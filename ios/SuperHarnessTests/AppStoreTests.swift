import Foundation
import XCTest
#if canImport(UserNotifications)
import UserNotifications
#endif
@testable import SuperHarness

@MainActor
final class AppStoreTests: XCTestCase {
    private func makeStore() async -> AppStore {
        let suiteName = "AppStoreTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        let keychain = InMemoryKeychainStore()
        let store = AppStore(client: MockSuperHarnessClient(), keychain: keychain, defaults: defaults)
        await store.bootstrap()
        return store
    }

    func testDraftsSurviveRelaunchUntilSentOrDeleted() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("AppStoreTests-drafts-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        let first = await makeStore()
        first.enableDraftPersistence(directory: directory)
        let sessionId = try XCTUnwrap(first.sessions.first(where: { !$0.isMaster })?.id)
        let photo = ImageAttachment(name: "photo-1.jpg", previewDataUrl: "data:image/jpeg;base64,AAAA")

        first.draftInputs[sessionId] = "half-typed reply"
        first.draftInputs[AppStore.newThreadDraftKey] = "new thread idea"
        first.draftAttachments[AppStore.newThreadDraftKey] = [photo]
        first.newThreadConfig = NewThreadDraftConfig(
            harness: .claudeTmux, projectPath: "/tmp/project", modelId: "opus", reasoning: "medium", remoteControl: true
        )
        first.flushDrafts()
        first.stopEventStream()

        // A fresh store (app relaunch) restores text, attachments and the New Chat setup.
        let second = await makeStore()
        defer { second.stopEventStream() }
        second.enableDraftPersistence(directory: directory)
        XCTAssertEqual(second.draftInputs[sessionId], "half-typed reply")
        XCTAssertEqual(second.draftInputs[AppStore.newThreadDraftKey], "new thread idea")
        XCTAssertEqual(second.draftAttachments[AppStore.newThreadDraftKey], [photo])
        XCTAssertEqual(second.newThreadConfig.harness, .claudeTmux)
        XCTAssertEqual(second.newThreadConfig.modelId, "opus")
        XCTAssertTrue(second.newThreadConfig.remoteControl)

        // Leaving the New Chat page and reopening it keeps the draft and the chosen harness.
        second.openDraftChat()
        second.clearDetailRoute()
        second.openDraftChat()
        XCTAssertEqual(second.detailRoute, .draft(.claudeTmux))
        XCTAssertEqual(second.draftInputs[AppStore.newThreadDraftKey], "new thread idea")

        // Opening it for a specific harness switches harness but keeps the message.
        second.openDraftChat(for: .codex)
        XCTAssertEqual(second.detailRoute, .draft(.codex))
        XCTAssertEqual(second.draftInputs[AppStore.newThreadDraftKey], "new thread idea")

        // Starting the session is what clears the New Chat draft; the session draft is untouched.
        second.clearNewThreadDraft()
        second.flushDrafts()
        let saved = DraftPersistence(directory: directory).load()
        XCTAssertNil(saved.inputs[AppStore.newThreadDraftKey])
        XCTAssertNil(saved.attachments[AppStore.newThreadDraftKey])
        XCTAssertEqual(saved.inputs[sessionId], "half-typed reply")
    }

    func testBootstrapLoadsDemoFixturesAndFiltersCorrectly() async {
        let store = await makeStore()
        defer { store.stopEventStream() }

        XCTAssertNotNil(store.masterSession)
        XCTAssertEqual(store.harnesses.count, 5)
        XCTAssertTrue(store.harnesses.contains(where: { $0.id == .muse }))
        XCTAssertTrue(store.harnesses.contains(where: { $0.id == .pi }))
        XCTAssertNotNil(store.usage)
        XCTAssertNotNil(store.usage?.muse)
        XCTAssertEqual(store.usage?.pi?.spend24hUsd, 1.2)
        XCTAssertNotNil(store.catalog)
        XCTAssertFalse(store.pinnedToTopSessions.isEmpty)

        // Filter by Muse
        store.selectedHarnessFilter = .muse
        let museOnly = store.filteredNonMasterSessions
        XCTAssertFalse(museOnly.isEmpty)
        XCTAssertTrue(museOnly.allSatisfy { $0.harness.harnessGroup == .muse })

        // Filter by Codex
        store.selectedHarnessFilter = .codex
        let codexOnly = store.filteredNonMasterSessions
        XCTAssertFalse(codexOnly.isEmpty)
        XCTAssertTrue(codexOnly.allSatisfy { $0.harness.harnessGroup == .codex })

        // Search query
        store.selectedHarnessFilter = nil
        store.searchQuery = "tailscale"
        let matches = store.filteredNonMasterSessions
        XCTAssertEqual(matches.count, 1)
        XCTAssertEqual(matches.first?.id, "codex:cx-control-server")
    }

    func testPinPinToTopHideAndArchiveActions() async {
        let store = await makeStore()
        defer { store.stopEventStream() }

        guard let target = store.sessions.first(where: { $0.id == "claude-tmux:cc-usage-redesign" }) else {
            return XCTFail("Expected demo session")
        }
        XCTAssertFalse(target.pinned)
        XCTAssertFalse(target.pinnedToTop)

        await store.togglePin(target)
        XCTAssertTrue(store.sessions.first(where: { $0.id == target.id })?.pinned == true)

        if let updated = store.sessions.first(where: { $0.id == target.id }) {
            await store.togglePinToTop(updated)
        }
        XCTAssertTrue(store.pinnedToTopSessions.contains(where: { $0.id == target.id }))

        if let updated = store.sessions.first(where: { $0.id == target.id }) {
            await store.toggleHideSession(updated)
        }
        XCTAssertFalse(store.filteredNonMasterSessions.contains(where: { $0.id == target.id }))

        if let updated = store.sessions.first(where: { $0.id == target.id }) {
            await store.archiveSession(updated)
        }
        XCTAssertEqual(store.sessions.first(where: { $0.id == target.id })?.status, .archived)
    }

    func testDemoQueueWhenBusyAndAbortStopsRun() async {
        let store = await makeStore()
        defer { store.stopEventStream() }

        // antigravity:agy-ios-companion starts in working state in MockSuperHarnessClient
        let busyId = "antigravity:agy-ios-companion"
        await store.loadTranscript(for: busyId)
        XCTAssertTrue(store.isSessionBusy(busyId))
        let initialQueuedCount = store.liveActivity(for: busyId)?.queuedMessages?.count ?? 0

        // Sending while busy should queue the follow-up message
        await store.sendMessage(for: busyId, text: "Queued follow-up test")
        await store.loadTranscript(for: busyId)
        let afterQueuedCount = store.liveActivity(for: busyId)?.queuedMessages?.count ?? 0
        XCTAssertEqual(afterQueuedCount, initialQueuedCount + 1)

        // Aborting should mark session idle
        await store.abortRun(for: busyId)
        XCTAssertFalse(store.isSessionBusy(busyId))
    }

    func testDemoSendStartsStreamingAndProducesAssistantReply() async {
        let store = await makeStore()
        defer { store.stopEventStream() }

        let sessionId = "claude-tmux:cc-usage-redesign"
        await store.loadTranscript(for: sessionId)
        let beforeCount = store.messages(for: sessionId).count

        await store.sendMessage(for: sessionId, text: "Verify hero window math")
        // Give MockSuperHarnessClient brief time to process simulated reply
        try? await Task.sleep(nanoseconds: 1_900_000_000)
        await store.loadTranscript(for: sessionId)

        let afterMessages = store.messages(for: sessionId)
        XCTAssertGreaterThanOrEqual(afterMessages.count, beforeCount + 2)
        XCTAssertFalse(store.isSessionBusy(sessionId))
    }

    func testEnvironmentOverridesConfigureLiveHostWhenNoClientInjected() {
        let suiteName = "AppStoreEnvTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        let keychain = InMemoryKeychainStore()

        let store = AppStore(
            client: nil,
            keychain: keychain,
            defaults: defaults,
            environment: [
                "SH_HOST_URL": "http://100.64.0.10:47890",
                "SH_BEARER_TOKEN": "secret-token-xyz",
                "SH_CONNECTION_MODE": "live",
            ]
        )

        XCTAssertEqual(store.hostURLString, "http://100.64.0.10:47890")
        XCTAssertEqual(store.bearerToken, "secret-token-xyz")
        XCTAssertEqual(store.connectionMode, .live)
        XCTAssertEqual(store.connectionHealth, .connecting)
        XCTAssertEqual(defaults.string(forKey: "sh.hostURL"), "http://100.64.0.10:47890")
        XCTAssertEqual(defaults.string(forKey: "sh.connectionMode"), "live")
        XCTAssertEqual(keychain.loadToken(for: "desktop-control-server"), "secret-token-xyz")
    }

    func testSelectSessionCallsWatchSessionAndResyncRequiredTriggersBootstrap() async {
        let suiteName = "AppStoreSyncV1Tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        let keychain = InMemoryKeychainStore()
        let mock = MockSuperHarnessClient()
        let store = AppStore(client: mock, keychain: keychain, defaults: defaults)
        defer { store.stopEventStream() }

        await store.bootstrap()
        XCTAssertEqual(store.protocolVersion, 1)
        let initialBootstraps = await mock.bootstrapCallCount
        XCTAssertEqual(initialBootstraps, 1)

        // Selecting a session calls watchSession with its ID
        store.selectSession("codex:cx-control-server")
        try? await Task.sleep(nanoseconds: 120_000_000)
        let watchedAfterSelect = await mock.watchedSessions
        XCTAssertTrue(watchedAfterSelect.contains("codex:cx-control-server"))

        // Emitting resync_required over SSE triggers a lightweight resync()
        await mock.emitServerEventForTesting(.resyncRequired)
        try? await Task.sleep(nanoseconds: 180_000_000)
        let afterResyncBootstraps = await mock.bootstrapCallCount
        XCTAssertGreaterThan(afterResyncBootstraps, initialBootstraps)

        // loadMediaData fetches and caches media bytes
        let firstBytes = await store.loadMediaData(path: "/tmp/sample.png")
        XCTAssertNotNil(firstBytes)
        XCTAssertFalse(firstBytes?.isEmpty ?? true)
    }

    func testInitialSessionIdEnvVarAndSessionRowSubtitleFormatting() async {
        let suiteName = "AppStoreInitialSessionTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        let keychain = InMemoryKeychainStore()
        let store = AppStore(
            client: MockSuperHarnessClient(),
            keychain: keychain,
            defaults: defaults,
            environment: ["SH_INITIAL_SESSION_ID": "codex:cx-control-server"]
        )
        defer { store.stopEventStream() }

        await store.bootstrap()
        XCTAssertEqual(store.selectedSessionId, "codex:cx-control-server")
        XCTAssertEqual(store.pendingInitialSessionId, "codex:cx-control-server")

        // Subtitle formatting suppresses redundant harness names and duplicate previews
        let duplicateSession = UnifiedSession(
            id: "antigravity:dup",
            harness: .antigravity,
            title: "Blue Bubbles Native Project",
            preview: "  blue bubbles   native project  ",
            projectName: "Antigravity"
        )
        XCTAssertNil(SessionRowFormatting.cleanPreview(for: duplicateSession))
        XCTAssertNil(SessionRowFormatting.cleanProjectName(for: duplicateSession))

        let distinctSession = UnifiedSession(
            id: "codex:real",
            harness: .codex,
            title: "Fix mobile SSE reconnect",
            preview: "Added Last-Event-ID replay buffer handling",
            projectName: "super-harness"
        )
        XCTAssertEqual(SessionRowFormatting.cleanPreview(for: distinctSession), "Added Last-Event-ID replay buffer handling")
        XCTAssertEqual(SessionRowFormatting.cleanProjectName(for: distinctSession), "super-harness")
    }

    func testArchiveActiveSessionClearsRouteAndDraftRouteFlow() async {
        let suiteName = "AppStoreDraftArchiveTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        let keychain = InMemoryKeychainStore()
        let mock = MockSuperHarnessClient()
        let store = AppStore(client: mock, keychain: keychain, defaults: defaults)
        defer { store.stopEventStream() }

        await store.bootstrap()

        // Open inline draft chat for Codex
        store.openDraftChat(for: .codex)
        XCTAssertNil(store.selectedSessionId)
        XCTAssertEqual(store.detailRoute, .draft(.codex))

        // Starting a session transitions cleanly to .session(newId)
        let startedId = await store.startSession(
            StartSessionRequest(
                harness: .codex,
                cwd: "/Users/lxe/Developer/super-harness",
                prompt: "Run smoke check"
            )
        )
        XCTAssertNotNil(startedId)
        XCTAssertEqual(store.selectedSessionId, startedId)
        XCTAssertEqual(store.detailRoute, startedId.map { .session($0) })

        // Archiving the currently active session clears selection & detailRoute cleanly
        if let active = store.activeSession {
            await store.archiveSession(active)
        }
        XCTAssertNil(store.selectedSessionId)
        XCTAssertNil(store.detailRoute)

        // Env var SH_INITIAL_ROUTE=draft initializes directly into DraftChatView route
        let draftEnvStore = AppStore(
            client: nil,
            keychain: InMemoryKeychainStore(),
            defaults: UserDefaults(suiteName: "AppStoreDraftEnv.\(UUID().uuidString)")!,
            environment: [
                "SH_INITIAL_ROUTE": "draft",
                "SH_INITIAL_HARNESS": "claude-cli",
            ]
        )
        XCTAssertEqual(draftEnvStore.detailRoute, .draft(.claudeCli))
        XCTAssertEqual(draftEnvStore.pendingInitialRoute, .draft(.claudeCli))
    }

    func testSetSessionModelDeduplicatesTranscriptsAndFiltersProjectsPerHarness() async {
        let suiteName = "AppStorePerfDictationTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        let keychain = InMemoryKeychainStore()
        let store = AppStore(client: MockSuperHarnessClient(), keychain: keychain, defaults: defaults)
        defer { store.stopEventStream() }

        await store.bootstrap()

        // 1. Mid-session model & effort switching
        let sid = "codex:cx-control-server"
        await store.setSessionModel(sessionId: sid, model: "gpt-5.3-codex-mini", reasoningEffort: "medium")
        let updated = store.sessions.first(where: { $0.id == sid })
        XCTAssertEqual(updated?.model, "gpt-5.3-codex-mini")
        XCTAssertEqual(updated?.reasoningEffort, "medium")

        // 2. Per-harness project filtering
        let codexProjects = DraftProjectFilter.projects(for: .codex, in: store.catalog)
        XCTAssertTrue(codexProjects.allSatisfy { $0.harnesses.contains(.codex) })
        XCTAssertFalse(codexProjects.contains(where: { $0.name == "obsidian-kit" }))

        let agyProjects = DraftProjectFilter.projects(for: .antigravity, in: store.catalog)
        XCTAssertTrue(agyProjects.contains(where: { $0.name == "obsidian-kit" }))
        XCTAssertFalse(agyProjects.contains(where: { $0.name == "security-playbooks" }))

        // 3. Tail-only limit default (15) & loadEarlierMessages (+25 -> 40)
        XCTAssertEqual(store.transcriptLimit(for: sid), 15)
        await store.loadEarlierMessages(for: sid)
        XCTAssertEqual(store.transcriptLimit(for: sid), 40)

        // 4. Transcript SSE deduplication
        let tr = SessionTranscriptResult(
            sessionId: sid,
            messages: [UnifiedMessage(id: "m-1", role: .assistant, timestamp: 1000, blocks: [.text(text: "Hi")])],
            totalCount: 1,
            hasMore: false,
            sourceMtimeMs: 9999,
            liveActivity: LiveActivityState(isWorking: false)
        )
        XCTAssertTrue(store.applyTranscriptUpdate(tr))
        XCTAssertFalse(store.applyTranscriptUpdate(tr))

        var trChanged = tr
        trChanged.sourceMtimeMs = 10000
        XCTAssertTrue(store.applyTranscriptUpdate(trChanged))

        // 5. Dictation status & transcription via mock
        await store.refreshDictationStatus()
        XCTAssertEqual(store.dictationStatus?.healthy, true)
        XCTAssertEqual(store.dictationStatus?.model, "whisper-large-v3-turbo")
    }

    func testColdLaunchOfflineAutoReconnectsWhenDesktopOpens() async {
        let defaults = UserDefaults(suiteName: "AppStoreReconnectCold.\(UUID().uuidString)")!
        defaults.set(ConnectionMode.live.rawValue, forKey: "sh.connectionMode")
        let mock = MockSuperHarnessClient()
        await mock.setSimulateOffline(true)

        let store = AppStore(
            client: mock,
            keychain: InMemoryKeychainStore(),
            defaults: defaults,
            reconnectIntervalNs: 40_000_000
        )
        defer { store.stopEventStream() }

        await store.bootstrap()
        XCTAssertTrue(store.sessions.isEmpty)
        XCTAssertNotNil(store.lastError)
        if case .offline = store.connectionHealth {} else {
            XCTFail("Expected .offline after failed cold bootstrap, got \(store.connectionHealth)")
        }

        // Desktop app opens
        await mock.setSimulateOffline(false)

        // Wait up to 600ms for autoReconnectLoop to recover
        for _ in 0..<20 {
            if store.connectionHealth == .connected && !store.sessions.isEmpty { break }
            try? await Task.sleep(nanoseconds: 30_000_000)
        }

        XCTAssertEqual(store.connectionHealth, .connected)
        XCTAssertNil(store.lastError)
        XCTAssertFalse(store.sessions.isEmpty)
    }

    func testMidSessionDisconnectThenConnectedClearsErrorAndResyncs() async {
        let defaults = UserDefaults(suiteName: "AppStoreReconnectMid.\(UUID().uuidString)")!
        defaults.set(ConnectionMode.live.rawValue, forKey: "sh.connectionMode")
        let mock = MockSuperHarnessClient()
        let store = AppStore(
            client: mock,
            keychain: InMemoryKeychainStore(),
            defaults: defaults,
            reconnectIntervalNs: 5_000_000_000
        )
        defer { store.stopEventStream() }

        await store.bootstrap()
        try? await Task.sleep(nanoseconds: 80_000_000)
        let beforeBootstraps = await mock.bootstrapCallCount

        store.lastError = "Stale network error"
        await mock.emitServerEventForTesting(.disconnected("Connection lost"))
        try? await Task.sleep(nanoseconds: 80_000_000)
        if case .offline = store.connectionHealth {} else {
            XCTFail("Expected .offline on disconnect")
        }

        await mock.emitServerEventForTesting(.connected)
        for _ in 0..<20 {
            let currentCount = await mock.bootstrapCallCount
            if store.connectionHealth == .connected && currentCount > beforeBootstraps { break }
            try? await Task.sleep(nanoseconds: 30_000_000)
        }

        XCTAssertEqual(store.connectionHealth, .connected)
        XCTAssertNil(store.lastError)
        let afterBootstraps = await mock.bootstrapCallCount
        XCTAssertGreaterThan(afterBootstraps, beforeBootstraps)
    }

    func testSceneBecameActiveRetriesBootstrapWhenNotYetBootstrapped() async {
        let defaults = UserDefaults(suiteName: "AppStoreReconnectForeground.\(UUID().uuidString)")!
        defaults.set(ConnectionMode.live.rawValue, forKey: "sh.connectionMode")
        let mock = MockSuperHarnessClient()
        await mock.setSimulateOffline(true)

        let store = AppStore(
            client: mock,
            keychain: InMemoryKeychainStore(),
            defaults: defaults,
            reconnectIntervalNs: 60_000_000_000
        )
        defer { store.stopEventStream() }

        await store.bootstrap()
        XCTAssertTrue(store.sessions.isEmpty)
        if case .offline = store.connectionHealth {} else {
            XCTFail("Expected .offline before foreground retry")
        }

        // Simulate app going to background, Desktop opening, then returning to foreground
        await store.handleScenePhaseChanged(.background)
        await mock.setSimulateOffline(false)
        await store.handleSceneBecameActive()

        XCTAssertEqual(store.connectionHealth, .connected)
        XCTAssertNil(store.lastError)
        XCTAssertFalse(store.sessions.isEmpty)
    }

    func testOptimisticPendingMessageInsertionReconciliationExpiryAndRetry() async {
        let defaults = UserDefaults(suiteName: "AppStorePending.\(UUID().uuidString)")!
        let mock = MockSuperHarnessClient()
        let store = AppStore(client: mock, keychain: InMemoryKeychainStore(), defaults: defaults)
        defer { store.stopEventStream() }

        await store.bootstrap()
        let sid = "muse:muse-orb-review"
        await store.loadTranscript(for: sid)

        // 1. Synchronous optimistic insertion clears draft and immediately renders pending bubble
        await mock.setSimulateSendError("Host temporarily unreachable")
        store.draftInputs[sid] = "Ship optimistic user bubbles"
        let pending = store.submitMessage(for: sid)
        XCTAssertNotNil(pending)
        XCTAssertEqual(store.draftInputs[sid], "")
        XCTAssertEqual(store.pendingOutgoingBySessionId[sid]?.count, 1)
        XCTAssertEqual(store.pendingOutgoingBySessionId[sid]?.first?.state, .sending)
        XCTAssertTrue(store.messages(for: sid).contains(where: { $0.id == pending?.messageId && $0.role == .user }))

        // 2. Send failure keeps the bubble in .failed state
        try? await Task.sleep(nanoseconds: 120_000_000)
        if case .failed(let err) = store.pendingOutgoingBySessionId[sid]?.first?.state {
            XCTAssertEqual(err, "Host temporarily unreachable")
        } else {
            XCTFail("Expected failed delivery state")
        }
        XCTAssertTrue(store.messages(for: sid).contains(where: { $0.id == pending?.messageId }))

        // 3. Retry clears error and reconciles away once transcript echoes the user message
        await mock.setSimulateSendError(nil)
        if let messageId = pending?.messageId {
            store.retryPendingMessage(for: sid, messageId: messageId)
        }
        try? await Task.sleep(nanoseconds: 150_000_000)
        XCTAssertTrue(store.pendingOutgoingBySessionId[sid]?.isEmpty ?? true)

        // 4. Direct reconciliation matches text within timestamp >= createdAt - 10s & expires .sent after 90s
        let baseTs = 1_732_500_000_000.0
        store.pendingOutgoingBySessionId[sid] = [
            PendingOutgoingMessage(id: "p-match", text: "Check pace bar", createdAt: baseTs, state: .sent),
            PendingOutgoingMessage(id: "p-expired", text: "Old message", createdAt: baseTs - 95_000, state: .sent),
            PendingOutgoingMessage(id: "p-keep", text: "Still in flight", createdAt: baseTs, state: .sending),
        ]
        let echoed = SessionTranscriptResult(
            sessionId: sid,
            messages: [
                UnifiedMessage(
                    id: "u-echo",
                    role: .user,
                    timestamp: baseTs - 5_000,
                    blocks: [.text(text: "Check pace bar")]
                ),
            ],
            sourceMtimeMs: baseTs
        )
        store.reconcilePendingOutgoing(for: sid, transcript: echoed, nowMs: baseTs)
        XCTAssertEqual(store.pendingOutgoingBySessionId[sid]?.map(\.id), ["p-keep"])
    }

    func testUnchangedSessionsAndActivityUpdatesDoNotMutateObservedProperties() async {
        final class FlagBox: @unchecked Sendable {
            private let lock = NSLock()
            private var value = false
            func set() { lock.lock(); value = true; lock.unlock() }
            func get() -> Bool { lock.lock(); defer { lock.unlock() }; return value }
        }

        let defaults = UserDefaults(suiteName: "AppStoreNoopDiff.\(UUID().uuidString)")!
        let mock = MockSuperHarnessClient()
        let store = AppStore(client: mock, keychain: InMemoryKeychainStore(), defaults: defaults)
        defer { store.stopEventStream() }

        await store.bootstrap()
        try? await Task.sleep(nanoseconds: 80_000_000)

        let sessionsChanged = FlagBox()
        let harnessesChanged = FlagBox()
        let workingChanged = FlagBox()

        withObservationTracking {
            _ = store.sessions
        } onChange: {
            sessionsChanged.set()
        }
        withObservationTracking {
            _ = store.harnesses
        } onChange: {
            harnessesChanged.set()
        }
        withObservationTracking {
            _ = store.hostWorkingSessionIds
        } onChange: {
            workingChanged.set()
        }

        // Emit identical sessions + harnesses + activity -> none of the tracked properties should fire onChange
        await mock.emitServerEventForTesting(
            .sessions(
                harnesses: store.harnesses,
                sessions: store.sessions,
                workingSessionIds: Array(store.hostWorkingSessionIds)
            )
        )
        await mock.emitServerEventForTesting(.activity(Array(store.hostWorkingSessionIds)))
        try? await Task.sleep(nanoseconds: 100_000_000)

        XCTAssertFalse(sessionsChanged.get())
        XCTAssertFalse(harnessesChanged.get())
        XCTAssertFalse(workingChanged.get())
    }

    func testActivityEventMirrorsHostWorkingSpinnersAndMasterStaysIdle() async {
        let defaults = UserDefaults(suiteName: "AppStoreActivity.\(UUID().uuidString)")!
        let mock = MockSuperHarnessClient()
        let store = AppStore(client: mock, keychain: InMemoryKeychainStore(), defaults: defaults)
        defer { store.stopEventStream() }

        await store.bootstrap()
        try? await Task.sleep(nanoseconds: 80_000_000)

        // Initial bootstrap mirrors activeWorkingSessionIds from host
        XCTAssertTrue(store.hostWorkingSessionIds.contains("antigravity:agy-ios-companion"))
        XCTAssertFalse(store.isSessionBusy("master:root"))

        // Emit SSE event: activity with codex + muse working
        await mock.emitServerEventForTesting(.activity(["codex:cx-control-server", "muse:muse-orb-review"]))
        try? await Task.sleep(nanoseconds: 100_000_000)

        XCTAssertEqual(store.hostWorkingSessionIds, Set(["codex:cx-control-server", "muse:muse-orb-review"]))
        XCTAssertTrue(store.isSessionBusy("codex:cx-control-server"))
        XCTAssertTrue(store.isSessionBusy("muse:muse-orb-review"))
        XCTAssertTrue(store.isAnyWorking(for: .codex))
        XCTAssertTrue(store.isAnyWorking(for: .muse))
        XCTAssertFalse(store.isSessionBusy("master:root"))

        // Clearing activity stops spinners on idle sessions
        await mock.emitServerEventForTesting(.activity([]))
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertTrue(store.hostWorkingSessionIds.isEmpty)
        XCTAssertFalse(store.isSessionBusy("codex:cx-control-server"))
        XCTAssertFalse(store.isSessionBusy("muse:muse-orb-review"))
    }

    /// Regression: right after a send, the host's working list lags the open chat's transcript.
    /// A lagging list must not wipe the open chat's working state (the Running row flashed).
    func testLaggingActivityListDoesNotClearOpenChatWorkingState() async {
        let defaults = UserDefaults(suiteName: "AppStoreLag.\(UUID().uuidString)")!
        let mock = MockSuperHarnessClient()
        let store = AppStore(client: mock, keychain: InMemoryKeychainStore(), defaults: defaults)
        defer { store.stopEventStream() }
        await store.bootstrap()
        try? await Task.sleep(nanoseconds: 80_000_000)

        let sid = "codex:cx-control-server"
        store.selectedSessionId = sid
        store.applyTranscriptUpdate(SessionTranscriptResult(
            sessionId: sid,
            messages: [UnifiedMessage(id: "m1", role: .user, timestamp: 1000, blocks: [.text(text: "hi")])],
            hasMore: false,
            sourceMtimeMs: 1000,
            liveActivity: LiveActivityState(isWorking: true)
        ))

        // The host's list has not caught up with the new turn yet.
        await mock.emitServerEventForTesting(.activity([]))
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(store.transcriptsBySessionId[sid]?.liveActivity?.isWorking, true)

        // Once the chat is no longer open, the host's list is trusted again.
        store.selectedSessionId = nil
        await mock.emitServerEventForTesting(.activity(["muse:muse-orb-review"]))
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(store.transcriptsBySessionId[sid]?.liveActivity?.isWorking, false)
    }

    func testProtocolV2SessionsDeltaUpsertsRemovesReordersAndSkipsNoOp() async {
        final class FlagBox: @unchecked Sendable {
            private let lock = NSLock()
            private var value = false
            func set() { lock.lock(); value = true; lock.unlock() }
            func get() -> Bool { lock.lock(); defer { lock.unlock() }; return value }
        }

        let defaults = UserDefaults(suiteName: "AppStoreDelta.\(UUID().uuidString)")!
        let mock = MockSuperHarnessClient()
        let store = AppStore(client: mock, keychain: InMemoryKeychainStore(), defaults: defaults)
        defer { store.stopEventStream() }

        await store.bootstrap()
        try? await Task.sleep(nanoseconds: 80_000_000)

        let existingCount = store.sessions.count
        guard var updatedCodex = store.sessions.first(where: { $0.id == "codex:cx-control-server" }) else {
            return XCTFail("Expected codex session")
        }
        updatedCodex.title = "Protocol v2 Delta Updated Title"

        let brandNew = UnifiedSession(
            id: "muse:delta-new",
            harness: .muse,
            title: "Fresh Delta Session",
            updatedAt: Date().timeIntervalSince1970 * 1000.0
        )

        let delta = SessionsDeltaEnvelope(
            upserts: [updatedCodex, brandNew],
            removedIds: ["codex:cx-test-harness"],
            order: ["muse:delta-new", "codex:cx-control-server"],
            harnesses: nil,
            activeWorkingSessionIds: ["muse:delta-new"]
        )
        await mock.emitServerEventForTesting(.sessionsDelta(delta))
        try? await Task.sleep(nanoseconds: 100_000_000)

        XCTAssertEqual(store.sessions.count, existingCount) // +1 added, -1 removed
        XCTAssertFalse(store.sessions.contains(where: { $0.id == "codex:cx-test-harness" }))
        XCTAssertEqual(store.sessions.first?.id, "muse:delta-new")
        XCTAssertEqual(store.sessions[1].id, "codex:cx-control-server")
        XCTAssertEqual(store.sessions[1].title, "Protocol v2 Delta Updated Title")
        XCTAssertEqual(store.hostWorkingSessionIds, Set(["muse:delta-new"]))
        XCTAssertTrue(store.isSessionBusy("muse:delta-new"))

        // Re-applying an identical no-op delta must NOT trigger observation mutation on store.sessions
        let sessionsMutated = FlagBox()
        withObservationTracking {
            _ = store.sessions
        } onChange: {
            sessionsMutated.set()
        }
        let noopDelta = SessionsDeltaEnvelope(
            upserts: [updatedCodex],
            removedIds: [],
            order: nil,
            harnesses: nil,
            activeWorkingSessionIds: ["muse:delta-new"]
        )
        store.applySessionsDelta(noopDelta)
        XCTAssertFalse(sessionsMutated.get())
    }

    @MainActor
    func testStreamOverlayDeduplicatesPersistedMultiToolClaudeTurn() {
        let sid = "claude:multi-tool-test"
        let store = AppStore(client: MockSuperHarnessClient(), keychain: InMemoryKeychainStore(), defaults: .init(suiteName: UUID().uuidString)!)

        // Initial persisted transcript before the turn starts
        let initialUser = UnifiedMessage(id: "u-1", role: .user, timestamp: 1000, blocks: [.text(text: "check omnara")])
        let prevAssistant = UnifiedMessage(id: "a-1", role: .assistant, timestamp: 1001, blocks: [.text(text: "previous reply")])
        store.applyTranscriptUpdate(SessionTranscriptResult(
            sessionId: sid,
            messages: [initialUser, prevAssistant],
            totalCount: 2,
            hasMore: false,
            liveActivity: LiveActivityState(isWorking: false)
        ))

        // 1. Stream starts -> captures baseline (a-1, 1 block); empty streaming bubble is NOT shown
        store.applyStreamEvent(StreamEvent(sessionId: sid, runId: "r-1", kind: .start))
        XCTAssertEqual(store.messages(for: sid).count, 2, "Empty start stream event should not render a blank duplicate bubble")

        // 2. Before persistence catches up, live stream blocks & text SHOULD render
        let cmd1 = UnifiedBlock.command(command: "ls -la", cwd: nil, output: nil, exitCode: nil, durationMs: nil, status: "running")
        let cmd2 = UnifiedBlock.command(command: "git status", cwd: nil, output: nil, exitCode: nil, durationMs: nil, status: "running")
        store.applyStreamEvent(StreamEvent(sessionId: sid, runId: "r-1", kind: .block, block: cmd1))
        store.applyStreamEvent(StreamEvent(sessionId: sid, runId: "r-1", kind: .block, block: cmd2))
        store.applyStreamEvent(StreamEvent(sessionId: sid, runId: "r-1", kind: .delta, text: "Omnara is already on the page, but without its X handle."))

        let prePersistMsgs = store.messages(for: sid)
        XCTAssertEqual(prePersistMsgs.count, 3)
        XCTAssertEqual(prePersistMsgs.last?.id, "stream-r-1")
        XCTAssertEqual(prePersistMsgs.last?.blocks.count, 3)

        // 3. LiveSync pushes persisted active assistant turn with those exact commands + text + 2 more commands
        let cmd3 = UnifiedBlock.command(command: "python3 fix.py", cwd: nil, output: "ok", exitCode: 0, durationMs: 50, status: "completed")
        let cmd4 = UnifiedBlock.command(command: "git diff", cwd: nil, output: nil, exitCode: nil, durationMs: nil, status: "running")
        let persistedTurn = UnifiedMessage(
            id: "a-2",
            role: .assistant,
            timestamp: 2000,
            blocks: [cmd1, cmd2, .text(text: "Omnara is already on the page, but without its X handle."), cmd3, cmd4]
        )
        store.applyStreamEvent(StreamEvent(sessionId: sid, runId: "r-1", kind: .block, block: cmd3))
        store.applyStreamEvent(StreamEvent(sessionId: sid, runId: "r-1", kind: .block, block: cmd4))
        store.applyTranscriptUpdate(SessionTranscriptResult(
            sessionId: sid,
            messages: [initialUser, prevAssistant, persistedTurn],
            totalCount: 3,
            hasMore: false,
            liveActivity: LiveActivityState(isWorking: true, focus: "Running Bash")
        ))

        // Duplicate streaming bubble MUST be completely suppressed!
        let dedupedMsgs = store.messages(for: sid)
        XCTAssertEqual(dedupedMsgs.count, 3, "Must NOT show duplicate streaming bubble once persisted turn contains active assistant message")
        XCTAssertEqual(dedupedMsgs.last?.id, "a-2")
        XCTAssertTrue(store.isSessionBusy(sid), "Session must remain busy while streaming")

        // 4. If a brand-new unpersisted trailing paragraph streams in, show ONLY that new text (zero duplicate blocks)
        store.applyStreamEvent(StreamEvent(sessionId: sid, runId: "r-1", kind: .delta, text: "\n\nAdded @omnara and pushed."))
        let withTrailing = store.messages(for: sid)
        XCTAssertEqual(withTrailing.count, 4)
        XCTAssertEqual(withTrailing.last?.id, "stream-r-1")
        XCTAssertEqual(withTrailing.last?.blocks, [.text(text: "Added @omnara and pushed.")])
    }

    @MainActor
    func testPendingMessageNeverDisappearsOnQueuedOrSyntheticEcho() {
        let sid = "antigravity:test-no-thrash"
        let store = AppStore(client: MockSuperHarnessClient(), keychain: InMemoryKeychainStore(), defaults: .init(suiteName: UUID().uuidString)!)
        store.applyTranscriptUpdate(SessionTranscriptResult(sessionId: sid, messages: [], totalCount: 0, hasMore: false))

        let pending = store.submitMessage(for: sid, text: "keep this bubble steady", attachments: [])
        XCTAssertNotNil(pending)
        XCTAssertEqual(store.messages(for: sid).count, 1)

        // 1. Host sends transient queuedMessages before disk flush -> pending bubble MUST stay visible!
        store.applyTranscriptUpdate(SessionTranscriptResult(
            sessionId: sid,
            messages: [],
            totalCount: 0,
            hasMore: false,
            liveActivity: LiveActivityState(isWorking: true, queuedMessages: [QueuedMessageItem(text: "keep this bubble steady")])
        ))
        XCTAssertEqual(store.messages(for: sid).count, 1, "Message must NEVER vanish when temporarily echoed in queuedMessages")

        // 2. Synthetic mobile-opt-* message must NOT drop pending either!
        store.applyTranscriptUpdate(SessionTranscriptResult(
            sessionId: sid,
            messages: [UnifiedMessage(id: "mobile-opt-123", role: .user, timestamp: Date().timeIntervalSince1970 * 1000.0, blocks: [.text(text: "keep this bubble steady")])],
            totalCount: 1,
            hasMore: false
        ))
        XCTAssertFalse(store.pendingOutgoingBySessionId[sid]?.isEmpty ?? true, "Synthetic mobile-opt-* must not clear pending outgoing state")

        // 3. Real persisted user message arrives -> atomically swaps with zero gap and zero duplication!
        store.applyTranscriptUpdate(SessionTranscriptResult(
            sessionId: sid,
            messages: [UnifiedMessage(id: "agy-u-1", role: .user, timestamp: Date().timeIntervalSince1970 * 1000.0, blocks: [.text(text: "keep this bubble steady")])],
            totalCount: 1,
            hasMore: false
        ))
        XCTAssertTrue(store.pendingOutgoingBySessionId[sid]?.isEmpty ?? true)
        XCTAssertEqual(store.messages(for: sid).map(\.id), ["agy-u-1"])
    }

    @MainActor
    func testAwaitingReplyCoversTheGapAfterSending() {
        let sid = "codex:test-awaiting-reply"
        let store = AppStore(client: MockSuperHarnessClient(), keychain: InMemoryKeychainStore(), defaults: .init(suiteName: UUID().uuidString)!)
        let now = Date().timeIntervalSince1970 * 1000.0
        let reply = UnifiedMessage(id: "a-1", role: .assistant, timestamp: now, blocks: [.text(text: "Done.")])
        store.applyTranscriptUpdate(SessionTranscriptResult(sessionId: sid, messages: [reply], totalCount: 1, hasMore: false))
        XCTAssertFalse(store.isAwaitingReply(sid), "An idle thread shows no working row")

        XCTAssertNotNil(store.submitMessage(for: sid, text: "Thinking level?", attachments: []))
        XCTAssertTrue(store.isAwaitingReply(sid), "The working row shows as soon as the message is sent")

        // The host saves the user message and reports the turn; the transcript's own activity takes over.
        let user = UnifiedMessage(id: "u-1", role: .user, timestamp: now, blocks: [.text(text: "Thinking level?")])
        store.applyTranscriptUpdate(SessionTranscriptResult(
            sessionId: sid, messages: [reply, user], totalCount: 2, hasMore: false,
            liveActivity: LiveActivityState(isWorking: true)
        ))
        XCTAssertTrue(store.isAwaitingReply(sid))

        let answer = UnifiedMessage(id: "a-2", role: .assistant, timestamp: now, blocks: [.text(text: "Medium.")])
        store.applyTranscriptUpdate(SessionTranscriptResult(
            sessionId: sid, messages: [reply, user, answer], totalCount: 3, hasMore: false,
            liveActivity: LiveActivityState(isWorking: false)
        ))
        XCTAssertFalse(store.isAwaitingReply(sid), "The row goes away once the reply has arrived")
    }

    func testColdLaunchHydratesSynchronouslyFromDiskSnapshot() async throws {
        let suite = "sh.test.snapshot.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.set("live", forKey: "sh.connectionMode")
        defaults.set("http://127.0.0.1:47890", forKey: "sh.hostURL")
        let snapURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("sh-test-snap-\(UUID().uuidString).json")
        defer { try? FileManager.default.removeItem(at: snapURL) }

        let mock = MockSuperHarnessClient()
        let firstStore = AppStore(client: mock, defaults: defaults, environment: [:], snapshotFileURL: snapURL)
        await firstStore.bootstrap(quiet: true)
        await firstStore.loadTranscript(for: "codex:cx-control-server")
        firstStore.persistSnapshotNow()

        let coldStore = AppStore(client: mock, defaults: defaults, environment: [:], snapshotFileURL: snapURL)
        XCTAssertTrue(coldStore.hasCompletedBootstrap)
        XCTAssertFalse(coldStore.sessions.isEmpty)
        XCTAssertNotNil(coldStore.transcriptsBySessionId["codex:cx-control-server"])
        XCTAssertFalse(coldStore.messages(for: "codex:cx-control-server").isEmpty)
    }

    func testUnwatchedIdleSessionDoesNotStaySpinningFromStaleTranscriptLiveActivity() async throws {
        let suite = "sh.test.idle.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.set("live", forKey: "sh.connectionMode")
        defaults.set("http://127.0.0.1:47890", forKey: "sh.hostURL")
        let mock = MockSuperHarnessClient()
        let store = AppStore(client: mock, defaults: defaults, environment: [:])
        await store.bootstrap(quiet: true)

        let sid = "codex:cx-control-server"
        // Simulate visiting the session while it was actively running
        store.selectedSessionId = sid
        let workingTr = SessionTranscriptResult(
            sessionId: sid,
            messages: [UnifiedMessage(id: "m1", role: .user, timestamp: 1000, blocks: [.text(text: "hi")])],
            hasMore: false,
            sourceMtimeMs: 1000,
            liveActivity: LiveActivityState(isWorking: true, focus: "Running tests")
        )
        store.applyTranscriptUpdate(workingTr)
        XCTAssertTrue(store.isSessionBusy(sid))

        // Navigate back to the session list (unwatched) and receive host activity = [] (idle)
        store.selectedSessionId = nil
        store.hostWorkingSessionIds = []
        await store.bootstrap(quiet: true)
        XCTAssertFalse(store.isSessionBusy(sid), "Unwatched idle session must never stay spinning from stale cached transcript liveActivity")
        XCTAssertEqual(store.transcriptsBySessionId[sid]?.liveActivity?.isWorking, false)
    }

    func testFolderGroupingCrudAndSettingsSync() async throws {
        let suite = "sh.test.folders.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        let mock = MockSuperHarnessClient()
        let store = AppStore(client: mock, defaults: defaults, environment: [:])
        await store.bootstrap(quiet: true)

        await store.setGroupBy(.folders)
        XCTAssertEqual(store.groupBy, .folders)
        XCTAssertEqual(store.settings.sidebarGroupBy, .folders)

        let target = try XCTUnwrap(store.sessions.first(where: { !$0.isMaster && !$0.pinnedToTop }))
        let targetSessionId = target.id
        await store.createFolderAndAssign(sessionId: targetSessionId, name: "Release Squad", color: "#22C55E")
        let created = try XCTUnwrap(store.folders.first(where: { $0.name == "Release Squad" }))
        XCTAssertEqual(store.sessions.first(where: { $0.id == targetSessionId })?.folderId, created.id)

        let sections = store.groupedSections
        let shSection = try XCTUnwrap(sections.first(where: { $0.folderId == created.id }))
        XCTAssertEqual(shSection.title, "Release Squad")
        XCTAssertEqual(shSection.accentHex, "#22C55E")
        XCTAssertTrue(shSection.sessions.contains(where: { $0.id == targetSessionId }))
        XCTAssertTrue(sections.contains(where: { $0.id == "folder-unfiled" && $0.title == "Unfiled" }))

        await store.renameFolder(id: created.id, name: "Core Platform")
        XCTAssertEqual(store.folders.first(where: { $0.id == created.id })?.name, "Core Platform")

        await store.deleteFolder(id: created.id)
        XCTAssertFalse(store.folders.contains(where: { $0.id == created.id }))
        XCTAssertNil(store.sessions.first(where: { $0.id == targetSessionId })?.folderId)
    }

    /// lxe's Codex turn: text, commands, text, commands, text. The phone glued the texts into
    /// one paragraph ("…yet.ADU EAP is…") and showed the last one twice.
    func testTextBetweenStepsStaysSeparateParagraphsAndIsNotShownTwice() async {
        let store = AppStore(client: MockSuperHarnessClient(), keychain: InMemoryKeychainStore(), defaults: UserDefaults(suiteName: "sh.tests.stream.\(UUID().uuidString)")!, environment: [:])
        defer { store.stopEventStream() }
        let sid = "codex:periodic-check"
        let user = UnifiedMessage(id: "u-1", role: .user, timestamp: 1000, blocks: [.text(text: "update the pi host")])
        store.applyTranscriptUpdate(SessionTranscriptResult(sessionId: sid, messages: [user], totalCount: 1, hasMore: false, liveActivity: LiveActivityState(isWorking: true)))

        func cmd(_ c: String) -> UnifiedBlock { .command(command: c, cwd: nil, output: nil, exitCode: 0, durationMs: 5, status: "completed") }
        let t1 = "I haven't started the gateway update yet."
        let t2 = "ADU EAP is back on 1.5.6 and reachable."
        let t3 = "All six devices are Connected again."

        store.applyStreamEvent(StreamEvent(sessionId: sid, runId: "r-1", kind: .start))
        store.applyStreamEvent(StreamEvent(sessionId: sid, runId: "r-1", kind: .delta, text: t1))
        store.applyStreamEvent(StreamEvent(sessionId: sid, runId: "r-1", kind: .block, block: cmd("ping eap")))
        store.applyStreamEvent(StreamEvent(sessionId: sid, runId: "r-1", kind: .delta, text: t2))
        store.applyStreamEvent(StreamEvent(sessionId: sid, runId: "r-1", kind: .block, block: cmd("check devices")))
        store.applyStreamEvent(StreamEvent(sessionId: sid, runId: "r-1", kind: .delta, text: t3))

        // Before anything is saved: the stream shows text and steps in the order they arrived.
        let streamed = store.messages(for: sid).last
        XCTAssertEqual(streamed?.id, "stream-r-1")
        XCTAssertEqual(streamed?.blocks, [.text(text: t1), cmd("ping eap"), .text(text: t2), cmd("check devices"), .text(text: t3)])

        // The host saves the turn while the stream is still open: nothing is shown twice.
        let saved = UnifiedMessage(id: "a-1", role: .assistant, timestamp: 2000, blocks: [.text(text: t1), cmd("ping eap"), .text(text: t2), cmd("check devices"), .text(text: t3)])
        store.applyTranscriptUpdate(SessionTranscriptResult(sessionId: sid, messages: [user, saved], totalCount: 2, hasMore: false, liveActivity: LiveActivityState(isWorking: true)))
        let afterSave = store.messages(for: sid)
        XCTAssertEqual(afterSave.map(\.id), ["u-1", "a-1"], "the saved turn replaces the stream; no merged paragraph beside it")

        // A text the host has not saved yet still shows, once, as its own paragraph.
        let t4 = "Next I will restart the gateway."
        store.applyStreamEvent(StreamEvent(sessionId: sid, runId: "r-1", kind: .block, block: cmd("uptime")))
        store.applyStreamEvent(StreamEvent(sessionId: sid, runId: "r-1", kind: .delta, text: t4))
        XCTAssertEqual(store.messages(for: sid).last?.blocks, [.text(text: t4)])

        XCTAssertEqual(AppStore.endingStreamParagraph("abc"), "abc\n\n")
        XCTAssertEqual(AppStore.endingStreamParagraph("abc\n\n"), "abc\n\n")
        XCTAssertEqual(AppStore.endingStreamParagraph(""), "")
    }

    /// Two text items with no step between them: only the delta's item id tells them apart.
    func testADeltaFromANewTextItemStartsANewParagraph() async {
        let store = AppStore(client: MockSuperHarnessClient(), keychain: InMemoryKeychainStore(), defaults: UserDefaults(suiteName: "sh.tests.stream.\(UUID().uuidString)")!, environment: [:])
        defer { store.stopEventStream() }
        let sid = "codex:two-items"
        let user = UnifiedMessage(id: "u-1", role: .user, timestamp: 1000, blocks: [.text(text: "go")])
        store.applyTranscriptUpdate(SessionTranscriptResult(sessionId: sid, messages: [user], totalCount: 1, hasMore: false, liveActivity: LiveActivityState(isWorking: true)))

        store.applyStreamEvent(StreamEvent(sessionId: sid, runId: "r", kind: .start))
        store.applyStreamEvent(StreamEvent(sessionId: sid, runId: "r", kind: .delta, text: "First ", itemId: "i1"))
        store.applyStreamEvent(StreamEvent(sessionId: sid, runId: "r", kind: .delta, text: "item.", itemId: "i1"))
        store.applyStreamEvent(StreamEvent(sessionId: sid, runId: "r", kind: .delta, text: "Second item.", itemId: "i2"))
        XCTAssertEqual(store.messages(for: sid).last?.blocks, [.text(text: "First item."), .text(text: "Second item.")])

        // Once the host saves both, neither is shown again.
        let saved = UnifiedMessage(id: "a-1", role: .assistant, timestamp: 2000, blocks: [.text(text: "First item."), .text(text: "Second item.")])
        store.applyTranscriptUpdate(SessionTranscriptResult(sessionId: sid, messages: [user, saved], totalCount: 2, hasMore: false, liveActivity: LiveActivityState(isWorking: true)))
        XCTAssertEqual(store.messages(for: sid).map(\.id), ["u-1", "a-1"])

        // A harness that sends no item id keeps appending to the same paragraph.
        let other = "claude:no-item-id"
        store.applyTranscriptUpdate(SessionTranscriptResult(sessionId: other, messages: [user], totalCount: 1, hasMore: false, liveActivity: LiveActivityState(isWorking: true)))
        store.applyStreamEvent(StreamEvent(sessionId: other, runId: "r2", kind: .start))
        store.applyStreamEvent(StreamEvent(sessionId: other, runId: "r2", kind: .delta, text: "One "))
        store.applyStreamEvent(StreamEvent(sessionId: other, runId: "r2", kind: .delta, text: "paragraph."))
        XCTAssertEqual(store.messages(for: other).last?.blocks, [.text(text: "One paragraph.")])

        let decoded = try? JSONDecoder().decode(StreamEvent.self, from: Data(#"{"sessionId":"s","runId":"r","kind":"delta","text":"x","itemId":"i9"}"#.utf8))
        XCTAssertEqual(decoded?.itemId, "i9")
    }

    /// A harness error during a turn belongs in that session's thread, not in the list banner.
    func testAStreamErrorShowsInItsSessionAndClearsWhenANewTurnStarts() async {
        let store = AppStore(client: MockSuperHarnessClient(), keychain: InMemoryKeychainStore(), defaults: UserDefaults(suiteName: "sh.tests.notice.\(UUID().uuidString)")!, environment: [:])
        defer { store.stopEventStream() }
        let sid = "pi:model-down"
        store.applyStreamEvent(StreamEvent(sessionId: sid, runId: "r", kind: .start))
        store.applyStreamEvent(StreamEvent(sessionId: sid, runId: "r", kind: .error, error: "Pi could not reach its model server at 127.0.0.1:8080"))
        XCTAssertEqual(store.sessionNotices[sid]?.message, "Pi could not reach its model server at 127.0.0.1:8080")
        XCTAssertNil(store.lastError, "no list banner for a problem inside one session")
        XCTAssertFalse(store.isSessionBusy(sid), "the session no longer looks busy")

        store.applyStreamEvent(StreamEvent(sessionId: sid, runId: "r2", kind: .start))
        XCTAssertNil(store.sessionNotices[sid], "a new turn clears the old problem")

        store.applyStreamEvent(StreamEvent(sessionId: sid, runId: "r2", kind: .error, error: "again"))
        store.dismissSessionNotice(for: sid)
        XCTAssertNil(store.sessionNotices[sid])
    }

    func testAppIconBadgeIsOptInAndCountsVisibleUnreadSessions() {
        let suite = "sh.tests.badge.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        let store = AppStore(client: MockSuperHarnessClient(), keychain: InMemoryKeychainStore(), defaults: defaults, environment: [:])
        defer { store.stopEventStream() }

        let now = Date().timeIntervalSince1970 * 1000
        store.sessions = [
            UnifiedSession(id: "claude:1", harness: .claudeCli, harnessGroup: .claude, title: "One", status: .idle, createdAt: now, updatedAt: now, unread: true),
            UnifiedSession(id: "muse:2", harness: .muse, harnessGroup: .muse, title: "Two", status: .idle, createdAt: now, updatedAt: now, unread: true),
            UnifiedSession(id: "codex:3", harness: .codex, harnessGroup: .codex, title: "Read", status: .idle, createdAt: now, updatedAt: now, unread: false),
            UnifiedSession(id: "claude:arch", harness: .claudeCli, harnessGroup: .claude, title: "Archived", status: .archived, createdAt: now, updatedAt: now, unread: true),
            UnifiedSession(id: "master:root", harness: .master, harnessGroup: .master, title: "Master", status: .idle, createdAt: now, updatedAt: now, unread: true),
        ]

        XCTAssertFalse(store.appIconBadgeEnabled)
        XCTAssertEqual(store.unreadSessionCount, 2)
        XCTAssertEqual(store.effectiveAppIconBadgeCount, 0)

        store.setAppIconBadgeEnabled(true)
        XCTAssertTrue(store.appIconBadgeEnabled)
        XCTAssertEqual(store.effectiveAppIconBadgeCount, 2)

        store.setAppIconBadgeEnabled(false)
        XCTAssertEqual(store.effectiveAppIconBadgeCount, 0)
    }

    func testOpenSessionFromNotificationHandlesColdLaunchAndWarmResume() {
        let suite = "sh.tests.notif.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        let store = AppStore(client: MockSuperHarnessClient(), keychain: InMemoryKeychainStore(), defaults: defaults, environment: [:])
        defer { store.stopEventStream() }

        // Cold launch: sessions not loaded yet -> queues pendingInitialSessionId and dismisses sheets
        store.isHostSettingsSheetPresented = true
        store.openSessionFromNotification("antigravity:abc-123")
        XCTAssertFalse(store.isHostSettingsSheetPresented)
        XCTAssertEqual(store.pendingInitialSessionId, "antigravity:abc-123")

        // Warm resume: session already loaded -> opens detailRoute immediately and clears unread
        let now = Date().timeIntervalSince1970 * 1000
        store.sessions = [
            UnifiedSession(id: "antigravity:abc-123", harness: .antigravity, harnessGroup: .antigravity, title: "Thread", status: .idle, createdAt: now, updatedAt: now, unread: true),
        ]
        store.isUsageSheetPresented = true
        store.openSessionFromNotification("antigravity:abc-123")
        XCTAssertFalse(store.isUsageSheetPresented)
        XCTAssertNil(store.pendingInitialSessionId)
        XCTAssertEqual(store.selectedSessionId, "antigravity:abc-123")
        XCTAssertEqual(store.detailRoute, .session("antigravity:abc-123"))
        XCTAssertFalse(store.sessions[0].isUnread)
    }

    #if canImport(UIKit) && canImport(UserNotifications)
    /// Regression test for the Swift 6 UNUserNotificationCenterDelegate crash:
    /// implementing the bridged `async` delegate methods ran Apple's `completionHandler`
    /// off the main thread (`onMain == false`), crashing iOS on every notification tap.
    func testNotificationDelegateCallbacksCompleteOnMainThreadAndRouteTap() {
        final class StubContent: NSObject {
            @objc let userInfo: [AnyHashable: Any] = ["sessionId": "antigravity:tap-regression-1"]
            @objc let threadIdentifier: String = "antigravity:tap-regression-1"
        }
        final class StubRequest: NSObject {
            @objc let content = StubContent()
        }
        final class StubNotification: NSObject {
            @objc let request = StubRequest()
        }
        final class StubResponse: NSObject {
            @objc let notification = StubNotification()
        }

        let suite = "sh.tests.notif.delegate.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        let store = AppStore(client: MockSuperHarnessClient(), keychain: InMemoryKeychainStore(), defaults: defaults, environment: [:])
        defer {
            store.stopEventStream()
            PushNotificationCoordinator.shared.store = nil
        }

        let now = Date().timeIntervalSince1970 * 1000
        store.sessions = [
            UnifiedSession(id: "antigravity:tap-regression-1", harness: .antigravity, harnessGroup: .antigravity, title: "Target", status: .idle, createdAt: now, updatedAt: now, unread: true),
        ]
        PushNotificationCoordinator.shared.configure(store: store)

        let delegate = PushNotificationCoordinator.notificationDelegate
        XCTAssertTrue(UNUserNotificationCenter.current().delegate === delegate)

        // 1. didReceive invoked via ObjC selector on main thread completes synchronously on main thread and navigates.
        let didReceiveSel = NSSelectorFromString("userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:")
        XCTAssertTrue((delegate as AnyObject).responds(to: didReceiveSel))
        typealias DidReceiveIMP = @convention(c) (AnyObject, Selector, UNUserNotificationCenter, AnyObject, @escaping @convention(block) () -> Void) -> Void
        let didReceiveFn = unsafeBitCast(class_getMethodImplementation(type(of: delegate as AnyObject), didReceiveSel)!, to: DidReceiveIMP.self)

        var didReceiveOnMain = false
        var didReceiveCompleted = false
        didReceiveFn(delegate as AnyObject, didReceiveSel, UNUserNotificationCenter.current(), StubResponse()) {
            didReceiveOnMain = Thread.isMainThread
            didReceiveCompleted = true
        }
        XCTAssertTrue(didReceiveCompleted)
        XCTAssertTrue(didReceiveOnMain, "didReceive completionHandler must execute on the main thread")
        XCTAssertEqual(store.detailRoute, .session("antigravity:tap-regression-1"))

        // 2. didReceive invoked from a background queue still hops completionHandler onto the main thread.
        final class BoolBox: @unchecked Sendable { var value = false }
        let bgExp = expectation(description: "didReceive from background queue")
        let bgOnMain = BoolBox()
        let bgResponse = StubResponse()
        DispatchQueue.global(qos: .userInitiated).async {
            didReceiveFn(delegate as AnyObject, didReceiveSel, UNUserNotificationCenter.current(), bgResponse) {
                bgOnMain.value = Thread.isMainThread
                bgExp.fulfill()
            }
        }
        wait(for: [bgExp], timeout: 3)
        XCTAssertTrue(bgOnMain.value, "didReceive completionHandler must hop to main thread even if called off-main")

        // 3. willPresent completes on main thread with banner + sound + badge.
        let willPresentSel = NSSelectorFromString("userNotificationCenter:willPresentNotification:withCompletionHandler:")
        XCTAssertTrue((delegate as AnyObject).responds(to: willPresentSel))
        typealias WillPresentIMP = @convention(c) (AnyObject, Selector, UNUserNotificationCenter, AnyObject, @escaping @convention(block) (UNNotificationPresentationOptions) -> Void) -> Void
        let willPresentFn = unsafeBitCast(class_getMethodImplementation(type(of: delegate as AnyObject), willPresentSel)!, to: WillPresentIMP.self)

        var willPresentOnMain = false
        var presentedOptions: UNNotificationPresentationOptions = []
        willPresentFn(delegate as AnyObject, willPresentSel, UNUserNotificationCenter.current(), StubNotification()) { opts in
            willPresentOnMain = Thread.isMainThread
            presentedOptions = opts
        }
        XCTAssertTrue(willPresentOnMain)
        XCTAssertEqual(presentedOptions, [.banner, .sound, .badge])
    }
    #endif

    func testDoneSummaryFormattingAndOrchestratorModelLabels() {
        let now = Date().timeIntervalSince1970 * 1000
        let doneSession = UnifiedSession(
            id: "claude:done",
            harness: .claudeCli,
            harnessGroup: .claude,
            title: "Build",
            status: .idle,
            createdAt: now,
            updatedAt: now,
            summary: "Done: fixed notification tap crash"
        )
        let formattedDone = SessionRowFormatting.formattedSubtitle(for: doneSession)
        XCTAssertEqual(formattedDone, .init(isDone: true, text: "fixed notification tap crash"))

        let waitingSession = UnifiedSession(
            id: "claude:wait",
            harness: .claudeCli,
            harnessGroup: .claude,
            title: "Review",
            status: .idle,
            createdAt: now,
            updatedAt: now,
            summary: "Waiting: approval to deploy"
        )
        XCTAssertEqual(
            SessionRowFormatting.formattedSubtitle(for: waitingSession),
            .init(isDone: false, text: "Waiting: approval to deploy")
        )

        // Plain user text starting with "Done:" should not be misclassified as a summarizer completion badge
        let plainUserSession = UnifiedSession(
            id: "claude:user",
            harness: .claudeCli,
            harnessGroup: .claude,
            title: "Chat",
            status: .idle,
            createdAt: now,
            updatedAt: now,
            lastUserText: "Done: please check this"
        )
        XCTAssertEqual(
            SessionRowFormatting.formattedSubtitle(for: plainUserSession),
            .init(isDone: false, text: "Done: please check this")
        )

        // Antigravity Orchestrator variant names stay distinct while effort suffixes are stripped
        XCTAssertEqual(ComposerView.cleanBaseDisplayLabel("Orchestrator (Neon)"), "Orchestrator (Neon)")
        XCTAssertEqual(ComposerView.cleanBaseDisplayLabel("Orchestrator (Carbon)"), "Orchestrator (Carbon)")
        XCTAssertEqual(ComposerView.cleanBaseDisplayLabel("Orchestrator (Argon)"), "Orchestrator (Argon)")
        XCTAssertEqual(ComposerView.cleanBaseDisplayLabel("Gemini 4 Neon (High)"), "Gemini 4 Neon")
        XCTAssertEqual(ComposerView.cleanBaseDisplayLabel("GPT-OSS 120B (Medium)"), "GPT-OSS 120B")
    }

    func testProjectSectionCarriesProjectPathAndOpensDraftWithPreselectedProject() {
        let suite = "sh.tests.projectdraft.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        let store = AppStore(client: MockSuperHarnessClient(), keychain: InMemoryKeychainStore(), defaults: defaults, environment: [:])
        defer { store.stopEventStream() }

        let now = Date().timeIntervalSince1970 * 1000
        store.groupBy = .project
        store.sessions = [
            UnifiedSession(
                id: "claude:dsx-1",
                harness: .claudeTmux,
                harnessGroup: .claude,
                title: "DSX on .102",
                cwd: "/home/lxe/DSX",
                projectName: "DSX",
                status: .idle,
                createdAt: now,
                updatedAt: now
            ),
            UnifiedSession(
                id: "codex:sh-1",
                harness: .codex,
                harnessGroup: .codex,
                title: "Superharness",
                cwd: "/home/lxe/super-harness",
                projectName: "super-harness",
                status: .idle,
                createdAt: now - 1000,
                updatedAt: now - 1000
            ),
        ]

        let dsxSection = store.groupedSections.first(where: { $0.title == "DSX" })
        XCTAssertNotNil(dsxSection)
        XCTAssertEqual(dsxSection?.isProjectOrSectionGroup, true)
        XCTAssertEqual(dsxSection?.projectPath, "/home/lxe/DSX")
        XCTAssertNil(dsxSection?.harnessGroup)

        store.openDraftChat(for: dsxSection?.harnessGroup, projectPath: dsxSection?.projectPath)
        XCTAssertEqual(store.newThreadConfig.projectPath, "/home/lxe/DSX")
        if case .draft = store.detailRoute {
            // expected
        } else {
            XCTFail("Expected detailRoute to be .draft, got \(String(describing: store.detailRoute))")
        }
    }

    func testThinkingSliderLabelsSitUnderTheirDots() {
        // Row 300 wide, dots at 16, 105.33, 194.67, 284.
        let leading = { (i: Int, x: CGFloat, w: CGFloat) in
            SHThinkingEffortSlider.stopLabelLeading(index: i, count: 4, stopX: x, labelWidth: w, rowWidth: 300)
        }
        XCTAssertEqual(leading(0, 16, 24), 0)                       // first label flush left
        XCTAssertEqual(leading(3, 284, 36), 264)                    // last label flush right
        XCTAssertEqual(leading(1, 105.33, 24), 93.33, accuracy: 0.01) // centred under its dot
        XCTAssertEqual(leading(2, 290, 40), 260)                    // pulled in rather than past the end
    }

    func testThinkingSliderStopsAndCoalescedModelEffortResolution() {
        // Discrete stop snapping & clamping
        XCTAssertEqual(SHThinkingEffortSlider.nearestStopIndex(x: -10, trackWidth: 200, count: 4), 0)
        XCTAssertEqual(SHThinkingEffortSlider.nearestStopIndex(x: 0, trackWidth: 200, count: 4), 0)
        XCTAssertEqual(SHThinkingEffortSlider.nearestStopIndex(x: 68, trackWidth: 200, count: 4), 1)
        XCTAssertEqual(SHThinkingEffortSlider.nearestStopIndex(x: 132, trackWidth: 200, count: 4), 2)
        XCTAssertEqual(SHThinkingEffortSlider.nearestStopIndex(x: 200, trackWidth: 200, count: 4), 3)
        XCTAssertEqual(SHThinkingEffortSlider.nearestStopIndex(x: 250, trackWidth: 200, count: 4), 3)
        XCTAssertEqual(SHThinkingEffortSlider.nearestStopIndex(x: 50, trackWidth: 200, count: 1), 0)

        XCTAssertEqual(SHThinkingEffortSlider.displayName(for: "none"), "Off")
        XCTAssertEqual(SHThinkingEffortSlider.displayName(for: "xhigh"), "XHigh")
        XCTAssertEqual(SHThinkingEffortSlider.compactStopLabel(for: "medium", totalStops: 4), "Med")
        XCTAssertEqual(SHThinkingEffortSlider.compactStopLabel(for: "medium", totalStops: 3), "Medium")

        // Antigravity sibling slug switching + Orchestrator (no effort levels)
        let agyModels = [
            HarnessModelOption(id: "gemini-4-neon-low", label: "Gemini 4 Neon (Low)", reasoningLevels: ["low", "medium", "high", "xhigh"], defaultReasoningLevel: "low"),
            HarnessModelOption(id: "gemini-4-neon-medium", label: "Gemini 4 Neon (Medium)", reasoningLevels: ["low", "medium", "high", "xhigh"], defaultReasoningLevel: "medium"),
            HarnessModelOption(id: "gemini-4-neon-high", label: "Gemini 4 Neon (High)", reasoningLevels: ["low", "medium", "high", "xhigh"], defaultReasoningLevel: "high"),
            HarnessModelOption(id: "gemini-pro-orchestrator-neon", label: "Orchestrator (Neon)"),
        ]

        let switchedEffort = ComposerView.resolveEffortSelection(
            effort: "medium",
            currentModel: "gemini-4-neon-high",
            availableModels: agyModels
        )
        XCTAssertEqual(switchedEffort.modelId, "gemini-4-neon-medium")
        XCTAssertEqual(switchedEffort.effort, "medium")

        let pickedNeonWithExistingEffort = ComposerView.resolveModelSelection(
            picked: agyModels[2],
            currentEffort: "low",
            availableModels: agyModels,
            allowExtreme: false
        )
        XCTAssertEqual(pickedNeonWithExistingEffort.modelId, "gemini-4-neon-low")
        XCTAssertEqual(pickedNeonWithExistingEffort.effort, "low")

        let pickedOrch = ComposerView.resolveModelSelection(
            picked: agyModels[3],
            currentEffort: "high",
            availableModels: agyModels,
            allowExtreme: false
        )
        XCTAssertEqual(pickedOrch.modelId, "gemini-pro-orchestrator-neon")
        XCTAssertNil(pickedOrch.effort)
    }

    func testHomeDirectoryAndUsernameProjectsCoalesce() {
        XCTAssertEqual(AppStore.homeUsername(fromPath: "/home/alice"), "alice")
        XCTAssertEqual(AppStore.homeUsername(fromPath: "/Users/bob/"), "bob")
        XCTAssertEqual(AppStore.homeUsername(fromPath: "C:\\Users\\carol"), "carol")
        XCTAssertNil(AppStore.homeUsername(fromPath: "/home/alice/my-repo"))
        XCTAssertTrue(AppStore.isHomeProjectLabel("alice", cwd: "/home/alice"))
        XCTAssertTrue(AppStore.isHomeProjectLabel("~ (Home)", cwd: "~"))
        XCTAssertTrue(AppStore.isHomeProjectLabel("Home (~)", cwd: "/home/alice"))
        XCTAssertFalse(AppStore.isHomeProjectLabel("DSX", cwd: "/home/alice"))

        let suite = "sh.tests.homecoalesce.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        let store = AppStore(client: MockSuperHarnessClient(), keychain: InMemoryKeychainStore(), defaults: defaults, environment: [:])
        defer { store.stopEventStream() }

        let now = Date().timeIntervalSince1970 * 1000
        store.groupBy = .project
        store.sessions = [
            UnifiedSession(
                id: "codex:user-home",
                harness: .codex,
                harnessGroup: .codex,
                title: "Upgrade packages",
                cwd: "/home/alice",
                projectName: "alice",
                status: .idle,
                createdAt: now,
                updatedAt: now,
                nativeSection: "alice"
            ),
            UnifiedSession(
                id: "claude:tilde-home",
                harness: .claudeCli,
                harnessGroup: .claude,
                title: "Home task",
                cwd: "/home/alice",
                projectName: "Home (~)",
                status: .idle,
                createdAt: now - 1000,
                updatedAt: now - 1000,
                nativeSection: "Ungrouped"
            ),
            UnifiedSession(
                id: "pi:legacy-home",
                harness: .pi,
                harnessGroup: .pi,
                title: "Tilde task",
                cwd: "~",
                projectName: "~ (Home)",
                status: .idle,
                createdAt: now - 2000,
                updatedAt: now - 2000
            ),
            UnifiedSession(
                id: "claude:dsx",
                harness: .claudeCli,
                harnessGroup: .claude,
                title: "DSX task",
                cwd: "/home/alice",
                projectName: "Home (~)",
                status: .idle,
                createdAt: now - 3000,
                updatedAt: now - 3000,
                nativeSection: "DSX"
            ),
            UnifiedSession(
                id: "codex:subrepo",
                harness: .codex,
                harnessGroup: .codex,
                title: "Repo work",
                cwd: "/home/alice/my-repo",
                projectName: "my-repo",
                status: .idle,
                createdAt: now - 4000,
                updatedAt: now - 4000
            ),
        ]

        let sections = store.groupedSections
        let homeSections = sections.filter {
            $0.title == "Home (~)" || $0.title.lowercased() == "alice" || $0.title.contains("~")
        }
        XCTAssertEqual(homeSections.count, 1)
        XCTAssertEqual(homeSections.first?.title, "Home (~)")
        XCTAssertEqual(
            homeSections.first?.sessions.map(\.id),
            ["codex:user-home", "claude:tilde-home", "pi:legacy-home"]
        )
        XCTAssertEqual(sections.first(where: { $0.title == "DSX" })?.sessions.map(\.id), ["claude:dsx"])
        XCTAssertEqual(sections.first(where: { $0.title == "my-repo" })?.sessions.map(\.id), ["codex:subrepo"])
    }

    func testModelEffortMenuDefersCommitUntilDismissAndDeduplicatesNoOps() {
        // Open and close without changing anything -> no commit
        XCTAssertNil(
            SHModelEffortMenu.resolveCommit(
                initialModelId: "gemini-4-neon",
                pickedModelId: nil,
                initialEffort: "high",
                draftEffort: "high"
            )
        )

        // Tap already-selected model without changing effort -> no commit
        XCTAssertNil(
            SHModelEffortMenu.resolveCommit(
                initialModelId: "gemini-4-neon",
                pickedModelId: "gemini-4-neon",
                initialEffort: "high",
                draftEffort: "HIGH"
            )
        )

        // Slide effort and tap outside -> single effortOnly commit
        XCTAssertEqual(
            SHModelEffortMenu.resolveCommit(
                initialModelId: "gemini-4-neon",
                pickedModelId: nil,
                initialEffort: "high",
                draftEffort: "low"
            ),
            .effortOnly("low")
        )

        // Slide effort and tap the already-selected model -> single effortOnly commit
        XCTAssertEqual(
            SHModelEffortMenu.resolveCommit(
                initialModelId: "gemini-4-neon",
                pickedModelId: "gemini-4-neon",
                initialEffort: "high",
                draftEffort: "medium"
            ),
            .effortOnly("medium")
        )

        // Slide effort AND pick a different model -> single atomic modelAndEffort commit
        XCTAssertEqual(
            SHModelEffortMenu.resolveCommit(
                initialModelId: "gemini-4-neon",
                pickedModelId: "gemini-4-carbon",
                initialEffort: "high",
                draftEffort: "low"
            ),
            .modelAndEffort(modelId: "gemini-4-carbon", effort: "low")
        )
    }

    func testCommitSessionModelProtectsAgainstStalePollsAndClearsOnServerEcho() async {
        let suite = "sh.tests.modelreconcile.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        let store = AppStore(client: MockSuperHarnessClient(), keychain: InMemoryKeychainStore(), defaults: defaults, environment: [:])
        defer { store.stopEventStream() }

        let now = Date().timeIntervalSince1970 * 1000
        let staleSession = UnifiedSession(
            id: "antigravity:reconcile-1",
            harness: .antigravity,
            harnessGroup: .antigravity,
            title: "Reconcile test",
            cwd: "/home/alice",
            projectName: "Home (~)",
            model: "gemini-4-neon-high",
            reasoningEffort: "high",
            status: .idle,
            createdAt: now,
            updatedAt: now
        )
        store.sessions = [staleSession]

        // 1. commitSessionModel updates optimistically synchronously before any network await
        let syncTask = store.commitSessionModel(
            sessionId: staleSession.id,
            model: "gemini-4-neon-low",
            reasoningEffort: "low"
        )
        XCTAssertEqual(store.sessions.first?.model, "gemini-4-neon-low")
        XCTAssertEqual(store.sessions.first?.reasoningEffort, "low")
        XCTAssertNotNil(store.pendingModelOverrides[staleSession.id])

        // 2. A stale SSE delta arriving while request is in flight must NOT flash back to "high"
        store.applySessionsDelta(SessionsDeltaEnvelope(upserts: [staleSession]))
        XCTAssertEqual(store.sessions.first?.model, "gemini-4-neon-low")
        XCTAssertEqual(store.sessions.first?.reasoningEffort, "low")

        // 3. Wait for organize acknowledgement; stale snapshots within grace window still don't revert
        await syncTask.value
        XCTAssertEqual(store.pendingModelOverrides[staleSession.id]?.serverAcknowledged, true)
        store.applySessionsDelta(SessionsDeltaEnvelope(upserts: [staleSession]))
        XCTAssertEqual(store.sessions.first?.model, "gemini-4-neon-low")
        XCTAssertEqual(store.sessions.first?.reasoningEffort, "low")

        // 4. Once the server echoes the matching model/effort, the override clears cleanly
        var echoed = staleSession
        echoed.model = "gemini-4-neon-low"
        echoed.reasoningEffort = "low"
        store.applySessionsDelta(SessionsDeltaEnvelope(upserts: [echoed]))
        XCTAssertNil(store.pendingModelOverrides[staleSession.id])

        // 5. Subsequent external updates (e.g. Desktop switches to medium) now flow through normally
        var externalChange = echoed
        externalChange.model = "gemini-4-neon-medium"
        externalChange.reasoningEffort = "medium"
        store.applySessionsDelta(SessionsDeltaEnvelope(upserts: [externalChange]))
        XCTAssertEqual(store.sessions.first?.model, "gemini-4-neon-medium")
        XCTAssertEqual(store.sessions.first?.reasoningEffort, "medium")

        // 6. Rapid back-to-back commits always settle on the newest value without reverting
        _ = store.commitSessionModel(sessionId: staleSession.id, model: "gemini-4-neon-low", reasoningEffort: "low")
        let finalTask = store.commitSessionModel(sessionId: staleSession.id, model: "gemini-4-neon-xhigh", reasoningEffort: "xhigh")
        await finalTask.value
        XCTAssertEqual(store.sessions.first?.model, "gemini-4-neon-xhigh")
        XCTAssertEqual(store.sessions.first?.reasoningEffort, "xhigh")
    }

    /// The checked row in the model menu is the model the pill names, in every case the pill
    /// can name one: by stem, by alias, and by the harness default when the session reports none.
    func testSelectedModelStemFollowsThePillLabel() {
        let models = [
            HarnessModelOption(id: "claude-opus-5-5", label: "Opus 5.5", isDefault: true, aliases: ["opus"]),
            HarnessModelOption(id: "claude-fable-5-2", label: "Fable 5.2", aliases: ["fable"]),
            HarnessModelOption(id: "gemini-4-neon-low", label: "Gemini 4 Neon (Low)"),
        ]
        XCTAssertEqual(ComposerView.selectedModelStem(model: "claude-fable-5-2", availableModels: models), "claude-fable-5-2")
        XCTAssertEqual(ComposerView.selectedModelStem(model: "fable", availableModels: models), "claude-fable-5-2")
        XCTAssertEqual(ComposerView.selectedModelStem(model: "Opus 5.5", availableModels: models), "claude-opus-5-5")
        XCTAssertEqual(ComposerView.selectedModelStem(model: "gemini-4-neon-high", availableModels: models), "gemini-4-neon")
        XCTAssertEqual(ComposerView.selectedModelStem(model: nil, availableModels: models), "claude-opus-5-5")
        XCTAssertEqual(ComposerView.selectedModelStem(model: "", availableModels: models), "claude-opus-5-5")
        XCTAssertNil(ComposerView.selectedModelStem(model: "unknown-model", availableModels: models))
    }

    func testArchiveSessionResistsStalePollsUntilHostConfirmsRemoval() async {
        let suite = "sh.tests.archivereconcile.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        let store = AppStore(client: MockSuperHarnessClient(), keychain: InMemoryKeychainStore(), defaults: defaults, environment: [:])
        defer { store.stopEventStream() }

        let now = Date().timeIntervalSince1970 * 1000
        let target = UnifiedSession(
            id: "claude:test-archive-1",
            harness: .claudeTmux,
            harnessGroup: .claude,
            title: "Test session",
            cwd: "/home/alice",
            projectName: "Home (~)",
            status: .idle,
            isLive: true,
            createdAt: now,
            updatedAt: now
        )
        store.sessions = [target]

        await store.archiveSession(target)
        XCTAssertEqual(store.sessions.first?.status, .archived)
        XCTAssertEqual(store.sessions.first?.hidden, true)
        XCTAssertEqual(store.pendingArchivedSessionIds[target.id]?.serverAcknowledged, true)
        XCTAssertTrue(store.groupedSections.isEmpty, "Archived session must disappear from groupedSections")

        // A stale SSE delta arriving right after archive must NOT resurrect the session
        store.applySessionsDelta(SessionsDeltaEnvelope(upserts: [target]))
        XCTAssertEqual(store.sessions.first?.status, .archived)
        XCTAssertEqual(store.sessions.first?.hidden, true)
        XCTAssertTrue(store.groupedSections.isEmpty, "Stale SSE upsert must not resurrect archived session")

        // Once the host removes the session via removedIds, the pending archive guard clears cleanly
        store.applySessionsDelta(SessionsDeltaEnvelope(removedIds: [target.id]))
        XCTAssertNil(store.pendingArchivedSessionIds[target.id])
        XCTAssertTrue(store.sessions.isEmpty)
    }

    func testScrollBottomMetricsDetectsOvershootPastBottom() {
        // Normal resting at bottom: content 2000pt in 800pt viewport -> maxOffsetY = 1200
        let normal = SessionDetailView.scrollBottomMetrics(
            contentHeight: 2000,
            containerHeight: 800,
            contentOffsetY: 1200,
            visibleMaxY: 2000,
            topInset: 0,
            bottomInset: 0
        )
        XCTAssertEqual(normal.distanceFromBottom, 0, accuracy: 0.01)
        XCTAssertEqual(normal.overshootPastBottom, 0, accuracy: 0.01)

        // Scrolled up reading older messages
        let scrolledUp = SessionDetailView.scrollBottomMetrics(
            contentHeight: 2000,
            containerHeight: 800,
            contentOffsetY: 600,
            visibleMaxY: 1400,
            topInset: 0,
            bottomInset: 0
        )
        XCTAssertEqual(scrolledUp.distanceFromBottom, 600, accuracy: 0.01)
        XCTAssertEqual(scrolledUp.overshootPastBottom, 0, accuracy: 0.01)

        // Overshoot past bottom (viewport stranded in empty void below contentSize.height)
        let overshot = SessionDetailView.scrollBottomMetrics(
            contentHeight: 2000,
            containerHeight: 800,
            contentOffsetY: 2100,
            visibleMaxY: 2900,
            topInset: 0,
            bottomInset: 0
        )
        XCTAssertEqual(overshot.distanceFromBottom, 0, accuracy: 0.01)
        XCTAssertEqual(overshot.overshootPastBottom, 900, accuracy: 0.01)

        // Short transcript (content shorter than viewport, topInset 100): maxOffsetY = -100
        let shortOvershot = SessionDetailView.scrollBottomMetrics(
            contentHeight: 400,
            containerHeight: 800,
            contentOffsetY: 300,
            visibleMaxY: 1100,
            topInset: 100,
            bottomInset: 0
        )
        XCTAssertEqual(shortOvershot.overshootPastBottom, 400, accuracy: 0.01)
    }

    func testFilePreviewTargetParsingAndOpenFileLink() async throws {
        let plain = try XCTUnwrap(FilePreviewTarget.parse(from: URL(string: "file:///tmp/demo/SessionDetailView.swift")!))
        XCTAssertEqual(plain.path, "/tmp/demo/SessionDetailView.swift")
        XCTAssertEqual(plain.fileName, "SessionDetailView.swift")
        XCTAssertNil(plain.startLine)
        XCTAssertNil(plain.endLine)

        let singleLine = try XCTUnwrap(FilePreviewTarget.parse(from: URL(string: "file:///tmp/demo/SessionDetailView.swift#L42")!))
        XCTAssertEqual(singleLine.path, "/tmp/demo/SessionDetailView.swift")
        XCTAssertEqual(singleLine.startLine, 42)
        XCTAssertNil(singleLine.endLine)

        let rangeLine = try XCTUnwrap(FilePreviewTarget.parse(from: URL(string: "file:///tmp/demo/SessionDetailView.swift#L42-L88")!))
        XCTAssertEqual(rangeLine.startLine, 42)
        XCTAssertEqual(rangeLine.endLine, 88)

        XCTAssertNil(FilePreviewTarget.parse(from: URL(string: "https://example.com/file.swift")!))

        let store = AppStore(client: MockSuperHarnessClient())
        XCTAssertTrue(store.openFileLink(URL(string: "file:///tmp/demo/README.md#L10-L20")!))
        XCTAssertEqual(store.filePreviewTarget?.path, "/tmp/demo/README.md")
        XCTAssertEqual(store.filePreviewTarget?.startLine, 10)
        XCTAssertEqual(store.filePreviewTarget?.endLine, 20)

        let preview = try await store.fetchFilePreview(path: "/tmp/demo/README.md", startLine: 10, endLine: 20)
        XCTAssertEqual(preview.kind, "markdown")
        XCTAssertEqual(preview.startLine, 10)
        XCTAssertEqual(preview.endLine, 20)
    }
}
