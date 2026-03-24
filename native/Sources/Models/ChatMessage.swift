import Foundation

struct ChatMessage: Identifiable {
    let id: UUID
    let role: Role
    let content: String
    let timestamp: Date
    let toolName: String?

    enum Role {
        case user
        case ghost
        case system
        case toolUse
        case toolResult
    }

    init(
        id: UUID = UUID(),
        role: Role,
        content: String,
        timestamp: Date = Date(),
        toolName: String? = nil
    ) {
        self.id = id
        self.role = role
        self.content = content
        self.timestamp = timestamp
        self.toolName = toolName
    }
}

extension ChatMessage {
    var isToolMessage: Bool {
        role == .toolUse || role == .toolResult
    }

    var resolvedToolName: String {
        if let toolName = sanitizedToolName {
            return toolName
        }

        switch normalizedToolKind {
        case "bash":
            return "Bash"
        case "read":
            return "Read"
        case "write":
            return "Write"
        default:
            return "Tool"
        }
    }

    var normalizedToolKind: String {
        let rawName = (sanitizedToolName ?? inferredToolName ?? "").lowercased()

        if rawName.contains("bash") || rawName.contains("shell") || rawName.contains("terminal") {
            return "bash"
        }

        if rawName.contains("read") || rawName.contains("cat") || rawName.contains("view") {
            return "read"
        }

        if rawName.contains("write") || rawName.contains("edit") || rawName.contains("patch") {
            return "write"
        }

        return rawName.isEmpty ? "tool" : rawName
    }

    var toolPrimarySubject: String? {
        if let path = structuredValue(forKeys: [
            "path",
            "file_path",
            "filepath",
            "filePath",
            "target_path",
            "targetPath",
            "absolute_path",
            "absolutePath",
        ]) {
            return Self.compactWhitespace(path)
        }

        if normalizedToolKind == "bash",
           let command = structuredValue(forKeys: ["command", "cmd"]) {
            return Self.compactWhitespace(command)
        }

        if let value = structuredValue(forKeys: ["url", "uri", "query", "prompt", "pattern"]) {
            return Self.compactWhitespace(value)
        }

        return nil
    }

    var toolInputPreview: String {
        toolPrimarySubject ?? singleLineContent
    }

    var toolOutputPreview: String {
        if let value = structuredValue(forKeys: [
            "summary",
            "message",
            "result",
            "output",
            "stdout",
            "stderr",
            "text",
        ]) {
            return Self.compactWhitespace(value)
        }

        return singleLineContent
    }

    var singleLineContent: String {
        Self.compactWhitespace(content)
    }

    var contentSizeSummary: String {
        ByteCountFormatter.string(fromByteCount: Int64(content.utf8.count), countStyle: .file)
    }

    private var sanitizedToolName: String? {
        guard let toolName else { return nil }

        let trimmed = toolName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.caseInsensitiveCompare("result") != .orderedSame else {
            return nil
        }

        return trimmed
    }

    private var inferredToolName: String? {
        structuredValue(forKeys: ["tool", "tool_name", "toolName", "name"])
    }

    private func structuredValue(forKeys keys: [String]) -> String? {
        guard let jsonObject = parsedJSONObject else { return nil }
        return Self.findValue(in: jsonObject, keys: Set(keys.map { $0.lowercased() }))
    }

    private var parsedJSONObject: Any? {
        guard let data = content.data(using: .utf8) else { return nil }
        return try? JSONSerialization.jsonObject(with: data)
    }

    private static func findValue(in object: Any, keys: Set<String>) -> String? {
        switch object {
        case let dictionary as [String: Any]:
            for (key, value) in dictionary {
                if keys.contains(key.lowercased()), let value = stringValue(value) {
                    return value
                }
            }

            for value in dictionary.values {
                if let nestedValue = findValue(in: value, keys: keys) {
                    return nestedValue
                }
            }

        case let array as [Any]:
            for value in array {
                if let nestedValue = findValue(in: value, keys: keys) {
                    return nestedValue
                }
            }

        default:
            break
        }

        return nil
    }

    private static func stringValue(_ value: Any) -> String? {
        switch value {
        case let string as String:
            return string
        case let number as NSNumber:
            return number.stringValue
        default:
            return nil
        }
    }

    private static func compactWhitespace(_ text: String) -> String {
        text
            .replacingOccurrences(of: "\r\n", with: "\n")
            .components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }
}
