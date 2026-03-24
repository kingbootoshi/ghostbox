import SwiftUI

struct SlashCommandPopup: View {
    let commands: [GhostSlashCommand]
    let onSelect: (GhostSlashCommand) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Slash commands")
                .font(Theme.Typography.label(weight: .semibold))
                .foregroundColor(Theme.Colors.accentLightest)

            VStack(alignment: .leading, spacing: 6) {
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

    static let fallbackSlashCommands = [
        GhostSlashCommand(name: "compact", description: "Condense the current chat into a shorter summary."),
        GhostSlashCommand(name: "history", description: "Show the recent conversation history."),
        GhostSlashCommand(name: "model", description: "Check or change the model for this ghost."),
        GhostSlashCommand(name: "help", description: "List the available slash commands.")
    ]

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

    static func mergedSlashCommands(
        fallbackSlashCommands: [GhostSlashCommand],
        fetchedCommands: [GhostSlashCommand]
    ) -> [GhostSlashCommand] {
        var commandsByName = Dictionary(uniqueKeysWithValues: fallbackSlashCommands.map {
            ($0.name.lowercased(), $0)
        })

        for command in fetchedCommands {
            commandsByName[command.name.lowercased()] = command
        }

        let orderedNames = fallbackSlashCommands.map(\.name) + fetchedCommands.map(\.name)
        var seenNames = Set<String>()

        return orderedNames.compactMap { name in
            let normalizedName = name.lowercased()
            guard seenNames.insert(normalizedName).inserted else { return nil }
            return commandsByName[normalizedName]
        }
    }
}

extension AgentChatView {
    var slashCommandPopup: some View {
        SlashCommandPopup(
            commands: filteredSlashCommands,
            onSelect: selectSlashCommand
        )
    }

    var slashAutocompleteQuery: String? {
        SlashCommandPopup.slashAutocompleteQuery(for: viewModel.inputText)
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
        slashAutocompleteQuery != nil &&
        !filteredSlashCommands.isEmpty
    }

    func handleInputTextChanged() {
        isSlashCommandPopupVisible = slashAutocompleteQuery != nil

        guard isSlashCommandPopupVisible else { return }
        loadSlashCommandsIfNeeded()
    }

    func selectSlashCommand(_ command: GhostSlashCommand) {
        viewModel.inputText = "/\(command.name) "
        dismissSlashCommandPopup()
        isInputFocused = true
    }

    func dismissSlashCommandPopup() {
        isSlashCommandPopupVisible = false
    }

    func loadSlashCommandsIfNeeded() {
        guard !didAttemptSlashCommandFetch else { return }

        didAttemptSlashCommandFetch = true

        Task {
            do {
                let fetchedCommands = try await viewModel.ghostboxClient.fetchCommands(ghostName: viewModel.ghostName)
                await MainActor.run {
                    slashCommands = mergedSlashCommands(with: fetchedCommands)
                }
            } catch {
                await MainActor.run {
                    slashCommands = SlashCommandPopup.fallbackSlashCommands
                }
            }
        }
    }

    func mergedSlashCommands(with fetchedCommands: [GhostSlashCommand]) -> [GhostSlashCommand] {
        SlashCommandPopup.mergedSlashCommands(
            fallbackSlashCommands: SlashCommandPopup.fallbackSlashCommands,
            fetchedCommands: fetchedCommands
        )
    }
}
