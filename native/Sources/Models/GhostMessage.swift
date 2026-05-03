import Foundation

/// Matches the actual GhostMessage union type from the Ghostbox API.
/// Each variant has different fields:
///   assistant:    { type, text }
///   tool_use:     { type, tool, input }
///   tool_result:  { type, output }
///   result:       { type, text, sessionId }
struct GhostMessage: Decodable {
    let type: MessageType
    let text: String?
    let tool: String?
    let input: AnyCodable?
    let output: AnyCodable?
    let sessionId: String?
    let queueJobId: String?
    let position: Int?
    let reason: String?

    enum MessageType: String, Codable {
        case assistant
        case thinking
        case tool_use
        case tool_result
        case result
        case queued
        case aborted
        case rejected
    }
}

/// Wrapper for arbitrary JSON values that just need to be displayed as strings.
struct AnyCodable: Decodable {
    let value: Any

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            value = NSNull()
        } else if let string = try? container.decode(String.self) {
            value = string
        } else if let int = try? container.decode(Int.self) {
            value = int
        } else if let double = try? container.decode(Double.self) {
            value = double
        } else if let bool = try? container.decode(Bool.self) {
            value = bool
        } else if let dict = try? container.decode([String: AnyCodable].self) {
            value = dict.mapValues { $0.value }
        } else if let array = try? container.decode([AnyCodable].self) {
            value = array.map { $0.value }
        } else {
            value = "<unknown>"
        }
    }

    var stringValue: String {
        if let s = value as? String { return s }
        if value is NSNull { return "null" }
        if let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .sortedKeys]),
           let s = String(data: data, encoding: .utf8) {
            return s
        }
        return String(describing: value)
    }
}
