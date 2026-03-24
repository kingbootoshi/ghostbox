import SwiftUI

struct GhostRow: View {
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
