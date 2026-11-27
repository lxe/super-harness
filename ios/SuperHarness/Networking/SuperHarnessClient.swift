import Foundation
import ImageIO

public enum SuperHarnessServerEvent: Sendable {
    case connected
    case disconnected(String?)
    case resyncRequired
    case stream(StreamEvent)
    case transcript(SessionTranscriptResult)
    case sessions(harnesses: [HarnessDetection]?, sessions: [UnifiedSession], workingSessionIds: [String]? = nil)
    case sessionsDelta(SessionsDeltaEnvelope)
    case activity([String])
    case usage(UsageSnapshot)
    case state(SuperHarnessState)
}

public struct ConnectionTestResult: Sendable, Equatable {
    public var ok: Bool
    public var latencyMs: Int
    public var harnessCount: Int
    public var message: String

    public init(ok: Bool, latencyMs: Int, harnessCount: Int, message: String) {
        self.ok = ok
        self.latencyMs = latencyMs
        self.harnessCount = harnessCount
        self.message = message
    }
}

public enum SuperHarnessAPIError: LocalizedError, Sendable {
    case invalidURL(String)
    case unauthorized
    case notFound(String)
    case httpError(Int, String)
    case decodingError(String)

    public var errorDescription: String? {
        switch self {
        case .invalidURL(let raw): return "Invalid host URL: \(raw)"
        case .unauthorized: return "Unauthorized (401). Check your Bearer token."
        case .notFound(let path): return "Endpoint not available on host: \(path)"
        case .httpError(let code, let body): return "HTTP \(code): \(body)"
        case .decodingError(let msg): return "Response decoding error: \(msg)"
        }
    }
}

public protocol SuperHarnessClientProtocol: Sendable {
    func fetchBootstrap() async throws -> BootstrapPayload
    func fetchSessions(query: String?, harness: HarnessGroup?, liveOnly: Bool) async throws -> [UnifiedSession]
    func fetchHarnesses() async throws -> [HarnessDetection]
    func fetchTranscript(sessionId: String, limit: Int) async throws -> SessionTranscriptResult
    func fetchUsage(force: Bool) async throws -> UsageSnapshot?
    func fetchCatalog(force: Bool) async throws -> HarnessCatalog?
    func watchSession(sessionId: String?, limit: Int) async
    func fetchMedia(path: String) async throws -> Data
    func fetchMedia(path: String, maxWidth: Int?) async throws -> Data
    /// `ignoreLocalCache` skips the HTTP cache, for a retry after a response that was missing or unusable.
    func fetchMedia(path: String, maxWidth: Int?, ignoreLocalCache: Bool) async throws -> Data
    /// Dictation always goes through the host, which proxies to the server set on the desktop.
    func fetchDictationStatus() async -> DictationStatusResponse?
    func transcribeAudio(wavData: Data) async throws -> String
    func sendMessage(sessionId: String, message: String, attachments: [ImageAttachment]) async throws -> SendMessageResult
    func sendMessage(sessionId: String, message: String, attachments: [ImageAttachment], mode: SendMode) async throws -> SendMessageResult
    func abortRun(sessionId: String) async throws -> Bool
    func startSession(_ request: StartSessionRequest) async throws -> StartSessionResponse
    func organize(actions: [OrganizeAction]) async throws -> OrganizeResponse
    func fetchFolders() async throws -> FoldersResponse
    func updateSettings(sidebarGroupBy: SidebarGroupBy) async throws -> SuperHarnessSettings?
    func updateSettings(harnessOrder: [String]) async throws -> SuperHarnessSettings?
    func archiveSession(sessionId: String, killTmux: Bool) async throws -> ArchiveResponse
    func setSessionUnread(sessionId: String, unread: Bool) async throws
    func controlHarness(harness: HarnessGroup, action: HarnessControlAction) async throws -> ControlHarnessResponse
    func uploadAttachment(dataUrl: String, filename: String?) async throws -> ImageAttachment
    func uploadAttachmentData(_ data: Data, mimeType: String, filename: String?) async throws -> ImageAttachment
    func registerPushDevice(rid: String, relayUrl: String, enabled: Bool) async -> Bool
    func sendTestPush() async throws -> Bool
    func testConnection() async throws -> ConnectionTestResult
    func eventStream() -> AsyncStream<SuperHarnessServerEvent>
}

public extension SuperHarnessClientProtocol {
    func fetchMedia(path: String, maxWidth: Int?) async throws -> Data {
        try await fetchMedia(path: path)
    }
    func fetchMedia(path: String, maxWidth: Int?, ignoreLocalCache: Bool) async throws -> Data {
        try await fetchMedia(path: path, maxWidth: maxWidth)
    }
    func sendMessage(sessionId: String, message: String, attachments: [ImageAttachment], mode: SendMode) async throws -> SendMessageResult {
        try await sendMessage(sessionId: sessionId, message: message, attachments: attachments)
    }

    func uploadAttachmentData(_ data: Data, mimeType: String, filename: String?) async throws -> ImageAttachment {
        let dataUrl = "data:\(mimeType);base64,\(data.base64EncodedString())"
        return try await uploadAttachment(dataUrl: dataUrl, filename: filename)
    }

    func registerPushDevice(rid: String, relayUrl: String, enabled: Bool) async -> Bool { false }
    func sendTestPush() async throws -> Bool { false }
    func fetchFolders() async throws -> FoldersResponse { FoldersResponse() }
    func updateSettings(sidebarGroupBy: SidebarGroupBy) async throws -> SuperHarnessSettings? { nil }
    func updateSettings(harnessOrder: [String]) async throws -> SuperHarnessSettings? { nil }
}

private final class LockedEventIdBox: @unchecked Sendable {
    private let lock = NSLock()
    private var value: String?

    func get() -> String? {
        lock.lock()
        defer { lock.unlock() }
        return value
    }

    func set(_ next: String?) {
        lock.lock()
        defer { lock.unlock() }
        value = next
    }
}

public final class LiveSuperHarnessClient: SuperHarnessClientProtocol, Sendable {
    private static let clientIdDefaultsKey = "sh.mobileClientId"

    public let baseURL: URL
    public let clientId: String
    private let token: String
    private let session: URLSession
    private let sseClient: SSEClient
    private let decoder: JSONDecoder
    private let encoder: JSONEncoder
    private let lastEventIdBox = LockedEventIdBox()

    private static func makeDedicatedSession() -> URLSession {
        let cfg = URLSessionConfiguration.default
        cfg.httpMaximumConnectionsPerHost = 8
        cfg.waitsForConnectivity = false
        cfg.requestCachePolicy = .useProtocolCachePolicy
        cfg.urlCache = URLCache(memoryCapacity: 16 * 1024 * 1024, diskCapacity: 64 * 1024 * 1024)
        cfg.timeoutIntervalForRequest = 45
        cfg.timeoutIntervalForResource = 120
        return URLSession(configuration: cfg)
    }

    public init(
        baseURL: URL,
        token: String,
        session: URLSession? = nil,
        clientId: String? = nil,
        defaults: UserDefaults = .standard
    ) {
        self.baseURL = baseURL
        self.token = token
        self.session = session ?? Self.makeDedicatedSession()
        self.sseClient = SSEClient()
        self.decoder = JSONDecoder()
        self.encoder = JSONEncoder()
        if let clientId, !clientId.isEmpty {
            self.clientId = clientId
        } else if let stored = defaults.string(forKey: Self.clientIdDefaultsKey), !stored.isEmpty {
            self.clientId = stored
        } else {
            let generated = UUID().uuidString.lowercased()
            defaults.set(generated, forKey: Self.clientIdDefaultsKey)
            self.clientId = generated
        }
    }

    public static func normalizeBaseURL(_ raw: String) throws -> URL {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw SuperHarnessAPIError.invalidURL(raw)
        }
        let withScheme = trimmed.contains("://") ? trimmed : "http://\(trimmed)"
        let withoutTrailingSlash = withScheme.hasSuffix("/") ? String(withScheme.dropLast()) : withScheme
        guard let url = URL(string: withoutTrailingSlash), url.host != nil else {
            throw SuperHarnessAPIError.invalidURL(raw)
        }
        return url
    }

    public func fetchBootstrap() async throws -> BootstrapPayload {
        do {
            let payload: BootstrapPayload = try await request(path: "/api/bootstrap", method: "GET")
            if let seq = payload.seq, seq > 0 {
                lastEventIdBox.set(String(seq))
            }
            return payload
        } catch SuperHarnessAPIError.notFound {
            // Graceful fallback to existing controlServer.ts endpoints
            async let harnessesTask = fetchHarnesses()
            async let sessionsTask = fetchSessions(query: nil, harness: nil, liveOnly: false)
            async let usageTask = try? fetchUsage(force: false)
            async let catalogTask = try? fetchCatalog(force: false)

            let harnesses = try await harnessesTask
            let sessions = try await sessionsTask
            let usage = await usageTask
            let catalog = await catalogTask

            var merged = sessions
            if !merged.contains(where: { $0.isMaster }) {
                merged.insert(Self.syntheticMasterSession(), at: 0)
            }
            return BootstrapPayload(
                harnesses: harnesses,
                sessions: merged,
                state: SuperHarnessState(),
                usage: usage,
                catalog: catalog
            )
        }
    }

    public func fetchSessions(query: String?, harness: HarnessGroup?, liveOnly: Bool) async throws -> [UnifiedSession] {
        var items: [URLQueryItem] = []
        if let query, !query.isEmpty {
            items.append(URLQueryItem(name: "q", value: query))
        }
        if let harness {
            items.append(URLQueryItem(name: "harness", value: harness.rawValue))
        }
        if liveOnly {
            items.append(URLQueryItem(name: "live", value: "true"))
        }
        let envelope: SessionsEnvelope = try await request(path: "/api/sessions", method: "GET", queryItems: items)
        return envelope.sessions
    }

    public func fetchHarnesses() async throws -> [HarnessDetection] {
        let envelope: HarnessesEnvelope = try await request(path: "/api/harnesses", method: "GET")
        return envelope.harnesses
    }

    public func fetchTranscript(sessionId: String, limit: Int = 40) async throws -> SessionTranscriptResult {
        try await request(
            path: "/api/transcript",
            method: "GET",
            queryItems: [
                URLQueryItem(name: "sessionId", value: sessionId),
                URLQueryItem(name: "limit", value: "\(limit)"),
                URLQueryItem(name: "compact", value: "1"),
            ]
        )
    }

    public func fetchUsage(force: Bool = false) async throws -> UsageSnapshot? {
        do {
            return try await request(
                path: "/api/usage",
                method: "GET",
                queryItems: [URLQueryItem(name: "force", value: force ? "true" : "false")]
            )
        } catch SuperHarnessAPIError.notFound {
            return nil
        }
    }

    public func fetchCatalog(force: Bool = false) async throws -> HarnessCatalog? {
        do {
            return try await request(
                path: "/api/catalog",
                method: "GET",
                queryItems: [URLQueryItem(name: "force", value: force ? "true" : "false")]
            )
        } catch SuperHarnessAPIError.notFound {
            return nil
        }
    }

    public func watchSession(sessionId: String?, limit: Int = 80) async {
        struct WatchBody: Encodable {
            let clientId: String
            let sessionId: String?
            let limit: Int

            enum CodingKeys: String, CodingKey {
                case clientId, sessionId, limit
            }

            func encode(to encoder: Encoder) throws {
                var c = encoder.container(keyedBy: CodingKeys.self)
                try c.encode(clientId, forKey: .clientId)
                if let sessionId {
                    try c.encode(sessionId, forKey: .sessionId)
                } else {
                    try c.encodeNil(forKey: .sessionId)
                }
                try c.encode(limit, forKey: .limit)
            }
        }
        struct WatchResp: Decodable { let ok: Bool? }
        let body = WatchBody(clientId: clientId, sessionId: sessionId, limit: limit)
        let _: WatchResp? = try? await request(path: "/api/watch", method: "POST", body: body)
    }

    public func fetchMedia(path: String) async throws -> Data {
        try await fetchMedia(path: path, maxWidth: nil)
    }

    public func fetchMedia(path: String, maxWidth: Int?) async throws -> Data {
        try await fetchMedia(path: path, maxWidth: maxWidth, ignoreLocalCache: false)
    }

    public func fetchMedia(path: String, maxWidth: Int?, ignoreLocalCache: Bool) async throws -> Data {
        var items = [URLQueryItem(name: "path", value: path)]
        if let maxWidth, maxWidth > 0 {
            items.append(URLQueryItem(name: "w", value: String(maxWidth)))
        }
        guard let url = makeURL(path: "/api/media", queryItems: items) else {
            throw SuperHarnessAPIError.invalidURL(path)
        }
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.timeoutInterval = 20
        if ignoreLocalCache {
            req.cachePolicy = .reloadIgnoringLocalCacheData
        }
        if !token.isEmpty {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw SuperHarnessAPIError.httpError(0, "Invalid HTTP response")
        }
        switch http.statusCode {
        case 200..<300:
            // The host caches media for up to an hour. A response that cannot be shown (for
            // example a file read while it was still being written) must not be replayed from
            // the HTTP cache on the next attempt.
            if !MediaDataValidator.isUsable(data, forPath: path) {
                session.configuration.urlCache?.removeCachedResponse(for: req)
            }
            return data
        case 401:
            throw SuperHarnessAPIError.unauthorized
        case 404:
            throw SuperHarnessAPIError.notFound("/api/media")
        default:
            let message = String(data: data, encoding: .utf8) ?? "Media request failed"
            throw SuperHarnessAPIError.httpError(http.statusCode, message)
        }
    }

    public func fetchDictationStatus() async -> DictationStatusResponse? {
        guard let url = makeURL(path: "/api/dictate/status") else { return nil }
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.timeoutInterval = 8
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if !token.isEmpty {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        guard let (data, response) = try? await session.data(for: req),
              let http = response as? HTTPURLResponse,
              (200..<300).contains(http.statusCode) else {
            return nil
        }
        return try? decoder.decode(DictationStatusResponse.self, from: data)
    }

    public func transcribeAudio(wavData: Data) async throws -> String {
        guard let url = makeURL(path: "/api/dictate") else {
            throw SuperHarnessAPIError.invalidURL("/api/dictate")
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 45
        req.httpBody = wavData
        let isWav = wavData.count >= 4 && wavData[wavData.startIndex] == 0x52 && wavData[wavData.startIndex + 1] == 0x49 && wavData[wavData.startIndex + 2] == 0x46 && wavData[wavData.startIndex + 3] == 0x46
        req.setValue(isWav ? "audio/wav" : "audio/mp4", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if !token.isEmpty {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        let requestStartedAt = CFAbsoluteTimeGetCurrent()
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw SuperHarnessAPIError.httpError(0, "Invalid HTTP response")
        }
        #if DEBUG
        // Splits the round trip into YapYap time (reported by the host) and everything else
        // (upload, host proxy, response), which is the network overhead to keep near zero.
        struct TimingEnvelope: Decodable {
            struct Timing: Decodable { var readMs: Double?; var yapyapMs: Double? }
            var timing: Timing?
        }
        let totalMs = (CFAbsoluteTimeGetCurrent() - requestStartedAt) * 1000
        if let timing = (try? decoder.decode(TimingEnvelope.self, from: data))?.timing, let yapyapMs = timing.yapyapMs {
            print(String(format: "PERF dictate bytes=%d total_ms=%.0f yapyap_ms=%.0f host_read_ms=%.0f overhead_ms=%.0f",
                         wavData.count, totalMs, yapyapMs, timing.readMs ?? 0, totalMs - yapyapMs))
        } else {
            print(String(format: "PERF dictate bytes=%d total_ms=%.0f (host sent no timing)", wavData.count, totalMs))
        }
        #endif
        if http.statusCode == 401 {
            throw SuperHarnessAPIError.unauthorized
        }
        if http.statusCode == 404 {
            throw SuperHarnessAPIError.notFound("/api/dictate")
        }
        if let parsed = try? decoder.decode(DictationResult.self, from: data) {
            if parsed.ok, let text = parsed.text {
                return text
            }
            throw SuperHarnessAPIError.httpError(http.statusCode, parsed.error ?? "Transcription failed")
        }
        let body = String(data: data, encoding: .utf8) ?? "Transcription failed"
        throw SuperHarnessAPIError.httpError(http.statusCode, body)
    }

    public func sendMessage(sessionId: String, message: String, attachments: [ImageAttachment]) async throws -> SendMessageResult {
        try await sendMessage(sessionId: sessionId, message: message, attachments: attachments, mode: .steer)
    }

    public func sendMessage(sessionId: String, message: String, attachments: [ImageAttachment], mode: SendMode) async throws -> SendMessageResult {
        struct SendBody: Encodable {
            let sessionId: String
            let message: String
            let attachments: [ImageAttachment]?
            let mode: String
            let force: Bool
        }
        // Avoid re-uploading megabytes of base64 previewDataUrl when the attachment is already stored on host.
        let wireAttachments: [ImageAttachment]? = attachments.isEmpty ? nil : attachments.map { att in
            guard !att.path.isEmpty else { return att }
            return ImageAttachment(
                id: att.id,
                name: att.name,
                path: att.path,
                mimeType: att.mimeType,
                previewDataUrl: nil,
                sizeBytes: att.sizeBytes
            )
        }
        let body = SendBody(
            sessionId: sessionId,
            message: message,
            attachments: wireAttachments,
            mode: mode.rawValue,
            force: mode == .steer
        )
        return try await request(path: "/api/send", method: "POST", body: body)
    }

    public func abortRun(sessionId: String) async throws -> Bool {
        struct AbortBody: Encodable { let sessionId: String }
        struct AbortResp: Decodable { let ok: Bool }
        do {
            let resp: AbortResp = try await request(path: "/api/abort", method: "POST", body: AbortBody(sessionId: sessionId))
            return resp.ok
        } catch SuperHarnessAPIError.notFound {
            return false
        }
    }

    public func startSession(_ startRequest: StartSessionRequest) async throws -> StartSessionResponse {
        try await request(path: "/api/start", method: "POST", body: startRequest)
    }

    public func organize(actions: [OrganizeAction]) async throws -> OrganizeResponse {
        struct OrganizeBody: Encodable { let actions: [OrganizeAction] }
        return try await request(path: "/api/organize", method: "POST", body: OrganizeBody(actions: actions))
    }

    public func fetchFolders() async throws -> FoldersResponse {
        try await request(path: "/api/folders", method: "GET")
    }

    public func updateSettings(sidebarGroupBy: SidebarGroupBy) async throws -> SuperHarnessSettings? {
        struct SettingsBody: Encodable { let sidebarGroupBy: String }
        let res: UpdateSettingsResponse = try await request(
            path: "/api/settings",
            method: "POST",
            body: SettingsBody(sidebarGroupBy: sidebarGroupBy.rawValue)
        )
        return res.settings
    }

    public func updateSettings(harnessOrder: [String]) async throws -> SuperHarnessSettings? {
        struct SettingsBody: Encodable { let harnessOrder: [String] }
        let res: UpdateSettingsResponse = try await request(
            path: "/api/settings",
            method: "POST",
            body: SettingsBody(harnessOrder: harnessOrder)
        )
        return res.settings
    }

    public func archiveSession(sessionId: String, killTmux: Bool) async throws -> ArchiveResponse {
        struct ArchiveBody: Encodable { let sessionId: String; let killTmux: Bool }
        do {
            return try await request(path: "/api/archive", method: "POST", body: ArchiveBody(sessionId: sessionId, killTmux: killTmux))
        } catch SuperHarnessAPIError.notFound {
            // Fall back to hiding if archive endpoint is not yet wired on host
            _ = try? await organize(actions: [OrganizeAction(type: .hideSession, sessionId: sessionId)])
            return ArchiveResponse(ok: true, method: "hide-fallback", error: nil)
        }
    }

    /// POST /api/sessions/read marks a session read; with `unread: true` it marks it unread.
    public func setSessionUnread(sessionId: String, unread: Bool) async throws {
        struct ReadBody: Encodable { let sessionId: String; let unread: Bool? }
        struct ReadResponse: Decodable { let ok: Bool? }
        let _: ReadResponse = try await request(
            path: "/api/sessions/read",
            method: "POST",
            body: ReadBody(sessionId: sessionId, unread: unread ? true : nil)
        )
    }

    public func controlHarness(harness: HarnessGroup, action: HarnessControlAction) async throws -> ControlHarnessResponse {
        struct ControlBody: Encodable { let harness: HarnessGroup; let action: HarnessControlAction }
        return try await request(path: "/api/control-harness", method: "POST", body: ControlBody(harness: harness, action: action))
    }

    public func uploadAttachment(dataUrl: String, filename: String?) async throws -> ImageAttachment {
        struct AttachmentBody: Encodable { let dataUrl: String; let filename: String? }
        do {
            return try await request(
                path: "/api/attachments",
                method: "POST",
                body: AttachmentBody(dataUrl: dataUrl, filename: filename)
            )
        } catch SuperHarnessAPIError.notFound {
            return ImageAttachment(
                name: filename ?? "image.jpg",
                path: "",
                mimeType: "image/jpeg",
                previewDataUrl: dataUrl
            )
        }
    }

    /// Raw binary upload (zero base64 overhead) supporting images, videos, and arbitrary files up to 50 MB.
    public func uploadAttachmentData(_ data: Data, mimeType: String, filename: String?) async throws -> ImageAttachment {
        guard let url = makeURL(path: "/api/attachments") else {
            throw SuperHarnessAPIError.invalidURL("/api/attachments")
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.timeoutInterval = 120
        req.httpBody = data
        // The host treats an application/json body as its base64 upload form, so a .json file
        // travels as a generic binary; its name keeps the extension.
        let wireType = (mimeType.isEmpty || mimeType.lowercased() == "application/json") ? "application/octet-stream" : mimeType
        req.setValue(wireType, forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let filename, !filename.isEmpty {
            let encoded = filename.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? filename
            req.setValue(encoded, forHTTPHeaderField: "X-Filename")
        }
        if !token.isEmpty {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let (respData, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw SuperHarnessAPIError.httpError(0, "Invalid HTTP response")
        }
        switch http.statusCode {
        case 200..<300:
            return try decoder.decode(ImageAttachment.self, from: respData)
        case 401:
            throw SuperHarnessAPIError.unauthorized
        case 404:
            throw SuperHarnessAPIError.notFound("/api/attachments")
        default:
            let message = String(data: respData, encoding: .utf8) ?? "Attachment upload failed"
            throw SuperHarnessAPIError.httpError(http.statusCode, message)
        }
    }

    public func registerPushDevice(rid: String, relayUrl: String, enabled: Bool) async -> Bool {
        struct PushRegBody: Encodable { let rid: String; let relayUrl: String; let enabled: Bool }
        struct PushRegResp: Decodable { let ok: Bool }
        do {
            let resp: PushRegResp = try await request(
                path: "/api/push/register",
                method: "POST",
                body: PushRegBody(rid: rid, relayUrl: relayUrl, enabled: enabled)
            )
            return resp.ok
        } catch {
            return false
        }
    }

    public func sendTestPush() async throws -> Bool {
        struct PushTestBody: Encodable { let title: String; let body: String }
        struct PushTestResp: Decodable { let ok: Bool }
        let resp: PushTestResp = try await request(
            path: "/api/push/test",
            method: "POST",
            body: PushTestBody(title: "Super Harness", body: "Push notifications are active!")
        )
        return resp.ok
    }

    public func testConnection() async throws -> ConnectionTestResult {
        let start = Date()
        do {
            let health: HealthCheckResponse = try await request(path: "/api/health", method: "GET")
            let ms = Int(Date().timeIntervalSince(start) * 1000.0)
            let harnesses = (try? await fetchHarnesses()) ?? []
            let installedCount = harnesses.filter(\.installed).count
            let protoSuffix = health.protocolVersion.map { " · Sync v\($0)" } ?? ""
            let harnessSuffix = installedCount > 0 ? " · \(installedCount) harnesses" : ""
            return ConnectionTestResult(
                ok: health.ok,
                latencyMs: ms,
                harnessCount: installedCount,
                message: "Connected (\(ms)ms)\(protoSuffix)\(harnessSuffix)"
            )
        } catch SuperHarnessAPIError.notFound {
            let harnesses = try await fetchHarnesses()
            let ms = Int(Date().timeIntervalSince(start) * 1000.0)
            let installedCount = harnesses.filter(\.installed).count
            return ConnectionTestResult(
                ok: true,
                latencyMs: ms,
                harnessCount: installedCount,
                message: "Connected (\(ms)ms) · \(installedCount) harnesses detected"
            )
        }
    }

    public func eventStream() -> AsyncStream<SuperHarnessServerEvent> {
        guard let url = makeURL(
            path: "/api/events",
            queryItems: [URLQueryItem(name: "clientId", value: clientId)]
        ) else {
            return AsyncStream { $0.finish() }
        }
        let idBox = lastEventIdBox
        return AsyncStream { continuation in
            let frames = sseClient.stream(
                url: url,
                bearerToken: token,
                initialLastEventId: idBox.get(),
                latestEventId: { idBox.get() },
                onStateChange: { connected, reason in
                    if connected {
                        continuation.yield(.connected)
                    } else {
                        continuation.yield(.disconnected(reason))
                    }
                },
                onEventIdUpdate: { newId in
                    idBox.set(newId)
                }
            )

            let task = Task {
                let jsonDecoder = JSONDecoder()
                for await frame in frames {
                    if let id = frame.id, !id.isEmpty {
                        idBox.set(id)
                    }
                    if frame.event == "resync_required" {
                        continuation.yield(.resyncRequired)
                        continue
                    }
                    guard let data = frame.data.data(using: .utf8) else { continue }
                    switch frame.event {
                    case "connected":
                        continuation.yield(.connected)
                    case "stream":
                        if let ev = try? jsonDecoder.decode(StreamEvent.self, from: data) {
                            continuation.yield(.stream(ev))
                        }
                    case "transcript":
                        if let tr = try? jsonDecoder.decode(SessionTranscriptResult.self, from: data) {
                            continuation.yield(.transcript(tr))
                        }
                    case "sessions":
                        if let env = try? jsonDecoder.decode(SessionsEnvelope.self, from: data) {
                            continuation.yield(.sessions(harnesses: env.harnesses, sessions: env.sessions, workingSessionIds: env.activeWorkingSessionIds))
                        }
                    case "sessions_delta":
                        if let delta = try? jsonDecoder.decode(SessionsDeltaEnvelope.self, from: data) {
                            continuation.yield(.sessionsDelta(delta))
                        }
                    case "activity":
                        if let env = try? jsonDecoder.decode(ActivityUpdateEnvelope.self, from: data) {
                            continuation.yield(.activity(env.workingSessionIds))
                        }
                    case "usage":
                        if let usage = try? jsonDecoder.decode(UsageSnapshot.self, from: data) {
                            continuation.yield(.usage(usage))
                        }
                    case "state":
                        if let state = try? jsonDecoder.decode(SuperHarnessState.self, from: data) {
                            continuation.yield(.state(state))
                        }
                    default:
                        break
                    }
                }
                continuation.finish()
            }

            continuation.onTermination = { _ in
                task.cancel()
            }
        }
    }

    // MARK: - HTTP Plumbing

    private func makeURL(path: String, queryItems: [URLQueryItem] = []) -> URL? {
        var comps = URLComponents(url: baseURL.appendingPathComponent(path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))), resolvingAgainstBaseURL: false)
        if !queryItems.isEmpty {
            comps?.queryItems = queryItems
            // URLComponents leaves "+" as is, and the host reads "+" in a query as a space,
            // which would turn a file path containing "+" into a 404.
            let encoded = comps?.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
            comps?.percentEncodedQuery = encoded
        }
        return comps?.url
    }

    private func request<Response: Decodable>(
        path: String,
        method: String,
        queryItems: [URLQueryItem] = []
    ) async throws -> Response {
        try await performRequest(path: path, method: method, queryItems: queryItems, bodyData: nil)
    }

    private func request<Body: Encodable, Response: Decodable>(
        path: String,
        method: String,
        queryItems: [URLQueryItem] = [],
        body: Body
    ) async throws -> Response {
        let data = try encoder.encode(body)
        return try await performRequest(path: path, method: method, queryItems: queryItems, bodyData: data)
    }

    private func performRequest<Response: Decodable>(
        path: String,
        method: String,
        queryItems: [URLQueryItem],
        bodyData: Data?
    ) async throws -> Response {
        guard let url = makeURL(path: path, queryItems: queryItems) else {
            throw SuperHarnessAPIError.invalidURL(path)
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.timeoutInterval = 15
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if !token.isEmpty {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let bodyData {
            req.httpBody = bodyData
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw SuperHarnessAPIError.httpError(0, "Invalid HTTP response")
        }
        switch http.statusCode {
        case 200..<300:
            do {
                return try decoder.decode(Response.self, from: data)
            } catch {
                throw SuperHarnessAPIError.decodingError(error.localizedDescription)
            }
        case 401:
            throw SuperHarnessAPIError.unauthorized
        case 404:
            throw SuperHarnessAPIError.notFound(path)
        default:
            let message = String(data: data, encoding: .utf8) ?? "Request failed"
            throw SuperHarnessAPIError.httpError(http.statusCode, message)
        }
    }

    private static func syntheticMasterSession() -> UnifiedSession {
        UnifiedSession(
            id: "master:root",
            nativeId: "root",
            harness: .master,
            harnessGroup: .master,
            title: "Master Orchestrator",
            preview: "Cross-harness control center",
            cwd: "~",
            projectName: "Super Harness",
            model: "Master",
            status: .idle,
            isLive: true,
            pinned: true,
            dispatchMode: .master
        )
    }
}

// MARK: - Media Validation

/// Decides whether bytes returned for a media path can actually be shown. Images must decode
/// completely: a truncated file (read while its writer was still running) is rejected so the
/// caller retries instead of caching a picture that will never render.
public enum MediaDataValidator {
    private static let rasterImageExtensions: Set<String> = ["png", "jpg", "jpeg", "webp", "gif", "heic", "heif", "bmp", "tif", "tiff"]

    public static func isRasterImagePath(_ path: String) -> Bool {
        rasterImageExtensions.contains((path as NSString).pathExtension.lowercased())
    }

    public static func isUsable(_ data: Data, forPath path: String) -> Bool {
        guard !data.isEmpty else { return false }
        guard isRasterImagePath(path) else { return true }
        return isCompleteImage(data)
    }

    /// True when the bytes are a fully present image. The format comes from the bytes, not the
    /// path: the host answers a .png path with WebP. ImageIO decodes a truncated file without
    /// complaint (the missing rows come out blank), so each common format's end marker is
    /// checked first.
    public static func isCompleteImage(_ data: Data) -> Bool {
        let bytes = [UInt8](data.prefix(16))
        func hasPrefix(_ magic: [UInt8]) -> Bool { bytes.count >= magic.count && Array(bytes.prefix(magic.count)) == magic }
        func hasSuffix(_ tail: [UInt8]) -> Bool { data.count >= tail.count && Array(data.suffix(tail.count)) == tail }

        if hasPrefix([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) {
            // PNG ends with an empty IEND chunk and its CRC.
            guard hasSuffix([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82]) else { return false }
        } else if hasPrefix([0xFF, 0xD8, 0xFF]) {
            // JPEG ends with the EOI marker; some encoders append a little padding after it.
            let tail = Array(data.suffix(64))
            guard tail.indices.dropLast().contains(where: { tail[$0] == 0xFF && tail[$0 + 1] == 0xD9 }) else { return false }
        } else if hasPrefix([0x52, 0x49, 0x46, 0x46]), bytes.count >= 12, Array(bytes[8..<12]) == [0x57, 0x45, 0x42, 0x50] {
            // WebP: the RIFF header states the payload size.
            let declared = Int(bytes[4]) | Int(bytes[5]) << 8 | Int(bytes[6]) << 16 | Int(bytes[7]) << 24
            guard data.count >= declared + 8 else { return false }
        } else if hasPrefix([0x47, 0x49, 0x46, 0x38]) {
            guard hasSuffix([0x3B]) else { return false }
        }

        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              CGImageSourceGetCount(source) > 0,
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
            return false
        }
        return image.width > 0 && image.height > 0
    }
}

/// Loads a media item with a few spaced retries. A generated image can be announced in the
/// transcript moments before its file is complete on the host, so one failed or unusable
/// response must not leave a permanent placeholder.
public enum MediaRetryLoader {
    public nonisolated static let defaultDelays: [Double] = [0, 1.5, 4, 10]

    /// Runs on the caller's actor (`#isolation`), so the caller's non-Sendable closures are used in place.
    public static func load<Result>(
        path: String,
        delays: [Double] = defaultDelays,
        isolation: isolated (any Actor)? = #isolation,
        sleep: (Double) async -> Void = { seconds in
            try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
        },
        loader: (String) async -> Data?,
        decode: (Data) -> Result?
    ) async -> Result? {
        for delay in delays {
            if delay > 0 { await sleep(delay) }
            if Task.isCancelled { return nil }
            if let data = await loader(path), let result = decode(data) {
                return result
            }
        }
        return nil
    }
}
