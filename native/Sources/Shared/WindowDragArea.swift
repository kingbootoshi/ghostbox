import AppKit
import SwiftUI

/// An invisible NSView overlay that makes its region draggable for borderless windows.
/// Use as .background(WindowDragArea()) on the header area only.
struct WindowDragArea: NSViewRepresentable {
    func makeNSView(context: Context) -> DragView {
        DragView()
    }

    func updateNSView(_ nsView: DragView, context: Context) {}
}

final class DragView: NSView {
    override func mouseDown(with event: NSEvent) {
        window?.performDrag(with: event)
    }
}
