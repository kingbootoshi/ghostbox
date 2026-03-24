import SwiftUI

private enum ChatPanelLayout {
    static let defaultWidth: CGFloat = 380
    static let vaultBrowserWidth: CGFloat = 720
}

struct AgentChatView: View {
    @ObservedObject var viewModel: AgentChatViewModel
    @FocusState private var isInputFocused: Bool
    @State private var expandedToolMessages: Set<UUID> = []
    @State private var showsVaultBrowser = false

    var body: some View {
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
        .background(Color.clear)
        .onAppear {
            isInputFocused = true
        }
        .onChange(of: showsVaultBrowser) {
            isInputFocused = !showsVaultBrowser
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
                            .font(.custom("DM Sans", size: 12))
                            .foregroundColor(Color.white.opacity(Theme.Text.secondary))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 40)
                } else if viewModel.messages.isEmpty {
                    VStack(spacing: 8) {
                        Text("No messages yet.")
                            .font(.custom("DM Sans", size: 14).weight(.medium))
                            .foregroundColor(Color.white.opacity(Theme.Text.secondary))

                        Text("Send a message to start the thread.")
                            .font(.custom("DM Sans", size: 12))
                            .foregroundColor(Color.white.opacity(Theme.Text.tertiary))
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, 40)
                } else {
                    LazyVStack(spacing: 20) {
                        ForEach(Array(viewModel.messages.enumerated()), id: \.element.id) { index, message in
                            if message.role == .toolUse || message.role == .toolResult {
                                ToolMessageBlock(
                                    message: message,
                                    isExpanded: expandedToolMessages.contains(message.id),
                                    onToggle: { toggleToolMessage(message.id) }
                                )
                            } else {
                                AgentMessageBlock(message: message, ghostName: viewModel.ghostName)
                            }

                            if index < viewModel.messages.count - 1 {
                                ExchangeBreak()
                            }
                        }

                        if viewModel.isStreaming {
                            GhostTypingBlock(name: viewModel.ghostName)
                        }
                    }
                    .padding(.top, 20)
                    .padding(.bottom, 16)
                }
            }
            .onChange(of: viewModel.messages.count) {
                guard let last = viewModel.messages.last else { return }
                withAnimation(.easeOut(duration: 0.2)) {
                    proxy.scrollTo(last.id, anchor: .bottom)
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
                    .font(.custom("DM Sans", size: 16).weight(.semibold))
                    .foregroundColor(Theme.Colors.accentLight)

                Text(viewModel.ghost?.model ?? "Loading...")
                    .font(.custom("DM Sans", size: 11))
                    .foregroundColor(Color.white.opacity(Theme.Text.tertiary))

                Spacer(minLength: 0)

                if viewModel.isStreaming {
                    Button("Stop") {
                        viewModel.cancelStream()
                    }
                    .font(.custom("DM Sans", size: 11).weight(.medium))
                    .foregroundColor(Color.white.opacity(Theme.Text.secondary))
                    .buttonStyle(.plain)
                }

                ChatHeaderButton(
                    title: showsVaultBrowser ? "Chat" : "Files",
                    systemImage: showsVaultBrowser ? "bubble.left.and.bubble.right" : "folder"
                ) {
                    withAnimation(.easeOut(duration: 0.18)) {
                        showsVaultBrowser.toggle()
                    }
                }

                Button {
                    NotificationCenter.default.post(
                        name: .closeGhostChat,
                        object: nil,
                        userInfo: ["ghostName": viewModel.ghostName]
                    )
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(Color.white.opacity(Theme.Text.tertiary))
                        .frame(width: 24, height: 24)
                        .background(Color.white.opacity(0.05))
                        .clipShape(Circle())
                }
                .buttonStyle(.plain)
            }

            if let error = viewModel.error {
                Text(error)
                    .font(.custom("DM Sans", size: 11))
                    .foregroundColor(Color.orange.opacity(0.9))
            } else if viewModel.isLoadingHistory {
                Text("Loading saved messages...")
                    .font(.custom("DM Sans", size: 11))
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
                .font(.custom("DM Sans", size: 14))
                .foregroundColor(Color.white.opacity(Theme.Text.primary))
                .focused($isInputFocused)
                .disabled(viewModel.isLoadingHistory || viewModel.isCompacting)
                .onSubmit { viewModel.send() }
                .padding(.horizontal, 18)
                .padding(.vertical, 14)
                .background(Color.white.opacity(0.02))
                .clipShape(RoundedRectangle(cornerRadius: 18))
                .padding(.horizontal, 18)

            Text(footerHint)
                .font(.custom("DM Sans", size: 10))
                .foregroundColor(Color.white.opacity(0.08))
                .padding(.bottom, 12)
        }
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
        if expandedToolMessages.contains(id) {
            expandedToolMessages.remove(id)
        } else {
            expandedToolMessages.insert(id)
        }
    }
}

extension Notification.Name {
    static let resizeGhostChatPanel = Notification.Name("resizeGhostChatPanel")
}

private struct ChatHeaderButton: View {
    let title: String
    let systemImage: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: systemImage)
                    .font(.system(size: 10, weight: .semibold))

                Text(title)
                    .font(.custom("DM Sans", size: 11).weight(.medium))
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
                .font(.custom("DM Sans", size: 11).weight(.semibold))
                .foregroundColor(senderColor)

            Text(message.content)
                .font(.custom("DM Sans", size: 14))
                .foregroundColor(contentColor)
                .textSelection(.enabled)
                .lineSpacing(5.6)
                .fixedSize(horizontal: false, vertical: true)

            Text(Self.formatter.string(from: message.timestamp))
                .font(.custom("DM Sans", size: 9.5))
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

private struct ToolMessageBlock: View {
    let message: ChatMessage
    let isExpanded: Bool
    let onToggle: () -> Void

    private static let formatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "h:mm a"
        return formatter
    }()

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Button(action: onToggle) {
                HStack(spacing: 8) {
                    Text(message.role == .toolUse ? "Tool" : "Result")
                        .font(.custom("DM Sans", size: 11).weight(.semibold))
                        .foregroundColor(message.role == .toolUse ? Theme.Colors.accentLightest : Color.white.opacity(Theme.Text.tertiary))

                    Text(message.toolName ?? fallbackName)
                        .font(.custom("DM Sans", size: 11))
                        .foregroundColor(Color.white.opacity(Theme.Text.secondary))

                    Spacer(minLength: 0)

                    Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundColor(Color.white.opacity(Theme.Text.quaternary))
                }
            }
            .buttonStyle(.plain)

            Text(displayContent)
                .font(.custom("DM Sans", size: 13))
                .foregroundColor(Color.white.opacity(Theme.Text.secondary))
                .lineSpacing(4.8)
                .fixedSize(horizontal: false, vertical: true)

            Text(Self.formatter.string(from: message.timestamp))
                .font(.custom("DM Sans", size: 9.5))
                .foregroundColor(Color.white.opacity(0.1))
                .padding(.top, 1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 20)
    }

    private var fallbackName: String {
        message.role == .toolUse ? "Tool Call" : "Tool Result"
    }

    private var displayContent: String {
        guard !isExpanded else { return message.content }
        return truncated(message.content, limit: 160)
    }

    private func truncated(_ text: String, limit: Int) -> String {
        guard text.count > limit else { return text }
        let endIndex = text.index(text.startIndex, offsetBy: limit)
        return String(text[..<endIndex]) + "..."
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
                .font(.custom("DM Sans", size: 11).weight(.semibold))
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
                    .font(.custom("DM Sans", size: 11))
                    .foregroundColor(Color.orange.opacity(0.9))
            }

            if viewModel.isLoadingEntries {
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
                            .font(.custom("DM Sans", size: 12))
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
                        .font(.custom("DM Sans", size: 16).weight(.semibold))
                        .foregroundColor(Color.white.opacity(Theme.Text.primary))

                    Text(viewModel.viewerSubtitle)
                        .font(.custom("DM Sans", size: 11))
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
                            .font(.custom("DM Sans", size: 12))
                            .foregroundColor(Color.white.opacity(Theme.Text.secondary))
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let file = viewModel.loadedFile {
                    if viewModel.isEditing {
                        TextEditor(text: $viewModel.draftContent)
                            .font(.custom("DM Sans", size: 13))
                            .foregroundColor(Color.white.opacity(Theme.Text.primary))
                            .scrollContentBackground(.hidden)
                            .padding(16)
                            .background(Color.white.opacity(0.03))
                            .clipShape(RoundedRectangle(cornerRadius: 20))
                    } else {
                        ScrollView {
                            Text(file.content)
                                .font(.custom("DM Sans", size: 13))
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
                            .font(.custom("DM Sans", size: 14).weight(.medium))
                            .foregroundColor(Color.white.opacity(Theme.Text.secondary))

                        Text("Folders open in the browser on the left.")
                            .font(.custom("DM Sans", size: 12))
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
                    .font(.system(size: 12, weight: .medium))
                    .foregroundColor(isSelected ? Theme.Colors.accentLightest : Theme.Colors.accentLight.opacity(0.9))
                    .frame(width: 16)

                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(.custom("DM Sans", size: 12.5).weight(.medium))
                        .foregroundColor(Color.white.opacity(Theme.Text.primary))
                        .lineLimit(1)

                    Text(subtitle)
                        .font(.custom("DM Sans", size: 10.5))
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
                    .font(.custom("DM Sans", size: 11).weight(index == segments.count - 1 ? .semibold : .medium))
                    .foregroundColor(index == segments.count - 1 ? Theme.Colors.accentLightest : Color.white.opacity(Theme.Text.secondary))

                    if index < segments.count - 1 {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 8, weight: .medium))
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

        defer {
            isLoadingEntries = false
        }

        do {
            let fetchedEntries = try await client.listVault(ghostName: ghostName, path: currentPath)
            entries = fetchedEntries.sorted { lhs, rhs in
                if lhs.isDirectory != rhs.isDirectory {
                    return lhs.isDirectory && !rhs.isDirectory
                }

                return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
            }
        } catch {
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
