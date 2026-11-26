import XCTest
@testable import SuperHarness

final class SSEParserTests: XCTestCase {
    func testParsesEventTypeAndMultilineDataAndIgnoresComments() {
        var parser = SSEParser()
        let raw = """
        : keep-alive heartbeat
        event: stream
        id: evt-42
        retry: 3000
        data: {"line":1}
        data: {"line":2}

        """

        let frames = parser.feed(chunk: raw)
        XCTAssertEqual(frames.count, 1)
        XCTAssertEqual(frames[0].event, "stream")
        XCTAssertEqual(frames[0].id, "evt-42")
        XCTAssertEqual(frames[0].retry, 3000)
        XCTAssertEqual(frames[0].data, "{\"line\":1}\n{\"line\":2}")
    }

    func testHandlesCRLFAndDefaultMessageEvent() {
        var parser = SSEParser()
        XCTAssertNil(parser.feed(line: "data: hello\r"))
        XCTAssertNil(parser.feed(line: "data: world\r"))
        let frame = parser.feed(line: "\r")
        XCTAssertEqual(frame, SSEFrame(event: "message", data: "hello\nworld"))
    }

    func testMultipleSequentialEventsResetStateProperly() {
        var parser = SSEParser()
        let chunk = "event: connected\ndata: {\"ok\":true}\n\n: comment\ndata: second\n\n"
        let frames = parser.feed(chunk: chunk)
        XCTAssertEqual(frames.count, 2)
        XCTAssertEqual(frames[0], SSEFrame(event: "connected", data: "{\"ok\":true}"))
        XCTAssertEqual(frames[1], SSEFrame(event: "message", data: "second"))
    }

    func testFlushEmitsTrailingEventWithoutBlankLine() {
        var parser = SSEParser()
        _ = parser.feed(line: "event: usage")
        _ = parser.feed(line: "data: {\"ok\":1}")
        let frame = parser.flush()
        XCTAssertEqual(frame, SSEFrame(event: "usage", data: "{\"ok\":1}"))
        XCTAssertNil(parser.flush())
    }

    func testTracksLastEventIdAcrossFramesAndParsesResyncRequired() {
        var parser = SSEParser()
        let chunk = """
        id: 101
        event: connected
        data: {"ok":true,"protocolVersion":1,"seq":101}

        id: 250
        event: resync_required
        data: {"reason":"buffer_gap","lastSeq":101,"currentSeq":250}

        event: sessions
        data: {"sessions":[]}

        """
        let frames = parser.feed(chunk: chunk)
        XCTAssertEqual(frames.count, 3)
        XCTAssertEqual(frames[0].id, "101")
        XCTAssertEqual(frames[1].event, "resync_required")
        XCTAssertEqual(frames[1].id, "250")
        // Per SSE spec, frames without an id field preserve the last seen event ID
        XCTAssertEqual(frames[2].id, "250")
        XCTAssertEqual(parser.lastEventId, "250")

        let url = URL(string: "http://100.64.0.10:47890/api/events?clientId=abc")!
        let req = SSEClient.makeRequest(url: url, bearerToken: "tok", lastEventId: parser.lastEventId)
        XCTAssertEqual(req.value(forHTTPHeaderField: "Last-Event-ID"), "250")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer tok")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Accept"), "text/event-stream")
    }
}
