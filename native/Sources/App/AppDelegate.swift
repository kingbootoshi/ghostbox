import AppKit
import Carbon
import Combine
import CoreText
import SwiftUI
import UserNotifications

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private(set) var client: GhostboxClient = GhostboxClient.fromUserDefaults()

    private lazy var appState = AppState(client: client)
    private var hubPanelController: HubPanelController?
    private var chatPanelControllers: [String: ChatPanelController] = [:]
    private var statusItem: NSStatusItem?
    private var hotKeyMonitor: HotKeyMonitor?
    private var connectionWindow: NSWindow?

    private let panelAnimationStagger: TimeInterval = 0.03
    private let panelHideDuration: TimeInterval = 0.3
    private var serverProcess: Process?
    private var serverLogHandle: FileHandle?
    private var baseMenuBarIcon: NSImage?
    private var unreadObservation: AnyCancellable?
    private var lastRenderedBadgeCount: Int?

    private var hasConnection: Bool {
        GhostboxClient.fromUserDefaults().token != nil
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, error in
            print("[notifications] authorization granted=\(granted) error=\(String(describing: error))")
            if !granted {
                print("[notifications] banners will not appear - check System Settings > Notifications > Ghostbox")
            }
        }

        registerFonts()
        setupMenuBar()
        setupNotifications()
        setupHotkey()
        migrateLegacyServerTokenIfNeeded()

        if hasConnection {
            launchHub()
        } else {
            showConnectionWindow()
        }
    }

    func showConnectionWindow() {
        let connectionView = ConnectionView { [weak self] url, token in
            guard let self else { return }
            UserDefaults.standard.set(url, forKey: "serverURL")
            try? KeychainHelper.save(token: token)

            self.client = GhostboxClient(baseURL: URL(string: url), token: token)
            self.appState = AppState(client: self.client)
            self.bindUnreadObservation()

            // Order out immediately (no animation) to avoid dealloc crash
            let window = self.connectionWindow
            window?.animationBehavior = .none
            window?.orderOut(nil)
            self.connectionWindow = nil
            self.launchHub()
        }

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 480, height: 520),
            styleMask: [.borderless, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.backgroundColor = .clear
        window.isOpaque = false
        window.hasShadow = true
        window.isMovableByWindowBackground = true
        window.animationBehavior = .none

        let blur = NSVisualEffectView(frame: NSRect(x: 0, y: 0, width: 480, height: 520))
        blur.material = .hudWindow
        blur.blendingMode = .behindWindow
        blur.state = .active
        blur.wantsLayer = true
        blur.layer?.cornerRadius = Theme.Layout.cornerRadius
        blur.layer?.masksToBounds = true
        blur.layer?.borderWidth = 0

        let hostingView = NSHostingView(rootView: BorderlessGlass { connectionView })
        hostingView.translatesAutoresizingMaskIntoConstraints = false
        blur.addSubview(hostingView)
        NSLayoutConstraint.activate([
            hostingView.topAnchor.constraint(equalTo: blur.topAnchor),
            hostingView.bottomAnchor.constraint(equalTo: blur.bottomAnchor),
            hostingView.leadingAnchor.constraint(equalTo: blur.leadingAnchor),
            hostingView.trailingAnchor.constraint(equalTo: blur.trailingAnchor),
        ])

        window.contentView = blur
        window.center()

        connectionWindow = window
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    private func migrateLegacyServerTokenIfNeeded() {
        let defaults = UserDefaults.standard
        guard let legacyToken = defaults.string(forKey: "serverToken"), !legacyToken.isEmpty else {
            return
        }

        if KeychainHelper.loadToken() == nil {
            try? KeychainHelper.save(token: legacyToken)
        }

        defaults.removeObject(forKey: "serverToken")
    }

    private func launchHub() {
        hubPanelController = HubPanelController(client: client, appState: appState)
        hubPanelController?.createPanelHidden()

        Task {
            appState.isStartingServer = true
            appState.serverStatus = "Connecting to server..."

            NSApp.activate(ignoringOtherApps: true)
            hubPanelController?.revealPanel()

            await ensureServerRunning()
            appState.isStartingServer = false
            appState.serverStatus = nil
            _ = try? await client.listGhosts()
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        closeChatAll()
        if let process = serverProcess, process.isRunning {
            process.terminate()
        }
        try? serverLogHandle?.close()
        serverLogHandle = nil
    }

    private func ensureServerRunning() async {
        if await client.healthCheck() {
            appState.serverStatus = nil
            return
        }

        if client.isRemote {
            appState.serverStatus = "Remote server unreachable"
            return
        }

        appState.serverStatus = "Server not detected, starting..."
        guard let projectRoot = findProjectRoot() else {
            appState.serverStatus = "Failed to start server"
            return
        }

        let logDir = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".ghostbox")
        try? FileManager.default.createDirectory(at: logDir, withIntermediateDirectories: true)
        let logFile = logDir.appendingPathComponent("server.log")

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/opt/homebrew/bin/bun")
        process.arguments = ["run", "src/api.ts"]
        process.currentDirectoryURL = URL(fileURLWithPath: projectRoot)

        if !FileManager.default.fileExists(atPath: logFile.path) {
            FileManager.default.createFile(atPath: logFile.path, contents: nil)
        }

        if let handle = try? FileHandle(forWritingTo: logFile) {
            handle.seekToEndOfFile()
            process.standardOutput = handle
            process.standardError = handle
            serverLogHandle = handle
        }

        do {
            try process.run()
            serverProcess = process

            for attempt in 1...30 {
                appState.serverStatus = "Starting server... (\(attempt)/30)"
                try? await Task.sleep(for: .milliseconds(300))
                if await client.healthCheck() {
                    appState.serverStatus = nil
                    return
                }
            }
            appState.serverStatus = "Failed to start server"
        } catch {
            try? serverLogHandle?.close()
            serverLogHandle = nil
            appState.serverStatus = "Failed to start server"
        }
    }

    private func findProjectRoot() -> String? {
        var url = URL(fileURLWithPath: Bundle.main.bundlePath)
        for _ in 0..<10 {
            url = url.deletingLastPathComponent()
            if FileManager.default.fileExists(atPath: url.appendingPathComponent("src/api.ts").path) {
                return url.path
            }
        }

        let home = FileManager.default.homeDirectoryForCurrentUser.path
        for candidate in [
            "\(home)/Dev/ghostbox",
            "\(home)/dev/ghostbox",
            "\(home)/Developer/ghostbox",
            "\(home)/Projects/ghostbox",
        ] {
            if FileManager.default.fileExists(atPath: "\(candidate)/src/api.ts") {
                return candidate
            }
        }

        return nil
    }

    func toggleHub() {
        guard hasConnection else {
            if connectionWindow == nil {
                showConnectionWindow()
            } else {
                NSApp.activate(ignoringOtherApps: true)
                connectionWindow?.makeKeyAndOrderFront(nil)
            }
            return
        }

        let anyVisible = (hubPanelController?.isVisible ?? false) ||
            chatPanelControllers.values.contains { $0.isVisible }

        if anyVisible {
            closeHubAndPanels()
        } else {
            openHubAndPanels()
        }
    }

    func openChat(ghostName: String) {
        let ghost = appState.ghosts.first { $0.name == ghostName }

        if let controller = chatPanelControllers[ghostName] {
            controller.prepareForOpening(ghost: ghost)
            NSApp.activate(ignoringOtherApps: true)
            controller.show()
            return
        }

        let controller = ChatPanelController(
            ghostName: ghostName,
            client: client,
            initialGhost: ghost,
            stackIndex: chatPanelControllers.count,
            hubCenterProvider: { [weak self] in
                self?.hubPanelController?.hubCenter
            }
        )

        chatPanelControllers[ghostName] = controller
        NSApp.activate(ignoringOtherApps: true)
        controller.show()
    }

    func closeChat(ghostName: String) {
        guard let controller = chatPanelControllers[ghostName] else { return }
        controller.hide()
    }

    func closeChatAll() {
        let controllers = Array(chatPanelControllers.values)
        for controller in controllers {
            controller.hide()
        }
    }

    private var screenCenter: NSPoint {
        guard let screen = NSScreen.main else {
            return NSPoint(x: 500, y: 400)
        }
        let workArea = screen.visibleFrame
        return NSPoint(x: workArea.midX, y: workArea.midY)
    }

    private func openHubAndPanels(animated: Bool = true) {
        if hubPanelController == nil {
            hubPanelController = HubPanelController(client: client, appState: appState)
        }

        NSApp.activate(ignoringOtherApps: true)

        hubPanelController?.show(animated: animated)

        let controllersToShow = chatPanelControllers.values.filter { $0.wasOpen }
        for controller in controllersToShow {
            controller.showInPlace()
        }
    }

    private func closeHubAndPanels() {
        let controllersToHide = chatPanelControllers.values.filter { $0.isVisible }

        for controller in controllersToHide {
            controller.wasOpen = true
        }

        // Everything disappears at the same time, in place
        hubPanelController?.hide()

        for controller in controllersToHide {
            controller.hideInPlace()
        }
    }

    private func registerFonts() {
        guard let fontsURL = Bundle.main.resourceURL?.appendingPathComponent("Fonts"),
              let fontFiles = try? FileManager.default.contentsOfDirectory(
                  at: fontsURL,
                  includingPropertiesForKeys: nil
              ) else { return }

        for fontFile in fontFiles where fontFile.pathExtension == "ttf" || fontFile.pathExtension == "otf" {
            CTFontManagerRegisterFontsForURL(fontFile as CFURL, .process, nil)
        }
    }

    private func setupMenuBar() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem?.isVisible = true

        baseMenuBarIcon = Self.loadMenuBarIcon()
        if let button = statusItem?.button {
            if let icon = baseMenuBarIcon {
                button.image = icon
            } else {
                button.title = "Ghost"
            }
        }

        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Toggle Hub", action: #selector(toggleHubMenuAction), keyEquivalent: "g"))
        menu.items.last?.keyEquivalentModifierMask = [.command, .shift]
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Disconnect", action: #selector(disconnectMenuAction), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        statusItem?.menu = menu

        bindUnreadObservation()
    }

    private func bindUnreadObservation() {
        unreadObservation?.cancel()
        unreadObservation = appState.$unreadGhosts
            .receive(on: RunLoop.main)
            .sink { [weak self] unreads in
                self?.updateMenuBarBadge(count: unreads.count)
            }
    }

    private func updateMenuBarBadge(count: Int) {
        guard let button = statusItem?.button else { return }
        guard lastRenderedBadgeCount != count else { return }
        lastRenderedBadgeCount = count

        guard let baseIcon = baseMenuBarIcon else {
            button.title = count > 0 ? "Ghost (\(count))" : "Ghost"
            return
        }

        if count == 0 {
            button.image = baseIcon
            return
        }

        // Expand canvas so badge doesn't clip outside the icon bounds
        let iconSize = baseIcon.size
        let badgeDiameter: CGFloat = 12
        let padding: CGFloat = 4
        let canvasSize = NSSize(width: iconSize.width + padding, height: iconSize.height)

        let badgedIcon = NSImage(size: canvasSize, flipped: false) { _ in
            // Draw the ghost icon left-aligned
            baseIcon.draw(in: NSRect(origin: .zero, size: iconSize))

            // Badge in upper-right of the canvas
            let badgeRect = NSRect(
                x: canvasSize.width - badgeDiameter,
                y: canvasSize.height - badgeDiameter,
                width: badgeDiameter,
                height: badgeDiameter
            )
            NSColor.systemRed.setFill()
            NSBezierPath(ovalIn: badgeRect).fill()

            if count <= 9 {
                let attrs: [NSAttributedString.Key: Any] = [
                    .font: NSFont.systemFont(ofSize: 8, weight: .bold),
                    .foregroundColor: NSColor.white,
                ]
                let text = "\(count)" as NSString
                let textSize = text.size(withAttributes: attrs)
                text.draw(at: NSPoint(
                    x: badgeRect.midX - textSize.width / 2,
                    y: badgeRect.midY - textSize.height / 2
                ), withAttributes: attrs)
            }

            return true
        }

        // Not template - we need the red badge color to show
        badgedIcon.isTemplate = false
        button.image = badgedIcon
    }

    private func setupNotifications() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleOpenGhostChat(_:)),
            name: .openGhostChat,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleCloseGhostChat(_:)),
            name: .closeGhostChat,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleGhostUnread(_:)),
            name: .ghostUnread,
            object: nil
        )
    }

    @objc private func handleGhostUnread(_ notification: Notification) {
        guard let ghostName = notification.userInfo?["ghostName"] as? String else { return }
        appState.markUnread(ghostName)
    }

    private func setupHotkey() {
        hotKeyMonitor = HotKeyMonitor(handler: { [weak self] in
            self?.toggleHub()
        })
        hotKeyMonitor?.register()
    }

    private static func loadMenuBarIcon() -> NSImage? {
        guard let imageURL = Bundle.main.url(forResource: "ghost-menubar@2x", withExtension: "png", subdirectory: "Images"),
              let image = NSImage(contentsOf: imageURL) else {
            return nil
        }

        let targetHeight: CGFloat = 22
        let ratio = image.size.width / image.size.height
        let targetSize = NSSize(width: ceil(targetHeight * ratio), height: targetHeight)
        let resized = NSImage(size: targetSize)
        resized.lockFocus()
        image.draw(
            in: NSRect(origin: .zero, size: targetSize),
            from: NSRect(origin: .zero, size: image.size),
            operation: .copy,
            fraction: 1
        )
        resized.unlockFocus()
        return resized
    }

    @objc private func toggleHubMenuAction() {
        toggleHub()
    }

    @objc private func disconnectMenuAction() {
        UserDefaults.standard.removeObject(forKey: "serverURL")
        KeychainHelper.deleteToken()
        closeChatAll()
        hubPanelController?.hide()
        hubPanelController = nil
        chatPanelControllers.removeAll()
        showConnectionWindow()
    }

    @objc private func handleOpenGhostChat(_ notification: Notification) {
        guard let ghostName = notification.userInfo?["ghostName"] as? String else { return }
        appState.markRead(ghostName)
        openChat(ghostName: ghostName)
    }

    @objc private func handleCloseGhostChat(_ notification: Notification) {
        guard let ghostName = notification.userInfo?["ghostName"] as? String else { return }
        closeChat(ghostName: ghostName)
    }
}

extension AppDelegate: @preconcurrency UNUserNotificationCenterDelegate {
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        if let ghostName = response.notification.request.content.userInfo["ghostName"] as? String {
            appState.markRead(ghostName)
            openChat(ghostName: ghostName)
            NSApp.activate(ignoringOtherApps: true)
        }

        completionHandler()
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        // Always show the banner. The notification only fires when the ghost's
        // panel isn't visible, so if we get here the user needs to see it.
        // macOS suppresses banners for foreground apps by default - returning
        // .banner here overrides that.
        completionHandler([.banner, .sound, .badge])
    }
}

private final class HotKeyMonitor {
    private static let signature: OSType = 0x47424F58

    private let handler: @MainActor () -> Void
    private var hotKeyRef: EventHotKeyRef?
    private var eventHandlerRef: EventHandlerRef?

    init(handler: @escaping @MainActor () -> Void) {
        self.handler = handler
    }

    deinit {
        if let hotKeyRef {
            UnregisterEventHotKey(hotKeyRef)
        }

        if let eventHandlerRef {
            RemoveEventHandler(eventHandlerRef)
        }
    }

    func register() {
        guard hotKeyRef == nil else { return }

        var eventType = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyReleased)
        )

        InstallEventHandler(
            GetApplicationEventTarget(),
            { _, event, userData in
                guard let userData else { return noErr }
                let monitor = Unmanaged<HotKeyMonitor>.fromOpaque(userData).takeUnretainedValue()
                monitor.handle(event: event)
                return noErr
            },
            1,
            &eventType,
            Unmanaged.passUnretained(self).toOpaque(),
            &eventHandlerRef
        )

        let hotKeyID = EventHotKeyID(signature: Self.signature, id: 1)
        RegisterEventHotKey(
            UInt32(kVK_ANSI_G),
            UInt32(cmdKey | shiftKey),
            hotKeyID,
            GetEventDispatcherTarget(),
            0,
            &hotKeyRef
        )
    }

    private func handle(event: EventRef?) {
        guard let event else { return }

        var hotKeyID = EventHotKeyID()
        let status = GetEventParameter(
            event,
            EventParamName(kEventParamDirectObject),
            EventParamType(typeEventHotKeyID),
            nil,
            MemoryLayout<EventHotKeyID>.size,
            nil,
            &hotKeyID
        )

        guard status == noErr, hotKeyID.signature == Self.signature else { return }

        Task { @MainActor in
            handler()
        }
    }
}
