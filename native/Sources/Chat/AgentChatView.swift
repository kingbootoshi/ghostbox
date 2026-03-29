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
                            backgroundTaskCount: viewModel.activeBackgroundTaskCount,
                            isStreaming: viewModel.isStreaming,
                            isWakingGhost: viewModel.isWakingGhost,
                            isLoadingHistory: viewModel.isLoadingHistory,
                            isCompacting: viewModel.isCompacting,
                            isCreatingSession: viewModel.isCreatingSession,
                            isHistoryModeActive: viewModel.isHistoryModeActive,
                            isInputDisabled: viewModel.isInputDisabled,
                            isInputFocused: $isInputFocused,
                            showsSlashCommandPopup: showsSlashCommandPopup,
                            firstFilteredSlashCommand: filteredSlashCommands.first,
                            stats: viewModel.stats,
                            onPasteCommand: viewModel.addImageFromPasteboard,
                            onHistoryBack: viewModel.browseSentHistoryBackward,
                            onHistoryForward: viewModel.browseSentHistoryForward,
                            onQueueBrowseUp: viewModel.browseQueueBackward,
                            onQueueBrowseDown: viewModel.browseQueueForward,
                            onSubmit: submitInput
                        )
                        .overlay(alignment: .bottomTrailing) {
                            if !viewModel.queuedMessages.isEmpty {
                                queueIndicator
                                    .padding(.trailing, 20)
                                    .padding(.bottom, 44)
                                    .transition(.opacity.combined(with: .move(edge: .trailing)))
                            }
                        }
                        .animation(.easeOut(duration: 0.15), value: viewModel.queuedMessages.count)
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

            if let toastMessage = viewModel.toast ?? viewModel.error {
                VStack {
                    HStack {
                        Spacer()
                        HStack(spacing: 8) {
                            Circle()
                                .fill(Color.orange.opacity(0.8))
                                .frame(width: 6, height: 6)

                            Text(toastMessage)
                                .font(Theme.Typography.label(weight: .medium))
                                .foregroundColor(Color.white.opacity(Theme.Text.primary))
                                .lineLimit(2)

                            Button {
                                viewModel.dismissToast()
                            } label: {
                                Image(systemName: "xmark")
                                    .font(.system(size: 9, weight: .semibold))
                                    .foregroundColor(Color.white.opacity(Theme.Text.tertiary))
                                    .frame(width: 18, height: 18)
                                    .background(Color.white.opacity(0.08))
                                    .clipShape(Circle())
                            }
                            .buttonStyle(.plain)
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(
                            RoundedRectangle(cornerRadius: 14)
                                .fill(Color.white.opacity(0.06))
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: 14)
                                .strokeBorder(Theme.Colors.accentLight.opacity(0.18), lineWidth: 0.5)
                        )
                        .shadow(color: Color.black.opacity(0.3), radius: 12, y: 4)
                        .padding(.trailing, 16)
                        .padding(.top, 80)
                    }
                    Spacer()
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
                .zIndex(5)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: viewModel.toast)
        .animation(.easeInOut(duration: 0.2), value: viewModel.error)
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
                if viewModel.isWakingGhost && viewModel.messages.isEmpty {
                    VStack(spacing: 12) {
                        ProgressView()
                            .controlSize(.small)
                            .tint(Theme.Colors.accentLight)

                        Text("Waking ghost...")
                            .font(Theme.Typography.body())
                            .foregroundColor(Color.white.opacity(Theme.Text.secondary))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 40)
                } else if viewModel.isLoadingHistory && viewModel.messages.isEmpty {
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
                } else if viewModel.isCreatingSession && viewModel.messages.isEmpty {
                    VStack(spacing: 10) {
                        Text("Starting new session...")
                            .font(Theme.Typography.body(weight: .medium))
                            .foregroundColor(Theme.Colors.accentLight)

                        Text("You can start typing right away.")
                            .font(Theme.Typography.body())
                            .foregroundColor(Color.white.opacity(Theme.Text.tertiary))
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
                                .id(ChatScrollAnchor.typing)
                        }

                        Color.clear
                            .frame(height: 1)
                            .id(ChatScrollAnchor.bottom)
                    }
                    .padding(.top, 20)
                    .padding(.bottom, 16)
                }
            }
            .onAppear {
                scrollToLatest(using: proxy)
            }
            .onChange(of: viewModel.messages.count) {
                scrollToLatest(using: proxy)
            }
            .onChange(of: viewModel.messagesVersion) {
                guard viewModel.isStreaming else { return }
                scrollToLatest(using: proxy)
            }
            .onChange(of: viewModel.historySelectionMessageID) {
                guard let selectionID = viewModel.historySelectionMessageID else { return }
                withAnimation(.easeOut(duration: 0.2)) {
                    proxy.scrollTo(ChatScrollAnchor.message(selectionID), anchor: .center)
                }
            }
            .onChange(of: viewModel.isStreaming) {
                guard viewModel.isStreaming else { return }
                scrollToLatest(using: proxy)
            }
            .onChange(of: viewModel.sessions?.current) {
                scrollToLatest(using: proxy)
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

    private var queueIndicator: some View {
        let label: String = if let idx = viewModel.queueBrowseIndex {
            "\(idx + 1)/\(viewModel.queuedMessages.count) queued"
        } else {
            "\(viewModel.queuedMessages.count) queued"
        }

        return Text(label)
            .font(Theme.Typography.caption(weight: .medium))
            .foregroundColor(Theme.Colors.accentLightest)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Theme.Colors.accent.opacity(viewModel.isQueueBrowsing ? 0.3 : 0.18))
            .overlay {
                RoundedRectangle(cornerRadius: 999, style: .continuous)
                    .strokeBorder(Theme.Colors.accentLight.opacity(viewModel.isQueueBrowsing ? 0.35 : 0.18), lineWidth: 0.5)
            }
            .clipShape(RoundedRectangle(cornerRadius: 999, style: .continuous))
            .shadow(color: Theme.Colors.accent.opacity(0.12), radius: 16, x: 0, y: 8)
            .allowsHitTesting(false)
            .animation(.easeOut(duration: 0.12), value: viewModel.queueBrowseIndex)
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
        guard !viewModel.commitHistorySelection() else { return }
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
        if viewModel.exitHistoryModeIfNeeded() {
            return .handled
        }

        if viewModel.isQueueBrowsing {
            viewModel.exitQueueBrowseMode()
            return .handled
        }

        if expandedImage != nil {
            withAnimation(.easeOut(duration: 0.15)) {
                expandedImage = nil
            }
            _ = viewModel.handleEscapeForHistory()
            return .handled
        }

        if showHotkeyHelp {
            dismissHotkeyHelp()
            _ = viewModel.handleEscapeForHistory()
            return .handled
        }

        if viewModel.isStreaming {
            viewModel.cancelStream()
            _ = viewModel.handleEscapeForHistory()
            return .handled
        }

        return viewModel.handleEscapeForHistory() ? .handled : .ignored
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
                selectedMessageID: viewModel.historySelectionMessageID,
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
            .id(ChatScrollAnchor.message(item.id))
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

    private func scrollToLatest(using proxy: ScrollViewProxy) {
        DispatchQueue.main.async {
            withAnimation(.easeOut(duration: 0.2)) {
                proxy.scrollTo(ChatScrollAnchor.bottom, anchor: .bottom)
            }
        }
    }
}

private enum ChatScrollAnchor {
    static let typing = "chat-typing-anchor"
    static let bottom = "chat-bottom-anchor"

    static func message(_ id: UUID) -> String {
        "chat-message-\(id.uuidString)"
    }
}

private struct ChatDisplayRow: View {
    let item: ChatDisplayItem
    let ghostName: String
    let selectedMessageID: UUID?
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
                isSelected: selectedMessageID == message.id,
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
