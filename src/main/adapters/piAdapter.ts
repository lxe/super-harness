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
  SendMessageResult,
  SessionStats,
  SessionTranscriptResult,
  StartSessionRequest,
  StreamEvent,
  UnifiedBlock,
  UnifiedMessage,
  UnifiedSession,
} from '../../shared/types';
import { PiRpcPool, splitPiModelRef, type PiRpcTurnHooks } from '../services/piRpcClient';
import { readJsonlTailLines, readProgressiveJsonlTail } from '../utils/tailReader';
import { cleanTextPreview, getBinaryVersionCached, projectNameFromCwd, whichBinary, type ProcessRow } from '../utils/system';
import { findTmuxPaneForPids, parseTmuxPaneList } from './museAdapter';
import { invalid, normalizeEffort, resultsFor } from './sessionConfig';
import {
  computeFileFingerprint,
  createUniqueIdGenerator,
  formatPromptWithImagePaths,
  type DispatchContext,
  type HarnessDriver,
  type HarnessWatchSpec,
} from './types';

const execFileAsync = promisify(execFile);

/** Pi's config dir (`PI_CODING_AGENT_DIR`, default `~/.pi/agent`). */
export const PI_AGENT_DIR = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');

/** Session storage: `PI_CODING_AGENT_SESSION_DIR`, then settings.json `sessionDir`, then `<agent>/sessions`. */
export function piSessionsDir(): string {
  if (process.env.PI_CODING_AGENT_SESSION_DIR) return process.env.PI_CODING_AGENT_SESSION_DIR;
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(PI_AGENT_DIR, 'settings.json'), 'utf8')) as {
      sessionDir?: unknown;
    };
    if (typeof settings.sessionDir === 'string' && path.isAbsolute(settings.sessionDir)) return settings.sessionDir;
  } catch {
    // default below
  }
  return path.join(PI_AGENT_DIR, 'sessions');
}

/** Pi thinking levels (`--thinking`, RPC `set_thinking_level`). */
export const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** `--home-lxe-proj--`: Pi drops the leading separator and maps `/`, `\` and `:` to `-`. */
export function encodePiCwd(cwd: string): string {
  return `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`;
}

/** `<timestamp>_<session-id>.jsonl` → session id. */
export function piSessionIdFromFilename(name: string): string | null {
  const m = name.match(/^[^_]+_(.+)\.jsonl$/);
  return m ? m[1] : null;
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};

function isoToMs(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return fallback;
}

/** Text and images of a Pi user message (`content` is a string or text/image blocks). */
export function piUserContent(content: unknown): {
  text: string;
  images: Array<Extract<UnifiedBlock, { type: 'image' }>>;
} {
  if (typeof content === 'string') return { text: content, images: [] };
  const texts: string[] = [];
  const images: Array<Extract<UnifiedBlock, { type: 'image' }>> = [];
  if (Array.isArray(content)) {
    content.forEach((raw, i) => {
      const b = asRecord(raw);
      if (b.type === 'text' && typeof b.text === 'string') texts.push(b.text);
      else if (b.type === 'image' && typeof b.data === 'string' && b.data) {
        const mime = typeof b.mimeType === 'string' ? b.mimeType : 'image/png';
        images.push({ type: 'image', path: `pi-image-${i}`, name: `image ${i + 1}`, dataUrl: `data:${mime};base64,${b.data}` });
      }
    });
  }
  return { text: texts.join('\n'), images };
}

// ---------------------------------------------------------------------------
// Discovery metadata (incremental scan of append-only session files)
// ---------------------------------------------------------------------------

export interface PiSessionMeta {
  nativeId: string;
  path: string;
  cwd: string;
  createdAt: number;
  name?: string;
  firstUserText?: string;
  /** `provider/modelId` of the latest model_change (else of the latest assistant message). */
  model?: string;
  thinking?: string;
  parentSession?: string;
  userMessages: number;
  /** Bytes consumed so far (always at a line boundary). */
  offset: number;
  mtimeMs: number;
}

/**
 * Folds complete JSONL lines into session metadata. Only the cheap, line-local facts
 * discovery needs: header, display name, model and thinking level, first prompt.
 */
export function foldPiMetaLines(meta: PiSessionMeta, lines: string[]): PiSessionMeta {
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('{"type":"session"')) {
      try {
        const o = JSON.parse(line) as Record<string, unknown>;
        if (typeof o.id === 'string') meta.nativeId = o.id;
        if (typeof o.cwd === 'string') meta.cwd = o.cwd;
        meta.createdAt = isoToMs(o.timestamp, meta.createdAt);
        if (typeof o.parentSession === 'string') meta.parentSession = o.parentSession;
      } catch {
        // malformed header
      }
      continue;
    }
    const isInfo = line.includes('"type":"session_info"');
    const isModel = line.includes('"type":"model_change"');
    const isThinking = line.includes('"type":"thinking_level_change"');
    const isUser = line.includes('"role":"user"');
    const isAssistantModel = !meta.model && line.includes('"role":"assistant"');
    if (!isInfo && !isModel && !isThinking && !isUser && !isAssistantModel) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (o.type === 'session_info') {
      meta.name = typeof o.name === 'string' && o.name.trim() ? o.name.trim() : undefined;
    } else if (o.type === 'model_change' && typeof o.provider === 'string' && typeof o.modelId === 'string') {
      meta.model = `${o.provider}/${o.modelId}`;
    } else if (o.type === 'thinking_level_change' && typeof o.thinkingLevel === 'string') {
      meta.thinking = o.thinkingLevel;
    } else if (o.type === 'message') {
      const msg = asRecord(o.message);
      if (msg.role === 'user') {
        meta.userMessages++;
        if (!meta.firstUserText) {
          const { text } = piUserContent(msg.content);
          if (text.trim()) meta.firstUserText = text;
        }
      } else if (msg.role === 'assistant' && !meta.model && typeof msg.provider === 'string' && typeof msg.model === 'string') {
        meta.model = `${msg.provider}/${msg.model}`;
      }
    }
  }
  return meta;
}

const metaCache = new Map<string, PiSessionMeta>();

/** Reads only the bytes appended since the last scan (sessions are append-only). */
export function scanPiSessionMeta(filePath: string, st: fs.Stats): PiSessionMeta | null {
  let meta = metaCache.get(filePath);
  if (meta && st.size < meta.offset) meta = undefined; // rewritten (migration): start over
  if (meta && meta.offset === st.size) {
    meta.mtimeMs = st.mtimeMs;
    return meta;
  }
  const base = path.basename(filePath);
  meta ??= {
    nativeId: piSessionIdFromFilename(base) || base,
    path: filePath,
    cwd: '',
    createdAt: st.birthtimeMs || st.ctimeMs,
    userMessages: 0,
    offset: 0,
    mtimeMs: st.mtimeMs,
  };
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const CHUNK = 1024 * 1024;
    let carry = '';
    let pos = meta.offset;
    while (pos < st.size) {
      const len = Math.min(CHUNK, st.size - pos);
      const buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, pos);
      if (n <= 0) break;
      pos += n;
      const text = carry + buf.subarray(0, n).toString('utf8');
      const lastNl = text.lastIndexOf('\n');
      if (lastNl < 0) {
        carry = text;
        continue;
      }
      foldPiMetaLines(meta, text.slice(0, lastNl).split('\n'));
      carry = text.slice(lastNl + 1);
    }
    // A trailing partial line is re-read next time.
    meta.offset = pos - Buffer.byteLength(carry, 'utf8');
    meta.mtimeMs = st.mtimeMs;
    metaCache.set(filePath, meta);
    return meta;
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

export interface PiTailState {
  /** The last turn has not reached a final assistant message. */
  midTurn: boolean;
  lastEventAt: number;
  /** Name of the tool whose result has not landed yet, when the tail ends on a tool call. */
  activeTool?: string;
}

/**
 * Turn-boundary probe over the file tail: Pi persists each message at message_end, so a
 * tail ending on a user message, a tool result, or an assistant message that stopped for
 * tool use means a run is still going (if a process is alive to run it).
 */
export function piTailState(lines: string[], fallbackTs: number): PiTailState {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"type":"message"') && !line.includes('"type":"compaction"')) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const ts = isoToMs(o.timestamp, fallbackTs);
    if (o.type === 'compaction') return { midTurn: true, lastEventAt: ts };
    const msg = asRecord(o.message);
    const role = msg.role;
    if (role === 'system' || role === 'custom') continue;
    if (role === 'assistant') {
      if (msg.stopReason === 'toolUse') {
        const calls = (Array.isArray(msg.content) ? msg.content : []).map(asRecord).filter((b) => b.type === 'toolCall');
        const last = calls[calls.length - 1];
        return { midTurn: true, lastEventAt: ts, activeTool: typeof last?.name === 'string' ? last.name : undefined };
      }
      return { midTurn: false, lastEventAt: ts };
    }
    if (role === 'user' || role === 'toolResult') return { midTurn: true, lastEventAt: ts };
    return { midTurn: false, lastEventAt: ts };
  }
  return { midTurn: false, lastEventAt: fallbackTs };
}

function readPiTailState(filePath: string, mtimeMs: number): PiTailState {
  const tail = readJsonlTailLines(filePath, 256 * 1024);
  return piTailState(tail?.lines ?? [], mtimeMs);
}

// ---------------------------------------------------------------------------
// Terminal holders (Pi TUI / print processes Superharness did not start)
// ---------------------------------------------------------------------------

export interface PiHolderProcess {
  pid: number;
  cwd: string;
  startedAt: number;
}

let bootTimeMs: number | null | undefined;
function readBootTimeMs(): number | null {
  if (bootTimeMs !== undefined) return bootTimeMs;
  try {
    const m = fs.readFileSync('/proc/stat', 'utf8').match(/^btime (\d+)/m);
    bootTimeMs = m ? Number(m[1]) * 1000 : null;
  } catch {
    bootTimeMs = null;
  }
  return bootTimeMs;
}

function readProcStartMs(pid: number): number | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ticks = Number(fields[19]); // field 22 (starttime), counted from after the comm
    const boot = readBootTimeMs();
    if (!Number.isFinite(ticks) || boot === null) return null;
    return boot + (ticks / 100) * 1000;
  } catch {
    return null;
  }
}

/** True for a process row that is the Pi CLI (it retitles itself `pi`). */
export function isPiProcessRow(p: ProcessRow): boolean {
  return p.comm === 'pi' || /pi-coding-agent\/dist\/(?:bundle\/)?cli\.js/.test(p.args);
}

export function findPiHolderProcesses(processes: ProcessRow[], ownPids: Set<number>): PiHolderProcess[] {
  const out: PiHolderProcess[] = [];
  for (const p of processes) {
    if (!isPiProcessRow(p) || ownPids.has(p.pid) || p.pid === process.pid) continue;
    let cwd = '';
    try {
      cwd = fs.readlinkSync(`/proc/${p.pid}/cwd`);
    } catch {
      continue;
    }
    out.push({ pid: p.pid, cwd, startedAt: readProcStartMs(p.pid) ?? 0 });
  }
  return out;
}

/**
 * Pairs foreign Pi processes with the sessions they hold. Pi keeps no lock and retitles
 * itself, so the only link is the working folder plus write time. Within one folder, the
 * sessions written since the earliest holder started are "possibly held". The pairing is
 * confident only when the folder has exactly one holder and exactly one such session;
 * otherwise sessions are still paired for display (newest process takes the newest file)
 * but all of them are marked ambiguous, and dispatch refuses rather than risk typing into
 * the wrong terminal or forking a session another process is writing.
 *
 * `sessions` must exclude files Superharness itself last wrote.
 */
export function assignPiHolders(
  holders: PiHolderProcess[],
  sessions: Array<{ nativeId: string; cwd: string; mtimeMs: number }>
): { byNativeId: Map<string, PiHolderProcess>; ambiguous: Set<string> } {
  const byNativeId = new Map<string, PiHolderProcess>();
  const ambiguous = new Set<string>();
  const byCwd = new Map<string, PiHolderProcess[]>();
  for (const h of holders) byCwd.set(h.cwd, [...(byCwd.get(h.cwd) ?? []), h]);
  for (const [cwd, hs] of byCwd) {
    const earliest = Math.min(...hs.map((h) => h.startedAt));
    const possible = sessions
      .filter((s) => s.cwd === cwd && s.mtimeMs >= earliest - 2000)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    const sorted = [...hs].sort((a, b) => b.startedAt - a.startedAt);
    const taken = new Set<string>();
    for (const h of sorted) {
      const pick = possible.find((s) => !taken.has(s.nativeId) && s.mtimeMs >= h.startedAt - 2000);
      if (!pick) continue;
      taken.add(pick.nativeId);
      byNativeId.set(pick.nativeId, h);
    }
    if (!(hs.length === 1 && possible.length === 1)) for (const s of possible) ambiguous.add(s.nativeId);
  }
  return { byNativeId, ambiguous };
}

function readParentPid(pid: number): number {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
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

let tmuxPanesCache: { at: number; panes: Map<number, string> } | null = null;
async function listTmuxPanes(): Promise<Map<number, string>> {
  if (tmuxPanesCache && Date.now() - tmuxPanesCache.at < 3000) return tmuxPanesCache.panes;
  let panes = new Map<number, string>();
  try {
    const { stdout } = await execFileAsync('tmux', ['list-panes', '-a', '-F', '#{pane_id} #{pane_pid}'], { timeout: 3000 });
    panes = parseTmuxPaneList(stdout);
  } catch {
    // no tmux server
  }
  tmuxPanesCache = { at: Date.now(), panes };
  return panes;
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

const MAX_TOOL_OUTPUT_CHARS = 60_000;

/** At most this many images are pulled out of one assistant turn's text. */
export const MAX_PI_LINKED_IMAGES_PER_TURN = 4;
const PI_LINKED_IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);

/** Resolves a link target to an existing local image file, or null. */
function resolveLocalImagePath(target: string): string | null {
  let p = target.trim().replace(/^<|>$/g, '');
  if (p.startsWith('file://')) {
    try {
      p = decodeURIComponent(new URL(p).pathname);
    } catch {
      return null;
    }
  } else if (p.startsWith('~/')) {
    p = path.join(os.homedir(), p.slice(2));
  }
  if (!path.isAbsolute(p)) return null;
  if (!PI_LINKED_IMAGE_EXTS.has(path.extname(p).toLowerCase())) return null;
  try {
    return fs.statSync(p).isFile() ? p : null;
  } catch {
    return null;
  }
}

/**
 * Pi has no "send a file" tool, so models hand over images as markdown links to local
 * paths, which are dead links on the phone. This finds links to image files that exist
 * on this machine (`![a](p)`, `[a](p)`, `[![a](p)](p)`, `file://` URLs and bare absolute
 * paths), drops the link syntax from the text, and returns image blocks so the phone shows
 * a thumbnail via /api/media. Missing files and non-image links are left untouched.
 * `seen`/`budget` carry dedupe and the per-turn cap across a turn's text blocks.
 */
export function extractPiLinkedImages(
  text: string,
  seen: Set<string>,
  budget: { left: number }
): { text: string; images: Array<Extract<UnifiedBlock, { type: 'image' }>> } {
  const images: Array<Extract<UnifiedBlock, { type: 'image' }>> = [];
  const take = (target: string, alt: string): boolean => {
    const p = resolveLocalImagePath(target);
    if (!p) return false;
    if (!seen.has(p) && budget.left > 0) {
      seen.add(p);
      budget.left -= 1;
      images.push({ type: 'image', path: p, name: alt.trim() || path.basename(p) });
    }
    return true;
  };
  // Linked image `[![alt](p)](p)` → one image, no leftover text.
  let out = text.replace(/\[!\[([^\]]*)\]\(([^)\s]+)\)\]\(([^)\s]+)\)/g, (m, alt: string, src: string) =>
    take(src, alt) ? '' : m
  );
  // Image `![alt](p)` → removed from text.
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (m, alt: string, src: string) => (take(src, alt) ? '' : m));
  // Link `[label](p)` → label stays as plain text.
  out = out.replace(/(?<!!)\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label: string, href: string) =>
    take(href, label) ? label : m
  );
  // Bare absolute, `~/` or file:// paths stay in the text; the image is shown as well.
  for (const m of out.matchAll(/(?:file:\/\/|~\/|(?<![\w.~:/-])\/)[^\s`'"<>()[\]]+\.(?:png|jpe?g|webp|gif)\b/gi)) {
    take(m[0], '');
  }
  return { text: out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n'), images };
}

type PendingBlock = Extract<UnifiedBlock, { type: 'command' | 'tool_call' | 'file_change' }>;

function textOfResult(content: unknown): string {
  if (typeof content === 'string') return content;
  return (Array.isArray(content) ? content : [])
    .map(asRecord)
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => String(b.text))
    .join('\n');
}

function blockForToolCall(name: string, args: Record<string, unknown>): PendingBlock {
  if (name === 'bash' && typeof args.command === 'string') {
    return { type: 'command', command: args.command, status: 'running' };
  }
  if ((name === 'edit' || name === 'write') && typeof args.path === 'string') {
    let diff: string | undefined;
    if (name === 'write' && typeof args.content === 'string') diff = `+ ${args.content.slice(0, 800)}`;
    else if (Array.isArray(args.edits)) {
      diff = args.edits
        .map(asRecord)
        .map((e) => `- ${String(e.oldText ?? '').slice(0, 400)}\n+ ${String(e.newText ?? '').slice(0, 400)}`)
        .join('\n')
        .slice(0, 4000);
    }
    return { type: 'file_change', changes: [{ path: args.path, kind: name, diff }], status: 'running' };
  }
  return { type: 'tool_call', name, args: JSON.stringify(args, null, 2).slice(0, 4000), status: 'running' };
}

function attachToolResult(block: PendingBlock, msg: Record<string, unknown>): void {
  const text = textOfResult(msg.content);
  const failed = msg.isError === true;
  const details = asRecord(msg.details);
  if (block.type === 'command') {
    block.output = text.slice(0, MAX_TOOL_OUTPUT_CHARS);
    const exit = details.exit_code ?? details.exitCode;
    block.exitCode = typeof exit === 'number' ? exit : failed ? 1 : null;
    if (typeof msg.durationMs === 'number') block.durationMs = msg.durationMs;
    block.status = failed ? 'failed' : 'completed';
  } else if (block.type === 'file_change') {
    if (typeof details.diff === 'string' && block.changes[0]) block.changes[0].diff = details.diff.slice(0, 8000);
    block.status = failed ? 'failed' : 'completed';
  } else {
    block.output = text.slice(0, MAX_TOOL_OUTPUT_CHARS);
    if (typeof msg.durationMs === 'number') block.durationMs = msg.durationMs;
    block.status = failed ? 'failed' : 'completed';
  }
}

/**
 * Entries on the active branch, oldest first. Pi sessions are trees (`id`/`parentId`);
 * the leaf is the newest entry with an id. Walking parents from it drops abandoned
 * branches. In a truncated tail the walk stops where a parent falls outside the window.
 */
export function piActiveBranch(entries: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const byId = new Map<string, Record<string, unknown>>();
  let leaf: Record<string, unknown> | undefined;
  for (const e of entries) {
    if (typeof e.id !== 'string' || e.type === 'session') continue;
    byId.set(e.id, e);
    leaf = e;
  }
  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  let cur = leaf;
  while (cur && typeof cur.id === 'string' && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.push(cur);
    cur = typeof cur.parentId === 'string' ? byId.get(cur.parentId) : undefined;
  }
  return out.reverse();
}

export function computePiSessionStats(branch: Array<Record<string, unknown>>): SessionStats {
  const stats: SessionStats = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    contextUsedTokens: 0,
    estimatedCostUsd: 0,
    turnCount: 0,
  };
  for (const e of branch) {
    const usage =
      e.type === 'message' ? asRecord(asRecord(e.message).usage) : e.type === 'compaction' || e.type === 'usage' ? asRecord(e.usage) : {};
    if (!Object.keys(usage).length) continue;
    const n = (k: string) => (typeof usage[k] === 'number' ? (usage[k] as number) : 0);
    stats.inputTokens += n('input');
    stats.outputTokens += n('output');
    stats.cacheReadTokens += n('cacheRead');
    stats.cacheWriteTokens += n('cacheWrite');
    stats.totalTokens += n('totalTokens');
    const cost = asRecord(usage.cost);
    if (typeof cost.total === 'number') stats.estimatedCostUsd += cost.total;
    if (e.type === 'message' && asRecord(e.message).role === 'assistant') {
      stats.turnCount++;
      stats.contextUsedTokens = n('input') + n('cacheRead') + n('cacheWrite') + n('output');
    }
  }
  stats.estimatedCostUsd = Math.round(stats.estimatedCostUsd * 10000) / 10000;
  return stats;
}

/**
 * Parses Pi session JSONL lines into unified messages along the active branch:
 * user messages (text + images), assistant thinking/text/tool calls coalesced per turn
 * with tool results attached by call id (`bash` → command, `edit`/`write` → file change
 * with Pi's own diff, everything else → tool call), `!` shell runs, compaction and
 * branch summaries as notices, and extension messages that Pi displays.
 */
export function parsePiJsonlLines(
  lines: string[],
  sessionId: string,
  sourceMtimeMs: number,
  limit = 120,
  meta?: { truncated?: boolean }
): SessionTranscriptResult & { tail: PiTailState } {
  const entries: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // partial first line of a tail window
    }
  }
  const branch = piActiveBranch(entries);
  const messages: UnifiedMessage[] = [];
  const uniqueId = createUniqueIdGenerator();
  const pending = new Map<string, PendingBlock>();
  let current: UnifiedMessage | null = null;
  let lastFocus: string | undefined;
  // Dedupe and cap linked images per coalesced assistant turn.
  const linkedImageState = new WeakMap<UnifiedMessage, { seen: Set<string>; budget: { left: number } }>();
  const linkedState = (m: UnifiedMessage) => {
    let s = linkedImageState.get(m);
    if (!s) {
      s = { seen: new Set(), budget: { left: MAX_PI_LINKED_IMAGES_PER_TURN } };
      linkedImageState.set(m, s);
    }
    return s;
  };
  const turnImages = (m: UnifiedMessage) => linkedState(m).seen;
  const turnImageBudget = (m: UnifiedMessage) => linkedState(m).budget;

  const ensureAssistant = (id: string, ts: number, model?: string): UnifiedMessage => {
    if (!current) {
      current = {
        id: uniqueId(`pi-a-${id}`),
        role: 'assistant',
        timestamp: ts,
        blocks: [],
        harnessMeta: { sourceKind: 'agent', model },
      };
      messages.push(current);
    }
    current.timestamp = ts;
    return current;
  };
  const pushNotice = (id: string, ts: number, title: string, detail: string | undefined, sourceKind: 'compaction' | 'system_meta') => {
    current = null;
    messages.push({
      id: uniqueId(`pi-n-${id}`),
      role: 'system',
      timestamp: ts,
      blocks: [{ type: 'notice', title, detail }],
      harnessMeta: { sourceKind },
    });
  };

  for (const e of branch) {
    const id = String(e.id);
    const ts = isoToMs(e.timestamp, sourceMtimeMs);
    if (e.type === 'compaction') {
      const tokens = typeof e.tokensBefore === 'number' ? ` (${Math.round(e.tokensBefore / 1000)}k tokens)` : '';
      pushNotice(id, ts, `Context compacted${tokens}`, typeof e.summary === 'string' ? e.summary.slice(0, 4000) : undefined, 'compaction');
      continue;
    }
    if (e.type === 'branch_summary') {
      pushNotice(id, ts, 'Returned from another branch', typeof e.summary === 'string' ? e.summary.slice(0, 4000) : undefined, 'system_meta');
      continue;
    }
    if (e.type === 'custom_message') {
      if (e.display !== true) continue;
      const { text } = piUserContent(e.content);
      if (text.trim()) pushNotice(id, ts, String(e.customType ?? 'Extension'), text.slice(0, 4000), 'system_meta');
      continue;
    }
    if (e.type !== 'message') continue;
    const msg = asRecord(e.message);
    const role = msg.role;
    const mts = typeof msg.timestamp === 'number' ? msg.timestamp : ts;

    if (role === 'user') {
      const { text, images } = piUserContent(msg.content);
      if (!text.trim() && images.length === 0) continue;
      current = null;
      const blocks: UnifiedBlock[] = [...images];
      if (text.trim()) blocks.push({ type: 'text', text });
      messages.push({ id: uniqueId(`pi-u-${id}`), role: 'user', timestamp: ts, blocks, harnessMeta: { sourceKind: 'human' } });
      continue;
    }
    if (role === 'assistant') {
      const model = typeof msg.provider === 'string' && typeof msg.model === 'string' ? `${msg.provider}/${msg.model}` : undefined;
      const a = ensureAssistant(id, mts, model);
      for (const raw of Array.isArray(msg.content) ? msg.content : []) {
        const b = asRecord(raw);
        if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) {
          a.blocks.push({ type: 'thinking', text: b.thinking.trim() });
        } else if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          const linked = extractPiLinkedImages(b.text, turnImages(a), turnImageBudget(a));
          if (linked.text.trim()) a.blocks.push({ type: 'text', text: linked.text });
          a.blocks.push(...linked.images);
        } else if (b.type === 'toolCall') {
          const name = typeof b.name === 'string' ? b.name : 'tool';
          const block = blockForToolCall(name, asRecord(b.arguments));
          a.blocks.push(block);
          if (typeof b.id === 'string') pending.set(b.id, block);
          lastFocus = name === 'bash' ? 'Running command' : `Running ${name}`;
        }
      }
      if (msg.stopReason === 'error' && typeof msg.errorMessage === 'string') a.error = msg.errorMessage.slice(0, 1500);
      else if (msg.stopReason === 'aborted') a.blocks.push({ type: 'notice', title: 'Stopped' });
      continue;
    }
    if (role === 'toolResult') {
      const block = typeof msg.toolCallId === 'string' ? pending.get(msg.toolCallId) : undefined;
      if (block) {
        attachToolResult(block, msg);
        pending.delete(String(msg.toolCallId));
      }
      continue;
    }
    if (role === 'bashExecution' && typeof msg.command === 'string') {
      current = null;
      messages.push({
        id: uniqueId(`pi-b-${id}`),
        role: 'user',
        timestamp: ts,
        blocks: [
          {
            type: 'command',
            command: msg.command,
            output: typeof msg.output === 'string' ? msg.output.slice(0, MAX_TOOL_OUTPUT_CHARS) : undefined,
            exitCode: typeof msg.exitCode === 'number' ? msg.exitCode : null,
            status: msg.cancelled ? 'cancelled' : 'completed',
          },
        ],
        harnessMeta: { sourceKind: 'human' },
      });
      continue;
    }
    if (role === 'custom' && msg.display === true) {
      const { text } = piUserContent(msg.content);
      if (text.trim()) pushNotice(id, ts, String(msg.customType ?? 'Extension'), text.slice(0, 4000), 'system_meta');
    }
  }

  const tail = piTailState(lines, sourceMtimeMs);
  const totalCount = messages.length;
  const sliced = totalCount > limit ? messages.slice(totalCount - limit) : messages;
  const liveActivity: LiveActivityState = {
    isWorking: tail.midTurn,
    focus: tail.midTurn ? (tail.activeTool ? `Running ${tail.activeTool}` : lastFocus) : undefined,
    lastEventAt: tail.lastEventAt,
  };
  return {
    sessionId,
    messages: sliced,
    totalCount,
    hasMore: Boolean(meta?.truncated) || totalCount > limit,
    sourceMtimeMs,
    liveActivity,
    stats: computePiSessionStats(branch),
    tail,
  };
}

export function loadPiTranscript(sessionId: string, filePath: string | undefined, limit = 120) {
  if (!filePath || !fs.existsSync(filePath)) {
    return {
      sessionId,
      messages: [],
      totalCount: 0,
      hasMore: false,
      sourceMtimeMs: Date.now(),
      tail: { midTurn: false, lastEventAt: Date.now() } as PiTailState,
    };
  }
  const outcome = readProgressiveJsonlTail(
    filePath,
    (lines, chunk) => parsePiJsonlLines(lines, sessionId, chunk.mtimeMs, limit, { truncated: chunk.truncated }),
    (parsed) => parsed.messages.length >= limit,
    { initialBytes: Math.max(1024 * 1024, limit * 24 * 1024) }
  );
  return (
    outcome?.parsed ?? {
      sessionId,
      messages: [],
      totalCount: 0,
      hasMore: false,
      sourceMtimeMs: Date.now(),
      tail: { midTurn: false, lastEventAt: Date.now() } as PiTailState,
    }
  );
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

/** New threads Superharness started that Pi has not written to disk yet. */
const pendingPiStarts = new Map<string, { session: UnifiedSession; expiresAt: number }>();

export function registerPendingPiStart(p: { nativeId: string; cwd: string; title: string; model?: string }): void {
  const now = Date.now();
  pendingPiStarts.set(p.nativeId, {
    expiresAt: now + 60_000,
    session: {
      id: `pi:${p.nativeId}`,
      nativeId: p.nativeId,
      harness: 'pi',
      harnessGroup: 'pi',
      title: p.title,
      preview: p.title,
      cwd: p.cwd,
      projectName: projectNameFromCwd(p.cwd),
      nativeSection: p.cwd !== os.homedir() ? projectNameFromCwd(p.cwd) : 'Ungrouped',
      nativeSectionOrder: p.cwd !== os.homedir() ? 10 : 9999,
      model: p.model,
      status: 'running',
      isLive: true,
      isRemote: false,
      createdAt: now,
      updatedAt: now,
      pinned: false,
      folderId: null,
      tags: [],
      hidden: false,
      dispatchMode: 'pi-rpc',
      liveOwner: 'super-harness',
    },
  });
}

export function takePendingPiStarts(found: Set<string>): UnifiedSession[] {
  const now = Date.now();
  const out: UnifiedSession[] = [];
  for (const [id, p] of pendingPiStarts) {
    if (found.has(id) || now > p.expiresAt) pendingPiStarts.delete(id);
    else out.push(p.session);
  }
  return out;
}

/** Explains why a message to a terminal-held Pi session cannot be delivered. */
export function buildPiUndeliverableError(title: string, reason: 'terminal' | 'ambiguous'): string {
  if (reason === 'ambiguous') {
    return (
      `Your message was not sent to "${title}": Pi terminals are open in this session's folder and several Pi ` +
      `sessions there were written since they started, so Superharness cannot tell which terminal holds this ` +
      `session (Pi keeps no lock). Sending could reach the wrong terminal or fork the conversation. Type it in ` +
      `the terminal that has this session open, or close the Pi terminals in this folder and press Retry.`
    );
  }
  return (
    `Your message was not sent to "${title}": the session is open in a Pi terminal that is not inside tmux, so ` +
    `Superharness cannot type into it, and writing from a second Pi process would fork the conversation. ` +
    `Type it in that terminal, or close the terminal and press Retry (Superharness will then drive the session itself).`
  );
}

async function typeIntoTmux(target: string, text: string, submitKey: 'Enter' | 'M-Enter'): Promise<void> {
  if (text.includes('\n') || text.length > 500) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-pi-tmux-'));
    const file = path.join(dir, 'prompt.txt');
    try {
      fs.writeFileSync(file, text);
      await execFileAsync('tmux', ['load-buffer', file], { timeout: 4000 });
      await execFileAsync('tmux', ['paste-buffer', '-t', target, '-p', '-d'], { timeout: 4000 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } else {
    await execFileAsync('tmux', ['send-keys', '-t', target, '-l', text], { timeout: 4000 });
  }
  await new Promise((r) => setTimeout(r, 150));
  await execFileAsync('tmux', ['send-keys', '-t', target, submitKey], { timeout: 4000 });
}

/** Waits until the prompt text shows up in the session file or in the pane (queued steer). */
async function confirmTmuxDelivery(filePath: string | undefined, target: string, prompt: string, timeoutMs = 4000): Promise<boolean> {
  const needle = JSON.stringify(prompt.trim().slice(0, 60)).slice(1, -1);
  const paneNeedle = prompt.trim().split('\n')[0].slice(0, 40);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    if (filePath && needle.length >= 3) {
      const tail = readJsonlTailLines(filePath, 128 * 1024);
      if (tail?.lines.some((l) => l.includes(needle))) return true;
    }
    try {
      // While a run streams, Pi lists queued steers above the editor ("Steering: …").
      const { stdout } = await execFileAsync('tmux', ['capture-pane', '-p', '-t', target, '-S', '-40'], { timeout: 2000 });
      const lines = stdout.split('\n');
      if (lines.some((l) => /steer|queued|follow-up/i.test(l) && l.includes(paneNeedle))) return true;
    } catch {
      // pane went away
    }
  }
  return false;
}

export function createPiDriver(): HarnessDriver {
  const pool = new PiRpcPool();
  let cachedVersion: string | null | undefined;
  /** Live map from the last discovery pass (nativeId → holder / tmux pane). */
  let lastHolders = new Map<string, PiHolderProcess>();
  let lastAmbiguous = new Set<string>();

  const resolveTmuxTarget = async (holder: PiHolderProcess | undefined): Promise<string | null> => {
    if (!holder) return null;
    return findTmuxPaneForPids(await listTmuxPanes(), ancestorPids(holder.pid));
  };

  const runHooks = (session: UnifiedSession, runId: string, ctx: DispatchContext): PiRpcTurnHooks => ({
    shSessionId: session.id,
    runId,
    onEvent: ctx.emitStream,
    onPersisted: () => ctx.triggerRefresh(150),
    onSettled: () => {
      ctx.triggerRefresh(300);
      ctx.triggerRefresh(1500);
    },
  });

  /** Dispatch through our own RPC worker (spawned on demand). */
  const sendViaRpc = async (
    session: UnifiedSession,
    prompt: string,
    attachments: ImageAttachment[] | undefined,
    ctx: DispatchContext,
    queue: boolean
  ): Promise<SendMessageResult> => {
    const bin = await whichBinary('pi');
    if (!bin) return { ok: false, error: 'pi CLI not found' };
    const runId = crypto.randomBytes(6).toString('hex');
    try {
      const w = await pool.ensure(session.id, {
        bin,
        cwd: session.cwd,
        sessionFile: session.transcriptPath && fs.existsSync(session.transcriptPath) ? session.transcriptPath : undefined,
        sessionId: session.nativeId,
      });
      if (!pool.isStreaming(session.id)) {
        // Superharness overrides apply before the run starts.
        if (session.model?.trim() && session.model.includes('/')) await pool.setModel(w, session.model);
        if (session.reasoningEffort?.trim()) await pool.setThinking(w, session.reasoningEffort.trim());
      }
      const steering = pool.isStreaming(session.id);
      const disposition = await pool.prompt(w, prompt, attachments, runHooks(session, runId, ctx), { queue });
      ctx.triggerRefresh(400);
      return {
        ok: true,
        runId,
        dispatchedVia: steering
          ? queue
            ? 'Pi RPC follow_up (runs when this turn finishes)'
            : 'Pi RPC steer (lands after the current tool calls)'
          : disposition === 'handled'
            ? 'Pi RPC prompt (handled by an extension command)'
            : 'Pi RPC prompt',
      };
    } catch (err) {
      return { ok: false, error: `Pi did not accept the message: ${err instanceof Error ? err.message : String(err)}` };
    }
  };

  const dispatch = async (
    session: UnifiedSession,
    prompt: string,
    attachments: ImageAttachment[] | undefined,
    ctx: DispatchContext,
    queue: boolean
  ): Promise<SendMessageResult> => {
    if (pool.has(session.id)) return sendViaRpc(session, prompt, attachments, ctx, queue);
    if (lastAmbiguous.has(session.nativeId)) return { ok: false, error: buildPiUndeliverableError(session.title, 'ambiguous') };
    const holder = lastHolders.get(session.nativeId);
    if (holder) {
      const target = await resolveTmuxTarget(holder);
      if (!target) return { ok: false, error: buildPiUndeliverableError(session.title, 'terminal') };
      // In the Pi TUI, Enter steers a running turn (or submits when idle); Alt+Enter queues a follow-up.
      const body = formatPromptWithImagePaths(prompt, attachments);
      try {
        await typeIntoTmux(target, body, queue ? 'M-Enter' : 'Enter');
      } catch (err) {
        return { ok: false, error: `tmux typing into the Pi terminal failed: ${err instanceof Error ? err.message : String(err)}` };
      }
      const delivered = await confirmTmuxDelivery(session.transcriptPath, target, prompt);
      ctx.triggerRefresh(800);
      ctx.triggerRefresh(2500);
      if (!delivered) {
        return {
          ok: false,
          error:
            'Superharness typed your message into the Pi terminal (tmux) but could not confirm Pi took it within 4 seconds. Check that terminal before resending, to avoid a duplicate.',
        };
      }
      return { ok: true, dispatchedVia: `Pi terminal typing via tmux → ${target}` };
    }
    return sendViaRpc(session, prompt, attachments, ctx, queue);
  };

  return {
    id: 'pi',
    displayName: 'Pi',

    async detect(processes: ProcessRow[], maxSessions: number) {
      const bin = await whichBinary('pi');
      cachedVersion = await getBinaryVersionCached(bin);
      const dir = piSessionsDir();
      const files: Array<{ path: string; st: fs.Stats }> = [];
      try {
        for (const sub of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!sub.isDirectory()) continue;
          const subDir = path.join(dir, sub.name);
          for (const f of fs.readdirSync(subDir)) {
            if (!f.endsWith('.jsonl')) continue;
            const p = path.join(subDir, f);
            try {
              files.push({ path: p, st: fs.statSync(p) });
            } catch {
              // raced away
            }
          }
        }
      } catch {
        // no session dir yet
      }
      files.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);

      const metas: PiSessionMeta[] = [];
      for (const f of files) {
        if (metas.length >= Math.max(1, maxSessions)) break;
        const meta = scanPiSessionMeta(f.path, f.st);
        // Sessions with no prompt yet (an opened-and-closed TUI) are noise in the list.
        if (meta && meta.userMessages > 0) metas.push(meta);
      }

      const ownPids = pool.ownPids();
      const piProcs = processes.filter(isPiProcessRow);
      // Files whose last write was ours are not candidates for a terminal holder.
      const foreignWritten = metas.filter((m) => !pool.has(`pi:${m.nativeId}`) && !pool.wroteLast(`pi:${m.nativeId}`, m.path));
      const { byNativeId, ambiguous } = assignPiHolders(findPiHolderProcesses(processes, ownPids), foreignWritten);
      lastHolders = byNativeId;
      lastAmbiguous = ambiguous;
      const now = Date.now();
      const sessions: UnifiedSession[] = [];
      for (const m of metas) {
        const id = `pi:${m.nativeId}`;
        const holder = byNativeId.get(m.nativeId);
        const ours = pool.has(id);
        const tmuxTarget = holder ? await resolveTmuxTarget(holder) : null;
        let status: UnifiedSession['status'] = 'idle';
        if (ours) status = pool.isStreaming(id) ? 'running' : 'idle';
        else if (holder || now - m.mtimeMs < 60_000) {
          // A run is going only if the tail is mid-turn and something is alive to run it.
          status = readPiTailState(m.path, m.mtimeMs).midTurn ? 'running' : 'idle';
        }
        const cwd = m.cwd || os.homedir();
        const hasProject = cwd !== os.homedir();
        const proj = projectNameFromCwd(cwd);
        const firstLine = cleanTextPreview(m.firstUserText, 140);
        sessions.push({
          id,
          nativeId: m.nativeId,
          harness: 'pi',
          harnessGroup: 'pi',
          title: m.name || cleanTextPreview(m.firstUserText, 90) || `Pi ${m.nativeId.slice(0, 8)}`,
          preview: firstLine || 'Pi session',
          cwd,
          projectName: proj,
          model: m.model,
          reasoningEffort: m.thinking,
          nativeSection: hasProject ? proj : 'Ungrouped',
          nativeSectionOrder: hasProject ? 10 : 9999,
          status,
          isLive: ours || Boolean(holder),
          isRemote: false,
          transcriptPath: m.path,
          createdAt: m.createdAt,
          updatedAt: m.mtimeMs,
          pinned: false,
          folderId: null,
          tags: m.parentSession ? ['fork'] : [],
          hidden: false,
          dispatchMode: tmuxTarget ? 'tmux-send' : 'pi-rpc',
          tmuxTarget: tmuxTarget || undefined,
          liveOwner: ours ? 'super-harness' : holder ? (tmuxTarget ? 'tmux' : 'desktop') : undefined,
          isTerminalHeld: holder && !tmuxTarget ? true : undefined,
          pid: holder?.pid,
        });
      }
      const found = new Set(sessions.map((s) => s.nativeId));
      sessions.unshift(...takePendingPiStarts(found));

      const detection: HarnessDetection = {
        id: 'pi',
        name: 'Pi',
        installed: Boolean(bin) || fs.existsSync(PI_AGENT_DIR),
        binaryPath: bin,
        version: cachedVersion,
        runningProcesses: piProcs.length,
        desktopAppRunning: false,
        daemonRunning: false,
        remoteControlEnabled: false,
        activeSessionCount: sessions.filter((s) => s.isLive).length,
        totalSessionCount: sessions.length,
        capabilities: { canStartNew: Boolean(bin), canResume: Boolean(bin), canTmuxMirror: true, canControlDaemon: false },
        notes: `${sessions.length} sessions (${byNativeId.size} open in a terminal)`,
      };
      return { detection, sessions };
    },

    async getTranscriptFingerprint(session) {
      return `${computeFileFingerprint(session.transcriptPath)}:${pool.isStreaming(session.id) ? 'run' : ''}`;
    },

    async loadTranscript(session, limit) {
      const res = loadPiTranscript(session.id, session.transcriptPath, limit);
      const { tail, ...out } = res;
      // Working needs a live runner: our worker, or a terminal that holds the session.
      const runner = pool.has(session.id) ? pool.isStreaming(session.id) : Boolean(lastHolders.get(session.nativeId)) || Date.now() - out.sourceMtimeMs < 60_000;
      const isWorking = pool.has(session.id) ? pool.isStreaming(session.id) : tail.midTurn && runner;
      out.liveActivity = { ...(out.liveActivity ?? { isWorking }), isWorking, focus: isWorking ? out.liveActivity?.focus : undefined };
      return out;
    },

    getGlobalWatchDirs(): HarnessWatchSpec[] {
      const dir = piSessionsDir();
      const specs: HarnessWatchSpec[] = [{ dir }];
      // New sessions land in per-folder subdirectories; watch the active ones.
      try {
        const subs = fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => {
            const p = path.join(dir, d.name);
            return { p, m: fs.statSync(p).mtimeMs };
          })
          .sort((a, b) => b.m - a.m)
          .slice(0, 12);
        for (const s of subs) specs.push({ dir: s.p, filter: (fn) => fn.endsWith('.jsonl') });
      } catch {
        // no sessions yet
      }
      return specs;
    },

    getSessionWatchFiles(session) {
      return session.transcriptPath ? [session.transcriptPath] : [];
    },

    async sendMessage(session, prompt, attachments, ctx) {
      // Default: steer into a running turn (Pi delivers it before the next model call).
      return dispatch(session, prompt, attachments, ctx, false);
    },

    async queueMessage(session, prompt, attachments, ctx) {
      // Explicit queue: Pi's native follow-up queue (runs after the current turn).
      return dispatch(session, prompt, attachments, ctx, true);
    },

    async startSession(req: StartSessionRequest, ctx: DispatchContext) {
      const bin = await whichBinary('pi');
      if (!bin) return { ok: false, error: 'pi CLI not found' };
      const cwd = fs.existsSync(req.cwd) ? req.cwd : os.homedir();
      const nativeId = crypto.randomUUID();
      const sessionId = `pi:${nativeId}`;
      const title = req.title?.trim() || cleanTextPreview(req.prompt, 90) || 'New Pi session';
      const effort = req.reasoningEffort ? normalizeEffort(req.reasoningEffort, PI_THINKING_LEVELS) : undefined;
      registerPendingPiStart({ nativeId, cwd, title, model: req.model || undefined });
      ctx.triggerRefresh();
      const runId = crypto.randomBytes(6).toString('hex');
      try {
        const w = await pool.ensure(sessionId, {
          bin,
          cwd,
          sessionId: nativeId,
          name: req.title?.trim() || undefined,
          model: req.model?.trim() || undefined,
          thinking: effort,
        });
        const shell: UnifiedSession = { ...(pendingPiStarts.get(nativeId)?.session as UnifiedSession) };
        const promptText = req.prompt?.trim() || (req.attachments?.length ? 'Inspect the attached image(s).' : '');
        if (promptText) await pool.prompt(w, promptText, req.attachments, runHooks(shell, runId, ctx));
        ctx.triggerRefresh(800);
        ctx.triggerRefresh(2500);
        return { ok: true, sessionId };
      } catch (err) {
        pendingPiStarts.delete(nativeId);
        pool.close(sessionId);
        ctx.triggerRefresh();
        return { ok: false, error: `Pi could not start the session: ${err instanceof Error ? err.message : String(err)}` };
      }
    },

    async applySessionConfig(session, change) {
      const terminal = !pool.has(session.id) && lastHolders.has(session.nativeId);
      const live = pool.has(session.id);
      const results = resultsFor(change, (field, requested) => {
        if (field === 'permissionMode') {
          return {
            status: 'unsupported',
            detail:
              'Pi has no permission modes: its tools run without approval prompts. Restricting tools is a launch-time --tools allowlist, which Superharness does not manage.',
          };
        }
        if (terminal) {
          return {
            status: 'unsupported',
            detail: 'This Pi session is open in a terminal; change the model or thinking level there (/model, Shift+Tab).',
          };
        }
        const v = requested.trim();
        if (!v) return { status: 'next_message', value: '', detail: 'Override cleared; Pi keeps the session’s current setting.' };
        if (field === 'model') {
          if (!splitPiModelRef(v)) return { status: 'invalid', detail: 'Use provider/modelId, for example ds41/deepseek-v4.1-flash.' };
          return { status: live ? 'applied' : 'next_message', value: v };
        }
        const level = normalizeEffort(v === 'none' ? 'off' : v, PI_THINKING_LEVELS);
        return level ? { status: live ? 'applied' : 'next_message', value: level } : invalid(PI_THINKING_LEVELS);
      });
      if (!live) return results;
      // Apply now over RPC; Pi rejects unknown models and clamps unsupported thinking levels.
      try {
        const w = await pool.ensure(session.id, { bin: 'pi', cwd: session.cwd, sessionFile: session.transcriptPath });
        for (const r of results) {
          if (r.status !== 'applied' || !r.value) continue;
          try {
            if (r.field === 'model') await pool.setModel(w, r.value);
            else if (r.field === 'reasoningEffort') {
              await pool.setThinking(w, r.value);
              const state = await pool.getState(w);
              if (typeof state.thinkingLevel === 'string' && state.thinkingLevel !== r.value) {
                r.detail = `This model does not support "${r.value}"; Pi set "${state.thinkingLevel}".`;
                r.value = state.thinkingLevel;
              }
            }
          } catch (err) {
            r.status = 'failed';
            r.detail = err instanceof Error ? err.message : String(err);
          }
        }
      } catch (err) {
        for (const r of results) if (r.status === 'applied') r.status = 'next_message';
        void err;
      }
      return results;
    },

    abort(sessionId: string, emitStream: (ev: StreamEvent) => void) {
      if (!sessionId.startsWith('pi:') || !pool.abort(sessionId)) return false;
      emitStream({ sessionId, runId: 'abort', kind: 'done' });
      return true;
    },

    async controlDaemon() {
      return { ok: false, error: 'Pi has no daemon to start or stop; Superharness runs Pi sessions itself.' };
    },

    async archiveSession() {
      return null;
    },

    shutdown() {
      pool.closeAll();
    },

    activeHostTurns() {
      return pool.activeTurnCount();
    },

    async restartHosts() {
      const n = pool.closeIdle();
      return n > 0 ? [`${n} Pi ${n === 1 ? 'worker' : 'workers'}`] : [];
    },
  };
}
