import Foundation
import Network
import Observation
import SwiftUI

private final class NetworkPathWatcher: @unchecked Sendable {
    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "com.lxe.superharness.network-path")

    init(onSatisfied: @escaping @Sendable () -> Void) {
        monitor.pathUpdateHandler = { path in
            if path.status == .satisfied {
                onSatisfied()
            }
        }
        monitor.start(queue: queue)
    }

    deinit {
        monitor.cancel()
    }
}

public struct SessionListSection: Identifiable, Sendable, Equatable {
    public let id: String
    public let title: String
    public let harnessGroup: HarnessGroup?
    public let accentHex: String?
    public let folderId: String?
    public let isProjectOrSectionGroup: Bool
    public let isHeadless: Bool
    public let sessions: [UnifiedSession]

    public init(
        id: String,
        title: String,
        harnessGroup: HarnessGroup? = nil,
        accentHex: String? = nil,
        folderId: String? = nil,
        isProjectOrSectionGroup: Bool = false,
        isHeadless: Bool = false,
        sessions: [UnifiedSession]
    ) {
        self.id = id
        self.title = title
        self.harnessGroup = harnessGroup
        self.accentHex = accentHex
        self.folderId = folderId
        self.isProjectOrSectionGroup = isProjectOrSectionGroup
        self.isHeadless = isHeadless
        self.sessions = sessions
    }
}

public enum DetailRoute: Hashable, Sendable {
    case session(String)
    case draft(StartHarnessKind)
}

public struct LightboxPayload: Identifiable, Equatable {
    public let id = UUID()
    public let title: String
    public let dataUrl: String?
    public let path: String?
}

public struct StreamTurnBaseline: Sendable, Equatable {
    public let lastAssistantId: String?
    public let lastAssistantBlockCount: Int

    public init(lastAssistantId: String?, lastAssistantBlockCount: Int) {
        self.lastAssistantId = lastAssistantId
        self.lastAssistantBlockCount = lastAssistantBlockCount
    }
}

public struct VisibleStreamingOverlay: Sendable, Equatable {
    public let showBlocks: [UnifiedBlock]
    public let showText: String

    public init(showBlocks: [UnifiedBlock], showText: String) {
        self.showBlocks = showBlocks
        self.showText = showText
    }
}


// MARK: - On-Disk Cold-Launch Snapshot Cache (Zero Skeleton Flash on Relaunch)

private struct CachedMobileSnapshot: Codable, Sendable {
    var version: Int = 1
    var hostURL: String
    var savedAt: Double
    var harnesses: [HarnessDetection]
    var sessions: [UnifiedSession]
    var state: SuperHarnessState
    var usage: UsageSnapshot?
    var catalog: HarnessCatalog?
    var recentTranscriptOrder: [String]
    var recentTranscripts: [String: SessionTranscriptResult]
}

private enum MobileSnapshotDiskStore {
    static var defaultFileURL: URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
            .appendingPathComponent("sh-mobile-snapshot-v1.json")
    }

    static func load(from url: URL?) -> CachedMobileSnapshot? {
        guard let url, let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(CachedMobileSnapshot.self, from: data)
    }

    static func save(_ snapshot: CachedMobileSnapshot, to url: URL?, synchronous: Bool = false) {
        guard let url else { return }
        let writeBlock: @Sendable () -> Void = {
            guard let data = try? JSONEncoder().encode(snapshot) else { return }
            try? FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            try? data.write(to: url, options: .atomic)
        }
        if synchronous {
            writeBlock()
        } else {
            DispatchQueue.global(qos: .utility).async(execute: writeBlock)
        }
    }
}

@MainActor
@Observable
public final class AppStore {
    // MARK: - Persistence Keys
    private enum StorageKey {
        static let connectionMode = "sh.connectionMode"
        static let hostURL = "sh.hostURL"
        static let groupBy = "sh.sidebarGroupBy"
        static let tokenAccount = "desktop-control-server"
        static let dictationURL = "sh.dictationURL"
        static let dictationTokenAccount = "yapyap-dictation-token"
        static let pushEnabled = "sh.pushEnabled"
        static let allowExtremeReasoning = "sh.allowExtremeReasoning"
        static let chatTextSize = "sh.chatTextSize"
        static let chatDensity = "sh.chatDensity"
        static let harnessOrder = "sh.harnessOrder"
        static let pushRelayURL = "sh.pushRelayURL"
    }

    public static let initialTranscriptLimit: Int = 15
    public static let earlierTranscriptStep: Int = 25
    public static let maxTranscriptLimit: Int = 200

    // MARK: - Connection State
    public var connectionMode: ConnectionMode
    public var hostURLString: String
    public var bearerToken: String
    public var connectionHealth: ConnectionHealth = .demo
    public var lastError: String?
    /// Developer-facing detail for `lastError` (domain, code, failing URL), when it is known.
    public private(set) var lastErrorTechnicalDetail: (message: String, detail: String)?
    public var lastErrorDetail: String? {
        guard let recorded = lastErrorTechnicalDetail, recorded.message == lastError else { return nil }
        return recorded.detail
    }
    public var protocolVersion: Int?
    public var lastBootstrapSeq: Int?

    // MARK: - Dictation (YapYap) State
    public var dictationURLOverride: String = ""
    public var dictationTokenOverride: String = ""
    public var dictationStatus: DictationStatusResponse?
    public var isCheckingDictation: Bool = false
    public var pushNotificationsEnabled: Bool = true
    /// Order of the harness gauges, the harness sections in the All view and the usage pills.
    /// Kept on the phone and shared through the host's `settings.harnessOrder`.
    public private(set) var harnessOrder: [HarnessGroup] = HarnessGroup.allCases

    /// Off by default: "max" and "ultra" thinking effort are offered only after the person enables them.
    /// Chat text size and spacing, chosen in Settings and kept on this device.
    public var chatTextSize: ChatTextSize = .standard {
        didSet { defaults.set(chatTextSize.rawValue, forKey: StorageKey.chatTextSize) }
    }
    public var chatDensity: ChatDensity = .comfortable {
        didSet { defaults.set(chatDensity.rawValue, forKey: StorageKey.chatDensity) }
    }
    public var chatMetrics: SHChatMetrics {
        SHChatMetrics(textSize: chatTextSize, density: chatDensity)
    }

    public var allowExtremeReasoning: Bool = false {
        didSet { defaults.set(allowExtremeReasoning, forKey: StorageKey.allowExtremeReasoning) }
    }
    public var pushRelayURL: String = PushNotificationCoordinator.defaultRelayURL

    // MARK: - Domain State
    public var harnesses: [HarnessDetection] = []
    public var sessions: [UnifiedSession] = []
    public var folders: [SessionFolder] = []
    public var usage: UsageSnapshot?
    public var catalog: HarnessCatalog?
    public var settings: SuperHarnessSettings = SuperHarnessSettings()
    public var hostWorkingSessionIds: Set<String> = []

    // MARK: - Navigation & Filtering
    public var selectedSessionId: String?
    public var detailRoute: DetailRoute?
    public var pendingInitialSessionId: String?
    public var pendingInitialRoute: DetailRoute?
    public var selectedHarnessFilter: HarnessGroup? = nil
    public var searchQuery: String = ""
    public var groupBy: SidebarGroupBy = .native {
        didSet { defaults.set(groupBy.rawValue, forKey: StorageKey.groupBy) }
    }
    public var showArchived: Bool = false
    public var showHidden: Bool = false

    // MARK: - Transcript & Composer State
    public var transcriptsBySessionId: [String: SessionTranscriptResult] = [:]
    public var transcriptLimitsBySessionId: [String: Int] = [:]
    public var loadingTranscriptSessionIds: Set<String> = []
    public var streamingMessagesBySessionId: [String: UnifiedMessage] = [:]
    private var streamBaselineBySessionId: [String: StreamTurnBaseline] = [:]
    private var streamingBlocksBySessionId: [String: [UnifiedBlock]] = [:]
    private var streamingTextBySessionId: [String: String] = [:]
    public var pendingOutgoingBySessionId: [String: [PendingOutgoingMessage]] = [:]
    public var sendingSessionIds: Set<String> = []
    /// Unsent composer text per session id, plus `newThreadDraftKey` for the New Chat page.
    /// Kept until the message is sent or the user deletes it; saved to disk when persistence is enabled.
    public var draftInputs: [String: String] = [:] {
        didSet { scheduleDraftSave(attachments: false) }
    }
    public var draftAttachments: [String: [ImageAttachment]] = [:] {
        didSet { scheduleDraftSave(attachments: true) }
    }
    /// Harness, project, model and effort chosen on the New Chat page.
    public var newThreadConfig = NewThreadDraftConfig() {
        didSet { scheduleDraftSave(attachments: false) }
    }
    public static let newThreadDraftKey = "draft:new-thread"
    @ObservationIgnored private var draftPersistence: DraftPersistence?
    @ObservationIgnored private var draftSaveTask: Task<Void, Never>?
    @ObservationIgnored private var draftAttachmentsDirty = false
    public var uploadingAttachmentIds: Set<String> = []
    public var isBootstrapping: Bool = false
    public var isRefreshing: Bool = false
    public var isLoadingUsage: Bool = false

    // MARK: - Sheets & Modals
    public var isUsageSheetPresented: Bool = false
    public var usageSheetTarget: HarnessGroup? = nil
    public var isHostSettingsSheetPresented: Bool = false
    public var lightboxPayload: LightboxPayload? = nil

    // MARK: - Dependencies
    private let keychain: KeychainStoreProtocol
    private let defaults: UserDefaults
    private let reconnectIntervalNs: UInt64
    private var client: SuperHarnessClientProtocol
    private var sseTask: Task<Void, Never>?
    private var autoReconnectTask: Task<Void, Never>?
    private var prefetchTask: Task<Void, Never>?
    private var transcriptFallbackTasks: [String: Task<Void, Never>] = [:]
    private var transcriptRevisionBySessionId: [String: Int] = [:]
    private var attachmentUploadTasks: [String: Task<ImageAttachment?, Never>] = [:]
    private var pathWatcher: NetworkPathWatcher?
    private var hasBootstrapped: Bool = false
    public var hasCompletedBootstrap: Bool { hasBootstrapped }
    private var isResyncing: Bool = false
    /// True while the app is fetching fresh state from the host: first load, a manual
    /// refresh, a background resync, or while the connection is being established.
    public var isSyncing: Bool {
        isBootstrapping || isRefreshing || isResyncing || connectionHealth == .connecting
    }

    // Session-list updates from the host are collected and applied together, so a burst of
    // them redraws the list once. See `enqueueListEvent`.
    @ObservationIgnored private var listEventInbox: [(event: SuperHarnessServerEvent, mode: ConnectionMode)] = []
    @ObservationIgnored private var stagedBootstrap: BootstrapPayload?
    /// True from the moment the app goes to the background until the foreground refresh has
    /// arrived. While true, list updates are held back instead of being drawn one by one.
    @ObservationIgnored private var isListFrozen = false
    @ObservationIgnored private var listFlushTask: Task<Void, Never>?
    @ObservationIgnored private var listThawTimeoutTask: Task<Void, Never>?
    @ObservationIgnored private var listInboxOldestAt: Date?
    @ObservationIgnored private var nextListFlushIsHydration = false
    static let listQuietInterval: TimeInterval = 0.06
    static let listMaxHold: TimeInterval = 1.0
    static let listThawTimeout: TimeInterval = 3.0
    static let listInboxLimit = 400
    private var isSceneActive: Bool = true
    private var mediaCache: [String: Data] = [:]
    private var mediaFailedKeys: Set<String> = []
    private var harnessOrderSyncTask: Task<Void, Never>?
    private let snapshotFileURL: URL?
    private var recentTranscriptOrder: [String] = []
    private var saveSnapshotTask: Task<Void, Never>?

    public init(
        client: SuperHarnessClientProtocol? = nil,
        keychain: KeychainStoreProtocol = KeychainStore(),
        defaults: UserDefaults = .standard,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        reconnectIntervalNs: UInt64 = 2_000_000_000,
        snapshotFileURL: URL? = nil
    ) {
        self.keychain = keychain
        self.defaults = defaults
        self.reconnectIntervalNs = reconnectIntervalNs

        var savedHost = defaults.string(forKey: StorageKey.hostURL) ?? "http://100.64.0.10:47890"
        var savedToken = keychain.loadToken(for: StorageKey.tokenAccount) ?? ""
        let savedModeRaw = defaults.string(forKey: StorageKey.connectionMode)
        var resolvedMode: ConnectionMode
        if let raw = savedModeRaw, let mode = ConnectionMode(rawValue: raw) {
            resolvedMode = mode
        } else {
            resolvedMode = .demo
        }

        var resolvedInitialRoute: DetailRoute? = nil
        // Optional environment overrides for Simulator / Xcode scheme pairing
        if client == nil {
            if let envHost = environment["SH_HOST_URL"]?.trimmingCharacters(in: .whitespacesAndNewlines),
               !envHost.isEmpty {
                savedHost = envHost
                defaults.set(envHost, forKey: StorageKey.hostURL)
            }
            if let envToken = environment["SH_BEARER_TOKEN"]?.trimmingCharacters(in: .whitespacesAndNewlines),
               !envToken.isEmpty {
                savedToken = envToken
                try? keychain.saveToken(envToken, for: StorageKey.tokenAccount)
            }
            if let envModeRaw = environment["SH_CONNECTION_MODE"]?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
               let envMode = ConnectionMode(rawValue: envModeRaw) {
                resolvedMode = envMode
                defaults.set(envMode.rawValue, forKey: StorageKey.connectionMode)
            }
            if let envFilter = environment["SH_INITIAL_HARNESS_FILTER"]?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
               let group = HarnessGroup(rawValue: envFilter) {
                self.selectedHarnessFilter = group
            }
            if let envRoute = environment["SH_INITIAL_ROUTE"]?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
               envRoute == "draft" {
                let envHarnessRaw = environment["SH_INITIAL_HARNESS"]?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
                let kind = StartHarnessKind(rawValue: envHarnessRaw) ?? .antigravity
                resolvedInitialRoute = .draft(kind)
            }
        }

        if let resolvedInitialRoute {
            self.detailRoute = resolvedInitialRoute
            self.pendingInitialRoute = resolvedInitialRoute
        } else if let initialSession = environment["SH_INITIAL_SESSION_ID"]?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !initialSession.isEmpty {
            self.pendingInitialSessionId = initialSession
            self.selectedSessionId = initialSession
            self.detailRoute = .session(initialSession)
        }

        self.hostURLString = savedHost
        self.bearerToken = savedToken
        self.connectionMode = resolvedMode
        self.dictationURLOverride = defaults.string(forKey: StorageKey.dictationURL) ?? ""
        if defaults.object(forKey: StorageKey.pushEnabled) != nil {
            self.pushNotificationsEnabled = defaults.bool(forKey: StorageKey.pushEnabled)
        }
        self.allowExtremeReasoning = defaults.bool(forKey: StorageKey.allowExtremeReasoning)
        if let raw = defaults.string(forKey: StorageKey.chatTextSize), let size = ChatTextSize(rawValue: raw) {
            self.chatTextSize = size
        }
        if let raw = defaults.string(forKey: StorageKey.chatDensity), let density = ChatDensity(rawValue: raw) {
            self.chatDensity = density
        }
        self.harnessOrder = HarnessOrder.normalized(defaults.stringArray(forKey: StorageKey.harnessOrder))
        let savedRelay = defaults.string(forKey: StorageKey.pushRelayURL)
        if savedRelay == "https://super-harness-push.lxe.workers.dev" || savedRelay?.isEmpty == true {
            self.pushRelayURL = PushNotificationCoordinator.defaultRelayURL
            defaults.set(PushNotificationCoordinator.defaultRelayURL, forKey: StorageKey.pushRelayURL)
        } else {
            self.pushRelayURL = savedRelay ?? PushNotificationCoordinator.defaultRelayURL
        }
        self.dictationTokenOverride = keychain.loadToken(for: StorageKey.dictationTokenAccount) ?? ""

        if let rawGroup = defaults.string(forKey: StorageKey.groupBy),
           let group = SidebarGroupBy(rawValue: rawGroup) {
            self.groupBy = group
        }

        if let injected = client {
            self.client = injected
            self.connectionHealth = resolvedMode == .demo ? .demo : .connected
        } else if resolvedMode == .live, let url = try? LiveSuperHarnessClient.normalizeBaseURL(savedHost) {
            self.client = LiveSuperHarnessClient(baseURL: url, token: savedToken)
            self.connectionHealth = .connecting
        } else {
            self.connectionMode = .demo
            self.client = MockSuperHarnessClient()
            self.connectionHealth = .demo
        }

        self.snapshotFileURL = snapshotFileURL ?? (client == nil ? MobileSnapshotDiskStore.defaultFileURL : nil)

        // Hydrate synchronously from on-disk Caches snapshot for instant zero-skeleton cold launch.
        // Always scrub stale running/isWorking flags from cached disk data so reopening after idle
        // never shows a ghost spinner before live bootstrap confirms what is actively working now.
        if self.connectionMode == .live,
           let snap = MobileSnapshotDiskStore.load(from: self.snapshotFileURL),
           snap.hostURL == self.hostURLString,
           !snap.sessions.isEmpty {
            self.harnesses = snap.harnesses
            self.sessions = snap.sessions.map { item in
                var copy = item
                if copy.status == .running { copy.status = .idle }
                return copy
            }
            self.folders = snap.state.folders
            self.settings = snap.state.settings
            self.usage = snap.usage
            self.catalog = snap.catalog
            self.recentTranscriptOrder = snap.recentTranscriptOrder
            var scrubbed: [String: SessionTranscriptResult] = [:]
            for (sid, tr) in snap.recentTranscripts {
                var copy = tr
                if var la = copy.liveActivity, la.isWorking {
                    la.isWorking = false
                    la.focus = nil
                    copy.liveActivity = la
                }
                scrubbed[sid] = copy
            }
            self.transcriptsBySessionId = scrubbed
            self.hasBootstrapped = true
        }

        // Only start NWPathMonitor in real app runtime (keep unit tests deterministic when client is injected)
        if client == nil {
            enableDraftPersistence()
            self.pathWatcher = NetworkPathWatcher { [weak self] in
                Task { @MainActor [weak self] in
                    self?.triggerImmediateReconnectIfOffline()
                }
            }
        }
    }

    public func persistSnapshotNow() {
        guard connectionMode == .live, let url = snapshotFileURL, !sessions.isEmpty else { return }
        let keepIds = Array(recentTranscriptOrder.suffix(10))
        var trimmedTranscripts: [String: SessionTranscriptResult] = [:]
        for sid in keepIds {
            if let tr = transcriptsBySessionId[sid] {
                trimmedTranscripts[sid] = tr
            }
        }
        let snap = CachedMobileSnapshot(
            hostURL: hostURLString,
            savedAt: Date().timeIntervalSince1970 * 1000.0,
            harnesses: harnesses,
            sessions: sessions,
            state: SuperHarnessState(settings: settings, folders: folders),
            usage: usage,
            catalog: catalog,
            recentTranscriptOrder: keepIds,
            recentTranscripts: trimmedTranscripts
        )
        MobileSnapshotDiskStore.save(snap, to: url, synchronous: true)
    }

    private func scheduleSnapshotPersist() {
        guard connectionMode == .live, let url = snapshotFileURL, !sessions.isEmpty else { return }
        saveSnapshotTask?.cancel()
        saveSnapshotTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(750))
            guard !Task.isCancelled, let self else { return }
            let keepIds = Array(self.recentTranscriptOrder.suffix(10))
            var trimmedTranscripts: [String: SessionTranscriptResult] = [:]
            for sid in keepIds {
                if let tr = self.transcriptsBySessionId[sid] {
                    trimmedTranscripts[sid] = tr
                }
            }
            let snap = CachedMobileSnapshot(
                hostURL: self.hostURLString,
                savedAt: Date().timeIntervalSince1970 * 1000.0,
                harnesses: self.harnesses,
                sessions: self.sessions,
                state: SuperHarnessState(settings: self.settings, folders: self.folders),
                usage: self.usage,
                catalog: self.catalog,
                recentTranscriptOrder: keepIds,
                recentTranscripts: trimmedTranscripts
            )
            MobileSnapshotDiskStore.save(snap, to: url)
        }
    }

    // MARK: - Debug: list publish log

    #if DEBUG
    /// With `SH_DEBUG_LIST_LOG=<file>` set, appends one line per session-list publish (and per
    /// list-affecting server event) so a foreground refresh can be checked for reshuffles.
    private static let listLogPath: String? = ProcessInfo.processInfo.environment["SH_DEBUG_LIST_LOG"]

    func debugListLog(_ message: @autoclosure () -> String) {
        guard let path = Self.listLogPath else { return }
        let line = String(format: "%.3f %@\n", Date().timeIntervalSince1970, message())
        guard let data = line.data(using: .utf8) else { return }
        if let handle = FileHandle(forWritingAtPath: path) {
            handle.seekToEndOfFile()
            handle.write(data)
            try? handle.close()
        } else {
            FileManager.default.createFile(atPath: path, contents: data)
        }
    }

    func debugStartListPublishLog() {
        guard Self.listLogPath != nil else { return }
        withObservationTracking {
            _ = sessions
            _ = harnessOrder
        } onChange: { [weak self] in
            Task { @MainActor [weak self] in
                guard let self else { return }
                let ids = self.sessions.filter { !$0.isMaster }.map(\.id)
                var hasher = Hasher()
                hasher.combine(ids)
                hasher.combine(self.harnessOrder)
                let head = ids.prefix(4).map { String($0.suffix(6)) }.joined(separator: ",")
                self.debugListLog("PUBLISH count=\(ids.count) order=\(String(UInt(bitPattern: hasher.finalize()), radix: 16).prefix(8)) head=\(head)")
                self.debugStartListPublishLog()
            }
        }
    }
    #endif

    // MARK: - Lifecycle

    public func bootstrap(quiet: Bool = false) async {
        #if DEBUG
        if !quiet { debugStartListPublishLog() }
        #endif
        #if DEBUG
        // UI checks for the error banner: report a realistic timeout shortly after launch.
        if !quiet, ProcessInfo.processInfo.environment["SH_DEBUG_SIMULATE_TIMEOUT"] != nil {
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 3_000_000_000)
                self?.reportError(URLError(.timedOut, userInfo: [
                    NSURLErrorFailingURLStringErrorKey: "http://100.64.0.10:47890/api/bootstrap",
                    NSLocalizedDescriptionKey: "The request timed out.",
                ]))
            }
        }
        #endif

        if !quiet || sessions.isEmpty {
            isBootstrapping = !quiet
        }
        if !quiet {
            lastError = nil
            if connectionMode == .live {
                connectionHealth = .connecting
            } else {
                connectionHealth = .demo
            }
        }

        do {
            let payload = try await client.fetchBootstrap()
            applyBootstrap(payload)
            hasBootstrapped = true
            clearStaleTranscriptActivity()
            scheduleSnapshotPersist()
            lastError = nil
            if connectionMode == .live {
                connectionHealth = .connected
            }
            stopAutoReconnectLoop()
            if !quiet || sseTask == nil {
                startEventStream()
            }
            if let sid = selectedSessionId {
                await client.watchSession(sessionId: sid, limit: transcriptLimit(for: sid))
            }
            startBackgroundPrefetch()
            Task { [weak self] in
                await self?.refreshDictationStatus()
            }
        } catch {
            reportError(error)
            if connectionMode == .live {
                connectionHealth = .offline(error.localizedDescription)
                if sseTask == nil {
                    startEventStream()
                }
                startAutoReconnectLoop()
            }
        }
        isBootstrapping = false
    }

    public func refresh() async {
        isRefreshing = true
        lastError = nil
        do {
            let payload = try await client.fetchBootstrap()
            applyBootstrap(payload)
            hasBootstrapped = true
            lastError = nil
            if let sid = selectedSessionId {
                await client.watchSession(sessionId: sid, limit: transcriptLimit(for: sid))
                await loadTranscript(for: sid)
            }
            if connectionMode == .live {
                connectionHealth = .connected
                stopAutoReconnectLoop()
                if sseTask == nil {
                    startEventStream()
                }
            }
        } catch {
            reportError(error)
            if connectionMode == .live {
                connectionHealth = .offline(error.localizedDescription)
                startAutoReconnectLoop()
            }
        }
        isRefreshing = false
    }

    /// Lightweight bidirectional resync triggered by SSE `resync_required`, reconnect, or returning to foreground.
    public func resync() async {
        guard !isResyncing, !isBootstrapping else { return }
        isResyncing = true
        defer { isResyncing = false }

        do {
            let payload = try await client.fetchBootstrap()
            applyBootstrap(payload, stageWhileFrozen: true)
            hasBootstrapped = true
            if isSceneActive { thawList() }
            if let sid = selectedSessionId {
                await client.watchSession(sessionId: sid, limit: transcriptLimit(for: sid))
                await loadTranscript(for: sid)
            }
            if connectionMode == .live {
                connectionHealth = .connected
                stopAutoReconnectLoop()
            }
            lastError = nil
        } catch {
            if isSceneActive { thawList() }
            if connectionMode == .live {
                connectionHealth = .offline(error.localizedDescription)
                startAutoReconnectLoop()
            }
        }
    }

    public func handleScenePhaseChanged(_ phase: ScenePhase) async {
        #if DEBUG
        debugListLog("PHASE \(phase)")
        #endif
        isSceneActive = (phase == .active)
        switch phase {
        case .active:
            await handleSceneBecameActive()
        case .background:
            flushDrafts()
            stopAutoReconnectLoop()
            freezeList()
        case .inactive:
            break
        @unknown default:
            break
        }
    }

    public func handleSceneBecameActive() async {
        isSceneActive = true
        startListThawTimeout()
        if connectionMode == .live {
            if !hasBootstrapped {
                thawList()
                await bootstrap(quiet: !sessions.isEmpty)
            } else {
                await resync()
                if sseTask == nil {
                    startEventStream()
                }
            }
        } else if hasBootstrapped {
            await resync()
        }
        // A refresh that was already running when the app came back thaws the list itself
        // when it finishes; the timeout covers one that never does.
        if !isResyncing { thawList() }
    }

    public func refreshUsage(force: Bool = true) async {
        isLoadingUsage = true
        defer { isLoadingUsage = false }
        do {
            if let snapshot = try await client.fetchUsage(force: force) {
                if usage != snapshot {
                    usage = snapshot
                }
            }
        } catch {
            reportError(error)
        }
    }

    public func stopEventStream() {
        sseTask?.cancel()
        sseTask = nil
        listFlushTask?.cancel()
        listFlushTask = nil
        listThawTimeoutTask?.cancel()
        listThawTimeoutTask = nil
        listEventInbox.removeAll()
        stagedBootstrap = nil
        listInboxOldestAt = nil
        isListFrozen = false
        stopAutoReconnectLoop()
        prefetchTask?.cancel()
        prefetchTask = nil
        for task in transcriptFallbackTasks.values {
            task.cancel()
        }
        transcriptFallbackTasks.removeAll()
    }

    private func startAutoReconnectLoop() {
        guard connectionMode == .live, isSceneActive, connectionHealth != .connected else { return }
        guard autoReconnectTask == nil else { return }

        let interval = reconnectIntervalNs
        autoReconnectTask = Task { [weak self] in
            defer { self?.autoReconnectTask = nil }
            while !Task.isCancelled {
                guard let self else { break }
                guard self.connectionMode == .live,
                      self.isSceneActive,
                      self.connectionHealth != .connected else {
                    break
                }
                try? await Task.sleep(nanoseconds: interval)
                guard !Task.isCancelled else { break }
                guard self.connectionMode == .live,
                      self.isSceneActive,
                      self.connectionHealth != .connected else {
                    break
                }
                await self.attemptAutoReconnect()
                if self.connectionHealth == .connected {
                    break
                }
            }
        }
    }

    private func stopAutoReconnectLoop() {
        autoReconnectTask?.cancel()
        autoReconnectTask = nil
    }

    private func attemptAutoReconnect() async {
        guard connectionMode == .live, isSceneActive, connectionHealth != .connected else { return }
        if !hasBootstrapped {
            await bootstrap(quiet: true)
        } else {
            await resync()
        }
    }

    public func triggerImmediateReconnectIfOffline() {
        guard connectionMode == .live, isSceneActive, connectionHealth != .connected else { return }
        startEventStream()
        Task { [weak self] in
            await self?.attemptAutoReconnect()
        }
        startAutoReconnectLoop()
    }

    private func startBackgroundPrefetch() {
        prefetchTask?.cancel()
        let candidates = prefetchCandidateSessionIds(limit: 5)
        guard !candidates.isEmpty else { return }
        let activeClient = client
        prefetchTask = Task(priority: .utility) { [weak self] in
            for sid in candidates {
                guard !Task.isCancelled else { break }
                let alreadyLoaded = await MainActor.run { self?.transcriptsBySessionId[sid] != nil }
                if alreadyLoaded { continue }
                if let result = try? await activeClient.fetchTranscript(sessionId: sid, limit: Self.initialTranscriptLimit) {
                    await MainActor.run {
                        guard let self, self.transcriptsBySessionId[sid] == nil else { return }
                        self.transcriptsBySessionId[sid] = result
                        if self.transcriptLimitsBySessionId[sid] == nil {
                            self.transcriptLimitsBySessionId[sid] = Self.initialTranscriptLimit
                        }
                    }
                }
            }
        }
    }

    public func prefetchCandidateSessionIds(limit: Int = 5) -> [String] {
        let nonMaster = sessions.filter { !$0.isMaster && !$0.hidden && $0.status != .archived }
        let sorted = nonMaster.sorted { a, b in
            if a.pinnedToTop != b.pinnedToTop { return a.pinnedToTop }
            if a.pinned != b.pinned { return a.pinned }
            return a.updatedAt > b.updatedAt
        }
        return Array(sorted.prefix(limit).map(\.id))
    }

    private func applyBootstrap(_ payload: BootstrapPayload, stageWhileFrozen: Bool = false) {
        if stageWhileFrozen, isListFrozen {
            stagedBootstrap = payload
            return
        }
        lastError = nil
        if let version = payload.protocolVersion, protocolVersion != version {
            protocolVersion = version
        }
        if let seq = payload.seq, lastBootstrapSeq != seq {
            lastBootstrapSeq = seq
        }
        if harnesses != payload.harnesses {
            harnesses = payload.harnesses
        }
        if sessions != payload.sessions {
            sessions = payload.sessions
        }
        if let working = payload.activeWorkingSessionIds {
            let nextWorking = Set(working)
            if hostWorkingSessionIds != nextWorking {
                hostWorkingSessionIds = nextWorking
            }
        }
        if let st = payload.state {
            let hostGroupChanged = settings.sidebarGroupBy != st.settings.sidebarGroupBy
            adoptHostHarnessOrder(st.settings)
            if settings != st.settings {
                settings = st.settings
            }
            if hostGroupChanged || (!hasBootstrapped && groupBy != st.settings.sidebarGroupBy) {
                if groupBy != st.settings.sidebarGroupBy {
                    groupBy = st.settings.sidebarGroupBy
                }
            }
            if folders != st.folders {
                folders = st.folders
            }
        }
        if let u = payload.usage, usage != u {
            usage = u
        }
        if let cat = payload.catalog, catalog != cat {
            catalog = cat
        }
        if let requested = pendingInitialSessionId {
            if requested.lowercased() == "first",
               let first = sessions.first(where: { !$0.isMaster }) ?? sessions.first {
                selectedSessionId = first.id
                pendingInitialSessionId = first.id
                detailRoute = .session(first.id)
            } else if let matched = sessions.first(where: { $0.id == requested })
                ?? sessions.first(where: { $0.id.hasPrefix(requested) || $0.nativeId == requested }) {
                selectedSessionId = matched.id
                pendingInitialSessionId = matched.id
                detailRoute = .session(matched.id)
            }
        } else if detailRoute == nil, pendingInitialRoute == nil, selectedSessionId == nil,
                  let first = sessions.first(where: { !$0.isMaster }) ?? sessions.first {
            selectedSessionId = first.id
        }
    }

    private func startEventStream() {
        sseTask?.cancel()
        let activeClient = client
        let mode = connectionMode
        sseTask = Task { [weak self] in
            let stream = activeClient.eventStream()
            for await event in stream {
                guard !Task.isCancelled else { break }
                self?.handleServerEvent(event, mode: mode)
            }
        }
    }

    // MARK: - Batched session-list updates

    /// Events that can change which rows the session list shows or their order.
    nonisolated static func isListEvent(_ event: SuperHarnessServerEvent) -> Bool {
        switch event {
        case .sessions, .sessionsDelta, .state, .activity: return true
        default: return false
        }
    }

    /// Holds a list event briefly so that events arriving together are applied in one pass.
    /// The host sends them in bursts after the app was away: it replays every list change the
    /// app missed. Applying each one separately made the sections visibly reshuffle through
    /// every intermediate order.
    private func enqueueListEvent(_ event: SuperHarnessServerEvent, mode: ConnectionMode) {
        listEventInbox.append((event, mode))
        if listEventInbox.count > Self.listInboxLimit {
            listEventInbox.removeFirst(listEventInbox.count - Self.listInboxLimit)
        }
        if listInboxOldestAt == nil { listInboxOldestAt = Date() }
        scheduleListFlush()
    }

    private func scheduleListFlush() {
        guard !isListFrozen else { return }
        listFlushTask?.cancel()
        let heldFor = listInboxOldestAt.map { Date().timeIntervalSince($0) } ?? 0
        if heldFor >= Self.listMaxHold {
            flushListUpdates()
            return
        }
        let delay = min(Self.listQuietInterval, Self.listMaxHold - heldFor)
        listFlushTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.flushListUpdates()
        }
    }

    /// Applies the staged refresh and every held event in one synchronous pass, which SwiftUI
    /// draws as a single update.
    func flushListUpdates() {
        listFlushTask?.cancel()
        listFlushTask = nil
        listInboxOldestAt = nil
        let bootstrapPayload = stagedBootstrap
        let events = listEventInbox
        stagedBootstrap = nil
        listEventInbox.removeAll(keepingCapacity: true)
        let isHydration = nextListFlushIsHydration
        nextListFlushIsHydration = false
        guard bootstrapPayload != nil || !events.isEmpty else { return }

        let apply = {
            if let bootstrapPayload { self.applyBootstrap(bootstrapPayload) }
            for item in events { self.applyServerEvent(item.event, mode: item.mode) }
        }
        if isHydration {
            // Returning from the background: show the final state without animating to it.
            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction, apply)
        } else {
            apply()
        }
    }

    private func freezeList() {
        guard !isListFrozen else { return }
        flushListUpdates()
        isListFrozen = true
    }

    private func thawList() {
        listThawTimeoutTask?.cancel()
        listThawTimeoutTask = nil
        guard isListFrozen else { return }
        isListFrozen = false
        nextListFlushIsHydration = true
        // Wait for the stream to go quiet (measured from now) so the replayed events that are
        // still arriving land in the same pass as the refresh.
        listInboxOldestAt = Date()
        scheduleListFlush()
    }

    private func startListThawTimeout() {
        guard isListFrozen else { return }
        listThawTimeoutTask?.cancel()
        listThawTimeoutTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(Self.listThawTimeout * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.thawList()
        }
    }

    func handleServerEvent(_ event: SuperHarnessServerEvent, mode: ConnectionMode) {
        if Self.isListEvent(event) {
            #if DEBUG
            debugListLog("EVENT \(String(describing: event).prefix(24))")
            #endif
            enqueueListEvent(event, mode: mode)
        } else {
            applyServerEvent(event, mode: mode)
        }
    }

    private func applyServerEvent(_ event: SuperHarnessServerEvent, mode: ConnectionMode) {
        #if DEBUG
        switch event {
        case .connected, .disconnected, .resyncRequired: debugListLog("EVENT \(String(describing: event).prefix(24))")
        default: break
        }
        #endif
        switch event {
        case .connected:
            let recoveringFromOffline: Bool = !hasBootstrapped || {
                if case .offline = connectionHealth { return true }
                return false
            }()
            let nextHealth: ConnectionHealth = mode == .demo ? .demo : .connected
            if connectionHealth != nextHealth {
                connectionHealth = nextHealth
            }
            if lastError != nil {
                lastError = nil
            }
            stopAutoReconnectLoop()
            if recoveringFromOffline && mode == .live {
                Task { [weak self] in
                    guard let self else { return }
                    if !self.hasBootstrapped {
                        await self.bootstrap(quiet: true)
                    } else {
                        await self.resync()
                    }
                }
            } else if let sid = selectedSessionId {
                let activeClient = client
                let activeLimit = transcriptLimit(for: sid)
                Task { await activeClient.watchSession(sessionId: sid, limit: activeLimit) }
            }
        case .disconnected(let reason):
            if mode == .live {
                connectionHealth = .offline(reason ?? "Disconnected")
                startAutoReconnectLoop()
            }
        case .resyncRequired:
            Task { [weak self] in
                await self?.resync()
            }
        case .sessions(let newHarnesses, let newSessions, let workingSessionIds):
            if let newHarnesses, harnesses != newHarnesses {
                harnesses = newHarnesses
            }
            if sessions != newSessions {
                sessions = newSessions
            }
            if let workingSessionIds {
                let nextWorking = Set(workingSessionIds)
                if hostWorkingSessionIds != nextWorking {
                    hostWorkingSessionIds = nextWorking
                }
            }
        case .sessionsDelta(let delta):
            applySessionsDelta(delta)
        case .activity(let workingSessionIds):
            let nextWorking = Set(workingSessionIds)
            if hostWorkingSessionIds != nextWorking {
                hostWorkingSessionIds = nextWorking
            }
            clearStaleTranscriptActivity()
        case .transcript(let tr):
            applyTranscriptUpdate(tr)
        case .usage(let snapshot):
            if usage != snapshot {
                usage = snapshot
            }
        case .state(let state):
            let hostGroupChanged = settings.sidebarGroupBy != state.settings.sidebarGroupBy
            adoptHostHarnessOrder(state.settings)
            if settings != state.settings {
                settings = state.settings
            }
            if hostGroupChanged && groupBy != state.settings.sidebarGroupBy {
                groupBy = state.settings.sidebarGroupBy
            }
            if folders != state.folders {
                folders = state.folders
            }
            scheduleSnapshotPersist()
        case .stream(let ev):
            applyStreamEvent(ev)
        }
    }

    /// Applies a Protocol v2 `sessions_delta` incrementally in place, mutating a local copy and
    /// assigning `sessions` once only when the list actually changed.
    /// Records a user-visible error, ignoring benign cancellations from reconnects or superseded requests.
    func reportError(_ error: Error) {
        if error is CancellationError { return }
        if let urlError = error as? URLError, urlError.code == .cancelled { return }
        if (error as NSError).domain == NSURLErrorDomain, (error as NSError).code == NSURLErrorCancelled { return }
        let message = error.localizedDescription
        let ns = error as NSError
        var parts = ["\(ns.domain) code \(ns.code)"]
        if let url = (ns.userInfo[NSURLErrorFailingURLErrorKey] as? URL)?.absoluteString
            ?? (ns.userInfo[NSURLErrorFailingURLStringErrorKey] as? String) {
            parts.append(url)
        }
        if let underlying = ns.userInfo[NSUnderlyingErrorKey] as? NSError {
            parts.append("underlying: \(underlying.domain) code \(underlying.code)")
        }
        if !(error is URLError), ns.domain != NSURLErrorDomain {
            parts.append(String(describing: error))
        }
        lastErrorTechnicalDetail = (message, parts.joined(separator: "\n"))
        lastError = message
    }

    public func applySessionsDelta(_ delta: SessionsDeltaEnvelope) {
        guard hasBootstrapped || !sessions.isEmpty else {
            if !isBootstrapping {
                Task { [weak self] in await self?.bootstrap() }
            }
            return
        }
        if let newHarnesses = delta.harnesses, harnesses != newHarnesses {
            harnesses = newHarnesses
        }
        if let working = delta.activeWorkingSessionIds {
            let nextWorking = Set(working)
            if hostWorkingSessionIds != nextWorking {
                hostWorkingSessionIds = nextWorking
            }
        }

        let removedSet = Set(delta.removedIds)
        var nextSessions = sessions
        var indexById: [String: Int] = Dictionary(
            uniqueKeysWithValues: nextSessions.enumerated().map { ($0.element.id, $0.offset) }
        )

        if !removedSet.isEmpty {
            nextSessions.removeAll { removedSet.contains($0.id) }
            indexById = Dictionary(
                uniqueKeysWithValues: nextSessions.enumerated().map { ($0.element.id, $0.offset) }
            )
        }

        for upsert in delta.upserts {
            if let existingIdx = indexById[upsert.id] {
                if nextSessions[existingIdx] != upsert {
                    nextSessions[existingIdx] = upsert
                }
            } else {
                indexById[upsert.id] = nextSessions.count
                nextSessions.append(upsert)
            }
        }

        if let order = delta.order, !order.isEmpty {
            let byId = Dictionary(uniqueKeysWithValues: nextSessions.map { ($0.id, $0) })
            var reordered: [UnifiedSession] = []
            reordered.reserveCapacity(nextSessions.count)
            var seen = Set<String>()
            for id in order {
                if let s = byId[id], seen.insert(id).inserted {
                    reordered.append(s)
                }
            }
            for s in nextSessions where !seen.contains(s.id) {
                reordered.append(s)
            }
            nextSessions = reordered
        }

        if sessions != nextSessions {
            sessions = nextSessions
        }
    }

    /// Live pushes carry a fixed-size tail window. When a new message arrives the oldest one falls
    /// out of that window; dropping it from the UI would shrink content above the reader and make
    /// the transcript jump. Keep already-loaded older messages that precede the incoming window.
    static func mergeSlidingWindow(existing: SessionTranscriptResult?, incoming: SessionTranscriptResult) -> SessionTranscriptResult {
        guard let existing, let firstIncoming = incoming.messages.first,
              let overlapIndex = existing.messages.firstIndex(where: { $0.id == firstIncoming.id }),
              overlapIndex > 0 else {
            return incoming
        }
        var merged = incoming
        merged.messages = Array(existing.messages[..<overlapIndex]) + incoming.messages
        merged.hasMore = existing.hasMore
        return merged
    }

    /// Deduplicates unchanged transcript pushes (e.g. idle WAL heartbeats) so SwiftUI avoids needless re-renders.
    @discardableResult
    public func applyTranscriptUpdate(_ tr: SessionTranscriptResult) -> Bool {
        let previousAssistantId = transcriptsBySessionId[tr.sessionId]?.messages.last(where: { $0.role == .assistant })?.id
        reconcilePendingOutgoing(for: tr.sessionId, transcript: tr)
        if let isWorking = tr.liveActivity?.isWorking {
            if isWorking {
                if !hostWorkingSessionIds.contains(tr.sessionId) {
                    hostWorkingSessionIds.insert(tr.sessionId)
                }
            } else if hostWorkingSessionIds.contains(tr.sessionId) {
                hostWorkingSessionIds.remove(tr.sessionId)
            }
        }
        if let existing = transcriptsBySessionId[tr.sessionId] {
            if existing.isEquivalentUpdate(to: tr) {
                return false
            }
            // Never let a stale out-of-order HTTP fetch regress the transcript backwards and hide a turn.
            if existing.sourceMtimeMs > 0,
               tr.sourceMtimeMs > 0,
               tr.sourceMtimeMs < existing.sourceMtimeMs,
               existing.sourceMtimeMs - tr.sourceMtimeMs < 30_000,
               tr.messages.count < existing.messages.count {
                return false
            }
        }
        transcriptRevisionBySessionId[tr.sessionId, default: 0] += 1
        transcriptFallbackTasks[tr.sessionId]?.cancel()
        transcriptFallbackTasks.removeValue(forKey: tr.sessionId)
        transcriptsBySessionId[tr.sessionId] = Self.mergeSlidingWindow(
            existing: transcriptsBySessionId[tr.sessionId],
            incoming: tr
        )
        if let newestAssistant = tr.messages.last(where: { $0.role == .assistant }),
           newestAssistant.id != previousAssistantId,
           !newestAssistant.blocks.isEmpty {
            PerfLogger.markFirstAssistantContentIfNeeded(sessionId: tr.sessionId)
        }
        if tr.liveActivity?.isWorking == false {
            clearStreamingState(for: tr.sessionId)
        }
        recentTranscriptOrder.removeAll { $0 == tr.sessionId }
        recentTranscriptOrder.append(tr.sessionId)
        if recentTranscriptOrder.count > 12 {
            recentTranscriptOrder.removeFirst(recentTranscriptOrder.count - 12)
        }
        scheduleSnapshotPersist()
        return true
    }

    private func clearStreamingState(for sessionId: String) {
        streamingMessagesBySessionId.removeValue(forKey: sessionId)
        streamBaselineBySessionId.removeValue(forKey: sessionId)
        streamingBlocksBySessionId.removeValue(forKey: sessionId)
        streamingTextBySessionId.removeValue(forKey: sessionId)
    }

    public static func captureStreamTurnBaseline(messages: [UnifiedMessage]) -> StreamTurnBaseline {
        var lastAssistantId: String? = nil
        var lastAssistantBlockCount = 0
        for m in messages where m.role == .assistant {
            lastAssistantId = m.id
            lastAssistantBlockCount = m.blocks.count
        }
        return StreamTurnBaseline(
            lastAssistantId: lastAssistantId,
            lastAssistantBlockCount: lastAssistantBlockCount
        )
    }

    /// Mirrors Desktop's `resolveVisibleStreamingOverlay` in `src/renderer/utils/transcriptCache.ts`:
    /// prevents live SSE stream previews from duplicating persisted assistant messages that LiveSync
    /// has already pushed for the active turn.
    public static func resolveVisibleStreamingOverlay(
        messages: [UnifiedMessage],
        baseline: StreamTurnBaseline?,
        streamingBlocks: [UnifiedBlock],
        streamingText: String
    ) -> VisibleStreamingOverlay {
        let lastMsg = messages.last
        let persistedActiveAssistant: Bool = {
            guard let lastMsg, lastMsg.role == .assistant else { return false }
            guard let baseline else { return true }
            return lastMsg.id != baseline.lastAssistantId || lastMsg.blocks.count > baseline.lastAssistantBlockCount
        }()

        if !persistedActiveAssistant || lastMsg == nil {
            return VisibleStreamingOverlay(
                showBlocks: streamingBlocks,
                showText: streamingText.trimmingCharacters(in: .whitespacesAndNewlines)
            )
        }

        func normalizeWs(_ s: String) -> String {
            s.components(separatedBy: .whitespacesAndNewlines)
                .filter { !$0.isEmpty }
                .joined(separator: " ")
        }

        let persistedText = lastMsg!.blocks.compactMap { block -> String? in
            if case .text(let t) = block { return t }
            return nil
        }.joined(separator: "\n\n")
        let persistedNorm = normalizeWs(persistedText)

        let trimmedStream = streamingText.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmedStream.isEmpty {
            return VisibleStreamingOverlay(showBlocks: [], showText: "")
        }

        // Split on paragraph breaks (2+ newlines) and drop any chunk already persisted.
        let rawChunks = trimmedStream.replacingOccurrences(of: "\r\n", with: "\n")
            .components(separatedBy: "\n\n")
        let remainingChunks = rawChunks
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { chunk in
                guard !chunk.isEmpty else { return false }
                let norm = normalizeWs(chunk)
                return !norm.isEmpty && !persistedNorm.contains(norm)
            }

        return VisibleStreamingOverlay(
            showBlocks: [],
            showText: remainingChunks.joined(separator: "\n\n")
        )
    }

    public func applyStreamEvent(_ ev: StreamEvent) {
        switch ev.kind {
        case .start:
            if !hostWorkingSessionIds.contains(ev.sessionId) {
                hostWorkingSessionIds.insert(ev.sessionId)
            }
            let persisted = transcriptsBySessionId[ev.sessionId]?.messages ?? []
            streamBaselineBySessionId[ev.sessionId] = Self.captureStreamTurnBaseline(messages: persisted)
            streamingBlocksBySessionId[ev.sessionId] = []
            streamingTextBySessionId[ev.sessionId] = ""
            streamingMessagesBySessionId[ev.sessionId] = UnifiedMessage(
                id: "stream-\(ev.runId)",
                role: .assistant,
                timestamp: Date().timeIntervalSince1970 * 1000.0,
                blocks: [],
                streaming: true
            )
        case .block:
            guard let block = ev.block else { return }
            PerfLogger.markFirstAssistantContentIfNeeded(sessionId: ev.sessionId)
            if streamBaselineBySessionId[ev.sessionId] == nil {
                let persisted = transcriptsBySessionId[ev.sessionId]?.messages ?? []
                streamBaselineBySessionId[ev.sessionId] = Self.captureStreamTurnBaseline(messages: persisted)
            }
            if streamingMessagesBySessionId[ev.sessionId] == nil {
                streamingMessagesBySessionId[ev.sessionId] = UnifiedMessage(
                    id: "stream-\(ev.runId)",
                    role: .assistant,
                    timestamp: Date().timeIntervalSince1970 * 1000.0,
                    blocks: [],
                    streaming: true
                )
            }
            if case .text(let text) = block {
                let existing = streamingTextBySessionId[ev.sessionId] ?? ""
                streamingTextBySessionId[ev.sessionId] = existing.isEmpty ? text : "\(existing)\n\n\(text)"
            } else {
                var blocks = streamingBlocksBySessionId[ev.sessionId] ?? []
                blocks.append(block)
                streamingBlocksBySessionId[ev.sessionId] = blocks
            }
            if var msg = streamingMessagesBySessionId[ev.sessionId] {
                msg.blocks.append(block)
                streamingMessagesBySessionId[ev.sessionId] = msg
            }
        case .delta:
            guard let chunk = ev.text else { return }
            if !chunk.isEmpty {
                PerfLogger.markFirstAssistantContentIfNeeded(sessionId: ev.sessionId)
            }
            if streamBaselineBySessionId[ev.sessionId] == nil {
                let persisted = transcriptsBySessionId[ev.sessionId]?.messages ?? []
                streamBaselineBySessionId[ev.sessionId] = Self.captureStreamTurnBaseline(messages: persisted)
            }
            let existingText = streamingTextBySessionId[ev.sessionId] ?? ""
            streamingTextBySessionId[ev.sessionId] = existingText + chunk
            var msg = streamingMessagesBySessionId[ev.sessionId] ?? UnifiedMessage(
                id: "stream-\(ev.runId)",
                role: .assistant,
                timestamp: Date().timeIntervalSince1970 * 1000.0,
                blocks: [],
                streaming: true
            )
            if case .text(let existing) = msg.blocks.last {
                msg.blocks[msg.blocks.count - 1] = .text(text: existing + chunk)
            } else {
                msg.blocks.append(.text(text: chunk))
            }
            streamingMessagesBySessionId[ev.sessionId] = msg
        case .done:
            clearStreamingState(for: ev.sessionId)
            hostWorkingSessionIds.remove(ev.sessionId)
            Task { await loadTranscript(for: ev.sessionId) }
        case .error:
            clearStreamingState(for: ev.sessionId)
            hostWorkingSessionIds.remove(ev.sessionId)
            if let err = ev.error {
                lastError = err
            }
        }
    }

    // MARK: - Computed Session Projections

    public var masterSession: UnifiedSession? {
        sessions.first(where: { $0.isMaster })
    }

    public var activeSession: UnifiedSession? {
        guard let sid = selectedSessionId else { return nil }
        return sessions.first(where: { $0.id == sid })
    }

    public var filteredNonMasterSessions: [UnifiedSession] {
        let q = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return sessions.filter { s in
            if s.isMaster { return false }
            if !showHidden && s.hidden { return false }
            if !showArchived && s.status == .archived { return false }
            if let filter = selectedHarnessFilter, s.harness.harnessGroup != filter {
                return false
            }
            if !q.isEmpty, !SessionRowFormatting.matches(s, query: q) { return false }
            return true
        }
    }

    public var pinnedToTopSessions: [UnifiedSession] {
        filteredNonMasterSessions
            .filter(\.pinnedToTop)
            .sorted { $0.updatedAt > $1.updatedAt }
    }

    private static func resolvedProjectSectionLabel(for session: UnifiedSession) -> String {
        if let sec = session.nativeSection?.trimmingCharacters(in: .whitespacesAndNewlines),
           !sec.isEmpty, sec != "Ungrouped" {
            return sec
        }
        let proj = session.projectName.trimmingCharacters(in: .whitespacesAndNewlines)
        let lower = proj.lowercased()
        let redundantHarnessNames: Set<String> = ["antigravity", "codex", "claude", "muse", "pi", "master", "super harness", ""]
        if !redundantHarnessNames.contains(lower) {
            return proj
        }
        return "Ungrouped"
    }

    private func buildNativeSections(for group: HarnessGroup, items: [UnifiedSession], isAllView: Bool) -> [SessionListSection] {
        var result: [SessionListSection] = []
        let nativePinned = items.filter(\.pinned).sorted { $0.updatedAt > $1.updatedAt }
        let unpinned = items.filter { !$0.pinned }

        if !nativePinned.isEmpty {
            result.append(
                SessionListSection(
                    id: "native-\(group.rawValue)-pinned",
                    title: isAllView ? group.title : "Pinned",
                    harnessGroup: group,
                    isProjectOrSectionGroup: false,
                    isHeadless: !isAllView,
                    sessions: nativePinned
                )
            )
        }

        let dict = Dictionary(grouping: unpinned) { Self.resolvedProjectSectionLabel(for: $0) }
        let orderedKeys = dict.keys.sorted { lhs, rhs in
            let lUngrouped = lhs == "Ungrouped"
            let rUngrouped = rhs == "Ungrouped"
            if lUngrouped != rUngrouped { return !lUngrouped }
            let lOrder = dict[lhs]?.compactMap(\.nativeSectionOrder).min() ?? 500
            let rOrder = dict[rhs]?.compactMap(\.nativeSectionOrder).min() ?? 500
            if lOrder != rOrder { return lOrder < rOrder }
            let lTime = dict[lhs]?.map(\.updatedAt).max() ?? 0
            let rTime = dict[rhs]?.map(\.updatedAt).max() ?? 0
            if lTime != rTime { return lTime > rTime }
            return lhs.localizedCaseInsensitiveCompare(rhs) == .orderedAscending
        }

        for key in orderedKeys {
            let sectionItems = (dict[key] ?? []).sorted { $0.updatedAt > $1.updatedAt }
            guard !sectionItems.isEmpty else { continue }
            let isProjectGroup = key != "Ungrouped"
            let displayTitle: String
            if isProjectGroup {
                displayTitle = key
            } else {
                displayTitle = isAllView ? group.title : "Conversations"
            }
            result.append(
                SessionListSection(
                    id: "native-\(group.rawValue)-\(key)",
                    title: displayTitle,
                    harnessGroup: group,
                    isProjectOrSectionGroup: isProjectGroup,
                    sessions: sectionItems
                )
            )
        }
        return result
    }

    public var groupedSections: [SessionListSection] {
        let regular = filteredNonMasterSessions.filter { !$0.pinnedToTop }
        let sorted = regular.sorted { a, b in
            if a.pinned != b.pinned { return a.pinned }
            return a.updatedAt > b.updatedAt
        }

        switch groupBy {
        case .recent:
            guard !sorted.isEmpty else { return [] }
            return [SessionListSection(id: "recent", title: "Recent", sessions: sorted)]

        case .harness:
            return harnessOrder.compactMap { group in
                let items = sorted.filter { $0.harness.harnessGroup == group }
                guard !items.isEmpty else { return nil }
                return SessionListSection(
                    id: "harness-\(group.rawValue)",
                    title: group.title,
                    harnessGroup: group,
                    sessions: items
                )
            }

        case .project:
            let dict = Dictionary(grouping: sorted) { Self.resolvedProjectSectionLabel(for: $0) }
            let orderedKeys = dict.keys.sorted { lhs, rhs in
                let lUngrouped = lhs == "Ungrouped"
                let rUngrouped = rhs == "Ungrouped"
                if lUngrouped != rUngrouped { return !lUngrouped }
                let lTime = dict[lhs]?.map(\.updatedAt).max() ?? 0
                let rTime = dict[rhs]?.map(\.updatedAt).max() ?? 0
                if lTime != rTime { return lTime > rTime }
                return lhs.localizedCaseInsensitiveCompare(rhs) == .orderedAscending
            }
            return orderedKeys.map { name in
                let items = (dict[name] ?? []).sorted { a, b in
                    if a.pinned != b.pinned { return a.pinned }
                    return a.updatedAt > b.updatedAt
                }
                return SessionListSection(
                    id: "project-\(name)",
                    title: name == "Ungrouped" ? "Conversations" : name,
                    isProjectOrSectionGroup: name != "Ungrouped",
                    sessions: items
                )
            }

        case .folders:
            var result: [SessionListSection] = []
            let orderedFolders = folders.sorted { $0.order < $1.order }
            let validFolderIds = Set(orderedFolders.map(\.id))
            let showEmptyFolders = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && selectedHarnessFilter == nil
            for folder in orderedFolders {
                let items = sorted.filter { $0.folderId == folder.id }
                if !items.isEmpty || showEmptyFolders {
                    result.append(
                        SessionListSection(
                            id: "folder-\(folder.id)",
                            title: folder.name,
                            accentHex: folder.color,
                            folderId: folder.id,
                            sessions: items
                        )
                    )
                }
            }
            let unfiled = sorted.filter { s in
                guard let fid = s.folderId else { return true }
                return !validFolderIds.contains(fid)
            }
            if !unfiled.isEmpty {
                result.append(SessionListSection(id: "folder-unfiled", title: "Unfiled", sessions: unfiled))
            }
            return result

        case .native:
            if let harnessFilter = selectedHarnessFilter {
                return buildNativeSections(for: harnessFilter, items: regular, isAllView: false)
            } else {
                return harnessOrder.flatMap { group -> [SessionListSection] in
                    let items = regular.filter { $0.harness.harnessGroup == group }
                    guard !items.isEmpty else { return [] }
                    return buildNativeSections(for: group, items: items, isAllView: true)
                }
            }
        }
    }

    public func activeCount(for group: HarnessGroup) -> Int {
        sessions.filter { !$0.isMaster && !$0.hidden && $0.status != .archived && $0.harness.harnessGroup == group }.count
    }

    public func isAnyWorking(for group: HarnessGroup) -> Bool {
        sessions.contains { !$0.isMaster && $0.harness.harnessGroup == group && isSessionBusy($0.id) }
    }

    public func isAnyWorking(in section: SessionListSection) -> Bool {
        section.sessions.contains { isSessionBusy($0.id) }
    }

    // MARK: - Transcript, Media & Messaging

    public func transcriptLimit(for sessionId: String) -> Int {
        transcriptLimitsBySessionId[sessionId] ?? Self.initialTranscriptLimit
    }

    public func selectSession(_ sessionId: String?) {
        selectedSessionId = sessionId
        if let sessionId {
            // Opening a thread reads it. The host learns this from the watch below; clear the
            // dot here too so it does not linger until the next session update.
            if sessions.first(where: { $0.id == sessionId })?.isUnread == true {
                mutateSession(sessionId) { $0.unread = false }
            }
            detailRoute = .session(sessionId)
        } else if case .session = detailRoute {
            detailRoute = nil
        }
        let activeClient = client
        let activeLimit = sessionId.map { transcriptLimit(for: $0) } ?? Self.initialTranscriptLimit
        Task {
            await activeClient.watchSession(sessionId: sessionId, limit: activeLimit)
            if let sessionId {
                await loadTranscript(for: sessionId)
            }
        }
    }

    public func clearDetailRoute() {
        selectedSessionId = nil
        detailRoute = nil
        let activeClient = client
        Task {
            await activeClient.watchSession(sessionId: nil, limit: Self.initialTranscriptLimit)
        }
    }

    /// Resolves cross-harness session links (`conversation://`, `session://`, `codex://`, `claude://`, `muse://`, etc.)
    /// against loaded sessions and navigates directly to the target thread.
    @discardableResult
    public func openSessionLink(_ url: URL) -> Bool {
        guard let target = SessionLinkResolver.resolve(url.absoluteString, in: sessions) else {
            return false
        }
        isUsageSheetPresented = false
        isHostSettingsSheetPresented = false
        lightboxPayload = nil
        selectSession(target.id)
        return true
    }

    public func loadMediaData(path: String, maxWidth: Int? = nil) async -> Data? {
        guard !path.isEmpty else { return nil }
        // If full-resolution image is already cached locally, reuse it immediately.
        if let fullCached = mediaCache[path] {
            return fullCached
        }
        let cacheKey = maxWidth.map { "w\($0):\(path)" } ?? path
        if let cached = mediaCache[cacheKey] {
            return cached
        }
        // After a failed or unusable response, the next attempt goes to the host and skips the
        // HTTP cache. Only bytes that can be shown are kept, so a bad first answer is never
        // replayed for the rest of the app's life.
        let retrying = mediaFailedKeys.contains(cacheKey)
        guard let data = try? await client.fetchMedia(path: path, maxWidth: maxWidth, ignoreLocalCache: retrying),
              MediaDataValidator.isUsable(data, forPath: path) else {
            mediaFailedKeys.insert(cacheKey)
            return nil
        }
        mediaFailedKeys.remove(cacheKey)
        mediaCache[cacheKey] = data
        return data
    }


    // MARK: - Sidebar Grouping & Folder Management

    public static let defaultFolderColors: [String] = [
        "#60A5FA",
        "#22C55E",
        "#D97757",
        "#A855F7",
        "#F59E0B",
        "#EC4899",
    ]

    /// Takes the host's harness order when it sends one, unless a local reorder is still on its way there.
    private func adoptHostHarnessOrder(_ hostSettings: SuperHarnessSettings) {
        guard harnessOrderSyncTask == nil, let raw = hostSettings.harnessOrder else { return }
        let next = HarnessOrder.normalized(raw)
        if next != harnessOrder {
            harnessOrder = next
            defaults.set(next.map(\.rawValue), forKey: StorageKey.harnessOrder)
        }
    }

    /// Moves a harness to another harness's position (called while a gauge is dragged). The
    /// order is saved on the phone at once and sent to the host shortly after the last move.
    public func moveHarness(_ dragged: HarnessGroup, onto target: HarnessGroup) {
        let next = HarnessOrder.moving(dragged, onto: target, in: harnessOrder)
        guard next != harnessOrder else { return }
        harnessOrder = next
        let names = next.map(\.rawValue)
        defaults.set(names, forKey: StorageKey.harnessOrder)
        settings.harnessOrder = names
        harnessOrderSyncTask?.cancel()
        harnessOrderSyncTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 900_000_000)
            guard !Task.isCancelled, let self else { return }
            // Hosts that do not know the field yet ignore it; the order still holds on this phone.
            _ = try? await self.client.updateSettings(harnessOrder: names)
            if !Task.isCancelled { self.harnessOrderSyncTask = nil }
        }
    }

    public func setGroupBy(_ mode: SidebarGroupBy) async {
        groupBy = mode
        settings.sidebarGroupBy = mode
        scheduleSnapshotPersist()
        do {
            if let updated = try await client.updateSettings(sidebarGroupBy: mode) {
                settings = updated
            }
        } catch {
            // Older hosts without /api/settings keep local grouping cleanly.
        }
    }

    @discardableResult
    public func createFolder(name: String, color: String = "#60A5FA") async -> SessionFolder? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if let existing = folders.first(where: { $0.name.lowercased() == trimmed.lowercased() }) {
            return existing
        }
        let newId = "folder-\(UUID().uuidString.prefix(8).lowercased())"
        let folder = SessionFolder(id: newId, name: trimmed, color: color, order: folders.count)
        folders.append(folder)
        scheduleSnapshotPersist()
        let action = OrganizeAction(
            type: .createFolder,
            folderId: newId,
            folderName: trimmed,
            folderColor: color
        )
        do {
            let res = try await client.organize(actions: [action])
            if let nextFolders = res.folders {
                folders = nextFolders
            }
            if let st = res.state {
                settings = st.settings
                folders = st.folders
            }
            scheduleSnapshotPersist()
            return folders.first(where: { $0.id == newId || $0.name.lowercased() == trimmed.lowercased() }) ?? folder
        } catch {
            reportError(error)
            return nil
        }
    }

    public func renameFolder(id: String, name: String) async {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        if let idx = folders.firstIndex(where: { $0.id == id }) {
            folders[idx].name = trimmed
        }
        scheduleSnapshotPersist()
        let action = OrganizeAction(type: .renameFolder, folderId: id, folderName: trimmed)
        do {
            let res = try await client.organize(actions: [action])
            if let nextFolders = res.folders {
                folders = nextFolders
            }
            scheduleSnapshotPersist()
        } catch {
            reportError(error)
        }
    }

    public func deleteFolder(id: String) async {
        folders.removeAll { $0.id == id }
        for idx in sessions.indices where sessions[idx].folderId == id {
            sessions[idx].folderId = nil
        }
        scheduleSnapshotPersist()
        let action = OrganizeAction(type: .deleteFolder, folderId: id)
        do {
            let res = try await client.organize(actions: [action])
            if let nextFolders = res.folders {
                folders = nextFolders
            }
            for idx in sessions.indices where sessions[idx].folderId == id {
                sessions[idx].folderId = nil
            }
            scheduleSnapshotPersist()
        } catch {
            reportError(error)
        }
    }

    /// Marks a session read or unread here at once and on the host, which shares it with other clients.
    public func setUnread(sessionId: String, unread: Bool) async {
        mutateSession(sessionId) { item in
            item.unread = unread
        }
        do {
            try await client.setSessionUnread(sessionId: sessionId, unread: unread)
        } catch SuperHarnessAPIError.notFound {
            // Host predates /api/sessions/read; the local mark still applies until the next refresh.
        } catch {
            reportError(error)
        }
    }

    public func assignFolder(sessionId: String, folderId: String?) async {
        mutateSession(sessionId) { item in
            item.folderId = folderId
        }
        scheduleSnapshotPersist()
        let action = OrganizeAction(type: .assignFolder, folderId: folderId, sessionId: sessionId)
        do {
            let res = try await client.organize(actions: [action])
            if let nextFolders = res.folders {
                folders = nextFolders
            }
            scheduleSnapshotPersist()
        } catch {
            reportError(error)
        }
    }

    public func createFolderAndAssign(sessionId: String, name: String, color: String = "#60A5FA") async {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let targetId: String
        var actions: [OrganizeAction] = []
        if let existing = folders.first(where: { $0.name.lowercased() == trimmed.lowercased() }) {
            targetId = existing.id
        } else {
            let newId = "folder-\(UUID().uuidString.prefix(8).lowercased())"
            targetId = newId
            folders.append(SessionFolder(id: newId, name: trimmed, color: color, order: folders.count))
            actions.append(OrganizeAction(type: .createFolder, folderId: newId, folderName: trimmed, folderColor: color))
        }
        mutateSession(sessionId) { item in
            item.folderId = targetId
        }
        actions.append(OrganizeAction(type: .assignFolder, folderId: targetId, sessionId: sessionId))
        scheduleSnapshotPersist()
        do {
            let res = try await client.organize(actions: actions)
            if let nextFolders = res.folders {
                folders = nextFolders
                if let canonical = nextFolders.first(where: { $0.id == targetId || $0.name.lowercased() == trimmed.lowercased() }),
                   canonical.id != targetId {
                    mutateSession(sessionId) { item in
                        item.folderId = canonical.id
                    }
                }
            }
            scheduleSnapshotPersist()
        } catch {
            reportError(error)
        }
    }

    public func renameSession(_ session: UnifiedSession, title: String) async {
        let trimmed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        mutateSession(session.id) { item in
            item.customTitle = trimmed.isEmpty ? nil : trimmed
        }
        let action = OrganizeAction(
            type: .renameSession,
            sessionId: session.id,
            title: trimmed
        )
        do {
            _ = try await client.organize(actions: [action])
            mutateSession(session.id) { item in
                item.customTitle = trimmed.isEmpty ? nil : trimmed
            }
        } catch {
            reportError(error)
        }
    }

    public func loadTranscript(for sessionId: String, limit: Int? = nil) async {
        let resolvedLimit = limit ?? transcriptLimit(for: sessionId)
        transcriptLimitsBySessionId[sessionId] = resolvedLimit
        loadingTranscriptSessionIds.insert(sessionId)
        defer { loadingTranscriptSessionIds.remove(sessionId) }
        do {
            let result = try await client.fetchTranscript(sessionId: sessionId, limit: resolvedLimit)
            _ = applyTranscriptUpdate(result)
        } catch {
            reportError(error)
        }
    }

    public func loadEarlierMessages(for sessionId: String) async {
        let current = transcriptLimit(for: sessionId)
        let nextLimit = min(Self.maxTranscriptLimit, current + Self.earlierTranscriptStep)
        guard nextLimit > current || transcriptsBySessionId[sessionId]?.hasMore == true else { return }
        transcriptLimitsBySessionId[sessionId] = nextLimit
        await loadTranscript(for: sessionId, limit: nextLimit)
        await client.watchSession(sessionId: sessionId, limit: nextLimit)
    }

    public func messages(for sessionId: String) -> [UnifiedMessage] {
        let persisted = transcriptsBySessionId[sessionId]?.messages ?? []
        var list = persisted
        if let pending = pendingOutgoingBySessionId[sessionId], !pending.isEmpty {
            // Never render a transient `mobile-opt-*` alongside an active local pending bubble,
            // and never render a pending bubble that already matches a newly persisted user message.
            let pendingNorms = Set(pending.map { Self.normalizeForDedup($0.text) }.filter { !$0.isEmpty })
            list.removeAll { msg in
                guard msg.id.hasPrefix("mobile-opt-") else { return false }
                let norm = Self.normalizeForDedup(Self.extractPlainText(from: msg))
                return pendingNorms.contains(norm)
            }
            let visiblePending = pending.filter { item in
                !Self.pendingMatchesPersistedTranscript(item, messages: persisted)
            }
            list.append(contentsOf: visiblePending.map { $0.asUnifiedMessage() })
        }
        if let streaming = streamingMessagesBySessionId[sessionId] {
            let overlay = Self.resolveVisibleStreamingOverlay(
                messages: persisted,
                baseline: streamBaselineBySessionId[sessionId],
                streamingBlocks: streamingBlocksBySessionId[sessionId] ?? [],
                streamingText: streamingTextBySessionId[sessionId] ?? ""
            )
            var visibleBlocks = overlay.showBlocks
            if !overlay.showText.isEmpty {
                visibleBlocks.append(.text(text: overlay.showText))
            }
            if !visibleBlocks.isEmpty {
                var visibleStream = streaming
                visibleStream.blocks = visibleBlocks
                list.append(visibleStream)
            }
        }
        return list
    }

    public func pendingDeliveryState(for sessionId: String, messageId: String) -> PendingOutgoingMessage.DeliveryState? {
        guard messageId.hasPrefix("pending-"),
              let pendingList = pendingOutgoingBySessionId[sessionId] else {
            return nil
        }
        return pendingList.first(where: { $0.messageId == messageId })?.state
    }

    public func liveActivity(for sessionId: String) -> LiveActivityState? {
        transcriptsBySessionId[sessionId]?.liveActivity
    }

    /// Returns the exact active tint shown by the harness's radial gauge, including
    /// warning (>=80%) and danger (>=95%) overrides, so activity orbs always match the gauge.
    public func gaugeTint(for group: HarnessGroup) -> Color {
        let summary = usage?[group]
        let barPct = summary?.barPercent ?? UsageMetrics.pickHeroWindow(summary?.windows ?? []).hero?.usedPercent
        return SHRadialGauge<EmptyView>.resolvedTint(
            base: SHColor.harness(group),
            value: barPct,
            estimated: summary?.barIsEstimated ?? false
        )
    }

    public func gaugeTint(for harness: HarnessKind) -> Color {
        guard let group = harness.harnessGroup else {
            return SHColor.harness(harness)
        }
        return gaugeTint(for: group)
    }

    public func isSessionBusy(_ sessionId: String) -> Bool {
        if streamingMessagesBySessionId[sessionId] != nil { return true }
        if pendingOutgoingBySessionId[sessionId]?.contains(where: { $0.state == .sending }) == true { return true }
        if hostWorkingSessionIds.contains(sessionId) { return true }
        // Only trust cached transcript liveActivity for the actively watched session;
        // unwatched sessions do not receive live transcript pushes so their cached
        // liveActivity.isWorking can remain stale after the agent goes idle.
        if selectedSessionId == sessionId,
           transcriptsBySessionId[sessionId]?.liveActivity?.isWorking == true {
            return true
        }
        if let session = sessions.first(where: { $0.id == sessionId }), !session.isMaster, session.isWorking {
            return true
        }
        return false
    }

    /// Clears stale `liveActivity.isWorking` on cached transcripts when the host explicitly
    /// reports the session is no longer working (prevents frozen spinners on unwatched rows
    /// and when re-opening a previously running thread).
    private func clearStaleTranscriptActivity() {
        let workingByStatus = Set(sessions.filter { !$0.isMaster && $0.isWorking }.map(\.id))
        let activeIds = hostWorkingSessionIds.union(workingByStatus)
        for (sid, tr) in transcriptsBySessionId {
            guard tr.liveActivity?.isWorking == true else { continue }
            guard !activeIds.contains(sid),
                  streamingMessagesBySessionId[sid] == nil,
                  pendingOutgoingBySessionId[sid]?.contains(where: { $0.state == .sending }) != true else {
                continue
            }
            var updated = tr
            if var la = updated.liveActivity {
                la.isWorking = false
                la.focus = nil
                updated.liveActivity = la
            }
            transcriptsBySessionId[sid] = updated
        }
    }

    /// Synchronously appends an optimistic user message, clears the draft, and dispatches
    /// the network send in the background so the bubble appears on the exact tap frame.
    @discardableResult
    public func submitMessage(
        for sessionId: String,
        text: String? = nil,
        attachments: [ImageAttachment]? = nil,
        mode: SendMode = .steer
    ) -> PendingOutgoingMessage? {
        guard let pending = enqueuePendingMessage(for: sessionId, text: text, attachments: attachments, mode: mode) else {
            return nil
        }
        Task { [weak self] in
            await self?.dispatchPendingMessage(sessionId: sessionId, pending: pending)
        }
        return pending
    }

    /// Appends the optimistic pending user bubble synchronously before any `await`, clears the draft,
    /// and dispatches the send without blocking on a redundant full transcript reload.
    public func sendMessage(
        for sessionId: String,
        text: String? = nil,
        attachments: [ImageAttachment]? = nil,
        mode: SendMode = .steer
    ) async {
        guard let pending = enqueuePendingMessage(for: sessionId, text: text, attachments: attachments, mode: mode) else {
            return
        }
        await dispatchPendingMessage(sessionId: sessionId, pending: pending)
    }

    public func retryPendingMessage(for sessionId: String, messageId: String) {
        guard var list = pendingOutgoingBySessionId[sessionId],
              let idx = list.firstIndex(where: { $0.messageId == messageId }) else {
            return
        }
        list[idx].state = .sending
        let pending = list[idx]
        pendingOutgoingBySessionId[sessionId] = list
        Task { [weak self] in
            await self?.dispatchPendingMessage(sessionId: sessionId, pending: pending)
        }
    }

    private func enqueuePendingMessage(
        for sessionId: String,
        text: String?,
        attachments: [ImageAttachment]?,
        mode: SendMode = .steer
    ) -> PendingOutgoingMessage? {
        let messageText = (text ?? draftInputs[sessionId] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let media = attachments ?? draftAttachments[sessionId] ?? []
        guard !messageText.isEmpty || !media.isEmpty else { return nil }

        if text == nil {
            draftInputs[sessionId] = ""
        }
        if attachments == nil {
            draftAttachments[sessionId] = []
        }

        let baselineId = transcriptsBySessionId[sessionId]?.messages
            .last(where: { !$0.id.hasPrefix("mobile-opt-") && !$0.id.hasPrefix("pending-") })?.id
        let pending = PendingOutgoingMessage(
            text: messageText,
            attachments: media,
            createdAt: Date().timeIntervalSince1970 * 1000.0,
            mode: mode,
            state: .sending,
            baselineLastPersistedId: baselineId
        )
        PerfLogger.markSendTapped(sessionId: sessionId)
        var list = pendingOutgoingBySessionId[sessionId] ?? []
        list.append(pending)
        pendingOutgoingBySessionId[sessionId] = list
        return pending
    }

    private func dispatchPendingMessage(sessionId: String, pending: PendingOutgoingMessage) async {
        let revisionBeforeSend = transcriptRevisionBySessionId[sessionId] ?? 0
        var resolvedAttachments: [ImageAttachment] = []
        resolvedAttachments.reserveCapacity(pending.attachments.count)
        for att in pending.attachments {
            if att.path.isEmpty, let uploadTask = attachmentUploadTasks[att.id] {
                if let uploaded = await uploadTask.value {
                    resolvedAttachments.append(uploaded)
                } else {
                    resolvedAttachments.append(att)
                }
            } else {
                resolvedAttachments.append(att)
            }
        }
        do {
            let result = try await client.sendMessage(
                sessionId: sessionId,
                message: pending.text,
                attachments: resolvedAttachments,
                mode: pending.mode
            )
            if result.ok {
                updatePendingState(sessionId: sessionId, pendingId: pending.id, to: .sent)
                if connectionMode == .live && (transcriptRevisionBySessionId[sessionId] ?? 0) == revisionBeforeSend {
                    scheduleFallbackTranscriptLoad(for: sessionId, baselineRevision: revisionBeforeSend)
                }
            } else {
                let err = result.error ?? "Message not delivered"
                updatePendingState(sessionId: sessionId, pendingId: pending.id, to: .failed(err))
                lastError = err
            }
        } catch {
            let err = error.localizedDescription
            updatePendingState(sessionId: sessionId, pendingId: pending.id, to: .failed(err))
            lastError = err
        }
    }

    private func updatePendingState(
        sessionId: String,
        pendingId: String,
        to newState: PendingOutgoingMessage.DeliveryState
    ) {
        guard var list = pendingOutgoingBySessionId[sessionId],
              let idx = list.firstIndex(where: { $0.id == pendingId }) else {
            return
        }
        list[idx].state = newState
        pendingOutgoingBySessionId[sessionId] = list
    }

    private func scheduleFallbackTranscriptLoad(for sessionId: String, baselineRevision: Int) {
        transcriptFallbackTasks[sessionId]?.cancel()
        transcriptFallbackTasks[sessionId] = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            guard !Task.isCancelled, let self else { return }
            self.transcriptFallbackTasks.removeValue(forKey: sessionId)
            guard (self.transcriptRevisionBySessionId[sessionId] ?? 0) == baselineRevision else { return }
            await self.loadTranscript(for: sessionId)
        }
    }

    /// Collapse all whitespace runs so line-wrapping or `\r\n` differences (e.g. Claude tmux)
    /// never prevent an optimistic user bubble from reconciling with the persisted transcript.
    private static func normalizeForDedup(_ text: String) -> String {
        text.components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }

    private static func extractPlainText(from msg: UnifiedMessage) -> String {
        msg.blocks.compactMap { block -> String? in
            if case .text(let t) = block { return t }
            return nil
        }.joined(separator: "\n")
    }

    private static func pendingMatchesPersistedTranscript(
        _ pending: PendingOutgoingMessage,
        messages: [UnifiedMessage]
    ) -> Bool {
        let normPending = normalizeForDedup(pending.text)

        // Prefer structural ordering after the baseline message captured when the user hit Send.
        // This is 100% immune to clock skew between iPhone and Linux/macOS hosts.
        let candidates: [UnifiedMessage]
        if let baselineId = pending.baselineLastPersistedId,
           let baselineIdx = messages.lastIndex(where: { $0.id == baselineId }) {
            let afterBaseline = messages[(baselineIdx + 1)...]
            candidates = afterBaseline.filter { $0.role == .user && !$0.id.hasPrefix("mobile-opt-") }
        } else {
            let persistedUsers = messages.filter { $0.role == .user && !$0.id.hasPrefix("mobile-opt-") }
            let lastPersistedId = messages.last(where: { !$0.id.hasPrefix("mobile-opt-") })?.id
            candidates = Array(persistedUsers.suffix(6)).filter { msg in
                msg.id == lastPersistedId || msg.timestamp == 0 || msg.timestamp >= pending.createdAt - 60_000
            }
        }

        return candidates.contains { msg in
            let normMsg = normalizeForDedup(extractPlainText(from: msg))
            if !normPending.isEmpty {
                return normMsg == normPending || normMsg.contains(normPending)
            }
            if !pending.attachments.isEmpty {
                return msg.blocks.contains { block in
                    if case .image = block { return true }
                    return false
                }
            }
            return false
        }
    }

    public func reconcilePendingOutgoing(
        for sessionId: String,
        transcript: SessionTranscriptResult,
        nowMs: Double = Date().timeIntervalSince1970 * 1000.0
    ) {
        guard let current = pendingOutgoingBySessionId[sessionId], !current.isEmpty else { return }

        let remaining = current.filter { pending in
            // Expire sent pending messages after 90s even if host never echoed them back
            if pending.state == .sent && (nowMs - pending.createdAt) >= 90_000 {
                return false
            }

            let matchedInTranscript = Self.pendingMatchesPersistedTranscript(
                pending,
                messages: transcript.messages
            )
            if matchedInTranscript {
                PerfLogger.markFirstTranscriptPushWithUserMessage(sessionId: sessionId, pendingId: pending.id)
            }
            return !matchedInTranscript
        }

        if remaining != current {
            if remaining.isEmpty {
                pendingOutgoingBySessionId.removeValue(forKey: sessionId)
            } else {
                pendingOutgoingBySessionId[sessionId] = remaining
            }
        }
    }

    public func abortRun(for sessionId: String) async {
        do {
            let ok = try await client.abortRun(sessionId: sessionId)
            if ok {
                streamingMessagesBySessionId.removeValue(forKey: sessionId)
                hostWorkingSessionIds.remove(sessionId)
                if var tr = transcriptsBySessionId[sessionId] {
                    tr.liveActivity?.isWorking = false
                    transcriptsBySessionId[sessionId] = tr
                }
                if let idx = sessions.firstIndex(where: { $0.id == sessionId }), sessions[idx].status == .running {
                    sessions[idx].status = .idle
                }
            }
        } catch {
            reportError(error)
        }
    }

    public func addAttachment(for sessionId: String, jpegData: Data, filename: String) async {
        await addFileAttachment(
            for: sessionId,
            data: jpegData,
            mimeType: "image/jpeg",
            filename: filename,
            previewImageData: jpegData
        )
    }

    /// Immediately attaches any image, video, or file to the composer with an instant local preview
    /// while uploading raw binary bytes to `/api/attachments` in the background.
    public func addFileAttachment(
        for sessionId: String,
        data: Data,
        mimeType: String,
        filename: String,
        previewImageData: Data? = nil
    ) async {
        let localId = UUID().uuidString
        let thumbDataUrl: String? = await Task.detached(priority: .userInitiated) {
            guard let imgBytes = previewImageData else { return nil }
            let thumb = ComposerView.downscaledJPEG(from: imgBytes, maxDimension: 220, quality: 0.72) ?? imgBytes
            return "data:image/jpeg;base64,\(thumb.base64EncodedString())"
        }.value

        let optimistic = ImageAttachment(
            id: localId,
            name: filename,
            path: "",
            mimeType: mimeType,
            previewDataUrl: thumbDataUrl,
            sizeBytes: data.count
        )
        var current = draftAttachments[sessionId] ?? []
        current.append(optimistic)
        draftAttachments[sessionId] = current
        uploadingAttachmentIds.insert(localId)

        let activeClient = client
        let uploadTask = Task<ImageAttachment?, Never> { [weak self] in
            defer {
                Task { @MainActor in
                    self?.uploadingAttachmentIds.remove(localId)
                    self?.attachmentUploadTasks.removeValue(forKey: localId)
                }
            }
            do {
                let uploaded = try await activeClient.uploadAttachmentData(data, mimeType: mimeType, filename: filename)
                let merged = ImageAttachment(
                    id: uploaded.id,
                    name: uploaded.name,
                    path: uploaded.path,
                    mimeType: uploaded.mimeType.isEmpty ? mimeType : uploaded.mimeType,
                    previewDataUrl: thumbDataUrl,
                    sizeBytes: uploaded.sizeBytes ?? data.count
                )
                if !uploaded.path.isEmpty, mimeType.lowercased().hasPrefix("image/") {
                    await MainActor.run {
                        self?.mediaCache[uploaded.path] = data
                        #if canImport(UIKit)
                        SHMediaImageCache.shared.store(data: data, for: uploaded.path)
                        #endif
                    }
                }
                await MainActor.run {
                    guard let self, var list = self.draftAttachments[sessionId],
                          let idx = list.firstIndex(where: { $0.id == localId }) else { return }
                    list[idx] = merged
                    self.draftAttachments[sessionId] = list
                }
                return merged
            } catch {
                await MainActor.run {
                    self?.reportError(error)
                }
                return optimistic
            }
        }
        attachmentUploadTasks[localId] = uploadTask
    }

    public func setPushNotificationsEnabled(_ enabled: Bool) {
        pushNotificationsEnabled = enabled
        defaults.set(enabled, forKey: StorageKey.pushEnabled)
        Task {
            if enabled {
                _ = await PushNotificationCoordinator.shared.requestAuthorizationAndRegister()
            }
            PushNotificationCoordinator.shared.syncCurrentTokenIfAvailable()
        }
    }

    public func registerPushDeviceOnHost(rid: String, relayUrl: String, enabled: Bool) async {
        _ = await client.registerPushDevice(rid: rid, relayUrl: relayUrl, enabled: enabled)
    }

    public func sendTestPushNotification() async -> Bool {
        do {
            return try await client.sendTestPush()
        } catch {
            reportError(error)
            return false
        }
    }

    public func removeAttachment(for sessionId: String, attachmentId: String) {
        attachmentUploadTasks[attachmentId]?.cancel()
        attachmentUploadTasks.removeValue(forKey: attachmentId)
        uploadingAttachmentIds.remove(attachmentId)
        draftAttachments[sessionId]?.removeAll(where: { $0.id == attachmentId })
    }

    // MARK: - Session Organization

    public func togglePin(_ session: UnifiedSession) async {
        let nextPinned = !session.pinned
        let actionType: OrganizeAction.ActionType = nextPinned ? .pin : .unpin
        mutateSession(session.id) { $0.pinned = nextPinned }
        do {
            _ = try await client.organize(actions: [OrganizeAction(type: actionType, sessionId: session.id)])
            mutateSession(session.id) { $0.pinned = nextPinned }
        } catch {
            reportError(error)
        }
    }

    public func togglePinToTop(_ session: UnifiedSession) async {
        let nextTop = !session.pinnedToTop
        let actionType: OrganizeAction.ActionType = nextTop ? .pinTop : .unpinTop
        mutateSession(session.id) {
            $0.pinnedToTop = nextTop
            if nextTop { $0.pinned = true }
        }
        do {
            _ = try await client.organize(actions: [OrganizeAction(type: actionType, sessionId: session.id)])
            mutateSession(session.id) {
                $0.pinnedToTop = nextTop
                if nextTop { $0.pinned = true }
            }
        } catch {
            reportError(error)
        }
    }

    public func archiveSession(_ session: UnifiedSession) async {
        mutateSession(session.id) {
            $0.status = .archived
            $0.isLive = false
        }
        let wasActive = selectedSessionId == session.id || detailRoute == .session(session.id)
        if wasActive {
            selectedSessionId = nil
            detailRoute = nil
            await client.watchSession(sessionId: nil, limit: 80)
        }
        do {
            _ = try await client.archiveSession(sessionId: session.id, killTmux: false)
            mutateSession(session.id) {
                $0.status = .archived
                $0.isLive = false
            }
        } catch {
            reportError(error)
        }
    }

    public func toggleHideSession(_ session: UnifiedSession) async {
        let nextHidden = !session.hidden
        let actionType: OrganizeAction.ActionType = nextHidden ? .hideSession : .unhideSession
        mutateSession(session.id) { $0.hidden = nextHidden }
        let wasActive = selectedSessionId == session.id || detailRoute == .session(session.id)
        if wasActive && nextHidden && !showHidden {
            selectedSessionId = nil
            detailRoute = nil
            await client.watchSession(sessionId: nil, limit: 80)
        }
        do {
            _ = try await client.organize(actions: [OrganizeAction(type: actionType, sessionId: session.id)])
            mutateSession(session.id) { $0.hidden = nextHidden }
        } catch {
            reportError(error)
        }
    }

    public func refreshCatalogIfNeeded(for group: HarnessGroup) async {
        if let existing = catalog?.models(for: group), !existing.isEmpty {
            return
        }
        if let fetched = try? await client.fetchCatalog(force: true) {
            catalog = fetched
        }
    }

    public func setSessionModel(sessionId: String, model: String?, reasoningEffort: String?) async {
        mutateSession(sessionId) { session in
            if let model { session.model = model }
            if let reasoningEffort { session.reasoningEffort = reasoningEffort }
        }
        let action = OrganizeAction(
            type: .setModel,
            sessionId: sessionId,
            model: model,
            reasoningEffort: reasoningEffort
        )
        do {
            _ = try await client.organize(actions: [action])
            mutateSession(sessionId) { session in
                if let model { session.model = model }
                if let reasoningEffort { session.reasoningEffort = reasoningEffort }
            }
        } catch {
            reportError(error)
        }
    }

    // MARK: - YapYap Voice Dictation

    public func refreshDictationStatus(overrideURL: String? = nil, overrideToken: String? = nil) async {
        isCheckingDictation = true
        defer { isCheckingDictation = false }
        let url = overrideURL ?? dictationURLOverride
        let tok = overrideToken ?? dictationTokenOverride
        dictationStatus = await client.fetchDictationStatus(
            overrideURL: url.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : url,
            overrideToken: tok.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : tok
        )
    }

    public func saveDictationOverrides(url: String, token: String) async {
        let trimmedURL = url.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        dictationURLOverride = trimmedURL
        dictationTokenOverride = trimmedToken
        defaults.set(trimmedURL, forKey: StorageKey.dictationURL)
        if trimmedToken.isEmpty {
            keychain.deleteToken(for: StorageKey.dictationTokenAccount)
        } else {
            try? keychain.saveToken(trimmedToken, for: StorageKey.dictationTokenAccount)
        }
        await refreshDictationStatus()
    }

    /// Called when the mic is tapped. One cheap status request opens the phone → host connection
    /// (and the host → YapYap one) during recording, so the audio upload after "stop" does not
    /// also pay for connection setup.
    public func prewarmDictation() async {
        let url = dictationURLOverride.trimmingCharacters(in: .whitespacesAndNewlines)
        let tok = dictationTokenOverride.trimmingCharacters(in: .whitespacesAndNewlines)
        if let status = await client.fetchDictationStatus(
            overrideURL: url.isEmpty ? nil : url,
            overrideToken: tok.isEmpty ? nil : tok
        ) {
            dictationStatus = status
        }
    }

    public func transcribeDictation(wavData: Data) async throws -> String {
        let url = dictationURLOverride.trimmingCharacters(in: .whitespacesAndNewlines)
        let tok = dictationTokenOverride.trimmingCharacters(in: .whitespacesAndNewlines)
        return try await client.transcribeAudio(
            wavData: wavData,
            overrideURL: url.isEmpty ? nil : url,
            overrideToken: tok.isEmpty ? nil : tok
        )
    }

    public func startSession(_ request: StartSessionRequest) async -> String? {
        do {
            let resp = try await client.startSession(request)
            guard resp.ok else {
                lastError = resp.error ?? "Failed to start session"
                return nil
            }
            if let sid = resp.sessionId {
                let now = Date().timeIntervalSince1970 * 1000.0
                if let prompt = request.prompt?.trimmingCharacters(in: .whitespacesAndNewlines), !prompt.isEmpty {
                    let seed = PendingOutgoingMessage(
                        text: prompt,
                        createdAt: now,
                        state: .sent
                    )
                    var pending = pendingOutgoingBySessionId[sid] ?? []
                    pending.append(seed)
                    pendingOutgoingBySessionId[sid] = pending
                }
                if !sessions.contains(where: { $0.id == sid }) {
                    let project = (request.cwd.trimmingCharacters(in: CharacterSet(charactersIn: "/")) as NSString).lastPathComponent
                    let placeholder = UnifiedSession(
                        id: sid,
                        harness: request.harness.kind,
                        harnessGroup: request.harness.kind.groupOrMaster,
                        title: request.title ?? request.prompt.map { String($0.prefix(60)) } ?? "New \(request.harness.label) session",
                        preview: request.prompt ?? "",
                        cwd: request.cwd,
                        projectName: project.isEmpty ? "Workspace" : project,
                        model: request.model,
                        reasoningEffort: request.reasoningEffort,
                        status: request.prompt == nil ? .idle : .running,
                        isLive: true,
                        createdAt: now,
                        updatedAt: now
                    )
                    if sessions.first?.isMaster == true {
                        sessions.insert(placeholder, at: 1)
                    } else {
                        sessions.insert(placeholder, at: 0)
                    }
                }
                selectSession(sid)
                if connectionMode == .live {
                    Task { [weak self] in
                        await self?.resync()
                    }
                }
                return sid
            }
        } catch {
            reportError(error)
        }
        return nil
    }

    public func controlHarness(_ harness: HarnessGroup, action: HarnessControlAction) async {
        do {
            let resp = try await client.controlHarness(harness: harness, action: action)
            if !resp.ok, let err = resp.error {
                lastError = err
            }
        } catch {
            reportError(error)
        }
    }

    // MARK: - Host Connection Settings

    public func testHostConnection(urlString: String, token: String) async -> ConnectionTestResult {
        do {
            let url = try LiveSuperHarnessClient.normalizeBaseURL(urlString)
            let probe = LiveSuperHarnessClient(baseURL: url, token: token)
            return try await probe.testConnection()
        } catch {
            return ConnectionTestResult(ok: false, latencyMs: 0, harnessCount: 0, message: error.localizedDescription)
        }
    }

    public func applyConnectionSettings(mode: ConnectionMode, urlString: String, token: String) async {
        stopEventStream()
        connectionMode = mode
        hostURLString = urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        bearerToken = token

        defaults.set(mode.rawValue, forKey: StorageKey.connectionMode)
        defaults.set(hostURLString, forKey: StorageKey.hostURL)
        if token.isEmpty {
            keychain.deleteToken(for: StorageKey.tokenAccount)
        } else {
            try? keychain.saveToken(token, for: StorageKey.tokenAccount)
        }

        transcriptsBySessionId.removeAll()
        transcriptLimitsBySessionId.removeAll()
        streamingMessagesBySessionId.removeAll()
        pendingOutgoingBySessionId.removeAll()
        hostWorkingSessionIds.removeAll()
        transcriptRevisionBySessionId.removeAll()
        mediaCache.removeAll()
        selectedSessionId = nil

        switch mode {
        case .demo:
            client = MockSuperHarnessClient()
            connectionHealth = .demo
        case .live:
            do {
                let url = try LiveSuperHarnessClient.normalizeBaseURL(hostURLString)
                client = LiveSuperHarnessClient(baseURL: url, token: token)
                connectionHealth = .connecting
            } catch {
                connectionHealth = .offline(error.localizedDescription)
                reportError(error)
                return
            }
        }

        await bootstrap()
    }

    public func openDraftChat(for harness: HarnessGroup? = nil) {
        // An explicit harness (filter chip, long-press) wins; otherwise reopen the draft where it was left.
        if let harness, newThreadConfig.harness.harnessGroup != harness {
            newThreadConfig.harness = harness.defaultStartHarness
        }
        let kind = newThreadConfig.harness
        selectedSessionId = nil
        detailRoute = .draft(kind)
        let activeClient = client
        Task {
            await activeClient.watchSession(sessionId: nil, limit: 80)
        }
    }

    public func openNewSessionSheet(for harness: HarnessGroup? = nil) {
        openDraftChat(for: harness)
    }

    public func openUsageSheet(for harness: HarnessGroup? = nil) {
        usageSheetTarget = harness
        isUsageSheetPresented = true
    }

    private func mutateSession(_ id: String, _ mutation: (inout UnifiedSession) -> Void) {
        guard let idx = sessions.firstIndex(where: { $0.id == id }) else { return }
        mutation(&sessions[idx])
    }

    // MARK: - Draft Persistence

    /// Loads saved drafts and keeps them saved from now on. The app calls this at launch;
    /// stores built with an injected client (unit tests) stay in memory unless they opt in.
    public func enableDraftPersistence(directory: URL = DraftPersistence.defaultDirectory) {
        let persistence = DraftPersistence(directory: directory)
        let saved = persistence.load()
        draftPersistence = nil
        draftInputs = saved.inputs
        draftAttachments = saved.attachments
        if let config = saved.newThread {
            newThreadConfig = config
        }
        draftPersistence = persistence
    }

    /// Writes drafts to disk now (used when the app goes to the background).
    public func flushDrafts() {
        draftSaveTask?.cancel()
        draftSaveTask = nil
        guard let draftPersistence else { return }
        draftPersistence.saveText(inputs: draftInputs, newThread: newThreadConfig)
        if draftAttachmentsDirty {
            draftAttachmentsDirty = false
            draftPersistence.saveAttachments(persistableDraftAttachments)
        }
    }

    /// Discards the New Chat draft after its session has been started.
    public func clearNewThreadDraft() {
        draftInputs[Self.newThreadDraftKey] = nil
        draftAttachments[Self.newThreadDraftKey] = nil
    }

    /// Attachments still uploading have no host path yet and cannot be resumed after a relaunch.
    private var persistableDraftAttachments: [String: [ImageAttachment]] {
        draftAttachments.mapValues { list in list.filter { !uploadingAttachmentIds.contains($0.id) } }
    }

    private func scheduleDraftSave(attachments: Bool) {
        guard draftPersistence != nil else { return }
        if attachments { draftAttachmentsDirty = true }
        draftSaveTask?.cancel()
        draftSaveTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 400_000_000)
            guard !Task.isCancelled else { return }
            self?.flushDrafts()
        }
    }
}

// MARK: - Draft Models & Disk Store

/// What the New Chat page had selected, so reopening it restores the same setup.
public struct NewThreadDraftConfig: Codable, Sendable, Equatable {
    public var harness: StartHarnessKind
    public var projectPath: String
    public var modelId: String
    public var reasoning: String
    public var remoteControl: Bool

    public init(
        harness: StartHarnessKind = .antigravity,
        projectPath: String = "",
        modelId: String = "",
        reasoning: String = "",
        remoteControl: Bool = false
    ) {
        self.harness = harness
        self.projectPath = projectPath
        self.modelId = modelId
        self.reasoning = reasoning
        self.remoteControl = remoteControl
    }
}

/// Saves unsent composer drafts as two JSON files: text and New Chat setup in one (rewritten as
/// the user types), attachments in the other (rewritten only when attachments change, since
/// image previews make it large).
public struct DraftPersistence: Sendable {
    public struct Saved: Equatable, Sendable {
        public var inputs: [String: String] = [:]
        public var attachments: [String: [ImageAttachment]] = [:]
        public var newThread: NewThreadDraftConfig?
    }

    private struct TextFile: Codable {
        var inputs: [String: String]
        var newThread: NewThreadDraftConfig?
    }

    public static var defaultDirectory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return base.appendingPathComponent("Drafts", isDirectory: true)
    }

    public let directory: URL
    private var textURL: URL { directory.appendingPathComponent("drafts.json") }
    private var attachmentsURL: URL { directory.appendingPathComponent("draft-attachments.json") }

    public init(directory: URL) {
        self.directory = directory
    }

    public func load() -> Saved {
        var saved = Saved()
        let decoder = JSONDecoder()
        if let data = try? Data(contentsOf: textURL), let file = try? decoder.decode(TextFile.self, from: data) {
            saved.inputs = file.inputs
            saved.newThread = file.newThread
        }
        if let data = try? Data(contentsOf: attachmentsURL),
           let attachments = try? decoder.decode([String: [ImageAttachment]].self, from: data) {
            saved.attachments = attachments
        }
        return saved
    }

    public func saveText(inputs: [String: String], newThread: NewThreadDraftConfig) {
        let file = TextFile(inputs: inputs.filter { !$0.value.isEmpty }, newThread: newThread)
        write(file, to: textURL)
    }

    public func saveAttachments(_ attachments: [String: [ImageAttachment]]) {
        write(attachments.filter { !$0.value.isEmpty }, to: attachmentsURL)
    }

    private func write<T: Encodable>(_ value: T, to url: URL) {
        guard let data = try? JSONEncoder().encode(value) else { return }
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? data.write(to: url, options: .atomic)
    }
}
