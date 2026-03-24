import SwiftUI

struct HotkeyHelpOverlay: View {
    let onDismiss: () -> Void

    var body: some View {
        ZStack {
            Color.black.opacity(0.7)
                .ignoresSafeArea()

            VStack(alignment: .leading, spacing: 18) {
                Text("Keyboard Shortcuts")
                    .font(Theme.Typography.display(Theme.FontSize.xxl, weight: .semibold))
                    .foregroundColor(Theme.Colors.accentLightest)

                VStack(alignment: .leading, spacing: 12) {
                    ForEach(ShortcutItem.allCases) { item in
                        HStack(alignment: .top, spacing: 16) {
                            Text(item.shortcut)
                                .font(Theme.Typography.label(Theme.FontSize.md, weight: .semibold))
                                .foregroundColor(Theme.Colors.accentLight)
                                .frame(width: 120, alignment: .leading)

                            Text(item.description)
                                .font(Theme.Typography.body())
                                .foregroundColor(Color.white.opacity(Theme.Text.secondary))
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }

                Text("Click anywhere or press Escape to dismiss.")
                    .font(Theme.Typography.caption())
                    .foregroundColor(Color.white.opacity(Theme.Text.tertiary))
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 22)
            .frame(maxWidth: 420, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 24)
                    .fill(Theme.Colors.surfaceElevated.opacity(0.96))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 24)
                    .strokeBorder(Theme.Colors.accentLight.opacity(0.28), lineWidth: 0.8)
            )
            .shadow(color: Theme.Colors.accent.opacity(0.2), radius: 30, x: 0, y: 16)
        }
        .contentShape(Rectangle())
        .onTapGesture {
            onDismiss()
        }
    }
}

enum ShortcutItem: String, CaseIterable, Identifiable {
    case toggleGhostbox
    case toggleChatFiles
    case toggleFullscreen
    case showHelp
    case closePanel
    case autocompleteSlashCommand
    case sendMessage

    var id: String { rawValue }

    var shortcut: String {
        switch self {
        case .toggleGhostbox:
            return "Cmd+Shift+G"
        case .toggleChatFiles:
            return "Cmd+\\"
        case .toggleFullscreen:
            return "Cmd+F"
        case .showHelp:
            return "Cmd+/"
        case .closePanel:
            return "Esc"
        case .autocompleteSlashCommand:
            return "Tab"
        case .sendMessage:
            return "Return"
        }
    }

    var description: String {
        switch self {
        case .toggleGhostbox:
            return "Toggle Ghostbox"
        case .toggleChatFiles:
            return "Switch to Chat / Files"
        case .toggleFullscreen:
            return "Toggle fullscreen"
        case .showHelp:
            return "Show this help"
        case .closePanel:
            return "Close panel"
        case .autocompleteSlashCommand:
            return "Autocomplete slash command"
        case .sendMessage:
            return "Send message"
        }
    }
}
