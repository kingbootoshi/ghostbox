import SwiftUI

struct HubView: View {
    @EnvironmentObject private var appState: AppState
    @StateObject private var viewModel: HubViewModel

    init(client: GhostboxClient) {
        _viewModel = StateObject(wrappedValue: HubViewModel(client: client))
    }

    private var displayGhosts: [Ghost] {
        viewModel.ghosts.isEmpty ? appState.ghosts : viewModel.ghosts
    }

    var body: some View {
        VStack(spacing: 0) {
            titleSection

            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
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
                .padding(.horizontal, 20)
                .padding(.top, 22)
                .padding(.bottom, 18)
            }

            footer
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
    }

    private var titleSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("GHOSTBOX")
                .font(.custom("DM Sans", size: 11).weight(.semibold))
                .foregroundColor(Color.white.opacity(0.35))
                .tracking(3.2)

            if viewModel.isLoading && displayGhosts.isEmpty {
                ProgressView()
                    .controlSize(.small)
                    .tint(Theme.Colors.accentLight)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 20)
        .padding(.top, 22)
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
                    .font(.custom("DM Sans", size: 13).weight(.semibold))
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
                .font(.custom("DM Sans", size: 14).weight(.medium))
                .foregroundColor(Color.white.opacity(0.6))

            Text("Spawn one to start a conversation.")
                .font(.custom("DM Sans", size: 12))
                .foregroundColor(Color.white.opacity(0.35))
        }
        .padding(.top, 4)
    }

    private func errorView(_ message: String) -> some View {
        Text(message)
            .font(.custom("DM Sans", size: 12))
            .foregroundColor(Color.orange.opacity(0.9))
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.orange.opacity(0.08))
            .clipShape(RoundedRectangle(cornerRadius: 18))
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
                            .font(.custom("DM Sans", size: 15).weight(.semibold))
                            .foregroundColor(Theme.Colors.accentLight)

                        HStack(spacing: 6) {
                            Text(ghost.status.rawValue.capitalized)
                            Text("·")
                            Text("\(ghost.provider) / \(ghost.model)")
                        }
                        .font(.custom("DM Sans", size: 12))
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
                .font(.custom("DM Sans", size: 11).weight(.medium))
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
