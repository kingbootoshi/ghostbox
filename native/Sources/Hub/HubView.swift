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
                            settingsContent
                        } else {
                            ghostListContent
                        }
                    }
                    .padding(.horizontal, 20)
                    .padding(.top, 22)
                    .padding(.bottom, 18)
                }

                if !showsSettings {
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
            viewModel.startPolling()
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
            if let error = viewModel.error {
                errorView(error)
            }

            if displayGhosts.isEmpty {
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

            Button(action: toggleSettings) {
                Image(systemName: showsSettings ? "gearshape.fill" : "gearshape")
                    .font(.system(size: Theme.FontSize.sm, weight: .semibold))
                    .foregroundColor(showsSettings ? Theme.Colors.accentLightest : Color.white.opacity(0.72))
                    .frame(width: 30, height: 30)
                    .background(showsSettings ? Theme.Colors.accent.opacity(0.22) : Color.white.opacity(0.05))
                    .overlay(
                        Circle()
                            .strokeBorder(
                                showsSettings
                                    ? Theme.Colors.accentLight.opacity(0.28)
                                    : Color.white.opacity(0.06),
                                lineWidth: 0.6
                            )
                    )
                    .clipShape(Circle())
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 20)
        .padding(.top, 22)
    }

    private var settingsContent: some View {
        VStack(alignment: .leading, spacing: 18) {
            if let feedback = settingsFeedback {
                settingsFeedbackView(feedback)
            }

            if isLoadingConfig && loadedConfig == nil {
                loadingSettingsState
            } else if loadedConfig == nil {
                unavailableSettingsState
            } else {
                settingsForm
            }
        }
    }

    private var loadingSettingsState: some View {
        VStack(alignment: .leading, spacing: 10) {
            ProgressView()
                .controlSize(.small)
                .tint(Theme.Colors.accentLight)

            Text("Loading settings...")
                .font(Theme.Typography.body())
                .foregroundColor(Color.white.opacity(Theme.Text.secondary))
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.white.opacity(0.02))
        .clipShape(RoundedRectangle(cornerRadius: 22))
    }

    private var unavailableSettingsState: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Settings are unavailable right now.")
                .font(Theme.Typography.body(weight: .medium))
                .foregroundColor(Color.white.opacity(Theme.Text.secondary))

            Button {
                Task { await loadSettings() }
            } label: {
                Text("Retry")
                    .font(Theme.Typography.label(weight: .semibold))
                    .foregroundColor(.white.opacity(0.9))
                    .padding(.horizontal, 14)
                    .padding(.vertical, 10)
                    .background(Theme.Colors.accent.opacity(0.35))
                    .clipShape(RoundedRectangle(cornerRadius: 16))
            }
            .buttonStyle(.plain)
        }
        .padding(18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.white.opacity(0.02))
        .clipShape(RoundedRectangle(cornerRadius: 22))
    }

    private var settingsForm: some View {
        VStack(alignment: .leading, spacing: 18) {
            HubSettingsSection(title: "General") {
                HubFieldLabel("Default Provider")
                Picker("", selection: $settingsDraft.defaultProvider) {
                    Text("anthropic").tag("anthropic")
                    Text("openai").tag("openai")
                }
                .labelsHidden()
                .pickerStyle(.segmented)
                .colorScheme(.dark)

                HubFieldLabel("Default Model")
                HubTextField("claude-sonnet-4-6", text: $settingsDraft.defaultModel)

                HubFieldLabel("Docker Image Name")
                HubTextField("ghostbox-agent", text: $settingsDraft.imageName)
            }

            HubSettingsSection(title: "Integrations") {
                HubFieldLabel("GitHub Remote URL")
                HubTextField("https://github.com/org/repo.git", text: $settingsDraft.githubRemote)

                HubFieldLabel("GitHub Token")
                HubSecureField("Not set", text: $settingsDraft.githubToken)
                if settingsDraft.githubToken.contains("...") {
                    maskedValueLabel(settingsDraft.githubToken)
                }

                HubFieldLabel("Telegram Bot Token")
                HubSecureField("Not set", text: $settingsDraft.telegramToken)
                if settingsDraft.telegramToken.contains("...") {
                    maskedValueLabel(settingsDraft.telegramToken)
                }
            }

            Button(action: saveSettings) {
                HStack(spacing: 8) {
                    if isSavingConfig {
                        ProgressView()
                            .controlSize(.small)
                            .tint(.white)
                    }

                    Text(isSavingConfig ? "Saving..." : "Save")
                        .font(Theme.Typography.label(weight: .semibold))
                }
                .foregroundColor(.white)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 13)
                .background(Theme.Colors.accent.opacity(0.78))
                .overlay(
                    RoundedRectangle(cornerRadius: 18)
                        .strokeBorder(Theme.Colors.accentLight.opacity(0.3), lineWidth: 0.5)
                )
                .clipShape(RoundedRectangle(cornerRadius: 18))
            }
            .buttonStyle(.plain)
            .disabled(isLoadingConfig || isSavingConfig)
        }
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
                        RoundedRectangle(cornerRadius: 18)
                            .strokeBorder(Theme.Colors.accentLight.opacity(0.3), lineWidth: 0.5)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 18))
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 20)
            .padding(.bottom, 18)
        }
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
            .clipShape(RoundedRectangle(cornerRadius: 18))
    }

    private func settingsFeedbackView(_ feedback: HubSettingsFeedback) -> some View {
        Text(feedback.message)
            .font(Theme.Typography.body())
            .foregroundColor(feedback.isSuccess ? Theme.Colors.accentLightest : Color.orange.opacity(0.9))
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(feedback.isSuccess ? Theme.Colors.accent.opacity(0.12) : Color.orange.opacity(0.08))
            .clipShape(RoundedRectangle(cornerRadius: 18))
    }

    private func maskedValueLabel(_ value: String) -> some View {
        Text(value)
            .font(Theme.Typography.caption())
            .foregroundColor(Color.white.opacity(Theme.Text.tertiary))
            .padding(.leading, 2)
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

private struct HubSettingsSection<Content: View>: View {
    let title: String
    let content: () -> Content

    init(title: String, @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title)
                .font(Theme.Typography.display())
                .foregroundColor(Color.white.opacity(0.82))

            VStack(alignment: .leading, spacing: 10) {
                content()
            }
        }
        .padding(18)
        .background(Color.white.opacity(0.02))
        .clipShape(RoundedRectangle(cornerRadius: 22))
    }
}

private struct HubFieldLabel: View {
    let title: String

    init(_ title: String) {
        self.title = title
    }

    var body: some View {
        Text(title)
            .font(Theme.Typography.label(weight: .semibold))
            .foregroundColor(Color.white.opacity(0.35))
            .tracking(0.8)
    }
}

private struct HubTextField: View {
    let placeholder: String
    @Binding var text: String

    init(_ placeholder: String, text: Binding<String>) {
        self.placeholder = placeholder
        _text = text
    }

    var body: some View {
        TextField(placeholder, text: $text)
            .textFieldStyle(.plain)
            .font(Theme.Typography.body(Theme.FontSize.lg))
            .foregroundColor(Color.white.opacity(0.82))
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(Color.white.opacity(0.05))
            .clipShape(RoundedRectangle(cornerRadius: 18))
    }
}

private struct HubSecureField: View {
    let placeholder: String
    @Binding var text: String

    init(_ placeholder: String, text: Binding<String>) {
        self.placeholder = placeholder
        _text = text
    }

    var body: some View {
        SecureField(placeholder, text: $text)
            .textFieldStyle(.plain)
            .font(Theme.Typography.body(Theme.FontSize.lg))
            .foregroundColor(Color.white.opacity(0.82))
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(Color.white.opacity(0.05))
            .clipShape(RoundedRectangle(cornerRadius: 18))
    }
}

private enum HubSettingsFeedback {
    case success(String)
    case error(String)

    var message: String {
        switch self {
        case let .success(message), let .error(message):
            return message
        }
    }

    var isSuccess: Bool {
        switch self {
        case .success:
            return true
        case .error:
            return false
        }
    }
}

private struct HubSettingsDraft {
    var defaultProvider = "anthropic"
    var defaultModel = ""
    var imageName = "ghostbox-agent"
    var githubRemote = ""
    var githubToken = ""
    var telegramToken = ""

    mutating func apply(_ config: GhostboxConfig) {
        defaultProvider = config.defaultProvider
        defaultModel = config.defaultModel
        imageName = config.imageName
        githubRemote = config.githubRemote ?? ""
        githubToken = config.githubToken
        telegramToken = config.telegramToken
    }

    func changes(from config: GhostboxConfig?) -> [String: Any] {
        guard let config else {
            return [
                "defaultProvider": defaultProvider,
                "defaultModel": defaultModel,
                "imageName": imageName,
                "githubRemote": githubRemote,
                "githubToken": githubToken,
                "telegramToken": telegramToken,
            ]
        }

        var changes: [String: Any] = [:]

        if defaultProvider != config.defaultProvider {
            changes["defaultProvider"] = defaultProvider
        }

        if defaultModel != config.defaultModel {
            changes["defaultModel"] = defaultModel
        }

        if imageName != config.imageName {
            changes["imageName"] = imageName
        }

        if githubRemote != (config.githubRemote ?? "") {
            changes["githubRemote"] = githubRemote
        }

        if githubToken != config.githubToken {
            changes["githubToken"] = githubToken
        }

        if telegramToken != config.telegramToken {
            changes["telegramToken"] = telegramToken
        }

        return changes
    }
}

private struct GhostRow: View {
    let ghost: Ghost
    let onOpen: () -> Void
    let onKill: () -> Void
    let onWake: () -> Void
    let onRemove: () -> Void

    @State private var showKillConfirm = false
    @State private var showRemoveConfirm = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Button(action: onOpen) {
                HStack(alignment: .top, spacing: 12) {
                    statusDot

                    VStack(alignment: .leading, spacing: 5) {
                        Text(ghost.name)
                            .font(Theme.Typography.display())
                            .foregroundColor(Theme.Colors.accentLight)

                        HStack(spacing: 6) {
                            Text(ghost.status.rawValue.capitalized)
                            Text("·")
                            Text("\(ghost.provider) / \(ghost.model)")
                        }
                        .font(Theme.Typography.label(weight: .regular))
                        .foregroundColor(Color.white.opacity(0.35))
                    }

                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            HStack(spacing: 8) {
                if ghost.status == .running {
                    actionButton(title: "Kill", tint: Color.red.opacity(0.9)) {
                        showKillConfirm = true
                    }
                }

                if ghost.status == .stopped {
                    actionButton(title: "Wake", tint: Color.green.opacity(0.9), action: onWake)
                }

                actionButton(title: "Remove", tint: Color.red.opacity(0.5)) {
                    showRemoveConfirm = true
                }
            }
        }
        .padding(16)
        .background(Color.white.opacity(0.02))
        .clipShape(RoundedRectangle(cornerRadius: 22))
        .alert("Kill \(ghost.name)?", isPresented: $showKillConfirm) {
            Button("Cancel", role: .cancel) {}
            Button("Kill", role: .destructive, action: onKill)
        } message: {
            Text("This stops the ghost container. You can wake it again later.")
        }
        .alert("Remove \(ghost.name)?", isPresented: $showRemoveConfirm) {
            Button("Cancel", role: .cancel) {}
            Button("Remove", role: .destructive, action: onRemove)
        } message: {
            Text("This permanently deletes the ghost and its container. The vault files are kept on disk.")
        }
    }

    private var statusDot: some View {
        Circle()
            .fill(statusColor)
            .frame(width: 8, height: 8)
            .padding(.top, 5)
    }

    private var statusColor: Color {
        switch ghost.status {
        case .running:
            return Color.green.opacity(0.9)
        case .stopped:
            return Color.red.opacity(0.9)
        case .error:
            return Color.orange.opacity(0.95)
        }
    }

    private func actionButton(title: String, tint: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(Theme.Typography.label())
                .foregroundColor(tint)
                .padding(.horizontal, 11)
                .padding(.vertical, 7)
                .background(Color.white.opacity(0.03))
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}

extension Notification.Name {
    static let openGhostChat = Notification.Name("openGhostChat")
    static let closeGhostChat = Notification.Name("closeGhostChat")
}
