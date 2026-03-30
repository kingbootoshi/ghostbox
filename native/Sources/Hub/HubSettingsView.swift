import SwiftUI

enum HubSettingsFeedback {
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

struct HubSettingsDraft {
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

struct HubSettingsView: View {
    @Binding var settingsDraft: HubSettingsDraft
    let loadedConfig: GhostboxConfig?
    let isLoadingConfig: Bool
    let isSavingConfig: Bool
    let settingsFeedback: HubSettingsFeedback?
    let onRetry: () -> Void
    let onSave: () -> Void

    @AppStorage("serverURL") private var serverURL = ""
    @State private var serverToken = KeychainHelper.loadToken() ?? ""
    @FocusState private var isServerTokenFocused: Bool

    var body: some View {
        settingsContent
    }

    var settingsContent: some View {
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

    var loadingSettingsState: some View {
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

    var unavailableSettingsState: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Settings are unavailable right now.")
                .font(Theme.Typography.body(weight: .medium))
                .foregroundColor(Color.white.opacity(Theme.Text.secondary))

            Button(action: onRetry) {
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

    var settingsForm: some View {
        VStack(alignment: .leading, spacing: 18) {
            HubSettingsSection(title: "Connection") {
                HubFieldLabel("Server URL")
                HubTextField("http://localhost:8008", text: $serverURL)
                Text("Leave empty for localhost. Restart app after changing.")
                    .font(Theme.Typography.caption())
                    .foregroundColor(Color.white.opacity(Theme.Text.tertiary))

                HubFieldLabel("API Token")
                HubSecureField("Not set", text: $serverToken)
                    .focused($isServerTokenFocused)
                Text("Required for remote servers. Get from ghostbox admin token.")
                    .font(Theme.Typography.caption())
                    .foregroundColor(Color.white.opacity(Theme.Text.tertiary))
            }

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
        .onChange(of: isServerTokenFocused) {
            if !isServerTokenFocused {
                persistServerToken()
            }
        }
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

    private func saveSettings() {
        persistServerToken()
        onSave()
    }

    private func persistServerToken() {
        let sanitizedToken = Self.sanitizedToken(serverToken)
        serverToken = sanitizedToken

        if sanitizedToken.isEmpty {
            KeychainHelper.deleteToken()
        } else {
            try? KeychainHelper.save(token: sanitizedToken)
        }
    }

    private static func sanitizedToken(_ token: String) -> String {
        token.filter { !$0.isWhitespace && !$0.isNewline }
    }
}
