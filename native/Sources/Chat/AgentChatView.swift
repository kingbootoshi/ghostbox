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
    @State private var cachedDisplayItems: [ChatDisplayItem] = []
    @State private var cachedPreCompactionDisplayItems: [ChatDisplayItem] = []
    @State var showsVaultBrowser = false
    @State private var showHotkeyHelp = false
    @State var slashCommands = SlashCommandPopup.fallbackSlashCommands
    @State var didAttemptSlashCommandFetch = false
    @State var isSlashCommandPopupVisible = false
    @State private var expandedImage: NSImage?

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

            if let expandedImage {
                ImageFullscreenOverlay(image: expandedImage) {
                    withAnimation(.easeOut(duration: 0.15)) {
                        self.expandedImage = nil
                    }
                }
                .transition(.opacity)
                .zIndex(4)
            }
        }
        .background(Color.clear)
        .onAppear {
            isInputFocused = true
            rebuildDisplayItems()
            rebuildPreCompactionDisplayItems()
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
        .onChange(of: viewModel.messagesVersion) {
            rebuildDisplayItems()
        }
        .onChange(of: viewModel.preCompactionDisplayVersion) {
            rebuildPreCompactionDisplayItems()
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
                                chatItemsSection(cachedPreCompactionDisplayItems)

                                HStack(spacing: 12) {
                                    hideOlderButton
                                    if viewModel.hasMoreOlderMessages {
                                        showMoreButton
                                    }
                                }
                            }

                            CompactionDivider(summary: viewModel.compactionSummary)
                        }

                        chatItemsSection(cachedDisplayItems)

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
                onRemove: viewModel.removeImage,
                onTap: { image in
                    withAnimation(.easeOut(duration: 0.15)) {
                        expandedImage = image
                    }
                }
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
        showsVaultBrowser.toggle()
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
        if expandedImage != nil {
            withAnimation(.easeOut(duration: 0.15)) {
                expandedImage = nil
            }
            return .handled
        }

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

    var fullscreenToolGroup: ToolCallGroup? {
        guard let fullscreenToolGroupID else { return nil }

        for item in cachedDisplayItems {
            if case .toolGroup(let group, _) = item, group.id == fullscreenToolGroupID {
                return group
            }
        }

        return nil
    }

    @ViewBuilder
    func chatItemsSection(_ items: [ChatDisplayItem]) -> some View {
        ForEach(items) { item in
            ChatDisplayRow(
                item: item,
                ghostName: viewModel.ghostName,
                isToolGroupExpanded: { groupID in
                    expandedToolMessages.contains(groupID)
                },
                onToggleToolGroup: toggleToolMessage,
                onShowFullscreenToolGroup: showFullscreenToolGroup,
                onThumbnailTap: { image in
                    withAnimation(.easeOut(duration: 0.15)) {
                        expandedImage = image
                    }
                }
            )
        }
    }

    private func rebuildDisplayItems() {
        cachedDisplayItems = ChatDisplayItem.build(from: viewModel.messages)
    }

    private func rebuildPreCompactionDisplayItems() {
        cachedPreCompactionDisplayItems = ChatDisplayItem.build(from: viewModel.visiblePreCompactionMessages)
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

private struct ChatDisplayRow: View {
    let item: ChatDisplayItem
    let ghostName: String
    let isToolGroupExpanded: (UUID) -> Bool
    let onToggleToolGroup: (UUID) -> Void
    let onShowFullscreenToolGroup: (UUID) -> Void
    let onThumbnailTap: (NSImage) -> Void

    var body: some View {
        VStack(spacing: 0) {
            rowContent

            ExchangeBreak()
                .frame(height: item.showsBreakAfter ? 1 : 0, alignment: .top)
                .clipped()
                .padding(.top, item.showsBreakAfter ? 20 : 0)
                .opacity(item.showsBreakAfter ? 1 : 0)
        }
    }

    @ViewBuilder
    private var rowContent: some View {
        switch item {
        case .message(let message, _):
            AgentMessageBlock(
                message: message,
                ghostName: ghostName,
                onThumbnailTap: onThumbnailTap
            )
        case .toolGroup(let group, _):
            ToolCallGroupBlock(
                group: group,
                isExpanded: isToolGroupExpanded(group.id),
                onToggle: { onToggleToolGroup(group.id) },
                onShowFullscreen: { onShowFullscreenToolGroup(group.id) }
            )
        }
    }
}
