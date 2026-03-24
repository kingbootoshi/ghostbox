import AppKit
import SwiftUI

@MainActor
final class HubPanelController {
    private var panel: GlassPanel?
    private let client: GhostboxClient
    private let appState: AppState

    private let panelSize = NSSize(width: 400, height: 600)

    init(client: GhostboxClient, appState: AppState) {
        self.client = client
        self.appState = appState
    }

    var isVisible: Bool {
        panel?.isVisible ?? false
    }

    var hubCenter: NSPoint? {
        guard let panel else { return nil }
        return NSPoint(x: panel.frame.midX, y: panel.frame.midY)
    }

    func toggle() {
        isVisible ? hide() : show()
    }

    func show() {
        if let panel {
            NSApp.activate(ignoringOtherApps: true)
            panel.snapIn()
            return
        }

        guard let targetFrame = centeredFrame(for: panelSize) else { return }

        let glassPanel = GlassPanel(contentRect: targetFrame, title: "Ghostbox")
        glassPanel.setSwiftUIContent(
            HubView(client: client)
                .environmentObject(appState)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        )
        panel = glassPanel

        NSApp.activate(ignoringOtherApps: true)
        glassPanel.slideFromCenter()
    }

    func hide() {
        guard let panel else { return }
        panel.snapOut()
    }

    private func centeredFrame(for size: NSSize) -> NSRect? {
        guard let screen = NSScreen.main else { return nil }
        let workArea = screen.visibleFrame
        let origin = NSPoint(
            x: workArea.midX - (size.width / 2),
            y: workArea.midY - (size.height / 2)
        )

        return NSRect(origin: origin, size: size)
    }
}
