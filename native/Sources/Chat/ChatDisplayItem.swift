import Foundation

struct CompactionMarker: Identifiable, Hashable {
    let id: String
    let summary: String?
    let timestamp: Date
    let tokensBefore: Int
}

enum ConversationTimelineItem: Identifiable {
    case message(ChatMessage)
    case compaction(CompactionMarker)

    var id: String {
        switch self {
        case .message(let message):
            return "message-\(message.id.uuidString)"
        case .compaction(let marker):
            return marker.id
        }
    }
}

enum ChatDisplayItem: Identifiable {
    case message(ChatMessage, showsBreakAfter: Bool)
    case toolGroup(ToolCallGroup, showsBreakAfter: Bool)
    case compaction(CompactionMarker, showsBreakAfter: Bool)

    var id: String {
        switch self {
        case .message(let message, _):
            return "message-\(message.id.uuidString)"
        case .toolGroup(let group, _):
            return "tool-\(group.id.uuidString)"
        case .compaction(let marker, _):
            return marker.id
        }
    }

    var showsBreakAfter: Bool {
        switch self {
        case .message(_, let showsBreakAfter):
            return showsBreakAfter
        case .toolGroup(_, let showsBreakAfter):
            return showsBreakAfter
        case .compaction(_, let showsBreakAfter):
            return showsBreakAfter
        }
    }

    static func build(from timelineItems: [ConversationTimelineItem]) -> [ChatDisplayItem] {
        var items: [ChatDisplayItem] = []
        var pendingMessages: [ChatMessage] = []

        func flushPendingMessages() {
            guard !pendingMessages.isEmpty else { return }
            items.append(contentsOf: buildMessageItems(from: pendingMessages))
            pendingMessages.removeAll(keepingCapacity: true)
        }

        for timelineItem in timelineItems {
            switch timelineItem {
            case .message(let message):
                pendingMessages.append(message)
            case .compaction(let marker):
                flushPendingMessages()
                items.append(.compaction(marker, showsBreakAfter: false))
            }
        }

        flushPendingMessages()

        return items.enumerated().map { index, item in
            let showsBreakAfter: Bool
            if index < items.count - 1 {
                showsBreakAfter = needsBreak(after: item, before: items[index + 1])
            } else {
                showsBreakAfter = false
            }

            return item.with(showsBreakAfter: showsBreakAfter)
        }
    }

    static func patch(existing: [ChatDisplayItem], from timelineItems: [ConversationTimelineItem]) -> [ChatDisplayItem] {
        let messagesByID: [UUID: ChatMessage] = Dictionary(
            uniqueKeysWithValues: timelineItems.compactMap { item in
                guard case .message(let message) = item else { return nil }
                return (message.id, message)
            }
        )

        return existing.map { item in
            switch item {
            case .message(let message, let showsBreakAfter):
                let updatedMessage = messagesByID[message.id] ?? message
                return .message(updatedMessage, showsBreakAfter: showsBreakAfter)

            case .toolGroup(let group, let showsBreakAfter):
                let updatedToolUse = messagesByID[group.toolUse.id] ?? group.toolUse
                let updatedToolResult = group.toolResult.flatMap { messagesByID[$0.id] } ?? group.toolResult
                return .toolGroup(
                    ToolCallGroup(toolUse: updatedToolUse, toolResult: updatedToolResult),
                    showsBreakAfter: showsBreakAfter
                )

            case .compaction(let marker, let showsBreakAfter):
                return .compaction(marker, showsBreakAfter: showsBreakAfter)
            }
        }
    }

    private static func buildMessageItems(from messages: [ChatMessage]) -> [ChatDisplayItem] {
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
                    items.append(.toolGroup(ToolCallGroup(toolUse: toolUse, toolResult: toolResult), showsBreakAfter: false))
                }

                index = next
            } else if message.role == .toolResult {
                index += 1
            } else {
                items.append(.message(message, showsBreakAfter: false))
                index += 1
            }
        }

        return items
    }

    private static func needsBreak(after current: ChatDisplayItem, before next: ChatDisplayItem) -> Bool {
        current.isUserMessage != next.isUserMessage
    }

    private var isUserMessage: Bool {
        switch self {
        case .message(let message, _):
            return message.role == .user
        case .toolGroup(_, _):
            return false
        case .compaction(_, _):
            return false
        }
    }

    private func with(showsBreakAfter: Bool) -> ChatDisplayItem {
        switch self {
        case .message(let message, _):
            return .message(message, showsBreakAfter: showsBreakAfter)
        case .toolGroup(let group, _):
            return .toolGroup(group, showsBreakAfter: showsBreakAfter)
        case .compaction(let marker, _):
            return .compaction(marker, showsBreakAfter: showsBreakAfter)
        }
    }
}

struct ToolCallGroup: Identifiable {
    let toolUse: ChatMessage
    let toolResult: ChatMessage?

    var id: UUID { toolUse.id }

    var isRunning: Bool {
        toolResult == nil
    }

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
            let runningPreview = inputPreview.isEmpty ? "Running..." : "\(inputPreview) - Running..."
            return truncated(runningPreview, limit: 80)
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
