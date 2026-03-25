import AppKit
import Foundation
import UniformTypeIdentifiers

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

@MainActor
final class AgentChatViewModel: ObservableObject {
    let ghostName: String

    @Published var messages: [ChatMessage] = []
    @Published var preCompactionMessages: [ChatMessage] = []
    @Published var showingPreCompactionMessages = false
    @Published var visiblePreCompactionCount = 0
    @Published private(set) var compactionSummary: String?

    static let olderMessagesBatchSize = 25
    @Published var inputText = ""
    @Published var pendingImages: [PendingImage] = []
    @Published var isStreaming = false
    @Published private(set) var isLoadingHistory = false
    @Published private(set) var isCompacting = false
    @Published private(set) var ghost: Ghost?
    @Published private(set) var error: String?
    @Published private(set) var stats: GhostStats?

    private let client: GhostboxClient
    private var streamTask: Task<Void, Never>?
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

    init(ghostName: String, client: GhostboxClient) {
        self.ghostName = ghostName
        self.client = client

        Task { [weak self] in
            await self?.loadInitialState()
        }
    }

    deinit {
        streamTask?.cancel()
    }

    var ghostboxClient: GhostboxClient {
        client
    }

    func send() {
        let prompt = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        let submittedImages = pendingImages.filter { !$0.isProcessing }
        guard (!prompt.isEmpty || !submittedImages.isEmpty), !isStreaming, !isLoadingHistory, !isCompacting else { return }

        streamTask?.cancel()
        messages.append(
            ChatMessage(
                role: .user,
                content: prompt,
                attachmentCount: submittedImages.count,
                thumbnails: submittedImages.map { $0.thumbnail }
            )
        )
        inputText = ""
        pendingImages = []
        isStreaming = true
        error = nil

        let ghostName = self.ghostName

        streamTask = Task { [weak self] in
            await self?.consumeStream(
                prompt: prompt,
                images: submittedImages,
                ghostName: ghostName
            )
        }
    }

    func cancelStream() {
        let name = ghostName
        let abortClient = client
        streamTask?.cancel()
        streamTask = nil
        isStreaming = false

        Task {
            try? await abortClient.abortGhost(name: name)
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
                await loadGhost()
            } catch {
                self.messages.append(ChatMessage(role: .system, content: "Model switch failed: \(error.localizedDescription)"))
            }
        }
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
                await loadHistory()
            } catch {
                self.error = error.localizedDescription
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

            // Quick 48px thumbnail for instant display - small and fast
            let quickThumb: NSImage
            if let fullImage = NSImage(data: imageData) {
                quickThumb = fullImage.thumbnailImage(maxDimension: 48) ?? fullImage
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

    private func consumeStream(prompt: String, images: [PendingImage], ghostName: String) async {
        var currentAssistantText = ""
        var currentAssistantIndex: Int?
        let isCompactCommand = Self.isCompactCommand(prompt)
        var compactResponseMessageID: UUID?

        defer {
            isStreaming = false
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
                }
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
                        messages[index] = ChatMessage(
                            id: existingMessage.id,
                            role: .ghost,
                            content: currentAssistantText,
                            timestamp: existingMessage.timestamp,
                            attachmentCount: existingMessage.attachmentCount
                        )
                        if isCompactCommand {
                            compactResponseMessageID = existingMessage.id
                        }
                    } else {
                        let assistantMessage = ChatMessage(role: .ghost, content: currentAssistantText)
                        messages.append(assistantMessage)
                        currentAssistantIndex = messages.count - 1
                        if isCompactCommand {
                            compactResponseMessageID = assistantMessage.id
                        }
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
            self.error = error.localizedDescription
            messages.append(
                ChatMessage(role: .system, content: "Error: \(error.localizedDescription)")
            )
            return
        }

        if isCompactCommand, let compactResponseMessageID {
            await handleCompaction(compactResponseMessageID: compactResponseMessageID)
        }

        await loadGhost()
        await loadStats()
    }

    private func loadInitialState() async {
        await loadHistory()
        await loadGhost()
        await loadStats()
    }

    private func loadHistory() async {
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
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func historyMessageToChatMessage(_ message: HistoryMessage) -> ChatMessage {
        ChatMessage(
            role: mapRole(message.role),
            content: message.text,
            timestamp: parseTimestamp(message.timestamp),
            toolName: message.toolName
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

    private func handleCompaction(compactResponseMessageID: UUID?) async {
        showingPreCompactionMessages = false
        await loadHistory()
    }

    private func loadGhost() async {
        do {
            ghost = try await client.getGhost(name: ghostName)
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func loadStats() async {
        do {
            stats = try await client.fetchStats(ghostName: ghostName)
        } catch {
            // Stats are best-effort, don't surface errors
        }
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
            thumbnail: image.thumbnailImage(maxDimension: 96) ?? image,
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
