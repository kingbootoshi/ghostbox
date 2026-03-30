import AppKit
import Foundation
import Observation
import UserNotifications

enum ChatToastType {
    case info
    case error
}

@MainActor
@Observable
final class NotificationController {
    let ghostName: String

    var toastMessage: String?
    var toastType: ChatToastType?
    var error: String?

    @ObservationIgnored private var dismissTask: Task<Void, Never>?

    init(ghostName: String) {
        self.ghostName = ghostName
    }

    deinit {
        dismissTask?.cancel()
    }

    var isGhostPanelVisible: Bool {
        Self.isGhostPanelVisible(ghostName)
    }

    func showToast(_ message: String) {
        show(message, type: .info, error: nil, duration: 3)
    }

    func showError(_ message: String) {
        show(message, type: .error, error: message, duration: 5)
    }

    func dismissToast() {
        toastMessage = nil
        toastType = nil
        error = nil
        dismissTask?.cancel()
    }

    func clearError() {
        error = nil

        guard toastType == .error else { return }

        toastMessage = nil
        toastType = nil
        dismissTask?.cancel()
    }

    func fireNotification(for messageText: String) {
        let preview = String(messageText.prefix(100))
        guard !preview.isEmpty else { return }

        SoundManager.shared.play(.notification)

        let content = UNMutableNotificationContent()
        content.title = "Ghostbox - \(ghostName)"
        content.body = preview
        content.sound = .none
        content.categoryIdentifier = "GHOST_MESSAGE"
        content.userInfo = ["ghostName": ghostName]

        let request = UNNotificationRequest(
            identifier: "ghost-message-\(ghostName)-\(UUID().uuidString)",
            content: content,
            trigger: nil
        )

        UNUserNotificationCenter.current().add(request) { error in
            if let error {
                print("[notifications] failed to deliver: \(error.localizedDescription)")
            }
        }

        NotificationCenter.default.post(
            name: .ghostUnread,
            object: nil,
            userInfo: ["ghostName": ghostName]
        )
    }

    private func show(
        _ message: String,
        type: ChatToastType,
        error: String?,
        duration: TimeInterval
    ) {
        toastMessage = message
        toastType = type
        self.error = error

        dismissTask?.cancel()
        dismissTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(duration))
            guard !Task.isCancelled else { return }
            self?.toastMessage = nil
            self?.toastType = nil
            if type == .error {
                self?.error = nil
            }
        }
    }

    private static func isGhostPanelVisible(_ ghostName: String) -> Bool {
        guard NSApp.isActive else { return false }

        return NSApp.windows.contains { window in
            window.isVisible && window.title == ghostName
        }
    }
}
