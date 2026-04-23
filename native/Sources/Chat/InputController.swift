import AppKit
import Foundation
import Observation
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
@Observable
final class InputController {
    var inputText = ""
    var pendingImages: [PendingImage] = []
    var historySelectionMessageID: UUID?
    var lastEscapeTime: Date?
    private(set) var isHistoryModeActive = false

    @ObservationIgnored private let store: ConversationStore
    @ObservationIgnored var isWakingGhost: @MainActor () -> Bool = { false }
    @ObservationIgnored private var historyDraft = ""

    private static let maximumAPIImageEdge: CGFloat = 1_568
    private static let maximumAPIImagePixels: CGFloat = 1_150_000
    private static let maximumAPIImageBytes = 4_500_000

    init(store: ConversationStore) {
        self.store = store
    }

    var isInputDisabled: Bool {
        isWakingGhost() || store.isLoadingHistory || store.ghost?.status == .stopped
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
    func commitHistorySelection(onCommit: @MainActor () -> Void = {}) -> Bool {
        guard isHistoryModeActive,
              let historySelectionMessageID,
              store.messages.contains(where: { $0.id == historySelectionMessageID }) else {
            return false
        }

        store.truncateMessages(after: historySelectionMessageID)
        onCommit()
        return exitHistoryModeIfNeeded()
    }

    @discardableResult
    func addImageFromPasteboard() -> Bool {
        let pasteboard = NSPasteboard.general
        let items = pasteboard.pasteboardItems ?? []

        var rawEntries: [(id: UUID, imageData: Data)] = []
        for item in items {
            guard let imageData = Self.extractImageData(from: item) else { continue }
            let placeholderID = UUID()

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

        if rawEntries.isEmpty,
           let image = NSImage(pasteboard: pasteboard),
           let imageData = image.pngData() {
            let placeholderID = UUID()
            let quickThumb = image.thumbnailImage(maxDimension: 200) ?? image

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

    func removeImage(id: UUID) {
        pendingImages.removeAll { $0.id == id }
    }

    private static func extractImageData(from item: NSPasteboardItem) -> Data? {
        if let pngData = item.data(forType: .png) {
            return pngData
        }
        if let tiffData = item.data(forType: .tiff) {
            return tiffData
        }
        if let jpegData = item.data(forType: .init("public.jpeg")) {
            return jpegData
        }
        if let fileURLString = item.string(forType: .fileURL),
           let url = URL(string: fileURLString),
           isSupportedImageFile(url),
           let data = try? Data(contentsOf: url) {
            return data
        }

        for type in item.types where type != .fileURL {
            guard let data = item.data(forType: type),
                  NSImage(data: data) != nil else {
                continue
            }

            return data
        }

        return nil
    }

    private func enterHistoryMode() -> Bool {
        guard !selectableHistoryMessages.isEmpty else { return false }

        historyDraft = inputText
        historySelectionMessageID = nil
        isHistoryModeActive = true
        return true
    }

    private var selectableHistoryMessages: [ChatMessage] {
        store.messages.filter { !$0.isToolMessage }
    }

    private var selectedHistoryIndex: Int? {
        guard let historySelectionMessageID else { return nil }
        return selectableHistoryMessages.firstIndex { $0.id == historySelectionMessageID }
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
