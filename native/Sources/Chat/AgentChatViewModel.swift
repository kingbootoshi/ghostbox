import AppKit
import Foundation
import UniformTypeIdentifiers
import UserNotifications

struct PendingImage: Identifiable {
    let id: UUID
    let data: Data
    let thumbnail: NSImage
    let mediaType: String
    let isProcessing: Bool

    init(id: UUID = UUID(), data: Data, thumbnail: NSImage, mediaType: String, isProcessing: Bool = false) {
        self.id = id
        self.data = data
        self.thumbnail = thumbnail
        self.mediaType = mediaType
        self.isProcessing = isProcessing
    }
}

struct QueuedChatMessage {
    let prompt: String
    let images: [PendingImage]
    let streamingBehavior: String?
    let isAlreadyDisplayed: Bool
}

@MainActor
final class AgentChatViewModel: ObservableObject {
    let ghostName: String

    @Published var messages: [ChatMessage] = [] {
        didSet {
            messagesVersion &+= 1
        }
    }
    @Published var preCompactionMessages: [ChatMessage] = [] {
        didSet {
            preCompactionDisplayVersion &+= 1
        }
    }
    @Published var showingPreCompactionMessages = false
    @Published var visiblePreCompactionCount = 0 {
        didSet {
            preCompactionDisplayVersion &+= 1
        }
    }
    @Published private(set) var compactionSummary: String?
    @Published private(set) var messagesVersion = 0
    @Published private(set) var preCompactionDisplayVersion = 0
    @Published var sessions: SessionListResponse?

    static let olderMessagesBatchSize = 25
    @Published var inputText = ""
    @Published var pendingImages: [PendingImage] = []
    @Published private(set) var queuedMessages: [QueuedChatMessage] = []
    @Published private(set) var historySelectionMessageID: UUID?
    @Published var lastEscapeTime: Date?
    @Published var isStreaming = false
    @Published private(set) var isWakingGhost = false
    @Published private(set) var isHistoryModeActive = false
    @Published private(set) var isLoadingHistory = false
    @Published private(set) var isCompacting = false
    @Published private(set) var isCreatingSession = false
    @Published private(set) var ghost: Ghost?
    @Published private(set) var error: String?
    @Published private(set) var toast: String?
    @Published private(set) var stats: GhostStats?

    private let client: GhostboxClient
    private var streamTask: Task<Void, Never>?
    private var activeStreamID: UUID?
    private var lastAbortTime: Date?
    private var toastDismissTask: Task<Void, Never>?
    private var errorDismissTask: Task<Void, Never>?
    private var historyDraft = ""
    private var hasLoadedInitialState = false
    private var isPreparingForOpening = false
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
    private static let maximumAPIImageEdge: CGFloat = 1_568
    private static let maximumAPIImagePixels: CGFloat = 1_150_000
    private static let maximumAPIImageBytes = 4_500_000
    init(ghostName: String, client: GhostboxClient, initialGhost: Ghost? = nil) {
        self.ghostName = ghostName
        self.client = client
        self.ghost = initialGhost

        Task { [weak self] in
            await self?.prepareForOpeningTask(ghostHint: initialGhost)
        }
    }

    deinit {
        streamTask?.cancel()
    }

    var ghostboxClient: GhostboxClient {
        client
    }

    var currentSession: SessionInfo? {
        guard let sessions else { return nil }
        let current = sessions.current
        return sessions.sessions.first { $0.id == current }
            ?? sessions.sessions.first { $0.id.contains(current) || current.contains($0.id) }
    }

    var isInputDisabled: Bool {
        isWakingGhost || isLoadingHistory || isCompacting || ghost?.status == .stopped
    }

    func showToast(_ message: String) {
        toast = message
        toastDismissTask?.cancel()
        toastDismissTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled else { return }
            self?.toast = nil
        }
    }

    func dismissToast() {
        toast = nil
        error = nil
        toastDismissTask?.cancel()
        errorDismissTask?.cancel()
    }

    func showError(_ message: String) {
        error = message
        errorDismissTask?.cancel()
        errorDismissTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(5))
            guard !Task.isCancelled else { return }
            self?.error = nil
        }
    }

    func send() {
        let prompt = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        let submittedImages = pendingImages.filter { !$0.isProcessing }
        guard (!prompt.isEmpty || !submittedImages.isEmpty), !isInputDisabled else { return }

        _ = exitHistoryModeIfNeeded(restoreDraft: false)

        inputText = ""
        pendingImages = []

        if isCreatingSession {
            messages.append(
                ChatMessage(
                    role: .user,
                    content: prompt,
                    attachmentCount: submittedImages.count,
                    thumbnails: submittedImages.map { $0.thumbnail }
                )
            )
            queuedMessages.append(
                QueuedChatMessage(
                    prompt: prompt,
                    images: submittedImages,
                    streamingBehavior: queuedMessages.isEmpty ? nil : "followUp",
                    isAlreadyDisplayed: true
                )
            )
            return
        }

        if isStreaming {
            queuedMessages.append(
                QueuedChatMessage(
                    prompt: prompt,
                    images: submittedImages,
                    streamingBehavior: "followUp",
                    isAlreadyDisplayed: false
                )
            )
            return
        }

        messages.append(
            ChatMessage(
                role: .user,
                content: prompt,
                attachmentCount: submittedImages.count,
                thumbnails: submittedImages.map { $0.thumbnail }
            )
        )
        SoundManager.shared.play(.messageSent)
        startStream(prompt: prompt, images: submittedImages)
    }

    func cancelStream() {
        guard isStreaming else { return }

        let now = Date()
        let shouldClearQueue = lastAbortTime.map { now.timeIntervalSince($0) <= 0.5 } ?? false
        lastAbortTime = now

        let hasQueuedMessages = !queuedMessages.isEmpty
        let name = ghostName
        let abortClient = client
        activeStreamID = nil
        streamTask?.cancel()
        streamTask = nil
        isStreaming = false

        if shouldClearQueue && hasQueuedMessages {
            clearQueue()
        }

        Task {
            try? await abortClient.abortGhost(name: name)

            guard hasQueuedMessages, !shouldClearQueue else { return }

            await MainActor.run { [weak self] in
                self?.processNextQueued()
            }
        }
    }

    func clearQueue() {
        queuedMessages.removeAll()

        let name = ghostName
        let clearQueueClient = client
        Task {
            try? await clearQueueClient.clearGhostQueue(name: name)
        }
    }

    func switchModel(to model: GhostModel) {
        let command = "/model \(model.provider)/\(model.modelId)"
        messages.append(ChatMessage(role: .system, content: "Switching to \(model.displayName)..."))

        Task { [weak self] in
            guard let self else { return }

            do {
                let stream = client.sendMessage(ghostName: ghostName, prompt: command, model: nil)
                for try await event in stream {
                    if event.type == .result || event.type == .assistant, let text = event.text, !text.isEmpty {
                        self.messages.append(ChatMessage(role: .system, content: text))
                    }
                }
                let fallbackGhost = self.locallyUpdatedGhost(for: model)

                do {
                    self.ghost = try await client.updateGhost(
                        name: ghostName,
                        provider: model.provider,
                        model: model.modelId
                    )
                } catch GhostboxClientError.requestFailed(let statusCode, _) where statusCode == 404 || statusCode == 405 {
                    self.ghost = fallbackGhost
                } catch {
                    self.ghost = fallbackGhost
                    self.messages.append(
                        ChatMessage(
                            role: .system,
                            content: "Model switched, but saving it failed: \(error.localizedDescription)"
                        )
                    )
                }
            } catch {
                self.messages.append(ChatMessage(role: .system, content: "Model switch failed: \(error.localizedDescription)"))
            }
        }
    }

    private func locallyUpdatedGhost(for model: GhostModel) -> Ghost? {
        guard let current = ghost else { return nil }

        return Ghost(
            name: current.name,
            status: current.status,
            provider: model.provider,
            model: model.modelId,
            portBase: current.portBase,
            containerId: current.containerId,
            createdAt: current.createdAt,
            systemPrompt: current.systemPrompt
        )
    }

    func prepareForOpening(ghost: Ghost? = nil) {
        Task { [weak self] in
            await self?.prepareForOpeningTask(ghostHint: ghost)
        }
    }

    @discardableResult
    func handleEscapeForHistory() -> Bool {
        if isHistoryModeActive {
            exitHistoryModeIfNeeded()
            return true
        }

        let now = Date()
        if let lastEscapeTime, now.timeIntervalSince(lastEscapeTime) <= 0.5 {
            self.lastEscapeTime = nil
            return enterHistoryMode()
        }

        lastEscapeTime = now
        return true
    }

    @discardableResult
    func browseSentHistoryBackward() -> Bool {
        guard isHistoryModeActive, !selectableHistoryMessages.isEmpty else { return false }

        let nextIndex: Int
        if let currentIndex = selectedHistoryIndex {
            nextIndex = max(0, currentIndex - 1)
        } else {
            nextIndex = selectableHistoryMessages.count - 1
        }

        historySelectionMessageID = selectableHistoryMessages[nextIndex].id
        return true
    }

    @discardableResult
    func browseSentHistoryForward() -> Bool {
        guard isHistoryModeActive, !selectableHistoryMessages.isEmpty else { return false }

        guard let currentIndex = selectedHistoryIndex else {
            historySelectionMessageID = selectableHistoryMessages.first?.id
            return true
        }

        let nextIndex = currentIndex + 1
        if nextIndex < selectableHistoryMessages.count {
            historySelectionMessageID = selectableHistoryMessages[nextIndex].id
            return true
        }

        exitHistoryModeIfNeeded()
        return true
    }

    @discardableResult
    func exitHistoryModeIfNeeded(restoreDraft: Bool = true) -> Bool {
        guard isHistoryModeActive else { return false }

        isHistoryModeActive = false
        historySelectionMessageID = nil
        lastEscapeTime = nil

        if restoreDraft {
            inputText = historyDraft
        }

        historyDraft = ""
        return true
    }

    @discardableResult
    func commitHistorySelection() -> Bool {
        guard isHistoryModeActive,
              let historySelectionMessageID,
              let selectedIndex = messages.firstIndex(where: { $0.id == historySelectionMessageID }) else {
            return false
        }

        if selectedIndex < messages.count - 1 {
            messages.removeSubrange((selectedIndex + 1)..<messages.count)
        }

        queuedMessages.removeAll()
        return exitHistoryModeIfNeeded()
    }

    func compact() {
        guard !isStreaming, !isLoadingHistory, !isCompacting else { return }

        isCompacting = true
        error = nil

        Task { [weak self] in
            guard let self else { return }

            defer {
                self.isCompacting = false
            }

            do {
                try await client.compactGhost(name: ghostName)
                hasLoadedInitialState = await reloadConversationState()
                await loadStats()
            } catch {
                self.showError(error.localizedDescription)
                self.messages.append(
                    ChatMessage(role: .system, content: "Error: \(error.localizedDescription)")
                )
            }
        }
    }

    @discardableResult
    func addImageFromPasteboard() -> Bool {
        let pasteboard = NSPasteboard.general
        let items = pasteboard.pasteboardItems ?? []

        guard !items.isEmpty else { return false }

        // Extract raw image data from pasteboard on main thread (fast)
        // and show placeholders with quick thumbnails instantly
        var rawEntries: [(id: UUID, imageData: Data)] = []
        for item in items {
            guard let imageData = Self.extractImageData(from: item) else { continue }
            let placeholderID = UUID()

            // Quick thumbnail for instant display - 200px is crisp in the strip
            let quickThumb: NSImage
            if let fullImage = NSImage(data: imageData) {
                quickThumb = fullImage.thumbnailImage(maxDimension: 200) ?? fullImage
            } else {
                quickThumb = NSImage(size: NSSize(width: 48, height: 48))
            }

            pendingImages.append(PendingImage(
                id: placeholderID,
                data: Data(),
                thumbnail: quickThumb,
                mediaType: "image/png",
                isProcessing: true
            ))
            rawEntries.append((id: placeholderID, imageData: imageData))
        }

        guard !rawEntries.isEmpty else { return false }

        // Heavy resize/encode work on background thread (Data is Sendable)
        let entries = rawEntries
        Task.detached {
            var results: [(id: UUID, data: Data, thumbData: Data, mediaType: String)] = []
            for entry in entries {
                guard let image = NSImage(data: entry.imageData),
                      let processed = Self.makePendingImage(from: image) else {
                    results.append((id: entry.id, data: Data(), thumbData: Data(), mediaType: ""))
                    continue
                }
                let thumbData = processed.thumbnail.tiffRepresentation ?? Data()
                results.append((id: entry.id, data: processed.data, thumbData: thumbData, mediaType: processed.mediaType))
            }

            await MainActor.run { [weak self] in
                guard let self else { return }
                for result in results {
                    guard !result.data.isEmpty,
                          let thumb = NSImage(data: result.thumbData),
                          let index = self.pendingImages.firstIndex(where: { $0.id == result.id }) else {
                        self.pendingImages.removeAll { $0.id == result.id }
                        continue
                    }
                    self.pendingImages[index] = PendingImage(
                        id: result.id,
                        data: result.data,
                        thumbnail: thumb,
                        mediaType: result.mediaType
                    )
                }
            }
        }

        return true
    }

    private static func extractImageData(from item: NSPasteboardItem) -> Data? {
        if let pngData = item.data(forType: .png) {
            return pngData
        }
        if let tiffData = item.data(forType: .tiff) {
            return tiffData
        }
        if let fileURLString = item.string(forType: .fileURL),
           let url = URL(string: fileURLString),
           isSupportedImageFile(url),
           let data = try? Data(contentsOf: url) {
            return data
        }
        return nil
    }

    func removeImage(id: UUID) {
        pendingImages.removeAll { $0.id == id }
    }

    private func processNextQueued() {
        guard !isStreaming, !isLoadingHistory, !isCompacting, !isCreatingSession, !queuedMessages.isEmpty else { return }

        let nextMessage = queuedMessages.removeFirst()

        if !nextMessage.isAlreadyDisplayed {
            messages.append(
                ChatMessage(
                    role: .user,
                    content: nextMessage.prompt,
                    attachmentCount: nextMessage.images.count,
                    thumbnails: nextMessage.images.map { $0.thumbnail }
                )
            )
        }

        startStream(
            prompt: nextMessage.prompt,
            images: nextMessage.images,
            streamingBehavior: nextMessage.streamingBehavior
        )
    }

    private func startStream(
        prompt: String,
        images: [PendingImage],
        streamingBehavior: String? = nil
    ) {
        streamTask?.cancel()

        let ghostName = self.ghostName
        let streamID = UUID()
        activeStreamID = streamID
        isStreaming = true
        error = nil

        streamTask = Task { [weak self] in
            await self?.consumeStream(
                prompt: prompt,
                images: images,
                ghostName: ghostName,
                streamingBehavior: streamingBehavior,
                streamID: streamID
            )
        }
    }

    private func consumeStream(
        prompt: String,
        images: [PendingImage],
        ghostName: String,
        streamingBehavior: String?,
        streamID: UUID
    ) async {
        var currentAssistantText = ""
        var currentAssistantIndex: Int?
        let isCompactCommand = Self.isCompactCommand(prompt)
        var compactResponseMessageID: UUID?
        // Capture visibility at stream start. NSApp.keyWindow is nil when all
        // panels are hidden (user pressed Cmd+Shift+G to hide), which is exactly
        // when we want a notification. A non-activating panel only becomes key
        // when clicked, so nil key window reliably means the UI is hidden.
        let panelsHiddenAtStart = NSApp.keyWindow == nil

        defer {
            if activeStreamID == streamID {
                activeStreamID = nil
                streamTask = nil
                isStreaming = false
            }
        }

        do {
            let stream = client.sendMessage(
                ghostName: ghostName,
                prompt: prompt,
                model: nil,
                images: images.map {
                    GhostboxMessageImage(
                        mediaType: $0.mediaType,
                        data: $0.data.base64EncodedString()
                    )
                },
                streamingBehavior: streamingBehavior
            )

            for try await event in stream {
                if Task.isCancelled {
                    return
                }

                switch event.type {
                case .assistant:
                    let chunk = event.text ?? ""
                    guard !chunk.isEmpty else { continue }

                    currentAssistantText += chunk

                    if let index = currentAssistantIndex, messages.indices.contains(index) {
                        let existingMessage = messages[index]
                        messages[index] = existingMessage.updatingContent(currentAssistantText)
                        if isCompactCommand {
                            compactResponseMessageID = existingMessage.id
                        }
                    } else {
                        let assistantMessage = ChatMessage(role: .ghost, content: currentAssistantText)
                        messages.append(assistantMessage)
                        currentAssistantIndex = messages.count - 1
                        SoundManager.shared.play(.messageReceived)
                        if isCompactCommand {
                            compactResponseMessageID = assistantMessage.id
                        }
                    }

                case .thinking:
                    let chunk = event.text ?? ""
                    guard !chunk.isEmpty else { continue }

                    if let last = messages.last, last.role == .thinking {
                        let index = messages.count - 1
                        messages[index] = last.updatingContent(chunk)
                    } else {
                        messages.append(ChatMessage(role: .thinking, content: chunk))
                    }

                case .tool_use:
                    let toolName = event.tool ?? "Tool"
                    let content = event.input?.stringValue ?? "Running \(toolName)"
                    messages.append(ChatMessage(role: .toolUse, content: content, toolName: toolName))
                    currentAssistantText = ""
                    currentAssistantIndex = nil

                case .tool_result:
                    let content = event.output?.stringValue ?? "Tool finished."
                    messages.append(ChatMessage(role: .toolResult, content: content, toolName: "Result"))
                    currentAssistantText = ""
                    currentAssistantIndex = nil

                case .result:
                    if let text = event.text, !text.isEmpty, currentAssistantText.isEmpty {
                        let resultMessage = ChatMessage(role: .ghost, content: text)
                        messages.append(resultMessage)
                        if isCompactCommand {
                            compactResponseMessageID = resultMessage.id
                        }
                    }
                }
            }
        } catch is CancellationError {
            return
        } catch {
            self.showError(error.localizedDescription)
            messages.append(
                ChatMessage(role: .system, content: "Error: \(error.localizedDescription)")
            )
            return
        }

        guard activeStreamID == streamID else { return }

        if isCompactCommand, let compactResponseMessageID {
            await handleCompaction(compactResponseMessageID: compactResponseMessageID)
        }

        await loadGhost()
        await loadStats()

        // Fire notification after the full response is complete so the preview
        // shows the final text, not a partial first chunk. Only notify if the
        // panels were hidden when the stream started - no point interrupting the
        // user if they're already looking at the chat.
        if panelsHiddenAtStart, !currentAssistantText.isEmpty, !isCompactCommand {
            fireNotification(for: currentAssistantText)
        }

        activeStreamID = nil
        streamTask = nil
        isStreaming = false

        if !queuedMessages.isEmpty {
            processNextQueued()
        }
    }

    private func fireNotification(for messageText: String) {
        let preview = String(messageText.prefix(100))
        guard !preview.isEmpty else { return }

        SoundManager.shared.play(.notification)

        let content = UNMutableNotificationContent()
        content.title = ghostName
        content.body = preview
        content.sound = .none
        content.categoryIdentifier = "GHOST_MESSAGE"
        content.userInfo = ["ghostName": ghostName]

        let request = UNNotificationRequest(
            identifier: "ghost-message-\(ghostName)-\(UUID().uuidString)",
            content: content,
            trigger: nil
        )

        UNUserNotificationCenter.current().add(request)
    }

    private func prepareForOpeningTask(ghostHint: Ghost?) async {
        guard !isPreparingForOpening else { return }

        isPreparingForOpening = true
        defer { isPreparingForOpening = false }

        if let ghostHint {
            ghost = ghostHint
        }

        if ghostHint?.status == .stopped {
            await wakeGhostAndLoadHistory()
            return
        }

        do {
            let latestGhost = try await client.getGhost(name: ghostName)
            ghost = latestGhost

            if latestGhost.status == .stopped {
                await wakeGhostAndLoadHistory()
                return
            }
        } catch {
            self.showError(error.localizedDescription)
            return
        }

        if !hasLoadedInitialState {
            hasLoadedInitialState = await reloadConversationState()
        }

        await loadGhost()
        await loadStats()
    }

    @discardableResult
    private func loadHistory() async -> Bool {
        isLoadingHistory = true
        error = nil

        defer {
            isLoadingHistory = false
        }

        do {
            let history = try await client.getHistory(ghostName: ghostName)
            messages = history.messages.map { historyMessageToChatMessage($0) }
            preCompactionMessages = history.preCompactionMessages.map { historyMessageToChatMessage($0) }
            compactionSummary = history.compactions.last?.summary
            visiblePreCompactionCount = 0
            showingPreCompactionMessages = false

            if !history.compactions.isEmpty && messages.isEmpty && !preCompactionMessages.isEmpty {
                messages = [ChatMessage(role: .system, content: "Session compacted")]
            }
            return true
        } catch {
            self.showError(error.localizedDescription)
            return false
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

    func showMoreOlderMessages() {
        let newCount = min(
            visiblePreCompactionCount + Self.olderMessagesBatchSize,
            preCompactionMessages.count
        )
        visiblePreCompactionCount = newCount
        showingPreCompactionMessages = newCount > 0
    }

    func hideOlderMessages() {
        visiblePreCompactionCount = 0
        showingPreCompactionMessages = false
    }

    var visiblePreCompactionMessages: [ChatMessage] {
        guard visiblePreCompactionCount > 0 else { return [] }
        let startIndex = max(0, preCompactionMessages.count - visiblePreCompactionCount)
        return Array(preCompactionMessages[startIndex...])
    }

    var hasMoreOlderMessages: Bool {
        visiblePreCompactionCount < preCompactionMessages.count
    }

    func handleCompaction() async {
        await handleCompaction(compactResponseMessageID: nil)
    }

    func loadSessions() async -> Bool {
        do {
            sessions = try await client.fetchSessions(name: ghostName)
            return true
        } catch {
            if self.error == nil {
                self.showError(error.localizedDescription)
            }
            return false
        }
    }

    func switchSession(sessionId: String) {
        guard !isStreaming, !isLoadingHistory, !isCompacting, !isCreatingSession else { return }
        guard sessions?.current != sessionId else { return }

        error = nil
        _ = exitHistoryModeIfNeeded()

        Task { [weak self] in
            guard let self else { return }

            do {
                try await client.switchSession(name: ghostName, sessionId: sessionId)
                hasLoadedInitialState = await reloadConversationState()
                await loadStats()
            } catch {
                self.showError(error.localizedDescription)
            }
        }
    }

    func newSession() {
        guard !isStreaming, !isLoadingHistory, !isCompacting, !isCreatingSession else { return }

        error = nil
        _ = exitHistoryModeIfNeeded()
        messages = []
        preCompactionMessages = []
        compactionSummary = nil
        visiblePreCompactionCount = 0
        showingPreCompactionMessages = false
        queuedMessages.removeAll()
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
                if !queuedMessages.isEmpty {
                    processNextQueued()
                }
            } catch {
                isCreatingSession = false
                self.showError(error.localizedDescription)
                hasLoadedInitialState = await reloadConversationState()
                await loadStats()
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
                self.showToast(error.localizedDescription)
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
                self.showToast(error.localizedDescription)
            }
        }
    }

    private func handleCompaction(compactResponseMessageID: UUID?) async {
        showingPreCompactionMessages = false
        hasLoadedInitialState = await reloadConversationState()
    }

    private func loadGhost() async {
        do {
            ghost = try await client.getGhost(name: ghostName)
        } catch {
            self.showError(error.localizedDescription)
        }
    }

    private func loadStats() async {
        do {
            stats = try await client.fetchStats(ghostName: ghostName)
        } catch {
            // Stats are best-effort, don't surface errors
        }
    }

    private func wakeGhostAndLoadHistory() async {
        isWakingGhost = true
        SoundManager.shared.play(.ghostWake)
        error = nil

        defer {
            isWakingGhost = false
        }

        do {
            try await client.wakeGhost(name: ghostName)
            hasLoadedInitialState = await reloadConversationState()
            await loadGhost()
            await loadStats()
        } catch {
            self.showError(error.localizedDescription)
        }
    }

    @discardableResult
    private func reloadConversationState() async -> Bool {
        async let historyLoaded = loadHistory()
        async let sessionsLoaded = loadSessions()

        let didLoadHistory = await historyLoaded
        _ = await sessionsLoaded
        return didLoadHistory
    }

    private func enterHistoryMode() -> Bool {
        guard !selectableHistoryMessages.isEmpty else { return false }

        historyDraft = inputText
        historySelectionMessageID = nil
        isHistoryModeActive = true
        return true
    }

    private var selectableHistoryMessages: [ChatMessage] {
        messages.filter { !$0.isToolMessage }
    }

    private var selectedHistoryIndex: Int? {
        guard let historySelectionMessageID else { return nil }
        return selectableHistoryMessages.firstIndex { $0.id == historySelectionMessageID }
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

    private static func isCompactCommand(_ prompt: String) -> Bool {
        prompt
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .hasPrefix("/compact")
    }

    private nonisolated static func makePendingImage(from image: NSImage) -> PendingImage? {
        let resized = resizeForAPI(image: image)

        guard var imageData = resized.pngData() else {
            return nil
        }

        imageData = compressForAPI(data: imageData)

        return PendingImage(
            data: imageData,
            thumbnail: image.thumbnailImage(maxDimension: 200) ?? image,
            mediaType: imageData.isJPEGData ? "image/jpeg" : "image/png"
        )
    }

    private nonisolated static func resizeForAPI(image: NSImage) -> NSImage {
        guard let pixelSize = image.pixelSize() else {
            return image
        }

        let longestEdge = max(pixelSize.width, pixelSize.height)
        let totalPixels = pixelSize.width * pixelSize.height

        guard longestEdge > maximumAPIImageEdge || totalPixels > maximumAPIImagePixels else {
            return image
        }

        let scale = min(
            maximumAPIImageEdge / longestEdge,
            sqrt(maximumAPIImagePixels / totalPixels)
        )
        let targetSize = NSSize(
            width: max(1, floor(pixelSize.width * scale)),
            height: max(1, floor(pixelSize.height * scale))
        )
        let resized = NSImage(size: targetSize)
        let sourceSize = image.size.width > 0 && image.size.height > 0 ? image.size : pixelSize

        resized.lockFocus()
        defer { resized.unlockFocus() }

        image.draw(
            in: NSRect(origin: .zero, size: targetSize),
            from: NSRect(origin: .zero, size: sourceSize),
            operation: .copy,
            fraction: 1
        )

        return resized
    }

    private nonisolated static func compressForAPI(data: Data) -> Data {
        guard data.count > maximumAPIImageBytes,
              let bitmap = NSBitmapImageRep(data: data),
              let jpegData = bitmap.representation(
                  using: .jpeg,
                  properties: [.compressionFactor: 0.85]
              ) else {
            return data
        }

        return jpegData
    }

    private static func isSupportedImageFile(_ url: URL) -> Bool {
        guard url.isFileURL else {
            return false
        }

        if let resourceValues = try? url.resourceValues(forKeys: [.contentTypeKey]),
           let contentType = resourceValues.contentType {
            return contentType.conforms(to: .image)
        }

        return false
    }
}

private extension NSImage {
    func pixelSize() -> NSSize? {
        let bitmapRepresentations = representations
            .compactMap { $0 as? NSBitmapImageRep }
            .filter { $0.pixelsWide > 0 && $0.pixelsHigh > 0 }

        if let bitmap = bitmapRepresentations.max(by: {
            ($0.pixelsWide * $0.pixelsHigh) < ($1.pixelsWide * $1.pixelsHigh)
        }) {
            return NSSize(width: bitmap.pixelsWide, height: bitmap.pixelsHigh)
        }

        guard let tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiffRepresentation),
              bitmap.pixelsWide > 0,
              bitmap.pixelsHigh > 0 else {
            return nil
        }

        return NSSize(width: bitmap.pixelsWide, height: bitmap.pixelsHigh)
    }

    func pngData() -> Data? {
        guard let tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiffRepresentation) else {
            return nil
        }

        return bitmap.representation(using: .png, properties: [:])
    }

    func thumbnailImage(maxDimension: CGFloat) -> NSImage? {
        guard size.width > 0, size.height > 0 else {
            return nil
        }

        let scale = min(maxDimension / size.width, maxDimension / size.height, 1)
        let targetSize = NSSize(width: size.width * scale, height: size.height * scale)
        let thumbnail = NSImage(size: targetSize)

        thumbnail.lockFocus()
        defer { thumbnail.unlockFocus() }

        draw(
            in: NSRect(origin: .zero, size: targetSize),
            from: NSRect(origin: .zero, size: size),
            operation: .copy,
            fraction: 1
        )

        return thumbnail
    }
}

private extension Data {
    var isJPEGData: Bool {
        starts(with: [0xFF, 0xD8, 0xFF])
    }
}
