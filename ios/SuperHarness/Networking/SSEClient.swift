import Foundation

public struct SSEFrame: Sendable, Equatable {
    public var event: String
    public var data: String
    public var id: String?
    public var retry: Int?

    public init(event: String = "message", data: String, id: String? = nil, retry: Int? = nil) {
        self.event = event
        self.data = data
        self.id = id
        self.retry = retry
    }
}

/// Spec-compliant incremental Server-Sent Events parser.
public struct SSEParser: Sendable {
    private var currentEvent: String?
    private var dataLines: [String] = []
    private var currentId: String?
    private var currentRetry: Int?

    public var lastEventId: String? { currentId }

    public init() {}

    /// Feeds one line (with or without trailing `\r`). Returns an `SSEFrame` when a blank line terminates an event.
    public mutating func feed(line rawLine: String) -> SSEFrame? {
        let line: String
        if rawLine.hasSuffix("\r") {
            line = String(rawLine.dropLast())
        } else {
            line = rawLine
        }

        // Blank line dispatches accumulated frame
        if line.isEmpty {
            return flush()
        }

        // Comment line
        if line.hasPrefix(":") {
            return nil
        }

        let field: String
        let value: String
        if let colonIndex = line.firstIndex(of: ":") {
            field = String(line[..<colonIndex])
            var rest = line[line.index(after: colonIndex)...]
            if rest.first == " " {
                rest = rest.dropFirst()
            }
            value = String(rest)
        } else {
            field = line
            value = ""
        }

        switch field {
        case "event":
            currentEvent = value
        case "data":
            dataLines.append(value)
        case "id":
            if !value.contains("\0") {
                currentId = value
            }
        case "retry":
            if let ms = Int(value.trimmingCharacters(in: .whitespaces)), ms >= 0 {
                currentRetry = ms
            }
        default:
            break
        }
        return nil
    }

    /// Feeds a chunk containing one or more lines separated by `\n` or `\r\n`.
    public mutating func feed(chunk: String) -> [SSEFrame] {
        var frames: [SSEFrame] = []
        let lines = chunk.split(separator: "\n", omittingEmptySubsequences: false)
        for line in lines {
            if let frame = feed(line: String(line)) {
                frames.append(frame)
            }
        }
        return frames
    }

    /// Flushes any pending event buffer (e.g. at EOF).
    public mutating func flush() -> SSEFrame? {
        defer {
            currentEvent = nil
            dataLines.removeAll(keepingCapacity: true)
            currentRetry = nil
        }
        guard !dataLines.isEmpty else {
            return nil
        }
        let eventName = (currentEvent?.isEmpty == false) ? currentEvent! : "message"
        return SSEFrame(
            event: eventName,
            data: dataLines.joined(separator: "\n"),
            id: currentId,
            retry: currentRetry
        )
    }
}

/// Async SSE client with automatic exponential backoff reconnect.
public final class SSEClient: Sendable {
    private let session: URLSession

    public init(session: URLSession? = nil) {
        if let session {
            self.session = session
        } else {
            let config = URLSessionConfiguration.default
            // Desktop sends `: ping` every 25s; 65s promptly detects dead/half-open sockets.
            config.timeoutIntervalForRequest = 65
            config.timeoutIntervalForResource = 0
            config.waitsForConnectivity = false
            self.session = URLSession(configuration: config)
        }
    }

    public static func makeRequest(url: URL, bearerToken: String, lastEventId: String?) -> URLRequest {
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        if !bearerToken.isEmpty {
            request.setValue("Bearer \(bearerToken)", forHTTPHeaderField: "Authorization")
        }
        if let lastEventId, !lastEventId.isEmpty {
            request.setValue(lastEventId, forHTTPHeaderField: "Last-Event-ID")
        }
        return request
    }

    public func stream(
        url: URL,
        bearerToken: String,
        initialLastEventId: String? = nil,
        latestEventId: (@Sendable () -> String?)? = nil,
        onStateChange: (@Sendable (Bool, String?) -> Void)? = nil,
        onEventIdUpdate: (@Sendable (String) -> Void)? = nil
    ) -> AsyncStream<SSEFrame> {
        AsyncStream { continuation in
            let task = Task {
                var backoffNs: UInt64 = 1_000_000_000
                let maxBackoffNs: UInt64 = 3_000_000_000
                var lastEventId: String? = initialLastEventId

                while !Task.isCancelled {
                    do {
                        // A full refresh fetched since the last frame is newer than that frame.
                        // Resuming from it stops the host replaying events the refresh covers.
                        let resumeId = latestEventId?() ?? lastEventId
                        let request = Self.makeRequest(url: url, bearerToken: bearerToken, lastEventId: resumeId)

                        let (bytes, response) = try await session.bytes(for: request)
                        guard let http = response as? HTTPURLResponse else {
                            throw URLError(.badServerResponse)
                        }
                        guard (200..<300).contains(http.statusCode) else {
                            throw NSError(
                                domain: "SSEClient",
                                code: http.statusCode,
                                userInfo: [NSLocalizedDescriptionKey: "HTTP \(http.statusCode)"]
                            )
                        }

                        backoffNs = 1_000_000_000
                        onStateChange?(true, nil)

                        var parser = SSEParser()
                        var lineBuffer = Data()
                        for try await byte in bytes {
                            if Task.isCancelled { break }
                            if byte == 0x0A { // '\n'
                                let line = String(decoding: lineBuffer, as: UTF8.self)
                                lineBuffer.removeAll(keepingCapacity: true)
                                if let frame = parser.feed(line: line) {
                                    if let id = frame.id, !id.isEmpty {
                                        lastEventId = id
                                        onEventIdUpdate?(id)
                                    }
                                    if let retryMs = frame.retry {
                                        backoffNs = UInt64(max(500, min(retryMs, 3_000))) * 1_000_000
                                    }
                                    continuation.yield(frame)
                                }
                            } else {
                                lineBuffer.append(byte)
                            }
                        }

                        if !lineBuffer.isEmpty {
                            let trailing = String(decoding: lineBuffer, as: UTF8.self)
                            _ = parser.feed(line: trailing)
                        }
                        if let finalFrame = parser.flush() {
                            if let id = finalFrame.id, !id.isEmpty {
                                lastEventId = id
                                onEventIdUpdate?(id)
                            }
                            continuation.yield(finalFrame)
                        }
                        onStateChange?(false, "Stream closed")
                    } catch {
                        if Task.isCancelled { break }
                        onStateChange?(false, error.localizedDescription)
                    }

                    guard !Task.isCancelled else { break }
                    try? await Task.sleep(nanoseconds: backoffNs)
                    backoffNs = min(backoffNs * 2, maxBackoffNs)
                }

                continuation.finish()
            }

            continuation.onTermination = { _ in
                task.cancel()
            }
        }
    }
}
