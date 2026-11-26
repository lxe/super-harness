import fs from 'node:fs';
import path from 'node:path';
import type {
  HarnessDetection,
  HarnessGroup,
  ImageAttachment,
  SendMessageResult,
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
    ctx: DispatchContext
  ): Promise<SendMessageResult>;

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
   * back to Super Harness's local hide-session behavior.
   */
  archiveSession(
    session: UnifiedSession,
    opts?: { killTmux?: boolean }
  ): Promise<{ ok: boolean; method?: string; error?: string; hideLocally?: boolean } | null>;

  /** Optional hook to cancel a harness-managed run (e.g., Antigravity ACP). */
  abort?(sessionId: string, emitStream: (ev: StreamEvent) => void): boolean;

  /** Optional cleanup hook called on app quit (e.g., closing persistent ACP connections). */
  shutdown?(): void;
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
export function formatPromptWithImagePaths(
  prompt: string,
  attachments?: ImageAttachment[]
): string {
  if (!attachments || attachments.length === 0) return prompt;
  const refs = attachments.map((a) => `[Attached image: ${a.path}]`).join('\n');
  return prompt.trim()
    ? `${refs}\n\n${prompt}`
    : `${refs}\n\nPlease inspect the attached image(s).`;
}

/**
 * Extracts `[Attached image: /abs/path/to/file.png]` lines emitted by
 * `formatPromptWithImagePaths` into structured `image` blocks and returns
 * the remaining clean prompt text.
 */
export function extractAttachedImagesFromText(rawText: string): {
  text: string;
  images: Array<Extract<UnifiedBlock, { type: 'image' }>>;
} {
  if (!rawText || !rawText.includes('[Attached image:')) {
    return { text: rawText, images: [] };
  }
  const images: Array<Extract<UnifiedBlock, { type: 'image' }>> = [];
  const seen = new Set<string>();
  const keptLines: string[] = [];

  for (const line of rawText.split('\n')) {
    const m = line.match(/^\s*\[Attached image:\s*(.+?)\]\s*$/i);
    if (m) {
      const imgPath = m[1].trim();
      if (imgPath && !seen.has(imgPath)) {
        seen.add(imgPath);
        images.push({
          type: 'image',
          path: imgPath,
          name: path.basename(imgPath),
        });
      }
      continue;
    }
    keptLines.push(line);
  }

  return {
    text: keptLines.join('\n').trim(),
    images,
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
