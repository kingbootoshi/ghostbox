import AppKit
import SwiftUI

struct AnimatedGhostView: NSViewRepresentable {
    let state: GhostAnimation
    var size: CGFloat = 24

    enum GhostAnimation: Equatable {
        case idle
        case blink
        case talking
        case excited
        case lookingAround
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> GhostSpriteImageView {
        let imageView = GhostSpriteImageView()
        imageView.imageScaling = .scaleProportionallyUpOrDown
        imageView.imageAlignment = .alignCenter
        imageView.wantsLayer = true
        imageView.layer?.magnificationFilter = .nearest
        updateImageView(imageView, coordinator: context.coordinator)
        return imageView
    }

    func updateNSView(_ imageView: GhostSpriteImageView, context: Context) {
        updateImageView(imageView, coordinator: context.coordinator)
    }

    private func updateImageView(_ imageView: GhostSpriteImageView, coordinator: Coordinator) {
        imageView.fixedSize = size

        let resourceName = selectedResourceName(using: coordinator)
        let shouldAnimate = state != .idle

        guard coordinator.resourceName != resourceName || coordinator.isAnimating != shouldAnimate else {
            return
        }

        coordinator.lastState = state
        coordinator.resourceName = resourceName
        coordinator.isAnimating = shouldAnimate

        guard let url = Bundle.main.url(forResource: resourceName, withExtension: "gif", subdirectory: "GhostSprites"),
              let image = NSImage(contentsOf: url) else {
            imageView.image = nil
            imageView.animates = false
            return
        }

        imageView.image = image
        imageView.animates = shouldAnimate
    }

    private func selectedResourceName(using coordinator: Coordinator) -> String {
        switch state {
        case .idle:
            return "Ghost animations - Idle"
        case .blink:
            if coordinator.lastState == .blink, let resourceName = coordinator.resourceName {
                return resourceName
            }

            return Bool.random() ? "Ghost animations - Blink" : "Ghost animations - DoubleBlink"
        case .talking:
            return "Ghost animations - Talking"
        case .excited:
            return "Ghost animations - Excited"
        case .lookingAround:
            return "Ghost animations - LookingAround"
        }
    }

    final class Coordinator {
        var lastState: GhostAnimation?
        var resourceName: String?
        var isAnimating = false
    }
}

final class GhostSpriteImageView: NSImageView {
    var fixedSize: CGFloat = 24 {
        didSet {
            invalidateIntrinsicContentSize()
        }
    }

    override var intrinsicContentSize: NSSize {
        NSSize(width: fixedSize, height: fixedSize)
    }
}
