import Foundation
import SwiftUI

struct VaultBrowserView: View {
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

struct VaultEntryRow: View {
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

struct VaultBreadcrumbs: View {
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
final class VaultBrowserViewModel: ObservableObject {
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
