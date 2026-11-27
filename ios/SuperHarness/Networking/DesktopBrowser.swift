import Foundation
import Network
import Observation

/// A desktop found on the local network through Bonjour (`_superharness._tcp`).
public struct NearbyDesktop: Identifiable, Equatable, Sendable {
    /// The desktop's stable id from the TXT record, or the service name when it has none.
    public var id: String
    public var name: String
    public var hostId: String
    /// Set for desktops found over Bonjour; nil for the debug sample.
    var endpoint: NWEndpoint?
    /// A known address (debug sample only).
    var fixedBaseURL: URL?
}

/// Browses for desktops advertising `_superharness._tcp` and resolves a chosen one to an
/// address. The TXT record carries `v`, `id` and `name` only; it never carries a code or token.
@MainActor
@Observable
public final class DesktopBrowser {
    public static let serviceType = "_superharness._tcp"

    public private(set) var desktops: [NearbyDesktop] = []
    /// Set when the system refuses the browse, usually because Local Network access is off.
    public private(set) var problem: String?

    @ObservationIgnored private var browser: NWBrowser?

    public init() {}

    public func start() {
        guard browser == nil else { return }
        #if DEBUG
        if ProcessInfo.processInfo.environment["SH_MOCK_NEARBY"] != nil {
            desktops = [NearbyDesktop(
                id: "mock-host",
                name: "Demo Desktop",
                hostId: "mock-host",
                endpoint: nil,
                fixedBaseURL: URL(string: "http://demo-desktop.local:47890")
            )]
            return
        }
        #endif
        let parameters = NWParameters()
        parameters.includePeerToPeer = false
        let browser = NWBrowser(for: .bonjourWithTXTRecord(type: Self.serviceType, domain: nil), using: parameters)
        browser.stateUpdateHandler = { [weak self] state in
            Task { @MainActor [weak self] in
                switch state {
                case .failed(let error), .waiting(let error):
                    self?.problem = Self.describe(error)
                case .ready:
                    self?.problem = nil
                default:
                    break
                }
            }
        }
        browser.browseResultsChangedHandler = { [weak self] results, _ in
            let found = results.compactMap(Self.desktop(from:))
            Task { @MainActor [weak self] in
                self?.desktops = found.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
            }
        }
        browser.start(queue: .main)
        self.browser = browser
    }

    public func stop() {
        browser?.cancel()
        browser = nil
    }

    nonisolated private static func describe(_ error: NWError) -> String {
        if case .dns(let code) = error, code == kDNSServiceErr_PolicyDenied {
            return "Allow Local Network access for Super Harness in the Settings app to find desktops nearby."
        }
        return "Couldn’t look for desktops nearby."
    }

    nonisolated private static func desktop(from result: NWBrowser.Result) -> NearbyDesktop? {
        guard case .service(let serviceName, _, _, _) = result.endpoint else { return nil }
        var txtName: String?
        var hostId = ""
        if case .bonjour(let record) = result.metadata {
            txtName = record["name"]
            hostId = record["id"] ?? ""
        }
        let name = (txtName?.isEmpty == false ? txtName! : serviceName)
        return NearbyDesktop(id: hostId.isEmpty ? serviceName : hostId, name: name, hostId: hostId, endpoint: result.endpoint, fixedBaseURL: nil)
    }

    /// Resolves a Bonjour service to `http://<address>:<port>` by opening a connection to it
    /// and reading the address the system chose. Returns nil when it cannot connect in time.
    public func baseURL(for desktop: NearbyDesktop) async -> URL? {
        if let fixed = desktop.fixedBaseURL { return fixed }
        guard let endpoint = desktop.endpoint else { return nil }
        return await Self.resolve(endpoint)
    }

    nonisolated private static func resolve(_ endpoint: NWEndpoint, timeout: TimeInterval = 4) async -> URL? {
        await withCheckedContinuation { (continuation: CheckedContinuation<URL?, Never>) in
            let connection = NWConnection(to: endpoint, using: .tcp)
            let finished = ResolveOnce()
            let finish: @Sendable (URL?) -> Void = { url in
                guard finished.claim() else { return }
                connection.cancel()
                continuation.resume(returning: url)
            }
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    finish(Self.url(from: connection.currentPath?.remoteEndpoint))
                case .failed, .cancelled:
                    finish(nil)
                default:
                    break
                }
            }
            connection.start(queue: .global(qos: .userInitiated))
            DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { finish(nil) }
        }
    }

    nonisolated static func url(from endpoint: NWEndpoint?) -> URL? {
        guard case .hostPort(let host, let port) = endpoint else { return nil }
        let address: String
        switch host {
        case .ipv4(let v4):
            address = "\(v4)"
        case .ipv6(let v6):
            // Drop a scope suffix such as "%en0": it is only meaningful on this device's stack
            // and URL hosts cannot carry it reliably.
            let text = "\(v6)"
            address = "[\(text.split(separator: "%").first.map(String.init) ?? text)]"
        case .name(let name, _):
            address = name
        @unknown default:
            return nil
        }
        return URL(string: "http://\(address):\(port.rawValue)")
    }
}

/// Lets several callbacks race to finish one continuation exactly once.
private final class ResolveOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    func claim() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if done { return false }
        done = true
        return true
    }
}
