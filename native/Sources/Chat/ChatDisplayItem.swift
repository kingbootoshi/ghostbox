import Foundation

enum ChatDisplayItem: Identifiable {
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
                var toolUses: [ChatMessage] = [message]
                var next = index + 1
                while next < messages.count, messages[next].role == .toolUse {
                    toolUses.append(messages[next])
                    next += 1
                }

                var toolResults: [ChatMessage] = []
                while next < messages.count, messages[next].role == .toolResult {
                    toolResults.append(messages[next])
                    next += 1
                }

                for (i, toolUse) in toolUses.enumerated() {
                    let toolResult = i < toolResults.count ? toolResults[i] : nil
                    items.append(.toolGroup(ToolCallGroup(toolUse: toolUse, toolResult: toolResult)))
                }

                index = next
            } else if message.role == .toolResult {
                index += 1
            } else {
                items.append(.message(message))
                index += 1
            }
        }

        return items
    }
}

struct ToolCallGroup: Identifiable {
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
