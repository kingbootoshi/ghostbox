import Foundation

struct HistoryMessage: Decodable {
    let role: String
    let text: String
    let toolName: String?
    let timestamp: String?
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

final class GhostboxClient {
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

    func getHistory(ghostName: String) async throws -> [HistoryMessage] {
        let request = makeRequest(path: ["api", "ghosts", ghostName, "history"])
        let response = try await decodeResponse(for: request, as: HistoryResponse.self)
        return response.messages
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
        model: String? = nil
    ) -> AsyncThrowingStream<GhostMessage, Error> {
        struct SendMessageRequest: Encodable {
            let prompt: String
            let model: String?
        }

        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let body = try encoder.encode(SendMessageRequest(prompt: prompt, model: model))
                    var request = makeRequest(
                        path: ["api", "ghosts", ghostName, "message"],
                        method: "POST",
                        body: body
                    )
                    request.setValue("text/event-stream", forHTTPHeaderField: "Accept")

                    let (bytes, response) = try await session.bytes(for: request)
                    try validate(response: response)
                    print("[GhostboxClient] SSE connected for ghost \(ghostName).")

                    var iterator = bytes.makeAsyncIterator()
                    var lineBuffer = Data()
                    var currentEvent: String?
                    var dataLines: [String] = []

                    while let byte = try await iterator.next() {
                        if Task.isCancelled {
                            print("[GhostboxClient] SSE cancelled for ghost \(ghostName).")
                            continuation.finish()
                            return
                        }

                        if byte == 0x0A {
                            let line = decodeSSELine(from: lineBuffer)
                            lineBuffer.removeAll(keepingCapacity: true)

                            if try processSSELine(
                                line,
                                currentEvent: &currentEvent,
                                dataLines: &dataLines,
                                continuation: continuation
                            ) {
                                return
                            }
                        } else {
                            lineBuffer.append(byte)
                        }
                    }

                    if !lineBuffer.isEmpty {
                        let line = decodeSSELine(from: lineBuffer)
                        if try processSSELine(
                            line,
                            currentEvent: &currentEvent,
                            dataLines: &dataLines,
                            continuation: continuation
                        ) {
                            return
                        }
                    }

                    if try handleSSEEvent(name: currentEvent, dataLines: dataLines, continuation: continuation) {
                        return
                    }

                    print("[GhostboxClient] SSE finished for ghost \(ghostName).")
                    continuation.finish()
                } catch is CancellationError {
                    print("[GhostboxClient] SSE task cancelled for ghost \(ghostName).")
                    continuation.finish()
                } catch {
                    print("[GhostboxClient] SSE failed for ghost \(ghostName): \(error.localizedDescription)")
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

    private func processSSELine(
        _ line: String,
        currentEvent: inout String?,
        dataLines: inout [String],
        continuation: AsyncThrowingStream<GhostMessage, Error>.Continuation
    ) throws -> Bool {
        print("[GhostboxClient] SSE line: \(line.isEmpty ? "<blank>" : line)")

        if line.isEmpty {
            if try handleSSEEvent(
                name: currentEvent,
                dataLines: dataLines,
                continuation: continuation
            ) {
                return true
            }

            currentEvent = nil
            dataLines.removeAll(keepingCapacity: true)
            return false
        }

        if line.hasPrefix(":") {
            return false
        }

        if let eventName = sseValue(for: "event:", in: line) {
            currentEvent = eventName.trimmingCharacters(in: .whitespacesAndNewlines)
            print("[GhostboxClient] SSE event name: \(currentEvent ?? "<none>")")
        } else if let data = sseValue(for: "data:", in: line) {
            dataLines.append(data)
            print("[GhostboxClient] SSE data: \(data)")
        }

        return false
    }

    private func handleSSEEvent(
        name: String?,
        dataLines: [String],
        continuation: AsyncThrowingStream<GhostMessage, Error>.Continuation
    ) throws -> Bool {
        let eventName = name ?? "message"
        print("[GhostboxClient] Handling SSE event '\(eventName)' with \(dataLines.count) data line(s).")

        if eventName == "done" {
            continuation.finish()
            return true
        }

        if eventName == "error" {
            let payload = dataLines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            let errorMessage = sseErrorMessage(from: payload)
            continuation.finish(throwing: GhostboxClientError.requestFailed(statusCode: 0, message: errorMessage))
            return true
        }

        guard eventName == "message" else {
            return false
        }

        let payload = dataLines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !payload.isEmpty else {
            return false
        }

        do {
            let message = try decoder.decode(GhostMessage.self, from: Data(payload.utf8))
            print("[GhostboxClient] Decoded ghost message of type '\(message.type.rawValue)'.")
            continuation.yield(message)
            return false
        } catch {
            throw GhostboxClientError.decodingFailed(error)
        }
    }

    private func decodeSSELine(from data: Data) -> String {
        var lineData = data
        if lineData.last == 0x0D {
            lineData.removeLast()
        }
        return String(decoding: lineData, as: UTF8.self)
    }

    private func sseValue(for prefix: String, in line: String) -> String? {
        guard line.hasPrefix(prefix) else { return nil }

        var value = String(line.dropFirst(prefix.count))
        if value.first == " " {
            value.removeFirst()
        }
        return value
    }

    private func sseErrorMessage(from payload: String) -> String {
        guard !payload.isEmpty else {
            return "Ghost connection failed"
        }

        struct ErrorPayload: Decodable {
            let error: String
        }

        if let data = payload.data(using: .utf8),
           let decoded = try? decoder.decode(ErrorPayload.self, from: data),
           !decoded.error.isEmpty {
            return decoded.error
        }

        return payload
    }
}

private struct HistoryResponse: Decodable {
    let messages: [HistoryMessage]
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
