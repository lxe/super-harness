import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// Rich, interactive offline Demo Mode backend covering Master, Antigravity, Codex, Claude, and Muse,
/// all UnifiedBlock types, live steps, queued messages, usage quotas, and simulated streaming replies.
public actor MockSuperHarnessClient: SuperHarnessClientProtocol {
    private var harnesses: [HarnessDetection]
    private var sessions: [UnifiedSession]
    private var transcripts: [String: SessionTranscriptResult]
    private var settings = SuperHarnessSettings()
    private var folders: [SessionFolder]
    private var usage: UsageSnapshot
    private var catalog: HarnessCatalog
    private var activeTasks: [String: Task<Void, Never>] = [:]
    private var continuations: [UUID: AsyncStream<SuperHarnessServerEvent>.Continuation] = [:]
    public private(set) var watchedSessions: [String?] = []
    public private(set) var bootstrapCallCount: Int = 0
    public private(set) var simulateOffline: Bool = false
    public private(set) var simulateSendError: String? = nil

    public func setSimulateOffline(_ offline: Bool) {
        simulateOffline = offline
    }

    public func setSimulateSendError(_ message: String?) {
        simulateSendError = message
    }

    public init() {
        let now = Date().timeIntervalSince1970 * 1000.0
        let minute = 60_000.0
        let hour = 3_600_000.0
        let day = 86_400_000.0

        self.folders = [
            SessionFolder(id: "folder-mobile", name: "iOS Companion", color: "#60a5fa", order: 0),
            SessionFolder(id: "folder-infra", name: "Infra & Perf", color: "#10a37f", order: 1),
        ]

        self.harnesses = [
            HarnessDetection(
                id: .antigravity,
                name: "Antigravity",
                installed: true,
                binaryPath: "/usr/local/bin/agy",
                version: "2.4.1",
                runningProcesses: 2,
                desktopAppRunning: true,
                daemonRunning: true,
                remoteControlEnabled: true,
                activeSessionCount: 1,
                totalSessionCount: 2,
                capabilities: HarnessCapabilities(canStartNew: true, canResume: true, canTmuxMirror: false, canControlDaemon: true),
                notes: "Connected via local language server"
            ),
            HarnessDetection(
                id: .codex,
                name: "Codex",
                installed: true,
                binaryPath: "/usr/local/bin/codex",
                version: "0.42.0",
                runningProcesses: 1,
                desktopAppRunning: false,
                daemonRunning: true,
                remoteControlEnabled: true,
                activeSessionCount: 1,
                totalSessionCount: 2,
                capabilities: HarnessCapabilities(canStartNew: true, canResume: true, canTmuxMirror: false, canControlDaemon: true)
            ),
            HarnessDetection(
                id: .claude,
                name: "Claude Code",
                installed: true,
                binaryPath: "/usr/local/bin/claude",
                version: "1.0.88",
                runningProcesses: 3,
                desktopAppRunning: true,
                daemonRunning: true,
                remoteControlEnabled: true,
                activeSessionCount: 1,
                totalSessionCount: 2,
                capabilities: HarnessCapabilities(canStartNew: true, canResume: true, canTmuxMirror: true, canControlDaemon: true)
            ),
            HarnessDetection(
                id: .muse,
                name: "Muse",
                installed: true,
                binaryPath: "/usr/local/bin/muse",
                version: "1.0.0",
                runningProcesses: 1,
                desktopAppRunning: false,
                daemonRunning: true,
                remoteControlEnabled: false,
                activeSessionCount: 1,
                totalSessionCount: 1,
                capabilities: HarnessCapabilities(canStartNew: true, canResume: true, canTmuxMirror: false, canControlDaemon: false),
                notes: "Local muse-exec runner"
            ),
        ]

        self.sessions = [
            UnifiedSession(
                id: "master:root",
                nativeId: "root",
                harness: .master,
                harnessGroup: .master,
                title: "Master Orchestrator",
                preview: "Coordinating iOS companion MVP, SSE control server, and quota telemetry",
                cwd: "/Users/lxe/Developer/super-harness",
                projectName: "super-harness",
                gitBranch: "feat/ios-app",
                model: "Claude Opus 4.6",
                status: .idle,
                isLive: true,
                createdAt: now - 4 * day,
                updatedAt: now - 3 * minute,
                tokenCount: 48_200,
                pinned: true,
                tags: ["orchestrator"],
                dispatchMode: .master
            ),
            UnifiedSession(
                id: "antigravity:agy-ios-companion",
                nativeId: "agy-ios-companion",
                harness: .antigravity,
                harnessGroup: .antigravity,
                title: "Build native SwiftUI iOS companion",
                preview: "Streaming SSE parser + obsidian transcript blocks ready for simulator tests",
                cwd: "/Users/lxe/Developer/super-harness",
                projectName: "super-harness",
                gitBranch: "feat/ios-app",
                model: "Gemini 3.1 Pro",
                status: .running,
                isLive: true,
                isRemote: true,
                createdAt: now - 3 * hour,
                updatedAt: now - 15_000,
                tokenCount: 112_400,
                pinned: true,
                pinnedToTop: true,
                folderId: "folder-mobile",
                tags: ["ios", "swiftui"],
                dispatchMode: .agyResume,
                nativeSection: "super-harness",
                nativeSectionOrder: 0,
                originApp: .antigravityCli,
                lastUserText: "make the session rows two lines: name on top, then my last message"
            ),
            UnifiedSession(
                id: "codex:cx-control-server",
                nativeId: "cx-control-server",
                harness: .codex,
                harnessGroup: .codex,
                title: "Add Tailscale bind & /api/bootstrap",
                preview: "Implemented paired bearer token auth and SSE usage/transcript fanout",
                cwd: "/Users/lxe/Developer/super-harness",
                projectName: "super-harness",
                gitBranch: "feat/mobile-api",
                model: "gpt-5.3-codex",
                status: .waitingInput,
                isLive: true,
                isRemote: false,
                createdAt: now - 6 * hour,
                updatedAt: now - 14 * minute,
                tokenCount: 74_800,
                pinned: true,
                pinnedToTop: true,
                folderId: "folder-infra",
                tags: ["api", "sse"],
                dispatchMode: .codexResume,
                nativeSection: "super-harness",
                nativeSectionOrder: 0,
                hostAddress: "lxe@100.64.0.3",
                hostLabel: "linux-box",
                lastUserText: "bind to the tailnet address only and ask me before opening the LAN port"
            ),
            UnifiedSession(
                id: "claude-tmux:cc-usage-redesign",
                nativeId: "cc-usage-redesign",
                harness: .claudeTmux,
                harnessGroup: .claude,
                title: "Hero-limit usage card & pace indicator",
                preview: "Added vertical pace tick and 7-day boxless spend chart across harnesses",
                cwd: "/Users/lxe/Developer/super-harness",
                projectName: "super-harness",
                gitBranch: "main",
                model: "claude-sonnet-4-6",
                status: .idle,
                isLive: true,
                isRemote: true,
                tmuxTarget: "claude-main:0.0",
                tmuxSessionName: "claude-main",
                createdAt: now - 1 * day,
                updatedAt: now - 42 * minute,
                tokenCount: 91_350,
                pinned: false,
                folderId: "folder-mobile",
                tags: ["ui", "usage"],
                dispatchMode: .tmuxSend,
                nativeSection: "super-harness",
                nativeSectionOrder: 0,
                permissionMode: "acceptEdits",
                hostAddress: "devbox.tailnet.ts.net",
                hostLabel: "devbox",
                lastUserText: "the pace tick should sit on the bar, not under it"
            ),
            UnifiedSession(
                id: "antigravity:agy-diff-engine",
                nativeId: "agy-diff-engine",
                harness: .antigravity,
                harnessGroup: .antigravity,
                title: "Optimize transcript virtualization",
                preview: "Reduced layout thrash on 2,000-block transcripts from 240ms to 18ms",
                cwd: "/Users/lxe/Developer/obsidian-kit",
                projectName: "obsidian-kit",
                gitBranch: "perf/virtual-list",
                model: "Gemini 3.1 Flash",
                status: .idle,
                isLive: false,
                createdAt: now - 2 * day,
                updatedAt: now - 5 * hour,
                tokenCount: 38_100,
                pinned: false,
                tags: ["perf"],
                dispatchMode: .agyResume,
                nativeSection: "obsidian-kit",
                nativeSectionOrder: 1,
                originApp: .antigravityApp,
                unread: true
            ),
            UnifiedSession(
                id: "codex:cx-test-harness",
                nativeId: "cx-test-harness",
                harness: .codex,
                harnessGroup: .codex,
                title: "Vitest coverage for session organizer",
                preview: "All 42 unit tests passing including folder migration edge cases",
                cwd: "/Users/lxe/Developer/super-harness",
                projectName: "super-harness",
                gitBranch: "chore/tests",
                model: "gpt-5.3-codex",
                status: .stopped,
                isLive: false,
                createdAt: now - 3 * day,
                updatedAt: now - 26 * hour,
                tokenCount: 29_900,
                pinned: false,
                folderId: "folder-infra",
                tags: ["tests"],
                dispatchMode: .codexResume,
                nativeSection: "super-harness",
                nativeSectionOrder: 0
            ),
            UnifiedSession(
                id: "claude-cli:cc-keychain-audit",
                nativeId: "cc-keychain-audit",
                harness: .claudeCli,
                harnessGroup: .claude,
                title: "Security review: bearer token & ATS",
                preview: "Verified NSAllowsLocalNetworking scope and Keychain accessibility flags",
                cwd: "/Users/lxe/Developer/security-playbooks",
                projectName: "security-playbooks",
                gitBranch: "audit/ios-local-net",
                model: "claude-opus-4-6",
                status: .idle,
                isLive: false,
                createdAt: now - 4 * day,
                updatedAt: now - 31 * hour,
                tokenCount: 64_500,
                pinned: false,
                tags: ["security"],
                dispatchMode: .claudeResume,
                nativeSection: "security-playbooks",
                nativeSectionOrder: 1,
                unread: true
            ),
            UnifiedSession(
                id: "muse:muse-orb-review",
                nativeId: "muse-orb-review",
                harness: .muse,
                harnessGroup: .muse,
                title: "Muse orbital badge & tolerant bootstrap",
                preview: "Verified future-proof JSON decoding across harnesses, usage, and catalog",
                cwd: "/Users/lxe/Developer/super-harness",
                projectName: "super-harness",
                gitBranch: "feat/ios-app",
                model: "muse-wonder-full-1.0",
                status: .idle,
                isLive: true,
                createdAt: now - 8 * hour,
                updatedAt: now - 22 * minute,
                tokenCount: 41_200,
                pinned: false,
                folderId: "folder-mobile",
                tags: ["muse", "ios"],
                dispatchMode: .museExec,
                nativeSection: "super-harness",
                nativeSectionOrder: 0,
                hostAddress: "100.64.0.12"
            ),
        ]

        let samplePreviewDataUrl = Self.makeSamplePreviewDataUrl()

        self.transcripts = [
            "codex:cx-test-harness": SessionTranscriptResult(
                sessionId: "codex:cx-test-harness",
                messages: [
                    UnifiedMessage(
                        id: "th-1",
                        role: .user,
                        timestamp: now - 27 * hour,
                        blocks: [.text(text: "Run the organizer tests and typecheck, then start the watcher.")]
                    ),
                    UnifiedMessage(
                        id: "th-2",
                        role: .assistant,
                        timestamp: now - 26 * hour,
                        blocks: [
                            .text(text: "Running the session organizer tests first."),
                            .command(
                                command: "npm test -- sessionOrganizer",
                                cwd: "/Users/lxe/Developer/super-harness",
                                output: "PASS tests/sessionOrganizer.test.ts (42 passed)",
                                exitCode: 0,
                                durationMs: 2140,
                                status: "completed"
                            ),
                            .text(text: "Tests pass. The typecheck does not:"),
                            .command(
                                command: "git log --oneline -1 && (cd frontend && npm run -s build > /tmp/frontend-build.log 2>&1) && npm run typecheck -- --pretty false",
                                cwd: "/Users/lxe/Developer/super-harness",
                                output: "src/main/folders.ts(88,7): error TS2322: Type 'string | undefined' is not assignable to type 'string'.",
                                exitCode: 2,
                                durationMs: 6310,
                                status: "completed"
                            ),
                            .text(text: "I fixed the type error and started the watcher."),
                            .command(
                                command: "cat > tests/folders.test.ts <<'EOF'\nimport { describe, expect, it } from 'vitest';\nimport { migrateFolders } from '../src/main/folders';\n\ndescribe('migrateFolders', () => {\n  it('keeps folder ids stable across a rename', () => {\n    expect(migrateFolders([{ id: 'a', name: 'Old' }])).toEqual([{ id: 'a', name: 'Old' }]);\n  });\n});\nEOF\nnpm run test:watch",
                                cwd: "/Users/lxe/Developer/super-harness",
                                output: nil,
                                exitCode: nil,
                                durationMs: nil,
                                status: "running"
                            ),
                        ],
                        harnessMeta: MessageHarnessMeta(model: "gpt-5.3-codex", sourceKind: .agent)
                    ),
                    UnifiedMessage(
                        id: "th-3",
                        role: .user,
                        timestamp: now - 25 * hour,
                        blocks: [.text(text: "Another Claude session sent a message:\n<cross-session-message from=\"bridge:session_01\" from-name=\"Release Ops\" from-mode=\"bypass\">\nThe folder migration is deployed to staging. Two things before you continue:\n\n1. Re-run the organizer tests against the staging snapshot.\n2. Tell me the commit hash so I can tag the release.\n</cross-session-message>")]
                    ),
                    UnifiedMessage(
                        id: "th-4",
                        role: .assistant,
                        timestamp: now - 25 * hour,
                        blocks: [.text(text: "Re-running the organizer tests against the staging snapshot now.\n\nInstall page: https://example.com/install/\n\nCode-styled: `https://example.com/code/`\n\nSee the [release notes](https://example.com/notes) too.\n\n- Dashboard: https://example.com/dash\n\n| Item | Link |\n| --- | --- |\n| Docs | [docs](https://example.com/docs) |"), .image(path: MockSuperHarnessClient.slowGeneratedImagePath, name: "generated.png", dataUrl: nil), .text(text: "That is the generated image.")],
                        harnessMeta: MessageHarnessMeta(model: "gpt-5.3-codex", sourceKind: .agent)
                    ),
                ],
                liveActivity: LiveActivityState(isWorking: false)
            ),

            "master:root": SessionTranscriptResult(
                sessionId: "master:root",
                messages: [
                    UnifiedMessage(
                        id: "m-1",
                        role: .user,
                        timestamp: now - 25 * minute,
                        blocks: [.text(text: "/status Give me a concise pulse across Antigravity, Codex, and Claude.")]
                    ),
                    UnifiedMessage(
                        id: "m-2",
                        role: .assistant,
                        timestamp: now - 24 * minute,
                        blocks: [
                            .toolCall(
                                name: "list_sessions",
                                server: "super-harness-mcp",
                                args: "{\"live\": true}",
                                output: "3 live sessions across 3 harnesses (1 running, 1 waiting input, 1 idle)",
                                status: "done",
                                durationMs: 42
                            ),
                            .text(text: """
                            Here is the current workspace pulse:

                            - **Antigravity** (`feat/ios-app`): actively building the native SwiftUI companion app — 3 of 5 checklist steps complete.
                            - **Codex** (`feat/mobile-api`): waiting for confirmation on remote bind port (`47890`) before wiring `/api/bootstrap`.
                            - **Claude tmux** (`main`): idle after landing the hero-limit usage card redesign.

                            Type any instruction to orchestrate across sessions or tap a harness tab to jump straight in.
                            """),
                        ],
                        harnessMeta: MessageHarnessMeta(model: "Claude Opus 4.6", sourceKind: .agent)
                    ),
                ],
                liveActivity: LiveActivityState(isWorking: false)
            ),

            "antigravity:agy-ios-companion": SessionTranscriptResult(
                sessionId: "antigravity:agy-ios-companion",
                messages: [
                    UnifiedMessage(
                        id: "agy-1",
                        role: .user,
                        timestamp: now - 40 * minute,
                        blocks: [
                            .text(text: "Build the native SwiftUI iOS companion using our obsidian palette, SSE streaming, and hero-limit usage sheet."),
                            .image(path: "/tmp/obsidian-reference.png", name: "obsidian-reference.png", dataUrl: samplePreviewDataUrl),
                        ]
                    ),
                    UnifiedMessage(
                        id: "agy-2",
                        role: .assistant,
                        timestamp: now - 38 * minute,
                        blocks: [
                            .thinking(
                                text: "Checking tokens.css obsidian elevation scale (#101114 -> #23252c), harness brand accents, and tolerant Codable decoding so both /api/bootstrap and the current /api/sessions subset work seamlessly.",
                                summary: "Mapped design tokens and tolerant Codable schema"
                            ),
                            .command(
                                command: "xcodegen generate && xcodebuild -scheme SuperHarness -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build",
                                cwd: "/Users/lxe/Developer/super-harness/ios",
                                output: "⚙️  Generating plists...\n⚙️  Writing project...\nCreated project at /Users/lxe/Developer/super-harness/ios/SuperHarness.xcodeproj\n** BUILD SUCCEEDED **",
                                exitCode: 0,
                                durationMs: 4820,
                                status: "done"
                            ),
                            .fileChange(
                                changes: [
                                    FileChangeEntry(
                                        path: "ios/SuperHarness/Theme/DesignTokens.swift",
                                        kind: "added",
                                        diff: """
                                        @@ -0,0 +1,10 @@
                                        +public enum SHColor {
                                        +    public static let surfaceCode = Color(hex: 0x101114)
                                        +    public static let surfaceCanvas = Color(hex: 0x16171B)
                                        +    public static let brandAntigravity = Color(hex: 0x60A5FA)
                                        +    public static let brandCodex = Color(hex: 0x10A37F)
                                        +    public static let brandClaude = Color(hex: 0xD97757)
                                        +}
                                        """
                                    ),
                                    FileChangeEntry(
                                        path: "ios/SuperHarness/Networking/SSEClient.swift",
                                        kind: "modified",
                                        diff: """
                                        @@ -42,4 +42,7 @@
                                         case "data":
                                             dataLines.append(value)
                                        +case "retry":
                                        +    if let ms = Int(value), ms >= 0 { currentRetry = ms }
                                         default:
                                             break
                                        """
                                    ),
                                ],
                                status: "applied"
                            ),
                            .webSearch(
                                query: "SwiftUI NavigationSplitView compact column visibility iOS 18",
                                url: "https://developer.apple.com/documentation/swiftui/navigationsplitview"
                            ),
                            .notice(
                                title: "Local Networking Configured",
                                detail: "NSAllowsLocalNetworking is enabled in Info.plist so Tailscale (100.x.y.z) and LAN HTTP endpoints connect cleanly."
                            ),
                            .text(text: """
                            The core networking layer, obsidian theme tokens, and coalesced transcript block renderer are wired up.

                            ```swift
                            let frame = parser.feed(line: "data: {\"ok\":true}")
                            ```

                            Related session: [Tailscale Control Server](conversation://cx-control-server). I'm running final simulator verification now — feel free to steer or follow up while I finish.
                            """),
                        ],
                        harnessMeta: MessageHarnessMeta(model: "Gemini 3.1 Pro", sourceKind: .agent)
                    ),
                ],
                liveActivity: LiveActivityState(
                    isWorking: true,
                    focus: "Running SwiftUI simulator tests on iPhone 17 Pro",
                    steps: [
                        LiveStepItem(title: "Map tokens.css & UnifiedModels", status: .done),
                        LiveStepItem(title: "Implement SSEClient & KeychainStore", status: .done),
                        LiveStepItem(title: "Build SessionList & Transcript views", status: .done),
                        LiveStepItem(title: "Verify build & unit tests in Simulator", status: .inProgress),
                        LiveStepItem(title: "Commit ios/ changes on feat/ios-app", status: .pending),
                    ],
                    queuedMessages: [
                        QueuedMessageItem(
                            id: "q-demo-1",
                            text: "Also double-check iPad split view column width in landscape.",
                            createdAt: now - 30_000,
                            source: "super-harness"
                        ),
                    ],
                    runningTasks: [
                        RunningTaskItem(
                            id: "task-xcodebuild",
                            summary: "xcodebuild test (iPhone 17 Pro)",
                            command: "xcodebuild test -scheme SuperHarness"
                        ),
                    ],
                    lastEventAt: now - 5_000
                )
            ),

            "codex:cx-control-server": SessionTranscriptResult(
                sessionId: "codex:cx-control-server",
                messages: [
                    UnifiedMessage(
                        id: "cx-1",
                        role: .user,
                        timestamp: now - 30 * minute,
                        blocks: [.text(text: "Prepare the ControlServer remote bind option and /api/bootstrap endpoint for the iOS companion.")]
                    ),
                    UnifiedMessage(
                        id: "cx-2",
                        role: .assistant,
                        timestamp: now - 15 * minute,
                        blocks: [
                            .thinking(
                                text: "Evaluating whether default bind should remain 127.0.0.1 unless the user explicitly enables Tailscale/LAN pairing.",
                                summary: "Checked bind safety and token persistence"
                            ),
                            .command(
                                command: "npm test -- controlServer",
                                cwd: "/Users/lxe/Developer/super-harness",
                                output: "FAIL tests/controlServer.test.ts\n  Expected 401 when Authorization header is omitted\nPASS after adding bearer check on /api/bootstrap (12 passed)",
                                exitCode: 0,
                                durationMs: 1290,
                                status: "done"
                            ),
                            .fileChange(
                                changes: [
                                    FileChangeEntry(
                                        path: "src/main/services/controlServer.ts",
                                        kind: "modified",
                                        diff: """
                                        @@ -78,6 +78,12 @@
                                        +if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
                                        +  const payload = await this.buildBootstrap();
                                        +  res.end(JSON.stringify(payload));
                                        +  return;
                                        +}
                                         if (req.method === 'GET' && url.pathname === '/api/harnesses') {
                                        """
                                    ),
                                ],
                                status: "applied"
                            ),
                            .question(
                                questions: [
                                    QuestionItem(
                                        question: "Which bind interface should Remote Mode default to when enabled?",
                                        options: [
                                            "Tailscale interface only (Recommended)",
                                            "All LAN interfaces (0.0.0.0)",
                                            "Localhost only (manual SSH tunnel)",
                                        ],
                                        multiSelect: false,
                                        answer: nil
                                    ),
                                ],
                                answered: false
                            ),
                        ],
                        harnessMeta: MessageHarnessMeta(model: "gpt-5.3-codex", sourceKind: .agent)
                    ),
                ],
                liveActivity: LiveActivityState(isWorking: false)
            ),

            "claude-tmux:cc-usage-redesign": SessionTranscriptResult(
                sessionId: "claude-tmux:cc-usage-redesign",
                messages: [
                    UnifiedMessage(
                        id: "cc-1",
                        role: .user,
                        timestamp: now - 55 * minute,
                        blocks: [.text(text: "Summarize the hero-limit usage sheet rules so iOS matches desktop commit 2961d79.")]
                    ),
                    UnifiedMessage(
                        id: "cc-2",
                        role: .assistant,
                        timestamp: now - 42 * minute,
                        blocks: [
                            .toolCall(
                                name: "read_file",
                                server: "filesystem",
                                args: "src/renderer/components/HarnessUsageHoverCard.tsx",
                                output: "Read 529 lines (pickHeroWindow, computeWindowPace, SpendTrendSection)",
                                status: "done",
                                durationMs: 18
                            ),
                            .text(text: """
                            Desktop usage hierarchy (`2961d79`):

                            1. **Hero Window**: Pick the highest `usedPercent` primary window (excluding `extra`), promoted to a **28pt semibold** tabular headline.
                            2. **Pace & Delta**: Show `+X% today · on pace for Y%` (warning tint if projected >= 100%) and place a crisp vertical **pace tick** on the bar at `elapsedPercent`.
                            3. **Progressive Disclosure**: Secondary windows stay quieter below the hero bar, paired with exact reset time.
                            4. **7-Day Spend**: Boxless inline metrics (`week`, `today`, `last 5h`) above a clean 7-bar chart with **Today** highlighted in the harness accent color.
                            """),
                        ],
                        harnessMeta: MessageHarnessMeta(model: "claude-sonnet-4-6", sourceKind: .agent)
                    ),
                ],
                liveActivity: LiveActivityState(isWorking: false)
            ),

            "muse:muse-orb-review": SessionTranscriptResult(
                sessionId: "muse:muse-orb-review",
                messages: [
                    UnifiedMessage(
                        id: "muse-1",
                        role: .user,
                        timestamp: now - 26 * minute,
                        blocks: [.text(text: "Verify Muse harness support and make /api/bootstrap decoding future-proof.")]
                    ),
                    UnifiedMessage(
                        id: "muse-2",
                        role: .assistant,
                        timestamp: now - 22 * minute,
                        blocks: [
                            .text(text: "Muse is wired with its orbital `#a855f7` mark, `muse-exec` dispatch mode, usage card, and lossy bootstrap decoding so future harnesses never fail sync."),
                        ],
                        harnessMeta: MessageHarnessMeta(model: "muse-wonder-full-1.0", sourceKind: .agent)
                    ),
                ],
                liveActivity: LiveActivityState(isWorking: false)
            ),
        ]

        self.usage = Self.makeDemoUsage(now: now, hour: hour, day: day)
        self.catalog = Self.makeDemoCatalog(now: now)
    }

    // MARK: - Protocol Implementation

    public func fetchBootstrap() async throws -> BootstrapPayload {
        bootstrapCallCount += 1
        if simulateOffline {
            throw URLError(.cannotConnectToHost)
        }
        return BootstrapPayload(
            protocolVersion: 1,
            seq: 1,
            harnesses: harnesses,
            sessions: sessions,
            activeWorkingSessionIds: currentWorkingSessionIds(),
            state: SuperHarnessState(
                settings: SuperHarnessSettings(
                    sidebarGroupBy: .native,
                    showArchived: false,
                    showHidden: false,
                    defaultNewSessionCwd: "/Users/lxe/Developer/super-harness"
                ),
                folders: folders,
                overrides: [:],
                masterMessages: transcripts["master:root"]?.messages ?? []
            ),
            usage: usage,
            catalog: catalog
        )
    }

    public func fetchSessions(query: String?, harness: HarnessGroup?, liveOnly: Bool) async throws -> [UnifiedSession] {
        sessions.filter { s in
            if liveOnly && !s.isLive { return false }
            if let harness, s.harness.harnessGroup != harness { return false }
            if let query, !query.isEmpty {
                let q = query.lowercased()
                let hay = "\(s.displayTitle) \(s.projectName) \(s.cwd) \(s.preview) \(s.tags.joined(separator: " "))".lowercased()
                return hay.contains(q)
            }
            return true
        }
    }

    public func fetchHarnesses() async throws -> [HarnessDetection] {
        harnesses
    }

    public func fetchTranscript(sessionId: String, limit: Int) async throws -> SessionTranscriptResult {
        if let existing = transcripts[sessionId] {
            return existing
        }
        let session = sessions.first(where: { $0.id == sessionId })
        let fallback = SessionTranscriptResult(
            sessionId: sessionId,
            messages: [
                UnifiedMessage(
                    id: "welcome-\(sessionId)",
                    role: .assistant,
                    timestamp: session?.updatedAt ?? Date().timeIntervalSince1970 * 1000.0,
                    blocks: [
                        .text(text: session?.preview.isEmpty == false ? session!.preview : "Session ready. Send a prompt to simulate a live streaming response in Demo Mode."),
                    ],
                    harnessMeta: MessageHarnessMeta(model: session?.model)
                ),
            ],
            liveActivity: LiveActivityState(isWorking: session?.isWorking ?? false)
        )
        transcripts[sessionId] = fallback
        return fallback
    }

    public func fetchUsage(force: Bool) async throws -> UsageSnapshot? {
        usage
    }

    public func fetchCatalog(force: Bool) async throws -> HarnessCatalog? {
        catalog
    }

    public func watchSession(sessionId: String?, limit: Int) async {
        watchedSessions.append(sessionId)
    }

    /// Demo path that behaves like an image still being written: the first request is a 404,
    /// the second returns a truncated file, later ones return the whole image.
    public static let slowGeneratedImagePath = "/demo/generated_images/slow-write.png"
    private var slowGeneratedImageRequests = 0

    public func fetchMedia(path: String) async throws -> Data {
        if path == Self.slowGeneratedImagePath {
            slowGeneratedImageRequests += 1
            guard slowGeneratedImageRequests > 1,
                  let dataUrl = Self.makeSamplePreviewDataUrl(),
                  let comma = dataUrl.firstIndex(of: ","),
                  let full = Data(base64Encoded: String(dataUrl[dataUrl.index(after: comma)...])) else {
                throw SuperHarnessAPIError.notFound("/api/media")
            }
            return slowGeneratedImageRequests == 2 ? full.prefix(full.count / 2) : full
        }
        if let dataUrl = Self.makeSamplePreviewDataUrl(),
           let comma = dataUrl.firstIndex(of: ","),
           let data = Data(base64Encoded: String(dataUrl[dataUrl.index(after: comma)...])) {
            return data
        }
        throw SuperHarnessAPIError.notFound("/api/media")
    }

    public func fetchDictationStatus(overrideURL: String?, overrideToken: String?) async -> DictationStatusResponse? {
        DictationStatusResponse(
            ok: true,
            configured: true,
            url: overrideURL?.isEmpty == false ? overrideURL : "http://100.64.0.10:8765",
            healthy: true,
            model: "whisper-large-v3-turbo"
        )
    }

    public func transcribeAudio(wavData: Data, overrideURL: String?, overrideToken: String?) async throws -> String {
        // SH_MOCK_TRANSCRIBE_DELAY_MS lengthens the demo transcription so UI tests can observe the in-flight state.
        let delayMs = ProcessInfo.processInfo.environment["SH_MOCK_TRANSCRIBE_DELAY_MS"].flatMap(UInt64.init) ?? 250
        try? await Task.sleep(nanoseconds: delayMs * 1_000_000)
        return "Run the simulator build and verify all unit tests pass."
    }

    public func emitServerEventForTesting(_ event: SuperHarnessServerEvent) {
        broadcast(event)
    }

    public func sendMessage(sessionId: String, message: String, attachments: [ImageAttachment]) async throws -> SendMessageResult {
        if let err = simulateSendError {
            return SendMessageResult(ok: false, error: err)
        }
        let now = Date().timeIntervalSince1970 * 1000.0
        var transcript = try await fetchTranscript(sessionId: sessionId, limit: 80)

        // If the session is actively working, enqueue the message just like the desktop host
        if transcript.liveActivity?.isWorking == true {
            let queued = QueuedMessageItem(
                text: message,
                attachments: attachments.isEmpty ? nil : attachments,
                createdAt: now,
                source: "super-harness"
            )
            var activity = transcript.liveActivity ?? LiveActivityState(isWorking: true)
            var list = activity.queuedMessages ?? []
            list.append(queued)
            activity.queuedMessages = list
            transcript.liveActivity = activity
            transcripts[sessionId] = transcript
            broadcast(.transcript(transcript))
            return SendMessageResult(ok: true, dispatchedVia: "demo-queue", runId: queued.id)
        }

        // Otherwise append user message and start simulated streaming reply
        var userBlocks: [UnifiedBlock] = []
        if !message.isEmpty {
            userBlocks.append(.text(text: message))
        }
        for att in attachments {
            userBlocks.append(.image(path: att.path, name: att.name, dataUrl: att.previewDataUrl))
        }
        let userMsg = UnifiedMessage(role: .user, timestamp: now, blocks: userBlocks)
        transcript.messages.append(userMsg)

        // Mark any unanswered question block as answered
        for idx in transcript.messages.indices {
            for bIdx in transcript.messages[idx].blocks.indices {
                if case .question(var qs, let answered) = transcript.messages[idx].blocks[bIdx], answered != true {
                    if !qs.isEmpty {
                        qs[0].answer = message
                    }
                    transcript.messages[idx].blocks[bIdx] = .question(questions: qs, answered: true)
                }
            }
        }

        let runId = "demo-run-\(UUID().uuidString.prefix(8))"
        transcript.liveActivity = LiveActivityState(
            isWorking: true,
            focus: "Analyzing request in Demo Mode",
            steps: [
                LiveStepItem(title: "Inspect workspace context", status: .inProgress),
                LiveStepItem(title: "Run verification check", status: .pending),
                LiveStepItem(title: "Draft response", status: .pending),
            ],
            queuedMessages: transcript.liveActivity?.queuedMessages,
            runningTasks: [RunningTaskItem(id: "demo-task", summary: "Demo runner active")],
            lastEventAt: now
        )
        transcripts[sessionId] = transcript
        setSessionStatus(sessionId: sessionId, status: .running, preview: message)
        broadcast(.transcript(transcript))
        broadcastSessionsAndActivity()

        activeTasks[sessionId]?.cancel()
        activeTasks[sessionId] = Task {
            await self.simulateReply(sessionId: sessionId, runId: runId, prompt: message)
        }

        return SendMessageResult(ok: true, dispatchedVia: "demo-stream", runId: runId)
    }

    public func abortRun(sessionId: String) async throws -> Bool {
        activeTasks[sessionId]?.cancel()
        activeTasks.removeValue(forKey: sessionId)

        if var tr = transcripts[sessionId] {
            tr.liveActivity = LiveActivityState(
                isWorking: false,
                focus: nil,
                steps: tr.liveActivity?.steps,
                queuedMessages: tr.liveActivity?.queuedMessages,
                runningTasks: nil,
                lastEventAt: Date().timeIntervalSince1970 * 1000.0
            )
            transcripts[sessionId] = tr
            broadcast(.transcript(tr))
        }
        setSessionStatus(sessionId: sessionId, status: .idle, preview: nil)
        broadcastSessionsAndActivity()
        return true
    }

    public func startSession(_ request: StartSessionRequest) async throws -> StartSessionResponse {
        let now = Date().timeIntervalSince1970 * 1000.0
        let nativeId = "demo-\(UUID().uuidString.prefix(6).lowercased())"
        let id = "\(request.harness.rawValue):\(nativeId)"
        let projectName = (request.cwd.trimmingCharacters(in: CharacterSet(charactersIn: "/")) as NSString).lastPathComponent
        let title = (request.title?.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap { $0.isEmpty ? nil : $0 }
            ?? (request.prompt?.prefix(48)).map(String.init)
            ?? "New \(request.harness.label) session"

        let newSession = UnifiedSession(
            id: id,
            nativeId: nativeId,
            harness: request.harness.kind,
            harnessGroup: request.harness.kind.groupOrMaster,
            title: title,
            preview: request.prompt ?? "Fresh session ready",
            cwd: request.cwd,
            projectName: projectName.isEmpty ? "Workspace" : projectName,
            gitBranch: "main",
            model: request.model ?? catalog.models(for: request.harness.harnessGroup).first?.id,
            status: .idle,
            isLive: true,
            isRemote: request.remoteControl ?? false,
            tmuxSessionName: request.tmuxSessionName,
            createdAt: now,
            updatedAt: now,
            pinned: false,
            dispatchMode: request.harness.kind.defaultDispatchMode,
            nativeSection: projectName.isEmpty ? "Workspace" : projectName,
            nativeSectionOrder: 0
        )

        if sessions.first?.isMaster == true {
            sessions.insert(newSession, at: 1)
        } else {
            sessions.insert(newSession, at: 0)
        }

        let effortNote = request.reasoningEffort.map { " · reasoning: `\($0)`" } ?? ""
        transcripts[id] = SessionTranscriptResult(
            sessionId: id,
            messages: [
                UnifiedMessage(
                    role: .assistant,
                    timestamp: now,
                    blocks: [
                        .notice(
                            title: "Session Started",
                            detail: "\(request.harness.label) in \(request.cwd)\(effortNote)"
                        ),
                    ],
                    harnessMeta: MessageHarnessMeta(model: newSession.model)
                ),
            ],
            liveActivity: LiveActivityState(isWorking: false)
        )

        broadcast(.sessions(harnesses: harnesses, sessions: sessions))

        if let prompt = request.prompt?.trimmingCharacters(in: .whitespacesAndNewlines), !prompt.isEmpty {
            _ = try await sendMessage(sessionId: id, message: prompt, attachments: [])
        }
        return StartSessionResponse(ok: true, sessionId: id, error: nil)
    }

    public func fetchFolders() async throws -> FoldersResponse {
        FoldersResponse(folders: folders, sidebarGroupBy: settings.sidebarGroupBy)
    }

    public func updateSettings(sidebarGroupBy: SidebarGroupBy) async throws -> SuperHarnessSettings? {
        settings.sidebarGroupBy = sidebarGroupBy
        return settings
    }

    public func organize(actions: [OrganizeAction]) async throws -> OrganizeResponse {
        for action in actions {
            switch action.type {
            case .createFolder:
                let name = (action.folderName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                if !name.isEmpty && !folders.contains(where: { $0.name.lowercased() == name.lowercased() }) {
                    let fid = action.folderId ?? "folder-\(UUID().uuidString.prefix(8).lowercased())"
                    folders.append(SessionFolder(id: fid, name: name, color: action.folderColor ?? "#60A5FA", order: folders.count))
                }
                continue
            case .renameFolder:
                if let fid = action.folderId,
                   let name = action.folderName?.trimmingCharacters(in: .whitespacesAndNewlines),
                   !name.isEmpty,
                   let fIdx = folders.firstIndex(where: { $0.id == fid }) {
                    folders[fIdx].name = name
                }
                continue
            case .deleteFolder:
                if let fid = action.folderId {
                    folders.removeAll { $0.id == fid }
                    for i in sessions.indices where sessions[i].folderId == fid {
                        sessions[i].folderId = nil
                    }
                }
                continue
            case .reorderFolders:
                if let orderedIds = action.folderIds {
                    for (order, fid) in orderedIds.enumerated() {
                        if let fIdx = folders.firstIndex(where: { $0.id == fid }) {
                            folders[fIdx].order = order
                        }
                    }
                    folders.sort { $0.order < $1.order }
                }
                continue
            default:
                break
            }
            guard let sid = action.sessionId,
                  let idx = sessions.firstIndex(where: { $0.id == sid }) else {
                continue
            }
            switch action.type {
            case .pin: sessions[idx].pinned = true
            case .unpin: sessions[idx].pinned = false
            case .pinTop:
                sessions[idx].pinnedToTop = true
                sessions[idx].pinned = true
            case .unpinTop:
                sessions[idx].pinnedToTop = false
            case .hideSession:
                sessions[idx].hidden = true
            case .unhideSession:
                sessions[idx].hidden = false
            case .renameSession:
                sessions[idx].customTitle = action.title
            case .assignFolder:
                sessions[idx].folderId = action.folderId
            case .tagSession:
                if let tags = action.tags { sessions[idx].tags = tags }
            case .setModel:
                if let model = action.model { sessions[idx].model = model }
                if let effort = action.reasoningEffort { sessions[idx].reasoningEffort = effort }
            case .createFolder, .deleteFolder, .renameFolder, .reorderFolders:
                break
            }
        }
        broadcast(.sessions(harnesses: harnesses, sessions: sessions))
        return OrganizeResponse(ok: true, folders: folders)
    }

    public func setSessionUnread(sessionId: String, unread: Bool) async throws {
        if let idx = sessions.firstIndex(where: { $0.id == sessionId }) {
            sessions[idx].unread = unread
            broadcast(.sessions(harnesses: harnesses, sessions: sessions))
        }
    }

    public func archiveSession(sessionId: String, killTmux: Bool) async throws -> ArchiveResponse {
        if let idx = sessions.firstIndex(where: { $0.id == sessionId }) {
            sessions[idx].status = .archived
            sessions[idx].isLive = false
            broadcast(.sessions(harnesses: harnesses, sessions: sessions))
        }
        return ArchiveResponse(ok: true, method: "demo-archive", error: nil)
    }

    public func controlHarness(harness: HarnessGroup, action: HarnessControlAction) async throws -> ControlHarnessResponse {
        if let idx = harnesses.firstIndex(where: { $0.id == harness }) {
            switch action {
            case .startRemote:
                harnesses[idx].remoteControlEnabled = true
                harnesses[idx].daemonRunning = true
            case .stopRemote:
                harnesses[idx].remoteControlEnabled = false
            case .openDesktop:
                harnesses[idx].desktopAppRunning = true
            }
            broadcast(.sessions(harnesses: harnesses, sessions: sessions))
        }
        return ControlHarnessResponse(ok: true, output: "Applied \(action.rawValue) to \(harness.title)")
    }

    public func uploadAttachment(dataUrl: String, filename: String?) async throws -> ImageAttachment {
        ImageAttachment(
            name: filename ?? "photo.jpg",
            path: "/tmp/\(filename ?? "photo.jpg")",
            mimeType: "image/jpeg",
            previewDataUrl: dataUrl
        )
    }

    public func uploadAttachmentData(_ data: Data, mimeType: String, filename: String?) async throws -> ImageAttachment {
        ImageAttachment(
            name: filename ?? "file.bin",
            path: "/tmp/\(filename ?? "file.bin")",
            mimeType: mimeType,
            previewDataUrl: nil,
            sizeBytes: data.count
        )
    }

    public func registerPushDevice(rid: String, relayUrl: String, enabled: Bool) async -> Bool { true }
    public func sendTestPush() async throws -> Bool { true }

    public func testConnection() async throws -> ConnectionTestResult {
        ConnectionTestResult(ok: true, latencyMs: 4, harnessCount: harnesses.count, message: "Demo Mode active (offline fixtures)")
    }

    nonisolated public func eventStream() -> AsyncStream<SuperHarnessServerEvent> {
        let id = UUID()
        return AsyncStream { continuation in
            Task {
                await self.registerContinuation(id: id, continuation: continuation)
            }
            continuation.onTermination = { [weak self] _ in
                Task { await self?.removeContinuation(id) }
            }
        }
    }

    // MARK: - Helpers

    private func registerContinuation(id: UUID, continuation: AsyncStream<SuperHarnessServerEvent>.Continuation) {
        continuations[id] = continuation
        if simulateOffline {
            continuation.yield(.disconnected("Cannot connect to host"))
        } else {
            continuation.yield(.connected)
        }
    }

    private func removeContinuation(_ id: UUID) {
        continuations.removeValue(forKey: id)
    }

    private func currentWorkingSessionIds() -> [String] {
        sessions.compactMap { s in
            guard !s.isMaster else { return nil }
            if s.isWorking || transcripts[s.id]?.liveActivity?.isWorking == true {
                return s.id
            }
            return nil
        }
    }

    private func broadcastSessionsAndActivity() {
        let workingIds = currentWorkingSessionIds()
        broadcast(.sessions(harnesses: harnesses, sessions: sessions, workingSessionIds: workingIds))
        broadcast(.activity(workingIds))
    }

    private func broadcast(_ event: SuperHarnessServerEvent) {
        for cont in continuations.values {
            cont.yield(event)
        }
    }

    private func setSessionStatus(sessionId: String, status: SessionStatus, preview: String?) {
        guard let idx = sessions.firstIndex(where: { $0.id == sessionId }) else { return }
        sessions[idx].status = status
        sessions[idx].updatedAt = Date().timeIntervalSince1970 * 1000.0
        if let preview, !preview.isEmpty {
            sessions[idx].preview = preview
        }
    }

    private func simulateReply(sessionId: String, runId: String, prompt: String) async {
        broadcast(.stream(StreamEvent(sessionId: sessionId, runId: runId, kind: .start)))

        try? await Task.sleep(nanoseconds: 350_000_000)
        guard !Task.isCancelled else { return }

        let thinkingBlock = UnifiedBlock.thinking(
            text: "Reviewing \"\(prompt)\" against current workspace state and active branch diff.",
            summary: "Analyzed prompt & workspace context"
        )
        broadcast(.stream(StreamEvent(sessionId: sessionId, runId: runId, kind: .block, block: thinkingBlock)))

        updateSteps(sessionId: sessionId, focus: "Running quick verification", doneCount: 1)
        try? await Task.sleep(nanoseconds: 450_000_000)
        guard !Task.isCancelled else { return }

        let cmdBlock = UnifiedBlock.command(
            command: "git status --short && swift test --filter Smoke",
            cwd: "/Users/lxe/Developer/super-harness/ios",
            output: "M SuperHarness/State/AppStore.swift\nTest Suite 'Smoke' passed in 0.14s",
            exitCode: 0,
            durationMs: 310,
            status: "done"
        )
        broadcast(.stream(StreamEvent(sessionId: sessionId, runId: runId, kind: .block, block: cmdBlock)))

        updateSteps(sessionId: sessionId, focus: "Composing reply", doneCount: 2)

        let replyChunks = [
            "Got it — I processed **\"\(prompt)\"** in Demo Mode.\n\n",
            "- Live SSE streaming deltas and tool blocks are updating incrementally.\n",
            "- Tap **Host Settings** anytime to point Super Harness at your Linux desktop host over Tailscale or LAN.",
        ]
        var assembled = ""
        for chunk in replyChunks {
            try? await Task.sleep(nanoseconds: 280_000_000)
            guard !Task.isCancelled else { return }
            assembled += chunk
            broadcast(.stream(StreamEvent(sessionId: sessionId, runId: runId, kind: .delta, text: chunk)))
        }

        // Persist finalized assistant message into mock transcript
        let model = sessions.first(where: { $0.id == sessionId })?.model
        let assistantMessage = UnifiedMessage(
            role: .assistant,
            timestamp: Date().timeIntervalSince1970 * 1000.0,
            blocks: [thinkingBlock, cmdBlock, .text(text: assembled)],
            harnessMeta: MessageHarnessMeta(model: model, sourceKind: .agent)
        )

        var nextQueued: QueuedMessageItem?
        if var tr = transcripts[sessionId] {
            tr.messages.append(assistantMessage)
            var remaining = tr.liveActivity?.queuedMessages ?? []
            if !remaining.isEmpty {
                nextQueued = remaining.removeFirst()
            }
            tr.liveActivity = LiveActivityState(
                isWorking: false,
                focus: nil,
                steps: [
                    LiveStepItem(title: "Inspect workspace context", status: .done),
                    LiveStepItem(title: "Run verification check", status: .done),
                    LiveStepItem(title: "Draft response", status: .done),
                ],
                queuedMessages: remaining.isEmpty ? nil : remaining,
                runningTasks: nil,
                lastEventAt: Date().timeIntervalSince1970 * 1000.0
            )
            transcripts[sessionId] = tr
            broadcast(.transcript(tr))
        }

        setSessionStatus(sessionId: sessionId, status: .idle, preview: assembled.replacingOccurrences(of: "\n", with: " "))
        broadcast(.stream(StreamEvent(sessionId: sessionId, runId: runId, kind: .done)))
        broadcastSessionsAndActivity()
        activeTasks.removeValue(forKey: sessionId)

        // Drain next queued follow-up automatically if present
        if let nextQueued {
            _ = try? await sendMessage(
                sessionId: sessionId,
                message: nextQueued.text,
                attachments: nextQueued.attachments ?? []
            )
        }
    }

    private func updateSteps(sessionId: String, focus: String, doneCount: Int) {
        guard var tr = transcripts[sessionId] else { return }
        let titles = ["Inspect workspace context", "Run verification check", "Draft response"]
        let steps = titles.enumerated().map { idx, title -> LiveStepItem in
            if idx < doneCount { return LiveStepItem(title: title, status: .done) }
            if idx == doneCount { return LiveStepItem(title: title, status: .inProgress) }
            return LiveStepItem(title: title, status: .pending)
        }
        tr.liveActivity = LiveActivityState(
            isWorking: true,
            focus: focus,
            steps: steps,
            queuedMessages: tr.liveActivity?.queuedMessages,
            runningTasks: tr.liveActivity?.runningTasks,
            lastEventAt: Date().timeIntervalSince1970 * 1000.0
        )
        transcripts[sessionId] = tr
        broadcast(.transcript(tr))
    }

    // MARK: - Fixture Builders

    private static func makeDemoUsage(now: Double, hour: Double, day: Double) -> UsageSnapshot {
        let dayNames = ["Thu", "Fri", "Sat", "Sun", "Mon", "Tue", "Wed"]
        func makePoints(_ values: [(Double, Int)]) -> [DailySpendPoint] {
            values.enumerated().map { idx, pair in
                DailySpendPoint(
                    date: "2026-11-\(19 + idx)",
                    dayLabel: dayNames[idx],
                    spendUsd: pair.0,
                    tokens: pair.1
                )
            }
        }

        let agy = HarnessUsageSummary(
            harness: .antigravity,
            updatedAt: now - 120_000,
            planLabel: "Google AI Ultra",
            barPercent: 42,
            windows: [
                UsageQuotaWindow(
                    id: "weekly",
                    label: "Weekly limit",
                    usedPercent: 42,
                    resetsAt: now + 3.4 * day,
                    delta24h: 11,
                    windowMinutes: 7 * 1440
                ),
                UsageQuotaWindow(
                    id: "5h",
                    label: "5-hour window",
                    usedPercent: 28,
                    resetsAt: now + 2.6 * hour,
                    delta24h: nil,
                    windowMinutes: 300
                ),
            ],
            creditsBalance: 14_250,
            spend5hUsd: 4.2,
            spend24hUsd: 14.8,
            spend7dUsd: 68.4,
            spend14dUsd: 129.0,
            tokens7d: 18_400_000,
            dailySpend7d: makePoints([
                (7.1, 1_900_000), (11.4, 3_100_000), (6.2, 1_700_000),
                (5.4, 1_400_000), (12.9, 3_600_000), (10.6, 2_800_000), (14.8, 3_900_000),
            ]),
            spendIsEstimated: true
        )

        let codex = HarnessUsageSummary(
            harness: .codex,
            updatedAt: now - 90_000,
            planLabel: "ChatGPT Pro",
            barPercent: 64,
            windows: [
                UsageQuotaWindow(
                    id: "weekly",
                    label: "Weekly limit",
                    usedPercent: 64,
                    resetsAt: now + 2.8 * day,
                    delta24h: 16,
                    windowMinutes: 7 * 1440
                ),
                UsageQuotaWindow(
                    id: "5h",
                    label: "5-hour window",
                    usedPercent: 48,
                    resetsAt: now + 1.9 * hour,
                    windowMinutes: 300
                ),
            ],
            spend5hUsd: 5.6,
            spend24hUsd: 19.2,
            spend7dUsd: 94.5,
            spend14dUsd: 176.2,
            tokens7d: 24_900_000,
            dailySpend7d: makePoints([
                (10.5, 2_700_000), (14.2, 3_800_000), (9.8, 2_600_000),
                (8.1, 2_100_000), (16.4, 4_300_000), (16.3, 4_300_000), (19.2, 5_100_000),
            ]),
            spendIsEstimated: true
        )

        let claude = HarnessUsageSummary(
            harness: .claude,
            updatedAt: now - 60_000,
            planLabel: "Claude Max 20x",
            barPercent: 83,
            windows: [
                UsageQuotaWindow(
                    id: "weekly",
                    label: "All models · weekly",
                    usedPercent: 83,
                    resetsAt: now + 1.7 * day,
                    delta24h: 19,
                    windowMinutes: 7 * 1440
                ),
                UsageQuotaWindow(
                    id: "5h",
                    label: "Current session (5h)",
                    usedPercent: 52,
                    resetsAt: now + 3.1 * hour,
                    windowMinutes: 300
                ),
                UsageQuotaWindow(
                    id: "extra",
                    label: "Extra usage",
                    usedPercent: 12,
                    windowMinutes: nil
                ),
            ],
            spend5hUsd: 8.9,
            spend24hUsd: 27.4,
            spend7dUsd: 142.0,
            spend14dUsd: 268.5,
            tokens7d: 31_200_000,
            dailySpend7d: makePoints([
                (18.0, 3_900_000), (22.4, 4_900_000), (15.1, 3_300_000),
                (12.8, 2_800_000), (24.9, 5_500_000), (21.4, 4_700_000), (27.4, 6_100_000),
            ]),
            spendIsEstimated: true
        )

        let muse = HarnessUsageSummary(
            harness: .muse,
            updatedAt: now - 75_000,
            planLabel: "Muse",
            barPercent: 31,
            windows: [
                UsageQuotaWindow(
                    id: "weekly",
                    label: "Weekly limit",
                    usedPercent: 31,
                    resetsAt: now + 4.2 * day,
                    delta24h: 8,
                    windowMinutes: 7 * 1440
                ),
            ],
            spend5hUsd: 2.1,
            spend24hUsd: 6.4,
            spend7dUsd: 28.5,
            spend14dUsd: 49.0,
            tokens7d: 9_600_000,
            dailySpend7d: makePoints([
                (3.2, 1_100_000), (4.5, 1_500_000), (2.8, 950_000),
                (2.4, 820_000), (5.1, 1_720_000), (4.1, 1_360_000), (6.4, 2_150_000),
            ]),
            spendIsEstimated: true
        )

        return UsageSnapshot(antigravity: agy, codex: codex, claude: claude, muse: muse)
    }

    private static func makeDemoCatalog(now: Double) -> HarnessCatalog {
        HarnessCatalog(
            models: [
                .antigravity: [
                    HarnessModelOption(
                        id: "gemini-3.1-pro",
                        label: "Gemini 3.1 Pro",
                        description: "Deep reasoning & multi-file edits",
                        isDefault: true,
                        reasoningLevels: ["low", "medium", "high"],
                        defaultReasoningLevel: "high"
                    ),
                    HarnessModelOption(
                        id: "gemini-3.1-flash",
                        label: "Gemini 3.1 Flash",
                        description: "Fast iteration & search",
                        reasoningLevels: ["low", "medium", "high"],
                        defaultReasoningLevel: "medium"
                    ),
                ],
                .codex: [
                    HarnessModelOption(
                        id: "gpt-5.3-codex",
                        label: "GPT-5.3 Codex",
                        description: "Flagship agentic coding",
                        isDefault: true,
                        reasoningLevels: ["low", "medium", "high", "xhigh"],
                        defaultReasoningLevel: "high"
                    ),
                    HarnessModelOption(
                        id: "gpt-5.3-codex-mini",
                        label: "GPT-5.3 Codex Mini",
                        description: "Low-latency tasks",
                        reasoningLevels: ["low", "medium", "high"],
                        defaultReasoningLevel: "medium"
                    ),
                ],
                .claude: [
                    HarnessModelOption(
                        id: "claude-opus-4-6",
                        label: "Claude Opus 4.6",
                        description: "Complex architecture & reviews",
                        isDefault: true,
                        reasoningLevels: ["low", "medium", "high", "max"],
                        defaultReasoningLevel: "high"
                    ),
                    HarnessModelOption(
                        id: "claude-sonnet-4-6",
                        label: "Claude Sonnet 4.6",
                        description: "Balanced speed & quality",
                        reasoningLevels: ["low", "medium", "high"],
                        defaultReasoningLevel: "medium"
                    ),
                ],
                .muse: [
                    HarnessModelOption(
                        id: "muse-wonder-full-1.0",
                        label: "Muse Wonder Full 1.0",
                        description: "Full reasoning & multi-step execution",
                        isDefault: true,
                        reasoningLevels: ["low", "medium", "high"],
                        defaultReasoningLevel: "high"
                    ),
                    HarnessModelOption(
                        id: "muse-fast-1.0",
                        label: "Muse Fast 1.0",
                        description: "Rapid iterations",
                        reasoningLevels: ["low", "medium"],
                        defaultReasoningLevel: "medium"
                    ),
                ],
            ],
            defaultReasoningEffort: [
                .antigravity: "high",
                .codex: "high",
                .claude: "high",
                .muse: "high",
            ],
            projects: [
                HarnessProjectOption(name: "super-harness", path: "/Users/lxe/Developer/super-harness", harnesses: HarnessGroup.allCases, lastUsedAt: now),
                HarnessProjectOption(name: "obsidian-kit", path: "/Users/lxe/Developer/obsidian-kit", harnesses: [.antigravity, .claude], lastUsedAt: now - 3_600_000),
                HarnessProjectOption(name: "security-playbooks", path: "/Users/lxe/Developer/security-playbooks", harnesses: [.claude, .codex], lastUsedAt: now - 86_400_000),
            ],
            updatedAt: now
        )
    }

    private static func makeSamplePreviewDataUrl() -> String? {
        #if canImport(UIKit)
        let size = CGSize(width: 320, height: 180)
        let renderer = UIGraphicsImageRenderer(size: size)
        let img = renderer.image { ctx in
            UIColor(red: 0.086, green: 0.090, blue: 0.106, alpha: 1).setFill()
            ctx.fill(CGRect(origin: .zero, size: size))

            let cardRect = CGRect(x: 18, y: 18, width: 284, height: 144)
            let cardPath = UIBezierPath(roundedRect: cardRect, cornerRadius: 14)
            UIColor(red: 0.122, green: 0.129, blue: 0.157, alpha: 1).setFill()
            cardPath.fill()

            let colors: [UIColor] = [
                UIColor(red: 0.376, green: 0.647, blue: 0.980, alpha: 1),
                UIColor(red: 0.063, green: 0.639, blue: 0.498, alpha: 1),
                UIColor(red: 0.851, green: 0.467, blue: 0.341, alpha: 1),
            ]
            for (i, color) in colors.enumerated() {
                let bar = UIBezierPath(roundedRect: CGRect(x: 34, y: 42 + i * 36, width: 120 + i * 48, height: 14), cornerRadius: 7)
                color.setFill()
                bar.fill()
            }
        }
        guard let png = img.pngData() else { return nil }
        return "data:image/png;base64,\(png.base64EncodedString())"
        #else
        return nil
        #endif
    }
}
