import Foundation
import Security

enum KeychainHelper {
    private static let service = "com.ghostbox.app"
    private static let account = "serverToken"

    private enum KeychainError: Error {
        case unexpectedStatus(OSStatus)
    }

    private static var baseQuery: [CFString: Any] {
        [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
        ]
    }

    static func save(token: String) throws {
        let tokenData = Data(token.utf8)
        var addQuery = baseQuery
        addQuery[kSecValueData] = tokenData

        let status = SecItemAdd(addQuery as CFDictionary, nil)
        if status == errSecDuplicateItem {
            let attributesToUpdate: [CFString: Any] = [
                kSecValueData: tokenData,
            ]
            let updateStatus = SecItemUpdate(baseQuery as CFDictionary, attributesToUpdate as CFDictionary)
            guard updateStatus == errSecSuccess else {
                throw KeychainError.unexpectedStatus(updateStatus)
            }
            return
        }

        guard status == errSecSuccess else {
            throw KeychainError.unexpectedStatus(status)
        }
    }

    static func loadToken() -> String? {
        var query = baseQuery
        query[kSecReturnData] = kCFBooleanTrue
        query[kSecMatchLimit] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)

        guard status != errSecItemNotFound else {
            return nil
        }

        guard status == errSecSuccess, let data = item as? Data else {
            return nil
        }

        return String(data: data, encoding: .utf8)
    }

    static func deleteToken() {
        SecItemDelete(baseQuery as CFDictionary)
    }
}
