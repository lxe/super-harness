export type HarnessKind =
  | 'master'
  | 'codex'
  | 'claude-tmux'
  | 'claude-desktop'
  | 'claude-cli'
  | 'antigravity';

export type HarnessGroup = 'codex' | 'claude' | 'antigravity';

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
  pid?: number;
  transcriptPath?: string;
  createdAt: number;
  updatedAt: number;
  tokenCount?: number;
  /** Super Harness organization overlay */
  pinned: boolean;
  /** Pinned globally to the top of Super Harness (above all harnesses) */
  pinnedToTop?: boolean;
  folderId?: string | null;
  tags: string[];
  hidden: boolean;
  /** Extra dispatch metadata */
  dispatchMode: 'master' | 'tmux-send' | 'claude-resume' | 'codex-resume' | 'agy-resume';
  /** Live sync ownership indicator for accurate bidirectional status in the UI. */
  liveOwner?: 'daemon' | 'tmux' | 'desktop' | 'super-harness';
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

export interface SessionTranscriptResult {
  sessionId: string;
  messages: UnifiedMessage[];
  totalCount: number;
  hasMore: boolean;
  sourceMtimeMs: number;
  liveActivity?: LiveActivityState;
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
  pinned?: boolean;
  pinnedToTop?: boolean;
  tags?: string[];
  hidden?: boolean;
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
  token: string;
}

export interface SuperHarnessSettings {
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
}

export interface SuperHarnessState {
  settings: SuperHarnessSettings;
  folders: SessionFolder[];
  overrides: Record<string, SessionOverride>;
  masterMessages: UnifiedMessage[];
  /** Maps read-only desktop conversation IDs (e.g. Antigravity App) to linked resumable CLI IDs */
  linkedCliSessions?: Record<string, string>;
}

export interface StartSessionRequest {
  harness: 'codex' | 'claude-tmux' | 'claude-cli' | 'antigravity';
  cwd: string;
  title?: string;
  prompt?: string;
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
}

export interface StreamEvent {
  sessionId: string;
  runId: string;
  kind: 'start' | 'delta' | 'block' | 'done' | 'error';
  text?: string;
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
  pickImageFiles: () => Promise<ImageAttachment[]>;
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
  getUsage: (force?: boolean) => Promise<UsageSnapshot>;
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
