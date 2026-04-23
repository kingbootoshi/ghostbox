import AppKit
import Foundation
import Observation

@MainActor
@Observable
final class ConversationStore {
    static let olderMessagesBatchSize = 25
    static let initialMessageCount = 50

    let ghostName: String

    var messages: [ChatMessage] = [] {
        didSet {
            messagesVersion &+= 1
            onConversationChanged()
        }
    }
    var preCompactionMessages: [ChatMessage] = [] {
        didSet {
            preCompactionDisplayVersion &+= 1
            onConversationChanged()
        }
    }
    private(set) var olderMessageCount = 0
    var hasOlderMessages: Bool { olderMessageCount > 0 || isLoadingOlderMessages }
    var messagesVersion = 0
    var preCompactionDisplayVersion = 0
    var sessions: SessionListResponse?
    var ghost: Ghost?
    var stats: GhostStats?
    var isLoadingHistory = false
    var isLoadingOlderMessages = false
    var isCreatingSession = false
    var isCompacting = false
    var isLoadingPreCompactionMessages = false
    var compactionSummary: String?
    var preCompactionRemainingCount = 0
    var visiblePreCompactionCount = 0 {
        didSet {
            preCompactionDisplayVersion &+= 1
        }
    }

    @ObservationIgnored private let client: GhostboxClient
    @ObservationIgnored var clearError: @MainActor () -> Void = {}
    @ObservationIgnored var showError: @MainActor (String) -> Void = { _ in }
    @ObservationIgnored var showToast: @MainActor (String) -> Void = { _ in }
    @ObservationIgnored var hasError: @MainActor () -> Bool = { false }
    @ObservationIgnored var onConversationChanged: @MainActor () -> Void = {}
    @ObservationIgnored private var nextHistoryBefore: Int?
    @ObservationIgnored private var nextPreCompactionBefore: Int?

    init(ghostName: String, client: GhostboxClient, initialGhost: Ghost? = nil) {
        self.ghostName = ghostName
        self.client = client
        self.ghost = initialGhost
    }

    var currentSession: SessionInfo? {
        guard let sessions else { return nil }
        let current = sessions.current
        return sessions.sessions.first { $0.id == current }
            ?? sessions.sessions.first { $0.id.contains(current) || current.contains($0.id) }
    }

    var visiblePreCompactionMessages: [ChatMessage] {
        guard visiblePreCompactionCount > 0 else { return [] }
        let startIndex = max(0, preCompactionMessages.count - visiblePreCompactionCount)
        return Array(preCompactionMessages[startIndex...])
    }

    var preCompactionOlderMessageCount: Int {
        max(0, preCompactionMessages.count - visiblePreCompactionCount) + preCompactionRemainingCount
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
            let history = try await client.getHistoryPage(
                ghostName: ghostName,
                segment: "post",
                limit: Self.initialMessageCount
            )
            let latestMessages = history.messages.map(historyMessageToChatMessage)
            preCompactionMessages = []
            preCompactionRemainingCount = history.preCompactionCount
            nextPreCompactionBefore = history.preCompactionCount > 0 ? history.preCompactionCount : nil
            compactionSummary = history.compactions.last?.summary
            visiblePreCompactionCount = 0
            nextHistoryBefore = history.nextBefore
            olderMessageCount = history.nextBefore ?? 0
            messages = latestMessages

            if !history.compactions.isEmpty && messages.isEmpty && history.preCompactionCount > 0 {
                messages = [ChatMessage(role: .system, content: "Session compacted")]
            }

            return true
        } catch {
            showError(error.localizedDescription)
            return false
        }
    }

    func newSession(onCompletion: @escaping @MainActor (Bool) -> Void = { _ in }) {
        guard !isLoadingHistory, !isCompacting, !isCreatingSession else { return }

        clearError()
        messages = []
        olderMessageCount = 0
        nextHistoryBefore = nil
        preCompactionMessages = []
        preCompactionRemainingCount = 0
        nextPreCompactionBefore = nil
        compactionSummary = nil
        visiblePreCompactionCount = 0
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

    func updateMessage(at index: Int, with message: ChatMessage) {
        guard messages.indices.contains(index) else { return }
        messages[index] = message
    }

    func loadOlderMessageBatch() {
        guard !isLoadingOlderMessages else { return }
        guard let before = nextHistoryBefore, before > 0 else { return }

        isLoadingOlderMessages = true

        Task { [weak self] in
            guard let self else { return }

            defer {
                isLoadingOlderMessages = false
            }

            do {
                let page = try await client.getHistoryPage(
                    ghostName: ghostName,
                    segment: "post",
                    limit: Self.olderMessagesBatchSize,
                    before: before
                )
                let olderBatch = page.messages.map(historyMessageToChatMessage)
                messages.insert(contentsOf: olderBatch, at: 0)
                nextHistoryBefore = page.nextBefore
                olderMessageCount = page.nextBefore ?? 0
            } catch {
                showToast(error.localizedDescription)
            }
        }
    }

    func showMoreOlderMessages() {
        guard !isLoadingPreCompactionMessages else { return }

        if visiblePreCompactionCount < preCompactionMessages.count {
            let newCount = min(
                visiblePreCompactionCount + Self.olderMessagesBatchSize,
                preCompactionMessages.count
            )
            visiblePreCompactionCount = newCount
            return
        }

        guard let before = nextPreCompactionBefore, before > 0 else { return }

        isLoadingPreCompactionMessages = true

        Task { [weak self] in
            guard let self else { return }

            defer {
                isLoadingPreCompactionMessages = false
            }

            do {
                let page = try await client.getHistoryPage(
                    ghostName: ghostName,
                    segment: "pre",
                    limit: Self.olderMessagesBatchSize,
                    before: before
                )
                let olderBatch = page.messages.map(historyMessageToChatMessage)
                preCompactionMessages.insert(contentsOf: olderBatch, at: 0)
                visiblePreCompactionCount = preCompactionMessages.count
                nextPreCompactionBefore = page.nextBefore
                preCompactionRemainingCount = page.nextBefore ?? 0
            } catch {
                showToast(error.localizedDescription)
            }
        }
    }

    private func historyMessageToChatMessage(_ message: HistoryMessage) -> ChatMessage {
        let thumbnails: [NSImage] = (message.images ?? []).compactMap { imageData in
            guard let data = Data(base64Encoded: imageData.data),
                  let image = NSImage(data: data) else { return nil }
            return image
        }

        return ChatMessage(
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
