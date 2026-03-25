import Foundation
import os

struct HistoryMessage: Decodable {
    let role: String
    let text: String
    let toolName: String?
    let timestamp: String?
}

struct CompactionInfo: Decodable {
    let timestamp: String
    let summary: String
    let tokensBefore: Int
}

struct HistoryData {
    let messages: [HistoryMessage]
    let preCompactionMessages: [HistoryMessage]
    let compactions: [CompactionInfo]
}

struct VaultEntry: Decodable, Identifiable {
    let name: String
    let path: String
    let type: String
    let size: Int?
    let modified: String?

    var id: String { path }
    var isDirectory: Bool { type == "directory" }
}

struct VaultFile: Decodable {
    let path: String
    let content: String
    let size: Int
}

struct GhostSlashCommand: Decodable, Identifiable, Hashable {
    let name: String
    let description: String

    var id: String { name }
}

struct GhostboxConfigSensitiveStatus: Decodable {
    let githubToken: Bool
    let telegramToken: Bool
}

struct GhostboxConfig: Decodable {
    let githubRemote: String?
    let githubToken: String
    let telegramToken: String
    let defaultModel: String
    let defaultProvider: String
    let imageName: String
    let hasSensitive: GhostboxConfigSensitiveStatus
}

struct GhostStats: Decodable {
    let sessionId: String
    let model: String
    let tokens: GhostStatsTokens
    let cost: Double
    let messageCount: Int
    let context: GhostStatsContext?
}

struct GhostStatsTokens: Decodable {
    let input: Int?
    let output: Int?
    let cacheRead: Int?
    let cacheWrite: Int?
    let total: Int?
}

struct GhostStatsContext: Decodable {
    let used: Int
    let window: Int
    let percent: Double
}

struct GhostboxMessageImage: Encodable {
    let mediaType: String
    let data: String
}

final class GhostboxClient {
    private static let logger = Logger(subsystem: "com.ghostbox.app", category: "network")

    private let baseURL: URL
    private let session: URLSession
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    init(baseURL: URL = URL(string: "http://localhost:3200")!, session: URLSession? = nil) {
        self.baseURL = baseURL

        if let session {
            self.session = session
        } else {
            let configuration = URLSessionConfiguration.default
            configuration.timeoutIntervalForRequest = 60
            configuration.timeoutIntervalForResource = 300
            self.session = URLSession(configuration: configuration)
        }
    }

    func listGhosts() async throws -> [Ghost] {
        let request = makeRequest(path: ["api", "ghosts"])
        let dict = try await decodeResponse(for: request, as: [String: Ghost].self)
        return dict.map { name, ghost in
            Ghost(name: name, status: ghost.status, provider: ghost.provider, model: ghost.model, portBase: ghost.portBase, containerId: ghost.containerId, createdAt: ghost.createdAt, systemPrompt: ghost.systemPrompt)
        }
    }

    func getGhost(name: String) async throws -> Ghost {
        let request = makeRequest(path: ["api", "ghosts", name])
        let ghost = try await decodeResponse(for: request, as: Ghost.self)
        return Ghost(name: name, status: ghost.status, provider: ghost.provider, model: ghost.model, portBase: ghost.portBase, containerId: ghost.containerId, createdAt: ghost.createdAt, systemPrompt: ghost.systemPrompt)
    }

    func spawnGhost(
        name: String,
        provider: String,
        model: String,
        systemPrompt: String?
    ) async throws -> Ghost {
        struct SpawnRequest: Encodable {
            let name: String
            let provider: String
            let model: String
            let systemPrompt: String?
        }

        let body = try encoder.encode(SpawnRequest(
            name: name,
            provider: provider,
            model: model,
            systemPrompt: systemPrompt
        ))

        let request = makeRequest(path: ["api", "ghosts"], method: "POST", body: body)
        let ghost = try await decodeResponse(for: request, as: Ghost.self)
        return Ghost(name: name, status: ghost.status, provider: ghost.provider, model: ghost.model, portBase: ghost.portBase, containerId: ghost.containerId, createdAt: ghost.createdAt, systemPrompt: ghost.systemPrompt)
    }

    func killGhost(name: String) async throws {
        let request = makeRequest(path: ["api", "ghosts", name, "kill"], method: "POST", body: Data("{}".utf8))
        _ = try await perform(request)
    }

    func wakeGhost(name: String) async throws {
        let request = makeRequest(path: ["api", "ghosts", name, "wake"], method: "POST", body: Data("{}".utf8))
        _ = try await perform(request)
    }

    func removeGhost(name: String) async throws {
        let request = makeRequest(path: ["api", "ghosts", name], method: "DELETE")
        _ = try await perform(request)
    }

    func getHistory(ghostName: String) async throws -> HistoryData {
        let request = makeRequest(path: ["api", "ghosts", ghostName, "history"])
        let response = try await decodeResponse(for: request, as: HistoryResponse.self)
        return HistoryData(
            messages: response.messages,
            preCompactionMessages: response.preCompactionMessages ?? [],
            compactions: response.compactions ?? []
        )
    }

    func compactGhost(name: String) async throws {
        let request = makeRequest(
            path: ["api", "ghosts", name, "compact"],
            method: "POST",
            body: Data("{}".utf8)
        )
        _ = try await decodeResponse(for: request, as: CompactResponse.self)
    }

    func listVault(ghostName: String, path: String) async throws -> [VaultEntry] {
        let request = makeRequest(
            path: ["api", "ghosts", ghostName, "vault"],
            queryItems: [URLQueryItem(name: "path", value: path)]
        )
        let response = try await decodeResponse(for: request, as: VaultEntriesResponse.self)
        return response.entries
    }

    func readVaultFile(ghostName: String, path: String) async throws -> VaultFile {
        let request = makeRequest(
            path: ["api", "ghosts", ghostName, "vault", "read"],
            queryItems: [URLQueryItem(name: "path", value: path)]
        )
        return try await decodeResponse(for: request, as: VaultFile.self)
    }

    func writeVaultFile(ghostName: String, path: String, content: String) async throws {
        let body = try encoder.encode(VaultWriteRequest(path: path, content: content))
        let request = makeRequest(
            path: ["api", "ghosts", ghostName, "vault", "write"],
            method: "PUT",
            body: body
        )
        _ = try await decodeResponse(for: request, as: VaultWriteResponse.self)
    }

    func abortGhost(name: String) async throws {
        let request = makeRequest(
            path: ["api", "ghosts", name, "abort"],
            method: "POST",
            body: Data("{}".utf8)
        )
        _ = try await perform(request)
    }

    func newGhostSession(name: String) async throws {
        let request = makeRequest(
            path: ["api", "ghosts", name, "new"],
            method: "POST",
            body: Data("{}".utf8)
        )
        _ = try await perform(request)
    }

    func fetchStats(ghostName: String) async throws -> GhostStats {
        let request = makeRequest(path: ["api", "ghosts", ghostName, "stats"])
        return try await decodeResponse(for: request, as: GhostStats.self)
    }

    func fetchCommands(ghostName: String) async throws -> [GhostSlashCommand] {
        let request = makeRequest(path: ["api", "ghosts", ghostName, "commands"])
        return try await decodeResponse(for: request, as: [GhostSlashCommand].self)
    }

    func fetchConfig() async throws -> GhostboxConfig {
        let request = makeRequest(path: ["api", "config"])
        return try await decodeResponse(for: request, as: GhostboxConfig.self)
    }

    func updateConfig(changes: [String: Any]) async throws -> GhostboxConfig {
        guard JSONSerialization.isValidJSONObject(changes) else {
            throw GhostboxClientError.invalidRequestPayload
        }

        let body: Data
        do {
            body = try JSONSerialization.data(withJSONObject: changes, options: [])
        } catch {
            throw GhostboxClientError.encodingFailed(error)
        }

        let request = makeRequest(path: ["api", "config"], method: "PUT", body: body)
        return try await decodeResponse(for: request, as: GhostboxConfig.self)
    }

    func sendMessage(
        ghostName: String,
        prompt: String,
        model: String? = nil,
        images: [GhostboxMessageImage]? = nil
    ) -> AsyncThrowingStream<GhostMessage, Error> {
        struct SendMessageRequest: Encodable {
            let prompt: String
            let model: String?
            let images: [GhostboxMessageImage]?
        }

        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let body = try encoder.encode(
                        SendMessageRequest(
                            prompt: prompt,
                            model: model,
                            images: images
                        )
                    )
                    var request = makeRequest(
                        path: ["api", "ghosts", ghostName, "message"],
                        method: "POST",
                        body: body
                    )
                    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")

                    let (bytes, response) = try await session.bytes(for: request)
                    try validate(response: response)
                    Self.logger.info("SSE connected for ghost \(ghostName, privacy: .public).")

                    let parser = SSEStreamParser(decoder: decoder)
                    for try await event in parser.parse(bytes: bytes, ghostName: ghostName) {
                        if Task.isCancelled {
                            Self.logger.info("SSE cancelled for ghost \(ghostName, privacy: .public).")
                            continuation.finish()
                            return
                        }

                        switch event {
                        case let .message(message):
                            continuation.yield(message)
                        case .done:
                            Self.logger.info("SSE finished for ghost \(ghostName, privacy: .public).")
                            continuation.finish()
                            return
                        }
                    }

                    Self.logger.info("SSE finished for ghost \(ghostName, privacy: .public).")
                    continuation.finish()
                } catch is CancellationError {
                    Self.logger.info("SSE task cancelled for ghost \(ghostName, privacy: .public).")
                    continuation.finish()
                } catch {
                    Self.logger.error("SSE failed for ghost \(ghostName, privacy: .public): \(error.localizedDescription, privacy: .public)")
                    continuation.finish(throwing: error)
                }
            }

            continuation.onTermination = { _ in
                task.cancel()
            }
        }
    }

    func healthCheck() async -> Bool {
        do {
            _ = try await listGhosts()
            return true
        } catch {
            return false
        }
    }

    private func makeRequest(
        path components: [String],
        method: String = "GET",
        body: Data? = nil,
        queryItems: [URLQueryItem]? = nil
    ) -> URLRequest {
        var url = baseURL
        for component in components {
            url.appendPathComponent(component)
        }

        if let queryItems, !queryItems.isEmpty,
           var components = URLComponents(url: url, resolvingAgainstBaseURL: false) {
            components.queryItems = queryItems
            url = components.url ?? url
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        return request
    }

    private func decodeResponse<T: Decodable>(for request: URLRequest, as type: T.Type) async throws -> T {
        let (data, _) = try await perform(request)
        do {
            return try decoder.decode(type, from: data)
        } catch {
            throw GhostboxClientError.decodingFailed(error)
        }
    }

    private func perform(_ request: URLRequest) async throws -> (Data, URLResponse) {
        let (data, response) = try await session.data(for: request)
        try validate(response: response, data: data)
        return (data, response)
    }

    private func validate(response: URLResponse, data: Data? = nil) throws {
        guard let httpResponse = response as? HTTPURLResponse else {
            throw GhostboxClientError.invalidResponse
        }

        guard (200...299).contains(httpResponse.statusCode) else {
            let message = data.flatMap { String(data: $0, encoding: .utf8) }
            throw GhostboxClientError.requestFailed(statusCode: httpResponse.statusCode, message: message)
        }
    }
}

private struct HistoryResponse: Decodable {
    let messages: [HistoryMessage]
    let preCompactionMessages: [HistoryMessage]?
    let compactions: [CompactionInfo]?
}

private struct CompactResponse: Decodable {
    let status: String
}

private struct VaultEntriesResponse: Decodable {
    let entries: [VaultEntry]
}

private struct VaultWriteRequest: Encodable {
    let path: String
    let content: String
}

private struct VaultWriteResponse: Decodable {
    let path: String
    let size: Int
}

enum GhostboxClientError: LocalizedError {
    case invalidResponse
    case invalidRequestPayload
    case requestFailed(statusCode: Int, message: String?)
    case decodingFailed(Error)
    case encodingFailed(Error)

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "Ghostbox returned an invalid response."
        case .invalidRequestPayload:
            return "Ghostbox request could not be prepared."
        case let .requestFailed(statusCode, message):
            if let message, !message.isEmpty {
                return "Ghostbox request failed with status \(statusCode): \(message)"
            }
            return "Ghostbox request failed with status \(statusCode)."
        case let .decodingFailed(error):
            return "Ghostbox returned data that could not be read: \(error.localizedDescription)"
        case let .encodingFailed(error):
            return "Ghostbox request could not be encoded: \(error.localizedDescription)"
        }
    }
}
