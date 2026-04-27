import AppKit
import Foundation
import Observation

@MainActor
@Observable
final class ConversationStore {
    static let olderMessagesBatchSize = 25
    static let initialMessageCount = 50

    let ghostName: String

    var timelineItems: [ConversationTimelineItem] = [] {
        didSet {
            timelineVersion &+= 1
            onConversationChanged()
        }
    }
    private(set) var olderMessageCount = 0
    var hasOlderMessages: Bool { nextTimelineCursor != nil || isLoadingOlderMessages }
    var timelineVersion = 0
    var sessions: SessionListResponse?
    var ghost: Ghost?
    var stats: GhostStats?
    var isLoadingHistory = false
    var isLoadingOlderMessages = false
    var isCreatingSession = false
    var isCompacting = false

    @ObservationIgnored private let client: GhostboxClient
    @ObservationIgnored var clearError: @MainActor () -> Void = {}
    @ObservationIgnored var showError: @MainActor (String) -> Void = { _ in }
    @ObservationIgnored var showToast: @MainActor (String) -> Void = { _ in }
    @ObservationIgnored var hasError: @MainActor () -> Bool = { false }
    @ObservationIgnored var onConversationChanged: @MainActor () -> Void = {}
    @ObservationIgnored private var nextTimelineCursor: String?

    init(ghostName: String, client: GhostboxClient, initialGhost: Ghost? = nil) {
        self.ghostName = ghostName
        self.client = client
        self.ghost = initialGhost
    }

    var messages: [ChatMessage] {
        timelineItems.compactMap { item in
            guard case .message(let message) = item else { return nil }
            return message
        }
    }

    var currentSession: SessionInfo? {
        guard let sessions else { return nil }
        let current = sessions.current
        return sessions.sessions.first { $0.id == current }
            ?? sessions.sessions.first { $0.id.contains(current) || current.contains($0.id) }
    }

    func appendMessage(_ message: ChatMessage) {
        timelineItems.append(.message(message))
    }

    func lastMessage() -> ChatMessage? {
        for item in timelineItems.reversed() {
            if case .message(let message) = item {
                return message
            }
        }
        return nil
    }

    func displayID(forMessageID id: UUID) -> String? {
        for item in timelineItems {
            guard case .message(let message) = item, message.id == id else { continue }
            return message.displayID
        }
        return nil
    }

    func updateMessage(id: UUID, with message: ChatMessage) {
        guard let index = timelineItems.firstIndex(where: { item in
            guard case .message(let existing) = item else { return false }
            return existing.id == id
        }) else {
            return
        }

        timelineItems[index] = .message(message)
    }

    func truncateMessages(after id: UUID) {
        guard let index = timelineItems.firstIndex(where: { item in
            guard case .message(let message) = item else { return false }
            return message.id == id
        }) else {
            return
        }

        if index < timelineItems.count - 1 {
            timelineItems.removeSubrange((index + 1)..<timelineItems.count)
        }
    }

    func loadStats() async {
        do {
            stats = try await client.fetchStats(ghostName: ghostName)
        } catch {
            // Stats are best-effort, don't surface errors
        }
    }

    @discardableResult
    func loadSessions() async -> Bool {
        do {
            sessions = try await client.fetchSessions(name: ghostName)
            return true
        } catch {
            if !hasError() {
                showError(error.localizedDescription)
            }
            return false
        }
    }

    @discardableResult
    func loadHistory() async -> Bool {
        isLoadingHistory = true
        clearError()

        defer {
            isLoadingHistory = false
        }

        do {
            let page = try await client.getTimelinePage(
                ghostName: ghostName,
                limit: Self.initialMessageCount
            )
            timelineItems = page.items.compactMap(timelineItemFromResponse)
            nextTimelineCursor = page.nextCursor
            olderMessageCount = page.nextCursor == nil ? 0 : 1
            return true
        } catch {
            showError(error.localizedDescription)
            return false
        }
    }

    func newSession(onCompletion: @escaping @MainActor (Bool) -> Void = { _ in }) {
        guard !isLoadingHistory, !isCompacting, !isCreatingSession else { return }

        clearError()
        timelineItems = []
        olderMessageCount = 0
        nextTimelineCursor = nil
        isCreatingSession = true
        SoundManager.shared.play(.sessionNew)

        Task { [weak self] in
            guard let self else { return }

            do {
                let sessionId = try await client.newGhostSession(name: ghostName)
                if let sessions {
                    let existingSession = sessions.sessions.first { $0.id == sessionId }
                    self.sessions = SessionListResponse(
                        current: sessionId,
                        sessions: existingSession.map { [ $0 ] + sessions.sessions.filter { $0.id != sessionId } } ?? sessions.sessions
                    )
                }
                _ = await loadSessions()
                await loadStats()
                isCreatingSession = false
                onCompletion(true)
            } catch {
                isCreatingSession = false
                showError(error.localizedDescription)
                let didReload = await reloadConversationState()
                await loadStats()
                onCompletion(didReload)
            }
        }
    }

    func switchSession(
        sessionId: String,
        onCompletion: @escaping @MainActor (Bool) -> Void = { _ in }
    ) {
        guard !isLoadingHistory, !isCompacting, !isCreatingSession else { return }
        guard sessions?.current != sessionId else { return }

        clearError()

        Task { [weak self] in
            guard let self else { return }

            do {
                try await client.switchSession(name: ghostName, sessionId: sessionId)
                let didLoadHistory = await reloadConversationState()
                await loadStats()
                onCompletion(didLoadHistory)
            } catch {
                showError(error.localizedDescription)
            }
        }
    }

    func renameSession(sessionId: String, name: String) {
        Task { [weak self] in
            guard let self else { return }

            do {
                try await client.renameSession(name: ghostName, sessionId: sessionId, sessionName: name)
                _ = await loadSessions()
            } catch {
                showToast(error.localizedDescription)
            }
        }
    }

    func deleteSession(sessionId: String) {
        guard sessions?.current != sessionId else {
            showToast("Cannot delete the active session")
            return
        }

        Task { [weak self] in
            guard let self else { return }

            do {
                try await client.deleteSession(name: ghostName, sessionId: sessionId)
                _ = await loadSessions()
            } catch {
                showToast(error.localizedDescription)
            }
        }
    }

    @discardableResult
    func reloadConversationState() async -> Bool {
        async let historyLoaded = loadHistory()
        async let sessionsLoaded = loadSessions()

        let didLoadHistory = await historyLoaded
        _ = await sessionsLoaded
        return didLoadHistory
    }

    func loadOlderMessageBatch() {
        guard !isLoadingOlderMessages else { return }
        guard let cursor = nextTimelineCursor else { return }

        isLoadingOlderMessages = true

        Task { [weak self] in
            guard let self else { return }

            defer {
                isLoadingOlderMessages = false
            }

            do {
                let page = try await client.getTimelinePage(
                    ghostName: ghostName,
                    limit: Self.olderMessagesBatchSize,
                    cursor: cursor
                )
                let olderBatch = page.items.compactMap(timelineItemFromResponse)
                timelineItems.insert(contentsOf: olderBatch, at: 0)
                nextTimelineCursor = page.nextCursor
                olderMessageCount = page.nextCursor == nil ? 0 : 1
            } catch {
                showToast(error.localizedDescription)
            }
        }
    }

    private func timelineItemFromResponse(_ item: TimelineItemData) -> ConversationTimelineItem? {
        switch item.type {
        case "message":
            guard let message = item.message else { return nil }
            return .message(historyMessageToChatMessage(message, timelineID: item.id))
        case "compaction":
            guard let compaction = item.compaction else { return nil }
            return .compaction(
                CompactionMarker(
                    id: item.id,
                    summary: compaction.summary.isEmpty ? nil : compaction.summary,
                    timestamp: parseTimestamp(compaction.timestamp),
                    tokensBefore: compaction.tokensBefore
                )
            )
        default:
            return nil
        }
    }

    private func historyMessageToChatMessage(_ message: HistoryMessage, timelineID: String) -> ChatMessage {
        let thumbnails: [NSImage] = (message.images ?? []).compactMap { imageData in
            guard let data = Data(base64Encoded: imageData.data),
                  let image = NSImage(data: data) else { return nil }
            return image
        }

        return ChatMessage(
            timelineID: timelineID,
            role: mapRole(message.role),
            content: message.text,
            timestamp: parseTimestamp(message.timestamp),
            toolName: message.toolName,
            attachmentCount: message.attachmentCount ?? thumbnails.count,
            thumbnails: thumbnails
        )
    }

    private func mapRole(_ role: String) -> ChatMessage.Role {
        switch role {
        case "user":
            return .user
        case "assistant":
            return .ghost
        case "tool_use":
            return .toolUse
        case "tool_result":
            return .toolResult
        case "system":
            return .system
        default:
            return .system
        }
    }

    private func parseTimestamp(_ value: String?) -> Date {
        guard let value, !value.isEmpty else {
            return Date()
        }

        if let date = Self.timestampFormatterWithFractionalSeconds.date(from: value) {
            return date
        }

        if let date = Self.timestampFormatter.date(from: value) {
            return date
        }

        return Date()
    }

    private static let timestampFormatterWithFractionalSeconds: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let timestampFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()
}
