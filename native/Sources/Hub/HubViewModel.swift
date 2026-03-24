import Foundation

@MainActor
final class HubViewModel: ObservableObject {
    @Published var ghosts: [Ghost] = []
    @Published private(set) var isLoading = false
    @Published var isSpawning = false
    @Published var spawnName = ""
    @Published var spawnProvider = "anthropic"
    @Published var spawnModel = ""
    @Published var spawnSystemPrompt = ""
    @Published var showSpawnForm = false
    @Published var error: String?

    private let client: GhostboxClient
    private var pollTimer: Timer?

    init(client: GhostboxClient) {
        self.client = client
    }

    deinit {
        pollTimer?.invalidate()
    }

    func loadGhosts() async {
        isLoading = true
        defer { isLoading = false }

        do {
            let fetchedGhosts = try await client.listGhosts()
            ghosts = fetchedGhosts.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    func spawn() async {
        let trimmedName = spawnName.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedModel = spawnModel.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedPrompt = spawnSystemPrompt.trimmingCharacters(in: .whitespacesAndNewlines)

        guard !trimmedName.isEmpty else {
            error = "Ghost name is required."
            return
        }

        guard !trimmedModel.isEmpty else {
            error = "Model is required."
            return
        }

        isSpawning = true
        defer { isSpawning = false }

        do {
            _ = try await client.spawnGhost(
                name: trimmedName,
                provider: spawnProvider,
                model: trimmedModel,
                systemPrompt: trimmedPrompt.isEmpty ? nil : trimmedPrompt
            )

            spawnName = ""
            spawnModel = ""
            spawnSystemPrompt = ""
            showSpawnForm = false
            error = nil
            await loadGhosts()
        } catch {
            self.error = error.localizedDescription
        }
    }

    func kill(name: String) async {
        await performGhostAction {
            try await client.killGhost(name: name)
        }
    }

    func wake(name: String) async {
        await performGhostAction {
            try await client.wakeGhost(name: name)
        }
    }

    func remove(name: String) async {
        await performGhostAction {
            try await client.removeGhost(name: name)
        }
    }

    func startPolling() {
        guard pollTimer == nil else { return }

        Task { await loadGhosts() }

        pollTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            Task { [weak self] in
                await self?.loadGhosts()
            }
        }
    }

    func stopPolling() {
        pollTimer?.invalidate()
        pollTimer = nil
    }

    private func performGhostAction(_ action: () async throws -> Void) async {
        do {
            try await action()
            error = nil
            await loadGhosts()
        } catch {
            self.error = error.localizedDescription
        }
    }
}
