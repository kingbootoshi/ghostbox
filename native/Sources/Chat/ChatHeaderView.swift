import Observation
import SwiftUI

struct ChatHeaderView: View {
    let viewModel: AgentChatViewModel
    @Binding var showsVaultBrowser: Bool
    let statusColor: Color
    let toggleVaultBrowser: () -> Void
    let toggleFullscreen: () -> Void
    let closeCurrentPanel: () -> Void

    var body: some View {
        let store = viewModel.store

        VStack(alignment: .leading, spacing: 10) {
            ViewThatFits(in: .horizontal) {
                wideHeader(store: store)
                compactHeader(store: store)
            }

            if store.isCreatingSession {
                Text("Starting new session...")
                    .font(Theme.Typography.label(weight: .regular))
                    .foregroundColor(Theme.Colors.accentLight)
            } else if viewModel.isWakingGhost {
                Text("Waking ghost...")
                    .font(Theme.Typography.label(weight: .regular))
                    .foregroundColor(Theme.Colors.accentLight)
            } else if store.isLoadingHistory {
                Text("Loading chat history...")
                    .font(Theme.Typography.label(weight: .regular))
                    .foregroundColor(Color.white.opacity(Theme.Text.tertiary))
            }
        }
        .padding(.horizontal, 20)
        .padding(.top, 20)
        .padding(.bottom, 12)
        .background(WindowDragArea())
    }

    private func wideHeader(store: ConversationStore) -> some View {
        HStack(alignment: .center, spacing: 10) {
            headerIdentity(ghostSize: 64, includeModelSwitcher: false)

            ModelSwitcherMenu(
                currentModel: store.ghost?.model ?? "Loading...",
                currentProvider: store.ghost?.provider ?? "anthropic",
                onSelect: { model in
                    viewModel.switchModel(to: model)
                }
            )

            sessionSwitcherRow(store: store)

            Spacer(minLength: 0)

            headerActionGroup
        }
    }

    private func compactHeader(store: ConversationStore) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                headerIdentity(ghostSize: 52, includeModelSwitcher: true)

                Spacer(minLength: 0)

                headerActionGroup
            }

            sessionSwitcherRow(store: store)
        }
    }

    private func headerIdentity(ghostSize: CGFloat, includeModelSwitcher: Bool) -> some View {
        HStack(alignment: .center, spacing: 10) {
            Circle()
                .fill(statusColor)
                .frame(width: 8, height: 8)

            AnimatedGhostView(
                state: viewModel.isStreaming ? .talking : .blink,
                size: ghostSize
            )
            .frame(width: ghostSize, height: ghostSize)

            VStack(alignment: .leading, spacing: includeModelSwitcher ? 7 : 0) {
                Text(viewModel.ghostName)
                    .font(Theme.Typography.display())
                    .foregroundColor(Theme.Colors.accentLight)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .minimumScaleFactor(0.9)
                    .allowsTightening(true)
                    .layoutPriority(1)

                if includeModelSwitcher {
                    ModelSwitcherMenu(
                        currentModel: viewModel.store.ghost?.model ?? "Loading...",
                        currentProvider: viewModel.store.ghost?.provider ?? "anthropic",
                        onSelect: { model in
                            viewModel.switchModel(to: model)
                        }
                    )
                }
            }
        }
    }

    private func sessionSwitcherRow(store: ConversationStore) -> some View {
        SessionSwitcherRow(
            sessions: store.sessions,
            currentSession: store.currentSession,
            isDisabled: viewModel.isStreaming || store.isLoadingHistory || viewModel.isWakingGhost || store.isCompacting,
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
    }

    private var headerActionGroup: some View {
        HStack(spacing: 8) {
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

            CircularIconButton(
                systemImage: "arrow.up.left.and.arrow.down.right",
                action: toggleFullscreen
            )

            CircularIconButton(systemImage: "xmark", action: closeCurrentPanel)
        }
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
                    .lineLimit(1)
                    .truncationMode(.tail)

                if let currentSubtitle {
                    Text(currentSubtitle)
                        .font(Theme.Typography.caption())
                        .foregroundColor(Color.white.opacity(Theme.Text.tertiary))
                        .lineLimit(1)
                        .truncationMode(.tail)
                }

                    Image(systemName: "chevron.down")
                        .font(.system(size: 8, weight: .semibold))
                        .foregroundColor(Color.white.opacity(Theme.Text.quaternary))
                }
                .capsuleControlStyle()
            }
            .menuStyle(.borderlessButton)
            .fixedSize()
            .disabled(isDisabled || sessions?.sessions.isEmpty != false)

            CircularIconButton(
                systemImage: "plus",
                action: onCreate,
                foregroundColor: Theme.Colors.accentLightest
            )
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
                let isCurrent =
                    model.id == normalizedCurrentModelIdentifier
                    || model.modelId == currentModelId
                    || model.displayName == trimmedCurrentModel

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
                    .lineLimit(1)
                    .truncationMode(.tail)

                Image(systemName: "chevron.down")
                    .font(.system(size: 8, weight: .semibold))
                    .foregroundColor(Color.white.opacity(Theme.Text.quaternary))
            }
            .capsuleControlStyle()
        }
        .menuStyle(.borderlessButton)
    }

    private var displayModelName: String {
        if let model = GhostModel.all.first(where: { $0.id == normalizedCurrentModelIdentifier }) {
            return model.displayName
        }

        if let model = GhostModel.all.first(where: { $0.modelId == currentModelId }) {
            return model.displayName
        }

        return currentModelId
    }

    private var trimmedCurrentModel: String {
        currentModel.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var currentModelId: String {
        let modelValue = trimmedCurrentModel
        if modelValue.contains("/") {
            return String(modelValue.split(separator: "/", maxSplits: 1).last ?? "")
        }

        return modelValue
    }

    private var normalizedCurrentModelIdentifier: String {
        let modelValue = trimmedCurrentModel
        if modelValue.contains("/") {
            let parts = modelValue.split(separator: "/", maxSplits: 1).map(String.init)
            if parts.count == 2 {
                return "\(parts[0].lowercased())/\(parts[1])"
            }
        }

        let providerValue = currentProvider.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if providerValue.isEmpty {
            return currentModelId
        }

        return "\(providerValue)/\(currentModelId)"
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
            .capsuleControlStyle()
        }
        .buttonStyle(.plain)
    }
}
