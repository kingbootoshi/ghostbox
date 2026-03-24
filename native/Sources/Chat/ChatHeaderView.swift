import SwiftUI

struct ChatHeaderView: View {
    @ObservedObject var viewModel: AgentChatViewModel
    @Binding var showsVaultBrowser: Bool
    let statusColor: Color
    let toggleVaultBrowser: () -> Void
    let closeCurrentPanel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 10) {
                Circle()
                    .fill(statusColor)
                    .frame(width: 8, height: 8)

                Text(viewModel.ghostName)
                    .font(Theme.Typography.display())
                    .foregroundColor(Theme.Colors.accentLight)

                Text(viewModel.ghost?.model ?? "Loading...")
                    .font(Theme.Typography.label(weight: .regular))
                    .foregroundColor(Color.white.opacity(Theme.Text.tertiary))

                Spacer(minLength: 0)

                if viewModel.isStreaming {
                    Button("Stop") {
                        viewModel.cancelStream()
                    }
                    .font(Theme.Typography.label())
                    .foregroundColor(Color.white.opacity(Theme.Text.secondary))
                    .buttonStyle(.plain)
                }

                ChatHeaderButton(
                    title: showsVaultBrowser ? "Chat" : "Files",
                    systemImage: showsVaultBrowser ? "bubble.left.and.bubble.right" : "folder",
                    action: toggleVaultBrowser
                )

                Button {
                    closeCurrentPanel()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: Theme.FontSize.xs, weight: .semibold))
                        .foregroundColor(Color.white.opacity(Theme.Text.tertiary))
                        .frame(width: 24, height: 24)
                        .background(Color.white.opacity(0.05))
                        .clipShape(Circle())
                }
                .buttonStyle(.plain)
            }

            if let error = viewModel.error {
                Text(error)
                    .font(Theme.Typography.label(weight: .regular))
                    .foregroundColor(Color.orange.opacity(0.9))
            } else if viewModel.isLoadingHistory {
                Text("Loading saved messages...")
                    .font(Theme.Typography.label(weight: .regular))
                    .foregroundColor(Color.white.opacity(Theme.Text.tertiary))
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 20)
        .padding(.bottom, 12)
    }
}

struct ChatHeaderButton: View {
    let title: String
    let systemImage: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: systemImage)
                    .font(.system(size: Theme.FontSize.xs, weight: .semibold))

                Text(title)
                    .font(Theme.Typography.label())
            }
            .foregroundColor(Theme.Colors.accentLightest)
            .padding(.horizontal, 10)
            .padding(.vertical, 7)
            .background(Color.white.opacity(0.05))
            .overlay(
                Capsule()
                    .strokeBorder(Theme.Colors.accentLight.opacity(0.18), lineWidth: 0.5)
            )
            .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}
