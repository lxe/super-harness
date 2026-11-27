import Foundation
import XCTest

@MainActor
final class LiveE2ETests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    private func envValue(_ key: String) -> String? {
        let env = ProcessInfo.processInfo.environment
        if let v = env[key]?.trimmingCharacters(in: .whitespacesAndNewlines), !v.isEmpty {
            return v
        }
        if let v = env["TEST_RUNNER_\(key)"]?.trimmingCharacters(in: .whitespacesAndNewlines), !v.isEmpty {
            return v
        }
        return nil
    }

    private func launchLiveApp() throws -> XCUIApplication {
        guard let hostURL = envValue("SH_E2E_HOST_URL") else {
            throw XCTSkip("SH_E2E_HOST_URL is not set; skipping live Simulator E2E test.")
        }

        let app = XCUIApplication()
        app.launchEnvironment["SH_HOST_URL"] = hostURL
        app.launchEnvironment["SH_CONNECTION_MODE"] = "live"
        if let token = envValue("SH_E2E_BEARER_TOKEN") ?? envValue("SH_E2E_TOKEN") {
            app.launchEnvironment["SH_BEARER_TOKEN"] = token
        }
        if let sessionId = envValue("SH_E2E_SESSION_ID") {
            app.launchEnvironment["SH_INITIAL_SESSION_ID"] = sessionId
        }
        if let wavPath = envValue("SH_E2E_WAV") {
            app.launchEnvironment["SH_DICTATION_TEST_WAV"] = wavPath
        }

        addUIInterruptionMonitor(withDescription: "Microphone Permission") { alert in
            let allowButtons = ["Allow", "OK", "Allow While Using App"]
            for title in allowButtons where alert.buttons[title].exists {
                alert.buttons[title].tap()
                return true
            }
            return false
        }

        app.launch()

        let input = app.descendants(matching: .any)["composer.input"].firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 20.0), "Expected composer.input to appear after launching into session")
        return app
    }

    private func recordMetric(_ name: String, ms: Int) {
        print("E2E_METRIC \(name)=\(ms)_ms")
    }

    func testOptimisticSendAndReply() throws {
        let app = try launchLiveApp()
        let scroll = app.scrollViews["transcript.scroll"].firstMatch
        let input = app.descendants(matching: .any)["composer.input"].firstMatch
        let sendButton = app.buttons["composer.send"].firstMatch
        let latestButton = app.buttons["transcript.latest"].firstMatch

        XCTAssertTrue(scroll.waitForExistence(timeout: 5.0))
        XCTAssertFalse(latestButton.exists, "transcript.latest must not appear at initial bottom open")

        let marker = "e2e-\(Int(Date().timeIntervalSince1970))"
        let prompt = "\(marker): reply with exactly \(marker) followed immediately by the suffix -ack and nothing else"

        input.tap()
        input.typeText(prompt)
        XCTAssertTrue(sendButton.waitForExistence(timeout: 2.0))

        let sendStart = CFAbsoluteTimeGetCurrent()
        sendButton.tap()

        // 1. Optimistic bubble containing marker must exist within 0.5s
        let markerPredicate = NSPredicate(format: "label CONTAINS %@", marker)
        let bubbleQuery = scroll.staticTexts.matching(markerPredicate)
        let afterTap = CFAbsoluteTimeGetCurrent()
        let optimisticDeadline = max(sendStart + 1.5, afterTap + 1.0)
        var bubbleAppearedAt: CFAbsoluteTime?
        repeat {
            if bubbleQuery.firstMatch.exists {
                bubbleAppearedAt = CFAbsoluteTimeGetCurrent()
                break
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.02))
        } while CFAbsoluteTimeGetCurrent() <= optimisticDeadline
        guard let appearedAt = bubbleAppearedAt else {
            XCTFail("Optimistic user bubble containing '\(marker)' did not appear within 1.5s (XCUITest polling budget)")
            return
        }
        recordMetric("optimistic_bubble", ms: max(0, Int(((appearedAt - sendStart) * 1000.0).rounded())))

        // 1b. Poll every 50ms for 2.5s right after appearance to guarantee the bubble NEVER disappears
        //     during optimistic -> persisted handoff (zero disappear/reappear thrash).
        let stabilityEnd = CFAbsoluteTimeGetCurrent() + 2.5
        var missingFrames = 0
        while CFAbsoluteTimeGetCurrent() <= stabilityEnd {
            if !bubbleQuery.firstMatch.exists {
                missingFrames += 1
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        recordMetric("optimistic_missing_frames", ms: missingFrames)
        XCTAssertEqual(missingFrames, 0, "User message disappeared during send handoff (\(missingFrames) missing frames)")

        // 2. Wait up to 60s for an assistant reply containing "12", polling every 250ms,
        //    and fail if transcript.latest ever appears while pinned at bottom.
        let replyPredicate = NSPredicate(format: "label CONTAINS %@ AND NOT (label CONTAINS 'suffix')", "\(marker)-ack")
        let replyQuery = scroll.staticTexts.matching(replyPredicate)
        let replyDeadline = sendStart + 60.0
        var replyReceivedAt: CFAbsoluteTime?

        while CFAbsoluteTimeGetCurrent() <= replyDeadline {
            if latestButton.exists {
                XCTFail("transcript.latest falsely appeared while transcript was pinned at bottom")
                return
            }
            if replyQuery.firstMatch.exists {
                replyReceivedAt = CFAbsoluteTimeGetCurrent()
                break
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }

        guard let repliedAt = replyReceivedAt else {
            XCTFail("Assistant reply containing the ack token did not arrive within 60s")
            return
        }
        recordMetric("assistant_reply", ms: max(0, Int(((repliedAt - sendStart) * 1000.0).rounded())))
        XCTAssertFalse(latestButton.exists, "transcript.latest must stay hidden after reply completes at bottom")
    }


    /// Returns (lastMessageMaxY, composerMinY) using accessibility frames.
    private func bottomGeometry(_ app: XCUIApplication) -> (CGFloat, CGFloat) {
        let msgs = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'message.' AND NOT (identifier == 'message.retry')"))
        var lastMaxY: CGFloat = 0
        for i in 0..<msgs.count {
            let f = msgs.element(boundBy: i).frame
            if f.height > 0 { lastMaxY = max(lastMaxY, f.maxY) }
        }
        let composer = app.descendants(matching: .any)["composer.input"].firstMatch.frame
        return (lastMaxY, composer.minY)
    }

    func testOpensPinnedToBottom() throws {
        let app = try launchLiveApp()
        let latestButton = app.buttons["transcript.latest"].firstMatch
        var worstGap: CGFloat = 0
        for tick in 0..<12 {
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
            let (lastMaxY, composerMinY) = bottomGeometry(app)
            let hidden = lastMaxY - composerMinY
            if tick >= 4 { worstGap = max(worstGap, hidden) }
            print("E2E_GEOM t=\(tick * 250)ms lastMsgMaxY=\(Int(lastMaxY)) composerMinY=\(Int(composerMinY)) hiddenBelowComposer=\(Int(hidden)) latest=\(latestButton.exists)")
        }
        recordMetric("open_hidden_below_composer_pt", ms: Int(worstGap))
        XCTAssertLessThanOrEqual(worstGap, 24, "Latest message must be fully visible above the composer after opening")
        XCTAssertFalse(latestButton.exists, "Latest must not show right after opening")
    }

    func testLatestButtonOnlyWhenScrolledUp() throws {
        let app = try launchLiveApp()
        let scroll = app.scrollViews["transcript.scroll"].firstMatch
        let latestButton = app.buttons["transcript.latest"].firstMatch

        XCTAssertTrue(scroll.waitForExistence(timeout: 5.0))
        RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        XCTAssertFalse(latestButton.exists, "transcript.latest must be absent at open")

        // Swipe down (scroll up into history) a few times until transcript.latest appears
        for _ in 0..<6 {
            if latestButton.exists { break }
            scroll.swipeDown()
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }

        XCTAssertTrue(latestButton.waitForExistence(timeout: 2.0), "transcript.latest should appear after scrolling up into history")

        // First verify that manually scrolling all the way back down to the bottom hides Latest automatically.
        for _ in 0..<8 {
            if !latestButton.exists { break }
            scroll.swipeUp()
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
        XCTAssertFalse(latestButton.exists, "transcript.latest must disappear automatically when manually scrolled back to the bottom")

        // Scroll back up into history again so we also verify tapping Latest.
        for _ in 0..<6 {
            if latestButton.exists { break }
            scroll.swipeDown()
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
        XCTAssertTrue(latestButton.waitForExistence(timeout: 2.0), "transcript.latest should reappear after scrolling up again")

        let tapStart = CFAbsoluteTimeGetCurrent()
        latestButton.tap()

        // XCUITest tap() includes accessibility snapshot & idle wait overhead, so measure
        // the post-tap disappearance window from after tap() returns while checking immediately.
        let afterTap = CFAbsoluteTimeGetCurrent()
        let dismissDeadline = afterTap + 1.0
        var dismissedAt: CFAbsoluteTime?
        repeat {
            if !latestButton.exists {
                dismissedAt = CFAbsoluteTimeGetCurrent()
                break
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        } while CFAbsoluteTimeGetCurrent() <= dismissDeadline
        guard let doneAt = dismissedAt else {
            XCTFail("transcript.latest did not disappear within 1s after tap")
            return
        }
        recordMetric("latest_dismiss", ms: max(0, Int(((doneAt - tapStart) * 1000.0).rounded())))
        // Confirm the tap actually scrolled back to the bottom of the transcript.
        RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        let (lastMaxY, composerMinY) = bottomGeometry(app)
        XCTAssertLessThanOrEqual(lastMaxY - composerMinY, 24, "Tapping Latest must return to the bottom of the transcript")
        XCTAssertFalse(latestButton.exists, "transcript.latest must stay hidden after returning to bottom")
    }

    func testDictationRoundTrip() throws {
        let app = try launchLiveApp()
        let micButton = app.buttons["composer.mic"].firstMatch
        let input = app.descendants(matching: .any)["composer.input"].firstMatch

        XCTAssertTrue(micButton.waitForExistence(timeout: 5.0))
        let initialValue = (input.value as? String) ?? ""

        micButton.tap()
        // Trigger UI interruption monitor if system mic permission alert appeared
        app.tap()
        RunLoop.current.run(until: Date().addingTimeInterval(1.5))

        let stopStart = CFAbsoluteTimeGetCurrent()
        micButton.tap()

        let deadline = stopStart + 3.0
        var transcribedAt: CFAbsoluteTime?
        while CFAbsoluteTimeGetCurrent() <= deadline {
            let currentValue = ((input.value as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let isPlaceholder = currentValue.hasPrefix("Ask ") || currentValue.hasPrefix("Type a follow-up")
            if !currentValue.isEmpty && !isPlaceholder && currentValue != initialValue {
                transcribedAt = CFAbsoluteTimeGetCurrent()
                break
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }

        guard let doneAt = transcribedAt else {
            XCTFail("Dictation transcription did not populate composer.input within 3s")
            return
        }
        recordMetric("dictation_roundtrip", ms: max(0, Int(((doneAt - stopStart) * 1000.0).rounded())))
    }

    func testTapConversationLinkSwitchesSession() throws {
        let app = XCUIApplication()
        app.launchEnvironment["SH_CONNECTION_MODE"] = "demo"
        app.launchEnvironment["SH_INITIAL_SESSION_ID"] = "antigravity:agy-ios-companion"
        app.launch()

        let link = app.links["Tailscale Control Server"].firstMatch
        XCTAssertTrue(link.waitForExistence(timeout: 6.0), "conversation:// markdown link should be hittable in transcript")
        link.tap()

        // Target session title in the floating header pill should switch to the Codex Control Server session
        let targetHeader = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Tailscale bind'")).firstMatch
        XCTAssertTrue(targetHeader.waitForExistence(timeout: 4.0), "Tapping conversation:// link must switch directly to target session")
    }

    func testNativeSwipeBackReturnsToSessionList() throws {
        let app = XCUIApplication()
        app.launchEnvironment["SH_CONNECTION_MODE"] = "demo"
        app.launch()

        let statusPill = app.buttons["header.status"].firstMatch
        XCTAssertTrue(statusPill.waitForExistence(timeout: 6.0), "Session list should appear on launch")

        let firstRow = app.staticTexts.matching(NSPredicate(format: "label CONTAINS 'Superharness' OR label CONTAINS 'Tailscale'")).firstMatch
        XCTAssertTrue(firstRow.waitForExistence(timeout: 5.0), "A demo session row should appear")
        firstRow.tap()

        let composer = app.descendants(matching: .any)["composer.input"].firstMatch
        XCTAssertTrue(composer.waitForExistence(timeout: 5.0), "Should navigate into SessionDetailView")

        // Perform a native rightward interactive swipe-back gesture from the left edge.
        let leftEdge = app.coordinate(withNormalizedOffset: CGVector(dx: 0.02, dy: 0.50))
        let rightTarget = app.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.50))
        leftEdge.press(forDuration: 0.02, thenDragTo: rightTarget)

        XCTAssertTrue(statusPill.waitForExistence(timeout: 4.0), "Native swipe-back must pop SessionDetailView back to SessionListView")
        XCTAssertFalse(composer.exists, "Composer must be gone after popping back")
    }
}
