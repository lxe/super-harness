import fs from 'node:fs';
import path from 'node:path';
import type {
  HarnessDetection,
  HarnessGroup,
  ImageAttachment,
  SendMessageResult,
  SessionConfigChange,
  SessionConfigFieldResult,
  SessionTranscriptResult,
  StartSessionRequest,
  StreamEvent,
  UnifiedBlock,
  UnifiedSession,
} from '../../shared/types';
import type { ProcessRow } from '../utils/system';

/**
 * Directory watch specification returned by a HarnessDriver for global
 * background discovery (LiveSyncService).
 */
export interface HarnessWatchSpec {
  dir: string;
  filter?: (filename: string) => boolean;
}

/**
 * Process-streaming & refresh utilities provided by HarnessDispatcher to a
 * HarnessDriver when sending messages or starting sessions.
 */
export interface DispatchContext {
  spawnStreaming(opts: {
    sessionId: string;
    runId: string;
    bin: string;
    args: string[];
    cwd: string;
    parseLine: (line: string, gotAnyDelta: boolean) => boolean;
  }): void;
  emitStream(ev: StreamEvent): void;
  triggerRefresh(delayMs?: number): void;
}

export type DaemonControlAction = 'start_remote' | 'stop_remote' | 'open_desktop';

/**
 * Cohesive contract encapsulating all harness-specific "tendrils" (local paths,
 * discovery, transcript loading, cache fingerprinting, FS watch targets,
 * message dispatch, session launch, daemon control, and native archiving).
 *
 * Adding a new AI coding harness means implementing this single interface and
 * registering it in `src/main/adapters/index.ts` — with zero changes required
 * in HarnessRegistry, LiveSyncService, or HarnessDispatcher.
 */
export interface HarnessDriver {
  readonly id: HarnessGroup;
  readonly displayName: string;

  /** Discover live & historical sessions and runtime capabilities. */
  detect(
    processes: ProcessRow[],
    maxSessions: number,
    showArchived: boolean
  ): Promise<{
    detection: HarnessDetection;
    sessions: UnifiedSession[];
  }>;

  /** Lightweight fingerprint used by TranscriptCache to skip re-reading unchanged chats. */
  getTranscriptFingerprint(session: UnifiedSession): Promise<string>;

  /** Load the latest `limit` messages plus liveActivity metadata for a session. */
  loadTranscript(session: UnifiedSession, limit: number): Promise<SessionTranscriptResult>;

  /** Directories to watch globally for new/updated sessions (LiveSyncService). */
  getGlobalWatchDirs(): HarnessWatchSpec[];

  /** Specific files to watch while a session is open in a pane (LiveSyncService). */
  getSessionWatchFiles(session: UnifiedSession): string[];

  /** Dispatch a prompt (and optional image attachments) into an existing session. */
  sendMessage(
    session: UnifiedSession,
    prompt: string,
    attachments: ImageAttachment[] | undefined,
    ctx: DispatchContext,
    opts?: { force?: boolean }
  ): Promise<SendMessageResult>;

  /**
   * Optional native queue dispatch (e.g., `codex queue --thread <id> --message ... --resume`)
   * so queued items persist inside the harness's own queue and stay synchronized with its Desktop/CLI UI.
   * Return `null` if the harness does not support native queueing.
   */
  queueMessage?(
    session: UnifiedSession,
    prompt: string,
    attachments: ImageAttachment[] | undefined,
    ctx: DispatchContext
  ): Promise<SendMessageResult | null>;

  /** Launch a brand-new session for this harness. */
  startSession(
    req: StartSessionRequest,
    ctx: DispatchContext
  ): Promise<{ ok: boolean; sessionId?: string; error?: string }>;

  /** Start/stop remote-control daemon or open desktop app. */
  controlDaemon(
    action: DaemonControlAction,
    ctx: DispatchContext
  ): Promise<{ ok: boolean; output?: string; error?: string }>;

  /**
   * Archive natively if the harness supports it (e.g., `codex archive`,
   * Claude Desktop `isArchived`, tmux `kill-session`). Return `null` to fall
   * back to Superharness's local hide-session behavior.
   */
  archiveSession(
    session: UnifiedSession,
    opts?: { killTmux?: boolean }
  ): Promise<{ ok: boolean; method?: string; error?: string; hideLocally?: boolean } | null>;

  /** Optional hook to cancel a harness-managed run (e.g., Antigravity ACP, Codex app-server, or Claude tmux). */
  abort?(
    sessionId: string,
    emitStream: (ev: StreamEvent) => void,
    session?: UnifiedSession
  ): boolean;

  /** Optional hook to sync section moves natively with the harness daemon (e.g., Codex `thread/section/move`). */
  moveSection?(session: UnifiedSession, sectionName: string | null): Promise<boolean>;

  /**
   * Optional hook to promote a session into tmux: Claude spawns a live
   * tmux + Remote Control session; Muse restarts a terminal-held session
   * inside tmux (closing the verified holding terminal process first) so
   * the terminal typing lane can reach it.
   */
  promoteToTmux?(
    session: UnifiedSession,
    ctx: DispatchContext
  ): Promise<{ ok: boolean; tmuxSession?: string; error?: string }>;

  /** Optional cleanup hook called on app quit (e.g., closing persistent ACP/app-server connections). */
  shutdown?(): void;

  /**
   * Turns running in Superharness's own hosts for this harness (pooled workers, `muse serve`,
   * `agy acp`). A harness update waits for these, since restartHosts would cut them off.
   */
  activeHostTurns?(): number;

  /**
   * After the harness was updated: close Superharness's own idle hosts so they respawn on the new
   * binary. Returns what was restarted, in words (e.g. `2 Pi workers`).
   */
  restartHosts?(): Promise<string[]>;

  /**
   * Optional sink for native push activity (e.g. Codex app-server daemon
   * notifications for turns Superharness did not start). LiveSyncService
   * uses it to push transcript refreshes without FS polling.
   */
  setActivitySink?(sink: ((sessionId: string) => void) | null): void;

  /**
   * Validate and apply a model / reasoning effort / permission mode change for one
   * session. Return one result per requested field; fields with status `applied` or
   * `next_message` are persisted as Superharness overrides by the caller. Drivers
   * without this hook report every field as unsupported.
   */
  applySessionConfig?(
    session: UnifiedSession,
    change: SessionConfigChange,
    ctx: DispatchContext
  ): Promise<SessionConfigFieldResult[]>;
}

/**
 * Generates guaranteed-unique message IDs within a parsed transcript, even if
 * the underlying harness emits duplicate step indices or UUIDs.
 */
export function createUniqueIdGenerator(): (base: string) => string {
  const used = new Set<string>();
  return (base: string): string => {
    if (!used.has(base)) {
      used.add(base);
      return base;
    }
    let n = 2;
    while (used.has(`${base}-${n}`)) n++;
    const next = `${base}-${n}`;
    used.add(next);
    return next;
  };
}

/**
 * Fast stat-based cache fingerprint for file-backed JSONL transcripts.
 * Includes a 10-second time bucket for files modified within the last 45s so
 * `liveActivity.isWorking` decays smoothly once a turn finishes.
 */
export function computeFileFingerprint(filePath: string | undefined): string {
  if (!filePath) return 'missing';
  try {
    const st = fs.statSync(filePath);
    const ageMs = Date.now() - st.mtimeMs;
    const recentBucket = ageMs < 45_000 ? Math.floor(Date.now() / 10_000) : 0;
    return `${filePath}:${st.size}:${Math.floor(st.mtimeMs)}:${recentBucket}`;
  } catch {
    return 'missing';
  }
}

/**
 * Formats a prompt with inline file path references for CLI harnesses that
 * inspect attached images from disk rather than multimodal protocol blocks.
 */
export function isImageAttachment(a: Pick<ImageAttachment, 'mimeType'>): boolean {
  return (a.mimeType || '').toLowerCase().startsWith('image/');
}

/** `[Attached image: …]` for images, `[Attached file: …]` for anything else. */
function attachmentRef(a: ImageAttachment): string {
  return isImageAttachment(a) ? `[Attached image: ${a.path}]` : `[Attached file: ${a.path}]`;
}

export function formatPromptWithImagePaths(
  prompt: string,
  attachments?: ImageAttachment[]
): string {
  if (!attachments || attachments.length === 0) return prompt;
  const refs = attachments.map(attachmentRef).join('\n');
  if (prompt.trim()) return `${refs}\n\n${prompt}`;
  return attachments.every(isImageAttachment)
    ? `${refs}\n\nPlease inspect the attached image(s).`
    : `${refs}\n\nPlease look at the attached file(s).`;
}

/**
 * Harness wires only carry images natively. Non-image attachments (PDFs,
 * logs, archives…) are moved into the prompt as `[Attached file: /path]`
 * lines so the agent reads them from disk; images stay as attachments.
 */
export function moveFileAttachmentsIntoPrompt(
  prompt: string,
  attachments: ImageAttachment[] | undefined
): { prompt: string; attachments: ImageAttachment[] | undefined } {
  const files = (attachments ?? []).filter((a) => !isImageAttachment(a));
  if (files.length === 0) return { prompt, attachments };
  const images = (attachments ?? []).filter(isImageAttachment);
  return {
    prompt: formatPromptWithImagePaths(prompt, files),
    attachments: images.length > 0 ? images : undefined,
  };
}

const ATTACHED_VIDEO_MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
};

/**
 * Extracts `[Attached image: /abs/path.png]` and `[Attached video: /abs/path.mp4]` lines (written
 * by `formatPromptWithImagePaths` and by the mobile send endpoint) into structured `image` and
 * `video` blocks, and returns the remaining prompt text.
 */
export function extractAttachedImagesFromText(rawText: string): {
  text: string;
  images: Array<Extract<UnifiedBlock, { type: 'image' }>>;
  videos: Array<Extract<UnifiedBlock, { type: 'video' }>>;
} {
  if (!rawText || !/\[Attached (image|video):/i.test(rawText)) {
    return { text: rawText, images: [], videos: [] };
  }
  const images: Array<Extract<UnifiedBlock, { type: 'image' }>> = [];
  const videos: Array<Extract<UnifiedBlock, { type: 'video' }>> = [];
  const seen = new Set<string>();
  const keptLines: string[] = [];

  for (const line of rawText.split('\n')) {
    const m = line.match(/^\s*\[Attached (image|video):\s*(.+?)\]\s*$/i);
    if (m) {
      const kind = m[1].toLowerCase();
      const mediaPath = m[2].trim();
      if (mediaPath && !seen.has(mediaPath)) {
        seen.add(mediaPath);
        if (kind === 'video') {
          videos.push({
            type: 'video',
            path: mediaPath,
            name: path.basename(mediaPath),
            mimeType: ATTACHED_VIDEO_MIME_BY_EXT[path.extname(mediaPath).toLowerCase()],
          });
        } else {
          images.push({ type: 'image', path: mediaPath, name: path.basename(mediaPath) });
        }
      }
      continue;
    }
    keptLines.push(line);
  }

  return {
    text: keptLines.join('\n').trim(),
    images,
    videos,
  };
}

/**
 * Standardized detection stub when a harness is disabled in Settings.
 */
export function createDisabledDetection(id: HarnessGroup, name: string): HarnessDetection {
  return {
    id,
    name,
    installed: false,
    binaryPath: null,
    version: null,
    runningProcesses: 0,
    desktopAppRunning: false,
    daemonRunning: false,
    remoteControlEnabled: false,
    activeSessionCount: 0,
    totalSessionCount: 0,
    capabilities: {
      canStartNew: false,
      canResume: false,
      canTmuxMirror: false,
      canControlDaemon: false,
    },
    notes: 'Disabled in Settings',
  };
}
