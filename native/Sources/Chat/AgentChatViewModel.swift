import Foundation

@MainActor
final class AgentChatViewModel: ObservableObject {
    let ghostName: String

    @Published var messages: [ChatMessage] = []
    @Published var inputText = ""
    @Published var isStreaming = false
    @Published private(set) var isLoadingHistory = false
    @Published private(set) var isCompacting = false
    @Published private(set) var ghost: Ghost?
    @Published private(set) var error: String?

    private let client: GhostboxClient
    private var streamTask: Task<Void, Never>?
    private static let timestampFormatterWithFractionalSeconds: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let timestampFormatter: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    init(ghostName: String, client: GhostboxClient) {
        self.ghostName = ghostName
        self.client = client

        Task { [weak self] in
            await self?.loadInitialState()
        }
    }

    deinit {
        streamTask?.cancel()
    }

    var ghostboxClient: GhostboxClient {
        client
    }

    func send() {
        let prompt = inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty, !isStreaming, !isLoadingHistory, !isCompacting else { return }

        streamTask?.cancel()
        messages.append(ChatMessage(role: .user, content: prompt))
        inputText = ""
        isStreaming = true
        error = nil

        let ghostName = self.ghostName

        streamTask = Task { [weak self] in
            await self?.consumeStream(prompt: prompt, ghostName: ghostName)
        }
    }

    func cancelStream() {
        streamTask?.cancel()
        streamTask = nil
        isStreaming = false
    }

    func compact() {
        guard !isStreaming, !isLoadingHistory, !isCompacting else { return }

        isCompacting = true
        error = nil

        Task { [weak self] in
            guard let self else { return }

            defer {
                self.isCompacting = false
            }

            do {
                try await client.compactGhost(name: ghostName)
                await loadHistory()
            } catch {
                self.error = error.localizedDescription
                self.messages.append(
                    ChatMessage(role: .system, content: "Error: \(error.localizedDescription)")
                )
            }
        }
    }

    private func consumeStream(prompt: String, ghostName: String) async {
        var currentAssistantText = ""
        var currentAssistantIndex: Int?

        defer {
            isStreaming = false
        }

        do {
            let stream = client.sendMessage(ghostName: ghostName, prompt: prompt, model: nil)

            for try await event in stream {
                if Task.isCancelled {
                    return
                }

                switch event.type {
                case .assistant:
                    let chunk = event.text ?? ""
                    guard !chunk.isEmpty else { continue }

                    currentAssistantText += chunk

                    if let index = currentAssistantIndex, messages.indices.contains(index) {
                        messages[index] = ChatMessage(role: .ghost, content: currentAssistantText)
                    } else {
                        messages.append(ChatMessage(role: .ghost, content: currentAssistantText))
                        currentAssistantIndex = messages.count - 1
                    }

                case .tool_use:
                    let toolName = event.tool ?? "Tool"
                    let content = event.input?.stringValue ?? "Running \(toolName)"
                    messages.append(ChatMessage(role: .toolUse, content: content, toolName: toolName))
                    currentAssistantText = ""
                    currentAssistantIndex = nil

                case .tool_result:
                    let content = event.output?.stringValue ?? "Tool finished."
                    messages.append(ChatMessage(role: .toolResult, content: content, toolName: "Result"))
                    currentAssistantText = ""
                    currentAssistantIndex = nil

                case .result:
                    if let text = event.text, !text.isEmpty, currentAssistantText.isEmpty {
                        messages.append(ChatMessage(role: .ghost, content: text))
                    }
                }
            }
        } catch is CancellationError {
            return
        } catch {
            self.error = error.localizedDescription
            messages.append(
                ChatMessage(role: .system, content: "Error: \(error.localizedDescription)")
            )
            return
        }

        await loadGhost()
    }

    private func loadInitialState() async {
        await loadHistory()
        await loadGhost()
    }

    private func loadHistory() async {
        isLoadingHistory = true
        error = nil

        defer {
            isLoadingHistory = false
        }

        do {
            let history = try await client.getHistory(ghostName: ghostName)
            messages = history.map { message in
                ChatMessage(
                    role: mapRole(message.role),
                    content: message.text,
                    timestamp: parseTimestamp(message.timestamp),
                    toolName: message.toolName
                )
            }
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func loadGhost() async {
        do {
            ghost = try await client.getGhost(name: ghostName)
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func mapRole(_ role: String) -> ChatMessage.Role {
        switch role {
        case "user":
            return .user
        case "assistant":
            return .ghost
        case "tool_use":
            return .toolUse
        case "tool_result":
            return .toolResult
        case "system":
            return .system
        default:
            return .system
        }
    }

    private func parseTimestamp(_ value: String?) -> Date {
        guard let value, !value.isEmpty else {
            return Date()
        }

        if let date = Self.timestampFormatterWithFractionalSeconds.date(from: value) {
            return date
        }

        if let date = Self.timestampFormatter.date(from: value) {
            return date
        }

        return Date()
    }
}
