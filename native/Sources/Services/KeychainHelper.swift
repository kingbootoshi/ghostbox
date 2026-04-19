import Foundation
import Security

// Local-file token store. Keychain was abandoned because macOS rebinds the
// keychain item's partition_list to the caller's cdhash on every SecItemAdd,
// so unsigned Debug rebuilds prompt on every launch. Apple DTS confirms there
// is no supported API to produce a partition-list-free item for unsigned
// binaries. File storage at ~/.ghostbox/app-token (mode 0600) matches every
// other credential in the ghostbox stack (auth.json, state.json) and every
// similar dev tool (~/.aws/credentials, ~/.kube/config, ~/.claude.json).
enum KeychainHelper {
    private static let legacyService = "com.ghostbox.app"
    private static let legacyAccount = "serverToken"
    private static let fileName = "app-token"

    private static var storeURL: URL {
        let home = FileManager.default.homeDirectoryForCurrentUser
        return home.appendingPathComponent(".ghostbox").appendingPathComponent(fileName)
    }

    static func save(token: String) throws {
        let directory = storeURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )

        let data = Data(token.utf8)
        try data.write(to: storeURL, options: [.atomic])
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o600],
            ofItemAtPath: storeURL.path
        )

        removeLegacyKeychainItem()
    }

    static func loadToken() -> String? {
        if let data = try? Data(contentsOf: storeURL),
           let token = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
           !token.isEmpty {
            return token
        }

        if let migrated = migrateLegacyKeychainItem() {
            return migrated
        }

        return nil
    }

    static func deleteToken() {
        try? FileManager.default.removeItem(at: storeURL)
        removeLegacyKeychainItem()
    }

    // Reads the old keychain item (if any), writes it to file, then removes it
    // from the keychain. This may prompt once if the old partition_list blocks
    // the current binary; after success the keychain entry is gone and no
    // further prompts can occur.
    private static func migrateLegacyKeychainItem() -> String? {
        var query = legacyBaseQuery
        query[kSecReturnData] = kCFBooleanTrue
        query[kSecMatchLimit] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess,
              let data = item as? Data,
              let token = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !token.isEmpty else {
            return nil
        }

        try? save(token: token)
        return token
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
