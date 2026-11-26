import { execFile } from 'node:child_process';
import { invalid, normalizeEffort, resultsFor } from './sessionConfig';
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
import { readJsonlTailLines, readProgressiveJsonlTail } from '../utils/tailReader';
import {
  cleanTextPreview,
  getBinaryVersion,
  projectNameFromCwd,
  whichBinary,
  type ProcessRow,
} from '../utils/system';
import {
  classifyMspError,
  extractMspHistoryItems,
  foldMspItems,
  mapMspTodoItems,
  MuseMspClient,
} from '../services/museMspClient';
import {
  computeFileFingerprint,
  createUniqueIdGenerator,
  formatPromptWithImagePaths,
  type DispatchContext,
  type HarnessDriver,
  type HarnessWatchSpec,
} from './types';

const execFileAsync = promisify(execFile);

export const MUSE_DATA_DIR = path.join(
  process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
  'muse'
);
export const MUSE_SESSIONS_DIR = path.join(MUSE_DATA_DIR, 'sessions');
export const MUSE_INDEX_DB = path.join(MUSE_DATA_DIR, 'session-index.db');

/** Reasoning effort levels accepted by MSP `turn/start.reasoningEffort`. */
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
  latest_segment_terminated: number | null;
}

/**
 * Resolves sidebar working status for a Muse session. `running` must mean
 * "a turn is executing right now" (same semantics as Claude's busy owners),
 * NOT merely "a terminal has the session open" — the latter left the Muse
 * tab and every live session row spinning forever.
 *
 * Signals: the session-index `latest_segment_terminated` flag (0 while a
 * host process segment is open, 1 once it exited — exec runs flip it per
 * run; an idle-but-open TUI keeps it 0) combined with transcript-write
 * freshness (writes append constantly during a turn, including
 * omitted-live-only markers, and stop when the turn ends).
 */
export function resolveMuseSessionStatus(input: {
  isLiveRegistered: boolean;
  latestSegmentTerminated?: number | null;
  updatedAt: number;
  now: number;
  /** Turn-boundary verdict from the transcript tail, when readable. */
  transcriptWorking?: boolean | null;
}): 'running' | 'idle' {
  if (input.latestSegmentTerminated === 1) return 'idle';
  if (input.transcriptWorking === false) return 'idle';
  const fresh = input.now - input.updatedAt < 90_000;
  if (input.transcriptWorking === true) {
    return fresh || input.isLiveRegistered ? 'running' : 'idle';
  }
  if (!fresh) return 'idle';
  // Open segment (or unknown) with actively-appending transcript.
  if (input.latestSegmentTerminated === 0) return 'running';
  return input.isLiveRegistered ? 'running' : 'idle';
}

/**
 * Cheap turn-boundary probe over the transcript tail: true when the latest
 * user prompt has no following `terminal` record, false when the last turn
 * terminated, null when the tail holds neither marker (caller falls back to
 * segment/freshness heuristics). String-scans only — no JSON.parse — so
 * discovery stays fast; frames that wrap records (permission transactions)
 * never carry these markers.
 */
export function museTranscriptIsWorking(transcriptPath: string): boolean | null {
  const tail = readJsonlTailLines(transcriptPath, 256 * 1024);
  if (!tail) return null;
  let verdict: boolean | null = null;
  for (const line of tail.lines) {
    if (line.includes('"kind":"terminal"')) verdict = false;
    if (line.includes('runtime.user_intent.accepted')) verdict = true;
  }
  return verdict;
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
    latestSegmentTerminated?: number | null;
  }): UnifiedSession => {
    const live = liveSessions.get(row.nativeId);
    const isLive = Boolean(live) || now - row.updatedAt < 10 * 60 * 1000;
    // Only pay the tail probe for sessions that could plausibly be working.
    const transcriptWorking =
      row.transcriptPath &&
      (Boolean(live) || row.latestSegmentTerminated === 0 || now - row.updatedAt < 90_000)
        ? museTranscriptIsWorking(row.transcriptPath)
        : null;
    const status = resolveMuseSessionStatus({
      isLiveRegistered: Boolean(live),
      latestSegmentTerminated: row.latestSegmentTerminated,
      updatedAt: row.updatedAt,
      now,
      transcriptWorking,
    });
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
      status,
      isLive,
      isRemote: false,
      transcriptPath: row.transcriptPath,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      pinned: false,
      folderId: null,
      tags: name ? [`@${name}`] : [],
      hidden: false,
      dispatchMode: 'muse-msp',
      liveOwner: live ? 'desktop' : undefined,
      isTerminalHeld: live && live.attachable !== true ? true : undefined,
    };
  };

  const sessions: UnifiedSession[] = [];

  // Primary discovery: Muse's own session index (titles, workspaces, models, μs timestamps).
  const rows = await querySqliteReadOnly<MuseIndexRow>(
    MUSE_INDEX_DB,
    `SELECT session_id, session_log_path, workspace_root, model_id, git_branch,
            title, first_user_prompt, created_at_us, updated_at_us, prompt_count,
            status, session_name, logged_session_name, latest_segment_terminated
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
          latestSegmentTerminated: r.latest_segment_terminated,
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

export type MuseUndeliverableKind = 'tui-held' | 'other';

/**
 * Human, self-contained explanation for a message that could not be
 * delivered as a native MSP user turn. A session held by a plain Muse
 * terminal exposes no MSP attach endpoint (`muse sessions --json` reports
 * `attachable: false`; `muse attach --stdio` exits 4), so no client can
 * submit a real user turn to it — Super Harness refuses rather than
 * stamping the message as a peer/cross-session delivery.
 */
export function buildMuseUndeliverableError(
  session: { title: string; tags?: string[] },
  kind: MuseUndeliverableKind
): string {
  const nameTag = session.tags?.find((t) => t.startsWith('@'));
  const label = nameTag ? `${nameTag} ("${session.title}")` : `"${session.title}"`;
  if (kind === 'tui-held') {
    return (
      `Your message was not delivered: ${label} is open in a Muse terminal that Super Harness cannot type into ` +
      `(it has no MSP attach endpoint and is not running inside tmux). Use Restart in tmux in this session's ` +
      `header menu and Super Harness will close that terminal process and relaunch the same session inside tmux, ` +
      `after which it can type into that terminal for you. Or type the message in that terminal instead; or close ` +
      `the terminal session entirely and press Retry here, and Super Harness will host the session itself over ` +
      `Muse's native MSP API.`
    );
  }
  return (
    `Your message was not delivered to ${label}: Muse's MSP host did not accept it. ` +
    `Press Retry — if the session is no longer held by a terminal, Super Harness will resume it over MSP and deliver it.`
  );
}

/** Parses `tmux list-panes -a -F '#{pane_id} #{pane_pid}'` output. */
export function parseTmuxPaneList(output: string): Map<number, string> {
  const panes = new Map<number, string>();
  for (const line of output.split('\n')) {
    const m = line.trim().match(/^(%\d+)\s+(\d+)$/);
    if (m) panes.set(Number(m[2]), m[1]);
  }
  return panes;
}

/** First ancestor pid (starting from the process itself) that owns a tmux pane. */
export function findTmuxPaneForPids(
  panes: Map<number, string>,
  candidatePids: number[]
): string | null {
  for (const pid of candidatePids) {
    const pane = panes.get(pid);
    if (pane) return pane;
  }
  return null;
}

/** Delivery ack for terminal typing: the prompt appears in session.jsonl. */
export async function waitForMuseTranscriptDelivery(
  transcriptPath: string | undefined,
  prompt: string,
  timeoutMs = 4000
): Promise<boolean> {
  if (!transcriptPath) return false;
  const needle = JSON.stringify(prompt.trim().slice(0, 60)).slice(1, -1);
  if (needle.length < 3) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const st = fs.statSync(transcriptPath);
      const start = Math.max(0, st.size - 262144);
      const fd = fs.openSync(transcriptPath, 'r');
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      fs.closeSync(fd);
      if (buf.toString('utf8').includes(needle)) return true;
    } catch {
      // log not flushed yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

function readParentPid(pid: number): number {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const closeParen = stat.lastIndexOf(')');
    const ppid = Number(stat.slice(closeParen + 2).split(' ')[1]);
    return Number.isFinite(ppid) ? ppid : 0;
  } catch {
    return 0;
  }
}

function ancestorPids(pid: number, max = 12): number[] {
  const out = [pid];
  let cur = pid;
  for (let i = 0; i < max; i++) {
    const ppid = readParentPid(cur);
    if (!ppid || ppid === 1 || out.includes(ppid)) break;
    out.push(ppid);
    cur = ppid;
  }
  return out;
}

/** Finds the live muse process holding this session's log open (Linux /proc). */
function findMusePidHoldingLog(transcriptPath: string): number | null {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return null;
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    try {
      const comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
      if (!comm.includes('muse')) continue;
      for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
        try {
          if (fs.readlinkSync(`/proc/${pid}/fd/${fd}`) === transcriptPath) return pid;
        } catch {
          // fd raced away
        }
      }
    } catch {
      // process raced away / not readable
    }
  }
  return null;
}

/**
 * Resolves the tmux pane hosting the terminal that runs this session, if
 * any. A Muse TUI held session has no MSP attach endpoint, so typing into
 * its own tmux pane is the only metadata-free submission route — the exact
 * same user turn a human keystroke produces.
 */
async function resolveMuseTmuxTarget(transcriptPath: string | undefined): Promise<string | null> {
  if (!transcriptPath) return null;
  const tmuxBin = await whichBinary('tmux');
  if (!tmuxBin) return null;
  const pid = findMusePidHoldingLog(transcriptPath);
  if (!pid) return null;
  try {
    const { stdout } = await execFileAsync(tmuxBin, [
      'list-panes',
      '-a',
      '-F',
      '#{pane_id} #{pane_pid}',
    ]);
    return findTmuxPaneForPids(parseTmuxPaneList(stdout), ancestorPids(pid));
  } catch {
    return null;
  }
}

function shouldUseTmuxPaste(text: string): boolean {
  return text.includes('\n') || text.length > 500;
}

/** Live-registry directory every Muse process registers its sessions in. */
export const MUSE_RUNTIME_REGISTRY_DIR = path.join(MUSE_DATA_DIR, 'runtime', 'muse', 'sessions');

/** Parses the holding pid out of a live-registry entry (`process_generation_hint: "pid=N"`). */
export function parseMuseRegistryPid(raw: string): number | null {
  try {
    const parsed = JSON.parse(raw) as { process_generation_hint?: unknown };
    if (typeof parsed.process_generation_hint !== 'string') return null;
    const m = parsed.process_generation_hint.match(/^pid=(\d+)$/);
    if (!m) return null;
    const pid = Number(m[1]);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function readMuseRegistryPid(nativeId: string): number | null {
  try {
    return parseMuseRegistryPid(
      fs.readFileSync(path.join(MUSE_RUNTIME_REGISTRY_DIR, `${nativeId}.json`), 'utf8')
    );
  } catch {
    return null;
  }
}

export type MuseHolderKind = 'tui' | 'serve' | 'other';

/**
 * Classifies a `/proc/<pid>/cmdline` (NUL-separated) so the restart lane
 * only ever signals a plain interactive Muse terminal — never a `muse
 * serve` host (Super Harness's own pooled host included) and never a
 * headless/bridge invocation. Misclassification fails safe: anything
 * unrecognized is 'other' and is refused.
 */
export function classifyMuseHolderCmdline(cmdline: string): MuseHolderKind {
  const tokens = cmdline.split('\0').filter(Boolean);
  const argv = tokens.length > 0 ? tokens : cmdline.split(/\s+/).filter(Boolean);
  if (argv.length === 0) return 'other';
  const base = path.basename(argv[0] ?? '');
  if (!base.startsWith('muse')) return 'other';
  const rest = argv.slice(1);
  if (rest.includes('serve')) return 'serve';
  const NON_TUI_SUBCOMMANDS = new Set([
    'exec', 'attach', 'acp', 'mxp', 'sessions', 'session-message', 'export',
    'trace', 'usage', 'login', 'logout', 'auth', 'mcp', 'skills', 'plugins',
    'sandbox', 'schema', 'config', 'voice', 'init', 'model-profile',
  ]);
  if (rest.some((t) => NON_TUI_SUBCOMMANDS.has(t))) return 'other';
  return 'tui';
}

function readProcessCmdline(pid: number): string {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
  } catch {
    return '';
  }
}

/** Deterministic tmux session name for a restarted Muse session. */
export function buildMuseTmuxSessionName(title: string, nativeId: string): string {
  const slug =
    (title || 'muse')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 20) || 'muse';
  const suffix = nativeId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 6) || 'session';
  return `sh-muse-${slug}-${suffix}`;
}

const MUSE_RESUME_BOOL_FLAGS = new Set([
  '--yolo',
  '--disable-approval',
  '--disable-sandbox',
  '--trust-workspace',
  '--parallel-tool-calls',
  '--no-parallel-tool-calls',
]);
const MUSE_RESUME_VALUE_FLAGS = new Set([
  '--model',
  '--provider',
  '--reasoning-effort',
  '--effort',
  '--permission-profile',
  '--approval-mode',
  '--sandbox-network',
  '--preset',
]);

/**
 * Extracts the posture flags worth replaying from the original terminal's
 * launch cmdline, so the tmux relaunch resumes with the same trust /
 * approval / sandbox / model posture the user started with — a terminal
 * started with `--yolo` would otherwise stall on the workspace-trust
 * prompt after restart. Anything unrecognized (binary path, subcommand,
 * prompt text, endpoints) never carries over.
 */
export function extractMuseResumeFlags(cmdline: string): string[] {
  const tokens = cmdline.split('\0').filter(Boolean);
  const argv = tokens.length > 0 ? tokens : cmdline.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i] ?? '';
    const eq = token.indexOf('=');
    const name = token.startsWith('--') && eq > 2 ? token.slice(0, eq) : token;
    if (MUSE_RESUME_BOOL_FLAGS.has(name)) {
      out.push(name);
    } else if (MUSE_RESUME_VALUE_FLAGS.has(name)) {
      if (token.startsWith('--') && eq > 2) {
        const value = token.slice(eq + 1);
        if (value) out.push(name, value);
      } else if (i + 1 < argv.length) {
        out.push(name, argv[i + 1] ?? '');
        i++;
      }
    }
  }
  return out;
}

/** Shell command tmux runs to resume a Muse session in a new terminal. */
export function buildMuseResumeCommand(bin: string, nativeId: string, flags: string[] = []): string {
  return [bin, 'resume', nativeId, ...flags].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
}

async function waitForMuseHolderExit(transcriptPath: string, pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch {
      alive = false;
    }
    if (!alive || findMusePidHoldingLog(transcriptPath) !== pid) return true;
    await new Promise((r) => setTimeout(r, 200));
  }
  return findMusePidHoldingLog(transcriptPath) !== pid;
}

function mspSessionTimestamp(raw: unknown, fallback: number): number {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return raw > 1e14 ? Math.floor(raw / 1000) : Math.floor(raw);
  }
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

/**
 * Cohesive HarnessDriver encapsulating all Muse (Meta) integration:
 * session-index.db discovery plus an exact bi-directional MSP mirror —
 * dispatch submits genuine user turns with MSP `turn/start` on the host
 * that holds the session (Super Harness's pooled `muse serve`, or
 * `muse attach --stdio` when the holding host is attachable), and
 * transcripts fold the host's own `Item[]` from `session/read`. The raw
 * event-log fold (`parseMuseJsonlLines`) remains only as the fallback when
 * no MSP host can answer. Sessions a plain terminal holds expose no attach
 * endpoint, so dispatch to them is refused honestly — never rerouted
 * through peer messaging or headless double-driving.
 */
export function createMuseDriver(): HarnessDriver {
  const resolveBin = (): Promise<string | null> => whichBinary('muse');
  const pooled = new MuseMspClient({ resolveBin, lane: 'serve' });
  const attachClients = new Map<string, MuseMspClient>();

  const attachClientFor = (nativeId: string): MuseMspClient => {
    let client = attachClients.get(nativeId);
    if (!client) {
      client = new MuseMspClient({ resolveBin, lane: 'attach', attachSessionId: nativeId });
      attachClients.set(nativeId, client);
    }
    return client;
  };

  return {
    async applySessionConfig(session, change) {
      const next = 'Applies to the next turn Super Harness sends to this Muse session.';
      return resultsFor(change, (field, requested) => {
        if (field === 'permissionMode') {
          return {
            status: 'unsupported',
            detail:
              'Super Harness runs Muse turns with approvalMode allowAll because it has no approval UI for Muse yet; a stricter mode would stall turns waiting for approvals nobody can answer.',
          };
        }
        if (!requested.trim()) return { status: 'next_message', value: '', detail: 'Override cleared. ' + next };
        if (field === 'model') return { status: 'next_message', value: requested.trim(), detail: next + ' (set with MSP model/set before the turn).' };
        const v = normalizeEffort(requested, MUSE_EFFORT_LEVELS);
        return v ? { status: 'next_message', value: v, detail: next } : invalid(MUSE_EFFORT_LEVELS);
      });
    },

    id: 'muse',
    displayName: 'Muse',

    detect(processes, maxSessions) {
      return detectMuse(processes, maxSessions);
    },

    async getTranscriptFingerprint(session) {
      const resolved = resolveMuseTranscriptPath(session.nativeId, session.transcriptPath);
      return computeFileFingerprint(resolved);
    },

    async loadTranscript(session, limit) {
      // Native mirror: ask the MSP host for its folded item history. A
      // foreign host can serve session/read even for sessions another host
      // (or a terminal) holds, so terminal activity mirrors here too.
      try {
        const res = await pooled.readSession(session.nativeId, false);
        const history = res.history as Record<string, unknown> | undefined;
        const items = extractMspHistoryItems(history);
        if (items.length > 0) {
          const all = foldMspItems(items, session.updatedAt);
          const totalCount = all.length;
          const sliced = totalCount > limit ? all.slice(totalCount - limit) : all;
          const sess = (res.session ?? {}) as Record<string, unknown>;
          const resolved = resolveMuseTranscriptPath(session.nativeId, session.transcriptPath);
          let sourceMtimeMs = Date.now();
          try {
            if (resolved) sourceMtimeMs = fs.statSync(resolved).mtimeMs;
          } catch {
            // keep now
          }
          const snapshot = history?.snapshot as Record<string, unknown> | null | undefined;
          const snapshotState = snapshot?.state as Record<string, unknown> | undefined;
          const steps = mapMspTodoItems(snapshotState?.todoList);
          const hasInProgressStep = Boolean(steps?.some((s) => s.status === 'in_progress'));
          const recentlyWritten = Date.now() - sourceMtimeMs < 35_000;
          const diskWorking = resolved ? museTranscriptIsWorking(resolved) : null;
          const isWorking =
            res.modelTurnRunning === true ||
            (typeof sess.activeTurnId === 'string' && sess.activeTurnId.length > 0) ||
            (recentlyWritten &&
              (diskWorking === true || (diskWorking !== false && hasInProgressStep)));
          return {
            sessionId: session.id,
            messages: sliced,
            totalCount,
            hasMore: totalCount > limit,
            sourceMtimeMs,
            liveActivity: {
              isWorking,
              steps,
              lastEventAt: mspSessionTimestamp(
                sess.lastActivityAt ?? sess.updatedAt,
                session.updatedAt
              ),
            },
          };
        }
      } catch {
        // No MSP answer (host down, unknown session) — raw log fallback.
      }
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
      opts?: { force?: boolean }
    ): Promise<SendMessageResult> {
      const bin = await whichBinary('muse');
      if (!bin) return { ok: false, error: 'muse CLI not found' };
      const runId = crypto.randomBytes(6).toString('hex');

      const live = (await getLiveMuseSessions(bin, true)).get(session.nativeId);
      if (live && live.attachable !== true) {
        // Terminal-held with no MSP attach endpoint. If that terminal is a
        // tmux pane, type into it — the exact user turn a keystroke makes,
        // with a transcript ack so a swallowed Enter is never silent.
        const transcriptPath = resolveMuseTranscriptPath(
          session.nativeId,
          session.transcriptPath
        );
        const tmuxTarget = await resolveMuseTmuxTarget(transcriptPath);
        if (tmuxTarget) {
          const tmuxBin = (await whichBinary('tmux')) as string;
          const body = formatPromptWithImagePaths(prompt, attachments);
          try {
            if (shouldUseTmuxPaste(body)) {
              const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-muse-tmux-'));
              const tmpFile = path.join(tmpDir, 'prompt.txt');
              try {
                fs.writeFileSync(tmpFile, body);
                await execFileAsync(tmuxBin, ['load-buffer', tmpFile], { timeout: 4000 });
                await execFileAsync(tmuxBin, ['paste-buffer', '-t', tmuxTarget, '-p', '-d'], {
                  timeout: 4000,
                });
              } finally {
                fs.rmSync(tmpDir, { recursive: true, force: true });
              }
            } else {
              await execFileAsync(tmuxBin, ['send-keys', '-t', tmuxTarget, '-l', body], {
                timeout: 4000,
              });
            }
            await new Promise((r) => setTimeout(r, 150));
            await execFileAsync(tmuxBin, ['send-keys', '-t', tmuxTarget, 'C-m'], {
              timeout: 4000,
            });
            const delivered = await waitForMuseTranscriptDelivery(transcriptPath, prompt, 4000);
            ctx.triggerRefresh(800);
            ctx.triggerRefresh(2500);
            if (!delivered) {
              return {
                ok: false,
                error:
                  'Super Harness typed your message into the tmux Muse terminal but could not confirm it landed in the session log within 4 seconds. Check that terminal before resending, to avoid a duplicate.',
              };
            }
            return {
              ok: true,
              runId,
              dispatchedVia: `Muse terminal typing via tmux (no MSP attach endpoint) → ${tmuxTarget}`,
            };
          } catch (err) {
            return {
              ok: false,
              error: `tmux typing into the Muse terminal failed: ${err instanceof Error ? err.message : String(err)}`,
            };
          }
        }
        return { ok: false, error: buildMuseUndeliverableError(session, 'tui-held') };
      }
      const client = live ? attachClientFor(session.nativeId) : pooled;

      try {
        if (opts?.force) {
          const steered = await client.steerTurn(session.nativeId, prompt, attachments);
          if (steered) {
            ctx.triggerRefresh(300);
            return { ok: true, runId, dispatchedVia: 'Muse MSP turn/steer' };
          }
          if (client.hasActiveTurn(session.nativeId)) {
            await client.interruptSession(session.nativeId);
          }
        }
        if (session.model?.trim()) {
          try {
            const conn = await client.ensureConnected();
            await conn.setModel(session.nativeId, session.model.trim());
          } catch {
            // Best-effort: the session's retained model binding still applies.
          }
        }
        await client.sendTurn({
          shSessionId: session.id,
          nativeSessionId: session.nativeId,
          prompt,
          attachments,
          reasoningEffort: session.reasoningEffort,
          runId,
          onEvent: ctx.emitStream,
          onComplete: () => {
            ctx.triggerRefresh(400);
            ctx.triggerRefresh(1800);
          },
        });
        return {
          ok: true,
          runId,
          dispatchedVia:
            attachments && attachments.length > 0
              ? `Muse MSP turn/start (${attachments.length} image${attachments.length === 1 ? '' : 's'})`
              : 'Muse MSP turn/start',
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (
          classifyMspError(err) === 'session-in-use' ||
          message.includes('no attach endpoint') ||
          message.includes('held by a TUI')
        ) {
          return { ok: false, error: buildMuseUndeliverableError(session, 'tui-held') };
        }
        return {
          ok: false,
          error: buildMuseUndeliverableError(session, 'other'),
        };
      }
    },

    async startSession(
      req: StartSessionRequest,
      ctx: DispatchContext
    ): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
      const bin = await whichBinary('muse');
      if (!bin) return { ok: false, error: 'muse CLI not found' };
      const cwd = fs.existsSync(req.cwd) ? req.cwd : os.homedir();
      const runId = crypto.randomBytes(6).toString('hex');
      try {
        const nativeId = await pooled.startSession({ cwd, model: req.model });
        const sessionId = `muse:${nativeId}`;
        const promptText = req.prompt?.trim() || '';
        const hasAttachments = Boolean(req.attachments && req.attachments.length > 0);
        await pooled.sendTurn({
          shSessionId: sessionId,
          nativeSessionId: nativeId,
          prompt:
            promptText ||
            (hasAttachments
              ? 'Inspect the attached image(s).'
              : 'Hello! Summarize the workspace briefly.'),
          attachments: req.attachments,
          reasoningEffort: req.reasoningEffort,
          runId,
          onEvent: ctx.emitStream,
          onComplete: () => {
            ctx.triggerRefresh(400);
            ctx.triggerRefresh(1800);
          },
        });
        ctx.triggerRefresh(800);
        ctx.triggerRefresh(2500);
        return { ok: true, sessionId };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : 'Muse MSP session/start failed',
        };
      }
    },

    abort(sessionId: string, emitStream: (ev: StreamEvent) => void): boolean {
      if (!sessionId.startsWith('muse:')) return false;
      const nativeId = sessionId.slice('muse:'.length);
      const attach = attachClients.get(nativeId);
      const client =
        attach && attach.hasActiveTurn(nativeId) ? attach : pooled.hasActiveTurn(nativeId) ? pooled : null;
      if (!client) return false;
      void client.interruptSession(nativeId);
      emitStream({ sessionId, runId: 'abort', kind: 'done' });
      return true;
    },

    shutdown(): void {
      pooled.close();
      for (const client of attachClients.values()) client.close();
      attachClients.clear();
    },

    async controlDaemon() {
      // Super Harness hosts Muse sessions itself over MSP (`muse serve`);
      // there is no separate remote daemon/desktop to start or stop. The
      // Settings UI hides these controls via canControlDaemon=false — this
      // clean one-liner is for MCP/API callers that ask anyway.
      return { ok: false, error: 'Muse has no remote daemon to start or stop.' };
    },

    /**
     * Restart a terminal-held Muse session inside tmux so Super Harness
     * can reach it with the terminal typing lane. The holding process is
     * identified as the muse process with this session's log open,
     * cross-checked against Muse's live registry pid, and re-verified
     * (cmdline still a plain interactive TUI, still the log holder)
     * immediately before SIGTERM. A `muse serve` host is never signalled.
     */
    async promoteToTmux(
      session: UnifiedSession,
      ctx: DispatchContext
    ): Promise<{ ok: boolean; tmuxSession?: string; error?: string }> {
      const bin = await whichBinary('muse');
      const tmuxBin = await whichBinary('tmux');
      if (!bin) return { ok: false, error: 'muse CLI not found' };
      if (!tmuxBin) return { ok: false, error: 'tmux not found' };

      const transcriptPath = resolveMuseTranscriptPath(session.nativeId, session.transcriptPath);
      if (!transcriptPath) {
        return { ok: false, error: 'Could not locate the Muse session log for this session.' };
      }

      const live = (await getLiveMuseSessions(bin, true)).get(session.nativeId);
      if (live && live.attachable === true) {
        return {
          ok: false,
          error:
            'This Muse session is already reachable over Muse\u2019s MSP API, so there is nothing to restart. Send your message here and Super Harness will deliver it natively.',
        };
      }

      const existingPane = await resolveMuseTmuxTarget(transcriptPath);
      if (existingPane) {
        let tmuxSession = existingPane;
        try {
          const { stdout } = await execFileAsync(
            tmuxBin,
            ['display-message', '-t', existingPane, '-p', '#{session_name}'],
            { timeout: 3000 }
          );
          if (stdout.trim()) tmuxSession = stdout.trim();
        } catch {
          // Pane id is still a usable label.
        }
        return { ok: true, tmuxSession };
      }

      if (museTranscriptIsWorking(transcriptPath) === true) {
        return {
          ok: false,
          error:
            'This Muse session is in the middle of a turn in its terminal. Restarting now would kill that work, so Super Harness left it running. Wait for the turn to finish (or stop it in that terminal), then use Restart in tmux again.',
        };
      }

      const holderPid = findMusePidHoldingLog(transcriptPath);
      if (live && !holderPid) {
        return {
          ok: false,
          error:
            'Super Harness could not identify the exact terminal process holding this Muse session, so it did not close anything. Close that terminal yourself, then use Restart in tmux again.',
        };
      }

      let resumeFlags: string[] = [];
      if (holderPid) {
        resumeFlags = extractMuseResumeFlags(readProcessCmdline(holderPid));
        const registryPid = readMuseRegistryPid(session.nativeId);
        if (registryPid && registryPid !== holderPid) {
          return {
            ok: false,
            error: `Super Harness found conflicting records for the process holding this Muse session (log holder pid ${holderPid}, live registry pid ${registryPid}), so it did not close anything. Close that terminal yourself, then use Restart in tmux again.`,
          };
        }
        if (holderPid === process.pid) {
          return { ok: false, error: 'This session is held by Super Harness itself; nothing to restart.' };
        }
        const kind = classifyMuseHolderCmdline(readProcessCmdline(holderPid));
        if (kind === 'serve') {
          return {
            ok: false,
            error:
              'This Muse session is held by a `muse serve` host process, not a plain terminal, so Super Harness will not close it. It should already be reachable over MSP; press Retry on your message.',
          };
        }
        if (kind !== 'tui') {
          return {
            ok: false,
            error: `The process holding this Muse session (pid ${holderPid}) is not a plain Muse terminal, so Super Harness did not close it. Close it yourself, then use Restart in tmux again.`,
          };
        }
        // Re-verify immediately before signalling: same pid, still the log
        // holder, still an interactive Muse TUI.
        if (
          findMusePidHoldingLog(transcriptPath) !== holderPid ||
          classifyMuseHolderCmdline(readProcessCmdline(holderPid)) !== 'tui'
        ) {
          return {
            ok: false,
            error:
              'The terminal holding this Muse session changed while Super Harness was checking it, so nothing was closed. Use Restart in tmux again.',
          };
        }
        try {
          process.kill(holderPid, 'SIGTERM');
        } catch (err) {
          return {
            ok: false,
            error: `Could not close the Muse terminal process (pid ${holderPid}): ${err instanceof Error ? err.message : String(err)}`,
          };
        }
        // A Muse TUI's graceful shutdown takes ~25s (measured on an idle
        // echo session: SIGTERM and double-SIGINT both release the session
        // log only at process exit), so give it 30s before giving up.
        const exited = await waitForMuseHolderExit(transcriptPath, holderPid, 30_000);
        if (!exited) {
          return {
            ok: false,
            error: `The Muse terminal process (pid ${holderPid}) did not close within 30 seconds of being asked, so Super Harness did not start a second copy of the session. Close that terminal yourself, then use Restart in tmux again.`,
          };
        }
        invalidateMuseLiveSessionsCache();
      }

      const cwd = fs.existsSync(session.cwd) ? session.cwd : os.homedir();
      const tmuxSession = buildMuseTmuxSessionName(session.title || 'muse', session.nativeId);
      try {
        await execFileAsync(tmuxBin, ['has-session', '-t', tmuxSession], { timeout: 3000 });
        return { ok: true, tmuxSession };
      } catch {
        // No such tmux session yet — create it below.
      }
      try {
        await execFileAsync(
          tmuxBin,
          [
            'new-session',
            '-d',
            '-s',
            tmuxSession,
            '-c',
            cwd,
            buildMuseResumeCommand(bin, session.nativeId, resumeFlags),
          ],
          { timeout: 5000 }
        );
      } catch (err) {
        return {
          ok: false,
          error: `The old terminal was closed, but Super Harness could not relaunch the session in tmux: ${err instanceof Error ? err.message : String(err)}. Nothing was lost — resume it manually with: tmux new-session -s ${tmuxSession} 'muse resume ${session.nativeId}'`,
        };
      }

      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const pane = await resolveMuseTmuxTarget(transcriptPath);
        if (pane) {
          ctx.triggerRefresh(400);
          ctx.triggerRefresh(1800);
          return { ok: true, tmuxSession };
        }
        await new Promise((r) => setTimeout(r, 300));
      }
      ctx.triggerRefresh(800);
      return {
        ok: false,
        error: `Super Harness relaunched the session in tmux session '${tmuxSession}' but could not confirm the Muse terminal finished starting there. Inspect it with: tmux attach -t ${tmuxSession} — if it is waiting on a prompt, answer it there and Super Harness will be able to type into it.`,
      };
    },

    async archiveSession() {
      // No native archive command; fall back to Super Harness local hide.
      return null;
    },
  };
}

