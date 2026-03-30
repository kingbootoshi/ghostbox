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

    init(client: GhostboxClient = GhostboxClient()) {
        self.client = client
    }

    func markUnread(_ ghostName: String) {
        unreadGhosts.insert(ghostName)
    }

    func markRead(_ ghostName: String) {
        unreadGhosts.remove(ghostName)
    }

    func refreshGhosts() async {
        isLoading = true
        error = nil

        do {
            let fetchedGhosts = try await client.listGhosts()
            ghosts = fetchedGhosts.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        } catch {
            self.error = error.localizedDescription
        }

        isLoading = false
    }
}
