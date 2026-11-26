import Foundation

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
    func fetchDictationStatus(overrideURL: String?, overrideToken: String?) async -> DictationStatusResponse?
    func transcribeAudio(wavData: Data, overrideURL: String?, overrideToken: String?) async throws -> String
    func sendMessage(sessionId: String, message: String, attachments: [ImageAttachment]) async throws -> SendMessageResult
    func sendMessage(sessionId: String, message: String, attachments: [ImageAttachment], mode: SendMode) async throws -> SendMessageResult
    func abortRun(sessionId: String) async throws -> Bool
    func startSession(_ request: StartSessionRequest) async throws -> StartSessionResponse
    func organize(actions: [OrganizeAction]) async throws -> OrganizeResponse
    func archiveSession(sessionId: String, killTmux: Bool) async throws -> ArchiveResponse
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
    func sendMessage(sessionId: String, message: String, attachments: [ImageAttachment], mode: SendMode) async throws -> SendMessageResult {
        try await sendMessage(sessionId: sessionId, message: message, attachments: attachments)
    }

    func uploadAttachmentData(_ data: Data, mimeType: String, filename: String?) async throws -> ImageAttachment {
        let dataUrl = "data:\(mimeType);base64,\(data.base64EncodedString())"
        return try await uploadAttachment(dataUrl: dataUrl, filename: filename)
    }

    func registerPushDevice(rid: String, relayUrl: String, enabled: Bool) async -> Bool { false }
    func sendTestPush() async throws -> Bool { false }
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
        if !token.isEmpty {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw SuperHarnessAPIError.httpError(0, "Invalid HTTP response")
        }
        switch http.statusCode {
        case 200..<300:
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

    public func fetchDictationStatus(overrideURL: String? = nil, overrideToken: String? = nil) async -> DictationStatusResponse? {
        guard let url = makeURL(path: "/api/dictate/status") else { return nil }
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.timeoutInterval = 8
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if !token.isEmpty {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        if let overrideURL, !overrideURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            req.setValue(overrideURL.trimmingCharacters(in: .whitespacesAndNewlines), forHTTPHeaderField: "X-Dictation-URL")
        }
        if let overrideToken, !overrideToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            req.setValue(overrideToken.trimmingCharacters(in: .whitespacesAndNewlines), forHTTPHeaderField: "X-Dictation-Token")
        }
        guard let (data, response) = try? await session.data(for: req),
              let http = response as? HTTPURLResponse,
              (200..<300).contains(http.statusCode) else {
            return nil
        }
        return try? decoder.decode(DictationStatusResponse.self, from: data)
    }

    public func transcribeAudio(wavData: Data, overrideURL: String? = nil, overrideToken: String? = nil) async throws -> String {
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
        if let overrideURL, !overrideURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            req.setValue(overrideURL.trimmingCharacters(in: .whitespacesAndNewlines), forHTTPHeaderField: "X-Dictation-URL")
        }
        if let overrideToken, !overrideToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            req.setValue(overrideToken.trimmingCharacters(in: .whitespacesAndNewlines), forHTTPHeaderField: "X-Dictation-Token")
        }

        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse else {
            throw SuperHarnessAPIError.httpError(0, "Invalid HTTP response")
        }
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
        req.setValue(mimeType.isEmpty ? "application/octet-stream" : mimeType, forHTTPHeaderField: "Content-Type")
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
