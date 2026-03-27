import SwiftUI

struct ChatHeaderView: View {
    @ObservedObject var viewModel: AgentChatViewModel
    @Binding var showsVaultBrowser: Bool
    let statusColor: Color
    let toggleVaultBrowser: () -> Void
    let toggleFullscreen: () -> Void
    let closeCurrentPanel: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .center, spacing: 10) {
                Circle()
                    .fill(statusColor)
                    .frame(width: 8, height: 8)

                AnimatedGhostView(
                    state: viewModel.isStreaming ? .talking : .blink,
                    size: 64
                )
                .frame(width: 64, height: 64)

                Text(viewModel.ghostName)
                    .font(Theme.Typography.display())
                    .foregroundColor(Theme.Colors.accentLight)

                ModelSwitcherMenu(
                    currentModel: viewModel.ghost?.model ?? "Loading...",
                    currentProvider: viewModel.ghost?.provider ?? "anthropic",
                    onSelect: { model in
                        viewModel.switchModel(to: model)
                    }
                )

                SessionSwitcherRow(
                    sessions: viewModel.sessions,
                    currentSession: viewModel.currentSession,
                    isDisabled: viewModel.isStreaming || viewModel.isLoadingHistory || viewModel.isWakingGhost || viewModel.isCompacting || viewModel.isCreatingSession,
                    onSelect: { sessionId in
                        viewModel.switchSession(sessionId: sessionId)
                    },
                    onCreate: {
                        viewModel.newSession()
                    },
                    onRename: { sessionId, name in
                        viewModel.renameSession(sessionId: sessionId, name: name)
                    },
                    onDelete: { sessionId in
                        viewModel.deleteSession(sessionId: sessionId)
                    }
                )

                Spacer(minLength: 0)

                if viewModel.isStreaming {
                    Button("Stop") {
                        viewModel.cancelStream()
                    }
                    .font(Theme.Typography.label())
                    .foregroundColor(Color.white.opacity(Theme.Text.secondary))
                    .buttonStyle(.plain)
                    .fixedSize()
                }

                ChatHeaderButton(
                    title: showsVaultBrowser ? "Chat" : "Files",
                    systemImage: showsVaultBrowser ? "bubble.left.and.bubble.right" : "folder",
                    action: toggleVaultBrowser
                )
                .fixedSize()

                Button(action: toggleFullscreen) {
                    Image(systemName: "arrow.up.left.and.arrow.down.right")
                        .font(.system(size: Theme.FontSize.xs, weight: .semibold))
                        .foregroundColor(Color.white.opacity(Theme.Text.tertiary))
                        .frame(width: 24, height: 24)
                        .background(Color.white.opacity(0.05))
                        .clipShape(Circle())
                }
                .buttonStyle(.plain)

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

            if viewModel.isCreatingSession {
                Text("Starting new session...")
                    .font(Theme.Typography.label(weight: .regular))
                    .foregroundColor(Theme.Colors.accentLight)
            } else if viewModel.isWakingGhost {
                Text("Waking ghost...")
                    .font(Theme.Typography.label(weight: .regular))
                    .foregroundColor(Theme.Colors.accentLight)
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

private struct SessionSwitcherRow: View {
    let sessions: SessionListResponse?
    let currentSession: SessionInfo?
    let isDisabled: Bool
    let onSelect: (String) -> Void
    let onCreate: () -> Void
    var onRename: ((String, String) -> Void)?
    var onDelete: ((String) -> Void)?
    @State private var renamingSession: SessionInfo?
    @State private var renameDraft = ""

    var body: some View {
        HStack(spacing: 8) {
            Menu {
                if let sessions, !sessions.sessions.isEmpty {
                    ForEach(sessions.sessions) { session in
                        let isCurrent = session.id == sessions.current
                            || session.id.contains(sessions.current)
                            || sessions.current.contains(session.id)

                        Button {
                            if !isCurrent {
                                onSelect(session.id)
                            }
                        } label: {
                            HStack {
                                Text(session.menuLabel)
                                if isCurrent {
                                    Image(systemName: "checkmark")
                                }
                            }
                        }
                    }

                    Divider()

                    if let currentSession {
                        Button("Rename Session...") {
                            renameDraft = currentSession.name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                            renamingSession = currentSession
                        }
                    }
                } else {
                    Text("Loading sessions...")
                }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "clock.arrow.trianglehead.counterclockwise.rotate.90")
                        .font(.system(size: Theme.FontSize.xs, weight: .semibold))

                    Text(currentTitle)
                        .font(Theme.Typography.label(weight: .regular))

                    if let currentSubtitle {
                        Text(currentSubtitle)
                            .font(Theme.Typography.caption())
                            .foregroundColor(Color.white.opacity(Theme.Text.tertiary))
                    }

                    Image(systemName: "chevron.down")
                        .font(.system(size: 8, weight: .semibold))
                        .foregroundColor(Color.white.opacity(Theme.Text.quaternary))
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
            .menuStyle(.borderlessButton)
            .fixedSize()
            .disabled(isDisabled || sessions?.sessions.isEmpty != false)

            Button(action: onCreate) {
                Image(systemName: "plus")
                    .font(.system(size: Theme.FontSize.xs, weight: .semibold))
                    .foregroundColor(Theme.Colors.accentLightest)
                    .frame(width: 24, height: 24)
                    .background(Color.white.opacity(0.05))
                    .clipShape(Circle())
            }
            .buttonStyle(.plain)
            .disabled(isDisabled)
        }
        .sheet(item: $renamingSession) { session in
            RenameSessionSheet(
                session: session,
                draftName: $renameDraft,
                onCancel: {
                    renamingSession = nil
                },
                onSave: {
                    onRename?(session.id, renameDraft.trimmingCharacters(in: .whitespacesAndNewlines))
                    renamingSession = nil
                }
            )
        }
    }

    private var currentTitle: String {
        if let currentSession {
            let name = currentSession.displayLabel
            if name != "Session" {
                return name
            }
            return "\(name) - \(currentSession.relativeDate)"
        }

        if let sessions, !sessions.current.isEmpty {
            return "Session"
        }

        return "Loading..."
    }

    private var currentSubtitle: String? {
        guard let currentSession else { return nil }
        let name = currentSession.name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !name.isEmpty {
            return currentSession.relativeDate
        }
        return nil
    }
}

private struct RenameSessionSheet: View {
    let session: SessionInfo
    @Binding var draftName: String
    let onCancel: () -> Void
    let onSave: () -> Void
    @FocusState private var isNameFieldFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Rename Session")
                .font(Theme.Typography.display())
                .foregroundColor(Theme.Colors.accentLight)

            Text(session.displayLabel)
                .font(Theme.Typography.caption())
                .foregroundColor(Color.white.opacity(Theme.Text.tertiary))

            TextField("Session name", text: $draftName)
                .textFieldStyle(.roundedBorder)
                .focused($isNameFieldFocused)
                .onSubmit {
                    onSave()
                }

            HStack {
                Spacer(minLength: 0)

                Button("Cancel", action: onCancel)

                Button("Save", action: onSave)
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(20)
        .frame(width: 320)
        .background(Color.black.opacity(0.001))
        .onAppear {
            isNameFieldFocused = true
        }
    }
}

struct ModelSwitcherMenu: View {
    let currentModel: String
    let currentProvider: String
    let onSelect: (GhostModel) -> Void

    var body: some View {
        Menu {
            ForEach(GhostModel.all) { model in
                let isCurrent = model.modelId == currentModel || model.displayName == currentModel

                Button {
                    onSelect(model)
                } label: {
                    HStack {
                        Text(model.displayName)
                        Text(model.provider)
                            .foregroundColor(.secondary)
                        if isCurrent {
                            Image(systemName: "checkmark")
                        }
                    }
                }
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "cpu")
                    .font(.system(size: Theme.FontSize.xs, weight: .semibold))

                Text(displayModelName)
                    .font(Theme.Typography.label(weight: .regular))

                Image(systemName: "chevron.down")
                    .font(.system(size: 8, weight: .semibold))
                    .foregroundColor(Color.white.opacity(Theme.Text.quaternary))
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
        .menuStyle(.borderlessButton)
        .fixedSize()
    }

    private var displayModelName: String {
        if let model = GhostModel.all.first(where: { $0.modelId == currentModel }) {
            return model.displayName
        }
        return currentModel
    }
}

private extension SessionInfo {
    var displayLabel: String {
        if let name = name?.trimmingCharacters(in: .whitespacesAndNewlines),
           !name.isEmpty {
            return name
        }

        return "Session"
    }

    var shortID: String {
        String(id.prefix(12))
    }

    var relativeDate: String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let date = formatter.date(from: lastActiveAt) ?? formatter.date(from: createdAt) else {
            return shortID
        }

        let interval = Date().timeIntervalSince(date)
        if interval < 60 { return "Just now" }
        if interval < 3600 { return "\(Int(interval / 60))m ago" }
        if interval < 86400 { return "\(Int(interval / 3600))h ago" }

        let dayFormatter = DateFormatter()
        dayFormatter.dateFormat = "MMM d"
        return dayFormatter.string(from: date)
    }

    var menuLabel: String {
        return "\(displayLabel) - \(relativeDate)"
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
