import Foundation
import Security

public protocol KeychainStoreProtocol: Sendable {
    func saveToken(_ token: String, for account: String) throws
    func loadToken(for account: String) -> String?
    func deleteToken(for account: String)
}

public enum KeychainError: LocalizedError, Sendable {
    case unexpectedStatus(OSStatus)

    public var errorDescription: String? {
        switch self {
        case .unexpectedStatus(let status):
            return "Keychain operation failed with status \(status)."
        }
    }
}

public final class KeychainStore: KeychainStoreProtocol, Sendable {
    private let service: String

    public init(service: String = "com.lxe.superharness.auth") {
        self.service = service
    }

    public func saveToken(_ token: String, for account: String) throws {
        let data = Data(token.utf8)
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
        ]

        let attributes: [CFString: Any] = [
            kSecValueData: data,
            kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]

        let updateStatus = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if updateStatus == errSecSuccess {
            return
        }
        if updateStatus == errSecItemNotFound {
            var addQuery = query
            addQuery[kSecValueData] = data
            addQuery[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let addStatus = SecItemAdd(addQuery as CFDictionary, nil)
            guard addStatus == errSecSuccess else {
                throw KeychainError.unexpectedStatus(addStatus)
            }
            return
        }
        throw KeychainError.unexpectedStatus(updateStatus)
    }

    public func loadToken(for account: String) -> String? {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    public func deleteToken(for account: String) {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

public final class InMemoryKeychainStore: KeychainStoreProtocol, @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String: String] = [:]

    public init(initial: [String: String] = [:]) {
        self.storage = initial
    }

    public func saveToken(_ token: String, for account: String) throws {
        lock.lock()
        defer { lock.unlock() }
        storage[account] = token
    }

    public func loadToken(for account: String) -> String? {
        lock.lock()
        defer { lock.unlock() }
        return storage[account]
    }

    public func deleteToken(for account: String) {
        lock.lock()
        defer { lock.unlock() }
        storage.removeValue(forKey: account)
    }
}
