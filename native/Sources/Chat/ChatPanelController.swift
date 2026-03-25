import AppKit
import QuartzCore
import SwiftUI

@MainActor
final class ChatPanelController: NSObject, NSWindowDelegate {
    let ghostName: String

    var wasOpen = false
    var animationIndex: Int { stackIndex }

    private var panel: GlassPanel?
    private let stackIndex: Int
    private let viewModel: AgentChatViewModel
    private let hubCenterProvider: @MainActor () -> NSPoint?
    private let userDefaults: UserDefaults

    private let defaultPanelSize = NSSize(width: 380, height: 550)
    private let hubSize = NSSize(width: 400, height: 600)
    private let panelResizeAnimationDuration: TimeInterval = 0.1

    private var lastKnownFrame: NSRect?
    private var isAnimatingPanel = false
    private var isShowingVaultBrowser = false
    private var isFullscreen = false
    private var preFullscreenFrame: NSRect?
    private var chatModeWidth: CGFloat?

    init(
        ghostName: String,
        client: GhostboxClient,
        stackIndex: Int = 0,
        hubCenterProvider: @escaping @MainActor () -> NSPoint?,
        userDefaults: UserDefaults = .standard
    ) {
        self.ghostName = ghostName
        self.stackIndex = stackIndex
        self.viewModel = AgentChatViewModel(ghostName: ghostName, client: client)
        self.hubCenterProvider = hubCenterProvider
        self.userDefaults = userDefaults

        super.init()

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handlePanelResizeRequest(_:)),
            name: .resizeGhostChatPanel,
            object: nil
        )

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleFullscreenToggle(_:)),
            name: .toggleGhostChatFullscreen,
            object: nil
        )
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    var isVisible: Bool {
        panel?.isVisible ?? false
    }

    func toggle() {
        isVisible ? hide() : show()
    }

    func show() {
        showFromCenter(hubCenter: resolvedHubCenter())
    }

    func showFromCenter(hubCenter: NSPoint) {
        showInPlace()
    }

    func hide() {
        wasOpen = false
        hideInPlace()
    }

    func hideInPlace(completion: (() -> Void)? = nil) {
        guard let panel, panel.isVisible else {
            completion?()
            return
        }

        lastKnownFrame = panel.frame

        panel.snapOut { [weak self] in
            self?.viewModel.cancelStream()
            completion?()
        }
    }

    func showInPlace() {
        if isVisible {
            wasOpen = true
            panel?.orderFrontRegardless()
            return
        }

        let targetFrame = restoredFrame(hubCenter: resolvedHubCenter())
        let panel = preparedPanel(targetFrame: targetFrame)

        wasOpen = true
        NSApp.activate(ignoringOtherApps: true)
        panel.snapIn()
    }

    func hideToCenter(hubCenter: NSPoint, completion: (() -> Void)? = nil) {
        hideInPlace(completion: completion)
    }

    func windowDidMove(_ notification: Notification) {
        guard !isAnimatingPanel,
              let window = notification.object as? NSWindow,
              window === panel else { return }

        saveFrame(window.frame)
    }

    func windowDidResize(_ notification: Notification) {
        guard !isAnimatingPanel,
              let window = notification.object as? NSWindow,
              window === panel else { return }

        if !isShowingVaultBrowser {
            chatModeWidth = window.frame.width
        }

        saveFrame(window.frame)
    }

    private func preparedPanel(targetFrame: NSRect) -> GlassPanel {
        if let panel {
            panel.setFrame(targetFrame, display: false)
            panel.contentView?.layer?.transform = CATransform3DIdentity
            panel.alphaValue = 1
            return panel
        }

        let glassPanel = GlassPanel(contentRect: targetFrame, title: ghostName)
        glassPanel.delegate = self
        glassPanel.setSwiftUIContent(
            AgentChatView(viewModel: viewModel)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        )
        panel = glassPanel
        return glassPanel
    }

    private func restoredFrame(hubCenter: NSPoint) -> NSRect {
        if let lastKnownFrame {
            chatModeWidth = chatModeWidth ?? lastKnownFrame.width
            return lastKnownFrame
        }

        if let savedFrame = savedFrame() {
            lastKnownFrame = savedFrame
            chatModeWidth = chatModeWidth ?? savedFrame.width
            return savedFrame
        }

        let defaultFrame = defaultFrame(hubCenter: hubCenter)
        lastKnownFrame = defaultFrame
        chatModeWidth = chatModeWidth ?? defaultFrame.width
        return defaultFrame
    }

    private func defaultFrame(hubCenter: NSPoint) -> NSRect {
        guard let screen = NSScreen.main else {
            return NSRect(origin: hubCenter, size: defaultPanelSize)
        }

        let workArea = screen.visibleFrame
        let height = min(defaultPanelSize.height, workArea.height - 40)

        return NSRect(
            x: hubCenter.x + (hubSize.width / 2) + 18 + (CGFloat(stackIndex) * 30),
            y: hubCenter.y - (height / 2) - (CGFloat(stackIndex) * 20),
            width: defaultPanelSize.width,
            height: height
        )
    }

    private func savedFrame() -> NSRect? {
        guard let frameString = userDefaults.string(forKey: positionKey) else { return nil }

        let frame = NSRectFromString(frameString)
        guard frame.width > 0, frame.height > 0 else { return nil }
        return frame
    }

    private func saveFrame(_ frame: NSRect) {
        lastKnownFrame = frame
        userDefaults.set(NSStringFromRect(frame), forKey: positionKey)
    }

    private func resolvedHubCenter() -> NSPoint {
        if let hubCenter = hubCenterProvider() {
            return hubCenter
        }

        if let screen = NSScreen.main {
            let workArea = screen.visibleFrame
            return NSPoint(x: workArea.midX, y: workArea.midY)
        }

        return NSPoint(x: 0, y: 0)
    }

    private var positionKey: String {
        "ghostbox.panel.position.\(ghostName)"
    }

    @objc private func handlePanelResizeRequest(_ notification: Notification) {
        guard let notificationGhostName = notification.userInfo?["ghostName"] as? String,
              notificationGhostName == ghostName,
              let widthValue = notification.userInfo?["width"] as? NSNumber else { return }

        let requestedWidth = CGFloat(truncating: widthValue)
        let showsVaultBrowser = (notification.userInfo?["showsVaultBrowser"] as? Bool)
            ?? (requestedWidth > defaultPanelSize.width)

        animatePanelWidth(to: requestedWidth, showsVaultBrowser: showsVaultBrowser)
    }

    @objc private func handleFullscreenToggle(_ notification: Notification) {
        guard let notificationGhostName = notification.userInfo?["ghostName"] as? String,
              notificationGhostName == ghostName,
              let panel else { return }

        isAnimatingPanel = true

        if isFullscreen {
            guard let restoreFrame = preFullscreenFrame else {
                isAnimatingPanel = false
                return
            }

            panel.setFrame(restoreFrame, display: true, animate: false)
            isFullscreen = false
            isAnimatingPanel = false
            saveFrame(panel.frame)
        } else {
            preFullscreenFrame = panel.frame

            guard let screen = panel.screen ?? NSScreen.main else {
                isAnimatingPanel = false
                return
            }

            let visibleFrame = screen.visibleFrame
            let padding: CGFloat = 16
            let targetFrame = NSRect(
                x: visibleFrame.origin.x + padding,
                y: visibleFrame.origin.y + padding,
                width: visibleFrame.width - (padding * 2),
                height: visibleFrame.height - (padding * 2)
            )

            panel.setFrame(targetFrame, display: true, animate: false)
            isFullscreen = true
            isAnimatingPanel = false
        }
    }

    private func animatePanelWidth(to requestedWidth: CGFloat, showsVaultBrowser: Bool) {
        guard let panel else { return }

        let currentFrame = panel.frame

        if showsVaultBrowser, !isShowingVaultBrowser {
            chatModeWidth = currentFrame.width
        }

        let targetWidth = showsVaultBrowser
            ? max(currentFrame.width, requestedWidth)
            : (chatModeWidth ?? requestedWidth)

        let clampedWidth = min(max(targetWidth, panel.minSize.width), panel.maxSize.width)

        guard abs(clampedWidth - currentFrame.width) > 0.5 else {
            isShowingVaultBrowser = showsVaultBrowser

            if !showsVaultBrowser {
                chatModeWidth = clampedWidth
            }

            saveFrame(currentFrame)
            return
        }

        var targetFrame = currentFrame
        targetFrame.size.width = clampedWidth

        isAnimatingPanel = true

        NSAnimationContext.runAnimationGroup({ context in
            context.duration = panelResizeAnimationDuration
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            context.allowsImplicitAnimation = true
            panel.animator().setFrame(targetFrame, display: true)
        }, completionHandler: { [weak self] in
            guard let self else { return }

            self.isAnimatingPanel = false
            self.isShowingVaultBrowser = showsVaultBrowser

            if !showsVaultBrowser {
                self.chatModeWidth = panel.frame.width
            }

            self.saveFrame(panel.frame)
        })
    }
}
