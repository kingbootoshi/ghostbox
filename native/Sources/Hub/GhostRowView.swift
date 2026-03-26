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
        Button(action: onOpen) {
            HStack(alignment: .center, spacing: 12) {
                Circle()
                    .fill(statusColor)
                    .frame(width: 8, height: 8)

                VStack(alignment: .leading, spacing: 5) {
                    HStack(alignment: .center, spacing: 8) {
                        AnimatedGhostView(
                            state: ghost.status == .running ? .blink : .idle,
                            size: 80
                        )
                        .frame(width: 80, height: 80)

                        Text(ghost.name)
                            .font(Theme.Typography.display())
                            .foregroundColor(Theme.Colors.accentLight)
                    }

                    HStack(spacing: 6) {
                        Text(ghost.status.rawValue.capitalized)
                        Text("·")
                        Text(ghost.model)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    .font(Theme.Typography.label(weight: .regular))
                    .foregroundColor(Color.white.opacity(0.35))
                }

                Spacer(minLength: 0)

                Menu {
                    if ghost.status == .running {
                        Button(role: .destructive) {
                            showKillConfirm = true
                        } label: {
                            Label("Kill", systemImage: "stop.circle")
                        }
                    }

                    if ghost.status == .stopped {
                        Button {
                            onWake()
                        } label: {
                            Label("Wake", systemImage: "play.circle")
                        }
                    }

                    Divider()

                    Button(role: .destructive) {
                        showRemoveConfirm = true
                    } label: {
                        Label("Remove", systemImage: "trash")
                    }
                } label: {
                    Image(systemName: "ellipsis")
                        .font(.system(size: Theme.FontSize.sm, weight: .medium))
                        .foregroundColor(Color.white.opacity(Theme.Text.quaternary))
                        .frame(width: 28, height: 28)
                        .contentShape(Rectangle())
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
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
}
