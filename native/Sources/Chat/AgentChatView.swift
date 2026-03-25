import SwiftUI

private enum ChatPanelLayout {
    static let defaultWidth: CGFloat = 380
    static let vaultBrowserWidth: CGFloat = 720
}

struct AgentChatView: View {
    @ObservedObject var viewModel: AgentChatViewModel
    @FocusState var isInputFocused: Bool
    @State private var expandedToolMessages: Set<UUID> = []
    @State private var fullscreenToolGroupID: UUID?
    @State var showsVaultBrowser = false
    @State private var showHotkeyHelp = false
    @State var slashCommands = SlashCommandPopup.fallbackSlashCommands
    @State var didAttemptSlashCommandFetch = false
    @State var isSlashCommandPopupVisible = false

    var body: some View {
        ZStack(alignment: .bottom) {
            VStack(spacing: 0) {
                ChatHeaderView(
                    viewModel: viewModel,
                    showsVaultBrowser: $showsVaultBrowser,
                    statusColor: statusColor,
                    toggleVaultBrowser: toggleVaultBrowser,
                    toggleFullscreen: toggleFullscreen,
                    closeCurrentPanel: closeCurrentPanel
                )

                ZStack {
                    VStack(spacing: 0) {
                        chatContent
                        attachmentStrip

                        ChatInputView(
                            inputText: $viewModel.inputText,
                            ghostName: viewModel.ghostName,
                            isLoadingHistory: viewModel.isLoadingHistory,
                            isCompacting: viewModel.isCompacting,
                            isInputFocused: $isInputFocused,
                            showsSlashCommandPopup: showsSlashCommandPopup,
                            firstFilteredSlashCommand: filteredSlashCommands.first,
                            stats: viewModel.stats,
                            onPasteCommand: viewModel.addImageFromPasteboard,
                            onSubmit: submitInput
                        )
                    }
                    .opacity(showsVaultBrowser ? 0 : 1)
                    .allowsHitTesting(!showsVaultBrowser)

                    VaultBrowserView(
                        ghostName: viewModel.ghostName,
                        client: viewModel.ghostboxClient
                    )
                    .opacity(showsVaultBrowser ? 1 : 0)
                    .allowsHitTesting(showsVaultBrowser)
                }
            }

            if let fullscreenToolGroup {
                ToolCallFullscreenOverlay(
                    group: fullscreenToolGroup,
                    onClose: closeFullscreenToolGroup
                )
                .transition(.opacity.combined(with: .scale(scale: 0.98)))
                .zIndex(1)
            }

            if showsSlashCommandPopup {
                Color.clear
                    .contentShape(Rectangle())
                    .onTapGesture {
                        dismissSlashCommandPopup()
                    }
            }

            if showsSlashCommandPopup {
                slashCommandPopup
                    .padding(.horizontal, 18)
                    .padding(.bottom, 84)
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
                    .zIndex(2)
            }

            if showHotkeyHelp {
                HotkeyHelpOverlay {
                    dismissHotkeyHelp()
                }
                .transition(.opacity)
                .zIndex(3)
            }
        }
        .background(Color.clear)
        .onAppear {
            isInputFocused = true
        }
        .onChange(of: showsVaultBrowser) {
            isInputFocused = !showsVaultBrowser
            dismissSlashCommandPopup()
            NotificationCenter.default.post(
                name: .resizeGhostChatPanel,
                object: nil,
                userInfo: [
                    "ghostName": viewModel.ghostName,
                    "showsVaultBrowser": showsVaultBrowser,
                    "width": showsVaultBrowser ? ChatPanelLayout.vaultBrowserWidth : ChatPanelLayout.defaultWidth,
                ]
            )
        }
        .onChange(of: viewModel.inputText) {
            handleInputTextChanged()
        }
        .onKeyPress(.escape, action: handleEscapeKey)
        .onReceive(NotificationCenter.default.publisher(for: .toggleGhostChatFiles)) { notification in
            guard let name = notification.userInfo?["ghostName"] as? String,
                  name == viewModel.ghostName else { return }
            toggleVaultBrowser()
        }
        .onReceive(NotificationCenter.default.publisher(for: .toggleGhostHotkeyHelp)) { notification in
            guard let name = notification.userInfo?["ghostName"] as? String,
                  name == viewModel.ghostName else { return }
            toggleHotkeyHelp()
        }
    }

    private var chatContent: some View {
        ScrollViewReader { proxy in
            ScrollView {
                if viewModel.isLoadingHistory && viewModel.messages.isEmpty {
                    VStack(spacing: 12) {
                        ProgressView()
                            .controlSize(.small)
                            .tint(Theme.Colors.accentLight)

                        Text("Loading chat history...")
                            .font(Theme.Typography.body())
                            .foregroundColor(Color.white.opacity(Theme.Text.secondary))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 40)
                } else if viewModel.messages.isEmpty {
                    VStack(spacing: 8) {
                        Text("No messages yet.")
                            .font(Theme.Typography.body(weight: .medium))
                            .foregroundColor(Color.white.opacity(Theme.Text.secondary))

                        Text("Send a message to start the thread.")
                            .font(Theme.Typography.body())
                            .foregroundColor(Color.white.opacity(Theme.Text.tertiary))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 40)
                } else {
                    LazyVStack(spacing: 20) {
                        if !viewModel.preCompactionMessages.isEmpty {
                            if viewModel.hasMoreOlderMessages {
                                showMoreButton
                            }

                            if viewModel.showingPreCompactionMessages {
                                chatItemsSection(preCompactionDisplayItems)

                                HStack(spacing: 12) {
                                    hideOlderButton
                                    if viewModel.hasMoreOlderMessages {
                                        showMoreButton
                                    }
                                }
                            }

                            CompactionDivider(summary: viewModel.compactionSummary)
                        }

                        chatItemsSection(displayItems)

                        if viewModel.isStreaming {
                            GhostTypingBlock(name: viewModel.ghostName)
                        }

                        Color.clear
                            .frame(height: 1)
                            .id(ChatScrollAnchor.bottom)
                    }
                    .padding(.top, 20)
                    .padding(.bottom, 16)
                }
            }
            .onChange(of: viewModel.messages.count) {
                withAnimation(.easeOut(duration: 0.2)) {
                    proxy.scrollTo(ChatScrollAnchor.bottom, anchor: .bottom)
                }
            }
        }
    }

    @ViewBuilder
    private var attachmentStrip: some View {
        if !viewModel.pendingImages.isEmpty {
            PendingImageStripView(
                images: viewModel.pendingImages,
                onRemove: viewModel.removeImage
            )
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }

    private var statusColor: Color {
        switch viewModel.ghost?.status {
        case .running:
            return Color.green.opacity(0.9)
        case .stopped:
            return Color.red.opacity(0.9)
        case .error:
            return Color.orange.opacity(0.95)
        case .none:
            return Color.white.opacity(Theme.Text.quaternary)
        }
    }

    private func toggleToolMessage(_ id: UUID) {
        withAnimation(.easeOut(duration: 0.15)) {
            if expandedToolMessages.contains(id) {
                expandedToolMessages.remove(id)
            } else {
                expandedToolMessages.insert(id)
            }
        }
    }

    private func submitInput() {
        dismissSlashCommandPopup()
        viewModel.send()
    }

    private func toggleVaultBrowser() {
        withAnimation(.easeOut(duration: 0.18)) {
            showsVaultBrowser.toggle()
        }
    }

    private func toggleFullscreen() {
        NotificationCenter.default.post(
            name: .toggleGhostChatFullscreen,
            object: nil,
            userInfo: ["ghostName": viewModel.ghostName]
        )
    }

    private func closeCurrentPanel() {
        NotificationCenter.default.post(
            name: .closeGhostChat,
            object: nil,
            userInfo: ["ghostName": viewModel.ghostName]
        )
    }

    private func toggleHotkeyHelp() {
        withAnimation(.easeOut(duration: 0.18)) {
            showHotkeyHelp.toggle()
        }
    }

    private func dismissHotkeyHelp() {
        guard showHotkeyHelp else { return }

        withAnimation(.easeOut(duration: 0.18)) {
            showHotkeyHelp = false
        }
    }

    private func handleEscapeKey() -> KeyPress.Result {
        if showHotkeyHelp {
            dismissHotkeyHelp()
            return .handled
        }

        if viewModel.isStreaming {
            viewModel.cancelStream()
            return .handled
        }

        return .ignored
    }

    private func showFullscreenToolGroup(_ id: UUID) {
        withAnimation(.easeOut(duration: 0.15)) {
            fullscreenToolGroupID = id
        }
    }

    private func closeFullscreenToolGroup() {
        withAnimation(.easeOut(duration: 0.15)) {
            fullscreenToolGroupID = nil
        }
    }

    var displayItems: [ChatDisplayItem] {
        displayItems(for: viewModel.messages)
    }

    private var preCompactionDisplayItems: [ChatDisplayItem] {
        displayItems(for: viewModel.visiblePreCompactionMessages)
    }

    var fullscreenToolGroup: ToolCallGroup? {
        guard let fullscreenToolGroupID else { return nil }

        for item in displayItems {
            if case .toolGroup(let group) = item, group.id == fullscreenToolGroupID {
                return group
            }
        }

        return nil
    }

    @ViewBuilder
    func chatItemsSection(_ items: [ChatDisplayItem]) -> some View {
        ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
            switch item {
            case .message(let message):
                AgentMessageBlock(message: message, ghostName: viewModel.ghostName)
            case .toolGroup(let group):
                ToolCallGroupBlock(
                    group: group,
                    isExpanded: expandedToolMessages.contains(group.id),
                    onToggle: { toggleToolMessage(group.id) },
                    onShowFullscreen: { showFullscreenToolGroup(group.id) }
                )
            }

            if index < items.count - 1, needsBreak(current: item, next: items[index + 1]) {
                ExchangeBreak()
            }
        }
    }

    func needsBreak(current: ChatDisplayItem, next: ChatDisplayItem) -> Bool {
        let currentIsUser: Bool
        if case .message(let msg) = current { currentIsUser = msg.role == .user } else { currentIsUser = false }

        let nextIsUser: Bool
        if case .message(let msg) = next { nextIsUser = msg.role == .user } else { nextIsUser = false }

        return currentIsUser != nextIsUser
    }

    private func displayItems(for messages: [ChatMessage]) -> [ChatDisplayItem] {
        ChatDisplayItem.build(from: messages)
    }

    private var showMoreButton: some View {
        let remaining = viewModel.preCompactionMessages.count - viewModel.visiblePreCompactionCount
        let batch = min(remaining, AgentChatViewModel.olderMessagesBatchSize)

        return Button {
            withAnimation(.easeOut(duration: 0.18)) {
                viewModel.showMoreOlderMessages()
            }
        } label: {
            Text("Show \(batch) older messages (\(remaining) total)")
                .font(Theme.Typography.label())
                .foregroundColor(Color.white.opacity(Theme.Text.secondary))
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 20)
        }
        .buttonStyle(.plain)
    }

    private var hideOlderButton: some View {
        Button {
            withAnimation(.easeOut(duration: 0.18)) {
                viewModel.hideOlderMessages()
            }
        } label: {
            Text("Hide older messages")
                .font(Theme.Typography.label())
                .foregroundColor(Color.white.opacity(Theme.Text.tertiary))
                .padding(.horizontal, 20)
        }
        .buttonStyle(.plain)
    }
}

private enum ChatScrollAnchor {
    static let bottom = "chat-bottom-anchor"
}
