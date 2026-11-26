import Foundation
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
}
