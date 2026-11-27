import XCTest
@testable import SuperHarness

final class PairingTests: XCTestCase {

    // MARK: QR link

    func testParsesAFullPairingLink() throws {
        let raw = "superharness://pair?v=1&name=Aleksey%27s%20Desktop&id=host-abc&port=47890&code=482913&hosts=archlinux.tail6026.ts.net%2C100.76.24.95%2C192.168.0.3"
        let link = try PairingLink.parse(raw).get()
        XCTAssertEqual(link.hostName, "Aleksey's Desktop")
        XCTAssertEqual(link.hostId, "host-abc")
        XCTAssertEqual(link.port, 47890)
        XCTAssertEqual(link.code, "482913")
        XCTAssertEqual(link.hosts, ["archlinux.tail6026.ts.net", "100.76.24.95", "192.168.0.3"])
        XCTAssertEqual(link.candidateBaseURLs.map(\.absoluteString), [
            "http://archlinux.tail6026.ts.net:47890",
            "http://100.76.24.95:47890",
            "http://192.168.0.3:47890",
        ])
    }

    func testLinkDefaultsThePortAndUsesACustomOne() throws {
        let noPort = try PairingLink.parse("superharness://pair?v=1&code=000111&hosts=mybox").get()
        XCTAssertEqual(noPort.port, 47890)
        XCTAssertEqual(noPort.candidateBaseURLs.first?.absoluteString, "http://mybox:47890")
        let custom = try PairingLink.parse("superharness://pair?v=1&port=5000&code=000111&hosts=mybox").get()
        XCTAssertEqual(custom.candidateBaseURLs.first?.absoluteString, "http://mybox:5000")
    }

    func testRejectsLinksThatAreNotUsablePairingCodes() {
        XCTAssertEqual(PairingLink.parse("https://example.com/pair?code=123456"), .failure(.notAPairingCode))
        XCTAssertEqual(PairingLink.parse("superharness://session/abc"), .failure(.notAPairingCode))
        XCTAssertEqual(PairingLink.parse("just some text"), .failure(.notAPairingCode))
        XCTAssertEqual(PairingLink.parse("superharness://pair?v=2&code=123456&hosts=a"), .failure(.unsupportedVersion(2)))
        XCTAssertEqual(PairingLink.parse("superharness://pair?v=1&code=12345&hosts=a"), .failure(.missingCode))
        XCTAssertEqual(PairingLink.parse("superharness://pair?v=1&hosts=a"), .failure(.missingCode))
        XCTAssertEqual(PairingLink.parse("superharness://pair?v=1&code=123456&hosts="), .failure(.missingAddresses))
    }

    func testTypedCodesMayContainSpacesOrDashes() {
        XCTAssertEqual(PairingLink.normalizedCode("482 913"), "482913")
        XCTAssertEqual(PairingLink.normalizedCode("482-913"), "482913")
        XCTAssertTrue(PairingLink.isValidCode("482913"))
        XCTAssertFalse(PairingLink.isValidCode("48291"))
        XCTAssertFalse(PairingLink.isValidCode("4829134"))
    }

    // MARK: Addresses

    func testAddressesBecomeBaseURLs() {
        XCTAssertEqual(PairingAddress.baseURL(from: "mybox")?.absoluteString, "http://mybox:47890")
        XCTAssertEqual(PairingAddress.baseURL(from: " 100.64.0.3 ")?.absoluteString, "http://100.64.0.3:47890")
        XCTAssertEqual(PairingAddress.baseURL(from: "10.0.0.5:5000")?.absoluteString, "http://10.0.0.5:5000")
        XCTAssertEqual(PairingAddress.baseURL(from: "http://host:1234/")?.absoluteString, "http://host:1234")
        XCTAssertEqual(PairingAddress.baseURL(from: "https://host")?.absoluteString, "https://host:47890")
        XCTAssertEqual(PairingAddress.baseURL(from: "fd7a:115c:a1e0::1")?.absoluteString, "http://[fd7a:115c:a1e0::1]:47890")
        XCTAssertNil(PairingAddress.baseURL(from: "   "))
    }

    // MARK: Host replies

    func testPairReplyMapping() throws {
        let url = URL(string: "http://mybox:47890")!
        let ok = try HTTPPairingService.grant(
            status: 200,
            body: Data(#"{"ok":true,"token":"abc123","hostId":"h1","hostName":"Box"}"#.utf8),
            baseURL: url
        )
        XCTAssertEqual(ok, PairGrant(token: "abc123", hostId: "h1", hostName: "Box", baseURL: url))

        XCTAssertThrowsError(try HTTPPairingService.grant(status: 401, body: Data(#"{"ok":false,"error":"bad code"}"#.utf8), baseURL: url)) {
            XCTAssertEqual($0 as? PairingError, .wrongCode("bad code"))
        }
        XCTAssertThrowsError(try HTTPPairingService.grant(status: 429, body: Data(), baseURL: url)) {
            XCTAssertEqual($0 as? PairingError, .tooManyAttempts)
        }
        XCTAssertThrowsError(try HTTPPairingService.grant(status: 200, body: Data(#"{"ok":true}"#.utf8), baseURL: url)) { error in
            guard case PairingError.server = error else { return XCTFail("expected a server error, got \(error)") }
        }
        XCTAssertThrowsError(try HTTPPairingService.grant(status: 404, body: Data(), baseURL: url)) { error in
            guard case PairingError.server = error else { return XCTFail("expected a server error, got \(error)") }
        }
    }

    func testInfoReplyFromTheHostDecodesAndHostErrorTextIsShown() throws {
        // The live host's reply, including a field this app does not use.
        let body = Data(#"{"ok":true,"hostId":"0d3e47acf766bbac","hostName":"archlinux","version":"0.1.0","pairingOpen":false,"protocolVersion":2}"#.utf8)
        let info = try JSONDecoder().decode(PairInfo.self, from: body)
        XCTAssertEqual(info.hostName, "archlinux")
        XCTAssertEqual(info.hostId, "0d3e47acf766bbac")
        XCTAssertEqual(info.pairingOpen, false)

        XCTAssertEqual(PairingError.wrongCode("Pairing isn’t open.").errorDescription, "Pairing isn’t open.")
        XCTAssertEqual(PairingError.wrongCode(nil).errorDescription?.hasPrefix("That code didn’t work"), true)
    }

    // MARK: Choosing an address

    func testPairingUsesTheBestRankedAddressThatAnswers() async throws {
        let urls = ["tailnet-name", "100.64.0.3", "192.168.0.3"].compactMap { PairingAddress.baseURL(from: $0) }
        // The Tailscale name does not resolve on this network; the two IPs answer.
        let service = MockPairingService(reachableHosts: ["100.64.0.3", "192.168.0.3"], hostId: "h1", hostName: "Box")
        let grant = try await PairingFlow.pair(candidates: urls, expectedHostId: "h1", code: "123 456", deviceName: "Phone", deviceId: "d1", service: service)
        XCTAssertEqual(grant.baseURL.host, "100.64.0.3")
        XCTAssertEqual(grant.hostName, "Box")
        XCTAssertEqual(service.pairCalls.map(\.code), ["123456"])
    }

    func testPairingFailsClearlyWhenNothingAnswersOrTheDesktopDiffers() async {
        let urls = ["a", "b"].compactMap { PairingAddress.baseURL(from: $0) }
        let nothing = MockPairingService(reachableHosts: ["elsewhere"])
        do {
            _ = try await PairingFlow.pair(candidates: urls, expectedHostId: "", code: "123456", deviceName: "P", deviceId: "d", service: nothing)
            XCTFail("expected unreachable")
        } catch { XCTAssertEqual(error as? PairingError, .unreachable) }

        let other = MockPairingService(reachableHosts: ["a"], hostId: "someone-else")
        do {
            _ = try await PairingFlow.pair(candidates: urls, expectedHostId: "h1", code: "123456", deviceName: "P", deviceId: "d", service: other)
            XCTFail("expected differentDesktop")
        } catch { XCTAssertEqual(error as? PairingError, .differentDesktop) }

        let closed = MockPairingService(reachableHosts: ["a"], pairingOpen: false)
        do {
            _ = try await PairingFlow.pair(candidates: urls, expectedHostId: "", code: "123456", deviceName: "P", deviceId: "d", service: closed)
            XCTFail("expected pairingClosed")
        } catch { XCTAssertEqual(error as? PairingError, .pairingClosed) }

        do {
            _ = try await PairingFlow.pair(candidates: urls, expectedHostId: "", code: "12", deviceName: "P", deviceId: "d", service: other)
            XCTFail("expected invalidCode")
        } catch { XCTAssertEqual(error as? PairingError, .invalidCode) }
    }

    func testWrongCodeIsReportedAndTheCodeBurnsAfterFiveTries() async {
        let url = PairingAddress.baseURL(from: "box")!
        let service = MockPairingService()
        for _ in 0..<5 {
            do {
                _ = try await service.pair(baseURL: url, code: "000000", deviceName: "P", deviceId: "d")
                XCTFail("expected wrongCode")
            } catch { XCTAssertEqual(error as? PairingError, .wrongCode(nil)) }
        }
        do {
            _ = try await service.pair(baseURL: url, code: MockPairingService.demoCode, deviceName: "P", deviceId: "d")
            XCTFail("expected tooManyAttempts")
        } catch { XCTAssertEqual(error as? PairingError, .tooManyAttempts) }
    }

    // MARK: Store

    private func freshDefaults() -> UserDefaults {
        UserDefaults(suiteName: "PairingTests.\(UUID().uuidString)")!
    }

    @MainActor func testAFreshInstallNeedsPairingAndDropsALeftoverKeychainToken() {
        let keychain = InMemoryKeychainStore()
        // The Keychain survives deleting the app; the old token is still there on reinstall.
        try? keychain.saveToken("left-over-token", for: "desktop-control-server")
        let store = AppStore(keychain: keychain, defaults: freshDefaults(), environment: [:], pairingService: MockPairingService())
        defer { store.stopEventStream() }
        XCTAssertEqual(store.connectionMode, .live, "demo mode is off by default")
        XCTAssertFalse(store.isPaired)
        XCTAssertTrue(store.needsPairing)
        XCTAssertNil(keychain.loadToken(for: "desktop-control-server"))
    }

    @MainActor func testAStoredAddressAndLegacyTokenStillConnect() {
        let keychain = InMemoryKeychainStore()
        let defaults = freshDefaults()
        try? keychain.saveToken("legacy-shared-token", for: "desktop-control-server")
        defaults.set("http://100.64.0.3:47890", forKey: "sh.hostURL")
        defaults.set("live", forKey: "sh.connectionMode")
        let store = AppStore(keychain: keychain, defaults: defaults, environment: [:], pairingService: MockPairingService())
        defer { store.stopEventStream() }
        XCTAssertTrue(store.isPaired)
        XCTAssertFalse(store.needsPairing)
        XCTAssertEqual(store.bearerToken, "legacy-shared-token")
        XCTAssertEqual(keychain.loadToken(for: "desktop-control-server"), "legacy-shared-token")
    }

    @MainActor func testPairingStoresTheDeviceTokenAndUnpairForgetsIt() async throws {
        let keychain = InMemoryKeychainStore()
        let defaults = freshDefaults()
        // SH_MOCK_PAIRING: after pairing the app loads demo data instead of calling a real host.
        let service = MockPairingService(hostId: "h1", hostName: "Studio")
        let store = AppStore(keychain: keychain, defaults: defaults, environment: ["SH_MOCK_PAIRING": "1"], pairingService: service)
        defer { store.stopEventStream() }
        XCTAssertTrue(store.needsPairing)

        do {
            try await store.pair(candidates: [PairingAddress.baseURL(from: "studio.local")!], expectedHostId: "h1", code: "999999")
            XCTFail("expected wrongCode")
        } catch { XCTAssertEqual(error as? PairingError, .wrongCode(nil)) }
        XCTAssertTrue(store.needsPairing, "a wrong code leaves the app unpaired")

        try await store.pair(candidates: [PairingAddress.baseURL(from: "studio.local")!], expectedHostId: "h1", code: MockPairingService.demoCode)
        XCTAssertTrue(store.isPaired)
        XCTAssertFalse(store.needsPairing)
        XCTAssertEqual(store.pairedHostName, "Studio")
        XCTAssertEqual(store.hostURLString, "http://studio.local:47890")
        XCTAssertEqual(keychain.loadToken(for: "desktop-control-server"), "mock-device-token")
        XCTAssertEqual(defaults.string(forKey: "sh.pairedHostName"), "Studio")
        XCTAssertFalse(store.sessions.isEmpty, "sessions load after pairing")

        await store.unpairFromDesktop()
        XCTAssertEqual(service.unpairCalls.map(\.token), ["mock-device-token"], "the desktop is told to drop this phone")
        XCTAssertEqual(service.unpairCalls.first?.url.absoluteString, "http://studio.local:47890")
        XCTAssertTrue(store.needsPairing)
        XCTAssertNil(keychain.loadToken(for: "desktop-control-server"))
        XCTAssertNil(defaults.string(forKey: "sh.hostURL"))
        XCTAssertTrue(store.sessions.isEmpty)
        XCTAssertEqual(store.pairedHostName, "")
    }

    @MainActor func testARevokedTokenReturnsToThePairingScreenWithAReason() async {
        let keychain = InMemoryKeychainStore()
        let defaults = freshDefaults()
        try? keychain.saveToken("device-token", for: "desktop-control-server")
        defaults.set("http://100.64.0.3:47890", forKey: "sh.hostURL")
        defaults.set("live", forKey: "sh.connectionMode")
        let client = MockSuperHarnessClient()
        await client.setSimulateUnauthorized(true)
        let store = AppStore(client: client, keychain: keychain, defaults: defaults, environment: [:], pairingService: MockPairingService())
        defer { store.stopEventStream() }
        XCTAssertFalse(store.needsPairing)

        await store.bootstrap()
        XCTAssertTrue(store.needsPairing)
        XCTAssertEqual(store.pairingNotice, AppStore.revokedNotice)
        XCTAssertNil(keychain.loadToken(for: "desktop-control-server"))
    }

    @MainActor func testMicIsUnavailableOnlyWhenTheDesktopHasNoDictationServer() {
        let store = AppStore(client: MockSuperHarnessClient(), keychain: InMemoryKeychainStore(), defaults: freshDefaults(), environment: [:])
        defer { store.stopEventStream() }
        XCTAssertNil(store.dictationUnavailableReason, "unknown status does not disable the mic")
        store.dictationStatus = DictationStatusResponse(ok: true, configured: false, healthy: false)
        XCTAssertEqual(store.dictationUnavailableReason, "Set up dictation in Super Harness on your desktop")
        store.dictationStatus = DictationStatusResponse(ok: true, configured: true, healthy: true)
        XCTAssertNil(store.dictationUnavailableReason)
    }
}
