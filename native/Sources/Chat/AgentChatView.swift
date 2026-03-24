import SwiftUI

private enum ChatPanelLayout {
    static let defaultWidth: CGFloat = 380
    static let vaultBrowserWidth: CGFloat = 720
}

struct AgentChatView: View {
    @ObservedObject var viewModel: AgentChatViewModel
    @FocusState private var isInputFocused: Bool
    @State private var expandedToolMessages: Set<UUID> = []
    @State private var fullscreenToolGroupID: UUID?
    @State private var showsVaultBrowser = false
    @State private var showHotkeyHelp = false
    @State private var slashCommands = Self.fallbackSlashCommands
    @State private var didAttemptSlashCommandFetch = false
    @State private var isSlashCommandPopupVisible = false

    var body: some View {
        ZStack(alignment: .bottom) {
            VStack(spacing: 0) {
                header

                if showsVaultBrowser {
                    VaultBrowserView(
                        ghostName: viewModel.ghostName,
                        client: viewModel.ghostboxClient
                    )
                } else {
                    chatContent
                    inputArea
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
                            olderMessagesToggle
                        }

                        if viewModel.showingPreCompactionMessages {
                            chatItemsSection(preCompactionDisplayItems)
                            CompactionDivider()
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

    private var header: some View {
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
                    systemImage: showsVaultBrowser ? "bubble.left.and.bubble.right" : "folder"
                ) {
                    toggleVaultBrowser()
                }

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

    private var inputArea: some View {
        VStack(spacing: 8) {
            TextField(inputPlaceholder, text: $viewModel.inputText)
                .textFieldStyle(.plain)
                .font(Theme.Typography.body(Theme.FontSize.lg))
                .foregroundColor(Color.white.opacity(Theme.Text.primary))
                .focused($isInputFocused)
                .disabled(viewModel.isLoadingHistory || viewModel.isCompacting)
                .onSubmit { submitInput() }
                .onKeyPress(.tab) {
                    guard showsSlashCommandPopup, let firstCommand = filteredSlashCommands.first else {
                        return .ignored
                    }

                    viewModel.inputText = "/\(firstCommand.name) "
                    return .handled
                }
                .padding(.horizontal, 18)
                .padding(.vertical, 14)
                .background(Color.white.opacity(0.02))
                .clipShape(RoundedRectangle(cornerRadius: 18))
                .padding(.horizontal, 18)

            Text(footerHint)
                .font(Theme.Typography.caption())
                .foregroundColor(Color.white.opacity(0.08))
                .padding(.bottom, 12)
        }
    }

    private var slashCommandPopup: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Slash commands")
                .font(Theme.Typography.label(weight: .semibold))
                .foregroundColor(Theme.Colors.accentLightest)

            VStack(alignment: .leading, spacing: 6) {
                ForEach(filteredSlashCommands) { command in
                    Button {
                        selectSlashCommand(command)
                    } label: {
                        HStack(alignment: .top, spacing: 10) {
                            Text("/\(command.name)")
                                .font(Theme.Typography.label(weight: .semibold))
                                .foregroundColor(Theme.Colors.accentLightest)
                                .frame(width: 92, alignment: .leading)

                            Text(command.description)
                                .font(Theme.Typography.body())
                                .foregroundColor(Color.white.opacity(Theme.Text.secondary))
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 10)
                        .background(Color.white.opacity(0.04))
                        .clipShape(RoundedRectangle(cornerRadius: 14))
                        .overlay(
                            RoundedRectangle(cornerRadius: 14)
                                .strokeBorder(Theme.Colors.accentLight.opacity(0.18), lineWidth: 0.5)
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 20)
                .fill(Theme.Colors.surfaceElevated.opacity(0.96))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 20)
                .strokeBorder(Theme.Colors.accentLight.opacity(0.22), lineWidth: 0.6)
        )
        .shadow(color: Theme.Colors.accent.opacity(0.18), radius: 22, x: 0, y: 12)
    }

    private var inputPlaceholder: String {
        if viewModel.isLoadingHistory {
            return "Loading chat history..."
        }

        if viewModel.isCompacting {
            return "Compacting chat..."
        }

        return "Talk to \(viewModel.ghostName)..."
    }

    private var footerHint: String {
        if viewModel.isLoadingHistory {
            return "Please wait"
        }

        if viewModel.isCompacting {
            return "Refreshing conversation"
        }

        return "Press return to send"
    }

    private var showsSlashCommandPopup: Bool {
        !showsVaultBrowser &&
        isSlashCommandPopupVisible &&
        fullscreenToolGroup == nil &&
        slashAutocompleteQuery != nil &&
        !filteredSlashCommands.isEmpty
    }

    private var slashAutocompleteQuery: String? {
        guard viewModel.inputText.hasPrefix("/") else { return nil }

        let remainder = String(viewModel.inputText.dropFirst())
        guard !remainder.contains(where: \.isWhitespace) else { return nil }

        return remainder.lowercased()
    }

    private var filteredSlashCommands: [GhostSlashCommand] {
        guard let query = slashAutocompleteQuery else { return [] }
        guard !query.isEmpty else { return slashCommands }

        return slashCommands.filter { command in
            command.name.range(of: query, options: [.anchored, .caseInsensitive]) != nil
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

        return .ignored
    }

    // Panel shortcuts (Cmd+\, Cmd+/) handled by GlassPanel.keyDown via NotificationCenter

    private func handleInputTextChanged() {
        isSlashCommandPopupVisible = slashAutocompleteQuery != nil

        guard isSlashCommandPopupVisible else { return }
        loadSlashCommandsIfNeeded()
    }

    private func selectSlashCommand(_ command: GhostSlashCommand) {
        viewModel.inputText = "/\(command.name) "
        dismissSlashCommandPopup()
        isInputFocused = true
    }

    private func dismissSlashCommandPopup() {
        isSlashCommandPopupVisible = false
    }

    private func loadSlashCommandsIfNeeded() {
        guard !didAttemptSlashCommandFetch else { return }

        didAttemptSlashCommandFetch = true

        Task {
            do {
                let fetchedCommands = try await viewModel.ghostboxClient.fetchCommands(ghostName: viewModel.ghostName)
                await MainActor.run {
                    slashCommands = mergedSlashCommands(with: fetchedCommands)
                }
            } catch {
                await MainActor.run {
                    slashCommands = Self.fallbackSlashCommands
                }
            }
        }
    }

    private func mergedSlashCommands(with fetchedCommands: [GhostSlashCommand]) -> [GhostSlashCommand] {
        var commandsByName = Dictionary(uniqueKeysWithValues: Self.fallbackSlashCommands.map {
            ($0.name.lowercased(), $0)
        })

        for command in fetchedCommands {
            commandsByName[command.name.lowercased()] = command
        }

        let orderedNames = Self.fallbackSlashCommands.map(\.name) + fetchedCommands.map(\.name)
        var seenNames = Set<String>()

        return orderedNames.compactMap { name in
            let normalizedName = name.lowercased()
            guard seenNames.insert(normalizedName).inserted else { return nil }
            return commandsByName[normalizedName]
        }
    }

    private static let fallbackSlashCommands = [
        GhostSlashCommand(name: "compact", description: "Condense the current chat into a shorter summary."),
        GhostSlashCommand(name: "history", description: "Show the recent conversation history."),
        GhostSlashCommand(name: "model", description: "Check or change the model for this ghost."),
        GhostSlashCommand(name: "help", description: "List the available slash commands.")
    ]

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

    private var displayItems: [ChatDisplayItem] {
        displayItems(for: viewModel.messages)
    }

    private var preCompactionDisplayItems: [ChatDisplayItem] {
        displayItems(for: viewModel.preCompactionMessages)
    }

    private var fullscreenToolGroup: ToolCallGroup? {
        guard let fullscreenToolGroupID else { return nil }

        for item in displayItems {
            if case .toolGroup(let group) = item, group.id == fullscreenToolGroupID {
                return group
            }
        }

        return nil
    }

    @ViewBuilder
    private func chatItemsSection(_ items: [ChatDisplayItem]) -> some View {
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

            if index < items.count - 1 {
                ExchangeBreak()
            }
        }
    }

    private func displayItems(for messages: [ChatMessage]) -> [ChatDisplayItem] {
        ChatDisplayItem.build(from: messages)
    }

    private var olderMessagesToggle: some View {
        Button {
            withAnimation(.easeOut(duration: 0.18)) {
                viewModel.showingPreCompactionMessages.toggle()
            }
        } label: {
            Text(
                viewModel.showingPreCompactionMessages
                    ? "Hide \(viewModel.preCompactionMessages.count) older messages"
                    : "Show \(viewModel.preCompactionMessages.count) older messages"
            )
            .font(Theme.Typography.label())
            .foregroundColor(Color.white.opacity(Theme.Text.secondary))
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 20)
        }
        .buttonStyle(.plain)
    }
}

private enum ChatScrollAnchor {
    static let bottom = "chat-bottom-anchor"
}

struct HotkeyHelpOverlay: View {
    let onDismiss: () -> Void

    var body: some View {
        ZStack {
            Color.black.opacity(0.7)
                .ignoresSafeArea()

            VStack(alignment: .leading, spacing: 18) {
                Text("Keyboard Shortcuts")
                    .font(Theme.Typography.display(Theme.FontSize.xxl, weight: .semibold))
                    .foregroundColor(Theme.Colors.accentLightest)

                VStack(alignment: .leading, spacing: 12) {
                    ForEach(ShortcutItem.allCases) { item in
                        HStack(alignment: .top, spacing: 16) {
                            Text(item.shortcut)
                                .font(Theme.Typography.label(Theme.FontSize.md, weight: .semibold))
                                .foregroundColor(Theme.Colors.accentLight)
                                .frame(width: 120, alignment: .leading)

                            Text(item.description)
                                .font(Theme.Typography.body())
                                .foregroundColor(Color.white.opacity(Theme.Text.secondary))
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                }

                Text("Click anywhere or press Escape to dismiss.")
                    .font(Theme.Typography.caption())
                    .foregroundColor(Color.white.opacity(Theme.Text.tertiary))
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 22)
            .frame(maxWidth: 420, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 24)
                    .fill(Theme.Colors.surfaceElevated.opacity(0.96))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 24)
                    .strokeBorder(Theme.Colors.accentLight.opacity(0.28), lineWidth: 0.8)
            )
            .shadow(color: Theme.Colors.accent.opacity(0.2), radius: 30, x: 0, y: 16)
        }
        .contentShape(Rectangle())
        .onTapGesture {
            onDismiss()
        }
    }
}

private enum ShortcutItem: String, CaseIterable, Identifiable {
    case toggleGhostbox
    case toggleChatFiles
    case showHelp
    case closePanel
    case autocompleteSlashCommand
    case sendMessage

    var id: String { rawValue }

    var shortcut: String {
        switch self {
        case .toggleGhostbox:
            return "Cmd+Shift+G"
        case .toggleChatFiles:
            return "Cmd+\\"
        case .showHelp:
            return "Cmd+/"
        case .closePanel:
            return "Esc"
        case .autocompleteSlashCommand:
            return "Tab"
        case .sendMessage:
            return "Return"
        }
    }

    var description: String {
        switch self {
        case .toggleGhostbox:
            return "Toggle Ghostbox"
        case .toggleChatFiles:
            return "Switch to Chat / Files"
        case .showHelp:
            return "Show this help"
        case .closePanel:
            return "Close panel"
        case .autocompleteSlashCommand:
            return "Autocomplete slash command"
        case .sendMessage:
            return "Send message"
        }
    }
}

private enum ChatDisplayItem: Identifiable {
    case message(ChatMessage)
    case toolGroup(ToolCallGroup)

    var id: UUID {
        switch self {
        case .message(let message):
            return message.id
        case .toolGroup(let group):
            return group.id
        }
    }

    static func build(from messages: [ChatMessage]) -> [ChatDisplayItem] {
        var items: [ChatDisplayItem] = []
        var index = 0

        while index < messages.count {
            let message = messages[index]

            if message.role == .toolUse {
                let result: ChatMessage?
                if index + 1 < messages.count, messages[index + 1].role == .toolResult {
                    result = messages[index + 1]
                    index += 1
                } else {
                    result = nil
                }

                items.append(.toolGroup(ToolCallGroup(toolUse: message, toolResult: result)))
            } else if message.role == .toolResult {
                items.append(.message(message))
            } else {
                items.append(.message(message))
            }

            index += 1
        }

        return items
    }
}

private struct ToolCallGroup: Identifiable {
    let toolUse: ChatMessage
    let toolResult: ChatMessage?

    var id: UUID { toolUse.id }

    var toolName: String {
        toolUse.resolvedToolName
    }

    var toolKind: String {
        toolUse.normalizedToolKind
    }

    var iconName: String {
        switch toolKind {
        case "bash":
            return "terminal.fill"
        case "read":
            return "doc.text"
        case "write":
            return "pencil"
        default:
            return "wrench"
        }
    }

    var collapsedPreview: String {
        let inputPreview = cleaned(toolUse.toolInputPreview)

        guard let toolResult else {
            return truncated(inputPreview, limit: 80)
        }

        if toolKind == "read", let subject = toolUse.toolPrimarySubject {
            return truncated("\(cleaned(subject)) -> \(toolResult.contentSizeSummary)", limit: 80)
        }

        let outputPreview = cleaned(toolResult.toolOutputPreview)
        guard !outputPreview.isEmpty else {
            return truncated(inputPreview, limit: 80)
        }

        return truncated("\(inputPreview) -> \(outputPreview)", limit: 80)
    }

    private func cleaned(_ text: String) -> String {
        text.replacingOccurrences(of: "\t", with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func truncated(_ text: String, limit: Int) -> String {
        guard text.count > limit else { return text }
        let endIndex = text.index(text.startIndex, offsetBy: limit)
        return String(text[..<endIndex]) + "..."
    }
}

extension Notification.Name {
    static let resizeGhostChatPanel = Notification.Name("resizeGhostChatPanel")
    static let toggleGhostChatFiles = Notification.Name("toggleGhostChatFiles")
    static let toggleGhostHotkeyHelp = Notification.Name("toggleGhostHotkeyHelp")
}

private struct ChatHeaderButton: View {
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

private struct CompactionDivider: View {
    var body: some View {
        HStack(spacing: 12) {
            Rectangle()
                .fill(Color.white.opacity(0.15))
                .frame(height: 1)

            Text("Compacted")
                .font(Theme.Typography.caption(weight: .medium))
                .foregroundColor(Color.white.opacity(0.15))

            Rectangle()
                .fill(Color.white.opacity(0.15))
                .frame(height: 1)
        }
        .padding(.horizontal, 20)
    }
}

private struct AgentMessageBlock: View {
    let message: ChatMessage
    let ghostName: String

    private static let formatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "h:mm a"
        return formatter
    }()

    var body: some View {
        VStack(alignment: message.role == .user ? .trailing : .leading, spacing: 4) {
            Text(senderName)
                .font(Theme.Typography.label(weight: .semibold))
                .foregroundColor(senderColor)

            Text(message.content)
                .font(Theme.Typography.body())
                .foregroundColor(contentColor)
                .textSelection(.enabled)
                .lineSpacing(5.6)
                .fixedSize(horizontal: false, vertical: true)

            Text(Self.formatter.string(from: message.timestamp))
                .font(Theme.Typography.caption())
                .foregroundColor(Color.white.opacity(0.1))
                .padding(.top, 1)
        }
        .frame(maxWidth: .infinity, alignment: message.role == .user ? .trailing : .leading)
        .padding(.horizontal, 20)
    }

    private var senderName: String {
        switch message.role {
        case .ghost:
            return ghostName
        case .user:
            return "You"
        case .system:
            return "System"
        case .toolUse:
            return "Tool"
        case .toolResult:
            return "Result"
        }
    }

    private var senderColor: Color {
        switch message.role {
        case .ghost:
            return Theme.Colors.accentLight
        case .user:
            return Color.white.opacity(Theme.Text.tertiary)
        case .system:
            return Color.orange.opacity(0.85)
        case .toolUse:
            return Theme.Colors.accentLightest
        case .toolResult:
            return Color.white.opacity(Theme.Text.tertiary)
        }
    }

    private var contentColor: Color {
        switch message.role {
        case .ghost:
            return Color.white.opacity(Theme.Text.primary)
        case .user:
            return Color.white.opacity(Theme.Text.secondary)
        case .system:
            return Color.orange.opacity(0.9)
        case .toolUse, .toolResult:
            return Color.white.opacity(Theme.Text.secondary)
        }
    }
}

private struct ToolCallGroupBlock: View {
    let group: ToolCallGroup
    let isExpanded: Bool
    let onToggle: () -> Void
    let onShowFullscreen: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button(action: onToggle) {
                HStack(spacing: 10) {
                    Image(systemName: group.iconName)
                        .font(.system(size: Theme.FontSize.sm, weight: .medium))
                        .foregroundColor(Theme.Colors.accentLight)
                        .frame(width: 14)

                    Text(group.toolName)
                        .font(Theme.Typography.label(weight: .semibold))
                        .foregroundColor(Theme.Colors.accentLightest)

                    Text(group.collapsedPreview)
                        .font(Theme.Typography.label(weight: .regular))
                        .foregroundColor(Color.white.opacity(Theme.Text.secondary))
                        .lineLimit(1)

                    Spacer(minLength: 0)

                    Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                        .font(.system(size: Theme.FontSize.xs, weight: .medium))
                        .foregroundColor(Color.white.opacity(Theme.Text.quaternary))
                }
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 12)
            .padding(.vertical, 11)
            .background(Color.white.opacity(0.03))
            .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))

            if isExpanded {
                VStack(alignment: .leading, spacing: 12) {
                    HStack(alignment: .top, spacing: 8) {
                        Text("Input")
                            .font(Theme.Typography.caption(weight: .semibold))
                            .foregroundColor(Color.white.opacity(Theme.Text.tertiary))

                        Spacer(minLength: 0)

                        Button(action: onShowFullscreen) {
                            Image(systemName: "arrow.up.left.and.arrow.down.right")
                                .font(.system(size: Theme.FontSize.xs, weight: .semibold))
                                .foregroundColor(Color.white.opacity(Theme.Text.secondary))
                                .frame(width: 24, height: 24)
                                .background(Color.white.opacity(0.04))
                                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                        }
                        .buttonStyle(.plain)
                    }

                    ToolCallContentView(content: group.toolUse.content)

                    if let toolResult = group.toolResult {
                        Rectangle()
                            .fill(Color.white.opacity(0.06))
                            .frame(height: 1)

                        Text("Output")
                            .font(Theme.Typography.caption(weight: .semibold))
                            .foregroundColor(Color.white.opacity(Theme.Text.tertiary))

                        ToolCallContentView(content: toolResult.content)
                    }
                }
                .padding(12)
                .background(Color.white.opacity(0.05))
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                .transition(.opacity.combined(with: .move(edge: .top)))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 20)
    }
}

private struct ToolCallContentView: View {
    let content: String

    var body: some View {
        ScrollView(.vertical, showsIndicators: true) {
            Text(content)
                .font(Theme.Typography.mono())
                .foregroundColor(Color.white.opacity(Theme.Text.secondary))
                .textSelection(.enabled)
                .lineSpacing(4)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxHeight: 220)
    }
}

private struct ToolCallFullscreenOverlay: View {
    let group: ToolCallGroup
    let onClose: () -> Void

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.opacity(0.62)
                .onTapGesture(perform: onClose)

            VStack(alignment: .leading, spacing: 14) {
                HStack(spacing: 10) {
                    Image(systemName: group.iconName)
                        .font(.system(size: Theme.FontSize.sm, weight: .medium))
                        .foregroundColor(Theme.Colors.accentLight)

                    Text(group.toolName)
                        .font(Theme.Typography.label(weight: .semibold))
                        .foregroundColor(Theme.Colors.accentLightest)

                    Text(group.collapsedPreview)
                        .font(Theme.Typography.label(weight: .regular))
                        .foregroundColor(Color.white.opacity(Theme.Text.secondary))
                        .lineLimit(1)

                    Spacer(minLength: 0)

                    Button(action: onClose) {
                        Image(systemName: "xmark")
                            .font(.system(size: Theme.FontSize.sm, weight: .semibold))
                            .foregroundColor(Color.white.opacity(Theme.Text.secondary))
                            .frame(width: 28, height: 28)
                            .background(Color.white.opacity(0.05))
                            .clipShape(Circle())
                    }
                    .buttonStyle(.plain)
                }

                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        Text("Input")
                            .font(Theme.Typography.caption(weight: .semibold))
                            .foregroundColor(Color.white.opacity(Theme.Text.tertiary))

                        Text(group.toolUse.content)
                            .font(Theme.Typography.mono())
                            .foregroundColor(Color.white.opacity(Theme.Text.secondary))
                            .textSelection(.enabled)
                            .lineSpacing(4)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .fixedSize(horizontal: false, vertical: true)

                        if let toolResult = group.toolResult {
                            Rectangle()
                                .fill(Color.white.opacity(0.06))
                                .frame(height: 1)

                            Text("Output")
                                .font(Theme.Typography.caption(weight: .semibold))
                                .foregroundColor(Color.white.opacity(Theme.Text.tertiary))

                            Text(toolResult.content)
                                .font(Theme.Typography.mono())
                                .foregroundColor(Color.white.opacity(Theme.Text.secondary))
                                .textSelection(.enabled)
                                .lineSpacing(4)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .padding(18)
                }
                .background(Color.white.opacity(0.05))
                .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
            }
            .padding(18)
        }
    }
}

private struct ExchangeBreak: View {
    var body: some View {
        Rectangle()
            .fill(Color.white.opacity(0.04))
            .frame(width: 30, height: 1)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.leading, 20)
    }
}

private struct GhostTypingBlock: View {
    let name: String
    @State private var phase = 0
    @State private var timer: Timer?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(name)
                .font(Theme.Typography.label(weight: .semibold))
                .foregroundColor(Theme.Colors.accentLight)

            HStack(spacing: 5) {
                ForEach(0..<3, id: \.self) { index in
                    Circle()
                        .fill(Color.white.opacity(phase == index ? 0.4 : 0.1))
                        .frame(width: 5, height: 5)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 20)
        .onAppear {
            timer?.invalidate()
            timer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { _ in
                phase = (phase + 1) % 3
            }
        }
        .onDisappear {
            timer?.invalidate()
            timer = nil
        }
    }
}

private struct VaultBrowserView: View {
    @StateObject private var viewModel: VaultBrowserViewModel

    init(ghostName: String, client: GhostboxClient) {
        _viewModel = StateObject(wrappedValue: VaultBrowserViewModel(
            ghostName: ghostName,
            client: client
        ))
    }

    var body: some View {
        HStack(spacing: 0) {
            sidebar

            Rectangle()
                .fill(Color.white.opacity(0.04))
                .frame(width: 1)

            viewer
        }
        .background(Color.clear)
    }

    private var sidebar: some View {
        VStack(alignment: .leading, spacing: 16) {
            VaultBreadcrumbs(path: viewModel.currentPath, onSelect: viewModel.navigate)

            if let error = viewModel.error {
                Text(error)
                    .font(Theme.Typography.label(weight: .regular))
                    .foregroundColor(Color.orange.opacity(0.9))
            }

            if viewModel.isLoadingEntries, viewModel.entries.isEmpty {
                ProgressView()
                    .controlSize(.small)
                    .tint(Theme.Colors.accentLight)
            }

            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    if viewModel.currentPath != "/" {
                        VaultEntryRow(
                            title: "..",
                            subtitle: "Parent folder",
                            systemImage: "arrow.turn.up.left",
                            isSelected: false,
                            action: viewModel.navigateToParent
                        )
                    }

                    if viewModel.entries.isEmpty, !viewModel.isLoadingEntries {
                        Text("This folder is empty.")
                            .font(Theme.Typography.body())
                            .foregroundColor(Color.white.opacity(Theme.Text.tertiary))
                            .padding(.top, 8)
                    } else {
                        ForEach(viewModel.entries) { entry in
                            VaultEntryRow(
                                title: entry.name,
                                subtitle: entrySubtitle(for: entry),
                                systemImage: entry.isDirectory ? "folder.fill" : "doc.text",
                                isSelected: viewModel.selectedFilePath == entry.path,
                                action: {
                                    if entry.isDirectory {
                                        viewModel.navigate(to: entry.path)
                                    } else {
                                        viewModel.openFile(at: entry.path)
                                    }
                                }
                            )
                        }
                    }
                }
                .padding(.bottom, 18)
            }
        }
        .frame(minWidth: 240, idealWidth: 260, maxWidth: 280, maxHeight: .infinity, alignment: .topLeading)
        .padding(.horizontal, 20)
        .padding(.top, 20)
        .padding(.bottom, 16)
        .background(Color.clear)
    }

    private var viewer: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .center, spacing: 10) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(viewModel.viewerTitle)
                        .font(Theme.Typography.display())
                        .foregroundColor(Color.white.opacity(Theme.Text.primary))

                    Text(viewModel.viewerSubtitle)
                        .font(Theme.Typography.label(weight: .regular))
                        .foregroundColor(Color.white.opacity(Theme.Text.tertiary))
                }

                Spacer(minLength: 0)

                if viewModel.selectedFilePath != nil {
                    if viewModel.isEditing {
                        ChatHeaderButton(title: "Save", systemImage: "square.and.arrow.down") {
                            viewModel.save()
                        }
                        .disabled(viewModel.isSaving)
                    } else {
                        ChatHeaderButton(title: "Edit", systemImage: "square.and.pencil") {
                            viewModel.startEditing()
                        }
                        .disabled(viewModel.loadedFile == nil || viewModel.isLoadingFile)
                    }
                }
            }

            Group {
                if viewModel.isLoadingFile {
                    VStack(spacing: 12) {
                        ProgressView()
                            .controlSize(.small)
                            .tint(Theme.Colors.accentLight)

                        Text("Loading file...")
                            .font(Theme.Typography.body())
                            .foregroundColor(Color.white.opacity(Theme.Text.secondary))
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let file = viewModel.loadedFile {
                    if viewModel.isEditing {
                        TextEditor(text: $viewModel.draftContent)
                            .font(Theme.Typography.body())
                            .foregroundColor(Color.white.opacity(Theme.Text.primary))
                            .scrollContentBackground(.hidden)
                            .padding(16)
                            .background(Color.white.opacity(0.03))
                            .clipShape(RoundedRectangle(cornerRadius: 20))
                    } else {
                        ScrollView {
                            Text(file.content)
                                .font(Theme.Typography.body())
                                .foregroundColor(Color.white.opacity(Theme.Text.primary))
                                .kerning(0.1)
                                .lineSpacing(4.8)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .topLeading)
                                .padding(18)
                        }
                        .background(Color.white.opacity(0.03))
                        .clipShape(RoundedRectangle(cornerRadius: 20))
                    }
                } else {
                    VStack(spacing: 8) {
                        Image(systemName: "folder.badge.questionmark")
                            .font(.system(size: 26, weight: .light))
                            .foregroundColor(Theme.Colors.accentLight.opacity(0.9))

                        Text("Choose a file to read it here.")
                            .font(Theme.Typography.body(weight: .medium))
                            .foregroundColor(Color.white.opacity(Theme.Text.secondary))

                        Text("Folders open in the browser on the left.")
                            .font(Theme.Typography.body())
                            .foregroundColor(Color.white.opacity(Theme.Text.tertiary))
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(.horizontal, 20)
        .padding(.top, 20)
        .padding(.bottom, 16)
        .background(Color.clear)
    }

    private func entrySubtitle(for entry: VaultEntry) -> String {
        if entry.isDirectory {
            return "Folder"
        }

        if let size = entry.size {
            return ByteCountFormatter.string(fromByteCount: Int64(size), countStyle: .file)
        }

        return "File"
    }
}

private struct VaultEntryRow: View {
    let title: String
    let subtitle: String
    let systemImage: String
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: systemImage)
                    .font(.system(size: Theme.FontSize.xs, weight: .medium))
                    .foregroundColor(isSelected ? Theme.Colors.accentLightest : Theme.Colors.accentLight.opacity(0.9))
                    .frame(width: 16)

                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(Theme.Typography.body(weight: .medium))
                        .foregroundColor(Color.white.opacity(Theme.Text.primary))
                        .lineLimit(1)

                    Text(subtitle)
                        .font(Theme.Typography.caption())
                        .foregroundColor(Color.white.opacity(Theme.Text.tertiary))
                        .lineLimit(1)
                }

                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 11)
            .background(
                RoundedRectangle(cornerRadius: 16)
                    .fill(isSelected ? Theme.Colors.accent.opacity(0.18) : Color.white.opacity(0.03))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 16)
                    .strokeBorder(
                        isSelected ? Theme.Colors.accentLight.opacity(0.26) : Color.white.opacity(0.04),
                        lineWidth: 0.5
                    )
            )
        }
        .buttonStyle(.plain)
    }
}

private struct VaultBreadcrumbs: View {
    let path: String
    let onSelect: (String) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(Array(segments.enumerated()), id: \.offset) { index, segment in
                    Button(segment.title) {
                        onSelect(segment.path)
                    }
                    .buttonStyle(.plain)
                    .font(Theme.Typography.label(weight: index == segments.count - 1 ? .semibold : .medium))
                    .foregroundColor(index == segments.count - 1 ? Theme.Colors.accentLightest : Color.white.opacity(Theme.Text.secondary))

                    if index < segments.count - 1 {
                        Image(systemName: "chevron.right")
                            .font(.system(size: Theme.FontSize.xs, weight: .medium))
                            .foregroundColor(Color.white.opacity(Theme.Text.quaternary))
                    }
                }
            }
        }
    }

    private var segments: [(title: String, path: String)] {
        let trimmed = path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !trimmed.isEmpty else {
            return [("Vault", "/")]
        }

        var results: [(String, String)] = [("Vault", "/")]
        var builtPath = ""

        for component in trimmed.split(separator: "/") {
            builtPath += "/" + component
            results.append((String(component), builtPath))
        }

        return results
    }
}

@MainActor
private final class VaultBrowserViewModel: ObservableObject {
    let ghostName: String

    @Published private(set) var currentPath = "/"
    @Published private(set) var entries: [VaultEntry] = []
    @Published private(set) var loadedFile: VaultFile?
    @Published private(set) var selectedFilePath: String?
    @Published private(set) var isLoadingEntries = false
    @Published private(set) var isLoadingFile = false
    @Published private(set) var isSaving = false
    @Published var draftContent = ""
    @Published var isEditing = false
    @Published var error: String?

    private let client: GhostboxClient

    init(ghostName: String, client: GhostboxClient) {
        self.ghostName = ghostName
        self.client = client

        Task { [weak self] in
            await self?.loadEntries()
        }
    }

    var viewerTitle: String {
        loadedFile?.path ?? "Vault Files"
    }

    var viewerSubtitle: String {
        if isSaving {
            return "Saving changes..."
        }

        if let file = loadedFile {
            return ByteCountFormatter.string(fromByteCount: Int64(file.size), countStyle: .file)
        }

        return "Browse \(ghostName)'s vault"
    }

    func navigate(to path: String) {
        currentPath = normalized(path)
        selectedFilePath = nil
        loadedFile = nil
        draftContent = ""
        isEditing = false

        Task { [weak self] in
            await self?.loadEntries()
        }
    }

    func navigateToParent() {
        guard currentPath != "/" else { return }

        let components = currentPath
            .trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            .split(separator: "/")

        if components.count <= 1 {
            navigate(to: "/")
        } else {
            let parent = "/" + components.dropLast().joined(separator: "/")
            navigate(to: parent)
        }
    }

    func openFile(at path: String) {
        selectedFilePath = path
        isEditing = false
        error = nil

        Task { [weak self] in
            await self?.loadFile(path: path)
        }
    }

    func startEditing() {
        guard let loadedFile else { return }
        draftContent = loadedFile.content
        isEditing = true
    }

    func save() {
        guard let selectedFilePath else { return }

        isSaving = true
        error = nil

        Task { [weak self] in
            guard let self else { return }

            defer {
                self.isSaving = false
            }

            do {
                try await self.client.writeVaultFile(
                    ghostName: self.ghostName,
                    path: selectedFilePath,
                    content: self.draftContent
                )

                self.isEditing = false
                await self.loadFile(path: selectedFilePath)
                await self.loadEntries()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    private func loadEntries() async {
        isLoadingEntries = true
        error = nil
        let requestedPath = currentPath

        defer {
            isLoadingEntries = false
        }

        do {
            let fetchedEntries = try await client.listVault(ghostName: ghostName, path: requestedPath)
            let sortedEntries = fetchedEntries.sorted { lhs, rhs in
                if lhs.isDirectory != rhs.isDirectory {
                    return lhs.isDirectory && !rhs.isDirectory
                }

                return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
            }

            guard requestedPath == currentPath else { return }

            withAnimation(.easeOut(duration: 0.15)) {
                entries = sortedEntries
            }
        } catch {
            guard requestedPath == currentPath else { return }
            self.error = error.localizedDescription
        }
    }

    private func loadFile(path: String) async {
        isLoadingFile = true
        error = nil

        defer {
            isLoadingFile = false
        }

        do {
            let file = try await client.readVaultFile(ghostName: ghostName, path: path)
            loadedFile = file
            draftContent = file.content
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func normalized(_ path: String) -> String {
        guard !path.isEmpty, path != "/" else { return "/" }
        return path.hasPrefix("/") ? path : "/" + path
    }
}
