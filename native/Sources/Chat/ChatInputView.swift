import SwiftUI

struct ChatInputView: View {
    @Binding var inputText: String
    let ghostName: String
    let isLoadingHistory: Bool
    let isCompacting: Bool
    let isInputFocused: FocusState<Bool>.Binding
    let showsSlashCommandPopup: Bool
    let firstFilteredSlashCommand: GhostSlashCommand?
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
                .padding(.horizontal, 18)
                .padding(.vertical, 14)
                .background(Color.white.opacity(0.02))
                .clipShape(RoundedRectangle(cornerRadius: 18))
                .padding(.horizontal, 18)

            Text(footerHint)
                .font(Theme.Typography.caption())
                .foregroundColor(Color.white.opacity(0.08))
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

    private func submitInput() {
        onSubmit()
    }
}
