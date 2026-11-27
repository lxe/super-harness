import Foundation
import SwiftUI
import UIKit
import XCTest
@testable import SuperHarness

final class UnifiedModelsTests: XCTestCase {
    func testDecodesSubsetSessionFromCurrentControlServer() throws {
        // Matches the exact subset returned by src/main/services/controlServer.ts GET /api/sessions
        let json = """
        {
          "id": "claude-tmux:cc-42",
          "harness": "claude-tmux",
          "title": "Refactor control server",
          "projectName": "super-harness",
          "cwd": "/home/lxe/super-harness",
          "status": "running",
          "isLive": true,
          "isRemote": false,
          "tmuxTarget": "claude:0.0",
          "folderId": null,
          "pinned": true,
          "tags": ["api", "ios"],
          "updatedAt": 1732500000000
        }
        """
        let session = try JSONDecoder().decode(UnifiedSession.self, from: Data(json.utf8))
        XCTAssertEqual(session.id, "claude-tmux:cc-42")
        XCTAssertEqual(session.nativeId, "cc-42")
        XCTAssertEqual(session.harness, .claudeTmux)
        XCTAssertEqual(session.harnessGroup, .claude)
        XCTAssertEqual(session.dispatchMode, .tmuxSend)
        XCTAssertEqual(session.status, .running)
        XCTAssertTrue(session.isWorking)
        XCTAssertTrue(session.pinned)
        XCTAssertFalse(session.pinnedToTop)
        XCTAssertFalse(session.hidden)
        XCTAssertEqual(session.preview, "")
        XCTAssertEqual(session.createdAt, 1732500000000)
    }

    func testDecodesLastUserTextAndHostFieldsAndKeepsOldPayloadsDecoding() throws {
        let json = """
        {
          "id": "claude-cli:remote-1",
          "harness": "claude-cli",
          "title": "Remote session",
          "preview": "Assistant preview text",
          "updatedAt": 1732500000000,
          "hostAddress": "lxe@192.168.1.3",
          "hostLabel": "linux-box",
          "lastUserText": "  fix the\\n row layout  "
        }
        """
        let session = try JSONDecoder().decode(UnifiedSession.self, from: Data(json.utf8))
        XCTAssertEqual(session.hostAddress, "lxe@192.168.1.3")
        XCTAssertEqual(session.hostLabel, "linux-box")
        XCTAssertEqual(session.lastUserText, "  fix the\n row layout  ")
        XCTAssertEqual(SessionRowFormatting.subtitle(for: session), "fix the row layout")

        // Round-trips through Codable (sessions are cached on disk).
        let reencoded = try JSONDecoder().decode(UnifiedSession.self, from: JSONEncoder().encode(session))
        XCTAssertEqual(reencoded, session)

        // Payload from a host that predates the fields.
        let old = """
        { "id": "codex:old", "harness": "codex", "title": "Old host", "preview": "Latest assistant line", "updatedAt": 1 }
        """
        let oldSession = try JSONDecoder().decode(UnifiedSession.self, from: Data(old.utf8))
        XCTAssertNil(oldSession.lastUserText)
        XCTAssertNil(oldSession.hostAddress)
        XCTAssertEqual(SessionRowFormatting.subtitle(for: oldSession), "Latest assistant line")

        // Blank lastUserText also falls back to the preview.
        var blank = oldSession
        blank.lastUserText = "   "
        XCTAssertEqual(SessionRowFormatting.subtitle(for: blank), "Latest assistant line")
    }

    func testHostBadgeLabelUsesLastIPv4OctetOrFirstHostLabel() {
        XCTAssertEqual(SessionRowFormatting.hostBadgeLabel("192.168.1.3"), ".3")
        XCTAssertEqual(SessionRowFormatting.hostBadgeLabel("lxe@100.64.0.12"), ".12")
        XCTAssertEqual(SessionRowFormatting.hostBadgeLabel("devbox.tailnet.ts.net"), "devbox")
        XCTAssertEqual(SessionRowFormatting.hostBadgeLabel("lxe@averyveryverylonghost.local"), "averyver")
        XCTAssertEqual(SessionRowFormatting.hostBadgeLabel("1.2.3"), "1")
        XCTAssertNil(SessionRowFormatting.hostBadgeLabel(nil))
        XCTAssertNil(SessionRowFormatting.hostBadgeLabel("  "))
        XCTAssertEqual(
            SessionRowFormatting.hostAccessibilityLabel(address: "192.168.1.3", label: "linux-box"),
            "Running on linux-box (192.168.1.3)"
        )
        XCTAssertEqual(
            SessionRowFormatting.hostAccessibilityLabel(address: "192.168.1.3", label: nil),
            "Running on 192.168.1.3 (192.168.1.3)"
        )
    }

    func testCommandBlockTrailingBadgeHidesSuccessAndKeepsFailureAndRunning() {
        XCTAssertNil(CommandBlockView.trailingBadge(exitCode: 0, status: "completed"))
        XCTAssertNil(CommandBlockView.trailingBadge(exitCode: nil, status: "completed"))
        XCTAssertNil(CommandBlockView.trailingBadge(exitCode: nil, status: "Success"))
        XCTAssertNil(CommandBlockView.trailingBadge(exitCode: 0, status: nil))
        XCTAssertEqual(CommandBlockView.trailingBadge(exitCode: 2, status: "completed")?.text, "exit 2")
        XCTAssertEqual(CommandBlockView.trailingBadge(exitCode: 2, status: "completed")?.isFailure, true)
        XCTAssertEqual(CommandBlockView.trailingBadge(exitCode: nil, status: "failed")?.isFailure, true)
        XCTAssertEqual(CommandBlockView.trailingBadge(exitCode: nil, status: "running")?.text, "running")
        XCTAssertEqual(CommandBlockView.trailingBadge(exitCode: nil, status: "running")?.isFailure, false)
    }

    func testCommandFirstLineNeverIncludesLaterLines() {
        let heredoc = "cat > a.txt <<'EOF'\nline one\nline two\nEOF"
        XCTAssertEqual(ScrollingCommandText.firstLine(of: heredoc), "cat > a.txt <<'EOF'")
        XCTAssertEqual(ScrollingCommandText.firstLine(of: "\n  npm test\n"), "npm test")
        XCTAssertEqual(ScrollingCommandText.firstLine(of: ""), "")
        XCTAssertTrue(ScrollingCommandText.isMultiLine(heredoc))
        XCTAssertFalse(ScrollingCommandText.isMultiLine(String(repeating: "x", count: 200)))
        XCTAssertFalse(ScrollingCommandText.isMultiLine("npm test\n"))
    }

    func testClassifiesCrossSessionMessagesAndLeavesTypedMessagesAlone() {
        let raw = "Another Claude session sent a message:\n<cross-session-message from=\"bridge:s1\" from-name=\"Release Ops\" from-mode=\"bypass\">\nDeployed to staging.\nSend me the hash.\n</cross-session-message>"
        let peer = UnifiedMessage(id: "u1", role: .user, timestamp: 1, blocks: [.text(text: raw)])
        let info = InjectedMessageInfo.classify(peer)
        XCTAssertEqual(info?.kind, .agent)
        XCTAssertEqual(info?.label, "From session · Release Ops")
        XCTAssertEqual(info?.body, "Deployed to staging.\nSend me the hash.")
        XCTAssertEqual(info?.preview, "Deployed to staging. Send me the hash.")

        // The host can also tag the message without any wrapper text.
        let tagged = UnifiedMessage(
            id: "u2", role: .user, timestamp: 1, blocks: [.text(text: "Tests are green.")],
            harnessMeta: MessageHarnessMeta(sourceKind: .agent, senderName: "CI watcher")
        )
        XCTAssertEqual(InjectedMessageInfo.classify(tagged)?.label, "From session · CI watcher")

        let task = UnifiedMessage(id: "u3", role: .user, timestamp: 1, blocks: [.text(text: "<task-notification><summary>Build finished</summary></task-notification>")])
        XCTAssertEqual(InjectedMessageInfo.classify(task)?.kind, .task)
        XCTAssertEqual(InjectedMessageInfo.classify(task)?.preview, "Build finished")

        let typed = UnifiedMessage(id: "u4", role: .user, timestamp: 1, blocks: [.text(text: "Use a <div> here, and compare a < b.")])
        XCTAssertNil(InjectedMessageInfo.classify(typed))
        let assistant = UnifiedMessage(id: "a1", role: .assistant, timestamp: 1, blocks: [.text(text: raw)])
        XCTAssertNil(InjectedMessageInfo.classify(assistant))
    }

    func testDictationSendRules() {
        XCTAssertEqual(ComposerDictation.appending("world", to: ""), "world")
        XCTAssertEqual(ComposerDictation.appending("world", to: "hello"), "hello world")
        XCTAssertEqual(ComposerDictation.appending("world", to: "hello "), "hello world")
        XCTAssertTrue(ComposerDictation.shouldSendAfterFinalizing(text: "hello world", hasAttachments: false, errorMessage: nil))
        XCTAssertTrue(ComposerDictation.shouldSendAfterFinalizing(text: "", hasAttachments: true, errorMessage: nil))
        XCTAssertFalse(ComposerDictation.shouldSendAfterFinalizing(text: "typed before dictating", hasAttachments: false, errorMessage: "No speech detected."))
        XCTAssertFalse(ComposerDictation.shouldSendAfterFinalizing(text: "  ", hasAttachments: false, errorMessage: nil))
    }

    func testSessionSearchMatchesTitleLastMessageProjectAndBranch() {
        let session = UnifiedSession(
            id: "codex:s1", harness: .codex, title: "Fix mobile SSE reconnect",
            preview: "Added replay buffer", cwd: "/home/lxe/super-harness", projectName: "super-harness",
            gitBranch: "feat/mobile-api", lastUserText: "please keep the Tailscale bind"
        )
        XCTAssertTrue(SessionRowFormatting.matches(session, query: ""))
        XCTAssertTrue(SessionRowFormatting.matches(session, query: "sse"))
        XCTAssertTrue(SessionRowFormatting.matches(session, query: "TAILSCALE"))
        XCTAssertTrue(SessionRowFormatting.matches(session, query: "mobile-api"))
        XCTAssertTrue(SessionRowFormatting.matches(session, query: "harness reconnect"))
        XCTAssertFalse(SessionRowFormatting.matches(session, query: "reconnect kubernetes"))
    }

    func testLevelHistoryRisesFastDecaysSlowlyAndKeepsItsLength() {
        var history = DictationController.silentHistory
        history = DictationController.advancing(history, with: 1)
        XCTAssertEqual(history.count, DictationController.levelBarCount)
        XCTAssertEqual(history.last ?? 0, 0.78, accuracy: 0.001)
        let afterDrop = DictationController.advancing(history, with: 0)
        XCTAssertEqual(afterDrop.last ?? 0, 0.78 * 0.64, accuracy: 0.001)
        XCTAssertEqual(afterDrop[afterDrop.count - 2], 0.78, accuracy: 0.001)
        XCTAssertEqual(DictationController.advancing(history, with: 7).last ?? 0, 0.78 + 0.22 * 0.78, accuracy: 0.001)
    }

    func testErrorsGetFriendlyMessagesAndKeepTechnicalDetail() {
        let timeout = SHErrorPresentation.present("The request timed out.", technicalDetail: "NSURLErrorDomain code -1001\nhttp://100.64.0.10:47890/api/bootstrap")
        XCTAssertEqual(timeout.message, "Your host took too long to answer. It may be asleep or on a slow connection.")
        XCTAssertTrue(timeout.detail.contains("The request timed out."))
        XCTAssertTrue(timeout.detail.contains("/api/bootstrap"))
        XCTAssertFalse(timeout.message.lowercased().contains("request"))

        XCTAssertEqual(SHErrorPresentation.friendlyMessage(for: "The Internet connection appears to be offline."), "This phone is offline. Check Wi-Fi, cellular or Tailscale.")
        XCTAssertEqual(SHErrorPresentation.friendlyMessage(for: "Could not connect to the server."), "Can't reach your host. Check that Super Harness is running there.")
        XCTAssertEqual(SHErrorPresentation.friendlyMessage(for: "HTTP 401 Unauthorized"), "Your host refused this phone. Pair again in Host Connection.")
        XCTAssertEqual(SHErrorPresentation.friendlyMessage(for: "zxqv"), "Something went wrong talking to your host.")
        XCTAssertEqual(SHErrorPresentation.present("zxqv").detail, "zxqv")
    }

    func testDisplayLevelIgnoresRoomNoiseAndRespondsToVoice() {
        XCTAssertEqual(DictationController.displayLevel(decibels: -60), 0)
        XCTAssertEqual(DictationController.displayLevel(decibels: -40), 0)
        XCTAssertLessThan(DictationController.displayLevel(decibels: -32), 0.08)
        XCTAssertGreaterThan(DictationController.displayLevel(decibels: -18), 0.4)
        XCTAssertEqual(DictationController.displayLevel(decibels: 0), 1)
    }

    func testDecodesOptionalUnreadFlag() throws {
        func decode(_ extra: String) throws -> UnifiedSession {
            let json = "{ \"id\": \"codex:u\", \"harness\": \"codex\", \"title\": \"T\", \"updatedAt\": 1\(extra) }"
            return try JSONDecoder().decode(UnifiedSession.self, from: Data(json.utf8))
        }
        XCTAssertTrue(try decode(", \"unread\": true").isUnread)
        XCTAssertFalse(try decode(", \"unread\": false").isUnread)
        let old = try decode("")
        XCTAssertNil(old.unread)
        XCTAssertFalse(old.isUnread)
        // A malformed value must not break decoding of the session.
        XCTAssertFalse(try decode(", \"unread\": \"yes\"").isUnread)
    }

    private func samplePNG() -> Data {
        // Noise keeps the PNG large enough that cutting it in half removes real pixel data.
        let size = CGSize(width: 64, height: 64)
        let image = UIGraphicsImageRenderer(size: size).image { ctx in
            for y in 0..<64 {
                for x in 0..<64 {
                    UIColor(hue: CGFloat((x * 7 + y * 13) % 64) / 64, saturation: 0.8, brightness: CGFloat((x ^ y) % 8) / 8 + 0.1, alpha: 1).setFill()
                    ctx.fill(CGRect(x: x, y: y, width: 1, height: 1))
                }
            }
        }
        return image.pngData()!
    }

    func testMediaValidatorRejectsTruncatedImagesAndAcceptsCompleteOnes() {
        let png = samplePNG()
        let path = "/home/lxe/.codex/generated_images/abc/exec-1.png"
        XCTAssertTrue(MediaDataValidator.isUsable(png, forPath: path))
        XCTAssertFalse(MediaDataValidator.isUsable(png.prefix(png.count / 2), forPath: path), "a half-written file must be rejected")
        XCTAssertFalse(MediaDataValidator.isUsable(Data(), forPath: path))
        XCTAssertFalse(MediaDataValidator.isUsable(Data("{\"error\":\"Media not found\"}".utf8), forPath: path))
        // The host answers a .png path with another format; the bytes decide, not the extension.
        let jpeg = UIImage(data: png)!.jpegData(compressionQuality: 0.8)!
        XCTAssertTrue(MediaDataValidator.isUsable(jpeg, forPath: path))
        XCTAssertFalse(MediaDataValidator.isUsable(jpeg.prefix(jpeg.count / 2), forPath: path))
        // WebP as the host sends it (ImageMagick, lossy VP8, 48x48) for a .png path.
        let webp = Data(base64Encoded: "UklGRlYAAABXRUJQVlA4IEoAAABQBACdASowADAAPnk0k0eko6GhuMgAkA8JaQANT+FaPl4UJecchj2QGxC4AP79r8epa8lreMlfS6Xd8+fReJaJGF/7tKZXYAAAAA==")!
        XCTAssertNotNil(UIImage(data: webp), "iOS decodes the host's WebP")
        XCTAssertTrue(MediaDataValidator.isUsable(webp, forPath: path))
        XCTAssertFalse(MediaDataValidator.isUsable(webp.prefix(webp.count - 20), forPath: path), "a WebP shorter than its header says is rejected")
        // Non-image media is not inspected.
        XCTAssertTrue(MediaDataValidator.isUsable(Data([1, 2, 3]), forPath: "/tmp/clip.mp4"))
    }

    @MainActor
    func testMediaRetryLoaderKeepsTryingUntilTheImageDecodes() async {
        let png = samplePNG()
        var calls = 0
        var sleeps: [Double] = []
        let image = await MediaRetryLoader.load(
            path: "/x/generated.png",
            delays: [0, 1.5, 4, 10],
            sleep: { sleeps.append($0) },
            loader: { _ in
                calls += 1
                if calls == 1 { return nil }                      // file not there yet
                if calls == 2 { return png.prefix(png.count / 2) } // still being written
                return png
            },
            decode: { MediaDataValidator.isCompleteImage($0) ? UIImage(data: $0) : nil }
        )
        XCTAssertNotNil(image)
        XCTAssertEqual(calls, 3)
        XCTAssertEqual(sleeps, [1.5, 4])

        var failedCalls = 0
        let never = await MediaRetryLoader.load(
            path: "/x/missing.png", delays: [0, 1, 2], sleep: { _ in },
            loader: { _ in failedCalls += 1; return nil }, decode: { UIImage(data: $0) }
        )
        XCTAssertNil(never)
        XCTAssertEqual(failedCalls, 3)
    }

    @MainActor
    func testStoreDoesNotCacheMissingOrTruncatedMediaAndRecoversOnRetry() async {
        let suite = "MediaRetryTests.\(UUID().uuidString)"
        let store = AppStore(
            client: MockSuperHarnessClient(),
            keychain: InMemoryKeychainStore(),
            defaults: UserDefaults(suiteName: suite)!,
            environment: [:]
        )
        defer { store.stopEventStream() }
        let path = MockSuperHarnessClient.slowGeneratedImagePath

        let first = await store.loadMediaData(path: path, maxWidth: 320)
        XCTAssertNil(first, "404 while the file does not exist yet")
        let second = await store.loadMediaData(path: path, maxWidth: 320)
        XCTAssertNil(second, "a truncated file must not be returned or cached")
        let third = await store.loadMediaData(path: path, maxWidth: 320)
        XCTAssertNotNil(third, "the complete image loads once the host has it")
        XCTAssertNotNil(third.flatMap { UIImage(data: $0) })
        let fourth = await store.loadMediaData(path: path, maxWidth: 320)
        XCTAssertEqual(fourth, third, "the good result is cached")
    }

    func testExtremeReasoningLevelsAreOptIn() {
        let levels = ["low", "medium", "high", "xhigh", "max", "ultra"]
        XCTAssertEqual(ReasoningEffortPolicy.offered(levels, allowExtreme: false), ["low", "medium", "high", "xhigh"])
        XCTAssertEqual(ReasoningEffortPolicy.offered(levels, allowExtreme: true), levels)
        // A session already at Max still shows Max, so the menu tells the truth.
        XCTAssertEqual(ReasoningEffortPolicy.offered(levels, allowExtreme: false, keeping: "Max"), ["low", "medium", "high", "xhigh", "max"])

        // A host default of "ultra" does not start a session at ultra unless enabled.
        XCTAssertEqual(ReasoningEffortPolicy.defaultLevel(from: levels, preferred: "ultra", allowExtreme: false), "xhigh")
        XCTAssertEqual(ReasoningEffortPolicy.defaultLevel(from: levels, preferred: "ultra", allowExtreme: true), "ultra")
        XCTAssertEqual(ReasoningEffortPolicy.defaultLevel(from: levels, preferred: "medium", allowExtreme: false), "medium")
        XCTAssertEqual(ReasoningEffortPolicy.defaultLevel(from: ["low", "medium", "high", "max"], preferred: nil, allowExtreme: false), "high")
        XCTAssertNil(ReasoningEffortPolicy.defaultLevel(from: [], preferred: "high", allowExtreme: false))
        XCTAssertTrue(ReasoningEffortPolicy.isExtreme("Ultrathink"))
        XCTAssertFalse(ReasoningEffortPolicy.isExtreme("xhigh"))
    }

    func testModelEffortMenuIgnoresClosureChangesWhenItsDataIsTheSame() {
        func menu(selected: String) -> SHModelEffortMenu {
            SHModelEffortMenu(
                models: [.init(id: "a", label: "A", isSelected: selected == "a"), .init(id: "b", label: "B", isSelected: selected == "b")],
                efforts: [.init(level: "high", isSelected: true)],
                harness: .codex, title: "A", effortLabel: "High",
                accessibilityText: "Switch model and effort", identifier: "composer.model",
                onSelectModel: { _ in }, onSelectEffort: { _ in }
            )
        }
        XCTAssertTrue(menu(selected: "a") == menu(selected: "a"), "a parent re-render with the same data must not rebuild the open menu")
        XCTAssertFalse(menu(selected: "a") == menu(selected: "b"))
    }

    func testShimmerBandSweepsAcrossTheTextOncePerPeriod() {
        XCTAssertEqual(SHShimmerText.bandCenter(at: 0, period: 2.6), -0.6, accuracy: 0.0001, "starts left of the text")
        XCTAssertEqual(SHShimmerText.bandCenter(at: 1.3, period: 2.6), 0.5, accuracy: 0.0001, "mid-sweep is the middle of the text")
        XCTAssertEqual(SHShimmerText.bandCenter(at: 2.599, period: 2.6), 1.6, accuracy: 0.01, "ends right of the text")
        XCTAssertEqual(SHShimmerText.bandCenter(at: 2.6 * 7 + 1.3, period: 2.6), 0.5, accuracy: 0.0001, "repeats")
    }

    func testHarnessOrderNormalizesAndMoves() throws {
        XCTAssertEqual(HarnessOrder.normalized(nil), [.antigravity, .codex, .claude, .muse, .pi])
        XCTAssertEqual(HarnessOrder.normalized(["claude", "codex"]), [.claude, .codex, .antigravity, .muse, .pi])
        XCTAssertEqual(HarnessOrder.normalized(["Muse", "bogus", "muse", "claude"]), [.muse, .claude, .antigravity, .codex, .pi])

        let order: [HarnessGroup] = [.antigravity, .codex, .claude, .muse]
        XCTAssertEqual(HarnessOrder.moving(.muse, onto: .antigravity, in: order), [.muse, .antigravity, .codex, .claude])
        XCTAssertEqual(HarnessOrder.moving(.antigravity, onto: .claude, in: order), [.codex, .claude, .antigravity, .muse])
        XCTAssertEqual(HarnessOrder.moving(.codex, onto: .codex, in: order), order)

        let withOrder = try JSONDecoder().decode(SuperHarnessSettings.self, from: Data("{\"harnessOrder\":[\"codex\",\"claude\"]}".utf8))
        XCTAssertEqual(withOrder.harnessOrder ?? [], ["codex", "claude"])
        XCTAssertNil(try JSONDecoder().decode(SuperHarnessSettings.self, from: Data("{}".utf8)).harnessOrder)
    }

    @MainActor
    func testMovingAHarnessReordersSectionsAndPersists() async {
        let suite = "HarnessOrderTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        let store = AppStore(client: MockSuperHarnessClient(), keychain: InMemoryKeychainStore(), defaults: defaults, environment: [:])
        defer { store.stopEventStream() }
        await store.bootstrap()
        XCTAssertEqual(store.harnessOrder, [.antigravity, .codex, .claude, .muse, .pi])

        store.moveHarness(.claude, onto: .antigravity)
        XCTAssertEqual(store.harnessOrder, [.claude, .antigravity, .codex, .muse, .pi])
        XCTAssertEqual(defaults.stringArray(forKey: "sh.harnessOrder") ?? [], ["claude", "antigravity", "codex", "muse", "pi"])

        // A second store on the same defaults starts with the saved order.
        let reopened = AppStore(client: MockSuperHarnessClient(), keychain: InMemoryKeychainStore(), defaults: defaults, environment: [:])
        defer { reopened.stopEventStream() }
        XCTAssertEqual(reopened.harnessOrder, [.claude, .antigravity, .codex, .muse, .pi])
    }

    func testDecodesAllUnifiedBlockVariantsIncludingVideoAndUnknownFallback() throws {
        let json = """
        {
          "id": "msg-1",
          "role": "assistant",
          "timestamp": 1732500005000,
          "blocks": [
            { "type": "text", "text": "Hello **world**" },
            { "type": "image", "path": "/tmp/a.png", "name": "a.png", "dataUrl": "data:image/png;base64,AA==" },
            { "type": "video", "path": "/tmp/demo.mp4", "name": "demo.mp4", "mimeType": "video/mp4" },
            { "type": "thinking", "text": "Step by step", "summary": "Analyzed" },
            { "type": "command", "command": "ls -la", "cwd": "/tmp", "output": "ok", "exitCode": 0, "durationMs": 42, "status": "done" },
            { "type": "file_change", "changes": [{ "path": "a.swift", "kind": "modified", "diff": "+let x = 1" }], "status": "applied" },
            { "type": "tool_call", "name": "read_file", "server": "fs", "args": "{}", "output": "done", "status": "done", "durationMs": 12 },
            { "type": "web_search", "query": "SwiftUI Charts", "url": "https://developer.apple.com" },
            { "type": "question", "questions": [{ "question": "Proceed?", "options": ["Yes", "No"], "multiSelect": false }], "answered": false },
            { "type": "notice", "title": "Heads up", "detail": "Local network" },
            { "type": "future_unknown_block", "foo": "bar" }
          ],
          "harnessMeta": { "model": "claude-opus-4-6", "sourceKind": "agent" }
        }
        """

        let message = try JSONDecoder().decode(UnifiedMessage.self, from: Data(json.utf8))
        XCTAssertEqual(message.id, "msg-1")
        XCTAssertEqual(message.role, .assistant)
        XCTAssertEqual(message.blocks.count, 11)
        XCTAssertEqual(message.harnessMeta?.model, "claude-opus-4-6")

        if case .text(let t) = message.blocks[0] { XCTAssertEqual(t, "Hello **world**") } else { XCTFail("Expected text") }
        if case .image(let p, let n, let d) = message.blocks[1] {
            XCTAssertEqual(p, "/tmp/a.png")
            XCTAssertEqual(n, "a.png")
            XCTAssertEqual(d, "data:image/png;base64,AA==")
        } else { XCTFail("Expected image") }
        if case .video(let p, let n, let m) = message.blocks[2] {
            XCTAssertEqual(p, "/tmp/demo.mp4")
            XCTAssertEqual(n, "demo.mp4")
            XCTAssertEqual(m, "video/mp4")
        } else { XCTFail("Expected video") }
        if case .thinking(let t, let s) = message.blocks[3] {
            XCTAssertEqual(t, "Step by step")
            XCTAssertEqual(s, "Analyzed")
        } else { XCTFail("Expected thinking") }
        if case .command(let cmd, _, _, let code, _, _) = message.blocks[4] {
            XCTAssertEqual(cmd, "ls -la")
            XCTAssertEqual(code, 0)
        } else { XCTFail("Expected command") }
        if case .fileChange(let changes, let status) = message.blocks[5] {
            XCTAssertEqual(changes.count, 1)
            XCTAssertEqual(changes[0].path, "a.swift")
            XCTAssertEqual(status, "applied")
        } else { XCTFail("Expected file_change") }
        if case .toolCall(let name, let server, _, _, _, _) = message.blocks[6] {
            XCTAssertEqual(name, "read_file")
            XCTAssertEqual(server, "fs")
        } else { XCTFail("Expected tool_call") }
        if case .webSearch(let q, let url) = message.blocks[7] {
            XCTAssertEqual(q, "SwiftUI Charts")
            XCTAssertEqual(url, "https://developer.apple.com")
        } else { XCTFail("Expected web_search") }
        if case .question(let qs, let answered) = message.blocks[8] {
            XCTAssertEqual(qs.count, 1)
            XCTAssertEqual(qs[0].options, ["Yes", "No"])
            XCTAssertEqual(answered, false)
        } else { XCTFail("Expected question") }
        if case .notice(let title, let detail) = message.blocks[9] {
            XCTAssertEqual(title, "Heads up")
            XCTAssertEqual(detail, "Local network")
        } else { XCTFail("Expected notice") }
        if case .notice(let title, _) = message.blocks[10] {
            XCTAssertEqual(title, "Unsupported block")
        } else { XCTFail("Expected fallback notice") }
    }

    func testDecodesMobileApiSettingsAndReorderFoldersAction() throws {
        let settingsJSON = """
        {
          "sidebarGroupBy": "native",
          "showArchived": false,
          "showHidden": false,
          "defaultNewSessionCwd": "/home/lxe",
          "mobileApi": {
            "enabled": true,
            "bindHost": "0.0.0.0",
            "port": 47890,
            "token": "test-token-123"
          }
        }
        """
        let settings = try JSONDecoder().decode(SuperHarnessSettings.self, from: Data(settingsJSON.utf8))
        XCTAssertEqual(settings.mobileApi?.enabled, true)
        XCTAssertEqual(settings.mobileApi?.bindHost, "0.0.0.0")
        XCTAssertEqual(settings.mobileApi?.port, 47890)
        XCTAssertEqual(settings.mobileApi?.token, "test-token-123")

        let action = OrganizeAction(type: .reorderFolders, folderIds: ["f-2", "f-1"])
        let encoded = try JSONEncoder().encode(action)
        let decoded = try JSONDecoder().decode(OrganizeAction.self, from: encoded)
        XCTAssertEqual(decoded.type, .reorderFolders)
        XCTAssertEqual(decoded.folderIds, ["f-2", "f-1"])

        let setModelAction = OrganizeAction(
            type: .setModel,
            sessionId: "codex:cx-1",
            model: "gpt-5.3-codex",
            reasoningEffort: "xhigh"
        )
        let setModelData = try JSONEncoder().encode(setModelAction)
        let decodedSetModel = try JSONDecoder().decode(OrganizeAction.self, from: setModelData)
        XCTAssertEqual(decodedSetModel.type, .setModel)
        XCTAssertEqual(decodedSetModel.sessionId, "codex:cx-1")
        XCTAssertEqual(decodedSetModel.model, "gpt-5.3-codex")
        XCTAssertEqual(decodedSetModel.reasoningEffort, "xhigh")

        let dictationStatusJSON = """
        {
          "ok": true,
          "configured": true,
          "url": "http://100.64.0.10:8765",
          "healthy": true,
          "model": "whisper-large-v3-turbo"
        }
        """
        let status = try JSONDecoder().decode(DictationStatusResponse.self, from: Data(dictationStatusJSON.utf8))
        XCTAssertTrue(status.ok)
        XCTAssertTrue(status.configured)
        XCTAssertTrue(status.healthy)
        XCTAssertEqual(status.model, "whisper-large-v3-turbo")

        let dictationResultJSON = #"{"ok":true,"text":"hello world"}"#
        let result = try JSONDecoder().decode(DictationResult.self, from: Data(dictationResultJSON.utf8))
        XCTAssertTrue(result.ok)
        XCTAssertEqual(result.text, "hello world")
    }

    func testDecodesRealLiveBootstrapPayloadIfPresent() throws {
        let livePath = "/tmp/sh-live-bootstrap.json"
        guard FileManager.default.fileExists(atPath: livePath) else {
            // Skip gracefully on machines without the captured live host snapshot
            return
        }
        let data = try Data(contentsOf: URL(fileURLWithPath: livePath))
        let rawObj = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        let rawSessionCount = (rawObj?["sessions"] as? [Any])?.count ?? 0

        let payload = try JSONDecoder().decode(BootstrapPayload.self, from: data)
        XCTAssertEqual(payload.harnesses.count, 4)
        XCTAssertTrue(payload.harnesses.contains(where: { $0.id == .muse }))
        XCTAssertGreaterThan(payload.sessions.count, 0)
        XCTAssertEqual(payload.sessions.count, rawSessionCount)
        XCTAssertTrue(payload.sessions.contains(where: { $0.harness == .muse }))
        XCTAssertNotNil(payload.state)
        XCTAssertEqual(payload.state?.settings.mobileApi?.port, 47890)
        XCTAssertNotNil(payload.usage)
        XCTAssertNotNil(payload.usage?.muse)
        XCTAssertNotNil(payload.catalog)
        XCTAssertFalse(payload.catalog?.models(for: .muse).isEmpty ?? true)
        XCTAssertGreaterThan(payload.catalog?.projects.count ?? 0, 0)
    }

    func testFutureUnknownHarnessDoesNotCrashDecoding() throws {
        let json = """
        {
          "protocolVersion": 1,
          "seq": 42,
          "harnesses": [
            { "id": "codex", "name": "Codex", "installed": true },
            { "id": "muse", "name": "Muse", "installed": true },
            { "id": "future-harness", "name": "Future AI", "installed": true }
          ],
          "sessions": [
            {
              "id": "muse:m-1",
              "harness": "muse",
              "harnessGroup": "muse",
              "title": "Muse task",
              "status": "running",
              "dispatchMode": "muse-exec",
              "liveOwner": "super-harness-muse",
              "updatedAt": 1732500001000
            },
            {
              "id": "codex:c-1",
              "harness": "codex",
              "harnessGroup": "future-group",
              "title": "Codex with future metadata",
              "status": "future_status",
              "dispatchMode": "future-exec",
              "originApp": "future-app",
              "liveOwner": "future-owner",
              "updatedAt": 1732500002000
            },
            {
              "id": "future-harness:f-1",
              "harness": "future-harness",
              "harnessGroup": "future-harness",
              "title": "Unknown harness session",
              "status": "idle",
              "updatedAt": 1732500003000
            }
          ],
          "state": {
            "settings": {
              "sidebarGroupBy": "future_grouping",
              "showArchived": false,
              "showHidden": false,
              "enabledHarnesses": {
                "antigravity": true,
                "codex": true,
                "claude": true,
                "muse": true,
                "future-harness": true
              },
              "defaultNewSessionCwd": "/tmp"
            },
            "folders": [],
            "overrides": {},
            "masterMessages": []
          },
          "usage": {
            "antigravity": { "harness": "antigravity", "updatedAt": 1000, "windows": [], "spend5hUsd": 0, "spend24hUsd": 0, "spend7dUsd": 0, "spend14dUsd": 0, "tokens7d": 0, "dailySpend7d": [], "spendIsEstimated": true },
            "codex": { "harness": "codex", "updatedAt": 1000, "windows": [], "spend5hUsd": 0, "spend24hUsd": 0, "spend7dUsd": 0, "spend14dUsd": 0, "tokens7d": 0, "dailySpend7d": [], "spendIsEstimated": true },
            "claude": { "harness": "claude", "updatedAt": 1000, "windows": [], "spend5hUsd": 0, "spend24hUsd": 0, "spend7dUsd": 0, "spend14dUsd": 0, "tokens7d": 0, "dailySpend7d": [], "spendIsEstimated": true },
            "muse": { "harness": "muse", "updatedAt": 1000, "barPercent": 12, "windows": [], "spend5hUsd": 0, "spend24hUsd": 0, "spend7dUsd": 0, "spend14dUsd": 0, "tokens7d": 0, "dailySpend7d": [], "spendIsEstimated": true },
            "future-harness": { "harness": "future-harness", "updatedAt": 1000, "windows": [], "spend5hUsd": 0, "spend24hUsd": 0, "spend7dUsd": 0, "spend14dUsd": 0, "tokens7d": 0, "dailySpend7d": [], "spendIsEstimated": true }
          },
          "catalog": {
            "models": {
              "muse": [{ "id": "muse-wonder-full-1.0", "label": "Muse Wonder Full" }],
              "future-harness": [{ "id": "future-1", "label": "Future 1" }]
            },
            "defaultReasoningEffort": {
              "muse": "high",
              "future-harness": "ultra"
            },
            "projects": [
              { "name": "super-harness", "path": "/tmp/sh", "harnesses": ["codex", "muse", "future-harness"] }
            ],
            "updatedAt": 1732500000000
          }
        }
        """

        let payload = try JSONDecoder().decode(BootstrapPayload.self, from: Data(json.utf8))
        XCTAssertEqual(payload.harnesses.map(\.id), [.codex, .muse])
        XCTAssertEqual(payload.sessions.count, 2)

        let museSession = payload.sessions.first(where: { $0.id == "muse:m-1" })
        XCTAssertEqual(museSession?.harness, .muse)
        XCTAssertEqual(museSession?.dispatchMode, .museExec)
        XCTAssertEqual(museSession?.liveOwner, "super-harness-muse")

        let codexSession = payload.sessions.first(where: { $0.id == "codex:c-1" })
        XCTAssertEqual(codexSession?.harnessGroup, .codex)
        XCTAssertEqual(codexSession?.status, .idle)
        XCTAssertNil(codexSession?.originApp)

        XCTAssertEqual(payload.state?.settings.sidebarGroupBy, .native)
        XCTAssertEqual(payload.state?.settings.enabledHarnesses?["future-harness"], true)
        XCTAssertEqual(payload.usage?.muse?.barPercent, 12)
        XCTAssertEqual(payload.catalog?.models(for: .muse).first?.id, "muse-wonder-full-1.0")
        XCTAssertEqual(payload.catalog?.projects.first?.harnesses, [.codex, .muse])

        // Also verify transcript tolerates future enum values
        let transcriptJSON = """
        {
          "sessionId": "muse:m-1",
          "messages": [
            {
              "id": "msg-future",
              "role": "future_role",
              "timestamp": 1732500009000,
              "blocks": [{ "type": "text", "text": "Hello from Muse" }],
              "harnessMeta": { "model": "muse-wonder-full-1.0", "sourceKind": "future_source" }
            }
          ],
          "liveActivity": {
            "isWorking": true,
            "steps": [{ "title": "Future step", "status": "future_step_status" }]
          }
        }
        """
        let transcript = try JSONDecoder().decode(SessionTranscriptResult.self, from: Data(transcriptJSON.utf8))
        XCTAssertEqual(transcript.messages.count, 1)
        XCTAssertEqual(transcript.messages[0].role, .assistant)
        XCTAssertEqual(transcript.messages[0].harnessMeta?.sourceKind, .agent)
        XCTAssertEqual(transcript.liveActivity?.steps?.first?.status, .pending)
    }

    func testDecodesUsageSnapshotAndComputesHeroWindowAndPace() throws {
        let nowMs = 1_732_500_000_000.0
        let resetsInHalfWeek = nowMs + (3.5 * 86_400_000.0)
        let json = """
        {
          "antigravity": {
            "harness": "antigravity",
            "updatedAt": \(nowMs),
            "planLabel": "Ultra",
            "barPercent": 40,
            "windows": [
              { "id": "weekly", "label": "Weekly", "usedPercent": 40, "resetsAt": \(resetsInHalfWeek), "delta24h": 10, "windowMinutes": 10080 },
              { "id": "5h", "label": "5h", "usedPercent": 20, "windowMinutes": 300 },
              { "id": "extra", "label": "Extra", "usedPercent": 95 }
            ],
            "spend5hUsd": 3.5,
            "spend24hUsd": 12.0,
            "spend7dUsd": 55.0,
            "spend14dUsd": 100.0,
            "tokens7d": 12000000,
            "dailySpend7d": [
              { "date": "2026-11-25", "dayLabel": "Wed", "spendUsd": 12.0, "tokens": 2500000 }
            ],
            "spendIsEstimated": true
          },
          "codex": {
            "harness": "codex",
            "updatedAt": \(nowMs),
            "barPercent": 50,
            "windows": [],
            "spend5hUsd": 1, "spend24hUsd": 2, "spend7dUsd": 10, "spend14dUsd": 20,
            "tokens7d": 1000000, "dailySpend7d": [], "spendIsEstimated": true
          },
          "claude": {
            "harness": "claude",
            "updatedAt": \(nowMs),
            "barPercent": 80,
            "windows": [],
            "spend5hUsd": 4, "spend24hUsd": 8, "spend7dUsd": 40, "spend14dUsd": 80,
            "tokens7d": 5000000, "dailySpend7d": [], "spendIsEstimated": true
          }
        }
        """

        let snapshot = try JSONDecoder().decode(UsageSnapshot.self, from: Data(json.utf8))
        let picked = UsageMetrics.pickHeroWindow(snapshot.antigravity.windows)
        // Extra window (95%) must NOT beat primary weekly window (40%)
        XCTAssertEqual(picked.hero?.id, "weekly")
        XCTAssertEqual(picked.secondary.count, 2)

        let pace = UsageMetrics.computeWindowPace(picked.hero!, nowMs: nowMs)
        XCTAssertNotNil(pace)
        XCTAssertEqual(pace!.elapsedPercent, 50.0, accuracy: 0.5)
        XCTAssertEqual(pace!.projectedPercent, 80)
        XCTAssertEqual(pace!.windowWord, "week")
    }

    func testDecodesHarnessCatalog() throws {
        let json = """
        {
          "models": {
            "codex": [
              {
                "id": "gpt-5.3-codex",
                "label": "GPT-5.3 Codex",
                "isDefault": true,
                "reasoningLevels": ["low", "medium", "high", "xhigh"],
                "defaultReasoningLevel": "high"
              }
            ]
          },
          "defaultReasoningEffort": { "codex": "high" },
          "projects": [
            { "name": "super-harness", "path": "/Users/lxe/Developer/super-harness", "harnesses": ["codex", "claude"] }
          ],
          "updatedAt": 1732500000000
        }
        """

        let catalog = try JSONDecoder().decode(HarnessCatalog.self, from: Data(json.utf8))
        XCTAssertEqual(catalog.models(for: .codex).count, 1)
        XCTAssertEqual(catalog.models(for: .codex).first?.reasoningLevels, ["low", "medium", "high", "xhigh"])
        XCTAssertEqual(catalog.defaultReasoning(for: .codex), "high")
        XCTAssertEqual(catalog.projects.first?.name, "super-harness")
    }

    func testCoalescesConsecutiveTraceBlocks() {
        let blocks: [UnifiedBlock] = [
            .thinking(text: "t1", summary: nil),
            .command(command: "ls", cwd: nil, output: nil, exitCode: 0, durationMs: nil, status: nil),
            .text(text: "Done"),
            .toolCall(name: "read", server: nil, args: nil, output: nil, status: nil, durationMs: nil),
        ]
        let segments = CoalescedSegment.coalesce(blocks)
        XCTAssertEqual(segments.count, 3)
        if case .traceGroup(let grouped) = segments[0] {
            XCTAssertEqual(grouped.count, 2)
        } else {
            XCTFail("Expected first segment to be traceGroup")
        }
        if case .single(.text(let text)) = segments[1] {
            XCTAssertEqual(text, "Done")
        } else {
            XCTFail("Expected second segment to be text")
        }
        if case .single(.toolCall(let name, _, _, _, _, _)) = segments[2] {
            XCTAssertEqual(name, "read")
        } else {
            XCTFail("Single trailing trace block should remain .single")
        }
    }

    func testDecodesActiveWorkingSessionIdsAndActivityUpdateEnvelope() throws {
        let bootstrapJSON = """
        {
          "protocolVersion": 1,
          "seq": 9,
          "harnesses": [{ "id": "codex", "name": "Codex", "installed": true }],
          "sessions": [{ "id": "codex:c-1", "harness": "codex", "title": "Working", "updatedAt": 1732500000000 }],
          "activeWorkingSessionIds": ["codex:c-1", "muse:m-1"]
        }
        """
        let bootstrap = try JSONDecoder().decode(BootstrapPayload.self, from: Data(bootstrapJSON.utf8))
        XCTAssertEqual(bootstrap.activeWorkingSessionIds, ["codex:c-1", "muse:m-1"])

        let sessionsJSON = """
        {
          "count": 1,
          "sessions": [{ "id": "codex:c-1", "harness": "codex", "title": "Working", "updatedAt": 1732500000000 }],
          "activeWorkingSessionIds": ["codex:c-1"]
        }
        """
        let sessionsEnv = try JSONDecoder().decode(SessionsEnvelope.self, from: Data(sessionsJSON.utf8))
        XCTAssertEqual(sessionsEnv.activeWorkingSessionIds, ["codex:c-1"])

        let activityJSON = #"{"workingSessionIds":["antigravity:a-1","muse:m-2"]}"#
        let activity = try JSONDecoder().decode(ActivityUpdateEnvelope.self, from: Data(activityJSON.utf8))
        XCTAssertEqual(activity.workingSessionIds, ["antigravity:a-1", "muse:m-2"])

        let emptyActivity = try JSONDecoder().decode(ActivityUpdateEnvelope.self, from: Data("{}".utf8))
        XCTAssertTrue(emptyActivity.workingSessionIds.isEmpty)

        // Protocol v2 sessions_delta decoding (tolerant of unknown harness entries)
        let deltaJSON = """
        {
          "upserts": [
            { "id": "muse:m-9", "harness": "muse", "title": "Updated Muse", "updatedAt": 1732500005000 },
            { "id": "future-harness:f-1", "harness": "future-harness", "title": "Ignored future", "updatedAt": 1732500006000 }
          ],
          "removedIds": ["codex:old-1"],
          "order": ["muse:m-9", "codex:c-1"],
          "harnesses": [
            { "id": "muse", "name": "Muse", "installed": true },
            { "id": "future-harness", "name": "Future", "installed": true }
          ],
          "activeWorkingSessionIds": ["muse:m-9"]
        }
        """
        let delta = try JSONDecoder().decode(SessionsDeltaEnvelope.self, from: Data(deltaJSON.utf8))
        XCTAssertEqual(delta.upserts.map(\.id), ["muse:m-9"])
        XCTAssertEqual(delta.removedIds, ["codex:old-1"])
        XCTAssertEqual(delta.order, ["muse:m-9", "codex:c-1"])
        XCTAssertEqual(delta.harnesses?.map(\.id), [.muse])
        XCTAssertEqual(delta.activeWorkingSessionIds, ["muse:m-9"])
    }

    func testPickHeroWindowPrefersCanonicalPrimaryOver3P() {
        let windows = [
            UsageQuotaWindow(id: "3p-weekly", label: "Claude & GPT · Weekly", usedPercent: 50),
            UsageQuotaWindow(id: "five_hour", label: "Gemini · 5h limit", usedPercent: 6),
            UsageQuotaWindow(id: "weekly", label: "Gemini · Weekly", usedPercent: 3),
            UsageQuotaWindow(id: "3p-five-hour", label: "Claude & GPT · 5h limit", usedPercent: 0),
        ]
        let picked = UsageMetrics.pickHeroWindow(windows)
        XCTAssertEqual(picked.hero?.id, "five_hour", "Hero must prefer canonical Gemini five_hour/weekly over higher 3P window")
        XCTAssertEqual(picked.secondary.map(\.id), ["3p-weekly", "weekly", "3p-five-hour"])
    }

    func testSessionLinkResolverAllSchemes() {
        let agy = UnifiedSession(
            id: "antigravity:dc969a3b-736f-45e1-b1af-60d2fe972418",
            nativeId: "dc969a3b-736f-45e1-b1af-60d2fe972418",
            harness: .antigravity,
            title: "Troubleshooting SSH",
            cwd: "/tmp",
            projectName: "super-harness"
        )
        let claude = UnifiedSession(
            id: "claude:3d88042c-caee-4c5c-863e-dcccc4b2ff38",
            nativeId: "3d88042c-caee-4c5c-863e-dcccc4b2ff38",
            harness: .claudeDesktop,
            title: "Orble supervisor",
            cwd: "/tmp",
            projectName: "orble"
        )
        let codex = UnifiedSession(
            id: "codex:01a214b8-51a9-7410-acf7-d351e13b4430",
            nativeId: "01a214b8-51a9-7410-acf7-d351e13b4430",
            harness: .codex,
            title: "Codex thread",
            cwd: "/tmp",
            projectName: "orble"
        )
        let muse = UnifiedSession(
            id: "muse:aabbccdd-1122-3344-5566-778899001122",
            nativeId: "aabbccdd-1122-3344-5566-778899001122",
            harness: .muse,
            title: "Super Harness Muse",
            cwd: "/tmp",
            projectName: "super-harness"
        )
        let all = [agy, claude, codex, muse]

        XCTAssertEqual(SessionLinkResolver.resolve("conversation://dc969a3b-736f-45e1-b1af-60d2fe972418", in: all)?.id, agy.id)
        XCTAssertEqual(SessionLinkResolver.resolve("CONVERSATION://dc969a3b?foo=bar#top", in: all)?.id, agy.id)
        XCTAssertEqual(SessionLinkResolver.resolve("antigravity://conversation/dc969a3b-736f-45e1-b1af-60d2fe972418/", in: all)?.id, agy.id)
        XCTAssertEqual(SessionLinkResolver.resolve("agy://dc969a3b-736f-45e1-b1af-60d2fe972418", in: all)?.id, agy.id)
        XCTAssertEqual(SessionLinkResolver.resolve("claude://session/3d88042c-caee-4c5c-863e-dcccc4b2ff38", in: all)?.id, claude.id)
        XCTAssertEqual(SessionLinkResolver.resolve("codex://thread/01a214b8-51a9-7410-acf7-d351e13b4430", in: all)?.id, codex.id)
        XCTAssertEqual(SessionLinkResolver.resolve("muse://session/aabbccdd-1122-3344-5566-778899001122", in: all)?.id, muse.id)
        XCTAssertEqual(SessionLinkResolver.resolve("super-harness://session/claude:3d88042c-caee-4c5c-863e-dcccc4b2ff38", in: all)?.id, claude.id)
        XCTAssertEqual(SessionLinkResolver.resolve("sh://session/01a214b8", in: all)?.id, codex.id)
        XCTAssertNil(SessionLinkResolver.resolve("https://example.com/dc969a3b-736f-45e1-b1af-60d2fe972418", in: all))
    }

    func testScrollInsetKeepsShortContentAndCapsTallContent() {
        XCTAssertEqual(SHScrollInset<EmptyView>.visibleHeight(contentHeight: 120, maxHeight: 320), 120)
        XCTAssertEqual(SHScrollInset<EmptyView>.visibleHeight(contentHeight: 2400, maxHeight: 320), 320)
        XCTAssertEqual(SHScrollInset<EmptyView>.visibleHeight(contentHeight: 0, maxHeight: 320), 1)
    }

    /// Records the session order each time SwiftUI would be told the list changed.
    @MainActor
    private final class ListPublishRecorder {
        var orders: [[String]] = []
        private let store: AppStore
        init(store: AppStore) { self.store = store; track() }
        private func track() {
            withObservationTracking { _ = store.sessions } onChange: { [weak self] in
                Task { @MainActor [weak self] in
                    guard let self else { return }
                    self.orders.append(self.store.sessions.map(\.id))
                    self.track()
                }
            }
        }
    }

    @MainActor func testABurstOfListUpdatesIsDrawnOnceWithTheFinalOrder() async throws {
        let store = AppStore(client: MockSuperHarnessClient(), keychain: InMemoryKeychainStore(), defaults: UserDefaults(suiteName: "ListBurst.\(UUID().uuidString)")!, environment: [:])
        defer { store.stopEventStream() }
        await store.bootstrap()
        let ids = store.sessions.map(\.id)
        XCTAssertGreaterThan(ids.count, 3)
        let recorder = ListPublishRecorder(store: store)

        let orders = [Array(ids.reversed()), Array(ids.dropFirst() + ids.prefix(1)), Array(ids.dropFirst(2) + ids.prefix(2))]
        for order in orders {
            store.handleServerEvent(.sessionsDelta(SessionsDeltaEnvelope(order: order)), mode: .demo)
        }
        XCTAssertEqual(store.sessions.map(\.id), ids, "updates are held until the burst ends")

        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(store.sessions.map(\.id), orders[2])
        XCTAssertEqual(recorder.orders, [orders[2]], "the intermediate orders are never shown")
    }

    @MainActor func testListStaysStillInTheBackgroundAndShowsOnlyTheFinalStateOnReturn() async throws {
        let store = AppStore(client: MockSuperHarnessClient(), keychain: InMemoryKeychainStore(), defaults: UserDefaults(suiteName: "ListFreeze.\(UUID().uuidString)")!, environment: [:])
        defer { store.stopEventStream() }
        await store.bootstrap()
        let ids = store.sessions.map(\.id)
        let recorder = ListPublishRecorder(store: store)

        await store.handleScenePhaseChanged(.background)
        let orders = [Array(ids.reversed()), Array(ids.dropFirst() + ids.prefix(1)), Array(ids.dropFirst(2) + ids.prefix(2))]
        for order in orders {
            store.handleServerEvent(.sessionsDelta(SessionsDeltaEnvelope(order: order)), mode: .demo)
        }
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(store.sessions.map(\.id), ids, "nothing is applied while the app is away")
        XCTAssertTrue(recorder.orders.isEmpty)

        await store.handleScenePhaseChanged(.active)
        try await Task.sleep(nanoseconds: 400_000_000)
        XCTAssertEqual(store.sessions.map(\.id), orders[2])
        XCTAssertEqual(recorder.orders, [orders[2]], "one redraw, straight to the final order")
    }

    func testPinnedPillRowsHoldFourEachAndKeepEverySession() async throws {
        let payload = try await MockSuperHarnessClient().fetchBootstrap()
        let sessions = Array(payload.sessions.prefix(6))
        XCTAssertEqual(sessions.count, 6)
        let rows = SessionRowFormatting.pillRows(of: sessions, perRow: 4)
        XCTAssertEqual(rows.map(\.count), [4, 2])
        XCTAssertEqual(rows.flatMap { $0 }.map(\.id), sessions.map(\.id))
        XCTAssertTrue(SessionRowFormatting.pillRows(of: [], perRow: 4).isEmpty)
    }

    @MainActor func testChatTextSizeAndDensityPersistAndDriveTheMetrics() {
        let defaults = UserDefaults(suiteName: "ChatAppearance.\(UUID().uuidString)")!
        let store = AppStore(client: MockSuperHarnessClient(), keychain: InMemoryKeychainStore(), defaults: defaults, environment: [:])
        defer { store.stopEventStream() }
        XCTAssertEqual(store.chatTextSize, .standard)
        XCTAssertEqual(store.chatDensity, .comfortable)
        XCTAssertEqual(store.chatMetrics.scale, 1.0)

        store.chatTextSize = .extraLarge
        store.chatDensity = .compact
        XCTAssertEqual(store.chatMetrics.scale, 1.22)
        XCTAssertEqual(store.chatMetrics.messageGap, 16)
        XCTAssertEqual(store.chatMetrics.lineSpacing, 2.5 * 1.22, accuracy: 0.001)
        // At every density: lines are closer than list items, and list items closer than paragraphs.
        for density in ChatDensity.allCases {
            let metrics = SHChatMetrics(textSize: .standard, density: density)
            XCTAssertLessThan(metrics.lineSpacing * 2, metrics.listItemGap)
            XCTAssertLessThan(metrics.listItemGap, metrics.blockGap)
        }

        let reopened = AppStore(client: MockSuperHarnessClient(), keychain: InMemoryKeychainStore(), defaults: defaults, environment: [:])
        defer { reopened.stopEventStream() }
        XCTAssertEqual(reopened.chatTextSize, .extraLarge)
        XCTAssertEqual(reopened.chatDensity, .compact)
        XCTAssertGreaterThan(ChatDensity.spacious.messageGap, ChatDensity.comfortable.messageGap)
    }

    func testCommandContinuationKeepsIndentationAndIsNilForOneLine() {
        XCTAssertNil(ScrollingCommandText.remainingLines(of: "npm test"))
        XCTAssertNil(ScrollingCommandText.remainingLines(of: "npm test\n"))
        let command = "cat > a.txt <<'EOF'\n  indented line\nlast\nEOF\n"
        XCTAssertEqual(ScrollingCommandText.firstLine(of: command), "cat > a.txt <<'EOF'")
        XCTAssertEqual(ScrollingCommandText.remainingLines(of: command), "  indented line\nlast\nEOF")
    }

    func testSettingsButtonGlyphFollowsSyncAndConnectionState() {
        XCTAssertEqual(ConnectionStatusPill.glyph(health: .connected, isSyncing: false), .settings)
        XCTAssertEqual(ConnectionStatusPill.glyph(health: .demo, isSyncing: false), .settings)
        XCTAssertEqual(ConnectionStatusPill.glyph(health: .connected, isSyncing: true), .syncing)
        XCTAssertEqual(ConnectionStatusPill.glyph(health: .connecting, isSyncing: false), .syncing)
        XCTAssertEqual(ConnectionStatusPill.glyph(health: .offline("timed out"), isSyncing: false), .problem)
        // Retrying while offline keeps the warning instead of flipping to the sync arrows.
        XCTAssertEqual(ConnectionStatusPill.glyph(health: .offline("timed out"), isSyncing: true), .problem)
    }

    func testClipboardFileDetectionSeparatesFilesFromTextAndMedia() {
        // A zip shared from another app is a file.
        XCTAssertEqual(ClipboardAttachables.fileTypeIdentifier(in: ["public.zip-archive"]), "public.zip-archive")
        // Copied prose (with rich-text companions) stays text.
        XCTAssertNil(ClipboardAttachables.fileTypeIdentifier(in: ["public.rtf", "com.apple.flat-rtfd", "public.utf8-plain-text"]))
        XCTAssertNil(ClipboardAttachables.fileTypeIdentifier(in: ["public.url", "public.utf8-plain-text"]))
        // Images, PDFs and file URLs have their own handling.
        XCTAssertNil(ClipboardAttachables.fileTypeIdentifier(in: ["public.png"]))
        XCTAssertNil(ClipboardAttachables.fileTypeIdentifier(in: ["com.adobe.pdf"]))
        XCTAssertNil(ClipboardAttachables.fileTypeIdentifier(in: ["public.file-url"]))

        XCTAssertEqual(ClipboardAttachables.fileName(suggested: "super_harness_porcelain_package", typeIdentifier: "public.zip-archive", fallbackURL: nil, index: 0), "super_harness_porcelain_package.zip")
        XCTAssertEqual(ClipboardAttachables.fileName(suggested: "notes.txt", typeIdentifier: "public.zip-archive", fallbackURL: nil, index: 0), "notes.txt")
        XCTAssertEqual(ClipboardAttachables.fileName(suggested: nil, typeIdentifier: "public.zip-archive", fallbackURL: nil, index: 1), "pasted-file-2.zip")
    }

    @MainActor func testOversizeAttachmentIsRefusedWithAClearMessage() async {
        let store = AppStore(client: MockSuperHarnessClient(), keychain: InMemoryKeychainStore(), defaults: UserDefaults(suiteName: "Oversize.\(UUID().uuidString)")!, environment: [:])
        defer { store.stopEventStream() }
        let big = Data(count: AppStore.maxAttachmentBytes + 1)
        await store.addFileAttachment(for: "codex:cx-test-harness", data: big, mimeType: "application/zip", filename: "huge.zip")
        XCTAssertTrue((store.draftAttachments["codex:cx-test-harness"] ?? []).isEmpty)
        XCTAssertEqual(store.attachmentNotice?.contains("huge.zip"), true)
        XCTAssertEqual(store.attachmentNotice?.contains("up to"), true)

        store.attachmentNotice = nil
        await store.addFileAttachment(for: "codex:cx-test-harness", data: Data("hello".utf8), mimeType: "text/plain", filename: "note.txt")
        XCTAssertEqual(store.draftAttachments["codex:cx-test-harness"]?.map(\.name), ["note.txt"])
        XCTAssertNil(store.attachmentNotice)
    }

    func testContextPercentIsWithheldWhenUsageExceedsTheReportedWindow() {
        let normal = SessionStats(contextUsedTokens: 117_000, contextWindowTokens: 1_000_000)
        XCTAssertEqual(normal.contextUsedPercent ?? 0, 11.7, accuracy: 0.01)
        // 684k cannot fit in a 200k window: the window is wrong, so no percentage.
        let impossible = SessionStats(contextUsedTokens: 684_000, contextWindowTokens: 200_000)
        XCTAssertFalse(impossible.hasPlausibleContextWindow)
        XCTAssertNil(impossible.contextUsedPercent)
        XCTAssertNil(SessionStats(contextUsedTokens: 5_000, contextWindowTokens: nil).contextUsedPercent)
    }

    func testWorkingMarkPulseRestsPeaksAndTravelsRoundThePieces() {
        XCTAssertEqual(SuperHarnessMarkGeometry.pieces.count, 4)
        XCTAssertTrue(SuperHarnessMarkGeometry.pieces.allSatisfy { !$0.isEmpty })
        // Every piece lies inside the mark's viewBox.
        for piece in SuperHarnessMarkGeometry.pieces {
            XCTAssertTrue(SuperHarnessMarkGeometry.viewBox.insetBy(dx: -0.01, dy: -0.01).contains(piece.boundingRect))
        }
        let rest = SHWorkingMark.state(atPhase: 0)
        XCTAssertEqual(rest.lift, 0, accuracy: 0.001)
        XCTAssertEqual(rest.opacity, 0.45, accuracy: 0.001)
        let peak = SHWorkingMark.state(atPhase: 0.3)
        XCTAssertEqual(peak.lift, 1, accuracy: 0.001)
        XCTAssertEqual(peak.opacity, 1, accuracy: 0.001)
        XCTAssertEqual(SHWorkingMark.state(atPhase: 0.65).lift, 0, accuracy: 0.001)
        XCTAssertEqual(SHWorkingMark.state(atPhase: 0.65).opacity, 0.55, accuracy: 0.001)
        // The cycle repeats, and the easing ends where it should.
        XCTAssertEqual(SHWorkingMark.state(atPhase: 1.3), peak)
        XCTAssertEqual(SHWorkingMark.ease(0), 0, accuracy: 0.001)
        XCTAssertEqual(SHWorkingMark.ease(1), 1, accuracy: 0.001)
        // At any instant the four pieces are a quarter cycle apart, so exactly one is near its peak.
        let lifts = SHWorkingMark.phaseOffsets.map { SHWorkingMark.state(atPhase: 0.3 + $0).lift }
        XCTAssertEqual(lifts.filter { $0 > 0.9 }.count, 1)
    }

    func testPinnedOrderArrangesMovesAndInserts() {
        // Listed pins come first in the listed order; unknown ids are ignored; the rest follow.
        XCTAssertEqual(PinnedOrder.arranged(["a", "b", "c", "d"], by: ["c", "gone", "a"]), ["c", "a", "b", "d"])
        XCTAssertEqual(PinnedOrder.arranged(["a", "b"], by: []), ["a", "b"])

        // Moving the last visible pin to the top.
        XCTAssertEqual(PinnedOrder.afterMove(full: ["a", "b", "c"], visible: ["a", "b", "c"], fromOffsets: IndexSet(integer: 2), toOffset: 0), ["c", "a", "b"])
        // With a filter hiding "b", reordering "a" and "c" leaves "b" in its slot.
        XCTAssertEqual(PinnedOrder.afterMove(full: ["a", "b", "c"], visible: ["a", "c"], fromOffsets: IndexSet(integer: 1), toOffset: 0), ["c", "b", "a"])

        // Dropping a new chat at the top, in the middle and at the end.
        XCTAssertEqual(PinnedOrder.afterInsert("x", atVisibleIndex: 0, full: ["a", "b", "x"], visible: ["a", "b"]), ["x", "a", "b"])
        XCTAssertEqual(PinnedOrder.afterInsert("x", atVisibleIndex: 1, full: ["a", "b", "x"], visible: ["a", "b"]), ["a", "x", "b"])
        XCTAssertEqual(PinnedOrder.afterInsert("x", atVisibleIndex: 2, full: ["a", "b", "x"], visible: ["a", "b"]), ["a", "b", "x"])
        XCTAssertEqual(PinnedOrder.afterInsert("x", atVisibleIndex: 0, full: ["x"], visible: []), ["x"])

        XCTAssertEqual(SessionDragItem.sessionId(from: "superharness-session:codex:abc"), "codex:abc")
        XCTAssertNil(SessionDragItem.sessionId(from: "some other dragged text"))
    }

    @MainActor func testDraggingPinsReordersThemAndDroppingAChatPinsItThere() async throws {
        let defaults = UserDefaults(suiteName: "PinnedOrder.\(UUID().uuidString)")!
        let client = MockSuperHarnessClient()
        let store = AppStore(client: client, keychain: InMemoryKeychainStore(), defaults: defaults, environment: [:])
        defer { store.stopEventStream() }
        await store.bootstrap()
        let pinned = store.pinnedToTopSessions.map(\.id)
        XCTAssertEqual(pinned.count, 2)

        store.movePinned(fromOffsets: IndexSet(integer: 1), toOffset: 0)
        XCTAssertEqual(store.pinnedToTopSessions.map(\.id), [pinned[1], pinned[0]])
        XCTAssertEqual(defaults.stringArray(forKey: "sh.pinnedOrder") ?? [], [pinned[1], pinned[0]])

        let other = try XCTUnwrap(store.sessions.first { !$0.pinnedToTop && !$0.isMaster })
        await store.pinSession(other.id, atVisibleIndex: 1)
        XCTAssertEqual(store.pinnedToTopSessions.map(\.id), [pinned[1], other.id, pinned[0]])
        XCTAssertEqual(store.sessions.first { $0.id == other.id }?.pinnedToTop, true)

        // The order reaches the host shortly after the last change.
        try await Task.sleep(nanoseconds: 1_100_000_000)
        let hostOrder = try await client.fetchBootstrap().state?.settings.pinnedOrder
        XCTAssertEqual(hostOrder, [pinned[1], other.id, pinned[0]])
    }
}
