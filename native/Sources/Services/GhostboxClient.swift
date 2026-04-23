import Foundation
import os

struct HistoryImageData: Decodable {
    let mediaType: String
    let data: String
}

struct HistoryMessage: Decodable {
    let role: String
    let text: String
    let toolName: String?
    let timestamp: String?
    let attachmentCount: Int?
    let images: [HistoryImageData]?
}

struct CompactionInfo: Decodable {
    let timestamp: String
    let summary: String
    let tokensBefore: Int
}

struct HistoryPageData {
    let messages: [HistoryMessage]
    let totalCount: Int
    let nextBefore: Int?
    let preCompactionCount: Int
    let postCompactionCount: Int
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

struct SessionInfo: Decodable, Identifiable, Hashable {
    let id: String
    let name: String?
    let path: String?
    let messageCount: Int?
    let createdAt: String
    let lastActiveAt: String
}

struct SessionListResponse: Decodable {
    let current: String
    let sessions: [SessionInfo]
}

struct GhostboxMessageImage: Encodable {
    let mediaType: String
    let data: String
}

struct SteerResponse: Decodable {
    let status: String
    let pendingCount: Int
}

struct QueueStatus: Decodable {
    let steering: [String]
    let followUp: [String]
    let pendingCount: Int
}

struct ClearQueueResponse: Decodable {
    let cleared: ClearedQueues

    struct ClearedQueues: Decodable {
        let steering: [String]
        let followUp: [String]
    }
}

private struct GhostboxRealtimeEnvelope: Decodable {
    let id: String
    let at: String
    let type: String
    let ghosts: [String: Ghost]?
    let ghostName: String?
    let ghost: Ghost?
    let sessionId: String?
    let preview: String?
}

enum GhostboxRealtimeEvent {
    case snapshot(id: String, ghosts: [Ghost])
    case ghostUpsert(id: String, ghost: Ghost)
    case ghostRemove(id: String, ghostName: String)
    case messageCompleted(id: String, ghostName: String, sessionId: String, preview: String)

    var id: String {
        switch self {
        case .snapshot(let id, _),
             .ghostUpsert(let id, _),
             .ghostRemove(let id, _),
             .messageCompleted(let id, _, _, _):
            return id
        }
    }
}

final class GhostboxClient {
    private static let logger = Logger(subsystem: "com.ghostbox.app", category: "network")

    private static let defaultURL = URL(string: "http://localhost:8008")!

    let baseURL: URL
    let token: String?
    private let session: URLSession
    // Dedicated session for SSE streams: no inter-packet timeout so long tool
    // calls (file reads, complex work) don't kill the connection mid-stream.
    // timeoutIntervalForResource is left at its default (7 days) which is fine
    // since the stream ends naturally when the agent finishes.
    private let sseSession: URLSession
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    var isRemote: Bool {
        baseURL.host != "localhost" && baseURL.host != "127.0.0.1"
    }

    init(baseURL: URL? = nil, token: String? = nil, session: URLSession? = nil) {
        self.baseURL = baseURL ?? Self.defaultURL
        self.token = token

        if let session {
            self.session = session
            self.sseSession = session
        } else {
            let configuration = URLSessionConfiguration.default
            configuration.timeoutIntervalForRequest = 60
            configuration.timeoutIntervalForResource = 300
            self.session = URLSession(configuration: configuration)

            let sseConfiguration = URLSessionConfiguration.default
            // 0 means no timeout waiting for the next packet - required for
            // SSE streams where the agent may be silent for minutes during
            // tool calls or large file reads before the next event arrives.
            sseConfiguration.timeoutIntervalForRequest = 0
            sseConfiguration.shouldUseExtendedBackgroundIdleMode = true
            self.sseSession = URLSession(configuration: sseConfiguration)
        }
    }

    static func fromConnectionConfig() -> GhostboxClient {
        let config = ConnectionConfigStore.load()
        let url = config.flatMap { URL(string: $0.url) }
        return GhostboxClient(baseURL: url, token: config?.token)
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

    func updateGhost(name: String, provider: String, model: String) async throws -> Ghost {
        struct UpdateGhostRequest: Encodable {
            let provider: String
            let model: String
        }

        let body = try encoder.encode(UpdateGhostRequest(provider: provider, model: model))
        let request = makeRequest(path: ["api", "ghosts", name], method: "PATCH", body: body)
        let ghost = try await decodeResponse(for: request, as: Ghost.self)
        return Ghost(name: name, status: ghost.status, provider: ghost.provider, model: ghost.model, portBase: ghost.portBase, containerId: ghost.containerId, createdAt: ghost.createdAt, systemPrompt: ghost.systemPrompt)
    }

    func getHistoryPage(
        ghostName: String,
        segment: String = "post",
        limit: Int,
        before: Int? = nil
    ) async throws -> HistoryPageData {
        var queryItems = [
            URLQueryItem(name: "segment", value: segment),
            URLQueryItem(name: "limit", value: String(limit))
        ]

        if let before {
            queryItems.append(URLQueryItem(name: "before", value: String(before)))
        }

        let request = makeRequest(
            path: ["api", "ghosts", ghostName, "history"],
            queryItems: queryItems
        )
        let response = try await decodeResponse(for: request, as: HistoryPageResponse.self)
        return HistoryPageData(
            messages: response.messages,
            totalCount: response.totalCount,
            nextBefore: response.nextBefore,
            preCompactionCount: response.preCompactionCount,
            postCompactionCount: response.postCompactionCount,
            compactions: response.compactions ?? []
        )
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

    func killBackgroundTask(ghostName: String, taskId: String) async throws {
        let request = makeRequest(
            path: ["api", "ghosts", ghostName, "tasks", taskId, "kill"],
            method: "POST",
            body: Data("{}".utf8)
        )
        _ = try await perform(request)
    }

    func newGhostSession(name: String) async throws -> String {
        let request = makeRequest(
            path: ["api", "ghosts", name, "new"],
            method: "POST",
            body: Data("{}".utf8)
        )
        let response = try await decodeResponse(for: request, as: NewGhostSessionResponse.self)
        return response.sessionId
    }

    func fetchSessions(name: String) async throws -> SessionListResponse {
        let request = makeRequest(path: ["api", "ghosts", name, "sessions"])
        return try await decodeResponse(for: request, as: SessionListResponse.self)
    }

    func switchSession(name: String, sessionId: String) async throws {
        struct SwitchSessionRequest: Encodable {
            let sessionId: String
        }

        let body = try encoder.encode(SwitchSessionRequest(sessionId: sessionId))
        let request = makeRequest(
            path: ["api", "ghosts", name, "sessions", "switch"],
            method: "POST",
            body: body
        )
        _ = try await decodeResponse(for: request, as: SwitchSessionResponse.self)
    }

    func renameSession(name: String, sessionId: String, sessionName: String) async throws {
        struct RenameRequest: Encodable {
            let sessionId: String
            let name: String
        }
        struct RenameResponse: Decodable {
            let status: String
        }

        let body = try encoder.encode(RenameRequest(sessionId: sessionId, name: sessionName))
        let request = makeRequest(
            path: ["api", "ghosts", name, "sessions", "rename"],
            method: "POST",
            body: body
        )
        _ = try await decodeResponse(for: request, as: RenameResponse.self)
    }

    func deleteSession(name: String, sessionId: String) async throws {
        struct DeleteResponse: Decodable {
            let status: String
        }

        let request = makeRequest(
            path: ["api", "ghosts", name, "sessions", sessionId],
            method: "DELETE"
        )
        _ = try await decodeResponse(for: request, as: DeleteResponse.self)
    }

    func steerGhost(
        name: String,
        prompt: String,
        images: [GhostboxMessageImage]? = nil
    ) async throws -> SteerResponse {
        struct SteerRequest: Encodable {
            let prompt: String
            let images: [GhostboxMessageImage]?
        }

        let body = try encoder.encode(SteerRequest(prompt: prompt, images: images))
        let request = makeRequest(
            path: ["api", "ghosts", name, "steer"],
            method: "POST",
            body: body
        )
        return try await decodeResponse(for: request, as: SteerResponse.self)
    }

    func getGhostQueue(name: String) async throws -> QueueStatus {
        let request = makeRequest(path: ["api", "ghosts", name, "queue"])
        return try await decodeResponse(for: request, as: QueueStatus.self)
    }

    func clearGhostQueue(name: String) async throws -> ClearQueueResponse {
        let request = makeRequest(
            path: ["api", "ghosts", name, "clear-queue"],
            method: "POST",
            body: Data("{}".utf8)
        )
        return try await decodeResponse(for: request, as: ClearQueueResponse.self)
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
        images: [GhostboxMessageImage]? = nil,
        streamingBehavior: String? = nil
    ) -> AsyncThrowingStream<GhostMessage, Error> {
        struct SendMessageRequest: Encodable {
            let prompt: String
            let model: String?
            let images: [GhostboxMessageImage]?
            let streamingBehavior: String?
        }

        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let body = try encoder.encode(
                        SendMessageRequest(
                            prompt: prompt,
                            model: model,
                            images: images,
                            streamingBehavior: streamingBehavior
                        )
                    )
                    var request = makeRequest(
                        path: ["api", "ghosts", ghostName, "message"],
                        method: "POST",
                        body: body
                    )
                    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")

                    let (bytes, response) = try await sseSession.bytes(for: request)
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

    func streamEvents(lastEventId: String? = nil) -> AsyncThrowingStream<GhostboxRealtimeEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var request = makeRequest(path: ["api", "events"])
                    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    if let lastEventId, !lastEventId.isEmpty {
                        request.setValue(lastEventId, forHTTPHeaderField: "Last-Event-ID")
                    }

                    let (bytes, response) = try await sseSession.bytes(for: request)
                    try validate(response: response)
                    Self.logger.info("Realtime SSE connected.")

                    let parser = SSEStreamParser(decoder: decoder)
                    for try await event in parser.parseRaw(bytes: bytes, ghostName: "app") {
                        if Task.isCancelled {
                            continuation.finish()
                            return
                        }

                        switch event.name {
                        case "heartbeat":
                            continue
                        case "error":
                            throw GhostboxClientError.requestFailed(statusCode: 0, message: event.data)
                        default:
                            if let decodedEvent = try decodeRealtimeEvent(from: event.data) {
                                continuation.yield(decodedEvent)
                            }
                        }
                    }

                    continuation.finish()
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    Self.logger.error("Realtime SSE failed: \(error.localizedDescription, privacy: .public)")
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
            let request = makeRequest(path: ["api", "health"])
            let (data, _) = try await perform(request)
            struct HealthResponse: Decodable { let status: String }
            let response = try decoder.decode(HealthResponse.self, from: data)
            return response.status == "ok"
        } catch {
            Self.logger.error("Health check failed: \(error.localizedDescription, privacy: .public)")
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
        if let token {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
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

    private func decodeRealtimeEvent(from payload: String) throws -> GhostboxRealtimeEvent? {
        let envelope = try decoder.decode(GhostboxRealtimeEnvelope.self, from: Data(payload.utf8))

        switch envelope.type {
        case "snapshot":
            let ghosts = (envelope.ghosts ?? [:]).map { name, ghost in
                Ghost(
                    name: name,
                    status: ghost.status,
                    provider: ghost.provider,
                    model: ghost.model,
                    portBase: ghost.portBase,
                    containerId: ghost.containerId,
                    createdAt: ghost.createdAt,
                    systemPrompt: ghost.systemPrompt
                )
            }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            return .snapshot(id: envelope.id, ghosts: ghosts)
        case "ghost.upsert":
            guard let ghostName = envelope.ghostName, let ghost = envelope.ghost else {
                return nil
            }
            let resolvedGhost = Ghost(
                name: ghostName,
                status: ghost.status,
                provider: ghost.provider,
                model: ghost.model,
                portBase: ghost.portBase,
                containerId: ghost.containerId,
                createdAt: ghost.createdAt,
                systemPrompt: ghost.systemPrompt
            )
            return .ghostUpsert(id: envelope.id, ghost: resolvedGhost)
        case "ghost.remove":
            guard let ghostName = envelope.ghostName else {
                return nil
            }
            return .ghostRemove(id: envelope.id, ghostName: ghostName)
        case "message.completed":
            guard let ghostName = envelope.ghostName,
                  let sessionId = envelope.sessionId else {
                return nil
            }
            return .messageCompleted(
                id: envelope.id,
                ghostName: ghostName,
                sessionId: sessionId,
                preview: envelope.preview ?? ""
            )
        default:
            return nil
        }
    }
}

private struct HistoryPageResponse: Decodable {
    let segment: String?
    let messages: [HistoryMessage]
    let totalCount: Int
    let nextBefore: Int?
    let preCompactionCount: Int
    let postCompactionCount: Int
    let compactions: [CompactionInfo]?
}

private struct NewGhostSessionResponse: Decodable {
    let status: String
    let sessionId: String
}

private struct SwitchSessionResponse: Decodable {
    let status: String
    let sessionId: String
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
