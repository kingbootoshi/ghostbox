import Foundation

struct Ghost: Codable, Identifiable {
    let name: String
    let status: GhostStatus
    let provider: String
    let model: String
    let portBase: Int?
    let containerId: String?
    let createdAt: String?
    let systemPrompt: String?

    var id: String { name }

    enum GhostStatus: String, Codable {
        case running
        case stopped
        case error
    }

    enum CodingKeys: String, CodingKey {
        case status, provider, model, portBase, containerId, createdAt, systemPrompt
    }

    /// Ghost name isn't in the JSON - it's the dictionary key. Set after decoding.
    init(name: String, status: GhostStatus, provider: String, model: String, portBase: Int?, containerId: String?, createdAt: String?, systemPrompt: String?) {
        self.name = name
        self.status = status
        self.provider = provider
        self.model = model
        self.portBase = portBase
        self.containerId = containerId
        self.createdAt = createdAt
        self.systemPrompt = systemPrompt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.name = ""  // filled in by caller
        self.status = try container.decode(GhostStatus.self, forKey: .status)
        self.provider = try container.decode(String.self, forKey: .provider)
        self.model = try container.decode(String.self, forKey: .model)
        self.portBase = try container.decodeIfPresent(Int.self, forKey: .portBase)
        self.containerId = try container.decodeIfPresent(String.self, forKey: .containerId)
        self.createdAt = try container.decodeIfPresent(String.self, forKey: .createdAt)
        self.systemPrompt = try container.decodeIfPresent(String.self, forKey: .systemPrompt)
    }
}
