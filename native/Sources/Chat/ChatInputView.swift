import SwiftUI

struct ChatInputView: View {
    @Binding var inputText: String
    let ghostName: String
    let isLoadingHistory: Bool
    let isCompacting: Bool
    let isInputFocused: FocusState<Bool>.Binding
    let showsSlashCommandPopup: Bool
    let firstFilteredSlashCommand: GhostSlashCommand?
    let stats: GhostStats?
    let onPasteCommand: () -> Bool
    let onSubmit: () -> Void

    var body: some View {
        VStack(spacing: 8) {
            TextField(inputPlaceholder, text: $inputText)
                .textFieldStyle(.plain)
                .font(Theme.Typography.body(Theme.FontSize.lg))
                .foregroundColor(Color.white.opacity(Theme.Text.primary))
                .focused(isInputFocused)
                .disabled(isLoadingHistory || isCompacting)
                .onSubmit { submitInput() }
                .onKeyPress(.tab) {
                    guard showsSlashCommandPopup, let firstFilteredSlashCommand else {
                        return .ignored
                    }

                    inputText = "/\(firstFilteredSlashCommand.name) "
                    return .handled
                }
                .onKeyPress { keyPress in
                    guard keyPress.modifiers.contains(.command),
                          keyPress.characters.caseInsensitiveCompare("v") == .orderedSame else {
                        return .ignored
                    }

                    return onPasteCommand() ? .handled : .ignored
                }
                .padding(.horizontal, 18)
                .padding(.vertical, 14)
                .background(Color.white.opacity(0.02))
                .clipShape(RoundedRectangle(cornerRadius: 18))
                .padding(.horizontal, 18)

            HStack(spacing: 0) {
                Text(footerHint)
                    .font(Theme.Typography.caption())
                    .foregroundColor(Color.white.opacity(0.08))

                if let tokenFooter = tokenFooterText {
                    Spacer()
                    Text(tokenFooter)
                        .font(Theme.Typography.mono(Theme.FontSize.xs))
                        .foregroundColor(Color.white.opacity(tokenFooterOpacity))
                }
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 12)
        }
    }

    private var inputPlaceholder: String {
        if isLoadingHistory {
            return "Loading chat history..."
        }

        if isCompacting {
            return "Compacting chat..."
        }

        return "Talk to \(ghostName)..."
    }

    private var footerHint: String {
        if isLoadingHistory {
            return "Please wait"
        }

        if isCompacting {
            return "Refreshing conversation"
        }

        return "Press return to send"
    }

    private var tokenFooterText: String? {
        guard let context = stats?.context else { return nil }
        return "\(Self.formatTokenCount(context.used)) / \(Self.formatTokenCount(context.window))"
    }

    private var tokenFooterOpacity: Double {
        guard let context = stats?.context else { return 0.08 }
        if context.percent > 75 { return 0.5 }
        if context.percent > 50 { return 0.2 }
        return 0.12
    }

    private static func formatTokenCount(_ count: Int) -> String {
        if count >= 1_000_000 {
            let value = Double(count) / 1_000_000
            return value.truncatingRemainder(dividingBy: 1) == 0
                ? "\(Int(value))M"
                : String(format: "%.1fM", value)
        }
        if count >= 1_000 {
            let value = Double(count) / 1_000
            return value.truncatingRemainder(dividingBy: 1) == 0
                ? "\(Int(value))K"
                : String(format: "%.1fK", value)
        }
        return "\(count)"
    }

    private func submitInput() {
        onSubmit()
    }
}
