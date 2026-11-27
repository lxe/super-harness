import Foundation

// MARK: - Pairing link (the desktop's QR code)

/// The contents of the desktop's pairing QR code:
/// `superharness://pair?v=1&name=<desktop name>&id=<hostId>&port=<port>&code=<6 digits>&hosts=<a,b,c>`.
public struct PairingLink: Equatable, Sendable {
    public static let supportedVersion = 1
    public static let defaultPort = 47890

    public var version: Int
    public var hostName: String
    public var hostId: String
    public var port: Int
    public var code: String
    /// Addresses to try, best first (Tailscale name, Tailscale IP, LAN IP).
    public var hosts: [String]

    public enum ParseError: Error, Equatable, LocalizedError, Sendable {
        case notAPairingCode
        case unsupportedVersion(Int)
        case missingCode
        case missingAddresses

        public var errorDescription: String? {
            switch self {
            case .notAPairingCode:
                return "That QR code is not a Super Harness pairing code."
            case .unsupportedVersion:
                return "This pairing code is from a newer Super Harness. Update the app and try again."
            case .missingCode:
                return "The pairing code is incomplete. Show a new code on the desktop and scan again."
            case .missingAddresses:
                return "The pairing code has no desktop address in it. Show a new code on the desktop and scan again."
            }
        }
    }

    public static func parse(_ raw: String) -> Result<PairingLink, ParseError> {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let components = URLComponents(string: trimmed),
              components.scheme?.lowercased() == "superharness",
              (components.host ?? "").lowercased() == "pair" else {
            return .failure(.notAPairingCode)
        }
        var values: [String: String] = [:]
        for item in components.queryItems ?? [] {
            // URLComponents has already percent-decoded each value.
            if let value = item.value { values[item.name.lowercased()] = value }
        }
        let version = Int(values["v"] ?? "") ?? 1
        guard version == supportedVersion else { return .failure(.unsupportedVersion(version)) }

        let code = normalizedCode(values["code"] ?? "")
        guard isValidCode(code) else { return .failure(.missingCode) }

        let hosts = (values["hosts"] ?? "")
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        guard !hosts.isEmpty else { return .failure(.missingAddresses) }

        let port = Int(values["port"] ?? "").flatMap { (1...65535).contains($0) ? $0 : nil } ?? defaultPort
        return .success(PairingLink(
            version: version,
            hostName: values["name"]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "",
            hostId: values["id"]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "",
            port: port,
            code: code,
            hosts: hosts
        ))
    }

    /// Base URLs for the control server, in the link's order.
    public var candidateBaseURLs: [URL] {
        hosts.compactMap { PairingAddress.baseURL(from: $0, defaultPort: port) }
    }

    /// Digits only, so "123 456" and "123-456" are accepted when typed.
    public static func normalizedCode(_ raw: String) -> String {
        String(raw.unicodeScalars.filter { CharacterSet.decimalDigits.contains($0) })
    }

    public static func isValidCode(_ code: String) -> Bool {
        code.count == 6 && code.allSatisfy(\.isNumber)
    }
}

/// Turns what a person types or a QR code lists ("mybox", "100.64.0.3", "10.0.0.5:47890",
/// "http://host:1234", an IPv6 literal) into the control server's base URL.
public enum PairingAddress {
    public static func baseURL(from raw: String, defaultPort: Int = PairingLink.defaultPort) -> URL? {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        while text.hasSuffix("/") { text.removeLast() }

        if text.contains("://") {
            guard var components = URLComponents(string: text), let host = components.host, !host.isEmpty else { return nil }
            if components.port == nil { components.port = defaultPort }
            components.path = ""
            components.query = nil
            return components.url
        }

        // A bare IPv6 literal has more than one colon and no brackets.
        let colonCount = text.filter { $0 == ":" }.count
        let hostAndPort: String
        if text.hasPrefix("[") {
            hostAndPort = text.contains("]:") ? text : "\(text):\(defaultPort)"
        } else if colonCount > 1 {
            hostAndPort = "[\(text)]:\(defaultPort)"
        } else if colonCount == 1 {
            hostAndPort = text
        } else {
            hostAndPort = "\(text):\(defaultPort)"
        }
        guard let components = URLComponents(string: "http://\(hostAndPort)"),
              let host = components.host, !host.isEmpty else { return nil }
        return components.url
    }
}

// MARK: - Host responses

/// `GET /api/pair/info`: lets the phone check an address before pairing. Nothing secret.
public struct PairInfo: Codable, Equatable, Sendable {
    public var ok: Bool
    public var hostId: String?
    public var hostName: String?
    public var version: String?
    public var pairingOpen: Bool?

    public init(ok: Bool = true, hostId: String? = nil, hostName: String? = nil, version: String? = nil, pairingOpen: Bool? = nil) {
        self.ok = ok
        self.hostId = hostId
        self.hostName = hostName
        self.version = version
        self.pairingOpen = pairingOpen
    }
}

/// `POST /api/pair` success body.
public struct PairGrant: Equatable, Sendable {
    public var token: String
    public var hostId: String
    public var hostName: String
    /// The address that answered, saved as the host address.
    public var baseURL: URL
}

public enum PairingError: Error, Equatable, LocalizedError, Sendable {
    /// No address answered `GET /api/pair/info`.
    case unreachable
    /// An address answered, but it is a different desktop from the one in the QR code.
    case differentDesktop
    /// The desktop is reachable but is not showing a pairing code.
    case pairingClosed
    /// 401: wrong or expired code.
    case wrongCode(String?)
    /// 429: too many attempts.
    case tooManyAttempts
    case invalidAddress
    case invalidCode
    case server(String)

    public var errorDescription: String? {
        switch self {
        case .unreachable:
            return "Couldn’t reach the desktop. Check that both devices are on the same network, or that Tailscale is on for both."
        case .differentDesktop:
            return "That address belongs to a different desktop from the one showing the code."
        case .pairingClosed:
            return "The desktop isn’t showing a pairing code. In Super Harness on the desktop, open Settings → Mobile and choose Pair a phone."
        case .wrongCode(let hostMessage):
            // The desktop says exactly what is wrong (expired, not open, mistyped) when it can.
            if let hostMessage, !hostMessage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return hostMessage
            }
            return "That code didn’t work. Codes expire after 10 minutes; show a new one on the desktop and try again."
        case .tooManyAttempts:
            return "Too many attempts. Show a new code on the desktop and try again."
        case .invalidAddress:
            return "That doesn’t look like an address. Use a name or IP, like mydesktop or 100.64.0.3."
        case .invalidCode:
            return "Enter the 6-digit code shown on the desktop."
        case .server(let message):
            return message
        }
    }
}

// MARK: - Pairing service

public protocol PairingServiceProtocol: Sendable {
    /// Throws when the address does not answer in time.
    func info(baseURL: URL) async throws -> PairInfo
    func pair(baseURL: URL, code: String, deviceName: String, deviceId: String) async throws -> PairGrant
    /// Tells the desktop to drop this phone (`POST /api/unpair`, authenticated by the phone's
    /// own token). Best effort: the phone forgets the desktop whether or not this succeeds.
    func unpair(baseURL: URL, token: String) async
}

public struct HTTPPairingService: PairingServiceProtocol {
    private let session: URLSession
    private let infoTimeout: TimeInterval

    public init(infoTimeout: TimeInterval = 2.5) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.waitsForConnectivity = false
        configuration.timeoutIntervalForRequest = 12
        self.session = URLSession(configuration: configuration)
        self.infoTimeout = infoTimeout
    }

    public func info(baseURL: URL) async throws -> PairInfo {
        var request = URLRequest(url: baseURL.appendingPathComponent("api/pair/info"))
        request.timeoutInterval = infoTimeout
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw PairingError.unreachable
        }
        return try JSONDecoder().decode(PairInfo.self, from: data)
    }

    public func pair(baseURL: URL, code: String, deviceName: String, deviceId: String) async throws -> PairGrant {
        var request = URLRequest(url: baseURL.appendingPathComponent("api/pair"))
        request.httpMethod = "POST"
        request.timeoutInterval = 12
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "code": code,
            "deviceName": deviceName,
            "deviceId": deviceId,
        ])
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw PairingError.unreachable
        }
        guard let http = response as? HTTPURLResponse else { throw PairingError.unreachable }
        return try Self.grant(status: http.statusCode, body: data, baseURL: baseURL)
    }

    public func unpair(baseURL: URL, token: String) async {
        var request = URLRequest(url: baseURL.appendingPathComponent("api/unpair"))
        request.httpMethod = "POST"
        request.timeoutInterval = 3
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.httpBody = Data("{}".utf8)
        _ = try? await session.data(for: request)
    }

    /// Maps the host's reply to a grant or a `PairingError`. Separate so it can be tested
    /// without a network.
    static func grant(status: Int, body: Data, baseURL: URL) throws -> PairGrant {
        struct Body: Decodable {
            var ok: Bool?
            var token: String?
            var hostId: String?
            var hostName: String?
            var error: String?
        }
        let parsed = try? JSONDecoder().decode(Body.self, from: body)
        switch status {
        case 200..<300:
            guard parsed?.ok != false, let token = parsed?.token, !token.isEmpty else {
                throw PairingError.server(parsed?.error ?? "The desktop’s reply had no token in it.")
            }
            return PairGrant(token: token, hostId: parsed?.hostId ?? "", hostName: parsed?.hostName ?? "", baseURL: baseURL)
        case 401, 403:
            throw PairingError.wrongCode(parsed?.error)
        case 429:
            throw PairingError.tooManyAttempts
        case 404:
            throw PairingError.server("This desktop’s Super Harness is too old to pair. Update it and try again.")
        default:
            throw PairingError.server(parsed?.error ?? "The desktop answered with an error (\(status)).")
        }
    }
}

/// Finds which of a link's addresses reaches the desktop, then pairs with it.
public enum PairingFlow {
    /// Asks every address at once and returns the best-ranked one that answers as the expected
    /// desktop. `expectedHostId` empty means any desktop is accepted (manual entry).
    public static func firstReachable(
        _ candidates: [URL],
        expectedHostId: String,
        service: PairingServiceProtocol
    ) async throws -> (url: URL, info: PairInfo) {
        guard !candidates.isEmpty else { throw PairingError.invalidAddress }
        let results = await withTaskGroup(of: (Int, PairInfo?).self) { group -> [Int: PairInfo] in
            for (index, url) in candidates.enumerated() {
                group.addTask { (index, try? await service.info(baseURL: url)) }
            }
            var found: [Int: PairInfo] = [:]
            for await (index, info) in group {
                if let info { found[index] = info }
            }
            return found
        }
        guard !results.isEmpty else { throw PairingError.unreachable }
        let matching = results.filter { _, info in
            expectedHostId.isEmpty || (info.hostId ?? "").isEmpty || info.hostId == expectedHostId
        }
        guard let best = matching.keys.min(), let info = matching[best] else {
            throw PairingError.differentDesktop
        }
        return (candidates[best], info)
    }

    public static func pair(
        candidates: [URL],
        expectedHostId: String,
        code rawCode: String,
        deviceName: String,
        deviceId: String,
        service: PairingServiceProtocol
    ) async throws -> PairGrant {
        let code = PairingLink.normalizedCode(rawCode)
        guard PairingLink.isValidCode(code) else { throw PairingError.invalidCode }
        let reachable = try await firstReachable(candidates, expectedHostId: expectedHostId, service: service)
        if reachable.info.pairingOpen == false { throw PairingError.pairingClosed }
        var grant = try await service.pair(baseURL: reachable.url, code: code, deviceName: deviceName, deviceId: deviceId)
        if grant.hostName.isEmpty { grant.hostName = reachable.info.hostName ?? "" }
        if grant.hostId.isEmpty { grant.hostId = reachable.info.hostId ?? "" }
        return grant
    }
}

// MARK: - Mock (Simulator and tests)

/// A stand-in desktop for the Simulator and unit tests. It answers on the addresses in
/// `reachableHosts` and accepts `acceptedCode`.
public final class MockPairingService: PairingServiceProtocol, @unchecked Sendable {
    public static let demoCode = "123456"

    public var reachableHosts: Set<String>
    public var hostId: String
    public var hostName: String
    public var acceptedCode: String
    public var pairingOpen: Bool
    private let lock = NSLock()
    private var wrongAttempts = 0
    public private(set) var pairCalls: [(url: URL, code: String)] = []
    public private(set) var unpairCalls: [(url: URL, token: String)] = []

    public init(
        reachableHosts: Set<String> = [],
        hostId: String = "mock-host",
        hostName: String = "Demo Desktop",
        acceptedCode: String = MockPairingService.demoCode,
        pairingOpen: Bool = true
    ) {
        self.reachableHosts = reachableHosts
        self.hostId = hostId
        self.hostName = hostName
        self.acceptedCode = acceptedCode
        self.pairingOpen = pairingOpen
    }

    /// An empty set means every address answers.
    private func answers(_ url: URL) -> Bool {
        reachableHosts.isEmpty || reachableHosts.contains(url.host ?? "")
    }

    public func info(baseURL: URL) async throws -> PairInfo {
        guard answers(baseURL) else { throw PairingError.unreachable }
        return PairInfo(ok: true, hostId: hostId, hostName: hostName, version: "mock", pairingOpen: pairingOpen)
    }

    public func pair(baseURL: URL, code: String, deviceName: String, deviceId: String) async throws -> PairGrant {
        guard answers(baseURL) else { throw PairingError.unreachable }
        try record(url: baseURL, code: code)
        return PairGrant(token: "mock-device-token", hostId: hostId, hostName: hostName, baseURL: baseURL)
    }

    public func unpair(baseURL: URL, token: String) async {
        recordUnpair(url: baseURL, token: token)
    }

    private func recordUnpair(url: URL, token: String) {
        lock.lock()
        defer { lock.unlock() }
        unpairCalls.append((url, token))
    }

    /// Counts the attempt and throws when the code is wrong or the code has been burned.
    private func record(url: URL, code: String) throws {
        lock.lock()
        defer { lock.unlock() }
        pairCalls.append((url, code))
        if wrongAttempts >= 5 { throw PairingError.tooManyAttempts }
        guard code == acceptedCode else {
            wrongAttempts += 1
            throw PairingError.wrongCode(nil)
        }
    }
}
