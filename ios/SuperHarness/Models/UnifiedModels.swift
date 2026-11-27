import Foundation

// MARK: - Lossy / Future-Proof Decoding Helpers

private struct AnyCodingKey: CodingKey {
    var stringValue: String
    var intValue: Int?

    init?(stringValue: String) {
        self.stringValue = stringValue
        self.intValue = nil
    }

    init?(intValue: Int) {
        self.stringValue = String(intValue)
        self.intValue = intValue
    }
}

private struct LossyDecodable<T: Decodable>: Decodable {
    let value: T?

    init(from decoder: Decoder) throws {
        value = try? T(from: decoder)
    }
}

private func decodeLossyArray<T: Decodable, K: CodingKey>(
    from container: KeyedDecodingContainer<K>,
    forKey key: K
) -> [T] {
    guard let wrapped = try? container.decodeIfPresent([LossyDecodable<T>].self, forKey: key) else {
        return []
    }
    return wrapped.compactMap(\.value)
}

// MARK: - Core Harness & Session Enums

public enum HarnessKind: String, Codable, CaseIterable, Sendable, Hashable {
    case master
    case codex
    case claudeTmux = "claude-tmux"
    case claudeDesktop = "claude-desktop"
    case claudeCli = "claude-cli"
    case antigravity
    case muse
    case pi

    public var groupOrMaster: HarnessGroupOrMaster {
        switch self {
        case .master: return .master
        case .codex: return .codex
        case .antigravity: return .antigravity
        case .claudeTmux, .claudeDesktop, .claudeCli: return .claude
        case .muse: return .muse
        case .pi: return .pi
        }
    }

    public var harnessGroup: HarnessGroup? {
        switch self {
        case .master: return nil
        case .codex: return .codex
        case .antigravity: return .antigravity
        case .claudeTmux, .claudeDesktop, .claudeCli: return .claude
        case .muse: return .muse
        case .pi: return .pi
        }
    }

    public var defaultDispatchMode: DispatchMode {
        switch self {
        case .master: return .master
        case .codex: return .codexResume
        case .claudeTmux: return .tmuxSend
        case .claudeDesktop, .claudeCli: return .claudeResume
        case .antigravity: return .agyResume
        case .muse: return .museExec
        case .pi: return .piRpc
        }
    }
}

public enum HarnessGroup: String, Codable, CaseIterable, Identifiable, Sendable, Hashable {
    case antigravity
    case codex
    case claude
    case muse
    case pi

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .antigravity: return "Antigravity"
        case .codex: return "Codex"
        case .claude: return "Claude"
        case .muse: return "Muse"
        case .pi: return "Pi"
        }
    }

    public var defaultKind: HarnessKind {
        switch self {
        case .antigravity: return .antigravity
        case .codex: return .codex
        case .claude: return .claudeCli
        case .muse: return .muse
        case .pi: return .pi
        }
    }

    public var defaultStartHarness: StartHarnessKind {
        switch self {
        case .antigravity: return .antigravity
        case .codex: return .codex
        case .claude: return .claudeTmux
        case .muse: return .muse
        case .pi: return .pi
        }
    }
}

public enum HarnessGroupOrMaster: String, Codable, Sendable, Hashable {
    case master
    case codex
    case claude
    case antigravity
    case muse
    case pi
}

public enum StartHarnessKind: String, Codable, CaseIterable, Identifiable, Sendable, Hashable {
    case antigravity
    case codex
    case claudeCli = "claude-cli"
    case claudeTmux = "claude-tmux"
    case muse
    case pi

    public var id: String { rawValue }

    /// Harnesses offered when starting a new session. New Claude sessions always
    /// run in tmux; `claudeCli` stays decodable for existing sessions only.
    public static var pickable: [StartHarnessKind] { allCases.filter { $0 != .claudeCli } }

    public var label: String {
        switch self {
        case .antigravity: return "Antigravity"
        case .codex: return "Codex"
        case .claudeCli: return "Claude CLI"
        case .claudeTmux: return "Claude tmux"
        case .muse: return "Muse"
        case .pi: return "Pi"
        }
    }

    public var harnessGroup: HarnessGroup {
        switch self {
        case .antigravity: return .antigravity
        case .codex: return .codex
        case .claudeCli, .claudeTmux: return .claude
        case .muse: return .muse
        case .pi: return .pi
        }
    }

    public var kind: HarnessKind {
        switch self {
        case .antigravity: return .antigravity
        case .codex: return .codex
        case .claudeCli: return .claudeCli
        case .claudeTmux: return .claudeTmux
        case .muse: return .muse
        case .pi: return .pi
        }
    }
}

public enum SessionStatus: String, Codable, Sendable, Hashable {
    case running
    case idle
    case waitingInput = "waiting_input"
    case stopped
    case archived

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let raw = (try? container.decode(String.self)) ?? "idle"
        self = SessionStatus(rawValue: raw) ?? .idle
    }
}

public enum DispatchMode: String, Codable, Sendable, Hashable {
    case master
    case tmuxSend = "tmux-send"
    case claudeResume = "claude-resume"
    case codexResume = "codex-resume"
    case agyResume = "agy-resume"
    case museExec = "muse-exec"
    case piRpc = "pi-rpc"

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let raw = (try? container.decode(String.self)) ?? "claude-resume"
        self = DispatchMode(rawValue: raw) ?? .claudeResume
    }
}

public enum SidebarGroupBy: String, Codable, CaseIterable, Identifiable, Sendable, Hashable {
    case native
    case harness
    case project
    case folders
    case recent

    public var id: String { rawValue }

    public var label: String {
        switch self {
        case .native: return "Native"
        case .harness: return "Harness"
        case .project: return "Project"
        case .folders: return "Folders"
        case .recent: return "Recent"
        }
    }

    public var symbolName: String {
        switch self {
        case .native: return "square.stack.3d.up"
        case .harness: return "cpu"
        case .project: return "folder"
        case .folders: return "tray.2"
        case .recent: return "clock"
        }
    }
}

public enum OriginApp: String, Codable, Sendable, Hashable {
    case antigravityApp = "antigravity-app"
    case antigravityCli = "antigravity-cli"
}

// MARK: - Harness Detection

public struct HarnessCapabilities: Codable, Sendable, Equatable {
    public var canStartNew: Bool
    public var canResume: Bool
    public var canTmuxMirror: Bool
    public var canControlDaemon: Bool

    public init(
        canStartNew: Bool = true,
        canResume: Bool = true,
        canTmuxMirror: Bool = false,
        canControlDaemon: Bool = false
    ) {
        self.canStartNew = canStartNew
        self.canResume = canResume
        self.canTmuxMirror = canTmuxMirror
        self.canControlDaemon = canControlDaemon
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        canStartNew = try c.decodeIfPresent(Bool.self, forKey: .canStartNew) ?? true
        canResume = try c.decodeIfPresent(Bool.self, forKey: .canResume) ?? true
        canTmuxMirror = try c.decodeIfPresent(Bool.self, forKey: .canTmuxMirror) ?? false
        canControlDaemon = try c.decodeIfPresent(Bool.self, forKey: .canControlDaemon) ?? false
    }
}

public struct HarnessDetection: Codable, Identifiable, Sendable, Equatable {
    public var id: HarnessGroup
    public var name: String
    public var installed: Bool
    public var binaryPath: String?
    public var version: String?
    public var runningProcesses: Int
    public var desktopAppRunning: Bool
    public var daemonRunning: Bool
    public var remoteControlEnabled: Bool
    public var activeSessionCount: Int
    public var totalSessionCount: Int
    public var capabilities: HarnessCapabilities
    public var notes: String?

    public init(
        id: HarnessGroup,
        name: String,
        installed: Bool,
        binaryPath: String? = nil,
        version: String? = nil,
        runningProcesses: Int = 0,
        desktopAppRunning: Bool = false,
        daemonRunning: Bool = false,
        remoteControlEnabled: Bool = false,
        activeSessionCount: Int = 0,
        totalSessionCount: Int = 0,
        capabilities: HarnessCapabilities = HarnessCapabilities(),
        notes: String? = nil
    ) {
        self.id = id
        self.name = name
        self.installed = installed
        self.binaryPath = binaryPath
        self.version = version
        self.runningProcesses = runningProcesses
        self.desktopAppRunning = desktopAppRunning
        self.daemonRunning = daemonRunning
        self.remoteControlEnabled = remoteControlEnabled
        self.activeSessionCount = activeSessionCount
        self.totalSessionCount = totalSessionCount
        self.capabilities = capabilities
        self.notes = notes
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(HarnessGroup.self, forKey: .id)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? id.title
        installed = try c.decodeIfPresent(Bool.self, forKey: .installed) ?? false
        binaryPath = try c.decodeIfPresent(String.self, forKey: .binaryPath)
        version = try c.decodeIfPresent(String.self, forKey: .version)
        runningProcesses = try c.decodeIfPresent(Int.self, forKey: .runningProcesses) ?? 0
        desktopAppRunning = try c.decodeIfPresent(Bool.self, forKey: .desktopAppRunning) ?? false
        daemonRunning = try c.decodeIfPresent(Bool.self, forKey: .daemonRunning) ?? false
        remoteControlEnabled = try c.decodeIfPresent(Bool.self, forKey: .remoteControlEnabled) ?? false
        activeSessionCount = try c.decodeIfPresent(Int.self, forKey: .activeSessionCount) ?? 0
        totalSessionCount = try c.decodeIfPresent(Int.self, forKey: .totalSessionCount) ?? 0
        capabilities = try c.decodeIfPresent(HarnessCapabilities.self, forKey: .capabilities) ?? HarnessCapabilities()
        notes = try c.decodeIfPresent(String.self, forKey: .notes)
    }
}

// MARK: - UnifiedSession (tolerant decoding for both full bootstrap and subset /api/sessions)

public struct UnifiedSession: Codable, Identifiable, Sendable, Equatable, Hashable {
    public var id: String
    public var nativeId: String
    public var harness: HarnessKind
    public var harnessGroup: HarnessGroupOrMaster
    public var title: String
    public var customTitle: String?
    public var preview: String
    public var cwd: String
    public var projectName: String
    public var gitBranch: String?
    public var model: String?
    public var reasoningEffort: String?
    public var status: SessionStatus
    public var isLive: Bool
    public var isRemote: Bool
    public var remoteId: String?
    public var tmuxTarget: String?
    public var tmuxSessionName: String?
    public var pid: Int?
    public var transcriptPath: String?
    public var createdAt: Double
    public var updatedAt: Double
    public var tokenCount: Int?
    public var pinned: Bool
    public var pinnedToTop: Bool
    public var folderId: String?
    public var tags: [String]
    public var hidden: Bool
    public var dispatchMode: DispatchMode
    public var liveOwner: String?
    public var isSubagent: Bool
    public var parentSessionId: String?
    public var subagentCount: Int?
    public var nativeSection: String?
    public var nativeSectionOrder: Int?
    public var originApp: OriginApp?
    public var nativeMetaPath: String?
    public var permissionMode: String?
    /// Address of the machine the session runs on, when it is not the control host itself.
    public var hostAddress: String?
    public var hostLabel: String?
    /// Start of the newest message the person sent in this session (one line, host-trimmed).
    public var lastUserText: String?
    /// Host-generated one-line summary of what this thread is working on or last finished.
    public var summary: String?
    /// New activity since the person last had the session open on any client. The host
    /// computes it and never sets it while the session is running.
    public var unread: Bool?

    public var isUnread: Bool { unread == true }

    public var displayTitle: String {
        if let custom = customTitle?.trimmingCharacters(in: .whitespacesAndNewlines), !custom.isEmpty {
            return custom
        }
        return title.isEmpty ? "Untitled Session" : title
    }

    public var isMaster: Bool { harness == .master }

    public var isWorking: Bool { status == .running }

    public var updatedDate: Date {
        Date(timeIntervalSince1970: updatedAt / 1000.0)
    }

    public init(
        id: String,
        nativeId: String? = nil,
        harness: HarnessKind,
        harnessGroup: HarnessGroupOrMaster? = nil,
        title: String,
        customTitle: String? = nil,
        preview: String = "",
        cwd: String = "",
        projectName: String = "",
        gitBranch: String? = nil,
        model: String? = nil,
        reasoningEffort: String? = nil,
        status: SessionStatus = .idle,
        isLive: Bool = false,
        isRemote: Bool = false,
        remoteId: String? = nil,
        tmuxTarget: String? = nil,
        tmuxSessionName: String? = nil,
        pid: Int? = nil,
        transcriptPath: String? = nil,
        createdAt: Double? = nil,
        updatedAt: Double = Date().timeIntervalSince1970 * 1000.0,
        tokenCount: Int? = nil,
        pinned: Bool = false,
        pinnedToTop: Bool = false,
        folderId: String? = nil,
        tags: [String] = [],
        hidden: Bool = false,
        dispatchMode: DispatchMode? = nil,
        liveOwner: String? = nil,
        isSubagent: Bool = false,
        parentSessionId: String? = nil,
        subagentCount: Int? = nil,
        nativeSection: String? = nil,
        nativeSectionOrder: Int? = nil,
        originApp: OriginApp? = nil,
        nativeMetaPath: String? = nil,
        permissionMode: String? = nil,
        hostAddress: String? = nil,
        hostLabel: String? = nil,
        lastUserText: String? = nil,
        summary: String? = nil,
        unread: Bool? = nil
    ) {
        self.id = id
        self.nativeId = nativeId ?? Self.inferNativeId(from: id)
        self.harness = harness
        self.harnessGroup = harnessGroup ?? harness.groupOrMaster
        self.title = title
        self.customTitle = customTitle
        self.preview = preview
        self.cwd = cwd
        self.projectName = projectName.isEmpty ? Self.inferProjectName(from: cwd) : projectName
        self.gitBranch = gitBranch
        self.model = model
        self.reasoningEffort = reasoningEffort
        self.status = status
        self.isLive = isLive
        self.isRemote = isRemote
        self.remoteId = remoteId
        self.tmuxTarget = tmuxTarget
        self.tmuxSessionName = tmuxSessionName
        self.pid = pid
        self.transcriptPath = transcriptPath
        self.createdAt = createdAt ?? updatedAt
        self.updatedAt = updatedAt
        self.tokenCount = tokenCount
        self.pinned = pinned
        self.pinnedToTop = pinnedToTop
        self.folderId = folderId
        self.tags = tags
        self.hidden = hidden
        self.dispatchMode = dispatchMode ?? harness.defaultDispatchMode
        self.liveOwner = liveOwner
        self.isSubagent = isSubagent
        self.parentSessionId = parentSessionId
        self.subagentCount = subagentCount
        self.nativeSection = nativeSection
        self.nativeSectionOrder = nativeSectionOrder
        self.originApp = originApp
        self.nativeMetaPath = nativeMetaPath
        self.permissionMode = permissionMode
        self.hostAddress = hostAddress
        self.hostLabel = hostLabel
        self.lastUserText = lastUserText
        self.summary = summary
        self.unread = unread
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let decodedId = try c.decode(String.self, forKey: .id)
        let decodedHarness = try c.decode(HarnessKind.self, forKey: .harness)
        let decodedUpdated = try c.decodeIfPresent(Double.self, forKey: .updatedAt) ?? 0
        let decodedCwd = try c.decodeIfPresent(String.self, forKey: .cwd) ?? ""
        let decodedProject = try c.decodeIfPresent(String.self, forKey: .projectName) ?? ""

        id = decodedId
        nativeId = try c.decodeIfPresent(String.self, forKey: .nativeId) ?? Self.inferNativeId(from: decodedId)
        harness = decodedHarness
        harnessGroup = (try? c.decodeIfPresent(HarnessGroupOrMaster.self, forKey: .harnessGroup)) ?? decodedHarness.groupOrMaster
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? "Untitled"
        customTitle = try c.decodeIfPresent(String.self, forKey: .customTitle)
        preview = try c.decodeIfPresent(String.self, forKey: .preview) ?? ""
        cwd = decodedCwd
        projectName = decodedProject.isEmpty ? Self.inferProjectName(from: decodedCwd) : decodedProject
        gitBranch = try c.decodeIfPresent(String.self, forKey: .gitBranch)
        model = try c.decodeIfPresent(String.self, forKey: .model)
        reasoningEffort = try c.decodeIfPresent(String.self, forKey: .reasoningEffort)
        status = (try? c.decodeIfPresent(SessionStatus.self, forKey: .status)) ?? .idle
        isLive = try c.decodeIfPresent(Bool.self, forKey: .isLive) ?? false
        isRemote = try c.decodeIfPresent(Bool.self, forKey: .isRemote) ?? false
        remoteId = try c.decodeIfPresent(String.self, forKey: .remoteId)
        tmuxTarget = try c.decodeIfPresent(String.self, forKey: .tmuxTarget)
        tmuxSessionName = try c.decodeIfPresent(String.self, forKey: .tmuxSessionName)
        pid = try c.decodeIfPresent(Int.self, forKey: .pid)
        transcriptPath = try c.decodeIfPresent(String.self, forKey: .transcriptPath)
        createdAt = try c.decodeIfPresent(Double.self, forKey: .createdAt) ?? decodedUpdated
        updatedAt = decodedUpdated
        tokenCount = try c.decodeIfPresent(Int.self, forKey: .tokenCount)
        pinned = try c.decodeIfPresent(Bool.self, forKey: .pinned) ?? false
        pinnedToTop = try c.decodeIfPresent(Bool.self, forKey: .pinnedToTop) ?? false
        folderId = try c.decodeIfPresent(String.self, forKey: .folderId)
        tags = try c.decodeIfPresent([String].self, forKey: .tags) ?? []
        hidden = try c.decodeIfPresent(Bool.self, forKey: .hidden) ?? false
        dispatchMode = (try? c.decodeIfPresent(DispatchMode.self, forKey: .dispatchMode)) ?? decodedHarness.defaultDispatchMode
        liveOwner = try? c.decodeIfPresent(String.self, forKey: .liveOwner)
        isSubagent = try c.decodeIfPresent(Bool.self, forKey: .isSubagent) ?? false
        parentSessionId = try c.decodeIfPresent(String.self, forKey: .parentSessionId)
        subagentCount = try c.decodeIfPresent(Int.self, forKey: .subagentCount)
        nativeSection = try c.decodeIfPresent(String.self, forKey: .nativeSection)
        nativeSectionOrder = try c.decodeIfPresent(Int.self, forKey: .nativeSectionOrder)
        originApp = try? c.decodeIfPresent(OriginApp.self, forKey: .originApp)
        nativeMetaPath = try c.decodeIfPresent(String.self, forKey: .nativeMetaPath)
        permissionMode = try c.decodeIfPresent(String.self, forKey: .permissionMode)
        hostAddress = try? c.decodeIfPresent(String.self, forKey: .hostAddress)
        hostLabel = try? c.decodeIfPresent(String.self, forKey: .hostLabel)
        lastUserText = try? c.decodeIfPresent(String.self, forKey: .lastUserText)
        summary = try? c.decodeIfPresent(String.self, forKey: .summary)
        unread = try? c.decodeIfPresent(Bool.self, forKey: .unread)
    }

    private static func inferNativeId(from id: String) -> String {
        if let idx = id.firstIndex(of: ":") {
            return String(id[id.index(after: idx)...])
        }
        return id
    }

    private static func inferProjectName(from cwd: String) -> String {
        let trimmed = cwd.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        if trimmed.isEmpty { return "Workspace" }
        return (trimmed as NSString).lastPathComponent
    }
}

// MARK: - Attachments & Blocks

public enum SendMode: String, Codable, Sendable, Equatable {
    case steer
    case queue
}

public struct ImageAttachment: Codable, Identifiable, Sendable, Equatable, Hashable {
    public var id: String
    public var name: String
    public var path: String
    public var mimeType: String
    public var previewDataUrl: String?
    public var sizeBytes: Int?

    public var isImage: Bool { mimeType.lowercased().hasPrefix("image/") }
    public var isVideo: Bool { mimeType.lowercased().hasPrefix("video/") }

    public init(
        id: String = UUID().uuidString,
        name: String,
        path: String = "",
        mimeType: String = "image/jpeg",
        previewDataUrl: String? = nil,
        sizeBytes: Int? = nil
    ) {
        self.id = id
        self.name = name
        self.path = path
        self.mimeType = mimeType
        self.previewDataUrl = previewDataUrl
        self.sizeBytes = sizeBytes
    }
}

public struct FileChangeEntry: Codable, Sendable, Equatable, Hashable {
    public var path: String
    public var kind: String
    public var diff: String?

    public init(path: String, kind: String, diff: String? = nil) {
        self.path = path
        self.kind = kind
        self.diff = diff
    }
}

public struct QuestionItem: Codable, Sendable, Equatable, Hashable {
    public var question: String
    public var options: [String]
    public var multiSelect: Bool?
    public var answer: String?

    public init(question: String, options: [String], multiSelect: Bool? = nil, answer: String? = nil) {
        self.question = question
        self.options = options
        self.multiSelect = multiSelect
        self.answer = answer
    }
}

public enum UnifiedBlock: Codable, Sendable, Equatable, Hashable {
    case text(text: String)
    case image(path: String, name: String?, dataUrl: String?)
    case video(path: String, name: String?, mimeType: String?)
    case thinking(text: String, summary: String?)
    case command(command: String, cwd: String?, output: String?, exitCode: Int?, durationMs: Double?, status: String?)
    case fileChange(changes: [FileChangeEntry], status: String?)
    case toolCall(name: String, server: String?, args: String?, output: String?, status: String?, durationMs: Double?)
    case webSearch(query: String, url: String?)
    case question(questions: [QuestionItem], answered: Bool?)
    case notice(title: String, detail: String?)

    public var isTraceBlock: Bool {
        switch self {
        case .thinking, .command, .toolCall, .webSearch, .fileChange:
            return true
        case .text, .image, .video, .question, .notice:
            return false
        }
    }

    private enum CodingKeys: String, CodingKey {
        case type
        case text, path, name, dataUrl, mimeType, summary
        case command, cwd, output, exitCode, durationMs, status
        case changes
        case server, args
        case query, url
        case questions, answered
        case title, detail
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        let type = try c.decode(String.self, forKey: .type)
        switch type {
        case "text":
            self = .text(text: try c.decodeIfPresent(String.self, forKey: .text) ?? "")
        case "image":
            self = .image(
                path: try c.decodeIfPresent(String.self, forKey: .path) ?? "",
                name: try c.decodeIfPresent(String.self, forKey: .name),
                dataUrl: try c.decodeIfPresent(String.self, forKey: .dataUrl)
            )
        case "video":
            self = .video(
                path: try c.decodeIfPresent(String.self, forKey: .path) ?? "",
                name: try c.decodeIfPresent(String.self, forKey: .name),
                mimeType: try c.decodeIfPresent(String.self, forKey: .mimeType)
            )
        case "thinking":
            self = .thinking(
                text: try c.decodeIfPresent(String.self, forKey: .text) ?? "",
                summary: try c.decodeIfPresent(String.self, forKey: .summary)
            )
        case "command":
            self = .command(
                command: try c.decodeIfPresent(String.self, forKey: .command) ?? "",
                cwd: try c.decodeIfPresent(String.self, forKey: .cwd),
                output: try c.decodeIfPresent(String.self, forKey: .output),
                exitCode: try c.decodeIfPresent(Int.self, forKey: .exitCode),
                durationMs: try c.decodeIfPresent(Double.self, forKey: .durationMs),
                status: try c.decodeIfPresent(String.self, forKey: .status)
            )
        case "file_change":
            self = .fileChange(
                changes: try c.decodeIfPresent([FileChangeEntry].self, forKey: .changes) ?? [],
                status: try c.decodeIfPresent(String.self, forKey: .status)
            )
        case "tool_call":
            self = .toolCall(
                name: try c.decodeIfPresent(String.self, forKey: .name) ?? "tool",
                server: try c.decodeIfPresent(String.self, forKey: .server),
                args: try c.decodeIfPresent(String.self, forKey: .args),
                output: try c.decodeIfPresent(String.self, forKey: .output),
                status: try c.decodeIfPresent(String.self, forKey: .status),
                durationMs: try c.decodeIfPresent(Double.self, forKey: .durationMs)
            )
        case "web_search":
            self = .webSearch(
                query: try c.decodeIfPresent(String.self, forKey: .query) ?? "",
                url: try c.decodeIfPresent(String.self, forKey: .url)
            )
        case "question":
            self = .question(
                questions: try c.decodeIfPresent([QuestionItem].self, forKey: .questions) ?? [],
                answered: try c.decodeIfPresent(Bool.self, forKey: .answered)
            )
        case "notice":
            self = .notice(
                title: try c.decodeIfPresent(String.self, forKey: .title) ?? "Notice",
                detail: try c.decodeIfPresent(String.self, forKey: .detail)
            )
        default:
            self = .notice(title: "Unsupported block", detail: "Block type '\(type)'")
        }
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .text(let text):
            try c.encode("text", forKey: .type)
            try c.encode(text, forKey: .text)
        case .image(let path, let name, let dataUrl):
            try c.encode("image", forKey: .type)
            try c.encode(path, forKey: .path)
            try c.encodeIfPresent(name, forKey: .name)
            try c.encodeIfPresent(dataUrl, forKey: .dataUrl)
        case .video(let path, let name, let mimeType):
            try c.encode("video", forKey: .type)
            try c.encode(path, forKey: .path)
            try c.encodeIfPresent(name, forKey: .name)
            try c.encodeIfPresent(mimeType, forKey: .mimeType)
        case .thinking(let text, let summary):
            try c.encode("thinking", forKey: .type)
            try c.encode(text, forKey: .text)
            try c.encodeIfPresent(summary, forKey: .summary)
        case .command(let command, let cwd, let output, let exitCode, let durationMs, let status):
            try c.encode("command", forKey: .type)
            try c.encode(command, forKey: .command)
            try c.encodeIfPresent(cwd, forKey: .cwd)
            try c.encodeIfPresent(output, forKey: .output)
            try c.encodeIfPresent(exitCode, forKey: .exitCode)
            try c.encodeIfPresent(durationMs, forKey: .durationMs)
            try c.encodeIfPresent(status, forKey: .status)
        case .fileChange(let changes, let status):
            try c.encode("file_change", forKey: .type)
            try c.encode(changes, forKey: .changes)
            try c.encodeIfPresent(status, forKey: .status)
        case .toolCall(let name, let server, let args, let output, let status, let durationMs):
            try c.encode("tool_call", forKey: .type)
            try c.encode(name, forKey: .name)
            try c.encodeIfPresent(server, forKey: .server)
            try c.encodeIfPresent(args, forKey: .args)
            try c.encodeIfPresent(output, forKey: .output)
            try c.encodeIfPresent(status, forKey: .status)
            try c.encodeIfPresent(durationMs, forKey: .durationMs)
        case .webSearch(let query, let url):
            try c.encode("web_search", forKey: .type)
            try c.encode(query, forKey: .query)
            try c.encodeIfPresent(url, forKey: .url)
        case .question(let questions, let answered):
            try c.encode("question", forKey: .type)
            try c.encode(questions, forKey: .questions)
            try c.encodeIfPresent(answered, forKey: .answered)
        case .notice(let title, let detail):
            try c.encode("notice", forKey: .type)
            try c.encode(title, forKey: .title)
            try c.encodeIfPresent(detail, forKey: .detail)
        }
    }
}

// MARK: - Live Activity, Transcript & Streaming

public enum LiveStepStatus: String, Codable, Sendable, Equatable {
    case pending
    case inProgress = "in_progress"
    case done
    case skipped
    case failed

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let raw = (try? container.decode(String.self)) ?? "pending"
        self = LiveStepStatus(rawValue: raw) ?? .pending
    }
}

public struct LiveStepItem: Codable, Identifiable, Sendable, Equatable {
    public var id: String { title }
    public var title: String
    public var status: LiveStepStatus

    public init(title: String, status: LiveStepStatus) {
        self.title = title
        self.status = status
    }
}

public struct RunningTaskItem: Codable, Identifiable, Sendable, Equatable {
    public var id: String
    public var summary: String
    public var command: String?
    public var logPath: String?
    public var isDaemon: Bool?

    public init(id: String, summary: String, command: String? = nil, logPath: String? = nil, isDaemon: Bool? = nil) {
        self.id = id
        self.summary = summary
        self.command = command
        self.logPath = logPath
        self.isDaemon = isDaemon
    }
}

public struct QueuedMessageItem: Codable, Identifiable, Sendable, Equatable {
    public var id: String
    public var text: String
    public var attachments: [ImageAttachment]?
    public var createdAt: Double
    public var source: String

    public init(
        id: String = UUID().uuidString,
        text: String,
        attachments: [ImageAttachment]? = nil,
        createdAt: Double = Date().timeIntervalSince1970 * 1000.0,
        source: String = "super-harness"
    ) {
        self.id = id
        self.text = text
        self.attachments = attachments
        self.createdAt = createdAt
        self.source = source
    }
}

public struct LiveActivityState: Codable, Sendable, Equatable {
    public var isWorking: Bool
    public var focus: String?
    public var steps: [LiveStepItem]?
    public var queuedMessages: [QueuedMessageItem]?
    public var runningTasks: [RunningTaskItem]?
    public var lastEventAt: Double?

    public init(
        isWorking: Bool = false,
        focus: String? = nil,
        steps: [LiveStepItem]? = nil,
        queuedMessages: [QueuedMessageItem]? = nil,
        runningTasks: [RunningTaskItem]? = nil,
        lastEventAt: Double? = nil
    ) {
        self.isWorking = isWorking
        self.focus = focus
        self.steps = steps
        self.queuedMessages = queuedMessages
        self.runningTasks = runningTasks
        self.lastEventAt = lastEventAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        isWorking = try c.decodeIfPresent(Bool.self, forKey: .isWorking) ?? false
        focus = try c.decodeIfPresent(String.self, forKey: .focus)
        steps = c.contains(.steps) ? decodeLossyArray(from: c, forKey: .steps) : nil
        queuedMessages = c.contains(.queuedMessages) ? decodeLossyArray(from: c, forKey: .queuedMessages) : nil
        runningTasks = c.contains(.runningTasks) ? decodeLossyArray(from: c, forKey: .runningTasks) : nil
        lastEventAt = try c.decodeIfPresent(Double.self, forKey: .lastEventAt)
    }
}

public enum MessageRole: String, Codable, Sendable, Equatable {
    case user
    case assistant
    case system

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let raw = (try? container.decode(String.self)) ?? "assistant"
        self = MessageRole(rawValue: raw) ?? .assistant
    }
}

public enum MessageSourceKind: String, Codable, Sendable, Equatable {
    case human
    case agent
    case compaction
    case task
    case systemMeta = "system_meta"

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        let raw = (try? container.decode(String.self)) ?? "agent"
        self = MessageSourceKind(rawValue: raw) ?? .agent
    }
}

public struct MessageHarnessMeta: Codable, Sendable, Equatable {
    public var model: String?
    public var turnId: String?
    public var sourceKind: MessageSourceKind?
    public var senderName: String?

    public init(model: String? = nil, turnId: String? = nil, sourceKind: MessageSourceKind? = nil, senderName: String? = nil) {
        self.model = model
        self.turnId = turnId
        self.sourceKind = sourceKind
        self.senderName = senderName
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        model = try c.decodeIfPresent(String.self, forKey: .model)
        turnId = try c.decodeIfPresent(String.self, forKey: .turnId)
        sourceKind = try? c.decodeIfPresent(MessageSourceKind.self, forKey: .sourceKind)
        senderName = try c.decodeIfPresent(String.self, forKey: .senderName)
    }
}

public struct UnifiedMessage: Codable, Identifiable, Sendable, Equatable {
    public var id: String
    public var role: MessageRole
    public var timestamp: Double
    public var blocks: [UnifiedBlock]
    public var streaming: Bool?
    public var error: String?
    public var harnessMeta: MessageHarnessMeta?

    public init(
        id: String = UUID().uuidString,
        role: MessageRole,
        timestamp: Double = Date().timeIntervalSince1970 * 1000.0,
        blocks: [UnifiedBlock],
        streaming: Bool? = nil,
        error: String? = nil,
        harnessMeta: MessageHarnessMeta? = nil
    ) {
        self.id = id
        self.role = role
        self.timestamp = timestamp
        self.blocks = blocks
        self.streaming = streaming
        self.error = error
        self.harnessMeta = harnessMeta
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decodeIfPresent(String.self, forKey: .id) ?? UUID().uuidString
        role = try c.decodeIfPresent(MessageRole.self, forKey: .role) ?? .assistant
        timestamp = try c.decodeIfPresent(Double.self, forKey: .timestamp) ?? 0
        blocks = try c.decodeIfPresent([UnifiedBlock].self, forKey: .blocks) ?? []
        streaming = try c.decodeIfPresent(Bool.self, forKey: .streaming)
        error = try c.decodeIfPresent(String.self, forKey: .error)
        harnessMeta = try c.decodeIfPresent(MessageHarnessMeta.self, forKey: .harnessMeta)
    }
}

public struct SessionStats: Codable, Sendable, Equatable {
    public var inputTokens: Int
    public var outputTokens: Int
    public var cacheReadTokens: Int
    public var cacheWriteTokens: Int
    public var totalTokens: Int
    public var contextUsedTokens: Int
    public var contextWindowTokens: Int?
    public var estimatedCostUsd: Double
    public var turnCount: Int

    public init(
        inputTokens: Int = 0,
        outputTokens: Int = 0,
        cacheReadTokens: Int = 0,
        cacheWriteTokens: Int = 0,
        totalTokens: Int = 0,
        contextUsedTokens: Int = 0,
        contextWindowTokens: Int? = nil,
        estimatedCostUsd: Double = 0,
        turnCount: Int = 0
    ) {
        self.inputTokens = inputTokens
        self.outputTokens = outputTokens
        self.cacheReadTokens = cacheReadTokens
        self.cacheWriteTokens = cacheWriteTokens
        self.totalTokens = totalTokens
        self.contextUsedTokens = contextUsedTokens
        self.contextWindowTokens = contextWindowTokens
        self.estimatedCostUsd = estimatedCostUsd
        self.turnCount = turnCount
    }

    /// More tokens in context than the reported window can hold means the window size is
    /// wrong (the host guessed it from the model name), so no percentage can be trusted.
    public var hasPlausibleContextWindow: Bool {
        guard let window = contextWindowTokens, window > 0 else { return false }
        return contextUsedTokens <= window
    }

    public var contextUsedPercent: Double? {
        guard let window = contextWindowTokens, window > 0, contextUsedTokens > 0, hasPlausibleContextWindow else { return nil }
        return min(100, (Double(contextUsedTokens) / Double(window)) * 100.0)
    }
}

public struct SessionTranscriptResult: Codable, Sendable, Equatable {
    public var sessionId: String
    public var messages: [UnifiedMessage]
    public var totalCount: Int
    public var hasMore: Bool
    public var sourceMtimeMs: Double
    public var liveActivity: LiveActivityState?
    public var stats: SessionStats?

    public init(
        sessionId: String,
        messages: [UnifiedMessage],
        totalCount: Int? = nil,
        hasMore: Bool = false,
        sourceMtimeMs: Double = Date().timeIntervalSince1970 * 1000.0,
        liveActivity: LiveActivityState? = nil,
        stats: SessionStats? = nil
    ) {
        self.sessionId = sessionId
        self.messages = messages
        self.totalCount = totalCount ?? messages.count
        self.hasMore = hasMore
        self.sourceMtimeMs = sourceMtimeMs
        self.liveActivity = liveActivity
        self.stats = stats
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId) ?? ""
        let msgs: [UnifiedMessage] = decodeLossyArray(from: c, forKey: .messages)
        messages = msgs
        totalCount = try c.decodeIfPresent(Int.self, forKey: .totalCount) ?? msgs.count
        hasMore = try c.decodeIfPresent(Bool.self, forKey: .hasMore) ?? false
        sourceMtimeMs = try c.decodeIfPresent(Double.self, forKey: .sourceMtimeMs) ?? 0
        liveActivity = try? c.decodeIfPresent(LiveActivityState.self, forKey: .liveActivity)
        stats = try? c.decodeIfPresent(SessionStats.self, forKey: .stats)
    }

    /// True when another transcript snapshot carries no visible change (e.g. idle WAL heartbeat).
    public func isEquivalentUpdate(to other: SessionTranscriptResult) -> Bool {
        sourceMtimeMs == other.sourceMtimeMs
            && messages.count == other.messages.count
            && messages.last?.id == other.messages.last?.id
            && liveActivity == other.liveActivity
            && stats == other.stats
    }
}

public struct StreamEvent: Codable, Sendable, Equatable {
    public enum Kind: String, Codable, Sendable {
        case start
        case delta
        case block
        case done
        case error
    }

    public var sessionId: String
    public var runId: String
    public var kind: Kind
    public var text: String?
    public var block: UnifiedBlock?
    public var error: String?

    public init(
        sessionId: String,
        runId: String,
        kind: Kind,
        text: String? = nil,
        block: UnifiedBlock? = nil,
        error: String? = nil
    ) {
        self.sessionId = sessionId
        self.runId = runId
        self.kind = kind
        self.text = text
        self.block = block
        self.error = error
    }
}

// MARK: - Folders, State & Settings

public struct SessionFolder: Codable, Identifiable, Sendable, Equatable {
    public var id: String
    public var name: String
    public var color: String
    public var order: Int

    public init(id: String, name: String, color: String = "#818cf8", order: Int = 0) {
        self.id = id
        self.name = name
        self.color = color
        self.order = order
    }
}

public struct SessionOverride: Codable, Sendable, Equatable {
    public var customTitle: String?
    public var folderId: String?
    public var pinned: Bool?
    public var pinnedToTop: Bool?
    public var tags: [String]?
    public var hidden: Bool?
}

public struct MobileApiSettings: Codable, Sendable, Equatable {
    public var enabled: Bool
    public var bindHost: String
    public var port: Int
    public var token: String

    public init(
        enabled: Bool = false,
        bindHost: String = "127.0.0.1",
        port: Int = 47890,
        token: String = ""
    ) {
        self.enabled = enabled
        self.bindHost = bindHost
        self.port = port
        self.token = token
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? false
        bindHost = try c.decodeIfPresent(String.self, forKey: .bindHost) ?? "127.0.0.1"
        port = try c.decodeIfPresent(Int.self, forKey: .port) ?? 47890
        token = try c.decodeIfPresent(String.self, forKey: .token) ?? ""
    }
}

public struct SuperHarnessSettings: Codable, Sendable, Equatable {
    public var sidebarGroupBy: SidebarGroupBy
    public var showArchived: Bool
    public var showHidden: Bool
    public var enabledHarnesses: [String: Bool]?
    public var defaultNewSessionCwd: String
    public var mobileApi: MobileApiSettings?
    /// Order of the harness gauges and of the harness sections in the All view, shared by clients.
    public var harnessOrder: [String]?
    /// Session ids of the pinned chats in display order, shared by clients. Pinned chats that
    /// are missing from it follow in their usual order; ids that are no longer pinned are ignored.
    public var pinnedOrder: [String]?

    public init(
        sidebarGroupBy: SidebarGroupBy = .native,
        showArchived: Bool = false,
        showHidden: Bool = false,
        enabledHarnesses: [String: Bool]? = nil,
        defaultNewSessionCwd: String = "~",
        mobileApi: MobileApiSettings? = nil
    ) {
        self.sidebarGroupBy = sidebarGroupBy
        self.showArchived = showArchived
        self.showHidden = showHidden
        self.enabledHarnesses = enabledHarnesses
        self.defaultNewSessionCwd = defaultNewSessionCwd
        self.mobileApi = mobileApi
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        sidebarGroupBy = (try? c.decodeIfPresent(SidebarGroupBy.self, forKey: .sidebarGroupBy)) ?? .native
        showArchived = try c.decodeIfPresent(Bool.self, forKey: .showArchived) ?? false
        showHidden = try c.decodeIfPresent(Bool.self, forKey: .showHidden) ?? false
        enabledHarnesses = try? c.decodeIfPresent([String: Bool].self, forKey: .enabledHarnesses)
        defaultNewSessionCwd = try c.decodeIfPresent(String.self, forKey: .defaultNewSessionCwd) ?? "~"
        mobileApi = try? c.decodeIfPresent(MobileApiSettings.self, forKey: .mobileApi)
        harnessOrder = try? c.decodeIfPresent([String].self, forKey: .harnessOrder)
        pinnedOrder = try? c.decodeIfPresent([String].self, forKey: .pinnedOrder)
    }
}

public struct SuperHarnessState: Codable, Sendable, Equatable {
    public var settings: SuperHarnessSettings
    public var folders: [SessionFolder]
    public var overrides: [String: SessionOverride]
    public var masterMessages: [UnifiedMessage]

    public init(
        settings: SuperHarnessSettings = SuperHarnessSettings(),
        folders: [SessionFolder] = [],
        overrides: [String: SessionOverride] = [:],
        masterMessages: [UnifiedMessage] = []
    ) {
        self.settings = settings
        self.folders = folders
        self.overrides = overrides
        self.masterMessages = masterMessages
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        settings = (try? c.decodeIfPresent(SuperHarnessSettings.self, forKey: .settings)) ?? SuperHarnessSettings()
        folders = decodeLossyArray(from: c, forKey: .folders)
        overrides = (try? c.decodeIfPresent([String: SessionOverride].self, forKey: .overrides)) ?? [:]
        masterMessages = decodeLossyArray(from: c, forKey: .masterMessages)
    }
}

// MARK: - Requests & Actions

public struct StartSessionRequest: Codable, Sendable, Equatable {
    public var harness: StartHarnessKind
    public var cwd: String
    public var title: String?
    public var prompt: String?
    public var model: String?
    public var reasoningEffort: String?
    public var remoteControl: Bool?
    public var tmuxSessionName: String?

    public init(
        harness: StartHarnessKind,
        cwd: String,
        title: String? = nil,
        prompt: String? = nil,
        model: String? = nil,
        reasoningEffort: String? = nil,
        remoteControl: Bool? = nil,
        tmuxSessionName: String? = nil
    ) {
        self.harness = harness
        self.cwd = cwd
        self.title = title
        self.prompt = prompt
        self.model = model
        self.reasoningEffort = reasoningEffort
        self.remoteControl = remoteControl
        self.tmuxSessionName = tmuxSessionName
    }
}

public struct StartSessionResponse: Codable, Sendable, Equatable {
    public var ok: Bool
    public var sessionId: String?
    public var error: String?

    public init(ok: Bool, sessionId: String? = nil, error: String? = nil) {
        self.ok = ok
        self.sessionId = sessionId
        self.error = error
    }
}

public struct SendMessageResult: Codable, Sendable, Equatable {
    public var ok: Bool
    public var error: String?
    public var dispatchedVia: String?
    public var runId: String?

    public init(ok: Bool, error: String? = nil, dispatchedVia: String? = nil, runId: String? = nil) {
        self.ok = ok
        self.error = error
        self.dispatchedVia = dispatchedVia
        self.runId = runId
    }
}

public struct OrganizeAction: Codable, Sendable, Equatable {
    public enum ActionType: String, Codable, Sendable {
        case createFolder = "create_folder"
        case deleteFolder = "delete_folder"
        case renameFolder = "rename_folder"
        case reorderFolders = "reorder_folders"
        case assignFolder = "assign_folder"
        case pin
        case unpin
        case pinTop = "pin_top"
        case unpinTop = "unpin_top"
        case renameSession = "rename_session"
        case tagSession = "tag_session"
        case hideSession = "hide_session"
        case unhideSession = "unhide_session"
        case setModel = "set_model"
    }

    public var type: ActionType
    public var folderId: String?
    public var folderName: String?
    public var folderColor: String?
    public var folderIds: [String]?
    public var sessionId: String?
    public var title: String?
    public var tags: [String]?
    public var model: String?
    public var reasoningEffort: String?

    public init(
        type: ActionType,
        folderId: String? = nil,
        folderName: String? = nil,
        folderColor: String? = nil,
        folderIds: [String]? = nil,
        sessionId: String? = nil,
        title: String? = nil,
        tags: [String]? = nil,
        model: String? = nil,
        reasoningEffort: String? = nil
    ) {
        self.type = type
        self.folderId = folderId
        self.folderName = folderName
        self.folderColor = folderColor
        self.folderIds = folderIds
        self.sessionId = sessionId
        self.title = title
        self.tags = tags
        self.model = model
        self.reasoningEffort = reasoningEffort
    }
}

public struct OrganizeResponse: Codable, Sendable, Equatable {
    public var ok: Bool
    public var folders: [SessionFolder]?
    public var state: SuperHarnessState?

    public init(ok: Bool = true, folders: [SessionFolder]? = nil, state: SuperHarnessState? = nil) {
        self.ok = ok
        self.folders = folders
        self.state = state
    }
}

public struct FoldersResponse: Codable, Sendable, Equatable {
    public var folders: [SessionFolder]
    public var sidebarGroupBy: SidebarGroupBy?
    public var sessionFolderCounts: [String: Int]?

    public init(
        folders: [SessionFolder] = [],
        sidebarGroupBy: SidebarGroupBy? = nil,
        sessionFolderCounts: [String: Int]? = nil
    ) {
        self.folders = folders
        self.sidebarGroupBy = sidebarGroupBy
        self.sessionFolderCounts = sessionFolderCounts
    }
}

public struct UpdateSettingsResponse: Codable, Sendable, Equatable {
    public var ok: Bool
    public var settings: SuperHarnessSettings?

    public init(ok: Bool = true, settings: SuperHarnessSettings? = nil) {
        self.ok = ok
        self.settings = settings
    }
}

public struct ArchiveResponse: Codable, Sendable, Equatable {
    public var ok: Bool
    public var method: String?
    public var error: String?

    public init(ok: Bool, method: String? = nil, error: String? = nil) {
        self.ok = ok
        self.method = method
        self.error = error
    }
}

public enum HarnessControlAction: String, Codable, Sendable {
    case startRemote = "start_remote"
    case stopRemote = "stop_remote"
    case openDesktop = "open_desktop"
}

public struct ControlHarnessResponse: Codable, Sendable, Equatable {
    public var ok: Bool
    public var output: String?
    public var error: String?

    public init(ok: Bool, output: String? = nil, error: String? = nil) {
        self.ok = ok
        self.output = output
        self.error = error
    }
}

// MARK: - Harness Catalog (Models, Reasoning Effort & Projects)

public struct HarnessModelOption: Codable, Identifiable, Sendable, Equatable, Hashable {
    public var id: String
    public var label: String
    public var description: String?
    public var isDefault: Bool?
    public var group: String?
    public var reasoningLevels: [String]?
    public var defaultReasoningLevel: String?

    public init(
        id: String,
        label: String,
        description: String? = nil,
        isDefault: Bool? = nil,
        group: String? = nil,
        reasoningLevels: [String]? = nil,
        defaultReasoningLevel: String? = nil
    ) {
        self.id = id
        self.label = label
        self.description = description
        self.isDefault = isDefault
        self.group = group
        self.reasoningLevels = reasoningLevels
        self.defaultReasoningLevel = defaultReasoningLevel
    }
}

public struct HarnessProjectOption: Codable, Identifiable, Sendable, Equatable, Hashable {
    public var id: String { path }
    public var name: String
    public var path: String
    public var harnesses: [HarnessGroup]
    public var lastUsedAt: Double?

    public init(name: String, path: String, harnesses: [HarnessGroup] = HarnessGroup.allCases, lastUsedAt: Double? = nil) {
        self.name = name
        self.path = path
        self.harnesses = harnesses
        self.lastUsedAt = lastUsedAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        path = try c.decode(String.self, forKey: .path)
        let rawHarnesses = (try? c.decodeIfPresent([String].self, forKey: .harnesses)) ?? []
        harnesses = rawHarnesses.compactMap { HarnessGroup(rawValue: $0) }
        lastUsedAt = try c.decodeIfPresent(Double.self, forKey: .lastUsedAt)
    }
}

public struct HarnessCatalog: Codable, Sendable, Equatable {
    public var models: [String: [HarnessModelOption]]
    public var defaultReasoningEffort: [String: String]?
    public var projects: [HarnessProjectOption]
    public var updatedAt: Double

    public init(
        models: [HarnessGroup: [HarnessModelOption]],
        defaultReasoningEffort: [HarnessGroup: String]? = nil,
        projects: [HarnessProjectOption],
        updatedAt: Double = Date().timeIntervalSince1970 * 1000.0
    ) {
        self.models = Dictionary(uniqueKeysWithValues: models.map { ($0.key.rawValue, $0.value) })
        self.defaultReasoningEffort = defaultReasoningEffort.map {
            Dictionary(uniqueKeysWithValues: $0.map { ($0.key.rawValue, $0.value) })
        }
        self.projects = projects
        self.updatedAt = updatedAt
    }

    public func models(for group: HarnessGroup) -> [HarnessModelOption] {
        models[group.rawValue] ?? []
    }

    public func defaultReasoning(for group: HarnessGroup) -> String? {
        defaultReasoningEffort?[group.rawValue]
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let modelsContainer = try? c.nestedContainer(keyedBy: AnyCodingKey.self, forKey: .models) {
            var decodedModels: [String: [HarnessModelOption]] = [:]
            for key in modelsContainer.allKeys {
                decodedModels[key.stringValue] = decodeLossyArray(from: modelsContainer, forKey: key)
            }
            models = decodedModels
        } else {
            models = [:]
        }
        defaultReasoningEffort = try? c.decodeIfPresent([String: String].self, forKey: .defaultReasoningEffort)
        projects = decodeLossyArray(from: c, forKey: .projects)
        updatedAt = try c.decodeIfPresent(Double.self, forKey: .updatedAt) ?? 0
    }
}

// MARK: - Usage Quotas & Spend

public struct UsageQuotaWindow: Codable, Identifiable, Sendable, Equatable {
    public var id: String
    public var label: String
    public var usedPercent: Double
    public var resetsAt: Double?
    public var delta24h: Double?
    public var windowMinutes: Double?

    public init(
        id: String,
        label: String,
        usedPercent: Double,
        resetsAt: Double? = nil,
        delta24h: Double? = nil,
        windowMinutes: Double? = nil
    ) {
        self.id = id
        self.label = label
        self.usedPercent = usedPercent
        self.resetsAt = resetsAt
        self.delta24h = delta24h
        self.windowMinutes = windowMinutes
    }
}

public struct DailySpendPoint: Codable, Identifiable, Sendable, Equatable {
    public var id: String { date }
    public var date: String
    public var dayLabel: String
    public var spendUsd: Double
    public var tokens: Int

    public init(date: String, dayLabel: String, spendUsd: Double, tokens: Int) {
        self.date = date
        self.dayLabel = dayLabel
        self.spendUsd = spendUsd
        self.tokens = tokens
    }
}

public struct HarnessUsageSummary: Codable, Identifiable, Sendable, Equatable {
    public var id: HarnessGroup { harness }
    public var harness: HarnessGroup
    public var updatedAt: Double
    public var planLabel: String?
    public var barPercent: Double?
    public var barIsEstimated: Bool?
    public var windows: [UsageQuotaWindow]
    public var creditsBalance: Double?
    public var spend5hUsd: Double
    public var spend24hUsd: Double
    public var spend7dUsd: Double
    public var spend14dUsd: Double
    public var tokens7d: Int
    public var dailySpend7d: [DailySpendPoint]
    public var spendIsEstimated: Bool
    public var note: String?

    public init(
        harness: HarnessGroup,
        updatedAt: Double = Date().timeIntervalSince1970 * 1000.0,
        planLabel: String? = nil,
        barPercent: Double? = nil,
        barIsEstimated: Bool? = nil,
        windows: [UsageQuotaWindow] = [],
        creditsBalance: Double? = nil,
        spend5hUsd: Double = 0,
        spend24hUsd: Double = 0,
        spend7dUsd: Double = 0,
        spend14dUsd: Double = 0,
        tokens7d: Int = 0,
        dailySpend7d: [DailySpendPoint] = [],
        spendIsEstimated: Bool = true,
        note: String? = nil
    ) {
        self.harness = harness
        self.updatedAt = updatedAt
        self.planLabel = planLabel
        self.barPercent = barPercent
        self.barIsEstimated = barIsEstimated
        self.windows = windows
        self.creditsBalance = creditsBalance
        self.spend5hUsd = spend5hUsd
        self.spend24hUsd = spend24hUsd
        self.spend7dUsd = spend7dUsd
        self.spend14dUsd = spend14dUsd
        self.tokens7d = tokens7d
        self.dailySpend7d = dailySpend7d
        self.spendIsEstimated = spendIsEstimated
        self.note = note
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        harness = try c.decode(HarnessGroup.self, forKey: .harness)
        updatedAt = try c.decodeIfPresent(Double.self, forKey: .updatedAt) ?? 0
        planLabel = try c.decodeIfPresent(String.self, forKey: .planLabel)
        barPercent = try c.decodeIfPresent(Double.self, forKey: .barPercent)
        barIsEstimated = try c.decodeIfPresent(Bool.self, forKey: .barIsEstimated)
        windows = try c.decodeIfPresent([UsageQuotaWindow].self, forKey: .windows) ?? []
        creditsBalance = try c.decodeIfPresent(Double.self, forKey: .creditsBalance)
        spend5hUsd = try c.decodeIfPresent(Double.self, forKey: .spend5hUsd) ?? 0
        spend24hUsd = try c.decodeIfPresent(Double.self, forKey: .spend24hUsd) ?? 0
        spend7dUsd = try c.decodeIfPresent(Double.self, forKey: .spend7dUsd) ?? 0
        spend14dUsd = try c.decodeIfPresent(Double.self, forKey: .spend14dUsd) ?? 0
        tokens7d = try c.decodeIfPresent(Int.self, forKey: .tokens7d) ?? 0
        dailySpend7d = try c.decodeIfPresent([DailySpendPoint].self, forKey: .dailySpend7d) ?? []
        spendIsEstimated = try c.decodeIfPresent(Bool.self, forKey: .spendIsEstimated) ?? true
        note = try c.decodeIfPresent(String.self, forKey: .note)
    }
}

public struct UsageSnapshot: Codable, Sendable, Equatable {
    public var antigravity: HarnessUsageSummary
    public var codex: HarnessUsageSummary
    public var claude: HarnessUsageSummary
    public var muse: HarnessUsageSummary?
    public var pi: HarnessUsageSummary?

    public init(
        antigravity: HarnessUsageSummary,
        codex: HarnessUsageSummary,
        claude: HarnessUsageSummary,
        muse: HarnessUsageSummary? = nil,
        pi: HarnessUsageSummary? = nil
    ) {
        self.antigravity = antigravity
        self.codex = codex
        self.claude = claude
        self.muse = muse
        self.pi = pi
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: AnyCodingKey.self)
        var parsed: [HarnessGroup: HarnessUsageSummary] = [:]
        for key in c.allKeys {
            guard let group = HarnessGroup(rawValue: key.stringValue),
                  let summary = try? c.decode(HarnessUsageSummary.self, forKey: key) else {
                continue
            }
            parsed[group] = summary
        }
        antigravity = parsed[.antigravity] ?? HarnessUsageSummary(harness: .antigravity)
        codex = parsed[.codex] ?? HarnessUsageSummary(harness: .codex)
        claude = parsed[.claude] ?? HarnessUsageSummary(harness: .claude)
        muse = parsed[.muse]
        pi = parsed[.pi]
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(antigravity, forKey: .antigravity)
        try c.encode(codex, forKey: .codex)
        try c.encode(claude, forKey: .claude)
        try c.encodeIfPresent(muse, forKey: .muse)
        try c.encodeIfPresent(pi, forKey: .pi)
    }

    private enum CodingKeys: String, CodingKey {
        case antigravity, codex, claude, muse, pi
    }

    public subscript(_ group: HarnessGroup) -> HarnessUsageSummary {
        switch group {
        case .antigravity: return antigravity
        case .codex: return codex
        case .claude: return claude
        case .muse: return muse ?? HarnessUsageSummary(harness: .muse)
        case .pi: return pi ?? HarnessUsageSummary(harness: .pi)
        }
    }

    public var allSummaries: [HarnessUsageSummary] {
        var list = [antigravity, codex, claude]
        if let muse {
            list.append(muse)
        }
        if let pi {
            list.append(pi)
        }
        return list
    }
}

// MARK: - Usage Pace & Formatting Utilities

public struct WindowPaceInfo: Sendable, Equatable {
    public let elapsedPercent: Double
    public let projectedPercent: Int?
    public let windowWord: String
}

public enum UsageMetrics {
    public static func pickHeroWindow(_ windows: [UsageQuotaWindow]) -> (hero: UsageQuotaWindow?, secondary: [UsageQuotaWindow]) {
        guard !windows.isEmpty else { return (nil, []) }
        let canonicalPrimaryIds: Set<String> = ["five_hour", "weekly", "primary"]
        let canonicalPool = windows.filter { canonicalPrimaryIds.contains($0.id) }
        let primaryPool = canonicalPool.isEmpty ? windows.filter { $0.id != "extra" } : canonicalPool
        let candidates = primaryPool.isEmpty ? windows : primaryPool

        var hero = candidates[0]
        for w in candidates {
            if w.usedPercent > hero.usedPercent {
                hero = w
            } else if w.usedPercent == hero.usedPercent && w.id == "weekly" && hero.id != "weekly" {
                hero = w
            }
        }
        return (hero, windows.filter { $0.id != hero.id })
    }

    public static func computeWindowPace(_ window: UsageQuotaWindow, nowMs: Double = Date().timeIntervalSince1970 * 1000.0) -> WindowPaceInfo? {
        guard let resetsAt = window.resetsAt,
              let windowMinutes = window.windowMinutes,
              windowMinutes > 0 else {
            return nil
        }
        let windowMs = windowMinutes * 60_000.0
        let remainingMs = resetsAt - nowMs
        guard remainingMs > 0, remainingMs <= windowMs else { return nil }
        let elapsedMs = windowMs - remainingMs
        let elapsedPercent = min(100, max(0, (elapsedMs / windowMs) * 100.0))
        let windowWord: String
        if windowMinutes >= 7 * 1440 {
            windowWord = "week"
        } else if windowMinutes >= 1440 {
            windowWord = "day"
        } else {
            windowWord = "\(Int((windowMinutes / 60.0).rounded()))h window"
        }
        let projected: Int?
        if elapsedPercent >= 5, elapsedPercent <= 98, window.usedPercent > 0 {
            projected = Int(((window.usedPercent / elapsedPercent) * 100.0).rounded())
        } else {
            projected = nil
        }
        return WindowPaceInfo(elapsedPercent: elapsedPercent, projectedPercent: projected, windowWord: windowWord)
    }

    public static func formatUsd(_ n: Double) -> String {
        if n >= 1000 { return String(format: "$%.1fk", n / 1000.0) }
        if n >= 10 { return "$\(Int(n.rounded()))" }
        if n >= 1 { return String(format: "$%.1f", n) }
        if n == 0 { return "$0" }
        return String(format: "$%.2f", n)
    }

    public static func formatTokens(_ n: Int) -> String {
        if n >= 1_000_000_000 { return String(format: "%.1fB", Double(n) / 1_000_000_000.0) }
        if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000.0) }
        if n >= 1_000 { return "\(Int((Double(n) / 1_000.0).rounded()))k" }
        return "\(n)"
    }

    public static func formatResetLabel(_ resetsAtMs: Double?, nowMs: Double = Date().timeIntervalSince1970 * 1000.0) -> String? {
        guard let resetsAtMs else { return nil }
        let diff = resetsAtMs - nowMs
        if diff <= 0 { return "resets soon" }
        let totalMin = Int((diff / 60_000.0).rounded())
        if totalMin < 60 { return "resets in \(totalMin)m" }
        if totalMin < 24 * 60 {
            let hrs = totalMin / 60
            let mins = totalMin % 60
            return mins > 0 ? "resets in \(hrs)h \(mins)m" : "resets in \(hrs)h"
        }
        let date = Date(timeIntervalSince1970: resetsAtMs / 1000.0)
        let fmt = DateFormatter()
        fmt.dateFormat = "EEE h:mm a"
        return "resets \(fmt.string(from: date))"
    }

    public static func formatUpdatedAgo(_ updatedAtMs: Double, nowMs: Double = Date().timeIntervalSince1970 * 1000.0) -> String {
        let diffSec = max(0, Int((nowMs - updatedAtMs) / 1000.0))
        if diffSec < 60 { return "just now" }
        let mins = diffSec / 60
        if mins < 60 { return "\(mins)m ago" }
        let hrs = mins / 60
        if hrs < 24 { return "\(hrs)h ago" }
        return "\(hrs / 24)d ago"
    }
}

// MARK: - API Envelope Models

public struct DictationStatusResponse: Codable, Sendable, Equatable {
    public var ok: Bool
    public var configured: Bool
    public var url: String?
    public var healthy: Bool
    public var model: String?
    public var error: String?

    public init(
        ok: Bool = true,
        configured: Bool = false,
        url: String? = nil,
        healthy: Bool = false,
        model: String? = nil,
        error: String? = nil
    ) {
        self.ok = ok
        self.configured = configured
        self.url = url
        self.healthy = healthy
        self.model = model
        self.error = error
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = try c.decodeIfPresent(Bool.self, forKey: .ok) ?? false
        configured = try c.decodeIfPresent(Bool.self, forKey: .configured) ?? false
        url = try c.decodeIfPresent(String.self, forKey: .url)
        healthy = try c.decodeIfPresent(Bool.self, forKey: .healthy) ?? false
        model = try c.decodeIfPresent(String.self, forKey: .model)
        error = try c.decodeIfPresent(String.self, forKey: .error)
    }
}

public struct DictationResult: Codable, Sendable, Equatable {
    public var ok: Bool
    public var text: String?
    public var error: String?

    public init(ok: Bool, text: String? = nil, error: String? = nil) {
        self.ok = ok
        self.text = text
        self.error = error
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ok = try c.decodeIfPresent(Bool.self, forKey: .ok) ?? false
        text = try c.decodeIfPresent(String.self, forKey: .text)
        error = try c.decodeIfPresent(String.self, forKey: .error)
    }
}

public struct HealthCheckResponse: Codable, Sendable, Equatable {
    public var ok: Bool
    public var protocolVersion: Int?
    public var seq: Int?
    public var uptimeMs: Double?

    public init(ok: Bool = true, protocolVersion: Int? = nil, seq: Int? = nil, uptimeMs: Double? = nil) {
        self.ok = ok
        self.protocolVersion = protocolVersion
        self.seq = seq
        self.uptimeMs = uptimeMs
    }
}

public struct BootstrapPayload: Codable, Sendable, Equatable {
    public var protocolVersion: Int?
    public var seq: Int?
    public var harnesses: [HarnessDetection]
    public var sessions: [UnifiedSession]
    public var activeWorkingSessionIds: [String]?
    public var state: SuperHarnessState?
    public var usage: UsageSnapshot?
    public var catalog: HarnessCatalog?

    public init(
        protocolVersion: Int? = nil,
        seq: Int? = nil,
        harnesses: [HarnessDetection],
        sessions: [UnifiedSession],
        activeWorkingSessionIds: [String]? = nil,
        state: SuperHarnessState? = nil,
        usage: UsageSnapshot? = nil,
        catalog: HarnessCatalog? = nil
    ) {
        self.protocolVersion = protocolVersion
        self.seq = seq
        self.harnesses = harnesses
        self.sessions = sessions
        self.activeWorkingSessionIds = activeWorkingSessionIds
        self.state = state
        self.usage = usage
        self.catalog = catalog
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        protocolVersion = try c.decodeIfPresent(Int.self, forKey: .protocolVersion)
        seq = try c.decodeIfPresent(Int.self, forKey: .seq)
        harnesses = decodeLossyArray(from: c, forKey: .harnesses)
        sessions = decodeLossyArray(from: c, forKey: .sessions)
        activeWorkingSessionIds = try? c.decodeIfPresent([String].self, forKey: .activeWorkingSessionIds)
        state = try? c.decodeIfPresent(SuperHarnessState.self, forKey: .state)
        usage = try? c.decodeIfPresent(UsageSnapshot.self, forKey: .usage)
        catalog = try? c.decodeIfPresent(HarnessCatalog.self, forKey: .catalog)
    }
}

public struct SessionsEnvelope: Codable, Sendable, Equatable {
    public var count: Int?
    public var harnesses: [HarnessDetection]?
    public var sessions: [UnifiedSession]
    public var activeWorkingSessionIds: [String]?

    public init(
        count: Int? = nil,
        harnesses: [HarnessDetection]? = nil,
        sessions: [UnifiedSession],
        activeWorkingSessionIds: [String]? = nil
    ) {
        self.count = count
        self.harnesses = harnesses
        self.sessions = sessions
        self.activeWorkingSessionIds = activeWorkingSessionIds
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        count = try c.decodeIfPresent(Int.self, forKey: .count)
        if c.contains(.harnesses) {
            harnesses = decodeLossyArray(from: c, forKey: .harnesses)
        } else {
            harnesses = nil
        }
        sessions = decodeLossyArray(from: c, forKey: .sessions)
        activeWorkingSessionIds = try? c.decodeIfPresent([String].self, forKey: .activeWorkingSessionIds)
    }
}

public struct SessionsDeltaEnvelope: Codable, Sendable, Equatable {
    public var upserts: [UnifiedSession]
    public var removedIds: [String]
    public var order: [String]?
    public var harnesses: [HarnessDetection]?
    public var activeWorkingSessionIds: [String]?

    public init(
        upserts: [UnifiedSession] = [],
        removedIds: [String] = [],
        order: [String]? = nil,
        harnesses: [HarnessDetection]? = nil,
        activeWorkingSessionIds: [String]? = nil
    ) {
        self.upserts = upserts
        self.removedIds = removedIds
        self.order = order
        self.harnesses = harnesses
        self.activeWorkingSessionIds = activeWorkingSessionIds
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        upserts = decodeLossyArray(from: c, forKey: .upserts)
        removedIds = (try? c.decodeIfPresent([String].self, forKey: .removedIds)) ?? []
        order = try? c.decodeIfPresent([String].self, forKey: .order)
        if c.contains(.harnesses) {
            harnesses = decodeLossyArray(from: c, forKey: .harnesses)
        } else {
            harnesses = nil
        }
        activeWorkingSessionIds = try? c.decodeIfPresent([String].self, forKey: .activeWorkingSessionIds)
    }
}

public struct ActivityUpdateEnvelope: Codable, Sendable, Equatable {
    public var workingSessionIds: [String]

    public init(workingSessionIds: [String] = []) {
        self.workingSessionIds = workingSessionIds
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        workingSessionIds = (try? c.decodeIfPresent([String].self, forKey: .workingSessionIds)) ?? []
    }
}

public struct PendingOutgoingMessage: Identifiable, Sendable, Equatable {
    public enum DeliveryState: Sendable, Equatable {
        case sending
        case sent
        case failed(String)
    }

    public let id: String
    public let text: String
    public let attachments: [ImageAttachment]
    public let createdAt: Double
    public let mode: SendMode
    public var state: DeliveryState
    /// ID of the last real persisted message in the transcript when this pending bubble was enqueued.
    /// Used for clock-skew-proof deduplication when the host echoes the persisted user message back.
    public let baselineLastPersistedId: String?

    public init(
        id: String = UUID().uuidString,
        text: String,
        attachments: [ImageAttachment] = [],
        createdAt: Double = Date().timeIntervalSince1970 * 1000.0,
        mode: SendMode = .steer,
        state: DeliveryState = .sending,
        baselineLastPersistedId: String? = nil
    ) {
        self.id = id
        self.text = text
        self.attachments = attachments
        self.createdAt = createdAt
        self.mode = mode
        self.state = state
        self.baselineLastPersistedId = baselineLastPersistedId
    }

    public var messageId: String { "pending-\(id)" }

    public func asUnifiedMessage() -> UnifiedMessage {
        var blocks: [UnifiedBlock] = []
        if !text.isEmpty {
            blocks.append(.text(text: text))
        }
        for att in attachments {
            blocks.append(.image(path: att.path, name: att.name, dataUrl: att.previewDataUrl))
        }
        let errorText: String?
        if case .failed(let msg) = state {
            errorText = msg
        } else {
            errorText = nil
        }
        return UnifiedMessage(
            id: messageId,
            role: .user,
            timestamp: createdAt,
            blocks: blocks,
            streaming: nil,
            error: errorText,
            harnessMeta: nil
        )
    }
}

public struct HarnessesEnvelope: Codable, Sendable, Equatable {
    public var harnesses: [HarnessDetection]

    public init(harnesses: [HarnessDetection]) {
        self.harnesses = harnesses
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        harnesses = decodeLossyArray(from: c, forKey: .harnesses)
    }
}

public enum ConnectionMode: String, Codable, Sendable, Equatable {
    case demo
    case live
}

public enum ConnectionHealth: Sendable, Equatable {
    case demo
    case connecting
    case connected
    case offline(String)

    public var label: String {
        switch self {
        case .demo: return "Demo"
        case .connecting: return "Connecting"
        case .connected: return "Live"
        case .offline: return "Offline"
        }
    }
}

// MARK: - Cross-Harness Session Link Parser & Resolver (Desktop parity)

public struct ParsedSessionLink: Sendable, Equatable {
    public let unifiedId: String?
    public let harnessHint: HarnessGroup?
    public let nativeId: String

    public init(unifiedId: String? = nil, harnessHint: HarnessGroup? = nil, nativeId: String) {
        self.unifiedId = unifiedId
        self.harnessHint = harnessHint
        self.nativeId = nativeId
    }
}

public enum SessionLinkResolver {
    private static let schemeHints: [String: HarnessGroup?] = [
        "conversation": .antigravity,
        "antigravity": .antigravity,
        "agy": .antigravity,
        "codex": .codex,
        "claude": .claude,
        "muse": .muse,
        "pi": .pi,
        "session": nil,
        "sh": nil,
        "super-harness": nil,
    ]

    private static let wrapperSegments: Set<String> = [
        "session", "sessions", "thread", "threads", "conversation", "conversations", "chat", "chats",
    ]

    public static func parse(_ href: String) -> ParsedSessionLink? {
        let trimmed = href.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let sep = trimmed.range(of: "://") else { return nil }
        let scheme = String(trimmed[..<sep.lowerBound]).lowercased()
        guard let hintOpt = schemeHints[scheme] else { return nil }

        var rest = String(trimmed[sep.upperBound...])
        if let qIdx = rest.firstIndex(where: { $0 == "?" || $0 == "#" }) {
            rest = String(rest[..<qIdx])
        }
        rest = rest.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        guard !rest.isEmpty else { return nil }

        let decoded = rest.removingPercentEncoding ?? rest
        let segments = decoded.split(separator: "/").map(String.init).filter { !$0.isEmpty }
        guard !segments.isEmpty else { return nil }

        var idPart = segments[0]
        if segments.count >= 2 && wrapperSegments.contains(segments[0].lowercased()) {
            idPart = segments[1]
        } else if segments.count > 1 {
            idPart = segments[segments.count - 1]
        }
        idPart = idPart.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !idPart.isEmpty else { return nil }

        if let colon = idPart.firstIndex(of: ":"), colon > idPart.startIndex {
            let prefixStr = String(idPart[..<colon]).lowercased()
            let native = String(idPart[idPart.index(after: colon)...]).trimmingCharacters(in: .whitespacesAndNewlines)
            if let group = HarnessGroup(rawValue: prefixStr), !native.isEmpty {
                return ParsedSessionLink(
                    unifiedId: "\(group.rawValue):\(native)",
                    harnessHint: group,
                    nativeId: native
                )
            }
        }

        return ParsedSessionLink(unifiedId: nil, harnessHint: hintOpt, nativeId: idPart)
    }

    public static func resolve(_ href: String, in sessions: [UnifiedSession]) -> UnifiedSession? {
        guard let parsed = parse(href) else { return nil }
        let targetNative = parsed.nativeId.lowercased()

        if let targetUnified = parsed.unifiedId?.lowercased(),
           let exact = sessions.first(where: { $0.id.lowercased() == targetUnified }) {
            return exact
        }

        if let hint = parsed.harnessHint,
           let hinted = sessions.first(where: { $0.harness.harnessGroup == hint && $0.nativeId.lowercased() == targetNative }) {
            return hinted
        }

        if let byNative = sessions.first(where: { $0.nativeId.lowercased() == targetNative }) {
            return byNative
        }

        if targetNative.count >= 8 {
            let prefixMatches = sessions.filter { s in
                let matchesHint = (parsed.harnessHint == nil || s.harness.harnessGroup == parsed.harnessHint)
                return matchesHint && s.nativeId.lowercased().hasPrefix(targetNative)
            }
            if prefixMatches.count == 1 {
                return prefixMatches[0]
            }
        }

        return nil
    }
}

// MARK: - Reasoning Effort Policy

/// Which thinking-effort levels the app offers and which one it picks by default. The most
/// expensive levels ("max", "ultra") are opt-in: unless the person enables them in Settings
/// they are neither offered nor chosen as a default, even when the host suggests one.
public enum ReasoningEffortPolicy {
    public static func isExtreme(_ level: String) -> Bool {
        let l = level.lowercased()
        return l == "max" || l == "maximum" || l.hasPrefix("ultra")
    }

    /// Levels to show in a picker. `current` stays listed even when it is extreme, so a
    /// session already running at that level shows its real setting.
    public static func offered(_ levels: [String], allowExtreme: Bool, keeping current: String? = nil) -> [String] {
        guard !allowExtreme else { return levels }
        return levels.filter { !isExtreme($0) || $0.lowercased() == current?.lowercased() }
    }

    /// The level a new session or a model switch starts with: the preferred level when it is
    /// allowed, otherwise the highest allowed one.
    public static func defaultLevel(from levels: [String], preferred: String?, allowExtreme: Bool) -> String? {
        let allowed = offered(levels, allowExtreme: allowExtreme)
        if let preferred, let match = allowed.first(where: { $0.lowercased() == preferred.lowercased() }) {
            return match
        }
        return allowed.last ?? levels.first
    }
}

// MARK: - Harness Order

/// Pure helpers for the order of the pinned chats.
public enum PinnedOrder {
    /// `ids` (already in their usual order) rearranged by `order`: the ones `order` lists come
    /// first in that order, the rest follow as they were.
    public static func arranged(_ ids: [String], by order: [String]) -> [String] {
        let present = Set(ids)
        var seen = Set<String>()
        var result = order.filter { present.contains($0) && seen.insert($0).inserted }
        result.append(contentsOf: ids.filter { !seen.contains($0) })
        return result
    }

    /// The full order after the rows on screen were reordered. `visible` is the subset on
    /// screen (a harness filter or search may hide some pins); the hidden pins keep their slots.
    public static func afterMove(full: [String], visible: [String], fromOffsets: IndexSet, toOffset: Int) -> [String] {
        var moved = visible
        moved.move(fromOffsets: fromOffsets, toOffset: toOffset)
        let visibleSet = Set(visible)
        var iterator = moved.makeIterator()
        return full.map { visibleSet.contains($0) ? (iterator.next() ?? $0) : $0 }
    }

    /// The full order after `id` was dropped at `visibleIndex` among the rows on screen.
    public static func afterInsert(_ id: String, atVisibleIndex visibleIndex: Int, full: [String], visible: [String]) -> [String] {
        var next = full.filter { $0 != id }
        let others = visible.filter { $0 != id }
        if visibleIndex < others.count, let anchor = next.firstIndex(of: others[max(0, visibleIndex)]) {
            next.insert(id, at: anchor)
        } else if let last = others.last, let anchor = next.firstIndex(of: last) {
            next.insert(id, at: anchor + 1)
        } else {
            next.append(id)
        }
        return next
    }
}

public enum HarnessOrder {
    /// A complete order from a stored or host-sent list: unknown names and repeats are dropped,
    /// and any harness missing from the list follows in the default order.
    public static func normalized(_ raw: [String]?) -> [HarnessGroup] {
        var result: [HarnessGroup] = []
        for name in raw ?? [] {
            if let group = HarnessGroup(rawValue: name.lowercased()), !result.contains(group) {
                result.append(group)
            }
        }
        for group in HarnessGroup.allCases where !result.contains(group) {
            result.append(group)
        }
        return result
    }

    /// Moves `dragged` to the position `target` currently has, shifting the others.
    public static func moving(_ dragged: HarnessGroup, onto target: HarnessGroup, in order: [HarnessGroup]) -> [HarnessGroup] {
        guard dragged != target,
              let from = order.firstIndex(of: dragged),
              let to = order.firstIndex(of: target) else { return order }
        var next = order
        next.remove(at: from)
        next.insert(dragged, at: to)
        return next
    }
}
