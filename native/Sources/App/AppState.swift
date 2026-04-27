import Combine
import Foundation

@MainActor
final class AppState: ObservableObject {
    let client: GhostboxClient

    @Published var ghosts: [Ghost] = []
    @Published var isLoading = false
    @Published var isStartingServer = false
    @Published var serverStatus: String?
    @Published var error: String?
    @Published var unreadGhosts: Set<String> = []
    @Published var lastRealtimeEventId: String?

    init(client: GhostboxClient = GhostboxClient()) {
        self.client = client
    }

    func markUnread(_ ghostName: String) {
        unreadGhosts.insert(ghostName)
    }

    func markRead(_ ghostName: String) {
        unreadGhosts.remove(ghostName)
    }

    func replaceGhosts(_ ghosts: [Ghost]) {
        self.ghosts = ghosts.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }

    func upsertGhost(_ ghost: Ghost) {
        if let index = ghosts.firstIndex(where: { $0.name == ghost.name }) {
            ghosts[index] = ghost
        } else {
            ghosts.append(ghost)
            ghosts.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        }
    }

    func removeGhost(_ ghostName: String) {
        ghosts.removeAll { $0.name == ghostName }
        unreadGhosts.remove(ghostName)
    }

    func refreshGhosts() async {
        isLoading = true
        error = nil

        do {
            let fetchedGhosts = try await client.listGhosts()
            replaceGhosts(fetchedGhosts)
        } catch {
            self.error = error.localizedDescription
        }

        isLoading = false
    }
}
