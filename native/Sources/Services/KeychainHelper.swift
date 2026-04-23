import Foundation
import Security

struct ConnectionConfig: Codable {
    static let defaultURLString = "http://localhost:8008"

    let url: String
    let token: String
}

// One canonical client connection file shared by the CLI and native app.
// Legacy native locations are migrated once into ~/.ghostbox/connection.json
// and then removed so there is only one steady-state source of truth.
enum ConnectionConfigStore {
    private static let legacyService = "com.ghostbox.app"
    private static let legacyAccount = "serverToken"
    private static let legacyTokenFileName = "app-token"
    private static let legacyRemoteConfigFileName = "remote.json"
    private static let connectionFileName = "connection.json"

    private static var directoryURL: URL {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".ghostbox")
    }

    private static var storeURL: URL {
        directoryURL.appendingPathComponent(connectionFileName)
    }

    private static var legacyTokenURL: URL {
        directoryURL.appendingPathComponent(legacyTokenFileName)
    }

    private static var legacyRemoteConfigURL: URL {
        directoryURL.appendingPathComponent(legacyRemoteConfigFileName)
    }

    static func load() -> ConnectionConfig? {
        if let config = loadStoredConfig() {
            return config
        }

        return migrateLegacySourcesIfNeeded()
    }

    static func save(url: String, token: String) throws {
        let config = ConnectionConfig(
            url: sanitizeURL(url) ?? ConnectionConfig.defaultURLString,
            token: sanitizeToken(token)
        )

        guard !config.token.isEmpty else {
            throw CocoaError(.validationStringTooShort)
        }

        try FileManager.default.createDirectory(
            at: directoryURL,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(config)
        try data.write(to: storeURL, options: [.atomic])
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o600],
            ofItemAtPath: storeURL.path
        )

        clearLegacySources()
    }

    static func clear() {
        try? FileManager.default.removeItem(at: storeURL)
        clearLegacySources()
    }

    private static func loadStoredConfig() -> ConnectionConfig? {
        guard let data = try? Data(contentsOf: storeURL),
              let config = try? JSONDecoder().decode(ConnectionConfig.self, from: data),
              let sanitizedURL = sanitizeURL(config.url) else {
            return nil
        }

        let sanitizedToken = sanitizeToken(config.token)
        guard !sanitizedToken.isEmpty else {
            return nil
        }

        return ConnectionConfig(url: sanitizedURL, token: sanitizedToken)
    }

    private static func migrateLegacySourcesIfNeeded() -> ConnectionConfig? {
        if let remoteConfig = loadLegacyRemoteConfig() {
            try? save(url: remoteConfig.url, token: remoteConfig.token)
            return remoteConfig
        }

        let defaults = UserDefaults.standard
        let legacyURL = sanitizeURL(defaults.string(forKey: "serverURL"))
        let legacyDefaultToken = sanitizeToken(defaults.string(forKey: "serverToken"))
        let legacyToken = loadLegacyToken() ?? (legacyDefaultToken.isEmpty ? nil : legacyDefaultToken)

        guard let token = legacyToken else {
            return nil
        }

        let config = ConnectionConfig(
            url: legacyURL ?? ConnectionConfig.defaultURLString,
            token: token
        )

        try? save(url: config.url, token: config.token)
        defaults.removeObject(forKey: "serverURL")
        defaults.removeObject(forKey: "serverToken")
        return config
    }

    private static func loadLegacyRemoteConfig() -> ConnectionConfig? {
        guard let data = try? Data(contentsOf: legacyRemoteConfigURL),
              let config = try? JSONDecoder().decode(ConnectionConfig.self, from: data),
              let sanitizedURL = sanitizeURL(config.url) else {
            return nil
        }

        let sanitizedToken = sanitizeToken(config.token)
        guard !sanitizedToken.isEmpty else {
            return nil
        }

        return ConnectionConfig(url: sanitizedURL, token: sanitizedToken)
    }

    private static func loadLegacyToken() -> String? {
        if let data = try? Data(contentsOf: legacyTokenURL),
           let token = String(data: data, encoding: .utf8) {
            let sanitizedToken = sanitizeToken(token)
            if !sanitizedToken.isEmpty {
                return sanitizedToken
            }
        }

        return loadLegacyKeychainToken()
    }

    private static func loadLegacyKeychainToken() -> String? {
        var query = legacyBaseQuery
        query[kSecReturnData] = kCFBooleanTrue
        query[kSecMatchLimit] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess,
              let data = item as? Data,
              let token = String(data: data, encoding: .utf8) else {
            return nil
        }

        let sanitizedToken = sanitizeToken(token)
        return sanitizedToken.isEmpty ? nil : sanitizedToken
    }

    private static func clearLegacySources() {
        try? FileManager.default.removeItem(at: legacyTokenURL)
        try? FileManager.default.removeItem(at: legacyRemoteConfigURL)
        UserDefaults.standard.removeObject(forKey: "serverURL")
        UserDefaults.standard.removeObject(forKey: "serverToken")
        removeLegacyKeychainItem()
    }

    private static func sanitizeURL(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !trimmed.isEmpty else {
            return nil
        }

        return trimmed
    }

    private static func sanitizeToken(_ value: String?) -> String {
        guard let value else {
            return ""
        }

        return value.filter { !$0.isWhitespace && !$0.isNewline }
    }

    private static func removeLegacyKeychainItem() {
        SecItemDelete(legacyBaseQuery as CFDictionary)
    }

    private static var legacyBaseQuery: [CFString: Any] {
        [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: legacyService,
            kSecAttrAccount: legacyAccount,
        ]
    }
}
