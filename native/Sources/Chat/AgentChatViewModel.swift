import AppKit
import Foundation
import Observation

struct QueuedChatMessage {
    var prompt: String
    let images: [PendingImage]
    let streamingBehavior: String?
    let isAlreadyDisplayed: Bool
}

struct ActiveBackgroundTask: Identifiable, Hashable {
    let id: String
    let label: String
}

@MainActor
@Observable
final class AgentChatViewModel {
    let ghostName: String
    let notifications: NotificationController
    let store: ConversationStore
    let input: InputController

    private(set) var queuedMessages: [QueuedChatMessage] = []
    private(set) var queueBrowseIndex: Int?
    var isStreaming = false
    private(set) var showsTypingIndicator = false
    private(set) var isWakingGhost = false
    private(set) var activeBackgroundTasks: [ActiveBackgroundTask] = []

    @ObservationIgnored private let client: GhostboxClient
    @ObservationIgnored private var streamTask: Task<Void, Never>?
    @ObservationIgnored private var activeStreamID: UUID?
    @ObservationIgnored private var lastAbortTime: Date?
    @ObservationIgnored private var savedInputBeforeQueueBrowse = ""
    @ObservationIgnored private var hasLoadedInitialState = false
    @ObservationIgnored private var isPreparingForOpening = false
    @ObservationIgnored private var realtimeObserver: NSObjectProtocol?

    init(ghostName: String, client: GhostboxClient, initialGhost: Ghost? = nil) {
        self.ghostName = ghostName
        self.client = client

        let notifications = NotificationController(ghostName: ghostName)
        let store = ConversationStore(ghostName: ghostName, client: client, initialGhost: initialGhost)
        let input = InputController(store: store)

        self.notifications = notifications
        self.store = store
        self.input = input

        store.clearError = { notifications.clearError() }
        store.showError = { notifications.showError($0) }
        store.showToast = { notifications.showToast($0) }
        store.hasError = { notifications.error != nil }
        input.isWakingGhost = { [weak self] in self?.isWakingGhost ?? false }
        store.onConversationChanged = { [weak self] in
            self?.rebuildActiveBackgroundTasks()
        }

        realtimeObserver = NotificationCenter.default.addObserver(
            forName: .ghostRealtimeEvent,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            Task { @MainActor [weak self] in
                await self?.handleRealtimeEvent(notification)
            }
        }

        Task { [weak self] in
            await self?.prepareForOpeningTask(ghostHint: initialGhost)
        }
    }

    deinit {
        streamTask?.cancel()
        if let realtimeObserver {
            NotificationCenter.default.removeObserver(realtimeObserver)
        }
    }

    var ghostboxClient: GhostboxClient {
        client
    }

    var isQueueBrowsing: Bool {
        queueBrowseIndex != nil
    }

    func send() {
        if queueBrowseIndex != nil {
            saveCurrentQueueEdit()
            queueBrowseIndex = nil
            input.inputText = savedInputBeforeQueueBrowse
            savedInputBeforeQueueBrowse = ""
            return
        }

        let prompt = input.inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        let submittedImages = input.pendingImages.filter { !$0.isProcessing }
        guard (!prompt.isEmpty || !submittedImages.isEmpty), !input.isInputDisabled else { return }

        _ = input.exitHistoryModeIfNeeded(restoreDraft: false)

        input.inputText = ""
        input.pendingImages = []

        if store.isCreatingSession {
            store.messages.append(
                ChatMessage(
                    role: .user,
                    content: prompt,
                    attachmentCount: submittedImages.count,
                    thumbnails: submittedImages.map(\.thumbnail)
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

        store.messages.append(
            ChatMessage(
                role: .user,
                content: prompt,
                attachmentCount: submittedImages.count,
                thumbnails: submittedImages.map(\.thumbnail)
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
        store.isCompacting = false

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
        queueBrowseIndex = nil
        savedInputBeforeQueueBrowse = ""
        queuedMessages.removeAll()

        let name = ghostName
        let clearQueueClient = client
        Task {
            try? await clearQueueClient.clearGhostQueue(name: name)
        }
    }

    func killBackgroundTask(taskId: String) {
        activeBackgroundTasks.removeAll { $0.id == taskId }

        Task { [weak self] in
            guard let self else { return }

            do {
                try await client.killBackgroundTask(ghostName: ghostName, taskId: taskId)
            } catch {
                rebuildActiveBackgroundTasks()
            }
        }
    }

    func switchModel(to model: GhostModel) {
        let command = "/model \(model.provider)/\(model.modelId)"
        store.messages.append(ChatMessage(role: .system, content: "Switching to \(model.displayName)..."))

        Task { [weak self] in
            guard let self else { return }

            do {
                let stream = client.sendMessage(ghostName: ghostName, prompt: command, model: nil)
                for try await event in stream {
                    if event.type == .result || event.type == .assistant, let text = event.text, !text.isEmpty {
                        store.messages.append(ChatMessage(role: .system, content: text))
                    }
                }

                do {
                    store.ghost = try await client.updateGhost(
                        name: ghostName,
                        provider: model.provider,
                        model: model.modelId
                    )
                } catch {
                    store.messages.append(
                        ChatMessage(
                            role: .system,
                            content: "Model switch finished, but persisted state could not be confirmed: \(error.localizedDescription)"
                        )
                    )
                    await loadGhost()
                }
            } catch {
                store.messages.append(ChatMessage(role: .system, content: "Model switch failed: \(error.localizedDescription)"))
            }
        }
    }

    func prepareForOpening(ghost: Ghost? = nil) {
        Task { [weak self] in
            await self?.prepareForOpeningTask(ghostHint: ghost)
        }
    }

    @discardableResult
    func handleEscapeForHistory() -> Bool {
        input.handleEscapeForHistory()
    }

    @discardableResult
    func browseSentHistoryBackward() -> Bool {
        input.browseSentHistoryBackward()
    }

    @discardableResult
    func browseSentHistoryForward() -> Bool {
        input.browseSentHistoryForward()
    }

    @discardableResult
    func exitHistoryModeIfNeeded(restoreDraft: Bool = true) -> Bool {
        input.exitHistoryModeIfNeeded(restoreDraft: restoreDraft)
    }

    @discardableResult
    func commitHistorySelection() -> Bool {
        input.commitHistorySelection { [weak self] in
            self?.queuedMessages.removeAll()
        }
    }

    @discardableResult
    func addImageFromPasteboard() -> Bool {
        input.addImageFromPasteboard()
    }

    func removeImage(id: UUID) {
        input.removeImage(id: id)
    }

    @discardableResult
    func browseQueueBackward() -> Bool {
        guard !queuedMessages.isEmpty else { return false }

        if let current = queueBrowseIndex {
            guard current > 0 else { return true }
            saveCurrentQueueEdit()
            let next = current - 1
            queueBrowseIndex = next
            input.inputText = queuedMessages[next].prompt
        } else {
            savedInputBeforeQueueBrowse = input.inputText
            let last = queuedMessages.count - 1
            queueBrowseIndex = last
            input.inputText = queuedMessages[last].prompt
        }
        return true
    }

    @discardableResult
    func browseQueueForward() -> Bool {
        guard let current = queueBrowseIndex else { return false }

        saveCurrentQueueEdit()
        let next = current + 1
        if next < queuedMessages.count {
            queueBrowseIndex = next
            input.inputText = queuedMessages[next].prompt
        } else {
            queueBrowseIndex = nil
            input.inputText = savedInputBeforeQueueBrowse
            savedInputBeforeQueueBrowse = ""
        }
        return true
    }

    func exitQueueBrowseMode() {
        guard queueBrowseIndex != nil else { return }
        saveCurrentQueueEdit()
        queueBrowseIndex = nil
        input.inputText = savedInputBeforeQueueBrowse
        savedInputBeforeQueueBrowse = ""
    }

    func switchSession(sessionId: String) {
        guard !isStreaming, !isWakingGhost else { return }
        _ = input.exitHistoryModeIfNeeded()
        store.switchSession(sessionId: sessionId) { [weak self] didLoadHistory in
            self?.hasLoadedInitialState = didLoadHistory
        }
    }

    func newSession() {
        guard !isStreaming, !isWakingGhost else { return }
        _ = input.exitHistoryModeIfNeeded()
        queuedMessages.removeAll()
        store.newSession { [weak self] _ in
            guard let self, !self.queuedMessages.isEmpty else { return }
            self.processNextQueued()
        }
    }

    func renameSession(sessionId: String, name: String) {
        store.renameSession(sessionId: sessionId, name: name)
    }

    func deleteSession(sessionId: String) {
        store.deleteSession(sessionId: sessionId)
    }

    private func saveCurrentQueueEdit() {
        guard let current = queueBrowseIndex, current < queuedMessages.count else { return }
        let trimmed = input.inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmed.isEmpty {
            queuedMessages[current].prompt = trimmed
        }
    }

    private func processNextQueued() {
        guard !isStreaming,
              !store.isLoadingHistory,
              !store.isCompacting,
              !store.isCreatingSession,
              !queuedMessages.isEmpty else { return }

        if queueBrowseIndex != nil {
            queueBrowseIndex = nil
            input.inputText = savedInputBeforeQueueBrowse
            savedInputBeforeQueueBrowse = ""
        }

        let nextMessage = queuedMessages.removeFirst()

        if !nextMessage.isAlreadyDisplayed {
            store.messages.append(
                ChatMessage(
                    role: .user,
                    content: nextMessage.prompt,
                    attachmentCount: nextMessage.images.count,
                    thumbnails: nextMessage.images.map(\.thumbnail)
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
        notifications.clearError()

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
        showsTypingIndicator = true
        var currentAssistantText = ""      // running target (everything the server has sent)
        var visibleAssistantText = ""      // what the UI has painted so far (typewriter drain)
        var currentAssistantIndex: Int?
        var drainTask: Task<Void, Never>?
        var streamFinished = false
        let isCompactCommand = Self.isCompactCommand(prompt)
        var compactResponseMessageID: UUID?
        var shouldProcessQueuedAfterStream = false

        if isCompactCommand {
            store.isCompacting = true
        }

        func renderVisible() {
            guard !visibleAssistantText.isEmpty else { return }
            showsTypingIndicator = false

            if let index = currentAssistantIndex, store.messages.indices.contains(index) {
                let existing = store.messages[index]
                let updated = existing.updatingContent(visibleAssistantText)
                store.updateMessage(at: index, with: updated)
                if isCompactCommand {
                    compactResponseMessageID = updated.id
                }
            } else {
                let assistantMessage = ChatMessage(role: .ghost, content: visibleAssistantText)
                store.messages.append(assistantMessage)
                currentAssistantIndex = store.messages.count - 1
                SoundManager.shared.play(.messageReceived)
                if isCompactCommand {
                    compactResponseMessageID = assistantMessage.id
                }
            }
        }

        func startDrainIfNeeded() {
            guard drainTask == nil else { return }
            drainTask = Task { @MainActor in
                let baseCharsPerSecond: Double = 90
                let hz: Double = 30
                let tickNanos = UInt64((1.0 / hz) * 1_000_000_000)
                var accumulator: Double = 0
                while !Task.isCancelled {
                    let targetLen = currentAssistantText.count
                    let visibleLen = visibleAssistantText.count
                    let remaining = targetLen - visibleLen

                    if remaining <= 0 {
                        if streamFinished { break }
                        try? await Task.sleep(nanoseconds: tickNanos)
                        continue
                    }

                    var delta = baseCharsPerSecond / hz
                    if remaining > 200 {
                        delta *= 1 + min(Double(remaining) / 400, 4)
                    }
                    if streamFinished {
                        delta *= 3
                    }
                    accumulator += delta
                    var take = Int(accumulator)
                    accumulator -= Double(take)
                    take = max(1, min(take, remaining))

                    let idx = currentAssistantText.index(currentAssistantText.startIndex, offsetBy: visibleLen + take)
                    visibleAssistantText = String(currentAssistantText[..<idx])
                    renderVisible()
                    try? await Task.sleep(nanoseconds: tickNanos)
                }
                drainTask = nil
            }
        }

        func cancelDrain() {
            drainTask?.cancel()
            drainTask = nil
        }

        func flushAssistantMessage(force: Bool = false) {
            guard !currentAssistantText.isEmpty else { return }
            if force {
                cancelDrain()
                visibleAssistantText = currentAssistantText
                renderVisible()
                return
            }
            if visibleAssistantText.isEmpty {
                renderVisible()
            }
        }

        func resetAssistantAccumulators() {
            cancelDrain()
            currentAssistantText = ""
            visibleAssistantText = ""
            currentAssistantIndex = nil
            showsTypingIndicator = isStreaming
        }

        defer {
            let shouldProcessQueued = shouldProcessQueuedAfterStream && activeStreamID == streamID
            if activeStreamID == streamID {
                activeStreamID = nil
                streamTask = nil
                isStreaming = false
            }
            showsTypingIndicator = false
            if isCompactCommand {
                store.isCompacting = false
            }
            if shouldProcessQueued {
                processNextQueued()
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
                    flushAssistantMessage(force: true)
                    return
                }

                switch event.type {
                case .assistant:
                    let chunk = event.text ?? ""
                    guard !chunk.isEmpty else { continue }

                    currentAssistantText += chunk
                    startDrainIfNeeded()

                case .thinking:
                    let chunk = event.text ?? ""
                    guard !chunk.isEmpty else { continue }

                    flushAssistantMessage(force: true)
                    resetAssistantAccumulators()

                    if let last = store.messages.last, last.role == .thinking {
                        let index = store.messages.count - 1
                        store.updateMessage(at: index, with: last.updatingContent(chunk))
                    } else {
                        store.messages.append(ChatMessage(role: .thinking, content: chunk))
                    }

                case .tool_use:
                    flushAssistantMessage(force: true)
                    resetAssistantAccumulators()

                    let toolName = event.tool ?? "Tool"
                    let content = event.input?.stringValue ?? "Running \(toolName)"
                    store.messages.append(ChatMessage(role: .toolUse, content: content, toolName: toolName))

                case .tool_result:
                    flushAssistantMessage(force: true)
                    resetAssistantAccumulators()

                    let content = event.output?.stringValue ?? "Tool finished."
                    store.messages.append(ChatMessage(role: .toolResult, content: content, toolName: "Result"))
                    rebuildActiveBackgroundTasks()

                case .result:
                    if let text = event.text, !text.isEmpty, currentAssistantText.isEmpty {
                        currentAssistantText = text
                    }

                    streamFinished = true
                    flushAssistantMessage(force: true)
                }
            }
        } catch is CancellationError {
            flushAssistantMessage(force: true)
            return
        } catch {
            notifications.showError(error.localizedDescription)
            store.messages.append(
                ChatMessage(role: .system, content: "Error: \(error.localizedDescription)")
            )

            _ = await store.reloadConversationState()

            if !queuedMessages.isEmpty {
                shouldProcessQueuedAfterStream = true
            }
            return
        }

        flushAssistantMessage(force: true)

        guard activeStreamID == streamID else { return }

        if isCompactCommand, let compactResponseMessageID {
            await handleCompaction(compactResponseMessageID: compactResponseMessageID)
        }

        await loadGhost()
        await store.loadStats()

        if !currentAssistantText.isEmpty, !isCompactCommand, !notifications.isGhostPanelVisible {
            notifications.fireNotification(for: currentAssistantText)
        }

        if !queuedMessages.isEmpty {
            shouldProcessQueuedAfterStream = true
        }
    }

    private func prepareForOpeningTask(ghostHint: Ghost?) async {
        guard !isPreparingForOpening else { return }

        isPreparingForOpening = true
        defer { isPreparingForOpening = false }

        if let ghostHint {
            store.ghost = ghostHint
        }

        if ghostHint?.status == .stopped {
            await wakeGhostAndLoadHistory()
            return
        }

        do {
            let latestGhost = try await client.getGhost(name: ghostName)
            store.ghost = latestGhost

            if latestGhost.status == .stopped {
                await wakeGhostAndLoadHistory()
                return
            }
        } catch {
            notifications.showError(error.localizedDescription)
            return
        }

        if !hasLoadedInitialState {
            hasLoadedInitialState = await store.reloadConversationState()
        }

        await loadGhost()
        await store.loadStats()
    }

    private func handleCompaction(compactResponseMessageID _: UUID?) async {
        hasLoadedInitialState = await store.reloadConversationState()
    }

    private func loadGhost() async {
        do {
            store.ghost = try await client.getGhost(name: ghostName)
        } catch {
            notifications.showError(error.localizedDescription)
        }
    }

    private func handleRealtimeEvent(_ notification: Notification) async {
        guard let eventGhostName = notification.userInfo?["ghostName"] as? String,
              eventGhostName == ghostName else {
            return
        }

        let eventType = notification.userInfo?["type"] as? String
        let eventSessionId = notification.userInfo?["sessionId"] as? String
        let ghost = notification.userInfo?["ghost"] as? Ghost

        guard !isStreaming, !isWakingGhost, !store.isCreatingSession, !store.isCompacting else { return }

        if eventType == "ghost.remove" {
            store.ghost = nil
            return
        }

        if let ghost {
            store.ghost = ghost
            if eventType == "ghost.upsert" {
                return
            }
        }

        if let currentSession = store.sessions?.current,
           let eventSessionId,
           currentSession != eventSessionId {
            _ = await store.loadSessions()
            await store.loadStats()
            await loadGhost()
            return
        }

        hasLoadedInitialState = await store.reloadConversationState()
        await loadGhost()
        await store.loadStats()
    }

    private func wakeGhostAndLoadHistory() async {
        isWakingGhost = true
        SoundManager.shared.play(.ghostWake)
        notifications.clearError()

        defer {
            isWakingGhost = false
        }

        do {
            try await client.wakeGhost(name: ghostName)
            hasLoadedInitialState = await store.reloadConversationState()
            await loadGhost()
            await store.loadStats()
        } catch {
            notifications.showError(error.localizedDescription)
        }
    }

    private func rebuildActiveBackgroundTasks() {
        var tasksByID: [String: ActiveBackgroundTask] = [:]
        var orderedTaskIDs: [String] = []

        for message in store.preCompactionMessages + store.messages {
            guard message.role == .toolResult else { continue }

            if let task = Self.parseBackgroundTaskStart(from: message.content) {
                if tasksByID[task.id] == nil {
                    orderedTaskIDs.append(task.id)
                }
                tasksByID[task.id] = task
                continue
            }

            if let taskID = Self.parseBackgroundTaskCompletionID(from: message.content) {
                tasksByID.removeValue(forKey: taskID)
                orderedTaskIDs.removeAll { $0 == taskID }
            }

            if let realTaskIDs = Self.parseBackgroundStatusResult(from: message.content) {
                let realSet = Set(realTaskIDs)
                orderedTaskIDs.removeAll { !realSet.contains($0) }
                tasksByID = tasksByID.filter { realSet.contains($0.key) }
            }
        }

        activeBackgroundTasks = orderedTaskIDs.compactMap { tasksByID[$0] }
    }

    private static func parseBackgroundStatusResult(from content: String) -> [String]? {
        guard content.contains("background_status") || content.contains("Running tasks:") else {
            return nil
        }

        if content.contains("No running tasks") {
            return []
        }

        guard content.contains("Running tasks:") else {
            return nil
        }

        var ids: [String] = []
        let matches = backgroundTaskIDRegex.matches(
            in: content,
            range: NSRange(content.startIndex..., in: content)
        )
        for match in matches {
            if let range = Range(match.range, in: content) {
                ids.append(String(content[range]))
            }
        }
        return ids
    }

    private static func isCompactCommand(_ prompt: String) -> Bool {
        prompt
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
            .hasPrefix("/compact")
    }

    private static func parseBackgroundTaskStart(from content: String) -> ActiveBackgroundTask? {
        guard content.range(of: "Background task started", options: .caseInsensitive) != nil else {
            return nil
        }

        guard let taskID = extractBackgroundTaskID(from: content) else {
            return nil
        }

        let label = extractBackgroundTaskLabel(from: content, taskID: taskID) ?? taskID
        return ActiveBackgroundTask(id: taskID, label: label)
    }

    private static func parseBackgroundTaskCompletionID(from content: String) -> String? {
        guard let taskRange = content.range(of: "Background task", options: .caseInsensitive),
              let completedRange = content.range(of: "completed", options: .caseInsensitive),
              taskRange.lowerBound < completedRange.lowerBound else {
            return nil
        }

        if let taskID = extractLabeledValue(
            from: content,
            keys: ["taskId", "task_id", "task id", "id"]
        ) {
            return taskID
        }

        let between = String(content[taskRange.upperBound..<completedRange.lowerBound])
        return firstUsefulToken(in: between)
    }

    private static func extractBackgroundTaskID(from content: String) -> String? {
        if let taskID = extractLabeledValue(
            from: content,
            keys: ["taskId", "task_id", "task id", "id"]
        ) {
            return taskID
        }

        guard let markerRange = content.range(of: "Background task started", options: .caseInsensitive) else {
            return nil
        }

        let remainder = String(content[markerRange.upperBound...])
        return firstUsefulToken(in: remainder)
    }

    private static func extractBackgroundTaskLabel(from content: String, taskID: String) -> String? {
        if let label = extractLabeledValue(
            from: content,
            keys: ["label", "command", "cmd", "title", "name"]
        ) {
            return label
        }

        guard let markerRange = content.range(of: "Background task started", options: .caseInsensitive) else {
            return nil
        }

        var remainder = String(content[markerRange.upperBound...])
        guard let taskIDRange = remainder.range(of: taskID) else {
            return nil
        }

        remainder.removeSubrange(..<taskIDRange.upperBound)
        let label = remainder.trimmingCharacters(in: backgroundTaskTrimCharacters)
        return label.isEmpty ? nil : label
    }

    private static func extractLabeledValue(from content: String, keys: [String]) -> String? {
        for key in keys {
            guard let keyRange = content.range(of: key, options: .caseInsensitive) else {
                continue
            }

            var suffix = content[keyRange.upperBound...]
            suffix = suffix.drop(while: { $0.isWhitespace || $0 == "\"" || $0 == "'" })

            guard let delimiter = suffix.first, delimiter == ":" || delimiter == "=" else {
                continue
            }

            suffix = suffix.dropFirst()
            suffix = suffix.drop(while: { $0.isWhitespace })

            guard let firstCharacter = suffix.first else {
                continue
            }

            if firstCharacter == "\"" || firstCharacter == "'" {
                let quote = firstCharacter
                let quotedValue = suffix.dropFirst().prefix { $0 != quote }
                let value = String(quotedValue).trimmingCharacters(in: backgroundTaskTrimCharacters)
                if !value.isEmpty {
                    return value
                }
                continue
            }

            let rawValue = suffix.prefix { !backgroundTaskValueTerminators.contains($0) }
            let value = String(rawValue).trimmingCharacters(in: backgroundTaskTrimCharacters)
            if !value.isEmpty {
                return value
            }
        }

        return nil
    }

    private static func firstUsefulToken(in content: String) -> String? {
        let tokens = content
            .components(separatedBy: backgroundTaskTokenSeparators)
            .map { $0.trimmingCharacters(in: backgroundTaskTrimCharacters) }
            .filter { !$0.isEmpty }

        for token in tokens {
            let normalized = token.lowercased()
            if ["background", "task", "started", "completed", "id", "label"].contains(normalized) {
                continue
            }
            return token
        }

        return nil
    }

    private static let backgroundTaskIDRegex = try! NSRegularExpression(pattern: "bg-[0-9a-fA-F-]{36}")
    private static let backgroundTaskTrimCharacters = CharacterSet.whitespacesAndNewlines
        .union(CharacterSet(charactersIn: ":,;()[]{}\"'"))
    private static let backgroundTaskTokenSeparators = CharacterSet.whitespacesAndNewlines
        .union(CharacterSet(charactersIn: ",;"))
    private static let backgroundTaskValueTerminators: Set<Character> = [",", "\n", "\r", "}"]
}
