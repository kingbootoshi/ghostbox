import Foundation
import Security

enum KeychainHelper {
    private static let service = "com.ghostbox.app"
    private static let account = "serverToken"

    private enum KeychainError: Error {
        case unexpectedStatus(OSStatus)
        case accessCreationFailed
    }

    private static var baseQuery: [CFString: Any] {
        [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
        ]
    }

    /// Creates a SecAccess that allows ALL applications to read the item without prompting.
    /// This prevents Keychain from asking for a password every time the app is rebuilt
    /// with a new code signature during development.
    private static func createUnrestrictedAccess() throws -> SecAccess {
        var accessRef: SecAccess?
        let status = SecAccessCreate(service as CFString, [] as CFArray, &accessRef)
        guard status == errSecSuccess, let access = accessRef else {
            throw KeychainError.accessCreationFailed
        }

        // Get the default ACL for the decrypt authorization
        guard let aclList = SecAccessCopyMatchingACLList(access, kSecACLAuthorizationDecrypt) as? [SecACL],
              let decryptACL = aclList.first else {
            throw KeychainError.accessCreationFailed
        }

        let allAuthorizations = SecACLCopyAuthorizations(decryptACL)
        let removeStatus = SecACLRemove(decryptACL)
        guard removeStatus == errSecSuccess else {
            throw KeychainError.unexpectedStatus(removeStatus)
        }

        // Create a new ACL with nil trusted apps = all applications allowed
        var newACLRef: SecACL?
        let aclStatus = SecACLCreateWithSimpleContents(
            access,
            nil,
            service as CFString,
            [],
            &newACLRef
        )
        guard aclStatus == errSecSuccess, let newACL = newACLRef else {
            throw KeychainError.unexpectedStatus(aclStatus)
        }

        let updateStatus = SecACLUpdateAuthorizations(newACL, allAuthorizations)
        guard updateStatus == errSecSuccess else {
            throw KeychainError.unexpectedStatus(updateStatus)
        }

        return access
    }

    static func save(token: String) throws {
        // Delete first to recreate with proper ACLs
        SecItemDelete(baseQuery as CFDictionary)

        let tokenData = Data(token.utf8)
        var addQuery = baseQuery
        addQuery[kSecValueData] = tokenData

        // Use SecAccess with unrestricted ACLs so any code signature can read it
        let access = try createUnrestrictedAccess()
        addQuery[kSecAttrAccess] = access

        let status = SecItemAdd(addQuery as CFDictionary, nil)
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
