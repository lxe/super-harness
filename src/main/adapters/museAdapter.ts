import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  HarnessDetection,
  ImageAttachment,
  LiveActivityState,
  LiveStepItem,
  SendMessageResult,
  SessionTranscriptResult,
  StartSessionRequest,
  StreamEvent,
  UnifiedBlock,
  UnifiedMessage,
  UnifiedSession,
} from '../../shared/types';
import { querySqliteReadOnly } from '../utils/sqlite';
import { readProgressiveJsonlTail } from '../utils/tailReader';
import {
  cleanTextPreview,
  getBinaryVersion,
  projectNameFromCwd,
  whichBinary,
  type ProcessRow,
} from '../utils/system';
import {
  computeFileFingerprint,
  createUniqueIdGenerator,
  formatPromptWithImagePaths,
  type DispatchContext,
  type HarnessDriver,
  type HarnessWatchSpec,
} from './types';

const execFileAsync = promisify(execFile);

/** Runs a command feeding `stdinText` to its stdin (for `muse session-message send`). */
function execFileWithStdin(
  file: string,
  args: string[],
  stdinText: string,
  timeoutMs: number
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(err);
        else resolve({ stdout: String(stdout), stderr: String(stderr) });
      }
    );
    child.stdin?.on('error', () => {
      // Child exited before consuming stdin; the exec callback reports it.
    });
    child.stdin?.end(stdinText);
  });
}

export const MUSE_DATA_DIR = path.join(
  process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
  'muse'
);
export const MUSE_SESSIONS_DIR = path.join(MUSE_DATA_DIR, 'sessions');
export const MUSE_INDEX_DB = path.join(MUSE_DATA_DIR, 'session-index.db');

/** Reasoning effort levels accepted by `muse exec --reasoning-effort`. */
export const MUSE_EFFORT_LEVELS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
];

let cachedMuseVersion: string | null | undefined;

/** Muse timestamps (`recorded_at`, index `*_at_us`) are epoch microseconds. */
function museUsToMs(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return Date.now();
  return Math.floor(n / 1000);
}

interface MuseIndexRow {
  session_id: string;
  session_log_path: string | null;
  workspace_root: string | null;
  model_id: string | null;
  git_branch: string | null;
  title: string | null;
  first_user_prompt: string | null;
  created_at_us: number | null;
  updated_at_us: number | null;
  prompt_count: number | null;
  status: string | null;
  session_name: string | null;
  logged_session_name: string | null;
}

export interface MuseLiveSession {
  sessionId: string;
  name?: string;
  workspaceLabel?: string;
  attachable?: boolean;
}

/** Parses `muse sessions --json` stdout (`{"sessions":[...]}`). */
export function parseMuseLiveSessionsJson(stdout: string): MuseLiveSession[] {
  try {
    const parsed = JSON.parse(stdout.trim()) as { sessions?: unknown };
    if (!Array.isArray(parsed.sessions)) return [];
    const out: MuseLiveSession[] = [];
    for (const raw of parsed.sessions) {
      const s = raw as Record<string, unknown>;
      if (typeof s?.sessionId !== 'string' || !s.sessionId) continue;
      out.push({
        sessionId: s.sessionId,
        name: typeof s.name === 'string' ? s.name : undefined,
        workspaceLabel: typeof s.workspaceLabel === 'string' ? s.workspaceLabel : undefined,
        attachable: typeof s.attachable === 'boolean' ? s.attachable : undefined,
      });
    }
    return out;
  } catch {
    return [];
  }
}

let liveSessionsCache: { checkedAt: number; sessions: Map<string, MuseLiveSession> } | null =
  null;
const LIVE_SESSIONS_TTL_MS = 10_000;

export function invalidateMuseLiveSessionsCache(): void {
  liveSessionsCache = null;
}

async function getLiveMuseSessions(
  binPath: string | null,
  force = false
): Promise<Map<string, MuseLiveSession>> {
  const now = Date.now();
  if (!force && liveSessionsCache && now - liveSessionsCache.checkedAt < LIVE_SESSIONS_TTL_MS) {
    return liveSessionsCache.sessions;
  }
  const sessions = new Map<string, MuseLiveSession>();
  if (binPath) {
    try {
      const { stdout } = await execFileAsync(binPath, ['sessions', '--json'], {
        timeout: 3000,
        maxBuffer: 1024 * 1024,
      });
      for (const s of parseMuseLiveSessionsJson(stdout)) {
        sessions.set(s.sessionId, s);
      }
    } catch {
      // No live registry (no session running) — treat as no live sessions.
    }
  }
  liveSessionsCache = { checkedAt: now, sessions };
  return sessions;
}

const transcriptPathCache = new Map<string, string>();

/**
 * Resolves `<data>/muse/sessions/YYYY/MM/DD/<id>/session.jsonl` by checking
 * the explicit path first, then walking the date shards (bounded, cached).
 */
export function resolveMuseTranscriptPath(
  nativeId: string,
  transcriptPath?: string
): string | undefined {
  if (transcriptPath && fs.existsSync(transcriptPath)) return transcriptPath;
  const cached = transcriptPathCache.get(nativeId);
  if (cached && fs.existsSync(cached)) return cached;
  try {
    if (!fs.existsSync(MUSE_SESSIONS_DIR)) return transcriptPath;
    for (const year of fs.readdirSync(MUSE_SESSIONS_DIR, { withFileTypes: true })) {
      if (!year.isDirectory()) continue;
      const yearDir = path.join(MUSE_SESSIONS_DIR, year.name);
      for (const month of fs.readdirSync(yearDir, { withFileTypes: true })) {
        if (!month.isDirectory()) continue;
        const monthDir = path.join(yearDir, month.name);
        for (const day of fs.readdirSync(monthDir, { withFileTypes: true })) {
          if (!day.isDirectory()) continue;
          const candidate = path.join(monthDir, day.name, nativeId, 'session.jsonl');
          if (fs.existsSync(candidate)) {
            transcriptPathCache.set(nativeId, candidate);
            return candidate;
          }
        }
      }
    }
  } catch {
    // ignore — fall through to the unverified hint path
  }
  return transcriptPath;
}

/**
 * Unwraps one `session.jsonl` line into zero or more event-log records.
 * Muse wraps some durable records in `retained_frame` transactions whose
 * children carry the record JSON as a string; `retained_marker` lines are
 * tombstones for live-only records and yield nothing.
 */
export function unwrapMuseRecordLine(line: string): Array<Record<string, unknown>> {
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return [];
  }
  if (typeof obj.retained_frame === 'string') {
    const out: Array<Record<string, unknown>> = [];
    const children = Array.isArray(obj.children) ? obj.children : [];
    for (const child of children) {
      const recordJson = (child as Record<string, unknown>)?.record_json;
      if (typeof recordJson !== 'string') continue;
      try {
        out.push(JSON.parse(recordJson) as Record<string, unknown>);
      } catch {
        // ignore malformed child
      }
    }
    return out;
  }
  if (typeof obj.retained_marker === 'string') return [];
  if (typeof obj.payload_type === 'string') return [obj];
  return [];
}

/**
 * Strips runtime-injected `<system-reminder>` envelopes from a user prompt so
 * only what the human actually typed renders in the user bubble.
 */
export function stripRuntimeInjectedText(text: string): string {
  return text
    .replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi, '\n')
    .replace(/<system-reminder\b[^>]*\/>/gi, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractUserIntentContent(payload: Record<string, unknown>): {
  text: string;
  images: Array<Extract<UnifiedBlock, { type: 'image' }>>;
} {
  const modelMessages = Array.isArray(payload.model_messages) ? payload.model_messages : [];
  const firstMessage = modelMessages[0] as Record<string, unknown> | undefined;
  const content = Array.isArray(firstMessage?.content)
    ? (firstMessage.content as Array<Record<string, unknown>>)
    : Array.isArray(payload.refill_blocks)
      ? (payload.refill_blocks as Array<Record<string, unknown>>)
      : [];
  const texts: string[] = [];
  const images: Array<Extract<UnifiedBlock, { type: 'image' }>> = [];
  for (const block of content) {
    if (!block || typeof block !== 'object') continue;
    if (block.kind === 'text' && typeof block.text === 'string') {
      texts.push(block.text);
    } else if (block.kind === 'image' && typeof block.path === 'string' && block.path) {
      images.push({ type: 'image', path: block.path, name: path.basename(block.path) });
    }
  }
  return { text: stripRuntimeInjectedText(texts.join('\n')), images };
}

function parseToolArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
    } catch {
      // not JSON — handled by caller via raw string
    }
  }
  return {};
}

function formatToolArgsForDisplay(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === 'string') {
    const parsed = parseToolArgs(raw);
    if (Object.keys(parsed).length > 0) {
      return JSON.stringify(parsed, null, 2).slice(0, 4000);
    }
    return raw.slice(0, 4000) || undefined;
  }
  try {
    return JSON.stringify(raw, null, 2).slice(0, 4000);
  } catch {
    return undefined;
  }
}

const MAX_TOOL_OUTPUT_CHARS = 60_000;

/**
 * Parses Muse `session.jsonl` event-log lines into the unified transcript
 * model. Render-relevant durable records:
 * - `runtime.user_intent.accepted` (semantic_kind `chat`, surface `main`) → user message
 * - `runtime.session` run events: `assistant_message_committed` (text),
 *   `reasoning_summary_committed` / plaintext `reasoning_committed` (thinking;
 *   encrypted reasoning carries empty text and is skipped),
 *   `assistant_tool_calls_committed` + `tool_result_batch_committed`
 *   (coalesced by `tool_call_id`; `bash` → command, `request_user_input` →
 *   question, everything else → tool_call), `todo_snapshot_updated` (live
 *   steps), and `terminal` (turn boundary for `isWorking`).
 */
export function parseMuseJsonlLines(
  lines: string[],
  sessionId: string,
  sourceMtimeMs: number,
  limit = 120,
  meta?: { truncated?: boolean }
): SessionTranscriptResult {
  const messages: UnifiedMessage[] = [];
  const uniqueId = createUniqueIdGenerator();
  let currentAssistant: UnifiedMessage | null = null;
  let seq = 0;

  const pendingByCallId = new Map<
    string,
    Extract<UnifiedBlock, { type: 'command' | 'tool_call' | 'question' }>
  >();
  let latestSteps: LiveStepItem[] | undefined;
  let lastFocus: string | undefined;
  let lastEventAt = sourceMtimeMs;
  let lastUserSeq = -1;
  let lastTerminalSeq = -1;
  let recordSeq = 0;

  const ensureAssistant = (ts: number, runId?: string): UnifiedMessage => {
    if (!currentAssistant) {
      currentAssistant = {
        id: uniqueId(`muse-a-${seq++}`),
        role: 'assistant',
        timestamp: ts,
        blocks: [],
        harnessMeta: runId ? { turnId: runId, sourceKind: 'agent' } : { sourceKind: 'agent' },
      };
      messages.push(currentAssistant);
    }
    return currentAssistant;
  };

  const attachToolResult = (
    block: Extract<UnifiedBlock, { type: 'command' | 'tool_call' | 'question' }>,
    resultText: string
  ): void => {
    if (block.type === 'command') {
      try {
        const parsed = JSON.parse(resultText) as Record<string, unknown>;
        if (parsed && typeof parsed === 'object' && 'output' in parsed) {
          block.output = String(parsed.output ?? '').slice(0, MAX_TOOL_OUTPUT_CHARS);
          block.exitCode =
            typeof parsed.exit_code === 'number' ? parsed.exit_code : null;
          if (typeof parsed.terminal_status === 'string') {
            block.status = parsed.terminal_status;
          }
          return;
        }
      } catch {
        // plain-text shell output
      }
      block.output = resultText.slice(0, MAX_TOOL_OUTPUT_CHARS);
      return;
    }
    if (block.type === 'question') {
      block.answered = true;
      try {
        const parsed = JSON.parse(resultText) as Record<string, unknown>;
        const answers = Array.isArray(parsed?.answers) ? parsed.answers : [];
        answers.forEach((raw, idx) => {
          const a = raw as Record<string, unknown>;
          const label =
            typeof a?.answer === 'string'
              ? a.answer
              : typeof a?.label === 'string'
                ? a.label
                : typeof raw === 'string'
                  ? raw
                  : undefined;
          if (label && idx < block.questions.length) {
            block.questions[idx].answer = label;
          }
        });
      } catch {
        // free-form answer text stays unmapped; block is still marked answered
      }
      return;
    }
    block.output = resultText.slice(0, MAX_TOOL_OUTPUT_CHARS);
    block.status = 'completed';
  };

  for (const line of lines) {
    if (!line.trim()) continue;
    // Fast pre-filter before JSON.parse for the high-volume task/run chatter
    // that never renders (task lifecycle, model traces, reminders plumbing).
    if (
      !line.includes('user_intent.accepted') &&
      !line.includes('assistant_message_committed') &&
      !line.includes('reasoning_summary_committed') &&
      !line.includes('reasoning_committed') &&
      !line.includes('assistant_tool_calls_committed') &&
      !line.includes('tool_result_batch_committed') &&
      !line.includes('todo_snapshot_updated') &&
      !line.includes('"terminal"')
    ) {
      continue;
    }

    for (const record of unwrapMuseRecordLine(line)) {
      recordSeq++;
      const payloadType = String(record.payload_type || '');
      const payload = (record.payload ?? {}) as Record<string, unknown>;
      const ts = museUsToMs(record.recorded_at);
      if (ts > lastEventAt || lastEventAt === sourceMtimeMs) lastEventAt = ts;

      if (payloadType === 'runtime.user_intent.accepted') {
        const semanticKind = (payload.semantic_kind as Record<string, unknown> | undefined)
          ?.kind;
        if (semanticKind && semanticKind !== 'chat') continue;
        if (payload.surface && payload.surface !== 'main') continue;
        const { text, images } = extractUserIntentContent(payload);
        if (!text && images.length === 0) continue;
        currentAssistant = null;
        lastUserSeq = recordSeq;
        const blocks: UnifiedBlock[] = [...images];
        if (text) blocks.push({ type: 'text', text });
        messages.push({
          id: uniqueId(
            `muse-u-${typeof payload.intent_id === 'string' ? payload.intent_id : seq++}`
          ),
          role: 'user',
          timestamp: ts,
          blocks,
          harnessMeta: { sourceKind: 'human' },
        });
        continue;
      }

      if (payloadType !== 'runtime.session' || payload.kind !== 'run') continue;
      const event = (payload.event ?? {}) as Record<string, unknown>;
      const eventKind = String(event.kind || '');
      const runId = typeof payload.run_id === 'string' ? payload.run_id : undefined;

      if (eventKind === 'terminal') {
        lastTerminalSeq = recordSeq;
        currentAssistant = null;
        continue;
      }

      if (eventKind === 'todo_snapshot_updated') {
        const items = Array.isArray(event.items) ? event.items : [];
        latestSteps = items
          .filter(
            (it): it is Record<string, unknown> =>
              Boolean(it) && typeof it === 'object' && typeof (it as Record<string, unknown>).text === 'string'
          )
          .map((it) => {
            const status = String(it.status || 'pending');
            return {
              title: String(it.text),
              status: (status === 'completed'
                ? 'done'
                : status === 'in_progress'
                  ? 'in_progress'
                  : status === 'cancelled'
                    ? 'skipped'
                    : 'pending') as LiveStepItem['status'],
            };
          });
        const active = latestSteps.find((s) => s.status === 'in_progress');
        if (active) lastFocus = active.title;
        continue;
      }

      if (eventKind === 'reasoning_summary_committed' || eventKind === 'reasoning_committed') {
        const text = typeof event.text === 'string' ? event.text.trim() : '';
        // Encrypted reasoning records carry `text: ""` + `encrypted_content`;
        // only plaintext summaries/thoughts can render.
        if (text) {
          ensureAssistant(ts, runId).blocks.push({ type: 'thinking', text });
        }
        continue;
      }

      if (eventKind === 'assistant_message_committed') {
        const text = typeof event.text === 'string' ? event.text : '';
        if (text.trim()) {
          ensureAssistant(ts, runId).blocks.push({ type: 'text', text });
        }
        continue;
      }

      if (eventKind === 'assistant_tool_calls_committed') {
        const calls = Array.isArray(event.tool_calls) ? event.tool_calls : [];
        const assistant = ensureAssistant(ts, runId);
        for (const rawCall of calls) {
          const call = (rawCall ?? {}) as Record<string, unknown>;
          const name = typeof call.name === 'string' ? call.name : 'tool';
          const callId =
            typeof call.call_id === 'string'
              ? call.call_id
              : typeof call.id === 'string'
                ? call.id
                : `call-${seq}`;
          const argsObj = parseToolArgs(call.args);
          let block: Extract<UnifiedBlock, { type: 'command' | 'tool_call' | 'question' }>;
          if (name === 'bash' && typeof argsObj.command === 'string') {
            block = {
              type: 'command',
              command: argsObj.command,
              cwd: typeof argsObj.workdir === 'string' ? argsObj.workdir : undefined,
              status: 'running',
            };
            lastFocus =
              typeof argsObj.description === 'string' && argsObj.description
                ? argsObj.description
                : 'Running command';
          } else if (name === 'request_user_input' && Array.isArray(argsObj.questions)) {
            block = {
              type: 'question',
              questions: (argsObj.questions as Array<Record<string, unknown>>)
                .filter((q) => q && typeof q.question === 'string')
                .map((q) => ({
                  question: String(q.question),
                  options: (Array.isArray(q.options) ? q.options : [])
                    .map((o) => {
                      const opt = o as Record<string, unknown>;
                      return typeof opt?.label === 'string'
                        ? opt.label
                        : typeof o === 'string'
                          ? o
                          : '';
                    })
                    .filter(Boolean),
                  multiSelect:
                    (q.selection as Record<string, unknown> | undefined)?.mode === 'multiple',
                })),
            };
            lastFocus = 'Waiting for your answer';
          } else {
            block = {
              type: 'tool_call',
              name,
              args: formatToolArgsForDisplay(call.args),
              status: 'running',
            };
            lastFocus = `Running ${name}`;
          }
          assistant.blocks.push(block);
          pendingByCallId.set(callId, block);
        }
        continue;
      }

      if (eventKind === 'tool_result_batch_committed') {
        const results = Array.isArray(event.results) ? event.results : [];
        for (const rawResult of results) {
          const result = (rawResult ?? {}) as Record<string, unknown>;
          const callId = typeof result.tool_call_id === 'string' ? result.tool_call_id : '';
          const block = pendingByCallId.get(callId);
          if (!block) continue;
          const text = typeof result.text === 'string' ? result.text : '';
          attachToolResult(block, text);
          if (block.type === 'command' && !block.status) block.status = 'completed';
          pendingByCallId.delete(callId);
        }
        continue;
      }
    }
  }

  const totalCount = messages.length;
  const sliced = totalCount > limit ? messages.slice(totalCount - limit) : messages;
  const isWorking =
    lastUserSeq > lastTerminalSeq && Date.now() - sourceMtimeMs < 90_000;

  const liveActivity: LiveActivityState = {
    isWorking,
    focus: isWorking ? lastFocus : undefined,
    steps: latestSteps && latestSteps.length > 0 ? latestSteps : undefined,
    lastEventAt,
  };

  return {
    sessionId,
    messages: sliced,
    totalCount,
    hasMore: Boolean(meta?.truncated) || totalCount > limit,
    sourceMtimeMs,
    liveActivity,
  };
}

export async function loadMuseTranscript(
  nativeId: string,
  transcriptPath: string | undefined,
  limit = 120
): Promise<SessionTranscriptResult> {
  const sessionId = `muse:${nativeId}`;
  const resolved = resolveMuseTranscriptPath(nativeId, transcriptPath);
  if (!resolved || !fs.existsSync(resolved)) {
    return {
      sessionId,
      messages: [],
      totalCount: 0,
      hasMore: false,
      sourceMtimeMs: Date.now(),
    };
  }

  const initialBytes = Math.max(1024 * 1024, limit * 24 * 1024);
  const outcome = readProgressiveJsonlTail(
    resolved,
    (lines, chunkMeta) =>
      parseMuseJsonlLines(lines, sessionId, chunkMeta.mtimeMs, limit, {
        truncated: chunkMeta.truncated,
      }),
    (parsed) => parsed.messages.length >= limit,
    { initialBytes }
  );

  if (!outcome) {
    return {
      sessionId,
      messages: [],
      totalCount: 0,
      hasMore: false,
      sourceMtimeMs: Date.now(),
    };
  }
  return outcome.parsed;
}

interface MuseHeaderInfo {
  title?: string;
  preview?: string;
  cwd?: string;
  model?: string;
}

/** Best-effort header scan used only when the session-index DB is unavailable. */
function readMuseHeaderInfo(transcriptPath: string): MuseHeaderInfo {
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(131072);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const chunk = buf.subarray(0, bytesRead).toString('utf8');
    const info: MuseHeaderInfo = {};
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue;
      for (const record of unwrapMuseRecordLine(line)) {
        const payload = (record.payload ?? {}) as Record<string, unknown>;
        if (record.payload_type === 'runtime.session.metadata') {
          const rec = (payload.record ?? {}) as Record<string, unknown>;
          if (typeof rec.workspace_root === 'string') info.cwd = rec.workspace_root;
          if (typeof rec.model_id === 'string') info.model = rec.model_id;
        } else if (record.payload_type === 'runtime.user_intent.accepted' && !info.title) {
          const { text } = extractUserIntentContent(payload);
          if (text) {
            info.title = cleanTextPreview(text, 90);
            info.preview = cleanTextPreview(text, 140);
          }
        }
      }
      if (info.title && info.cwd) break;
    }
    return info;
  } catch {
    return {};
  }
}

export async function detectMuse(
  processes: ProcessRow[],
  maxSessions: number
): Promise<{ detection: HarnessDetection; sessions: UnifiedSession[] }> {
  const binPath = await whichBinary('muse');
  if (cachedMuseVersion === undefined) {
    cachedMuseVersion = await getBinaryVersion(binPath);
  }

  // The installed binary reports a versioned comm (e.g. `muse-bin-1.4.14`).
  const museProcs = processes.filter(
    (p) => p.comm === 'muse' || p.comm.startsWith('muse-') || /(?:^|\/)muse(?:\s|$)/.test(p.args)
  );
  const liveSessions = await getLiveMuseSessions(binPath);
  const now = Date.now();

  const toSession = (row: {
    nativeId: string;
    transcriptPath?: string;
    cwd: string;
    title: string;
    preview: string;
    model?: string;
    gitBranch?: string;
    createdAt: number;
    updatedAt: number;
    sessionName?: string;
  }): UnifiedSession => {
    const live = liveSessions.get(row.nativeId);
    const isLive = Boolean(live) || now - row.updatedAt < 10 * 60 * 1000;
    const hasWorkspaceProject = row.cwd !== os.homedir();
    const projName = projectNameFromCwd(row.cwd);
    const name = row.sessionName || live?.name;
    return {
      id: `muse:${row.nativeId}`,
      nativeId: row.nativeId,
      harness: 'muse',
      harnessGroup: 'muse',
      title: row.title,
      preview: row.preview,
      cwd: row.cwd,
      projectName: projName,
      gitBranch: row.gitBranch || undefined,
      model: row.model || undefined,
      nativeSection: hasWorkspaceProject ? projName : 'Ungrouped',
      nativeSectionOrder: hasWorkspaceProject ? 10 : 9999,
      status: live ? 'running' : 'idle',
      isLive,
      isRemote: false,
      transcriptPath: row.transcriptPath,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      pinned: false,
      folderId: null,
      tags: name ? [`@${name}`] : [],
      hidden: false,
      dispatchMode: 'muse-exec',
      liveOwner: live ? 'desktop' : undefined,
    };
  };

  const sessions: UnifiedSession[] = [];

  // Primary discovery: Muse's own session index (titles, workspaces, models, μs timestamps).
  const rows = await querySqliteReadOnly<MuseIndexRow>(
    MUSE_INDEX_DB,
    `SELECT session_id, session_log_path, workspace_root, model_id, git_branch,
            title, first_user_prompt, created_at_us, updated_at_us, prompt_count,
            status, session_name, logged_session_name
     FROM sessions
     WHERE prompt_count > 0
     ORDER BY updated_at_us DESC
     LIMIT ?`,
    [Math.max(1, maxSessions)]
  );

  if (rows.length > 0) {
    for (const r of rows) {
      if (!r.session_id) continue;
      const transcriptPath =
        resolveMuseTranscriptPath(r.session_id, r.session_log_path || undefined) ||
        r.session_log_path ||
        undefined;
      let updatedAt = museUsToMs(r.updated_at_us);
      try {
        if (transcriptPath) {
          updatedAt = Math.max(updatedAt, fs.statSync(transcriptPath).mtimeMs);
        }
      } catch {
        // keep index timestamp
      }
      const cwd = r.workspace_root || os.homedir();
      sessions.push(
        toSession({
          nativeId: r.session_id,
          transcriptPath,
          cwd,
          title:
            cleanTextPreview(r.title || r.first_user_prompt, 90) ||
            `Muse ${r.session_id.slice(0, 8)}`,
          preview: cleanTextPreview(r.first_user_prompt || r.title, 140) || 'Muse session',
          model: r.model_id || undefined,
          gitBranch: r.git_branch || undefined,
          createdAt: museUsToMs(r.created_at_us),
          updatedAt,
          sessionName: r.session_name || r.logged_session_name || undefined,
        })
      );
    }
  } else if (fs.existsSync(MUSE_SESSIONS_DIR)) {
    // Fallback: walk the date-sharded session store directly.
    const discovered: Array<{ nativeId: string; transcriptPath: string; mtime: number; ctime: number }> = [];
    try {
      for (const year of fs.readdirSync(MUSE_SESSIONS_DIR, { withFileTypes: true })) {
        if (!year.isDirectory()) continue;
        const yearDir = path.join(MUSE_SESSIONS_DIR, year.name);
        for (const month of fs.readdirSync(yearDir, { withFileTypes: true })) {
          if (!month.isDirectory()) continue;
          const monthDir = path.join(yearDir, month.name);
          for (const day of fs.readdirSync(monthDir, { withFileTypes: true })) {
            if (!day.isDirectory()) continue;
            const dayDir = path.join(monthDir, day.name);
            for (const entry of fs.readdirSync(dayDir, { withFileTypes: true })) {
              if (!entry.isDirectory()) continue;
              const tr = path.join(dayDir, entry.name, 'session.jsonl');
              if (!fs.existsSync(tr)) continue;
              try {
                const st = fs.statSync(tr);
                discovered.push({
                  nativeId: entry.name,
                  transcriptPath: tr,
                  mtime: st.mtimeMs,
                  ctime: st.birthtimeMs || st.ctimeMs,
                });
              } catch {
                // ignore
              }
            }
          }
        }
      }
    } catch {
      // ignore walk failures
    }
    discovered.sort((a, b) => b.mtime - a.mtime);
    for (const d of discovered.slice(0, maxSessions)) {
      const header = readMuseHeaderInfo(d.transcriptPath);
      if (!header.title) continue; // empty shell session with no prompt yet
      sessions.push(
        toSession({
          nativeId: d.nativeId,
          transcriptPath: d.transcriptPath,
          cwd: header.cwd || os.homedir(),
          title: header.title,
          preview: header.preview || header.title,
          model: header.model,
          createdAt: d.ctime,
          updatedAt: d.mtime,
        })
      );
    }
  }

  const detection: HarnessDetection = {
    id: 'muse',
    name: 'Muse',
    installed: Boolean(binPath) || fs.existsSync(MUSE_DATA_DIR),
    binaryPath: binPath,
    version: cachedMuseVersion,
    runningProcesses: museProcs.length,
    desktopAppRunning: false,
    daemonRunning: false,
    remoteControlEnabled: false,
    activeSessionCount: sessions.filter((s) => s.isLive).length,
    totalSessionCount: sessions.length,
    capabilities: {
      canStartNew: Boolean(binPath),
      canResume: Boolean(binPath),
      canTmuxMirror: false,
      canControlDaemon: false,
    },
    notes: `${sessions.length} sessions (${liveSessions.size} live in terminal)`,
  };

  return { detection, sessions };
}

/**
 * Builds `muse exec` argv for a headless turn. Super Harness has no approval
 * UI primitive, so dispatched turns run with `--yolo` (approval + sandbox off
 * for this run) rather than blocking forever on a prompt nobody can answer —
 * the same effective posture as the other harnesses' dispatched runs.
 */
export function buildMuseExecArgs(opts: {
  nativeId: string;
  cwd: string;
  prompt: string;
  model?: string;
  reasoningEffort?: string;
  attachments?: ImageAttachment[];
}): string[] {
  const args = [
    'exec',
    '--json',
    '--session-id',
    opts.nativeId,
    '--workspace',
    opts.cwd,
    '--yolo',
  ];
  if (opts.model?.trim()) args.push('--model', opts.model.trim());
  const effort = opts.reasoningEffort?.trim().toLowerCase();
  if (effort && MUSE_EFFORT_LEVELS.includes(effort)) {
    args.push('--reasoning-effort', effort);
  }
  for (const att of opts.attachments ?? []) {
    if (att.path) args.push('--image', att.path);
  }
  args.push(opts.prompt);
  return args;
}

/**
 * Parses one `muse exec --json` stdout line into Super Harness stream
 * deltas. Returns true when a text delta was emitted.
 */
export function parseMuseExecStreamLine(
  sessionId: string,
  runId: string,
  line: string,
  gotAnyDelta: boolean,
  emit: (ev: StreamEvent) => void
): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return false;
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return false;
  }
  const payloadType = String(record.payload_type || '');
  const payload = (record.payload ?? {}) as Record<string, unknown>;

  const emitDelta = (text: unknown): boolean => {
    if (typeof text !== 'string' || !text) return false;
    emit({ sessionId, runId, kind: 'delta', text });
    return true;
  };

  if (payloadType === 'run.output.delta') {
    return emitDelta(payload.text);
  }
  if (payloadType.startsWith('run.terminal')) {
    // Final text safety net when no deltas streamed (e.g. echo-style runs).
    return gotAnyDelta ? false : emitDelta(payload.text);
  }
  if (payloadType === 'runtime.session' && payload.kind === 'run') {
    const event = (payload.event ?? {}) as Record<string, unknown>;
    if (event.kind === 'assistant_message_committed') {
      return emitDelta(event.text);
    }
  }
  return false;
}

/**
 * Cohesive HarnessDriver encapsulating all Muse (Meta) integration:
 * session-index.db discovery, event-log transcripts, live-session steering
 * via `muse session-message send`, and headless continuation via
 * `muse exec --json --session-id <uuid>`.
 */
export function createMuseDriver(): HarnessDriver {
  return {
    id: 'muse',
    displayName: 'Muse',

    detect(processes, maxSessions) {
      return detectMuse(processes, maxSessions);
    },

    async getTranscriptFingerprint(session) {
      const resolved = resolveMuseTranscriptPath(session.nativeId, session.transcriptPath);
      return computeFileFingerprint(resolved);
    },

    loadTranscript(session, limit) {
      const resolved = resolveMuseTranscriptPath(session.nativeId, session.transcriptPath);
      return loadMuseTranscript(session.nativeId, resolved, limit);
    },

    getGlobalWatchDirs(): HarnessWatchSpec[] {
      const specs: HarnessWatchSpec[] = [
        {
          dir: MUSE_DATA_DIR,
          filter: (fn) => fn.startsWith('session-index.db'),
        },
      ];
      const nowDate = new Date();
      const todayShard = path.join(
        MUSE_SESSIONS_DIR,
        String(nowDate.getFullYear()),
        String(nowDate.getMonth() + 1).padStart(2, '0'),
        String(nowDate.getDate()).padStart(2, '0')
      );
      specs.push({ dir: todayShard });
      return specs;
    },

    getSessionWatchFiles(session: UnifiedSession): string[] {
      const resolved = resolveMuseTranscriptPath(session.nativeId, session.transcriptPath);
      return resolved ? [resolved] : [];
    },

    async sendMessage(
      session: UnifiedSession,
      prompt: string,
      attachments: ImageAttachment[] | undefined,
      ctx: DispatchContext,
      _opts?: { force?: boolean }
    ): Promise<SendMessageResult> {
      const bin = await whichBinary('muse');
      if (!bin) return { ok: false, error: 'muse CLI not found' };

      // Session open in a terminal right now -> steer it in place via the
      // cross-session message bridge (the `tmux send-keys` equivalent)
      // instead of double-driving the same log with a second process.
      const liveSessions = await getLiveMuseSessions(bin, true);
      if (liveSessions.has(session.nativeId)) {
        try {
          await execFileWithStdin(
            bin,
            ['session-message', 'send', '--target', session.nativeId, '--json'],
            formatPromptWithImagePaths(prompt, attachments),
            8000
          );
          ctx.triggerRefresh(800);
          ctx.triggerRefresh(2500);
          return { ok: true, dispatchedVia: 'muse session-message → live terminal session' };
        } catch (err) {
          return {
            ok: false,
            error: `muse session-message failed (session may have exited — retry to resume headlessly): ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }

      const cwd = fs.existsSync(session.cwd) ? session.cwd : os.homedir();
      const runId = crypto.randomBytes(6).toString('hex');
      ctx.spawnStreaming({
        sessionId: session.id,
        runId,
        bin,
        args: buildMuseExecArgs({
          nativeId: session.nativeId,
          cwd,
          prompt,
          model: session.model,
          reasoningEffort: session.reasoningEffort,
          attachments,
        }),
        cwd,
        parseLine: (line, gotAnyDelta) =>
          parseMuseExecStreamLine(session.id, runId, line, gotAnyDelta, ctx.emitStream),
      });
      return {
        ok: true,
        runId,
        dispatchedVia:
          attachments && attachments.length > 0
            ? `muse exec (${attachments.length} image${attachments.length === 1 ? '' : 's'})`
            : 'muse exec',
      };
    },

    async startSession(
      req: StartSessionRequest,
      ctx: DispatchContext
    ): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
      const bin = await whichBinary('muse');
      if (!bin) return { ok: false, error: 'muse CLI not found' };
      const cwd = fs.existsSync(req.cwd) ? req.cwd : os.homedir();
      const nativeId = crypto.randomUUID();
      const sessionId = `muse:${nativeId}`;
      const runId = crypto.randomBytes(6).toString('hex');
      ctx.spawnStreaming({
        sessionId,
        runId,
        bin,
        args: buildMuseExecArgs({
          nativeId,
          cwd,
          prompt: req.prompt || 'Hello! Summarize the workspace briefly.',
          model: req.model,
          reasoningEffort: req.reasoningEffort,
        }),
        cwd,
        parseLine: (line, gotAnyDelta) =>
          parseMuseExecStreamLine(sessionId, runId, line, gotAnyDelta, ctx.emitStream),
      });
      ctx.triggerRefresh(800);
      ctx.triggerRefresh(2500);
      return { ok: true, sessionId };
    },

    async controlDaemon(action) {
      return {
        ok: false,
        error: `Action '${action}' not supported for Muse — it runs as a terminal TUI (\`muse resume\`) with no daemon or desktop app.`,
      };
    },

    async archiveSession() {
      // No native archive command; fall back to Super Harness local hide.
      return null;
    },
  };
}
