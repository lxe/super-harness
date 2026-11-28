export type HarnessKind =
  | 'master'
  | 'codex'
  | 'claude-tmux'
  | 'claude-desktop'
  | 'claude-cli'
  | 'antigravity'
  | 'muse'
  | 'pi';

export type HarnessGroup = 'codex' | 'claude' | 'antigravity' | 'muse' | 'pi';

export type SessionStatus =
  | 'running'
  | 'idle'
  | 'waiting_input'
  | 'stopped'
  | 'archived';

export interface HarnessDetection {
  id: HarnessGroup;
  name: string;
  installed: boolean;
  binaryPath: string | null;
  version: string | null;
  runningProcesses: number;
  desktopAppRunning: boolean;
  daemonRunning: boolean;
  remoteControlEnabled: boolean;
  activeSessionCount: number;
  totalSessionCount: number;
  capabilities: {
    canStartNew: boolean;
    canResume: boolean;
    canTmuxMirror: boolean;
    canControlDaemon: boolean;
  };
  notes?: string;
  /** Installed vs latest version and how to update (Superharness checks every few hours). */
  update?: HarnessUpdateInfo;
}

/** Update status for one harness, attached to its HarnessDetection. */
export interface HarnessUpdateInfo {
  /** Installed version, normalized (e.g. `0.172.0`, `1.4.25-R9361.1`). */
  current: string | null;
  /** Latest available version; null when it can't be checked. */
  latest: string | null;
  updateAvailable: boolean;
  /** When `latest` was last checked (ms). */
  checkedAt: number | null;
  /** Where `latest` comes from, for people (e.g. `npm registry (@openai/codex)`). */
  latestSource?: string;
  /** `command`: Superharness can run the updater. `manual`: shows `manualHint` instead. */
  method: 'command' | 'manual';
  /** The commands the Update button runs, for display. */
  command?: string;
  manualHint?: string;
  /** The harness also updates itself (e.g. on launch). */
  selfUpdating?: string;
  /** A long-running daemon whose version differs from the installed CLI. */
  staleDaemon?: { name: string; version: string | null; expected: string | null; detail: string };
  /** Processes (e.g. sessions in tmux) still running an older build until they're restarted. */
  staleProcesses?: number;
  /** Why the latest-version check failed. */
  checkError?: string;
}

export type HarnessUpdatePhase = 'waiting' | 'updating' | 'restarting' | 'done' | 'failed' | 'cancelled';

/** One run of a harness's updater, streamed to the desktop and the phone (SSE `harness_update`). */
export interface HarnessUpdateJob {
  id: string;
  harness: HarnessGroup;
  phase: HarnessUpdatePhase;
  startedAt: number;
  finishedAt?: number;
  from: string | null;
  to: string | null;
  /** The command running now (or last run). */
  step?: string;
  /** Tail of the updater's output (newest last). */
  log: string[];
  /** Waiting phase: sessions on this harness that are working. */
  waitingFor?: number;
  /** Outcome or error, one or two sentences. */
  message?: string;
}

export interface UnifiedSession {
  /** Globally unique ID: `<harness>:<nativeId>` or `master:root` */
  id: string;
  nativeId: string;
  harness: HarnessKind;
  harnessGroup: HarnessGroup | 'master';
  title: string;
  customTitle?: string;
  preview: string;
  cwd: string;
  projectName: string;
  gitBranch?: string;
  model?: string;
  reasoningEffort?: string;
  status: SessionStatus;
  isLive: boolean;
  isRemote: boolean;
  remoteId?: string;
  tmuxTarget?: string;
  tmuxSessionName?: string;
  /** Address of the machine running this session when it is not the Superharness host (e.g. `192.168.0.3`). */
  hostAddress?: string;
  /** Friendly name of that machine (e.g. `lxebook-2021`). */
  hostLabel?: string;
  /** That machine stopped answering; its sessions are shown as last seen, not live. */
  hostOffline?: boolean;
  /** When that machine last answered a poll (ms epoch). */
  hostLastSeenAt?: number;
  /** Start of the last message the person sent in this session (one line, for list rows). */
  lastUserText?: string;
  /** New activity since lxe last had this session open (on any client). */
  unread?: boolean;
  /** One-line model-written summary of what the thread is doing now (replaces lastUserText in rows when set). */
  summary?: string;
  pid?: number;
  transcriptPath?: string;
  createdAt: number;
  updatedAt: number;
  tokenCount?: number;
  /** Superharness organization overlay */
  pinned: boolean;
  /** Pinned globally to the top of Superharness (above all harnesses) */
  pinnedToTop?: boolean;
  folderId?: string | null;
  tags: string[];
  hidden: boolean;
  /** Extra dispatch metadata */
  dispatchMode:
    | 'master'
    | 'tmux-send'
    | 'claude-resume'
    | 'codex-resume'
    | 'agy-resume'
    | 'muse-msp'
    | 'pi-rpc';
  /** Live sync ownership indicator for accurate bidirectional status in the UI. */
  liveOwner?: 'daemon' | 'tmux' | 'desktop' | 'super-harness';
  /** Held by a plain terminal with no programmatic attach endpoint (Muse or Pi TUI outside tmux). */
  isTerminalHeld?: boolean;
  /** Subagent / hierarchy metadata */
  isSubagent?: boolean;
  parentSessionId?: string;
  subagentCount?: number;
  /** Native section/project label from the underlying harness (e.g. Claude/Codex sections or 'Ungrouped') */
  nativeSection?: string;
  /** Native sort order of the section within its harness (lower = higher, 9999 = Ungrouped) */
  nativeSectionOrder?: number;
  /** Origin hint (e.g. antigravity desktop app vs agy cli) */
  originApp?: 'antigravity-app' | 'antigravity-cli';
  /** Native metadata file path for direct archiving (e.g. Claude Desktop local_*.json) */
  nativeMetaPath?: string;
  /** Native Claude permission mode (e.g. 'bypassPermissions', 'acceptEdits', 'plan') */
  permissionMode?: string;
  /**
   * Model and effort a live terminal process was launched with (its --model / --effort flags).
   * This is what the process actually runs, which a stored override can lag behind.
   */
  runningModel?: string;
  runningReasoningEffort?: string;
}

export interface ImageAttachment {
  id: string;
  name: string;
  path: string;
  mimeType: string;
  previewDataUrl?: string;
}

export type UnifiedBlock =
  | {
      type: 'text';
      text: string;
    }
  | {
      type: 'image';
      path: string;
      name?: string;
      dataUrl?: string;
    }
  | {
      type: 'video';
      path: string;
      name?: string;
      mimeType?: string;
    }
  | {
      type: 'thinking';
      text: string;
      summary?: string;
    }
  | {
      type: 'command';
      command: string;
      cwd?: string;
      output?: string;
      exitCode?: number | null;
      durationMs?: number;
      status?: string;
    }
  | {
      type: 'file_change';
      changes: Array<{
        path: string;
        kind: string;
        diff?: string;
      }>;
      status?: string;
    }
  | {
      type: 'tool_call';
      name: string;
      server?: string;
      args?: string;
      output?: string;
      status?: string;
      durationMs?: number;
    }
  | {
      type: 'web_search';
      query: string;
      url?: string;
    }
  | {
      type: 'question';
      questions: Array<{
        question: string;
        options: string[];
        multiSelect?: boolean;
        answer?: string;
      }>;
      answered?: boolean;
    }
  | {
      type: 'notice';
      title: string;
      detail?: string;
    };

export interface LiveStepItem {
  title: string;
  status: 'pending' | 'in_progress' | 'done' | 'skipped' | 'failed';
}

export interface RunningTaskItem {
  id: string;
  summary: string;
  command?: string;
  logPath?: string;
  isDaemon?: boolean;
}

export interface QueuedMessageItem {
  id: string;
  text: string;
  attachments?: ImageAttachment[];
  createdAt: number;
  source: 'super-harness' | 'native';
}

export interface LiveActivityState {
  isWorking: boolean;
  focus?: string;
  steps?: LiveStepItem[];
  queuedMessages?: QueuedMessageItem[];
  runningTasks?: RunningTaskItem[];
  lastEventAt?: number;
}

export type MessageSourceKind = 'human' | 'agent' | 'compaction' | 'task' | 'system_meta';

export interface UnifiedMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  timestamp: number;
  blocks: UnifiedBlock[];
  streaming?: boolean;
  error?: string;
  harnessMeta?: {
    model?: string;
    turnId?: string;
    sourceKind?: MessageSourceKind;
    senderName?: string;
  };
}

export interface SessionStats {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  /** Approximate current context window fill (latest turn input + cached input). */
  contextUsedTokens: number;
  /** Model's context window capacity in tokens (best-effort from model/harness). */
  contextWindowTokens?: number;
  /** Estimated API-equivalent cost in USD across loaded turns. */
  estimatedCostUsd: number;
  /** Number of model turns counted. */
  turnCount: number;
}

export interface SessionTranscriptResult {
  sessionId: string;
  messages: UnifiedMessage[];
  totalCount: number;
  hasMore: boolean;
  sourceMtimeMs: number;
  liveActivity?: LiveActivityState;
  stats?: SessionStats;
}

export interface SessionFolder {
  id: string;
  name: string;
  color: string;
  order: number;
}

export interface SessionOverride {
  customTitle?: string;
  folderId?: string | null;
  nativeSection?: string | null;
  nativeSectionOrder?: number;
  model?: string;
  reasoningEffort?: string;
  /** Harness-native permission mode chosen in Superharness (see SessionConfigChange). */
  permissionMode?: string;
  pinned?: boolean;
  pinnedToTop?: boolean;
  tags?: string[];
  hidden?: boolean;
}

/**
 * A request to change how a session runs. Values are harness-native after validation;
 * an empty string clears the Superharness override (back to the harness's own default).
 */
export interface SessionConfigChange {
  model?: string;
  reasoningEffort?: string;
  permissionMode?: string;
  /**
   * Allow restarting a live terminal process to apply settings it can only take at launch
   * (Claude in tmux: model and effort). The conversation resumes; nothing is lost.
   */
  restart?: boolean;
}

/**
 * What happened to one requested setting:
 * - applied: in effect now
 * - next_message: stored; Superharness applies it when it next sends to this session
 * - needs_restart: would take effect only after restarting the live process (pass restart: true)
 * - unsupported: this harness or session can't change it from Superharness (detail says why)
 * - invalid: value not accepted (detail lists valid values)
 * - failed: tried and could not confirm it took effect
 */
export type SessionConfigStatus =
  | 'applied'
  | 'next_message'
  | 'needs_restart'
  | 'unsupported'
  | 'invalid'
  | 'failed';

export interface SessionConfigFieldResult {
  field: 'model' | 'reasoningEffort' | 'permissionMode';
  requested: string;
  /** Normalized harness-native value that was stored/applied. */
  value?: string;
  status: SessionConfigStatus;
  detail?: string;
}

export interface SessionConfigResult {
  ok: boolean;
  sessionId: string;
  harness?: string;
  results: SessionConfigFieldResult[];
  error?: string;
}

export interface MasterEngineConfig {
  harness: HarnessGroup;
  model: string;
  cwd: string;
  autoApplyActions: boolean;
}

export type SidebarGroupBy = 'native' | 'harness' | 'project' | 'folders' | 'recent';

export interface ExternalAppsSettings {
  fileClickAction: 'internal' | 'editor' | 'system';
  folderClickAction: 'file-manager' | 'editor' | 'terminal' | 'internal';
  editorCommand: string;
  fileManagerCommand: string;
  terminalCommand: string;
}

export interface DetectedAppOption {
  id: string;
  label: string;
  command: string;
  binaryPath: string;
}

export interface DetectedSystemApps {
  editors: DetectedAppOption[];
  fileManagers: DetectedAppOption[];
  terminals: DetectedAppOption[];
}

export interface FilePreviewData {
  path: string;
  name: string;
  isDirectory: boolean;
  kind: 'markdown' | 'code' | 'image' | 'directory' | 'binary';
  content?: string;
  sizeBytes: number;
  lineCount?: number;
  startLine?: number;
  endLine?: number;
  entries?: Array<{ name: string; path: string; isDirectory: boolean; sizeBytes?: number }>;
  error?: string;
}

export interface MobileApiSettings {
  enabled: boolean;
  bindHost: string;
  port: number;
  /** Legacy shared Bearer token (phones set up before pairing). Still accepted on every route. */
  token: string;
  /** Stable random id for this desktop, carried in the pairing QR code and Bonjour TXT record. */
  hostId?: string;
  /** Phones paired with a one-time code; each has its own token, stored only as a hash. */
  pairedDevices?: PairedDevice[];
  /** Name phones show for this desktop (pairing prompt, Bonjour). Empty: the computer's name. */
  hostName?: string;
}

export interface MobileAddress {
  address: string;
  kind: 'tailscale-dns' | 'tailscale-ip' | 'lan';
}

export interface MobileAccessInfo {
  hostId: string;
  hostName: string;
  defaultHostName: string;
  /** Port the phone listener is bound to, 0 when it isn't listening. */
  listeningPort: number;
  addresses: MobileAddress[];
  bonjour: boolean;
}

export interface PairingSession {
  code: string;
  expiresAt: number;
  url: string;
  qrDataUrl: string;
  hosts: string[];
}

export type PairingEvent =
  | { type: 'paired'; device: { id: string; name: string } }
  | { type: 'closed'; reason: 'expired' | 'too_many_attempts' | 'cancelled' | 'paired' };

export interface PairedDevice {
  id: string;
  name: string;
  /** sha256 (hex) of the device's Bearer token. */
  tokenHash: string;
  createdAt: number;
  lastSeenAt?: number;
}

/**
 * The desktop's one dictation server: an OpenAI-compatible transcription endpoint
 * (POST {baseUrl}/v1/audio/transcriptions). Phones never talk to it directly; they send
 * audio to the host's /api/dictate, which proxies it here.
 */
export interface DictationSettings {
  baseUrl: string;
  /** Sent as `Authorization: Bearer <apiKey>` when set. */
  apiKey?: string;
  model?: string;
  language?: string;
  /** Desktop shortcut that toggles recording in the focused composer (default Ctrl+Shift+Space). */
  shortcut?: string;
}

export interface DictationStatus {
  ok: boolean;
  configured: boolean;
  healthy: boolean;
  model?: string;
  error?: string;
}

export interface DictationResult {
  ok: boolean;
  text?: string;
  error?: string;
  timing?: { upstreamMs: number };
}

export interface SuperHarnessSettings {
  /**
   * lxe's harness order for the gauge strip and the harness sections in the All view
   * (shared by desktop and phone). Missing harnesses follow in the default order.
   */
  harnessOrder?: HarnessGroup[];
  /**
   * Display order of pinned chats (session ids), shared by desktop and phone. Pinned chats
   * missing from it follow in their usual order; ids that are no longer pinned are ignored.
   */
  pinnedOrder?: string[];
  pollIntervalMs: number;
  maxSessionsPerHarness: number;
  sidebarGroupBy: SidebarGroupBy;
  showArchived: boolean;
  showHidden: boolean;
  enabledHarnesses: Record<HarnessGroup, boolean>;
  master: MasterEngineConfig;
  defaultNewSessionCwd: string;
  apps: ExternalAppsSettings;
  mobileApi?: MobileApiSettings;
  dictation?: DictationSettings;
  /** Background one-line thread summaries for list rows (default: enabled, Claude Haiku). */
  summaries?: SummarySettings;
}

export interface SummarySettings {
  enabled: boolean;
  model: string;
}

export interface SummarizerRunRecord {
  at: number;
  model: string;
  threads: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface SummarizerUsageStats {
  totalRuns: number;
  totalThreads: number;
  totalInputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  last24hRuns: number;
  last24hTokens: number;
  last24hCostUsd: number;
  lastRun?: SummarizerRunRecord;
}

/**
 * One stint of the Master Orchestrator on one harness. Every orchestrator turn resumes
 * `nativeId`; switching harness ends the segment (after compacting into the memory file)
 * and starts a new one seeded from that file.
 */
export interface MasterSegment {
  engine: HarnessGroup;
  /** Harness-native session id (Claude/Muse: chosen up front; Codex/Antigravity: captured from the first turn). */
  nativeId?: string;
  model?: string;
  startedAt: number;
  /** Completed turns; 0 means the native session has not been created yet. */
  turns?: number;
}

export interface MasterThreadState {
  segments: MasterSegment[];
  /** Native ids of one-turn orchestrator sessions created before persistent threads (hidden from the sidebar). */
  legacyNativeIds?: string[];
  legacyScanDone?: boolean;
}

export interface SuperHarnessState {
  settings: SuperHarnessSettings;
  folders: SessionFolder[];
  overrides: Record<string, SessionOverride>;
  masterMessages: UnifiedMessage[];
  /** The Master Orchestrator's native sessions, one per harness stint (see MasterThreadState). */
  masterThread?: MasterThreadState;
  /** Maps read-only desktop conversation IDs (e.g. Antigravity App) to linked resumable CLI IDs */
  linkedCliSessions?: Record<string, string>;
  /** Per-session `updatedAt` that lxe has seen (session open on a client). */
  readMarks?: Record<string, number>;
  /** Sessions with no read mark count as read up to this time (set when unread tracking started). */
  readBaseline?: number;
}

export interface StartSessionRequest {
  harness: 'codex' | 'claude-tmux' | 'claude-cli' | 'antigravity' | 'muse' | 'pi';
  cwd: string;
  title?: string;
  prompt?: string;
  attachments?: ImageAttachment[];
  model?: string;
  /** Optional thinking / reasoning effort level (e.g. low, medium, high, xhigh, max, ultra). */
  reasoningEffort?: string;
  remoteControl?: boolean;
  tmuxSessionName?: string;
}

export interface SendMessageResult {
  ok: boolean;
  error?: string;
  dispatchedVia?: string;
  runId?: string;
  /**
   * The session is mid-turn and the harness cannot take a message without stopping it. The
   * dispatcher then holds the message and sends it when the turn ends; a steer never stops a turn.
   */
  holdUntilIdle?: boolean;
}

export interface StreamEvent {
  sessionId: string;
  runId: string;
  kind: 'start' | 'delta' | 'block' | 'done' | 'error';
  text?: string;
  /**
   * For `delta`: the harness's id for the message item the text belongs to, when it has one.
   * A change of itemId starts a new paragraph (two text items can follow each other with no
   * block between them).
   */
  itemId?: string;
  block?: UnifiedBlock;
  error?: string;
}

export interface TmuxCaptureResult {
  target: string;
  content: string;
  updatedAt: number;
  error?: string;
}

export interface OrganizeAction {
  type:
    | 'create_folder'
    | 'delete_folder'
    | 'rename_folder'
    | 'reorder_folders'
    | 'assign_folder'
    | 'move_section'
    | 'set_model'
    | 'pin'
    | 'unpin'
    | 'pin_top'
    | 'unpin_top'
    | 'rename_session'
    | 'tag_session'
    | 'hide_session'
    | 'unhide_session';
  folderId?: string | null;
  folderName?: string;
  folderColor?: string;
  folderIds?: string[];
  sectionName?: string | null;
  sectionOrder?: number;
  model?: string;
  reasoningEffort?: string;
  permissionMode?: string;
  sessionId?: string;
  title?: string;
  tags?: string[];
}

export interface HarnessModelOption {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
  group?: string;
  /** Supported thinking / reasoning effort levels for this model, in ascending order. */
  reasoningLevels?: string[];
  /** Model's own default reasoning level (e.g. 'low', 'medium', 'high'). */
  defaultReasoningLevel?: string;
  /** Other IDs that mean this same model (e.g. `opus`, `claude-opus-5-5[1m]`), for matching a session's model. */
  aliases?: string[];
}

export interface HarnessProjectOption {
  name: string;
  path: string;
  harnesses: HarnessGroup[];
  lastUsedAt?: number;
}

export interface HarnessCatalog {
  models: Record<HarnessGroup, HarnessModelOption[]>;
  /** Configured harness-level default reasoning effort (e.g. from ~/.codex/config.toml). */
  defaultReasoningEffort?: Partial<Record<HarnessGroup, string>>;
  projects: HarnessProjectOption[];
  updatedAt: number;
}

export interface SuperHarnessApi {
  getBootstrap: () => Promise<{
    harnesses: HarnessDetection[];
    sessions: UnifiedSession[];
    state: SuperHarnessState;
    controlPort: number;
  }>;
  getHarnessCatalog: (force?: boolean) => Promise<HarnessCatalog>;
  createProjectDirectory: (
    parentDir: string,
    name: string
  ) => Promise<{ ok: boolean; path?: string; error?: string }>;
  refreshDiscovery: () => Promise<{
    harnesses: HarnessDetection[];
    sessions: UnifiedSession[];
  }>;
  getTranscript: (
    sessionId: string,
    limit?: number
  ) => Promise<SessionTranscriptResult>;
  watchSession: (
    paneId: string,
    sessionId: string | null,
    limit?: number
  ) => Promise<{ ok: boolean }>;
  captureTmux: (target: string) => Promise<TmuxCaptureResult>;
  saveAttachment: (
    dataUrl: string,
    filename?: string
  ) => Promise<ImageAttachment>;
  readClipboardImage: () => Promise<ImageAttachment | null>;
  /** Opens a file picker for any file type; images come back with an inline preview. */
  pickAttachmentFiles: () => Promise<ImageAttachment[]>;
  /** Absolute path of a dropped/pasted File, or null when it has none (e.g. dragged from a browser). */
  getPathForFile: (file: File) => string | null;
  sendMessage: (
    sessionId: string,
    prompt: string,
    attachments?: ImageAttachment[],
    opts?: { force?: boolean }
  ) => Promise<SendMessageResult>;
  queueMessage: (
    sessionId: string,
    prompt: string,
    attachments?: ImageAttachment[]
  ) => Promise<SendMessageResult>;
  abortRun: (sessionId: string) => Promise<{ ok: boolean }>;
  startSession: (req: StartSessionRequest) => Promise<{
    ok: boolean;
    sessionId?: string;
    error?: string;
  }>;
  controlHarness: (
    harness: HarnessGroup,
    action: 'start_remote' | 'stop_remote' | 'open_desktop'
  ) => Promise<{ ok: boolean; output?: string; error?: string }>;
  organize: (actions: OrganizeAction[]) => Promise<SuperHarnessState>;
  archiveSession: (
    sessionId: string,
    opts?: { killTmux?: boolean }
  ) => Promise<{ ok: boolean; method?: string; error?: string }>;
  promoteToTmux: (
    sessionId: string
  ) => Promise<{ ok: boolean; tmuxSession?: string; error?: string }>;
  updateSettings: (
    patch: Partial<SuperHarnessSettings>
  ) => Promise<SuperHarnessState>;
  clearMasterHistory: () => Promise<SuperHarnessState>;
  /** Summarize every recently changed thread now (Settings → Thread summaries). */
  refreshSummaries: () => Promise<{
    ok: boolean;
    summarized: number;
    pending: number;
    costUsd?: number;
    tokens?: number;
    error?: string;
  }>;
  getSummaryStats: () => Promise<SummarizerUsageStats>;
  resetSummaryStats: () => Promise<SummarizerUsageStats>;
  pickDirectory: () => Promise<string | null>;
  getSystemApps: () => Promise<DetectedSystemApps>;
  readFilePreview: (
    filePath: string,
    startLine?: number,
    endLine?: number
  ) => Promise<FilePreviewData>;
  openPath: (
    targetPath: string,
    mode?: 'auto' | 'internal' | 'editor' | 'file-manager' | 'terminal' | 'system',
    opts?: { line?: number; tmuxSession?: string }
  ) => Promise<{ ok: boolean; action?: 'internal' | 'launched'; error?: string }>;
  openExternalUrl: (url: string) => Promise<{ ok: boolean }>;
  openInHarness: (sessionId: string) => Promise<{ ok: boolean; via?: string; error?: string }>;
  getUsage: (force?: boolean) => Promise<UsageSnapshot>;
  restartApp: (opts?: { build?: boolean }) => Promise<{ ok: boolean; error?: string }>;
  /** Checks the saved dictation server, or `draft` settings when given (Settings → Test). */
  getDictationStatus: (draft?: DictationSettings) => Promise<DictationStatus>;
  /** Sends recorded audio to the main process, which proxies it to the dictation server. */
  transcribeAudio: (audio: Uint8Array, mimeType: string) => Promise<DictationResult>;
  getMobileAccessInfo: () => Promise<MobileAccessInfo>;
  /** Starts pairing: a fresh one-time code plus the QR code that carries it. */
  openPairing: () => Promise<PairingSession | { error: string }>;
  closePairing: () => Promise<void>;
  revokePairedDevice: (deviceId: string) => Promise<boolean>;
  onPairingEvent: (cb: (ev: PairingEvent) => void) => () => void;
  /** Checks every harness for a newer version now (normally every few hours). */
  checkHarnessUpdates: () => Promise<HarnessDetection[]>;
  startHarnessUpdate: (
    harness: HarnessGroup
  ) => Promise<{ ok: true; job: HarnessUpdateJob } | { ok: false; error: string }>;
  cancelHarnessUpdate: (harness: HarnessGroup) => Promise<boolean>;
  getHarnessUpdateJobs: () => Promise<HarnessUpdateJob[]>;
  onHarnessUpdate: (cb: (job: HarnessUpdateJob) => void) => () => void;
  onStreamEvent: (cb: (ev: StreamEvent) => void) => () => void;
  onTranscriptUpdated: (cb: (result: SessionTranscriptResult) => void) => () => void;
  onStateChanged: (cb: (state: SuperHarnessState) => void) => () => void;
  onUsageUpdated: (cb: (usage: UsageSnapshot) => void) => () => void;
  onSessionsUpdated: (
    cb: (payload: {
      harnesses: HarnessDetection[];
      sessions: UnifiedSession[];
    }) => void
  ) => () => void;
}

export interface UsageQuotaWindow {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt?: number;
  delta24h?: number;
  windowMinutes?: number;
}

export interface DailySpendPoint {
  date: string;
  dayLabel: string;
  spendUsd: number;
  tokens: number;
}

export interface HarnessUsageSummary {
  harness: HarnessGroup;
  updatedAt: number;
  planLabel?: string;
  /** Primary 0..100 fill percentage for the bar at the bottom of the harness tab */
  barPercent: number | null;
  /** True when barPercent is derived from local activity rather than an official quota % */
  barIsEstimated?: boolean;
  windows: UsageQuotaWindow[];
  creditsBalance?: number;
  spend5hUsd: number;
  spend24hUsd: number;
  spend7dUsd: number;
  spend14dUsd: number;
  tokens7d: number;
  dailySpend7d: DailySpendPoint[];
  spendIsEstimated: boolean;
  note?: string;
}

export type UsageSnapshot = Record<HarnessGroup, HarnessUsageSummary>;
