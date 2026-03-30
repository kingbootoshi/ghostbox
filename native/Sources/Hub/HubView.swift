import SwiftUI

struct HubView: View {
    @EnvironmentObject private var appState: AppState
    @StateObject private var viewModel: HubViewModel
    private let client: GhostboxClient
    @State private var showHotkeyHelp = false
    @State private var showsSettings = false
    @State private var isLoadingConfig = false
    @State private var isSavingConfig = false
    @State private var settingsDraft = HubSettingsDraft()
    @State private var loadedConfig: GhostboxConfig?
    @State private var settingsFeedback: HubSettingsFeedback?

    init(client: GhostboxClient) {
        self.client = client
        _viewModel = StateObject(wrappedValue: HubViewModel(client: client))
    }

    private var displayGhosts: [Ghost] {
        viewModel.ghosts.isEmpty ? appState.ghosts : viewModel.ghosts
    }

    var body: some View {
        ZStack {
            VStack(spacing: 0) {
                titleSection

                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        if showsSettings {
                            HubSettingsView(
                                settingsDraft: $settingsDraft,
                                loadedConfig: loadedConfig,
                                isLoadingConfig: isLoadingConfig,
                                isSavingConfig: isSavingConfig,
                                settingsFeedback: settingsFeedback,
                                onRetry: {
                                    Task { await loadSettings() }
                                },
                                onSave: saveSettings
                            )
                        } else {
                            ghostListContent
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.top, 22)
                    .padding(.bottom, 18)
                }

                if !showsSettings && !appState.isStartingServer {
                    footer
                }
            }

            if showHotkeyHelp {
                HotkeyHelpOverlay {
                    dismissHotkeyHelp()
                }
                .transition(.opacity)
                .zIndex(1)
            }
        }
        .background(Color.clear)
        .onAppear {
            if !appState.isStartingServer {
                viewModel.startPolling()
            }
        }
        .onChange(of: appState.isStartingServer) {
            if !appState.isStartingServer {
                viewModel.error = nil
                viewModel.startPolling()
            }
        }
        .onDisappear {
            viewModel.stopPolling()
        }
        .onReceive(viewModel.$ghosts) { ghosts in
            appState.ghosts = ghosts
        }
        .onReceive(viewModel.$isLoading) { isLoading in
            appState.isLoading = isLoading
        }
        .onReceive(viewModel.$error) { error in
            appState.error = error
        }
        .onKeyPress(.escape, action: handleEscapeKey)
        .onKeyPress(phases: [.down]) { keyPress in
            handleHubShortcut(keyPress)
        }
    }

    private var ghostListContent: some View {
        Group {
            if appState.isStartingServer, let serverStatus = appState.serverStatus {
                serverStatusView(serverStatus, isFailure: false)
            } else if !appState.isStartingServer, let error = viewModel.error {
                errorView(error)
            }

            if displayGhosts.isEmpty && !appState.isStartingServer && appState.serverStatus == nil {
                emptyState
            } else {
                ForEach(displayGhosts) { ghost in
                    GhostRow(
                        ghost: ghost,
                        onOpen: {
                            NotificationCenter.default.post(
                                name: .openGhostChat,
                                object: nil,
                                userInfo: ["ghostName": ghost.name]
                            )
                        },
                        onKill: {
                            Task { await viewModel.kill(name: ghost.name) }
                        },
                        onWake: {
                            Task { await viewModel.wake(name: ghost.name) }
                        },
                        onRemove: {
                            Task { await viewModel.remove(name: ghost.name) }
                        }
                    )
                }
            }

            if viewModel.showSpawnForm {
                SpawnFormView(
                    name: $viewModel.spawnName,
                    provider: $viewModel.spawnProvider,
                    model: $viewModel.spawnModel,
                    systemPrompt: $viewModel.spawnSystemPrompt,
                    isLoading: viewModel.isSpawning,
                    onSpawn: { Task { await viewModel.spawn() } },
                    onCancel: { viewModel.showSpawnForm = false }
                )
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
    }

    private var titleSection: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 8) {
                Text("GHOSTBOX")
                    .font(Theme.Typography.label(weight: .semibold))
                    .foregroundColor(Color.white.opacity(0.35))
                    .tracking(3.2)

                if showsSettings {
                    Text("Settings")
                        .font(Theme.Typography.display())
                        .foregroundColor(Theme.Colors.accentLight)
                }

                if viewModel.isLoading && displayGhosts.isEmpty && !showsSettings {
                    ProgressView()
                        .controlSize(.small)
                        .tint(Theme.Colors.accentLight)
                }

                if isLoadingConfig && showsSettings {
                    ProgressView()
                        .controlSize(.small)
                        .tint(Theme.Colors.accentLight)
                }
            }

            Spacer(minLength: 0)

            HStack(spacing: 8) {
                CircularIconButton(
                    systemImage: showsSettings ? "gearshape.fill" : "gearshape",
                    action: toggleSettings,
                    size: 30,
                    iconSize: Theme.FontSize.sm,
                    foregroundColor: showsSettings ? Theme.Colors.accentLightest : Color.white.opacity(0.72),
                    backgroundColor: showsSettings ? Theme.Colors.accent.opacity(0.22) : Theme.Colors.controlBackground,
                    borderColor: showsSettings ? Theme.Colors.accentLight.opacity(0.28) : Color.white.opacity(0.06)
                )

                CircularIconButton(
                    systemImage: "xmark",
                    action: {
                        NSApp.keyWindow?.orderOut(nil)
                    },
                    size: 30,
                    iconSize: 10,
                    foregroundColor: Color.white.opacity(0.4),
                    backgroundColor: Theme.Colors.controlBackground,
                    borderColor: Color.white.opacity(0.06)
                )
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 22)
        .background(WindowDragArea())
    }

    private var footer: some View {
        VStack(spacing: 10) {
            Rectangle()
                .fill(Color.white.opacity(0.04))
                .frame(height: 1)

            Button {
                withAnimation(.easeOut(duration: 0.18)) {
                    viewModel.showSpawnForm.toggle()
                }
            } label: {
                Text(viewModel.showSpawnForm ? "Close Form" : "Spawn Ghost")
                    .font(Theme.Typography.label(weight: .semibold))
                    .foregroundColor(.white.opacity(0.9))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 13)
                    .background(Theme.Colors.accent.opacity(0.35))
                    .overlay(
                        RoundedRectangle(cornerRadius: Theme.Layout.inputCornerRadius)
                            .strokeBorder(Theme.Colors.accentLight.opacity(0.3), lineWidth: 0.5)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Layout.inputCornerRadius))
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 20)
            .padding(.bottom, 18)
        }
    }

    private func serverStatusView(_ message: String, isFailure: Bool) -> some View {
        HStack(spacing: 10) {
            if appState.isStartingServer {
                ProgressView()
                    .controlSize(.small)
                    .tint(Theme.Colors.accentLight)
            }

            Text(message)
                .font(Theme.Typography.body(weight: .medium))
                .foregroundColor(isFailure ? Color.orange.opacity(0.9) : Theme.Colors.accentLight)
        }
        .padding(.vertical, 16)
        .frame(maxWidth: .infinity)
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("No ghosts yet.")
                .font(Theme.Typography.body(weight: .medium))
                .foregroundColor(Color.white.opacity(0.6))

            Text("Spawn one to start a conversation.")
                .font(Theme.Typography.body())
                .foregroundColor(Color.white.opacity(0.35))
        }
        .padding(.top, 4)
    }

    private func errorView(_ message: String) -> some View {
        Text(message)
            .font(Theme.Typography.body())
            .foregroundColor(Color.orange.opacity(0.9))
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.orange.opacity(0.08))
            .clipShape(RoundedRectangle(cornerRadius: Theme.Layout.inputCornerRadius))
    }

    private func toggleSettings() {
        let nextShowsSettings = !showsSettings

        withAnimation(.easeOut(duration: 0.18)) {
            showsSettings = nextShowsSettings
            if nextShowsSettings {
                viewModel.showSpawnForm = false
            }
        }

        settingsFeedback = nil

        if nextShowsSettings {
            Task { await loadSettings() }
        }
    }

    @MainActor
    private func loadSettings() async {
        isLoadingConfig = true
        defer { isLoadingConfig = false }

        do {
            let config = try await client.fetchConfig()
            loadedConfig = config
            settingsDraft.apply(config)
            settingsFeedback = nil
        } catch {
            settingsFeedback = .error(error.localizedDescription)
        }
    }

    private func saveSettings() {
        Task {
            await saveSettingsTask()
        }
    }

    @MainActor
    private func saveSettingsTask() async {
        let changes = settingsDraft.changes(from: loadedConfig)

        guard !changes.isEmpty else {
            settingsFeedback = .success("Nothing changed.")
            return
        }

        isSavingConfig = true
        defer { isSavingConfig = false }

        do {
            let updatedConfig = try await client.updateConfig(changes: changes)
            loadedConfig = updatedConfig
            settingsDraft.apply(updatedConfig)
            settingsFeedback = .success("Settings saved.")
        } catch {
            settingsFeedback = .error(error.localizedDescription)
        }
    }

    private func toggleHotkeyHelp() {
        withAnimation(.easeOut(duration: 0.18)) {
            showHotkeyHelp.toggle()
        }
    }

    private func dismissHotkeyHelp() {
        guard showHotkeyHelp else { return }

        withAnimation(.easeOut(duration: 0.18)) {
            showHotkeyHelp = false
        }
    }

    private func handleEscapeKey() -> KeyPress.Result {
        guard showHotkeyHelp else { return .ignored }

        dismissHotkeyHelp()
        return .handled
    }

    private func handleHubShortcut(_ keyPress: KeyPress) -> KeyPress.Result {
        guard keyPress.modifiers == [.command], keyPress.characters == "/" else {
            return .ignored
        }

        toggleHotkeyHelp()
        return .handled
    }
}

extension Notification.Name {
    static let openGhostChat = Notification.Name("openGhostChat")
    static let closeGhostChat = Notification.Name("closeGhostChat")
}
