import AppKit
import Carbon
import CoreText

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    let client = GhostboxClient()

    private lazy var appState = AppState(client: client)
    private var hubPanelController: HubPanelController?
    private var chatPanelControllers: [String: ChatPanelController] = [:]
    private var statusItem: NSStatusItem?
    private var hotKeyMonitor: HotKeyMonitor?

    private let panelAnimationStagger: TimeInterval = 0.03
    private let panelHideDuration: TimeInterval = 0.3
    private var serverProcess: Process?
    private var serverLogHandle: FileHandle?

    func applicationDidFinishLaunching(_ notification: Notification) {
        registerFonts()
        setupMenuBar()
        setupNotifications()
        setupHotkey()

        hubPanelController = HubPanelController(client: client, appState: appState)
        hubPanelController?.createPanelHidden()

        Task {
            appState.isStartingServer = true
            await ensureServerRunning()
            appState.isStartingServer = false
            _ = try? await client.listGhosts()
            try? await Task.sleep(for: .milliseconds(100))
            await MainActor.run {
                NSApp.activate(ignoringOtherApps: true)
                hubPanelController?.revealPanel()
            }
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
        if await client.healthCheck() { return }

        guard let projectRoot = findProjectRoot() else { return }

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

            for _ in 0..<30 {
                try? await Task.sleep(for: .milliseconds(300))
                if await client.healthCheck() { return }
            }
        } catch {
            try? serverLogHandle?.close()
            serverLogHandle = nil
            // Server failed to start - app will show connection error
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
        return nil
    }

    func toggleHub() {
        let anyVisible = (hubPanelController?.isVisible ?? false) ||
            chatPanelControllers.values.contains { $0.isVisible }

        if anyVisible {
            closeHubAndPanels()
        } else {
            openHubAndPanels()
        }
    }

    func openChat(ghostName: String) {
        if let controller = chatPanelControllers[ghostName] {
            NSApp.activate(ignoringOtherApps: true)
            controller.show()
            return
        }

        let controller = ChatPanelController(
            ghostName: ghostName,
            client: client,
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

        if let button = statusItem?.button {
            if let ghostImage = Self.loadMenuBarIcon() {
                button.image = ghostImage
            } else {
                button.title = "Ghost"
            }
        }

        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "Toggle Hub", action: #selector(toggleHubMenuAction), keyEquivalent: "g"))
        menu.items.last?.keyEquivalentModifierMask = [.command, .shift]
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
        statusItem?.menu = menu
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

    @objc private func handleOpenGhostChat(_ notification: Notification) {
        guard let ghostName = notification.userInfo?["ghostName"] as? String else { return }
        openChat(ghostName: ghostName)
    }

    @objc private func handleCloseGhostChat(_ notification: Notification) {
        guard let ghostName = notification.userInfo?["ghostName"] as? String else { return }
        closeChat(ghostName: ghostName)
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
