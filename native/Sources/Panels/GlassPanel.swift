import AppKit
import QuartzCore
import SwiftUI

class GlassPanel: NSPanel {
    private let toggleDuration: TimeInterval = 0.12
    private let highFrameRate = CAFrameRateRange(minimum: 80, maximum: 120, preferred: 120)

    init(
        contentRect: NSRect,
        title: String = ""
    ) {
        super.init(
            contentRect: contentRect,
            styleMask: [.borderless, .nonactivatingPanel, .fullSizeContentView, .resizable],
            backing: .buffered,
            defer: false
        )

        self.title = title
        isFloatingPanel = true
        level = .floating
        backgroundColor = .clear
        isOpaque = false
        hasShadow = false
        titleVisibility = .hidden
        titlebarAppearsTransparent = true
        isMovableByWindowBackground = false
        animationBehavior = .none
        collectionBehavior = [.fullScreenAuxiliary]
        minSize = NSSize(width: 380, height: 450)
        if let screen = NSScreen.main {
            maxSize = screen.frame.size
        } else {
            maxSize = NSSize(width: 3840, height: 2160)
        }

        standardWindowButton(.closeButton)?.isHidden = true
        standardWindowButton(.miniaturizeButton)?.isHidden = true
        standardWindowButton(.zoomButton)?.isHidden = true

        // Real macOS frosted glass
        let blur = NSVisualEffectView(frame: contentRect)
        blur.material = .hudWindow
        blur.blendingMode = .behindWindow
        blur.state = .active
        blur.wantsLayer = true
        blur.layerContentsRedrawPolicy = .onSetNeedsDisplay
        blur.layer?.cornerRadius = Theme.Layout.cornerRadius
        blur.layer?.masksToBounds = true
        blur.layer?.drawsAsynchronously = true
        // Prevent the clipping edge from showing as a line
        blur.layer?.borderWidth = 0
        blur.layer?.borderColor = nil

        contentView = blur
    }

    func setSwiftUIContent<V: View>(_ view: V) {
        guard let container = contentView else { return }

        let wrapped = BorderlessGlass { view }
        let hostingView = NSHostingView(rootView: wrapped)
        hostingView.translatesAutoresizingMaskIntoConstraints = false

        container.subviews.forEach { $0.removeFromSuperview() }
        container.addSubview(hostingView)

        NSLayoutConstraint.activate([
            hostingView.topAnchor.constraint(equalTo: container.topAnchor),
            hostingView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            hostingView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            hostingView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
        ])
    }

    // MARK: - Fast toggle (Cmd+Shift+G)

    func snapIn() {
        alphaValue = 0
        orderFrontRegardless()

        guard let layer = contentView?.layer else {
            alphaValue = 1
            return
        }

        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0.0
        fade.toValue = 1.0
        fade.duration = toggleDuration
        fade.timingFunction = CAMediaTimingFunction(name: .easeOut)
        fade.preferredFrameRateRange = highFrameRate
        layer.add(fade, forKey: "ghostbox.snapIn")

        alphaValue = 1
    }

    func showInstant() {
        alphaValue = 1
        orderFrontRegardless()
    }

    func snapOut(completion: (() -> Void)? = nil) {
        guard let layer = contentView?.layer else {
            orderOut(nil)
            completion?()
            return
        }

        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 1.0
        fade.toValue = 0.0
        fade.duration = toggleDuration
        fade.timingFunction = CAMediaTimingFunction(name: .easeOut)
        fade.preferredFrameRateRange = highFrameRate
        fade.isRemovedOnCompletion = false
        fade.fillMode = .forwards

        CATransaction.begin()
        CATransaction.setCompletionBlock { [weak self] in
            self?.orderOut(nil)
            self?.alphaValue = 1
            layer.removeAnimation(forKey: "ghostbox.snapOut")
            completion?()
        }
        layer.add(fade, forKey: "ghostbox.snapOut")
        CATransaction.commit()
    }

    // MARK: - First open (from hub click)

    func slideFromCenter() {
        alphaValue = 0
        orderFrontRegardless()

        guard let layer = contentView?.layer else {
            alphaValue = 1
            return
        }

        let scale = CABasicAnimation(keyPath: "transform")
        scale.fromValue = CATransform3DMakeScale(0.96, 0.96, 1)
        scale.toValue = CATransform3DIdentity
        scale.duration = 0.18
        scale.timingFunction = CAMediaTimingFunction(name: .easeOut)
        scale.preferredFrameRateRange = highFrameRate

        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0.0
        fade.toValue = 1.0
        fade.duration = 0.18
        fade.timingFunction = CAMediaTimingFunction(name: .easeOut)
        fade.preferredFrameRateRange = highFrameRate

        let group = CAAnimationGroup()
        group.animations = [scale, fade]
        group.duration = 0.18
        group.preferredFrameRateRange = highFrameRate

        layer.transform = CATransform3DIdentity
        layer.add(group, forKey: "ghostbox.slideIn")
        alphaValue = 1
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)

        if flags == [.command], event.charactersIgnoringModifiers == "\\" {
            NotificationCenter.default.post(
                name: .toggleGhostChatFiles,
                object: nil,
                userInfo: ["ghostName": title]
            )
            return true
        }

        if flags == [.command], event.charactersIgnoringModifiers == "/" {
            NotificationCenter.default.post(
                name: .toggleGhostHotkeyHelp,
                object: nil,
                userInfo: ["ghostName": title]
            )
            return true
        }

        if flags == [.command], event.charactersIgnoringModifiers == "f" {
            NotificationCenter.default.post(
                name: .toggleGhostChatFullscreen,
                object: nil,
                userInfo: ["ghostName": title]
            )
            return true
        }

        return super.performKeyEquivalent(with: event)
    }
}

struct BorderlessGlass<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        ZStack {
            // Dark tint over the real blur
            Theme.Colors.glassTint.opacity(0.55)

            // Purple accent gradient
            LinearGradient(
                colors: [
                    Theme.Colors.accentLight.opacity(0.08),
                    Theme.Colors.accent.opacity(0.04),
                    Color.clear,
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )

            content()
        }
    }
}
