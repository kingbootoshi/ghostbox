import Foundation

struct GhostModel: Identifiable, Hashable {
    let provider: String
    let modelId: String
    let displayName: String
    let defaultReasoning: String?

    var id: String { "\(provider)/\(modelId)" }
    var apiValue: String { modelId }

    static let all: [GhostModel] = [
        GhostModel(provider: "anthropic", modelId: "claude-opus-4-7", displayName: "Opus 4.7", defaultReasoning: nil),
        GhostModel(provider: "anthropic", modelId: "claude-sonnet-4-6", displayName: "Sonnet 4.6", defaultReasoning: nil),
        GhostModel(provider: "anthropic", modelId: "claude-opus-4-6", displayName: "Opus 4.6", defaultReasoning: nil),
        GhostModel(provider: "anthropic", modelId: "claude-haiku-4-5", displayName: "Haiku 4.5", defaultReasoning: nil),
        GhostModel(provider: "openai", modelId: "gpt-5.4", displayName: "GPT 5.4", defaultReasoning: "medium"),
    ]

    static let reasoningLevels = ["low", "medium", "high", "xhigh"]

    static let `default` = all[0]

    static func find(provider: String, modelId: String) -> GhostModel? {
        all.first { $0.provider == provider && $0.modelId == modelId }
    }

    var supportsReasoning: Bool {
        defaultReasoning != nil
    }
}
