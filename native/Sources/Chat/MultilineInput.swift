import AppKit
import SwiftUI
import UniformTypeIdentifiers

struct MultilineInput: NSViewRepresentable {
    @Binding var text: String
    @Binding var height: CGFloat
    var placeholder: String
    var font: NSFont
    var textColor: NSColor
    var isDisabled: Bool
    var minHeight: CGFloat = 20
    var maxHeight: CGFloat = 60
    var onSubmit: () -> Void
    var onPasteCommand: () -> Bool
    var onKeyPress: ((NSEvent) -> Bool)?

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        scrollView.hasVerticalScroller = false
        scrollView.hasHorizontalScroller = false
        scrollView.drawsBackground = false
        scrollView.borderType = .noBorder

        let textView = InputTextView()
        textView.delegate = context.coordinator
        textView.font = font
        textView.textColor = textColor
        textView.backgroundColor = .clear
        textView.drawsBackground = false
        textView.isEditable = true
        textView.isSelectable = true
        textView.isRichText = false
        textView.allowsUndo = true
        textView.isAutomaticQuoteSubstitutionEnabled = false
        textView.isAutomaticDashSubstitutionEnabled = false
        textView.isAutomaticTextReplacementEnabled = false
        textView.textContainerInset = NSSize(width: 0, height: 2)
        textView.textContainer?.lineFragmentPadding = 0
        textView.textContainer?.widthTracksTextView = true
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)

        textView.insertionPointColor = .white

        context.coordinator.textView = textView
        context.coordinator.onSubmit = onSubmit
        context.coordinator.onPasteCommand = onPasteCommand
        context.coordinator.minHeight = minHeight
        context.coordinator.maxHeight = maxHeight
        textView.onPasteCommand = context.coordinator.handlePasteCommand

        scrollView.documentView = textView
        context.coordinator.updateHeight(for: textView)
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? InputTextView else { return }

        context.coordinator.onSubmit = onSubmit
        context.coordinator.onPasteCommand = onPasteCommand
        context.coordinator.onKeyPress = onKeyPress
        context.coordinator.minHeight = minHeight
        context.coordinator.maxHeight = maxHeight
        textView.onPasteCommand = context.coordinator.handlePasteCommand
        context.coordinator.isUpdating = true

        if textView.string != text {
            textView.string = text
            textView.invalidateIntrinsicContentSize()
        }

        textView.isEditable = !isDisabled
        textView.font = font
        textView.textColor = textColor

        textView.placeholderString = placeholder
        textView.needsDisplay = true

        context.coordinator.isUpdating = false
        context.coordinator.updateHeight(for: textView)
    }

    func makeCoordinator() -> Coordinator { Coordinator(text: $text, height: $height) }

    final class Coordinator: NSObject, NSTextViewDelegate {
        @Binding var text: String
        @Binding var height: CGFloat
        var textView: InputTextView?
        var onSubmit: () -> Void = {}
        var onPasteCommand: () -> Bool = { false }
        var onKeyPress: ((NSEvent) -> Bool)?
        var isUpdating = false
        var minHeight: CGFloat = 20
        var maxHeight: CGFloat = 60

        init(text: Binding<String>, height: Binding<CGFloat>) {
            _text = text
            _height = height
        }

        func textDidChange(_ notification: Notification) {
            guard !isUpdating, let textView = notification.object as? NSTextView else { return }
            text = textView.string
            textView.invalidateIntrinsicContentSize()
            updateHeight(for: textView)
        }

        func textView(_ textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
            if commandSelector == #selector(NSResponder.insertNewline(_:)) {
                let event = NSApp.currentEvent
                let shiftHeld = event?.modifierFlags.contains(.shift) ?? false
                if shiftHeld {
                    textView.insertNewlineIgnoringFieldEditor(nil)
                } else {
                    onSubmit()
                }
                return true
            }
            return false
        }

        func handlePasteCommand() -> Bool {
            onPasteCommand()
        }

        func updateHeight(for textView: NSTextView) {
            guard let textContainer = textView.textContainer,
                  let layoutManager = textView.layoutManager else { return }

            layoutManager.ensureLayout(for: textContainer)
            let contentHeight = ceil(
                layoutManager.usedRect(for: textContainer).height
                    + (textView.textContainerInset.height * 2)
            )
            let measuredHeight = min(max(contentHeight, minHeight), maxHeight)

            guard abs(height - measuredHeight) > 0.5 else { return }

            DispatchQueue.main.async { [weak self] in
                self?.height = measuredHeight
            }
        }
    }
}

final class InputTextView: NSTextView {
    var placeholderString: String = ""
    var onPasteCommand: (() -> Bool)?

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)

        if string.isEmpty && !placeholderString.isEmpty {
            let attrs: [NSAttributedString.Key: Any] = [
                .font: font ?? NSFont.systemFont(ofSize: 14),
                .foregroundColor: NSColor.white.withAlphaComponent(0.2),
            ]
            let rect = NSRect(
                x: textContainerInset.width + (textContainer?.lineFragmentPadding ?? 0),
                y: textContainerInset.height,
                width: bounds.width,
                height: bounds.height
            )
            placeholderString.draw(in: rect, withAttributes: attrs)
        }
    }

    override func paste(_ sender: Any?) {
        if pasteboardContainsImage() {
            if onPasteCommand?() == true {
                return
            }
        }

        super.paste(sender)
    }

    private func pasteboardContainsImage() -> Bool {
        let pasteboard = NSPasteboard.general
        let items = pasteboard.pasteboardItems ?? []

        for item in items {
            if item.data(forType: .png) != nil || item.data(forType: .tiff) != nil {
                return true
            }

            if let fileURLString = item.string(forType: .fileURL),
               let url = URL(string: fileURLString),
               isSupportedImageFile(url) {
                return true
            }
        }

        return false
    }

    private func isSupportedImageFile(_ url: URL) -> Bool {
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
