import Observation
import SwiftUI

enum ChatPanelLayout {
    static let minWidth: CGFloat = 340
    static let defaultWidth: CGFloat = 400
    static let defaultHeight: CGFloat = 600
    static let minHeight: CGFloat = 450
    static let vaultBrowserWidth: CGFloat = 720
}

private struct ScrollOffsetKey: PreferenceKey {
    static var defaultValue: CGFloat = 0

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

private struct TopScrollOffsetKey: PreferenceKey {
    static var defaultValue: CGFloat = -.greatestFiniteMagnitude

    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}

struct AgentChatView: View {
    let viewModel: AgentChatViewModel
    @FocusState var isInputFocused: Bool
    @State private var expandedToolMessages: Set<UUID> = []
    @State private var fullscreenToolGroupID: UUID?
    @State private var cachedDisplayItems: [ChatDisplayItem] = []
    @State private var cachedPreCompactionDisplayItems: [ChatDisplayItem] = []
    @State var showsVaultBrowser = false
    @State private var showHotkeyHelp = false
    @State var slashCommands: [GhostSlashCommand] = []
    @State var didAttemptSlashCommandFetchForVisiblePopup = false
    @State var isLoadingSlashCommands = false
    @State var isSlashCommandPopupVisible = false
    @State private var expandedImage: NSImage?
    @State private var isNearBottom = true
    @State private var shouldFollowLatest = true
    @State private var scrollViewHeight: CGFloat = 0
    @State private var hasScrolledToInitialBottom = false
    @State private var cachedDisplaySourceIDs: [UUID] = []
    @State private var cachedPreCompactionSourceIDs: [UUID] = []
    @State private var pendingPrependAnchorID: UUID?

    var body: some View {
        @Bindable var input = viewModel.input
        let store = viewModel.store
        let notifications = viewModel.notifications

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
                            inputText: $input.inputText,
                            ghostName: viewModel.ghostName,
                            backgroundTasks: viewModel.activeBackgroundTasks,
                            isWakingGhost: viewModel.isWakingGhost,
                            isLoadingHistory: store.isLoadingHistory,
                            isCompacting: store.isCompacting,
                            isCreatingSession: store.isCreatingSession,
                            isHistoryModeActive: input.isHistoryModeActive,
                            isInputDisabled: input.isInputDisabled,
                            isInputFocused: $isInputFocused,
                            stats: store.stats,
                            onPasteCommand: viewModel.addImageFromPasteboard,
                            onQueueBrowseUp: viewModel.browseQueueBackward,
                            onQueueBrowseDown: viewModel.browseQueueForward,
                            onTab: autocompleteSlashCommand,
                            onKillBackgroundTask: { taskId in
                                viewModel.killBackgroundTask(taskId: taskId)
                            },
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

            if let toastMessage = notifications.toastMessage {
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
                                notifications.dismissToast()
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
                            RoundedRectangle(cornerRadius: Theme.Layout.controlCornerRadius)
                                .fill(Color.white.opacity(0.06))
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: Theme.Layout.controlCornerRadius)
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
        .animation(.easeInOut(duration: 0.2), value: notifications.toastMessage)
        .animation(.easeInOut(duration: 0.2), value: notifications.error)
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
        .onChange(of: input.inputText) {
            handleInputTextChanged()
        }
        .onChange(of: store.messagesVersion) {
            rebuildDisplayItems()
        }
        .onChange(of: store.preCompactionDisplayVersion) {
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

    private var hasEmptyState: Bool {
        viewModel.store.messages.isEmpty
    }

    private var chatContent: some View {
        ScrollViewReader { proxy in
            ZStack(alignment: .bottom) {
                if hasEmptyState {
                    VStack(spacing: 12) {
                        if viewModel.isWakingGhost {
                            ProgressView()
                                .controlSize(.small)
                                .tint(Theme.Colors.accentLight)
                            Text("Waking ghost...")
                                .font(Theme.Typography.body())
                                .foregroundColor(Color.white.opacity(Theme.Text.secondary))
                        } else if viewModel.store.isLoadingHistory {
                            ProgressView()
                                .controlSize(.small)
                                .tint(Theme.Colors.accentLight)
                            Text("Loading chat history...")
                                .font(Theme.Typography.body())
                                .foregroundColor(Color.white.opacity(Theme.Text.secondary))
                        } else if viewModel.store.isCreatingSession {
                            // Header already shows "Starting new session..." - no duplicate here
                        } else {
                            Text("No messages yet.")
                                .font(Theme.Typography.body(weight: .medium))
                                .foregroundColor(Color.white.opacity(Theme.Text.secondary))
                            Text("Send a message to start the thread.")
                                .font(Theme.Typography.body())
                                .foregroundColor(Color.white.opacity(Theme.Text.tertiary))
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }

                ScrollView {
                    if hasEmptyState {
                        Color.clear.frame(height: 0)
                    } else {
                        LazyVStack(spacing: 20) {
                            topHistoryTrigger

                            if viewModel.store.isLoadingOlderMessages || viewModel.store.isLoadingPreCompactionMessages {
                                historyLoadingIndicator
                            }

                            if !viewModel.store.preCompactionMessages.isEmpty || viewModel.store.preCompactionRemainingCount > 0 {
                                if !viewModel.store.visiblePreCompactionMessages.isEmpty {
                                    chatItemsSection(cachedPreCompactionDisplayItems)
                                }

                                CompactionDivider(summary: viewModel.store.compactionSummary)
                            }

                            chatItemsSection(cachedDisplayItems)

                            if viewModel.showsTypingIndicator {
                                GhostTypingBlock(name: viewModel.ghostName)
                                    .id(ChatScrollAnchor.typing)
                            }

                            GeometryReader { geo in
                                Color.clear.preference(
                                    key: ScrollOffsetKey.self,
                                    value: geo.frame(in: .named("chatScroll")).minY
                                )
                            }
                            .frame(height: 1)
                            .id(ChatScrollAnchor.bottom)
                        }
                        .padding(.top, 20)
                        .padding(.bottom, 16)
                    }
                }
                .coordinateSpace(name: "chatScroll")
                .background {
                    GeometryReader { geo in
                        Color.clear
                            .onAppear {
                                scrollViewHeight = geo.size.height
                            }
                            .onChange(of: geo.size.height) {
                                scrollViewHeight = geo.size.height
                            }
                    }
                }
                .onPreferenceChange(ScrollOffsetKey.self) { bottomY in
                    let nearBottom = bottomY < scrollViewHeight + 150
                    if nearBottom != isNearBottom {
                        isNearBottom = nearBottom
                    }
                    if !supportsScrollPhaseTracking, shouldFollowLatest, !nearBottom {
                        shouldFollowLatest = false
                    }
                }
                .onPreferenceChange(TopScrollOffsetKey.self) { topY in
                    guard topY > -140 else { return }
                    guard !shouldFollowLatest else { return }
                    requestOlderHistoryIfNeeded()
                }
                .onAppear {
                    if !viewModel.store.messages.isEmpty {
                        proxy.scrollTo(ChatScrollAnchor.bottom, anchor: .bottom)
                        hasScrolledToInitialBottom = true
                    }
                    shouldFollowLatest = true
                }
                .modifier(
                    ScrollIntentTrackingModifier {
                        shouldFollowLatest = false
                    }
                )
                .onChange(of: viewModel.store.messagesVersion) {
                    if preservePrependScrollPosition(using: proxy) {
                        return
                    }
                    if !hasScrolledToInitialBottom && !viewModel.store.messages.isEmpty {
                        DispatchQueue.main.async {
                            proxy.scrollTo(ChatScrollAnchor.bottom, anchor: .bottom)
                        }
                        hasScrolledToInitialBottom = true
                        shouldFollowLatest = true
                        return
                    }
                    guard shouldFollowLatest else { return }
                    scrollToLatest(using: proxy, animated: !viewModel.isStreaming)
                }
                .onChange(of: viewModel.input.historySelectionMessageID) {
                    guard let selectionID = viewModel.input.historySelectionMessageID else { return }
                    shouldFollowLatest = false
                    withAnimation(.easeOut(duration: 0.2)) {
                        proxy.scrollTo(ChatScrollAnchor.message(selectionID), anchor: .center)
                    }
                }
                .onChange(of: viewModel.isStreaming) {
                    guard shouldFollowLatest else { return }
                    scrollToLatest(using: proxy, animated: false)
                }
                .onChange(of: viewModel.store.sessions?.current) {
                    hasScrolledToInitialBottom = false
                    shouldFollowLatest = true
                    scrollToLatest(using: proxy)
                }
                .onChange(of: viewModel.store.preCompactionDisplayVersion) {
                    _ = preservePrependScrollPosition(using: proxy)
                }

                if !shouldFollowLatest && !viewModel.store.messages.isEmpty {
                    Button {
                        shouldFollowLatest = true
                        scrollToLatest(using: proxy)
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "arrow.down.circle.fill")
                            Text("Jump to latest")
                        }
                        .font(.system(size: 11, weight: .medium))
                        .capsuleControlStyle(
                            backgroundColor: Theme.Colors.accent,
                            borderColor: nil,
                            verticalPadding: 5
                        )
                    }
                    .buttonStyle(.plain)
                    .padding(.bottom, 12)
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
                }
            }
            .animation(.easeOut(duration: 0.15), value: isNearBottom)
        }
    }

    @ViewBuilder
    private var attachmentStrip: some View {
        if !viewModel.input.pendingImages.isEmpty {
            PendingImageStripView(
                images: viewModel.input.pendingImages,
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
        Theme.Colors.statusColor(for: viewModel.store.ghost?.status.rawValue ?? "")
    }

    private var queueIndicator: some View {
        let label: String = if let idx = viewModel.queueBrowseIndex {
            "\(idx + 1)/\(viewModel.queuedMessages.count) queued"
        } else {
            "\(viewModel.queuedMessages.count) queued"
        }

        return Text(label)
            .font(Theme.Typography.caption(weight: .medium))
            .capsuleControlStyle(
                backgroundColor: Theme.Colors.accent.opacity(viewModel.isQueueBrowsing ? 0.3 : 0.18),
                borderColor: Theme.Colors.accentLight.opacity(viewModel.isQueueBrowsing ? 0.35 : 0.18),
                verticalPadding: 6
            )
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

    private func autocompleteSlashCommand() -> Bool {
        guard isSlashCommandPopupVisible, let command = filteredSlashCommands.first else {
            return false
        }
        viewModel.input.inputText = "/\(command.name) "
        dismissSlashCommandPopup()
        return true
    }

    private func submitInput() {
        dismissSlashCommandPopup()
        guard !viewModel.commitHistorySelection() else { return }
        shouldFollowLatest = true
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
        let lastThinkingID = items.last(where: { item in
            if case .message(let msg, _) = item, msg.role == .thinking { return true }
            return false
        })?.id

        ForEach(items) { item in
            ChatDisplayRow(
                item: item,
                ghostName: viewModel.ghostName,
                selectedMessageID: viewModel.input.historySelectionMessageID,
                isActiveThinking: viewModel.isStreaming && item.id == lastThinkingID,
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
        let messages = viewModel.store.messages
        let sourceIDs = messages.map(\.id)

        if sourceIDs == cachedDisplaySourceIDs, !cachedDisplayItems.isEmpty {
            cachedDisplayItems = ChatDisplayItem.patch(existing: cachedDisplayItems, from: messages)
        } else {
            cachedDisplayItems = ChatDisplayItem.build(from: messages)
            cachedDisplaySourceIDs = sourceIDs
        }
    }

    private func rebuildPreCompactionDisplayItems() {
        let messages = viewModel.store.visiblePreCompactionMessages
        let sourceIDs = messages.map(\.id)

        if sourceIDs == cachedPreCompactionSourceIDs, !cachedPreCompactionDisplayItems.isEmpty {
            cachedPreCompactionDisplayItems = ChatDisplayItem.patch(existing: cachedPreCompactionDisplayItems, from: messages)
        } else {
            cachedPreCompactionDisplayItems = ChatDisplayItem.build(from: messages)
            cachedPreCompactionSourceIDs = sourceIDs
        }
    }

    private var topHistoryTrigger: some View {
        GeometryReader { geo in
            Color.clear.preference(
                key: TopScrollOffsetKey.self,
                value: geo.frame(in: .named("chatScroll")).minY
            )
        }
        .frame(height: 1)
    }

    private var historyLoadingIndicator: some View {
        HStack(spacing: 8) {
            ProgressView()
                .controlSize(.small)
                .tint(Theme.Colors.accentLight)
            Text("Loading older messages...")
                .font(Theme.Typography.label())
                .foregroundColor(Color.white.opacity(Theme.Text.secondary))
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 4)
    }

    private var oldestLoadedMessageID: UUID? {
        viewModel.store.visiblePreCompactionMessages.first?.id ?? viewModel.store.messages.first?.id
    }

    private func requestOlderHistoryIfNeeded() {
        guard pendingPrependAnchorID == nil else { return }

        if viewModel.store.hasOlderMessages {
            pendingPrependAnchorID = oldestLoadedMessageID
            viewModel.store.loadOlderMessageBatch()
            return
        }

        if viewModel.store.preCompactionOlderMessageCount > 0 {
            pendingPrependAnchorID = oldestLoadedMessageID
            viewModel.store.showMoreOlderMessages()
        }
    }

    private func preservePrependScrollPosition(using proxy: ScrollViewProxy) -> Bool {
        guard let anchorID = pendingPrependAnchorID else { return false }
        pendingPrependAnchorID = nil

        DispatchQueue.main.async {
            proxy.scrollTo(ChatScrollAnchor.message(anchorID), anchor: .top)
        }

        return true
    }

    private func scrollToLatest(using proxy: ScrollViewProxy, animated: Bool = true) {
        DispatchQueue.main.async {
            if animated {
                withAnimation(.easeOut(duration: 0.2)) {
                    proxy.scrollTo(ChatScrollAnchor.bottom, anchor: .bottom)
                }
            } else {
                proxy.scrollTo(ChatScrollAnchor.bottom, anchor: .bottom)
            }
        }
    }

    private var supportsScrollPhaseTracking: Bool {
        if #available(macOS 15.0, *) {
            return true
        }

        return false
    }
}

private struct ScrollIntentTrackingModifier: ViewModifier {
    let onUserScrollIntent: () -> Void

    func body(content: Content) -> some View {
        if #available(macOS 15.0, *) {
            content.onScrollPhaseChange { _, newPhase in
                switch newPhase {
                case .tracking, .interacting, .decelerating:
                    onUserScrollIntent()
                default:
                    break
                }
            }
        } else {
            content
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
    let isActiveThinking: Bool
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
                isActiveThinking: message.role == .thinking && isActiveThinking,
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
