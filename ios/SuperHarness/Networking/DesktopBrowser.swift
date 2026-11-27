import Foundation
import Network
import Observation

/// A desktop found on the local network through Bonjour (`_superharness._tcp`).
public struct NearbyDesktop: Identifiable, Equatable, Sendable {
    /// The desktop's stable id from the TXT record, or the service name when it has none.
    public var id: String
    public var name: String
    public var hostId: String
    /// The Bonjour service (name, type, domain) for desktops found on the network; nil for the
    /// debug sample.
    var service: BonjourService?
    /// A known address (debug sample only).
    var fixedBaseURL: URL?
}

struct BonjourService: Equatable, Sendable {
    var name: String
    var type: String
    var domain: String
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
                service: nil,
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
            return "Allow Local Network access for Superharness in the Settings app to find desktops nearby."
        }
        return "Couldn’t look for desktops nearby."
    }

    nonisolated private static func desktop(from result: NWBrowser.Result) -> NearbyDesktop? {
        guard case .service(let serviceName, let serviceType, let serviceDomain, _) = result.endpoint else { return nil }
        var txtName: String?
        var hostId = ""
        if case .bonjour(let record) = result.metadata {
            txtName = record["name"]
            hostId = record["id"] ?? ""
        }
        let name = (txtName?.isEmpty == false ? txtName! : serviceName)
        return NearbyDesktop(
            id: hostId.isEmpty ? serviceName : hostId,
            name: name,
            hostId: hostId,
            service: BonjourService(name: serviceName, type: serviceType, domain: serviceDomain),
            fixedBaseURL: nil
        )
    }

    /// Every address the desktop advertises, as base URLs, best first (Tailscale, then other
    /// IPv4, then IPv6). A desktop is often reachable on only some of them (a firewall may
    /// block the LAN address while Tailscale works), so the caller tries them all.
    public func baseURLs(for desktop: NearbyDesktop) async -> [URL] {
        if let fixed = desktop.fixedBaseURL { return [fixed] }
        guard let service = desktop.service else { return [] }
        let resolved = await BonjourResolver().resolve(service)
        return Self.rankedBaseURLs(addresses: resolved.addresses, port: resolved.port)
    }

    /// Orders addresses and drops ones a URL cannot use (IPv6 link-local needs a scope).
    nonisolated static func rankedBaseURLs(addresses: [String], port: Int) -> [URL] {
        func rank(_ address: String) -> Int {
            if address.contains(":") { return 2 }
            return isTailscale(address) ? 0 : 1
        }
        var seen = Set<String>()
        return addresses
            .filter { !$0.lowercased().hasPrefix("fe80") && seen.insert($0).inserted }
            .enumerated()
            .sorted { (rank($0.element), $0.offset) < (rank($1.element), $1.offset) }
            .compactMap { PairingAddress.baseURL(from: $0.element, defaultPort: port) }
    }

    /// Tailscale hands out addresses from 100.64.0.0/10.
    nonisolated static func isTailscale(_ ipv4: String) -> Bool {
        let parts = ipv4.split(separator: ".").compactMap { Int($0) }
        return parts.count == 4 && parts[0] == 100 && (64...127).contains(parts[1])
    }
}

/// Resolves one Bonjour service to all of its addresses. `NetService` is deprecated, but it is
/// the API that returns every address of a service; `NWConnection` only reports the one it
/// happened to connect to.
@MainActor
private final class BonjourResolver: NSObject, @preconcurrency NetServiceDelegate {
    private var continuation: CheckedContinuation<(addresses: [String], port: Int), Never>?
    private var netService: NetService?

    func resolve(_ service: BonjourService, timeout: TimeInterval = 4) async -> (addresses: [String], port: Int) {
        await withCheckedContinuation { continuation in
            self.continuation = continuation
            let netService = NetService(domain: service.domain, type: service.type, name: service.name)
            netService.delegate = self
            self.netService = netService
            netService.schedule(in: .main, forMode: .common)
            netService.resolve(withTimeout: timeout)
        }
    }

    private func finish(addresses: [String], port: Int) {
        guard let continuation else { return }
        self.continuation = nil
        netService?.stop()
        netService?.delegate = nil
        netService = nil
        continuation.resume(returning: (addresses, port))
    }

    func netServiceDidResolveAddress(_ sender: NetService) {
        let addresses = (sender.addresses ?? []).compactMap(Self.text(fromSockaddr:))
        finish(addresses: addresses, port: sender.port)
    }

    func netService(_ sender: NetService, didNotResolve errorDict: [String: NSNumber]) {
        finish(addresses: [], port: 0)
    }

    nonisolated static func text(fromSockaddr data: Data) -> String? {
        data.withUnsafeBytes { raw -> String? in
            guard let base = raw.baseAddress, raw.count >= MemoryLayout<sockaddr>.size else { return nil }
            let family = base.assumingMemoryBound(to: sockaddr.self).pointee.sa_family
            var buffer = [CChar](repeating: 0, count: Int(INET6_ADDRSTRLEN))
            if family == sa_family_t(AF_INET), raw.count >= MemoryLayout<sockaddr_in>.size {
                var address = base.assumingMemoryBound(to: sockaddr_in.self).pointee.sin_addr
                guard inet_ntop(AF_INET, &address, &buffer, socklen_t(buffer.count)) != nil else { return nil }
            } else if family == sa_family_t(AF_INET6), raw.count >= MemoryLayout<sockaddr_in6>.size {
                var address = base.assumingMemoryBound(to: sockaddr_in6.self).pointee.sin6_addr
                guard inet_ntop(AF_INET6, &address, &buffer, socklen_t(buffer.count)) != nil else { return nil }
            } else {
                return nil
            }
            return String(cString: buffer)
        }
    }
}
