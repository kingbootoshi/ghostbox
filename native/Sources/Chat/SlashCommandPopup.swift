import SwiftUI

struct SlashCommandPopup: View {
    let commands: [GhostSlashCommand]
    let isLoading: Bool
    let emptyStateText: String?
    let onSelect: (GhostSlashCommand) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Slash commands")
                .font(Theme.Typography.label(weight: .semibold))
                .foregroundColor(Theme.Colors.accentLightest)

            VStack(alignment: .leading, spacing: 6) {
                if commands.isEmpty {
                    emptyStateRow
                } else {
                    ForEach(commands) { command in
                        Button {
                            onSelect(command)
                        } label: {
                            HStack(alignment: .top, spacing: 10) {
                                Text("/\(command.name)")
                                    .font(Theme.Typography.label(weight: .semibold))
                                    .foregroundColor(Theme.Colors.accentLightest)
                                    .frame(width: 92, alignment: .leading)

                                Text(command.description)
                                    .font(Theme.Typography.body())
                                    .foregroundColor(Color.white.opacity(Theme.Text.secondary))
                                    .frame(maxWidth: .infinity, alignment: .leading)
                            }
                            .padding(.horizontal, 12)
                            .padding(.vertical, 10)
                            .background(Color.white.opacity(0.04))
                            .clipShape(RoundedRectangle(cornerRadius: 14))
                            .overlay(
                                RoundedRectangle(cornerRadius: 14)
                                    .strokeBorder(Theme.Colors.accentLight.opacity(0.18), lineWidth: 0.5)
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 20)
                .fill(Theme.Colors.surfaceElevated.opacity(0.96))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 20)
                .strokeBorder(Theme.Colors.accentLight.opacity(0.22), lineWidth: 0.6)
        )
        .shadow(color: Theme.Colors.accent.opacity(0.18), radius: 22, x: 0, y: 12)
    }

    @ViewBuilder
    private var emptyStateRow: some View {
        HStack(spacing: 10) {
            if isLoading {
                ProgressView()
                    .controlSize(.small)
                    .tint(Theme.Colors.accentLight)
            }

            Text(emptyStateText ?? "No slash commands available.")
                .font(Theme.Typography.body())
                .foregroundColor(Color.white.opacity(Theme.Text.secondary))
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Color.white.opacity(0.04))
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .strokeBorder(Theme.Colors.accentLight.opacity(0.18), lineWidth: 0.5)
        )
    }

    static func slashAutocompleteQuery(for inputText: String) -> String? {
        guard inputText.hasPrefix("/") else { return nil }

        let remainder = String(inputText.dropFirst())
        guard !remainder.contains(where: \.isWhitespace) else { return nil }

        return remainder.lowercased()
    }

    static func filteredSlashCommands(
        from slashCommands: [GhostSlashCommand],
        query: String?
    ) -> [GhostSlashCommand] {
        guard let query else { return [] }
        guard !query.isEmpty else { return slashCommands }

        return slashCommands.filter { command in
            command.name.range(of: query, options: [.anchored, .caseInsensitive]) != nil
        }
    }
}

extension AgentChatView {
    var slashCommandPopup: some View {
        SlashCommandPopup(
            commands: filteredSlashCommands,
            isLoading: isLoadingSlashCommands && filteredSlashCommands.isEmpty,
            emptyStateText: slashCommandEmptyStateText,
            onSelect: selectSlashCommand
        )
    }

    var slashAutocompleteQuery: String? {
        SlashCommandPopup.slashAutocompleteQuery(for: viewModel.input.inputText)
    }

    var filteredSlashCommands: [GhostSlashCommand] {
        SlashCommandPopup.filteredSlashCommands(
            from: slashCommands,
            query: slashAutocompleteQuery
        )
    }

    var showsSlashCommandPopup: Bool {
        !showsVaultBrowser &&
        isSlashCommandPopupVisible &&
        fullscreenToolGroup == nil &&
        slashAutocompleteQuery != nil
    }

    func handleInputTextChanged() {
        let shouldShowPopup = slashAutocompleteQuery != nil
        let becameVisible = shouldShowPopup && !isSlashCommandPopupVisible
        isSlashCommandPopupVisible = shouldShowPopup

        if becameVisible {
            didAttemptSlashCommandFetchForVisiblePopup = false
        }

        guard isSlashCommandPopupVisible else {
            didAttemptSlashCommandFetchForVisiblePopup = false
            return
        }
        loadSlashCommandsIfNeeded()
    }

    func selectSlashCommand(_ command: GhostSlashCommand) {
        viewModel.input.inputText = "/\(command.name) "
        dismissSlashCommandPopup()
        isInputFocused = true
    }

    func dismissSlashCommandPopup() {
        isSlashCommandPopupVisible = false
        didAttemptSlashCommandFetchForVisiblePopup = false
    }

    func loadSlashCommandsIfNeeded() {
        guard !didAttemptSlashCommandFetchForVisiblePopup else { return }
        guard !isLoadingSlashCommands else { return }

        didAttemptSlashCommandFetchForVisiblePopup = true
        isLoadingSlashCommands = slashCommands.isEmpty

        Task {
            do {
                let fetchedCommands = try await viewModel.ghostboxClient.fetchCommands(ghostName: viewModel.ghostName)
                await MainActor.run {
                    slashCommands = fetchedCommands
                    isLoadingSlashCommands = false
                }
            } catch {
                await MainActor.run {
                    isLoadingSlashCommands = false
                }
            }
        }
    }

    var slashCommandEmptyStateText: String? {
        guard filteredSlashCommands.isEmpty else { return nil }

        if isLoadingSlashCommands {
            return "Loading slash commands..."
        }

        if slashCommands.isEmpty {
            return "No slash commands available."
        }

        return "No matching slash commands."
    }
}
