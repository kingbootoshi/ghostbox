import AppKit
import Foundation

struct ChatMessage: Identifiable {
    let id: UUID
    let role: Role
    let content: String
    let timestamp: Date
    let toolName: String?
    let attachmentCount: Int
    let thumbnails: [NSImage]
    let attributedContent: AttributedString?
    private let cachedResolvedToolName: String
    private let cachedNormalizedToolKind: String
    private let cachedToolPrimarySubject: String?
    private let cachedToolInputPreview: String
    private let cachedToolOutputPreview: String
    private let cachedSingleLineContent: String
    private let cachedContentSizeSummary: String

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
        toolName: String? = nil,
        attachmentCount: Int = 0,
        thumbnails: [NSImage] = []
    ) {
        self.id = id
        self.role = role
        self.content = content
        self.timestamp = timestamp
        self.toolName = toolName
        self.attachmentCount = attachmentCount
        self.thumbnails = thumbnails

        let sanitizedToolName = Self.sanitizedToolName(toolName)
        let structuredContent =
            role == .toolUse || role == .toolResult
            ? Self.parseJSONObject(from: content)
            : nil
        let singleLineContent = Self.compactWhitespace(content)
        let normalizedToolKind = Self.resolveNormalizedToolKind(
            sanitizedToolName: sanitizedToolName,
            structuredContent: structuredContent
        )
        let toolPrimarySubject = Self.resolveToolPrimarySubject(
            normalizedToolKind: normalizedToolKind,
            structuredContent: structuredContent
        )

        attributedContent = Self.makeAttributedContent(for: role, content: content)
        cachedResolvedToolName = Self.resolveToolName(
            sanitizedToolName: sanitizedToolName,
            normalizedToolKind: normalizedToolKind
        )
        cachedNormalizedToolKind = normalizedToolKind
        cachedToolPrimarySubject = toolPrimarySubject
        cachedToolInputPreview = toolPrimarySubject ?? singleLineContent
        cachedToolOutputPreview = Self.resolveToolOutputPreview(
            structuredContent: structuredContent,
            fallback: singleLineContent
        )
        cachedSingleLineContent = singleLineContent
        cachedContentSizeSummary = ByteCountFormatter.string(
            fromByteCount: Int64(content.utf8.count),
            countStyle: .file
        )
    }
}

extension ChatMessage {
    var isToolMessage: Bool {
        role == .toolUse || role == .toolResult
    }

    var resolvedToolName: String {
        cachedResolvedToolName
    }

    var normalizedToolKind: String {
        cachedNormalizedToolKind
    }

    var toolPrimarySubject: String? {
        cachedToolPrimarySubject
    }

    var toolInputPreview: String {
        cachedToolInputPreview
    }

    var toolOutputPreview: String {
        cachedToolOutputPreview
    }

    var singleLineContent: String {
        cachedSingleLineContent
    }

    var contentSizeSummary: String {
        cachedContentSizeSummary
    }

    func updatingContent(_ content: String) -> ChatMessage {
        guard content != self.content else { return self }

        return ChatMessage(
            id: id,
            role: role,
            content: content,
            timestamp: timestamp,
            toolName: toolName,
            attachmentCount: attachmentCount,
            thumbnails: thumbnails
        )
    }

    private static func makeAttributedContent(for role: Role, content: String) -> AttributedString? {
        guard (role == .ghost || role == .system),
              !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }

        return try? AttributedString(
            markdown: content,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        )
    }

    private static func resolveToolName(sanitizedToolName: String?, normalizedToolKind: String) -> String {
        if let sanitizedToolName {
            return sanitizedToolName
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

    private static func resolveNormalizedToolKind(
        sanitizedToolName: String?,
        structuredContent: Any?
    ) -> String {
        let rawName = (sanitizedToolName ?? structuredValue(in: structuredContent, forKeys: ["tool", "tool_name", "toolName", "name"]) ?? "")
            .lowercased()

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

    private static func resolveToolPrimarySubject(
        normalizedToolKind: String,
        structuredContent: Any?
    ) -> String? {
        if let path = structuredValue(in: structuredContent, forKeys: [
            "path",
            "file_path",
            "filepath",
            "filePath",
            "target_path",
            "targetPath",
            "absolute_path",
            "absolutePath",
        ]) {
            return compactWhitespace(path)
        }

        if normalizedToolKind == "bash",
           let command = structuredValue(in: structuredContent, forKeys: ["command", "cmd"]) {
            return compactWhitespace(command)
        }

        if let value = structuredValue(in: structuredContent, forKeys: ["url", "uri", "query", "prompt", "pattern"]) {
            return compactWhitespace(value)
        }

        return nil
    }

    private static func resolveToolOutputPreview(structuredContent: Any?, fallback: String) -> String {
        if let value = structuredValue(in: structuredContent, forKeys: [
            "summary",
            "message",
            "result",
            "output",
            "stdout",
            "stderr",
            "text",
        ]) {
            return compactWhitespace(value)
        }

        return fallback
    }

    private static func sanitizedToolName(_ toolName: String?) -> String? {
        guard let toolName else { return nil }

        let trimmed = toolName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.caseInsensitiveCompare("result") != .orderedSame else {
            return nil
        }

        return trimmed
    }

    private static func structuredValue(in object: Any?, forKeys keys: [String]) -> String? {
        guard let object else { return nil }
        return findValue(in: object, keys: Set(keys.map { $0.lowercased() }))
    }

    private static func parseJSONObject(from content: String) -> Any? {
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
