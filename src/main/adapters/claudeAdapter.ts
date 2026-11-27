import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  SessionConfigFieldResult,
  HarnessDetection,
  ImageAttachment,
  LiveActivityState,
  LiveStepItem,
  QueuedMessageItem,
  SendMessageResult,
  SessionTranscriptResult,
  StartSessionRequest,
  StreamEvent,
  TmuxCaptureResult,
  UnifiedBlock,
  UnifiedMessage,
  UnifiedSession,
} from '../../shared/types';
import { ClaudeStreamPool } from '../services/claudeStreamClient';
import { readProgressiveJsonlTail } from '../utils/tailReader';
import { computeClaudeSessionStats } from '../utils/sessionStats';
import { offloadPool } from '../workers/offloadPool';
import { RemoteClaudeMirror } from './remoteClaude';
import {
  isInternalSummarizerCwd,
  isSummarizerPid,
  SUMMARIZER_CWD_BASENAME,
} from '../services/sessionSummarizer';
import {
  driveLocalClaudeQuestionTmux,
  extractPendingQuestionBlock,
  resolveClaudeQuestionAnswers,
} from './claudeQuestionTui';
import {
  CLAUDE_EFFORTS,
  CLAUDE_PERMISSION_MODES,
  invalid,
  normalizeClaudePermissionMode,
  normalizeEffort,
  resultsFor,
} from './sessionConfig';
import {
  cleanTextPreview,
  getBinaryVersionCached,
  isSameProcessAlive,
  normalizeTimestamp,
  projectNameFromCwd,
  whichBinary,
  type ProcessRow,
} from '../utils/system';
import {
  claudeTmuxRecords,
  listTmuxSessionNames,
  MAX_ARGV_PROMPT,
  type ClaudeTmuxRecord,
} from './claudeTmuxRevival';
import {
  computeFileFingerprint,
  createUniqueIdGenerator,
  extractAttachedImagesFromText,
  formatPromptWithImagePaths,
  type DaemonControlAction,
  type DispatchContext,
  type HarnessDriver,
  type HarnessWatchSpec,
} from './types';
import { readJsonFileCached } from '../utils/jsonFileCache';

const execFileAsync = promisify(execFile);

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const CLAUDE_SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
const CLAUDE_PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const CLAUDE_DESKTOP_SESSIONS_DIR = path.join(
  os.homedir(),
  '.config',
  'Claude',
  'claude-code-sessions'
);
const CLAUDE_DESKTOP_CONFIG_PATH = path.join(
  os.homedir(),
  '.config',
  'Claude',
  'claude_desktop_config.json'
);

interface ClaudeNativeSections {
  /** Maps local_<uuid> -> { name, order } */
  sectionByLocalId: Map<string, { name: string; order: number }>;
  starredLocalIds: Set<string>;
}

function loadClaudeNativeSections(): ClaudeNativeSections {
  const sectionByLocalId = new Map<string, { name: string; order: number }>();
  const starredLocalIds = new Set<string>();

  if (!fs.existsSync(CLAUDE_DESKTOP_CONFIG_PATH)) {
    return { sectionByLocalId, starredLocalIds };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(CLAUDE_DESKTOP_CONFIG_PATH, 'utf8')) as Record<
      string,
      unknown
    >;
    const prefs = (raw.preferences ?? {}) as Record<string, unknown>;
    const ep = (prefs.epitaxyPrefs ?? {}) as Record<string, unknown>;

    const starred = ep['starred-local-code-sessions'];
    if (Array.isArray(starred)) {
      for (const s of starred) {
        if (typeof s === 'string') starredLocalIds.add(s);
      }
    }

    // Build group id -> { name, order } from dframe-code-sections + dframe-group-scopes
    const groupInfo = new Map<string, { name: string; order: number }>();
    const codeSections = (ep['dframe-code-sections'] ?? {}) as Record<
      string,
      { sections?: Array<{ id?: string; name?: string; order?: number; kind?: string }> }
    >;
    for (const acctObj of Object.values(codeSections)) {
      for (const sec of acctObj?.sections ?? []) {
        if (sec.id && sec.name && sec.kind === 'manual') {
          groupInfo.set(sec.id, {
            name: sec.name,
            order: typeof sec.order === 'number' ? sec.order : 50,
          });
        }
      }
    }

    const groupScopes = (ep['dframe-group-scopes'] ?? {}) as Record<
      string,
      {
        groups?: Array<{ id?: string; name?: string }>;
        assignments?: Record<string, string>;
      }
    >;
    for (const acctObj of Object.values(groupScopes)) {
      let fallbackOrder = 20;
      for (const g of acctObj?.groups ?? []) {
        if (g.id && g.name && !groupInfo.has(g.id)) {
          groupInfo.set(g.id, { name: g.name, order: fallbackOrder++ });
        }
      }
      for (const [key, groupId] of Object.entries(acctObj?.assignments ?? {})) {
        // Keys look like "code:local_<uuid>"
        const localId = key.replace(/^code:/, '');
        const info = groupInfo.get(groupId);
        if (localId && info) {
          sectionByLocalId.set(localId, info);
        }
      }
    }
  } catch {
    // ignore parse errors
  }

  return { sectionByLocalId, starredLocalIds };
}

interface ActiveClaudeSessionJson {
  pid?: number;
  sessionId?: string;
  cwd?: string;
  startedAt?: number;
  updatedAt?: number;
  version?: string;
  entrypoint?: string;
  hostSessionId?: string;
  tmux?: string;
  name?: string;
  /** 'derived' = Claude Code's placeholder (e.g. `lxe-73`); anything else was chosen by a person. */
  nameSource?: string;
  status?: string;
  bridgeSessionId?: string;
  /** Process start time (/proc/<pid>/stat field 22); guards against PID reuse after a reboot. */
  procStart?: string;
}

interface ClaudeDesktopMetaJson {
  sessionId?: string;
  cliSessionId?: string;
  cwd?: string;
  title?: string;
  model?: string;
  createdAt?: number;
  lastActivityAt?: number;
  isArchived?: boolean;
  permissionMode?: string;
  gitAnchors?: Array<{ branch?: string }>;
}

let cachedClaudeVersion: string | null | undefined;
const claudeTranscriptPathCache = new Map<string, string>();
const headMetaCache = new Map<
  string,
  { mtimeMs: number; size: number; meta: { title?: string; preview?: string; cwd?: string; model?: string } }
>();

function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export function resolveClaudeTranscriptPath(cliSessionId: string, cwd?: string): string | undefined {
  return findClaudeTranscriptPath(cliSessionId, cwd);
}

function findClaudeTranscriptPath(cliSessionId: string, cwd?: string): string | undefined {
  if (!cliSessionId) return undefined;
  const cached = claudeTranscriptPathCache.get(cliSessionId);
  if (cached && fs.existsSync(cached)) return cached;
  if (cwd) {
    const direct = path.join(CLAUDE_PROJECTS_DIR, encodeClaudeProjectDir(cwd), `${cliSessionId}.jsonl`);
    if (fs.existsSync(direct)) {
      claudeTranscriptPathCache.set(cliSessionId, direct);
      return direct;
    }
  }
  if (!fs.existsSync(CLAUDE_PROJECTS_DIR)) return undefined;
  try {
    for (const dir of fs.readdirSync(CLAUDE_PROJECTS_DIR)) {
      const candidate = path.join(CLAUDE_PROJECTS_DIR, dir, `${cliSessionId}.jsonl`);
      if (fs.existsSync(candidate)) {
        claudeTranscriptPathCache.set(cliSessionId, candidate);
        return candidate;
      }
    }
  } catch {
    // ignore
  }
  return undefined;
}

interface ClaudeActivityResult {
  working: boolean;
  mtimeMs: number;
  /** Timestamp (ms) of the newest actual user/assistant conversation record in the JSONL. */
  lastMessageMs?: number;
  activeTool?: string;
}

const lastMsgTsCache = new Map<string, { size: number; mtimeMs: number; lastMessageMs: number }>();

/**
 * Finds the timestamp (ms) of the newest real `user` or `assistant` conversation record
 * in a Claude `.jsonl` transcript, ignoring background housekeeping lines Claude appends
 * while idle (`permission-mode`, `session-owner`, `atis-latch`, `bridge-session`,
 * `cost-state`, `last-prompt`, etc.) that bump the file's mtime without real chat activity.
 */
export function readLastClaudeMessageMs(transcriptPath: string, preStat?: fs.Stats): number {
  let st: fs.Stats;
  try {
    st = preStat ?? fs.statSync(transcriptPath);
  } catch {
    return 0;
  }
  const cached = lastMsgTsCache.get(transcriptPath);
  if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
    return cached.lastMessageMs;
  }

  let found = 0;
  const windows = [32 * 1024, 256 * 1024, 1024 * 1024, 4 * 1024 * 1024];
  let fd: number | null = null;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    for (const win of windows) {
      const readLen = Math.min(st.size, win);
      if (readLen <= 0) break;
      const offset = st.size - readLen;
      const buf = Buffer.allocUnsafe(readLen);
      const bytesRead = fs.readSync(fd, buf, 0, readLen, offset);
      const text = buf.subarray(0, bytesRead).toString('utf8');
      const lines = text.split('\n');
      const startIdx = offset > 0 ? 1 : 0;
      for (let i = lines.length - 1; i >= startIdx; i--) {
        const line = lines[i];
        if (!line || (!line.includes('"user"') && !line.includes('"assistant"'))) continue;
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (obj.type !== 'user' && obj.type !== 'assistant') continue;
        if (obj.isSidechain === true || obj.isMeta === true || obj.isCompactSummary === true) {
          continue;
        }
        const ts = normalizeTimestamp(obj.timestamp as string | number | undefined);
        if (ts > 0) {
          found = ts;
          break;
        }
      }
      if (found > 0 || readLen >= st.size) break;
    }
  } catch {
    // ignore unreadable file
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }

  if (lastMsgTsCache.size > 400) lastMsgTsCache.clear();
  lastMsgTsCache.set(transcriptPath, { size: st.size, mtimeMs: st.mtimeMs, lastMessageMs: found });
  return found;
}

function isClaudeLocalCommandText(text: string): boolean {
  const t = text.trim();
  return (
    t.startsWith('<local-command-caveat>') ||
    t.startsWith('<local-command-stdout>') ||
    t.startsWith('<local-command-stderr>') ||
    t.startsWith('<command-name>') ||
    t.startsWith('<command-message>')
  );
}

function extractTagContent(text: string, tag: string): string | null {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = text.match(re);
  return m ? m[1].trim() : null;
}

/**
 * Inspects only the tail (last 48KB) of a recently modified Claude .jsonl transcript
 * to accurately determine if the agent is mid-turn (API request in flight, streaming,
 * or executing a tool like Bash without a matching tool_result yet).
 */
function inspectClaudeTranscriptActivity(
  transcriptPath: string | undefined,
  isLivePid: boolean
): ClaudeActivityResult {
  if (!transcriptPath) return { working: false, mtimeMs: 0, lastMessageMs: 0 };
  let st: fs.Stats;
  try {
    st = fs.statSync(transcriptPath);
  } catch {
    return { working: false, mtimeMs: 0, lastMessageMs: 0 };
  }

  const lastMessageMs = readLastClaudeMessageMs(transcriptPath, st);
  const ageMs = Date.now() - st.mtimeMs;
  const msgAgeMs = lastMessageMs > 0 ? Math.max(0, Date.now() - lastMessageMs) : ageMs;
  if (ageMs > 15 * 60 * 1000 || msgAgeMs > 15 * 60 * 1000) {
    return { working: false, mtimeMs: st.mtimeMs, lastMessageMs };
  }

  try {
    const readLen = Math.min(st.size, 49152);
    const fd = fs.openSync(transcriptPath, 'r');
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, st.size - readLen);
    fs.closeSync(fd);

    const text = buf.toString('utf8');
    const lines = text.split('\n');
    const startIdx = st.size > readLen ? 1 : 0;

    const pendingTools = new Map<string, string>();
    let turnState: 'idle' | 'working' = 'idle';

    for (let i = startIdx; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      const type = obj.type;
      if (obj.isSidechain === true) continue;
      if (type === 'api-request') {
        turnState = 'working';
      } else if (type === 'system') {
        const sub = obj.subtype;
        if (sub === 'stop_hook_summary' || sub === 'turn_duration') {
          turnState = 'idle';
          pendingTools.clear();
        }
      } else if (type === 'assistant') {
        const msg = obj.message as Record<string, unknown> | undefined;
        const stopReason = msg?.stop_reason;
        const content = msg?.content;
        let sawToolUse = false;
        if (Array.isArray(content)) {
          for (const item of content) {
            if (!item || typeof item !== 'object') continue;
            const b = item as Record<string, unknown>;
            if (b.type === 'tool_use' && typeof b.id === 'string') {
              pendingTools.set(b.id, String(b.name || 'tool'));
              sawToolUse = true;
            }
          }
        }
        if (sawToolUse || stopReason === 'tool_use') {
          turnState = 'working';
        } else if (
          stopReason === 'end_turn' ||
          stopReason === 'stop_sequence' ||
          stopReason === 'max_tokens'
        ) {
          // A final assistant message with no tool_use concludes the turn;
          // drop any orphaned/background tool_use IDs from earlier turns so
          // "Working · Running Bash" never gets stuck after Claude finishes.
          pendingTools.clear();
          turnState = 'idle';
        } else {
          turnState = 'working';
        }
      } else if (type === 'user') {
        const msg = obj.message as Record<string, unknown> | undefined;
        const content = msg?.content;
        const origin =
          obj.origin && typeof obj.origin === 'object'
            ? (obj.origin as Record<string, unknown>)
            : undefined;
        let sawToolResult = false;
        let rawUserText = '';
        if (typeof content === 'string') {
          rawUserText = content;
        } else if (Array.isArray(content)) {
          const texts: string[] = [];
          for (const item of content) {
            if (!item || typeof item !== 'object') continue;
            const b = item as Record<string, unknown>;
            if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
              pendingTools.delete(b.tool_use_id);
              sawToolResult = true;
            } else if (b.type === 'text' && typeof b.text === 'string') {
              texts.push(b.text);
            }
          }
          rawUserText = texts.join('\n');
        }
        if (sawToolResult) {
          turnState = 'working';
        } else if (
          !obj.isMeta &&
          !obj.isCompactSummary &&
          origin?.kind !== 'task-notification' &&
          !isClaudeLocalCommandText(rawUserText)
        ) {
          pendingTools.clear();
          turnState = 'working';
        }
      }
    }

    const activeTool = Array.from(pendingTools.values()).pop();
    const hasPendingTool = pendingTools.size > 0;
    const maxIdleAge = isLivePid ? 3 * 60 * 1000 : 45 * 1000;
    const maxToolAge = isLivePid ? 15 * 60 * 1000 : 5 * 60 * 1000;

    const working =
      (hasPendingTool && msgAgeMs < maxToolAge) ||
      (turnState === 'working' && msgAgeMs < maxIdleAge);

    return { working, mtimeMs: st.mtimeMs, lastMessageMs, activeTool };
  } catch {
    return { working: false, mtimeMs: st.mtimeMs, lastMessageMs };
  }
}

function readJsonlHeadMeta(filePath: string): {
  title?: string;
  preview?: string;
  cwd?: string;
  model?: string;
} {
  try {
    const st = fs.statSync(filePath);
    const cached = headMetaCache.get(filePath);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return cached.meta;
    }
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(65536);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const chunk = buf.subarray(0, bytesRead).toString('utf8');
    let title: string | undefined;
    let preview: string | undefined;
    let cwd: string | undefined;
    let model: string | undefined;

    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (!cwd && typeof obj.cwd === 'string') cwd = obj.cwd;
      if (obj.type === 'custom-title' && typeof obj.customTitle === 'string') {
        title = obj.customTitle;
      }
      if (obj.type === 'user' && !preview) {
        const msg = obj.message as Record<string, unknown> | undefined;
        const c = msg?.content;
        if (typeof c === 'string') {
          preview = cleanTextPreview(c, 140);
        } else if (Array.isArray(c)) {
          const t = c
            .map((x) => ((x as Record<string, unknown>)?.text as string) || '')
            .filter(Boolean)
            .join(' ');
          if (t) preview = cleanTextPreview(t, 140);
        }
      }
      if (obj.type === 'assistant' && !model) {
        const msg = obj.message as Record<string, unknown> | undefined;
        if (typeof msg?.model === 'string') model = msg.model;
      }
    }
    const meta = { title, preview, cwd, model };
    headMetaCache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, meta });
    return meta;
  } catch {
    return {};
  }
}

const titleTailCache = new Map<
  string,
  { mtimeMs: number; size: number; meta: { customTitle?: string; aiTitle?: string } }
>();

/**
 * Latest `custom-title` / `ai-title` records in a Claude transcript. Claude Code appends
 * (and re-appends) these after turns, so they live near the end of the file, not the head.
 */
export function readJsonlTitleMeta(filePath: string): { customTitle?: string; aiTitle?: string } {
  try {
    const st = fs.statSync(filePath);
    const cached = titleTailCache.get(filePath);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) return cached.meta;
    const len = Math.min(st.size, 262144);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(filePath, 'r');
    try {
      fs.readSync(fd, buf, 0, len, st.size - len);
    } finally {
      fs.closeSync(fd);
    }
    const meta: { customTitle?: string; aiTitle?: string } = {};
    for (const line of buf.toString('utf8').split('\n')) {
      const isCustom = line.includes('"custom-title"');
      const isAi = !isCustom && line.includes('"ai-title"');
      if (!isCustom && !isAi) continue;
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        if (obj.type === 'custom-title' && typeof obj.customTitle === 'string' && obj.customTitle.trim()) {
          meta.customTitle = obj.customTitle;
        } else if (obj.type === 'ai-title' && typeof obj.aiTitle === 'string' && obj.aiTitle.trim()) {
          meta.aiTitle = obj.aiTitle;
        }
      } catch {
        // partial first line of the window
      }
    }
    titleTailCache.set(filePath, { mtimeMs: st.mtimeMs, size: st.size, meta });
    return meta;
  } catch {
    return {};
  }
}

/**
 * Title precedence for a Claude transcript: a name a person chose (Desktop title, `--name`,
 * `/rename`) beats Claude's AI title, which beats a derived placeholder name like `lxe-73`.
 */
export function pickClaudeTitle(parts: {
  desktopTitle?: string;
  name?: string;
  nameSource?: string;
  headTitle?: string;
  customTitle?: string;
  aiTitle?: string;
  tmuxSessionName?: string;
  preview?: string;
}): string | undefined {
  const derived = parts.nameSource === 'derived';
  return (
    parts.desktopTitle ||
    (!derived ? parts.name : undefined) ||
    parts.customTitle ||
    parts.headTitle ||
    parts.aiTitle ||
    parts.preview ||
    parts.name ||
    parts.tmuxSessionName ||
    undefined
  );
}

/**
 * Sessions Superharness just launched in tmux but Claude has not yet registered in
 * ~/.claude/sessions. Discovery reports them right away so a new thread appears once
 * and stays put, instead of popping in and out while Claude starts up.
 */
const pendingClaudeStarts = new Map<string, { session: UnifiedSession; expiresAt: number }>();

export function registerPendingClaudeStart(p: {
  nativeId: string;
  cwd: string;
  title: string;
  tmuxSessionName: string;
  remoteControl: boolean;
  model?: string;
}): void {
  const now = Date.now();
  pendingClaudeStarts.set(p.nativeId, {
    expiresAt: now + 30000,
    session: {
      id: `claude:${p.nativeId}`,
      nativeId: p.nativeId,
      harness: 'claude-tmux',
      harnessGroup: 'claude',
      title: p.title,
      preview: p.title,
      cwd: p.cwd,
      projectName: projectNameFromCwd(p.cwd),
      nativeSection: 'Ungrouped',
      nativeSectionOrder: 9999,
      model: p.model || undefined,
      status: 'running',
      isLive: true,
      isRemote: false,
      tmuxTarget: p.tmuxSessionName,
      tmuxSessionName: p.tmuxSessionName,
      createdAt: now,
      updatedAt: now,
      pinned: false,
      folderId: null,
      tags: ['tmux', ...(p.remoteControl ? ['remote-control'] : [])],
      hidden: false,
      dispatchMode: 'tmux-send',
      liveOwner: 'tmux',
    },
  });
}

/** Pending starts that Claude has not registered yet; drops registered or expired ones. */
export function takePendingClaudeStarts(registeredNativeIds: Set<string>): UnifiedSession[] {
  const now = Date.now();
  const out: UnifiedSession[] = [];
  for (const [id, p] of pendingClaudeStarts) {
    if (registeredNativeIds.has(id) || now > p.expiresAt) pendingClaudeStarts.delete(id);
    else out.push(p.session);
  }
  return out;
}

export async function detectClaude(
  processes: ProcessRow[],
  maxSessions: number,
  showArchived: boolean
): Promise<{ detection: HarnessDetection; sessions: UnifiedSession[] }> {
  const binPath = await whichBinary('claude');
  cachedClaudeVersion = await getBinaryVersionCached(binPath);

  const claudeProcs = processes.filter(
    (p) =>
      p.comm === 'claude' ||
      p.args.includes('/claude') ||
      p.args.toLowerCase().includes('claude-desktop') ||
      p.args.includes('/Claude')
  );
  const desktopRunning = claudeProcs.some(
    (p) =>
      p.args.toLowerCase().includes('claude-desktop') ||
      p.args.includes('/opt/claude') ||
      p.args.includes('app.asar')
  );

  // Load exact native Claude Desktop sidebar sections (projects, custom groups, and starred items)
  const nativeSec = loadClaudeNativeSections();

  // 0. Pre-load Claude Desktop metadata (~/.config/Claude/claude-code-sessions/*/*/local_*.json)
  //    so live `claude --resume` PIDs in ~/.claude/sessions/*.json inherit their Desktop identity
  //    (title, native section, starred pin, permissionMode, and harness='claude-desktop') instead
  //    of morphing into a separate `claude-cli` session mid-turn and dropping out of view!
  const desktopEntries: Array<{
    file: string;
    mtime: number;
    cliId: string;
    localId: string;
    data: ClaudeDesktopMetaJson;
  }> = [];
  const desktopMetaByCliId = new Map<
    string,
    { file: string; mtime: number; localId: string; data: ClaudeDesktopMetaJson }
  >();

  if (fs.existsSync(CLAUDE_DESKTOP_SESSIONS_DIR)) {
    const metaFiles: Array<{ file: string; mtime: number; st: fs.Stats }> = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 3) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(p, depth + 1);
        } else if (e.isFile() && e.name.startsWith('local_') && e.name.endsWith('.json')) {
          try {
            const st = fs.statSync(p);
            metaFiles.push({ file: p, mtime: st.mtimeMs, st });
          } catch {
            // ignore
          }
        }
      }
    };
    walk(CLAUDE_DESKTOP_SESSIONS_DIR, 0);
    metaFiles.sort((a, b) => b.mtime - a.mtime);

    for (const item of metaFiles) {
      let data: ClaudeDesktopMetaJson;
      try {
        // Re-parsed only when the file changes; `data` is read-only below.
        data = readJsonFileCached<ClaudeDesktopMetaJson>(item.file, item.st);
      } catch {
        continue;
      }
      const cliId = data.cliSessionId || data.sessionId;
      if (!cliId) continue;
      const localId = data.sessionId || path.basename(item.file, '.json');
      if (!desktopMetaByCliId.has(cliId)) {
        desktopMetaByCliId.set(cliId, { file: item.file, mtime: item.mtime, localId, data });
      }
      if (!data.isArchived || showArchived) {
        desktopEntries.push({ file: item.file, mtime: item.mtime, cliId, localId, data });
      }
    }
  }

  // 1. Live active sessions from ~/.claude/sessions/*.json (includes both tmux CLI & Desktop!)
  const liveBySessionId = new Map<string, ActiveClaudeSessionJson>();
  const liveTmuxSessions: UnifiedSession[] = [];
  let remoteActiveCount = 0;

  if (fs.existsSync(CLAUDE_SESSIONS_DIR)) {
    try {
      // Collect & deduplicate live PIDs by sessionId (preferring tmux or claude-desktop over transient CLI resume)
      const activeFiles: ActiveClaudeSessionJson[] = [];
      for (const fn of fs.readdirSync(CLAUDE_SESSIONS_DIR)) {
        if (!fn.endsWith('.json')) continue;
        const full = path.join(CLAUDE_SESSIONS_DIR, fn);
        let data: ActiveClaudeSessionJson;
        try {
          data = withoutHeadlessTmux(JSON.parse(fs.readFileSync(full, 'utf8')) as ActiveClaudeSessionJson);
        } catch {
          continue;
        }
        if (!data.sessionId || !data.pid) continue;
        if (!isSameProcessAlive(Number(data.pid), data.procStart)) continue;
        activeFiles.push(data);
      }

      const busySessionIds = new Set<string>();
      for (const f of activeFiles) {
        if (f.sessionId && (f.status === 'running' || f.status === 'busy')) {
          busySessionIds.add(f.sessionId);
        }
      }

      const priority = (d: ActiveClaudeSessionJson): number =>
        d.tmux ? 3 : d.entrypoint === 'claude-desktop' ? 2 : 1;
      activeFiles.sort((a, b) => priority(b) - priority(a));

      for (const data of activeFiles) {
        if (!data.sessionId || !data.pid) continue;
        if (isSummarizerPid(Number(data.pid)) || isInternalSummarizerCwd(data.cwd)) continue;
        if (liveBySessionId.has(data.sessionId)) continue;
        liveBySessionId.set(data.sessionId, data);
        if (data.bridgeSessionId) remoteActiveCount++;

        const desktopMatch = desktopMetaByCliId.get(data.sessionId);
        const isTmux = Boolean(data.tmux);
        const isDesktop = !isTmux && (data.entrypoint === 'claude-desktop' || Boolean(desktopMatch));
        const harness = isTmux
          ? 'claude-tmux'
          : isDesktop
            ? 'claude-desktop'
            : 'claude-cli';
        const cwd = desktopMatch?.data.cwd || data.cwd || os.homedir();
        const transcriptPath = findClaudeTranscriptPath(data.sessionId, cwd);
        const headMeta = transcriptPath ? readJsonlHeadMeta(transcriptPath) : {};
        const tmuxSessionName = data.tmux ? data.tmux.split(':')[0] : undefined;
        const tailTitles = transcriptPath ? readJsonlTitleMeta(transcriptPath) : {};
        const title =
          cleanTextPreview(
            pickClaudeTitle({
              desktopTitle: desktopMatch?.data.title,
              name: data.name,
              nameSource: data.nameSource,
              headTitle: headMeta.title,
              customTitle: tailTitles.customTitle,
              aiTitle: tailTitles.aiTitle,
              tmuxSessionName,
              preview: headMeta.preview,
            }),
            90
          ) || `Claude (${projectNameFromCwd(cwd)})`;
        const localId = data.hostSessionId || desktopMatch?.localId;
        const assignedSec = localId ? nativeSec.sectionByLocalId.get(localId) : undefined;
        const isStarred = localId ? nativeSec.starredLocalIds.has(localId) : false;
        const branch = Array.isArray(desktopMatch?.data.gitAnchors)
          ? desktopMatch.data.gitAnchors[0]?.branch
          : undefined;
        const activity = inspectClaudeTranscriptActivity(transcriptPath, true);
        const isRunning =
          data.status === 'running' ||
          data.status === 'busy' ||
          busySessionIds.has(data.sessionId) ||
          activity.working;
        const updatedAt =
          (activity.lastMessageMs ?? 0) > 0
            ? activity.lastMessageMs!
            : Math.max(
                normalizeTimestamp(data.startedAt),
                normalizeTimestamp(desktopMatch?.data.lastActivityAt ?? 0),
                activity.mtimeMs
              );

        const launchFlags = claudeLaunchFlagsForPid(Number(data.pid));
        liveTmuxSessions.push({
          // Canonical ID across all Claude variants so resuming/exiting a CLI process never changes session.id
          id: `claude:${data.sessionId}`,
          nativeId: data.sessionId,
          harness,
          harnessGroup: 'claude',
          title,
          preview:
            desktopMatch?.data.title ||
            headMeta.preview ||
            (isTmux ? `Live tmux session: ${data.tmux}` : `Live ${harness} session`),
          cwd,
          projectName: projectNameFromCwd(cwd),
          nativeSection: assignedSec ? assignedSec.name : 'Ungrouped',
          nativeSectionOrder: assignedSec ? assignedSec.order : 9999,
          nativeMetaPath: desktopMatch?.file,
          permissionMode: desktopMatch?.data.permissionMode,
          gitBranch: branch,
          model: launchFlags.model || desktopMatch?.data.model || headMeta.model,
          reasoningEffort: launchFlags.effort,
          runningModel: launchFlags.model,
          runningReasoningEffort: launchFlags.effort,
          status: isRunning ? 'running' : 'idle',
          isLive: true,
          isRemote: Boolean(data.bridgeSessionId),
          remoteId: data.bridgeSessionId || undefined,
          tmuxTarget: data.tmux || undefined,
          tmuxSessionName,
          pid: Number(data.pid),
          transcriptPath,
          createdAt: normalizeTimestamp(desktopMatch?.data.createdAt ?? data.startedAt),
          updatedAt,
          pinned: isStarred,
          folderId: null,
          tags: [
            ...(isTmux ? ['tmux'] : []),
            ...(data.bridgeSessionId ? ['remote-control'] : []),
            ...(isDesktop ? ['desktop'] : []),
          ],
          hidden: false,
          dispatchMode: isTmux ? 'tmux-send' : 'claude-resume',
          liveOwner: isTmux
            ? 'tmux'
            : data.entrypoint === 'claude-desktop'
              ? 'desktop'
              : 'super-harness',
        });
      }
    } catch {
      // ignore
    }
  }

  // 2. Remaining Claude Desktop metadata sessions (not currently in ~/.claude/sessions)
  const desktopSessions: UnifiedSession[] = [];
  const seenCliIds = new Set<string>(liveBySessionId.keys());

  for (const item of desktopEntries.slice(0, maxSessions)) {
    const { cliId, localId, data } = item;
    if (seenCliIds.has(cliId)) continue;
    seenCliIds.add(cliId);

    const cwd = data.cwd || os.homedir();
    const transcriptPath = findClaudeTranscriptPath(cliId, cwd);
    const branch = Array.isArray(data.gitAnchors) ? data.gitAnchors[0]?.branch : undefined;
    const assignedSec = nativeSec.sectionByLocalId.get(localId);
    const isStarred = nativeSec.starredLocalIds.has(localId);
    const activity = inspectClaudeTranscriptActivity(transcriptPath, desktopRunning);
    const isRunning = !data.isArchived && activity.working;
    const updatedAt =
      (activity.lastMessageMs ?? 0) > 0
        ? activity.lastMessageMs!
        : Math.max(
            normalizeTimestamp(data.lastActivityAt ?? item.mtime),
            activity.mtimeMs
          );

    desktopSessions.push({
      id: `claude:${cliId}`,
      nativeId: cliId,
      harness: 'claude-desktop',
      harnessGroup: 'claude',
      title: cleanTextPreview(data.title, 90) || `Claude Desktop (${projectNameFromCwd(cwd)})`,
      preview: data.title || cwd,
      cwd,
      projectName: projectNameFromCwd(cwd),
      nativeSection: assignedSec ? assignedSec.name : 'Ungrouped',
      nativeSectionOrder: assignedSec ? assignedSec.order : 9999,
      nativeMetaPath: item.file,
      permissionMode: data.permissionMode,
      gitBranch: branch,
      model: data.model || undefined,
      status: data.isArchived ? 'archived' : isRunning ? 'running' : 'idle',
      isLive: isRunning,
      isRemote: false,
      transcriptPath,
      createdAt: normalizeTimestamp(data.createdAt ?? item.mtime),
      updatedAt,
      pinned: isStarred,
      folderId: null,
      tags: ['desktop'],
      hidden: false,
      dispatchMode: 'claude-resume',
    });
  }

  // 3. Recent Claude CLI project transcripts (~/.claude/projects/*/*.jsonl)
  const cliSessions: UnifiedSession[] = [];
  if (fs.existsSync(CLAUDE_PROJECTS_DIR)) {
    const jsonlFiles: Array<{ file: string; mtime: number; nativeId: string }> = [];
    try {
      for (const projDir of fs.readdirSync(CLAUDE_PROJECTS_DIR)) {
        if (projDir.includes(SUMMARIZER_CWD_BASENAME)) continue;
        const fullDir = path.join(CLAUDE_PROJECTS_DIR, projDir);
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(fullDir, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const e of entries) {
          if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
          const nativeId = e.name.slice(0, -6);
          if (seenCliIds.has(nativeId)) continue;
          const full = path.join(fullDir, e.name);
          try {
            const st = fs.statSync(full);
            if (st.size < 200) continue;
            jsonlFiles.push({ file: full, mtime: st.mtimeMs, nativeId });
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }

    jsonlFiles.sort((a, b) => b.mtime - a.mtime);
    const remaining = Math.max(0, maxSessions - liveTmuxSessions.length - desktopSessions.length);
    for (const jf of jsonlFiles.slice(0, Math.min(remaining, 40))) {
      seenCliIds.add(jf.nativeId);
      const meta = readJsonlHeadMeta(jf.file);
      const cwd = meta.cwd || os.homedir();
      if (isInternalSummarizerCwd(cwd)) continue;
      const tailTitles = readJsonlTitleMeta(jf.file);
      const title =
        cleanTextPreview(
          pickClaudeTitle({
            headTitle: meta.title,
            customTitle: tailTitles.customTitle,
            aiTitle: tailTitles.aiTitle,
            preview: meta.preview,
          }),
          90
        ) ||
        `Claude CLI (${projectNameFromCwd(cwd)})`;
      const activity = inspectClaudeTranscriptActivity(jf.file, claudeProcs.length > 0);
      cliSessions.push({
        id: `claude:${jf.nativeId}`,
        nativeId: jf.nativeId,
        harness: 'claude-cli',
        harnessGroup: 'claude',
        title,
        preview: meta.preview || cwd,
        cwd,
        projectName: projectNameFromCwd(cwd),
        nativeSection: 'Ungrouped',
        nativeSectionOrder: 9999,
        model: meta.model,
        status: activity.working ? 'running' : 'idle',
        isLive: activity.working,
        isRemote: false,
        transcriptPath: jf.file,
        createdAt: jf.mtime,
        updatedAt: (activity.lastMessageMs ?? 0) > 0 ? activity.lastMessageMs! : jf.mtime,
        pinned: false,
        folderId: null,
        tags: ['cli'],
        hidden: false,
        dispatchMode: 'claude-resume',
      });
    }
  }

  liveTmuxSessions.push(...takePendingClaudeStarts(new Set(liveBySessionId.keys())));

  const allSessions = [...liveTmuxSessions, ...desktopSessions, ...cliSessions].sort((a, b) => {
    if (a.isLive !== b.isLive) return a.isLive ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });

  const detection: HarnessDetection = {
    id: 'claude',
    name: 'Claude (Desktop + tmux CLI)',
    installed: Boolean(binPath) || fs.existsSync(CLAUDE_DIR),
    binaryPath: binPath,
    version: cachedClaudeVersion,
    runningProcesses: claudeProcs.length,
    desktopAppRunning: desktopRunning,
    daemonRunning: liveTmuxSessions.some((s) => s.harness === 'claude-tmux'),
    remoteControlEnabled: remoteActiveCount > 0,
    activeSessionCount: liveTmuxSessions.length,
    totalSessionCount: allSessions.length,
    capabilities: {
      canStartNew: Boolean(binPath),
      canResume: Boolean(binPath),
      canTmuxMirror: true,
      canControlDaemon: Boolean(binPath),
    },
    notes: `${liveTmuxSessions.filter((s) => s.harness === 'claude-tmux').length} live tmux sessions (${remoteActiveCount} remote-control), ${desktopSessions.length} Desktop sessions`,
  };

  return { detection, sessions: allSessions };
}

const CLAUDE_IMAGE_CACHE_DIR = path.join(
  os.homedir(),
  '.config',
  'super-harness',
  'attachments',
  'claude-cache'
);

function cacheClaudeBase64Image(base64Data: string, mimeType: string): string | null {
  try {
    const extMap: Record<string, string> = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/jpg': 'jpg',
      'image/webp': 'webp',
      'image/gif': 'gif',
    };
    const ext = extMap[mimeType.toLowerCase()] || 'png';
    const rawB64 = base64Data.startsWith('data:')
      ? base64Data.slice(base64Data.indexOf(',') + 1)
      : base64Data;
    const hash = crypto.createHash('sha1').update(rawB64).digest('hex').slice(0, 20);
    const outPath = path.join(CLAUDE_IMAGE_CACHE_DIR, `${hash}.${ext}`);
    if (!fs.existsSync(outPath)) {
      fs.mkdirSync(CLAUDE_IMAGE_CACHE_DIR, { recursive: true });
      fs.writeFileSync(outPath, Buffer.from(rawB64, 'base64'));
    }
    return outPath;
  } catch {
    return null;
  }
}

function parseClaudeImageBlock(
  b: Record<string, unknown>
): Extract<UnifiedBlock, { type: 'image' }> | null {
  if (b.type !== 'image') return null;
  const source = (b.source && typeof b.source === 'object'
    ? (b.source as Record<string, unknown>)
    : undefined);

  if (source) {
    const srcType = String(source.type || '');
    if (srcType === 'base64' && typeof source.data === 'string' && source.data.length > 0) {
      if (source.data.length > 10_000_000) return null;
      const mimeType =
        typeof source.media_type === 'string' && source.media_type
          ? source.media_type
          : 'image/png';
      // Materialize large base64 blobs (>16KB) to disk once so Electron IPC never re-serializes
      // multi-MB strings on every live transcript push.
      if (source.data.length > 16_384) {
        const cachedPath = cacheClaudeBase64Image(source.data, mimeType);
        if (cachedPath) {
          return {
            type: 'image',
            path: cachedPath,
            name: 'Attached image',
          };
        }
      }
      return {
        type: 'image',
        path: '',
        dataUrl: source.data.startsWith('data:')
          ? source.data
          : `data:${mimeType};base64,${source.data}`,
        name: 'Attached image',
      };
    }
    if (srcType === 'url' && typeof source.url === 'string' && source.url.trim()) {
      return {
        type: 'image',
        path: '',
        dataUrl: source.url.trim(),
        name: 'Attached image',
      };
    }
    if (typeof source.path === 'string' && source.path.trim()) {
      const p = source.path.trim();
      return {
        type: 'image',
        path: p,
        name: path.basename(p),
      };
    }
  }

  if (typeof b.path === 'string' && b.path.trim()) {
    const p = b.path.trim();
    return {
      type: 'image',
      path: p,
      name: path.basename(p),
    };
  }
  return null;
}

const CLAUDE_VIDEO_MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
};

const CLAUDE_IMAGE_EXTS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.svg',
  '.bmp',
  '.ico',
]);

/** Converts Claude's `SendUserFile` tool_use input into renderable video/image/notice blocks. */
export function buildClaudeSendUserFileBlocks(input: Record<string, unknown>): UnifiedBlock[] {
  const rawFiles = Array.isArray(input.files)
    ? input.files
    : typeof input.file_path === 'string'
      ? [input.file_path]
      : typeof input.path === 'string'
        ? [input.path]
        : [];
  const caption = typeof input.caption === 'string' ? input.caption.trim() : '';
  const out: UnifiedBlock[] = [];
  for (const entry of rawFiles) {
    const rawPath =
      typeof entry === 'string'
        ? entry.trim()
        : entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).path === 'string'
          ? String((entry as Record<string, unknown>).path).trim()
          : '';
    if (!rawPath) continue;
    const resolvedPath = rawPath.startsWith('~/')
      ? path.join(os.homedir(), rawPath.slice(2))
      : rawPath;
    const ext = path.extname(resolvedPath).toLowerCase();
    const baseName = path.basename(resolvedPath) || resolvedPath;
    const label = rawFiles.length === 1 && caption ? caption : baseName;
    if (CLAUDE_VIDEO_MIME_BY_EXT[ext]) {
      out.push({
        type: 'video',
        path: resolvedPath,
        name: label,
        mimeType: CLAUDE_VIDEO_MIME_BY_EXT[ext],
      });
    } else if (CLAUDE_IMAGE_EXTS.has(ext)) {
      out.push({
        type: 'image',
        path: resolvedPath,
        name: label,
      });
    } else {
      out.push({
        type: 'notice',
        title: baseName,
        detail: caption ? `${caption}\n${resolvedPath}` : resolvedPath,
      });
    }
  }
  return out;
}

export function parseClaudeJsonlLines(
  lines: string[],
  sessionId: string,
  sourceMtimeMs: number,
  limit = 120,
  meta?: {
    truncated?: boolean;
    fileSize?: number;
    bytesRead?: number;
    tailActivity?: ClaudeActivityResult;
  }
): SessionTranscriptResult {
  const messages: UnifiedMessage[] = [];
  const uniqueId = createUniqueIdGenerator();
  // An interruption followed at once by a message from the user is how Superharness delivers a
  // steer to a background Claude process (stop, then send). That is not a stop the user asked
  // for, so its notice is dropped when the steer arrives.
  let pendingInterrupt: { index: number; ts: number } | null = null;
  const dropSteerInterrupt = (userTs: number) => {
    if (
      pendingInterrupt &&
      messages[pendingInterrupt.index]?.role === 'system' &&
      userTs - pendingInterrupt.ts <= STEER_INTERRUPT_WINDOW_MS
    ) {
      messages.splice(pendingInterrupt.index, 1);
    }
    pendingInterrupt = null;
  };
  const toolBlockById = new Map<string, UnifiedBlock>();
  const toolReadPathById = new Map<string, string>();
  let lastUserImagePaths = new Set<string>();
  const pendingToolNames = new Map<string, string>();
  const rawNativeQueue: Array<{ item: QueuedMessageItem; isInternal: boolean }> = [];
  let latestSteps: LiveStepItem[] | undefined;
  let currentAssistant: UnifiedMessage | null = null;
  let seq = 0;

  // Claude logs a dequeue for every delivered queue entry, but it may come before or after
  // the record that delivers the text (a queued_command attachment or a plain user turn).
  // An entry removed early by its delivery record leaves a credit, so its own dequeue does
  // not pop the next, still-waiting entry. Without this, one stale entry sat at the head
  // and every later dequeue removed the previous message, so the newest delivered message
  // kept showing as a pending steer at the end of the chat.
  let dequeueCredits = 0;
  const normalizeQueueText = (txt: string): string => txt.replace(/\s+/g, ' ').trim();
  const consumeQueuedText = (txt: string): void => {
    const target = normalizeQueueText(txt);
    if (!target) return;
    const idx = rawNativeQueue.findIndex((q) => normalizeQueueText(q.item.text) === target);
    if (idx < 0) return;
    rawNativeQueue.splice(idx, 1);
    dequeueCredits += 1;
  };

  const isInternalClaudeQueueContent = (txt: string): boolean =>
    /^<(?:task-notification|cross-session-message|teammate-message|system-reminder|local-command-|command-name)\b/i.test(
      txt
    );

  for (const line of lines) {
    if (!line.trim()) continue;
    // Fast byte-level pre-filter: skip high-volume telemetry/snapshot lines
    // (api-request-blob, file-history-snapshot, progress, etc.) before JSON.parse
    if (
      !line.includes('"user"') &&
      !line.includes('"assistant"') &&
      !line.includes('"queue-operation"') &&
      !line.includes('"queued_command"')
    ) {
      continue;
    }
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = obj.type;
    if (type === 'queue-operation') {
      const op = String(obj.operation || '');
      if (op === 'enqueue' && typeof obj.content === 'string' && obj.content.trim()) {
        const trimmed = obj.content.trim();
        rawNativeQueue.push({
          item: {
            id: `claude-q-${seq++}`,
            text: trimmed,
            createdAt: normalizeTimestamp(obj.timestamp),
            source: 'native',
          },
          isInternal: isInternalClaudeQueueContent(trimmed),
        });
      } else if (op === 'dequeue') {
        if (dequeueCredits > 0) dequeueCredits -= 1;
        else rawNativeQueue.shift();
      } else if (op === 'popAll' || op === 'clear') {
        rawNativeQueue.length = 0;
        dequeueCredits = 0;
      } else if (op === 'remove' && typeof obj.content === 'string') {
        const target = obj.content.trim();
        const idx = rawNativeQueue.findIndex((q) => q.item.text === target);
        if (idx >= 0) rawNativeQueue.splice(idx, 1);
      }
      continue;
    }

    // A message typed while Claude was busy, delivered into the running turn at a tool
    // boundary. It steered that turn, so it belongs in the chat at this point.
    if (type === 'attachment') {
      const att = obj.attachment as Record<string, unknown> | undefined;
      const prompt = typeof att?.prompt === 'string' ? att.prompt.trim() : '';
      if (att?.type === 'queued_command' && att.commandMode === 'prompt' && prompt) {
        consumeQueuedText(prompt);
        if (!isInternalClaudeQueueContent(prompt)) {
          const extracted = extractAttachedImagesFromText(stripPastedContentWrappers(prompt));
          const blocks: UnifiedBlock[] = [...extracted.images];
          if (extracted.text.trim()) blocks.push({ type: 'text', text: extracted.text });
          if (blocks.length > 0) {
            currentAssistant = null;
            dropSteerInterrupt(normalizeTimestamp(obj.timestamp));
            messages.push({
              id: uniqueId(String(obj.uuid || `cq-${seq++}`)),
              role: 'user',
              timestamp: normalizeTimestamp(obj.timestamp),
              blocks,
            });
          }
        }
      }
      continue;
    }

    if (type === 'system') {
      const sub = obj.subtype;
      if (sub === 'stop_hook_summary' || sub === 'turn_duration') {
        pendingToolNames.clear();
      }
      continue;
    }

    if (type !== 'user' && type !== 'assistant') continue;
    if (obj.isSidechain === true) continue;
    const msg = obj.message as Record<string, unknown> | undefined;
    if (!msg) continue;

    const ts = normalizeTimestamp(obj.timestamp);
    const content = msg.content;

    if (type === 'user') {
      // A queued message delivered as its own turn shows up here as a plain user prompt.
      if (typeof content === 'string') consumeQueuedText(content);
      else if (Array.isArray(content)) {
        const text = content
          .filter((c) => (c as { type?: string })?.type === 'text')
          .map((c) => String((c as { text?: unknown }).text ?? ''))
          .join('\n');
        if (text) consumeQueuedText(text);
      }
      const origin = (obj.origin && typeof obj.origin === 'object'
        ? (obj.origin as Record<string, unknown>)
        : undefined);
      const originKind = typeof origin?.kind === 'string' ? origin.kind : undefined;
      const isCompactSummary = Boolean(obj.isCompactSummary);
      const isMeta = Boolean(obj.isMeta);

      const buildUserMeta = (txt: string): UnifiedMessage['harnessMeta'] => {
        if (
          isCompactSummary ||
          /^This session is being continued from a previous conversation/i.test(txt)
        ) {
          return { sourceKind: 'compaction' };
        }
        if (
          originKind === 'peer' ||
          /<cross-session-message\b/i.test(txt) ||
          /<teammate-message\b/i.test(txt) ||
          /^Another Claude session sent a message:/i.test(txt)
        ) {
          const nameMatch =
            txt.match(/<cross-session-message[^>]*\bname="([^"]+)"/i) ||
            txt.match(/<teammate-message[^>]*\bteammate_id="([^"]+)"/i);
          const senderName =
            nameMatch?.[1] ||
            (typeof origin?.from === 'string' ? origin.from : undefined);
          return { sourceKind: 'agent', senderName };
        }
        if (
          originKind === 'task-notification' ||
          /^<task-notification\b/i.test(txt)
        ) {
          return { sourceKind: 'task' };
        }
        if (isMeta) {
          return { sourceKind: 'system_meta' };
        }
        return undefined;
      };

      const pushUserOrLocalCommand = (
        rawText: string,
        extraImages: Array<Extract<UnifiedBlock, { type: 'image' }>> = []
      ) => {
        const extracted = extractAttachedImagesFromText(stripPastedContentWrappers(rawText));
        const allImages: Array<Extract<UnifiedBlock, { type: 'image' }>> = [];
        const seenImgs = new Set<string>();
        for (const img of [...extraImages, ...extracted.images]) {
          const key = img.path || img.dataUrl || '';
          if (!key || seenImgs.has(key)) continue;
          seenImgs.add(key);
          allImages.push(img);
        }

        const trimmed = extracted.text.trim();
        if (!trimmed && allImages.length === 0) return;

        // Hide Claude Code's internal local-command-caveat and image coordinate-scaling meta notes
        if (
          allImages.length === 0 &&
          (trimmed.startsWith('<local-command-caveat>') ||
            /^\[Image:\s*original\s+\d+x\d+,\s*displayed at\b/i.test(trimmed))
        ) {
          return;
        }

        // Claude Code writes this marker as a user line when Escape stops a turn. Nobody typed
        // it, so show it as a quiet notice, not as a message from the user.
        if (allImages.length === 0 && isClaudeInterruptMarker(trimmed)) {
          currentAssistant = null;
          messages.push({
            id: uniqueId(String(obj.uuid || `ci-${seq++}`)),
            role: 'system',
            timestamp: ts,
            blocks: [{ type: 'notice', title: 'Turn interrupted', detail: 'The Stop button or Esc stopped Claude here.' }],
          });
          pendingInterrupt = { index: messages.length - 1, ts };
          return;
        }

        // Render local slash commands (/effort, /model, /compact, etc.) as quiet system notices
        if (
          allImages.length === 0 &&
          (trimmed.startsWith('<command-name>') || trimmed.startsWith('<command-message>'))
        ) {
          const cmdName =
            extractTagContent(trimmed, 'command-name') ||
            extractTagContent(trimmed, 'command-message') ||
            'command';
          const cmdArgs = extractTagContent(trimmed, 'command-args');
          const title = cmdArgs ? `${cmdName} ${cmdArgs}` : cmdName;
          currentAssistant = null;
          messages.push({
            id: uniqueId(String(obj.uuid || `cs-${seq++}`)),
            role: 'system',
            timestamp: ts,
            blocks: [{ type: 'notice', title }],
          });
          return;
        }

        // Attach local command output to the preceding command notice when possible
        if (
          allImages.length === 0 &&
          (trimmed.startsWith('<local-command-stdout>') ||
            trimmed.startsWith('<local-command-stderr>'))
        ) {
          const out =
            extractTagContent(trimmed, 'local-command-stdout') ||
            extractTagContent(trimmed, 'local-command-stderr') ||
            '';
          if (!out) return;
          const prev = messages[messages.length - 1];
          if (prev?.role === 'system' && prev.blocks[0]?.type === 'notice' && !prev.blocks[0].detail) {
            prev.blocks[0].detail = out;
            return;
          }
          currentAssistant = null;
          messages.push({
            id: uniqueId(String(obj.uuid || `cs-${seq++}`)),
            role: 'system',
            timestamp: ts,
            blocks: [{ type: 'notice', title: out }],
          });
          return;
        }

        const userBlocks: UnifiedBlock[] = [...allImages];
        if (trimmed) {
          userBlocks.push({ type: 'text', text: extracted.text });
        }

        currentAssistant = null;
        if (!isMeta && !isCompactSummary && originKind !== 'task-notification') {
          pendingToolNames.clear();
        }
        if (allImages.length > 0) {
          lastUserImagePaths = new Set(allImages.map((i) => i.path).filter(Boolean));
        } else if (!isMeta) {
          lastUserImagePaths = new Set();
        }
        if (!isMeta) dropSteerInterrupt(ts);
        messages.push({
          id: uniqueId(String(obj.uuid || `cu-${seq++}`)),
          role: 'user',
          timestamp: ts,
          blocks: userBlocks,
          harnessMeta: trimmed ? buildUserMeta(trimmed) : undefined,
        });
      };

      // Check if this is purely a tool_result reply from Claude's agent loop
      if (Array.isArray(content)) {
        const nonToolTexts: string[] = [];
        const userImages: Array<Extract<UnifiedBlock, { type: 'image' }>> = [];
        for (const item of content) {
          if (!item || typeof item !== 'object') continue;
          const b = item as Record<string, unknown>;
          if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
            pendingToolNames.delete(b.tool_use_id);
            const target = toolBlockById.get(b.tool_use_id);
            const toolImages: Array<Extract<UnifiedBlock, { type: 'image' }>> = [];
            if (Array.isArray(b.content)) {
              for (const x of b.content) {
                if (x && typeof x === 'object') {
                  const img = parseClaudeImageBlock(x as Record<string, unknown>);
                  if (img) toolImages.push(img);
                }
              }
            }
            const resultText =
              typeof b.content === 'string'
                ? b.content
                : Array.isArray(b.content)
                  ? b.content
                      .map((x) => ((x as Record<string, unknown>)?.text as string) || '')
                      .filter(Boolean)
                      .join('\n')
                  : JSON.stringify(b.content ?? '');
            if (target && (target.type === 'tool_call' || target.type === 'command')) {
              target.output = resultText.slice(0, 10000);
              target.status = b.is_error ? 'error' : 'completed';
            } else if (target && target.type === 'question') {
              target.answered = true;
              // Parse Claude AskUserQuestion tool_result: `User has answered your questions: "Q"="A", ...`
              const pairs = Array.from(resultText.matchAll(/"([^"]+)"="([^"]*)"/g));
              if (pairs.length > 0) {
                for (const [, qKey, ans] of pairs) {
                  const matchQ = target.questions.find(
                    (q) => q.question.trim() === qKey.trim() || q.question.includes(qKey.trim())
                  );
                  if (matchQ) matchQ.answer = ans;
                }
              } else if (target.questions.length === 1 && resultText.trim()) {
                target.questions[0].answer = resultText
                  .replace(/^User has answered your questions?:\s*/i, '')
                  .trim();
              }
            }
            // Surface screenshots / read images returned by tool_result inline in the assistant turn
            // unless it is a duplicate Read of the exact image path the user just attached.
            const readTargetPath = toolReadPathById.get(b.tool_use_id);
            const isDuplicateUserRead = Boolean(readTargetPath && lastUserImagePaths.has(readTargetPath));
            if (toolImages.length > 0 && currentAssistant && !isDuplicateUserRead) {
              currentAssistant.blocks.push(...toolImages);
            }
          } else if (b.type === 'image') {
            const img = parseClaudeImageBlock(b);
            if (img) userImages.push(img);
          } else if (b.type === 'text' && typeof b.text === 'string') {
            nonToolTexts.push(b.text);
          }
        }
        const joined = nonToolTexts.join('\n').trim();
        if (joined || userImages.length > 0) pushUserOrLocalCommand(joined, userImages);
      } else if (typeof content === 'string' && content.trim()) {
        pushUserOrLocalCommand(content);
      }
      continue;
    }

    // Assistant message
    const stopReason = msg.stop_reason;
    let sawAssistantToolUse = false;
    const blocks: UnifiedBlock[] = [];
    if (typeof content === 'string' && content.trim()) {
      blocks.push({ type: 'text', text: content });
    } else if (Array.isArray(content)) {
      for (const item of content) {
        if (!item || typeof item !== 'object') continue;
        const b = item as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          blocks.push({ type: 'text', text: b.text });
        } else if (b.type === 'image') {
          const img = parseClaudeImageBlock(b);
          if (img) blocks.push(img);
        } else if (b.type === 'thinking' && typeof b.thinking === 'string' && b.thinking.trim()) {
          blocks.push({ type: 'thinking', text: b.thinking });
        } else if (b.type === 'tool_use') {
          sawAssistantToolUse = true;
          const name = String(b.name || 'tool');
          const input = (b.input ?? {}) as Record<string, unknown>;
          const toolUseId = typeof b.id === 'string' ? b.id : undefined;
          if (toolUseId) {
            pendingToolNames.set(toolUseId, name);
            if (name === 'Read' && typeof input.file_path === 'string') {
              toolReadPathById.set(toolUseId, input.file_path.trim());
            }
          }

          if (name === 'TodoWrite' && Array.isArray(input.todos)) {
            latestSteps = (input.todos as Array<Record<string, unknown>>).map((td) => ({
              title: String(td.content ?? td.title ?? ''),
              status:
                td.status === 'completed'
                  ? 'done'
                  : td.status === 'in_progress'
                    ? 'in_progress'
                    : 'pending',
            }));
          } else if (name === 'AskUserQuestion' && Array.isArray(input.questions)) {
            const qBlock: Extract<UnifiedBlock, { type: 'question' }> = {
              type: 'question',
              questions: (input.questions as Array<Record<string, unknown>>).map((q) => ({
                question: String(q.question ?? ''),
                options: Array.isArray(q.options)
                  ? q.options.map((o) =>
                      typeof o === 'string' ? o : String((o as Record<string, unknown>)?.label ?? '')
                    )
                  : [],
                multiSelect: Boolean(q.multiSelect),
              })),
            };
            blocks.push(qBlock);
            if (toolUseId) toolBlockById.set(toolUseId, qBlock);
          } else if (name === 'Bash' || name === 'bash' || name === 'run_command') {
            const cmdBlock: UnifiedBlock = {
              type: 'command',
              command: String(input.command ?? input.cmd ?? JSON.stringify(input)),
              status: 'running',
            };
            blocks.push(cmdBlock);
            if (toolUseId) toolBlockById.set(toolUseId, cmdBlock);
          } else if (name === 'SendUserFile') {
            const fileBlocks = buildClaudeSendUserFileBlocks(input);
            if (fileBlocks.length > 0) {
              blocks.push(...fileBlocks);
            } else {
              const tcBlock: UnifiedBlock = {
                type: 'tool_call',
                name,
                args: JSON.stringify(input, null, 2).slice(0, 4000),
                status: 'completed',
              };
              blocks.push(tcBlock);
              if (toolUseId) toolBlockById.set(toolUseId, tcBlock);
            }
          } else if (name === 'Edit' || name === 'Write' || name === 'MultiEdit') {
            const filePath = String(input.file_path ?? input.path ?? 'file');
            const diff =
              typeof input.new_string === 'string'
                ? `- ${String(input.old_string ?? '').slice(0, 600)}\n+ ${input.new_string.slice(0, 600)}`
                : typeof input.content === 'string'
                  ? `+ ${input.content.slice(0, 800)}`
                  : undefined;
            const fcBlock: UnifiedBlock = {
              type: 'file_change',
              changes: [{ path: filePath, kind: name.toLowerCase(), diff }],
              status: 'completed',
            };
            blocks.push(fcBlock);
          } else {
            const tcBlock: UnifiedBlock = {
              type: 'tool_call',
              name,
              args: JSON.stringify(input, null, 2).slice(0, 4000),
              status: 'completed',
            };
            blocks.push(tcBlock);
            if (toolUseId) toolBlockById.set(toolUseId, tcBlock);
          }
        }
      }
    }

    if (
      !sawAssistantToolUse &&
      (stopReason === 'end_turn' ||
        stopReason === 'stop_sequence' ||
        stopReason === 'max_tokens')
    ) {
      pendingToolNames.clear();
    }

    if (blocks.length > 0) {
      if (!currentAssistant) {
        currentAssistant = {
          id: uniqueId(String(obj.uuid || `ca-${seq++}`)),
          role: 'assistant',
          timestamp: ts,
          blocks,
          harnessMeta: {
            model: typeof msg.model === 'string' ? msg.model : undefined,
          },
        };
        messages.push(currentAssistant);
      } else {
        currentAssistant.blocks.push(...blocks);
        currentAssistant.timestamp = ts;
      }
    }
  }

  const tailActivity = meta?.tailActivity ?? { working: false, mtimeMs: sourceMtimeMs };
  const activeTool = Array.from(pendingToolNames.values()).pop() || tailActivity.activeTool;
  const isWorking =
    tailActivity.working ||
    (Date.now() - sourceMtimeMs < 30_000 &&
      (pendingToolNames.size > 0 || Boolean(latestSteps?.some((s) => s.status === 'in_progress'))));
  // Claude delivers every message typed during a turn into that same turn at the next tool
  // call, which is steering, so show those messages in the chat at once instead of in a
  // queue tray that they would leave seconds later.
  for (const entry of rawNativeQueue) {
    if (entry.isInternal) continue;
    const extracted = extractAttachedImagesFromText(stripPastedContentWrappers(entry.item.text));
    const blocks: UnifiedBlock[] = [...extracted.images];
    if (extracted.text.trim()) blocks.push({ type: 'text', text: extracted.text });
    if (blocks.length === 0) continue;
    messages.push({
      id: uniqueId(`claude-steer-${entry.item.createdAt}`),
      role: 'user',
      timestamp: entry.item.createdAt,
      blocks,
    });
  }
  const visibleNativeQueue: QueuedMessageItem[] = [];
  const liveActivity: LiveActivityState = {
    isWorking,
    focus: isWorking && activeTool ? `Running ${activeTool}` : undefined,
    steps: latestSteps,
    queuedMessages: visibleNativeQueue.length > 0 ? visibleNativeQueue : undefined,
    lastEventAt: sourceMtimeMs,
  };

  const sliced = messages.length > limit ? messages.slice(messages.length - limit) : messages;
  const truncated = Boolean(meta?.truncated);
  let totalCount = messages.length;
  if (truncated) {
    const ratio =
      meta?.fileSize && meta?.bytesRead && meta.bytesRead > 0
        ? meta.fileSize / meta.bytesRead
        : 2;
    totalCount = Math.max(messages.length + 1, Math.round(messages.length * ratio));
  }

  return {
    sessionId,
    messages: sliced,
    totalCount,
    hasMore: truncated || messages.length > limit,
    sourceMtimeMs,
    liveActivity,
    stats: computeClaudeSessionStats(lines),
  };
}

export async function loadClaudeTranscript(
  sessionId: string,
  nativeId: string,
  transcriptPath: string | undefined,
  cwd: string | undefined,
  limit = 120
): Promise<SessionTranscriptResult> {
  const resolved = transcriptPath || findClaudeTranscriptPath(nativeId, cwd);
  if (!resolved || !fs.existsSync(resolved)) {
    return {
      sessionId,
      messages: [],
      totalCount: 0,
      hasMore: false,
      sourceMtimeMs: Date.now(),
    };
  }

  const tailActivity = inspectClaudeTranscriptActivity(resolved, true);
  const initialBytes = Math.max(768 * 1024, limit * 24 * 1024);

  const outcome = readProgressiveJsonlTail(
    resolved,
    (lines, chunkMeta) =>
      parseClaudeJsonlLines(lines, sessionId, chunkMeta.mtimeMs, limit, {
        truncated: chunkMeta.truncated,
        fileSize: chunkMeta.fileSize,
        bytesRead: lines.reduce((sum, l) => sum + l.length + 1, 0),
        tailActivity,
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

export async function captureTmuxPane(target: string): Promise<TmuxCaptureResult> {
  try {
    // Strip ANSI escape sequences cleanly for crisp readable mirror, or keep layout
    const { stdout } = await execFileAsync(
      'tmux',
      ['capture-pane', '-p', '-J', '-S', '-150', '-t', target],
      { timeout: 3000, maxBuffer: 2 * 1024 * 1024 }
    );
    return {
      target,
      content: stdout,
      updatedAt: Date.now(),
    };
  } catch (err) {
    return {
      target,
      content: '',
      updatedAt: Date.now(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Parses one JSONL stdout line emitted by `claude --output-format stream-json --verbose`.
 */
export function parseClaudeStreamLine(
  sessionId: string,
  runId: string,
  line: string,
  gotAnyDelta: boolean,
  emitStream: (ev: StreamEvent) => void,
  partials = false
): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    if (!trimmed.startsWith('Warning:')) {
      emitStream({ sessionId, runId, kind: 'delta', text: `${trimmed}\n` });
      return true;
    }
    return false;
  }

  // Partial streaming (--include-partial-messages): text deltas stream
  // live; the following complete `assistant` line for the same segment is
  // suppressed by the caller via gotAnyDelta so text never doubles.
  if (obj.type === 'stream_event') {
    const event = obj.event as Record<string, unknown> | undefined;
    const delta = event?.delta as Record<string, unknown> | undefined;
    if (
      event?.type === 'content_block_delta' &&
      delta?.type === 'text_delta' &&
      typeof delta.text === 'string' &&
      delta.text
    ) {
      emitStream({ sessionId, runId, kind: 'delta', text: delta.text });
      return true;
    }
    return false;
  }

  if (obj.type === 'assistant') {
    const msg = obj.message as Record<string, unknown> | undefined;
    const content = msg?.content;
    let emitted = false;
    if (Array.isArray(content)) {
      for (const part of content) {
        const p = part as Record<string, unknown>;
        if (p.type === 'text' && typeof p.text === 'string' && p.text) {
          if (!partials || !gotAnyDelta) {
            emitStream({ sessionId, runId, kind: 'delta', text: p.text });
            emitted = true;
          }
        } else if (p.type === 'thinking' && typeof p.thinking === 'string' && p.thinking) {
          emitStream({
            sessionId,
            runId,
            kind: 'block',
            block: { type: 'thinking', text: p.thinking },
          });
        } else if (p.type === 'tool_use') {
          const name = String(p.name ?? 'tool');
          const input = (p.input ?? {}) as Record<string, unknown>;
          if (name === 'Bash' || name === 'bash' || name === 'run_command') {
            emitStream({
              sessionId,
              runId,
              kind: 'block',
              block: {
                type: 'command',
                command: String(input.command ?? input.cmd ?? JSON.stringify(input)),
                status: 'running',
              },
            });
          } else if (name === 'SendUserFile') {
            const fileBlocks = buildClaudeSendUserFileBlocks(input);
            for (const block of fileBlocks) {
              emitStream({ sessionId, runId, kind: 'block', block });
            }
          } else if (name === 'Edit' || name === 'Write' || name === 'MultiEdit') {
            const filePath = String(input.file_path ?? input.path ?? 'file');
            emitStream({
              sessionId,
              runId,
              kind: 'block',
              block: {
                type: 'file_change',
                changes: [{ path: filePath, kind: name.toLowerCase() }],
                status: 'running',
              },
            });
          } else if (name !== 'TodoWrite') {
            emitStream({
              sessionId,
              runId,
              kind: 'block',
              block: {
                type: 'tool_call',
                name,
                args: JSON.stringify(input, null, 2).slice(0, 2000),
                status: 'running',
              },
            });
          }
        }
      }
    }
    return emitted;
  }

  if (obj.type === 'result') {
    if (obj.is_error && typeof obj.result === 'string') {
      emitStream({ sessionId, runId, kind: 'error', error: obj.result });
    } else if (!gotAnyDelta && typeof obj.result === 'string' && obj.result) {
      emitStream({ sessionId, runId, kind: 'delta', text: obj.result });
      return true;
    }
  }
  return false;
}

/**
 * Claude Code records a bracketed paste as `<pasted_content id="N">…</pasted_content id="N">`.
 * Show the text a person sent, without the wrapper.
 */
export function stripPastedContentWrappers(text: string): string {
  if (!text.includes('<pasted_content')) return text;
  return text
    .replace(/<pasted_content\b[^>]*>\n?/g, '')
    .replace(/\n?<\/pasted_content\b[^>]*>/g, '');
}

/** Long/multiline prompts go through tmux paste-buffer instead of literal keystrokes. */
export function shouldUseTmuxPasteBuffer(text: string): boolean {
  return text.includes('\n') || text.length > 500;
}

/**
 * Split text into the keystroke steps `typeIntoClaudeTmux` sends: literal chunks of at most
 * `chunk` chars, with '\n' as its own step (typed as Ctrl+J, Claude's newline key).
 */
export function claudeTmuxTypingSteps(text: string, chunk = 100): string[] {
  const steps: string[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  lines.forEach((line, i) => {
    if (i > 0) steps.push('\n');
    for (let at = 0; at < line.length; at += chunk) steps.push(line.slice(at, at + chunk));
  });
  return steps;
}

/**
 * Type a prompt into a Claude TUI as keystrokes. A bracketed paste (or one big burst of
 * keys) makes Claude Code record the message as `<pasted_content>` / `[Pasted text #1]`,
 * which shows up in the transcript and tells the model the text was pasted from elsewhere.
 * Short chunks with small gaps stay below the paste detector; Ctrl+J inserts newlines.
 */
export async function typeIntoClaudeTmux(target: string, text: string, tmuxBin = 'tmux'): Promise<void> {
  // If the tmux pane is scrolled up in copy-mode, cancel it first so keystrokes reach the Claude TUI.
  try {
    const { stdout } = await execFileAsync(
      tmuxBin,
      ['display-message', '-p', '-t', target, '#{pane_in_mode}'],
      { timeout: 2000 }
    );
    if (stdout.trim() === '1') {
      await execFileAsync(tmuxBin, ['send-keys', '-t', target, '-X', 'cancel'], { timeout: 2000 });
      await new Promise((r) => setTimeout(r, 50));
    }
  } catch {
    // Non-fatal: proceed with typing
  }
  for (const step of claudeTmuxTypingSteps(text)) {
    if (step === '\n') {
      await execFileAsync(tmuxBin, ['send-keys', '-t', target, 'C-j'], { timeout: 4000 });
    } else {
      await execFileAsync(tmuxBin, ['send-keys', '-t', target, '-l', step], { timeout: 4000 });
    }
    await new Promise((r) => setTimeout(r, 30));
  }
}

/**
 * Delivery ack for tmux typing: poll the tail of the session JSONL for the
 * submitted prompt (user line or queue-operation enqueue) so a raced or
 * swallowed Enter can be retried automatically.
 */
export async function waitForClaudeTranscriptDelivery(
  transcriptPath: string | undefined,
  prompt: string,
  timeoutMs = 4000,
  initialSize?: number
): Promise<boolean> {
  if (!transcriptPath) return false;
  const needle = JSON.stringify(prompt.trim().slice(0, 60)).slice(1, -1);
  if (needle.length < 3 && initialSize === undefined) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const st = fs.statSync(transcriptPath);
      if (needle.length < 3) {
        if (initialSize !== undefined && st.size > initialSize) return true;
      } else {
        const start = Math.max(0, st.size - 262144);
        const fd = fs.openSync(transcriptPath, 'r');
        const buf = Buffer.alloc(st.size - start);
        fs.readSync(fd, buf, 0, buf.length, start);
        fs.closeSync(fd);
        if (buf.toString('utf8').includes(needle)) return true;
      }
    } catch {
      // transcript not flushed yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

/**
 * Cohesive HarnessDriver encapsulating all Anthropic Claude integration
 * (Claude Desktop metadata, Claude Code CLI transcripts, and live tmux remote-control).
 */
export interface LiveClaudeOwner {
  pid: number;
  sessionId: string;
  entrypoint?: string;
  tmux?: string;
  status?: string;
}

export type ClaudeDispatchDecision =
  | { action: 'tmux'; tmuxTarget: string }
  | { action: 'resume' }
  | { action: 'block'; reason: string };

/**
 * Inspects live `~/.claude/sessions/*.json` PID records for a given session ID.
 */
/**
 * A headless Claude process (the SDK / stream-json mode Superharness and Claude Desktop run)
 * has no terminal, but records the tmux pane of whatever started its parent. Treating that as
 * ownership typed one chat's messages into another chat's terminal, so its tmux field is ignored.
 */
export function withoutHeadlessTmux(data: ActiveClaudeSessionJson): ActiveClaudeSessionJson {
  if (data.tmux && data.entrypoint === 'sdk-cli') {
    const { tmux: _ignored, ...rest } = data;
    return rest as ActiveClaudeSessionJson;
  }
  return data;
}

export function findLiveClaudeOwners(
  nativeSessionId: string,
  sessionsDir = CLAUDE_SESSIONS_DIR
): LiveClaudeOwner[] {
  if (!nativeSessionId || !fs.existsSync(sessionsDir)) return [];
  const owners: LiveClaudeOwner[] = [];
  try {
    for (const fn of fs.readdirSync(sessionsDir)) {
      if (!fn.endsWith('.json')) continue;
      let data: ActiveClaudeSessionJson;
      try {
        data = withoutHeadlessTmux(
          JSON.parse(fs.readFileSync(path.join(sessionsDir, fn), 'utf8')) as ActiveClaudeSessionJson
        );
      } catch {
        continue;
      }
      if (data.sessionId !== nativeSessionId || !data.pid) continue;
      const pid = Number(data.pid);
      if (!Number.isFinite(pid) || !isSameProcessAlive(pid, data.procStart)) continue;
      owners.push({
        pid,
        sessionId: data.sessionId,
        entrypoint: data.entrypoint,
        tmux: data.tmux,
        status: data.status,
      });
    }
  } catch {
    // ignore scan errors
  }
  return owners;
}

/**
 * Prevents spawning duplicate `claude --resume` clone processes while another
 * Claude process is actively running a turn (`status === 'busy' | 'running'`).
 * Idle sessions (including idle Claude Desktop background processes) are
 * allowed to resume and deliver messages normally.
 */
export function resolveClaudeDispatchGuard(owners: LiveClaudeOwner[]): ClaudeDispatchDecision {
  const tmuxOwner = owners.find((o) => Boolean(o.tmux));
  if (tmuxOwner?.tmux) {
    return { action: 'tmux', tmuxTarget: tmuxOwner.tmux };
  }

  const busyOwner = owners.find((o) => o.status === 'busy' || o.status === 'running');
  if (busyOwner) {
    const label =
      busyOwner.entrypoint === 'claude-desktop' ? 'Claude Desktop' : 'another Claude CLI process';
    return {
      action: 'block',
      reason: `Claude is currently busy in ${label} (PID ${busyOwner.pid}). Wait for the active turn to finish before retrying so two copies do not overwrite each other.`,
    };
  }

  return { action: 'resume' };
}

const VALID_CLAUDE_PERM_MODES = new Set([
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'manual',
  'dontAsk',
  'plan',
]);

const VALID_CLAUDE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

export function buildClaudeResumeArgs(
  session: Pick<UnifiedSession, 'nativeId' | 'permissionMode' | 'model' | 'reasoningEffort'>,
  promptWithImages: string
): string[] {
  const args = [
    '--resume',
    session.nativeId,
    '-p',
    promptWithImages,
    '--output-format',
    'stream-json',
    '--verbose',
  ];
  if (session.model?.trim()) {
    args.push('--model', session.model.trim());
  }
  const effort = session.reasoningEffort?.trim().toLowerCase();
  if (effort && VALID_CLAUDE_EFFORTS.has(effort)) {
    args.push('--effort', effort);
  }
  if (session.permissionMode && VALID_CLAUDE_PERM_MODES.has(session.permissionMode)) {
    args.push('--permission-mode', session.permissionMode);
  }
  return args;
}

/** Footer text Claude Code's TUI shows for each permission mode (Shift+Tab cycles them). */
export const CLAUDE_TUI_MODE_LABELS: Record<string, string> = {
  bypassPermissions: 'bypass permissions on',
  auto: 'auto mode on',
  manual: 'manual mode on',
  plan: 'plan mode on',
  acceptEdits: 'accept edits on',
};

/** Current permission mode read from the bottom of a captured Claude TUI pane. */
export function detectClaudeTuiMode(paneText: string): string | undefined {
  // The pane is padded with blank rows below short content; look at the last real lines.
  const tail = paneText
    .split('\n')
    .filter((l) => l.trim())
    .slice(-6)
    .join('\n')
    .toLowerCase();
  for (const [mode, label] of Object.entries(CLAUDE_TUI_MODE_LABELS)) {
    if (tail.includes(label)) return mode;
  }
  return undefined;
}

async function captureClaudePane(target: string): Promise<string> {
  const { stdout } = await execFileAsync('tmux', ['capture-pane', '-p', '-t', target], { timeout: 4000 });
  return stdout;
}

/**
 * Switch a live Claude TUI's permission mode with Shift+Tab, reading the footer after each
 * press. Session-scoped: unlike /model or /effort it changes no saved defaults.
 */
export async function cycleClaudeTuiMode(
  target: string,
  wanted: string
): Promise<{ ok: boolean; seen: string[] }> {
  const seen: string[] = [];
  for (let i = 0; i <= 7; i++) {
    const mode = detectClaudeTuiMode(await captureClaudePane(target));
    seen.push(mode ?? 'unknown');
    if (mode === wanted) return { ok: true, seen };
    await execFileAsync('tmux', ['send-keys', '-t', target, 'BTab'], { timeout: 4000 });
    await new Promise((r) => setTimeout(r, 700));
  }
  return { ok: false, seen };
}

/** Wait until Claude registers `nativeId` under a new pid in ~/.claude/sessions. */
/** `--model` and `--effort` from a Claude command line (argv). */
export function parseClaudeLaunchFlags(argv: readonly string[]): { model?: string; effort?: string } {
  const out: { model?: string; effort?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--model' && argv[i + 1]) out.model = argv[i + 1];
    else if (a.startsWith('--model=')) out.model = a.slice('--model='.length) || undefined;
    else if (a === '--effort' && argv[i + 1]) out.effort = argv[i + 1];
    else if (a.startsWith('--effort=')) out.effort = a.slice('--effort='.length) || undefined;
  }
  return out;
}

/** The flags a running Claude process was launched with (Linux /proc; empty elsewhere). */
function claudeLaunchFlagsForPid(pid: number): { model?: string; effort?: string } {
  if (!Number.isFinite(pid) || pid <= 0) return {};
  try {
    return parseClaudeLaunchFlags(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0'));
  } catch {
    return {};
  }
}

/** How soon after an interruption a user message must follow for it to count as a steer. */
const STEER_INTERRUPT_WINDOW_MS = 15_000;

/** The line Claude Code records in place of a user message when a turn is interrupted. */
export function isClaudeInterruptMarker(text: string): boolean {
  return /^\[Request interrupted by user(?: for tool use)?\]$/.test(text.trim());
}

async function waitForClaudeRelaunch(nativeId: string, oldPid: number | undefined, timeoutMs = 12000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      for (const f of fs.readdirSync(CLAUDE_SESSIONS_DIR)) {
        if (!f.endsWith('.json')) continue;
        try {
          const d = JSON.parse(fs.readFileSync(path.join(CLAUDE_SESSIONS_DIR, f), 'utf8')) as ActiveClaudeSessionJson;
          if (d.sessionId === nativeId && d.pid && d.pid !== oldPid) {
            process.kill(d.pid, 0);
            return true;
          }
        } catch {
          // stale or partial file
        }
      }
    } catch {
      // sessions dir missing
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

export function createClaudeDriver(): HarnessDriver {
  const remote = new RemoteClaudeMirror();
  const streamPool = new ClaudeStreamPool((sid, rid, line, gotAny, emit) =>
    parseClaudeStreamLine(sid, rid, line, gotAny, emit, true)
  );

  const startClaudeSession = async (
    req: StartSessionRequest,
    ctx: DispatchContext
  ): Promise<{ ok: boolean; sessionId?: string; error?: string }> => {
    const cwd = fs.existsSync(req.cwd) ? req.cwd : os.homedir();

    const nativeId = crypto.randomUUID();
    const sessionId = `claude:${nativeId}`;

    if (req.harness === 'claude-tmux') {
      const claudeBin = await whichBinary('claude');
      const tmuxBin = await whichBinary('tmux');
      if (!claudeBin) return { ok: false, error: 'claude CLI not found' };
      if (!tmuxBin) return { ok: false, error: 'tmux not found' };

      const rawName =
        (req.tmuxSessionName || req.title || `sh-${Date.now().toString(36)}`)
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 32) || `sh-${Date.now().toString(36)}`;

      const flags: string[] = ['--session-id', nativeId];
      if (req.remoteControl !== false) flags.push('--remote-control');
      if (req.model) flags.push('--model', req.model);
      if (req.reasoningEffort) flags.push('--effort', req.reasoningEffort);
      if (req.title) flags.push('--name', req.title);

      const quote = (a: string) => `'${a.replace(/'/g, `'\\''`)}'`;
      const initialPrompt = formatPromptWithImagePaths(req.prompt?.trim() || '', req.attachments);
      // Claude submits a positional prompt as the first turn the moment it starts, so the
      // task begins immediately with no typing race. tmux caps a command near 16 KB; longer
      // prompts are typed in once the TUI is up.
      const baseCmd = [claudeBin, ...flags].map(quote).join(' ');
      const promptInArgv = Boolean(initialPrompt) && initialPrompt.length <= 8000;
      const cmd = promptInArgv ? `${baseCmd} -- ${quote(initialPrompt)}` : baseCmd;

      try {
        await execFileAsync(tmuxBin, ['new-session', '-d', '-s', rawName, '-c', cwd, cmd], {
          timeout: 5000,
        });
        if (initialPrompt && !promptInArgv) {
          setTimeout(() => {
            void typeIntoClaudeTmux(rawName, initialPrompt, tmuxBin)
              .then(() => execFileAsync(tmuxBin, ['send-keys', '-t', rawName, 'C-m'], { timeout: 4000 }))
              .catch(() => {});
          }, 2500);
        }
        registerPendingClaudeStart({
          nativeId,
          cwd,
          title: req.title || cleanTextPreview(initialPrompt, 90) || `Claude (${projectNameFromCwd(cwd)})`,
          tmuxSessionName: rawName,
          remoteControl: req.remoteControl !== false,
          model: req.model,
        });
        ctx.triggerRefresh(0);
        ctx.triggerRefresh(1000);
        ctx.triggerRefresh(2800);
        ctx.triggerRefresh(5000);
        return { ok: true, sessionId };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }

    const bin = await whichBinary('claude');
    if (!bin) return { ok: false, error: 'claude CLI not found' };
    const runId = crypto.randomBytes(6).toString('hex');
    const cliPrompt = formatPromptWithImagePaths(
      req.prompt?.trim() ||
        (req.attachments && req.attachments.length > 0
          ? 'Inspect the attached image(s).'
          : 'Hello! Summarize the workspace briefly.'),
      req.attachments
    );
    const args = [
      '--session-id',
      nativeId,
      '-p',
      cliPrompt,
      '--output-format',
      'stream-json',
      '--verbose',
    ];
    if (req.model) args.push('--model', req.model);
    if (req.reasoningEffort) args.push('--effort', req.reasoningEffort);
    ctx.spawnStreaming({
      sessionId,
      runId,
      bin,
      args,
      cwd,
      parseLine: (line, gotAnyDelta) =>
        parseClaudeStreamLine(sessionId, runId, line, gotAnyDelta, ctx.emitStream),
    });
    ctx.triggerRefresh(800);
    ctx.triggerRefresh(2500);
    return { ok: true, sessionId };
  };

  return {
    async applySessionConfig(session, change, ctx) {
      if (remote.isRemote(session.id) || session.tags?.includes('remote-host')) {
        return resultsFor(change, () => ({
          status: 'unsupported',
          detail: `This Claude session runs on ${session.hostLabel || session.hostAddress || 'another machine'}; change it there.`,
        }));
      }
      // Validate first.
      const norm: { model?: string; reasoningEffort?: string; permissionMode?: string } = {};
      const bad: Record<string, ReturnType<typeof invalid>> = {};
      if (change.model !== undefined) norm.model = change.model.trim();
      if (change.reasoningEffort !== undefined) {
        const v = change.reasoningEffort.trim() ? normalizeEffort(change.reasoningEffort, CLAUDE_EFFORTS) : '';
        if (v === undefined) bad.reasoningEffort = invalid(CLAUDE_EFFORTS);
        else norm.reasoningEffort = v;
      }
      if (change.permissionMode !== undefined) {
        const v = change.permissionMode.trim() ? normalizeClaudePermissionMode(change.permissionMode) : '';
        if (v === undefined) bad.permissionMode = invalid(CLAUDE_PERMISSION_MODES);
        else norm.permissionMode = v;
      }

      const liveTmux = session.dispatchMode === 'tmux-send' && Boolean(session.tmuxTarget);
      if (!liveTmux) {
        const next =
          'Applies when Superharness next sends a message to this session (live set_model / set_permission_mode on its Claude process, or resume flags). The Claude Desktop app\'s own picker is not changed.';
        return resultsFor(change, (field) =>
          bad[field] ?? { status: 'next_message', value: norm[field] ?? '', detail: next }
        );
      }

      // Live Claude TUI in tmux.
      const target = session.tmuxTarget!;
      const out: Record<string, { status: SessionConfigFieldResult['status']; value?: string; detail?: string }> = {};
      const wantsLaunchFlags = (norm.model !== undefined && !bad.model) || norm.reasoningEffort !== undefined;
      if (wantsLaunchFlags && change.restart) {
        if (session.status === 'running') {
          for (const f of ['model', 'reasoningEffort', 'permissionMode'] as const) {
            if (norm[f] !== undefined) out[f] = { status: 'failed', detail: 'Claude is mid-turn in this tmux session; restart it when it is idle.' };
          }
        } else {
          const claudeBin = (await whichBinary('claude')) || 'claude';
          const model = norm.model !== undefined ? norm.model : session.model;
          const effort = norm.reasoningEffort !== undefined ? norm.reasoningEffort : session.reasoningEffort;
          const perm = norm.permissionMode !== undefined ? norm.permissionMode : session.permissionMode;
          const flags = ['--resume', session.nativeId];
          if (session.isRemote || session.tags?.includes('remote-control')) flags.push('--remote-control');
          if (model) flags.push('--model', model);
          if (effort) flags.push('--effort', effort);
          if (perm) flags.push('--permission-mode', perm);
          const quote = (a: string) => `'${a.replace(/'/g, `'\\''`)}'`;
          const cmd = [claudeBin, ...flags].map(quote).join(' ');
          try {
            await execFileAsync('tmux', ['respawn-pane', '-k', '-t', target, '-c', session.cwd || os.homedir(), cmd], { timeout: 5000 });
            const ok = await waitForClaudeRelaunch(session.nativeId, session.pid);
            for (const f of ['model', 'reasoningEffort', 'permissionMode'] as const) {
              if (norm[f] === undefined || bad[f]) continue;
              out[f] = ok
                ? { status: 'applied', value: norm[f], detail: `Restarted Claude in tmux ${target} with --resume and the new flags; the conversation continues.` }
                : { status: 'failed', value: norm[f], detail: `Restarted the tmux pane ${target} but Claude did not re-register within 12 s; check that terminal.` };
            }
            ctx.triggerRefresh(1500);
          } catch (err) {
            for (const f of ['model', 'reasoningEffort', 'permissionMode'] as const) {
              if (norm[f] !== undefined && !bad[f]) out[f] = { status: 'failed', detail: `tmux respawn failed: ${err instanceof Error ? err.message : String(err)}` };
            }
          }
        }
      } else {
        const why =
          'A live Claude terminal only takes model/effort at launch (typing /model or /effort would also change your global Claude defaults). Pass restart: true to restart it in place with --resume.';
        if (norm.model !== undefined) out.model = { status: 'needs_restart', value: norm.model, detail: why };
        if (norm.reasoningEffort !== undefined) out.reasoningEffort = { status: 'needs_restart', value: norm.reasoningEffort, detail: why };
        if (norm.permissionMode !== undefined) {
          const wanted = norm.permissionMode || 'manual';
          try {
            const r = await cycleClaudeTuiMode(target, wanted);
            out.permissionMode = r.ok
              ? { status: 'applied', value: norm.permissionMode, detail: 'Switched live with Shift+Tab (this session only).' }
              : {
                  status: 'failed',
                  detail: `Shift+Tab never reached "${CLAUDE_TUI_MODE_LABELS[wanted]}" (saw: ${r.seen.join(' -> ')}). The mode may not be enabled for this session; pass restart: true to relaunch with --permission-mode.`,
                };
          } catch (err) {
            out.permissionMode = { status: 'failed', detail: `tmux failed: ${err instanceof Error ? err.message : String(err)}` };
          }
        }
      }
      return resultsFor(change, (field) => bad[field] ?? out[field] ?? { status: 'failed', detail: 'Not processed.' });
    },

    id: 'claude',
    displayName: 'Claude (Desktop + tmux CLI)',

    async detect(processes, maxSessions, showArchived) {
      const [local, remoteSessions] = await Promise.all([
        detectClaude(processes, maxSessions, showArchived),
        remote.sessions().catch(() => [] as UnifiedSession[]),
      ]);
      const localIds = new Set(local.sessions.map((s) => s.id));
      const extra = remoteSessions.filter((s) => !localIds.has(s.id));
      if (extra.length === 0) return local;
      return {
        detection: {
          ...local.detection,
          activeSessionCount: local.detection.activeSessionCount + extra.length,
          totalSessionCount: local.detection.totalSessionCount + extra.length,
        },
        sessions: [...extra, ...local.sessions],
      };
    },

    setActivitySink(sink) {
      remote.setActivitySink(sink);
    },

    async getTranscriptFingerprint(session) {
      const remoteFp = remote.fingerprint(session.id);
      if (remoteFp) return remoteFp;
      const resolved =
        session.transcriptPath || resolveClaudeTranscriptPath(session.nativeId, session.cwd);
      return computeFileFingerprint(resolved);
    },

    async loadTranscript(session, limit) {
      // Right after launch a transcript request can beat the first SSH poll of remote hosts.
      if (!remote.isRemote(session.id) && session.tags?.includes('remote-host')) {
        await remote.sessions();
      }
      if (remote.isRemote(session.id)) {
        const res = await remote.loadTranscript(session.id, limit);
        if (res) return res;
      }
      const resolved =
        session.transcriptPath || resolveClaudeTranscriptPath(session.nativeId, session.cwd);
      // Reading and JSON-parsing a multi-MB tail runs on a worker thread so it never stalls
      // the main (browser UI) thread.
      return offloadPool.run('loadClaudeTranscript', session.id, session.nativeId, resolved, session.cwd, limit);
    },

    getGlobalWatchDirs(): HarnessWatchSpec[] {
      const specs: HarnessWatchSpec[] = [
        { dir: CLAUDE_SESSIONS_DIR, filter: (fn) => fn.endsWith('.json') },
      ];
      // Watch recent Claude project transcript dirs so background working spinners update live
      if (fs.existsSync(CLAUDE_PROJECTS_DIR)) {
        try {
          for (const entry of fs
            .readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })
            .slice(0, 40)) {
            if (entry.isDirectory()) {
              specs.push({
                dir: path.join(CLAUDE_PROJECTS_DIR, entry.name),
                filter: (fn) => fn.endsWith('.jsonl'),
              });
            }
          }
        } catch {
          // ignore
        }
      }
      return specs;
    },

    getSessionWatchFiles(session: UnifiedSession): string[] {
      const files: string[] = [];
      if (remote.isRemote(session.id)) return files; // polled over SSH instead
      if (session.transcriptPath) files.push(session.transcriptPath);
      if (session.pid) {
        files.push(path.join(CLAUDE_SESSIONS_DIR, `${session.pid}.json`));
      }
      return files;
    },

    /**
     * Queue for after the current turn. Claude queues natively on every path: a tmux TUI holds
     * input typed while it works, and a stream-json worker puts user frames sent mid-turn into
     * the CLI's input queue. So queueing is a send that never interrupts (no `force`).
     */
    async queueMessage(
      session: UnifiedSession,
      prompt: string,
      attachments: ImageAttachment[] | undefined,
      ctx: DispatchContext
    ): Promise<SendMessageResult> {
      return this.sendMessage(session, prompt, attachments, ctx, { force: false });
    },

    async sendMessage(
      session: UnifiedSession,
      prompt: string,
      attachments: ImageAttachment[] | undefined,
      ctx: DispatchContext,
      opts?: { force?: boolean }
    ): Promise<SendMessageResult> {
      if (remote.isRemote(session.id)) {
        return remote.sendMessage(session.id, prompt, attachments);
      }
      const promptWithImages = formatPromptWithImagePaths(prompt, attachments);

      // No metadata-free native wire exists into a live Claude TUI (the
      // cc-socks peer socket stamps origin.kind=peer), so tmux sessions are
      // driven by typing — honestly labelled degraded, hardened with
      // paste-buffer for long/multiline text and a transcript ack.
      const sendViaTmux = async (target: string): Promise<SendMessageResult> => {
        try {
          const transcriptPath =
            session.transcriptPath ||
            resolveClaudeTranscriptPath(session.nativeId, session.cwd);
          let initialSize: number | undefined;
          if (transcriptPath) {
            try {
              initialSize = fs.statSync(transcriptPath).size;
            } catch {
              initialSize = 0;
            }
          }

          // If Claude is waiting on an interactive AskUserQuestion TUI picker, drive the
          // arrow/Enter wizard directly instead of typing raw text into the option list.
          if (!attachments?.length && transcriptPath) {
            try {
              const recent = await loadClaudeTranscript(
                session.id,
                session.nativeId,
                transcriptPath,
                session.cwd,
                10
              );
              const pendingQ = extractPendingQuestionBlock(recent);
              const choices = pendingQ
                ? resolveClaudeQuestionAnswers(pendingQ.questions, prompt)
                : null;
              if (pendingQ && choices) {
                const handled = await driveLocalClaudeQuestionTmux(
                  target,
                  pendingQ.questions,
                  choices
                );
                if (handled) {
                  ctx.triggerRefresh(800);
                  ctx.triggerRefresh(2200);
                  return {
                    ok: true,
                    dispatchedVia: `tmux question picker → ${target}`,
                  };
                }
              }
            } catch {
              // Non-fatal: fall through to standard typing.
            }
          }

          await typeIntoClaudeTmux(target, promptWithImages);
          await new Promise((r) => setTimeout(r, 180));
          await execFileAsync('tmux', ['send-keys', '-t', target, 'C-m'], {
            timeout: 4000,
          });

          let delivered = await waitForClaudeTranscriptDelivery(
            transcriptPath,
            prompt,
            1800,
            initialSize
          );

          // If the prompt hasn't hit the JSONL yet, check whether the Claude TUI swallowed
          // the first Enter (text still sitting in the input box) and retry C-m once.
          if (transcriptPath && !delivered) {
            try {
              const { stdout: paneTail } = await execFileAsync(
                'tmux',
                ['capture-pane', '-p', '-t', target, '-S', '-12'],
                { timeout: 2500 }
              );
              const snippet = prompt.trim().slice(0, 24);
              if (snippet && paneTail.includes(snippet)) {
                await execFileAsync('tmux', ['send-keys', '-t', target, 'C-m'], {
                  timeout: 4000,
                });
              }
            } catch {
              // ignore pane capture errors
            }
            delivered = await waitForClaudeTranscriptDelivery(
              transcriptPath,
              prompt,
              3000,
              initialSize
            );
          }

          ctx.triggerRefresh(1200);
          if (!delivered) {
            // Schedule a follow-up refresh in case the TUI was mid-turn / queuing the prompt,
            // without falsely marking a successfully typed tmux message as "Not delivered".
            ctx.triggerRefresh(3500);
          }
          return {
            ok: true,
            dispatchedVia: `tmux typing → ${target}`,
          };
        } catch (err) {
          return {
            ok: false,
            error: `tmux send-keys failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      };

      // A tmux session that died (reboot, tmux server killed): start it again with this
      // message as Claude's first prompt instead of typing into a pane that isn't there.
      const reviveInTmux = async (rec: ClaudeTmuxRecord): Promise<SendMessageResult> => {
        streamPool.abort(session.id, ctx.emitStream);
        const inArgv = promptWithImages.trim().length <= MAX_ARGV_PROMPT;
        const res = await claudeTmuxRecords.revive(rec, inArgv ? { prompt: promptWithImages } : {});
        if (!res.ok) {
          return { ok: false, error: `Restarting tmux session ${rec.tmuxSessionName} failed: ${res.error}` };
        }
        if (!inArgv) {
          setTimeout(() => {
            void typeIntoClaudeTmux(rec.tmuxSessionName, promptWithImages)
              .then(() =>
                execFileAsync('tmux', ['send-keys', '-t', rec.tmuxSessionName, 'C-m'], { timeout: 4000 })
              )
              .catch(() => {});
          }, 4000);
        }
        ctx.triggerRefresh(1500);
        ctx.triggerRefresh(4000);
        return { ok: true, dispatchedVia: `restarted tmux ${rec.tmuxSessionName} (claude --resume)` };
      };

      // Live tmux-backed Claude session -> direct tmux send-keys with TUI-safe Enter delay
      if (session.dispatchMode === 'tmux-send' && session.tmuxTarget) {
        const tmuxName = session.tmuxSessionName || session.tmuxTarget.split(':')[0];
        if (!(await listTmuxSessionNames()).has(tmuxName)) {
          return reviveInTmux(
            claudeTmuxRecords.get(session.nativeId) ?? {
              nativeId: session.nativeId,
              tmuxSessionName: tmuxName,
              cwd: session.cwd,
              model: session.model,
              reasoningEffort: session.reasoningEffort,
              permissionMode: session.permissionMode,
              remoteControl: session.tags?.includes('remote-control') ?? true,
              bootId: '',
              seenAt: Date.now(),
            }
          );
        }
        return sendViaTmux(session.tmuxTarget);
      }

      // Guard against spawning a second concurrent `claude --resume` clone process
      // while Claude Desktop or another external live CLI process is actively running a turn.
      // Exclude our own warm ClaudeStreamPool worker PID from external owner detection.
      const ownPid = streamPool.getWorkerPid(session.id);
      const liveOwners = findLiveClaudeOwners(session.nativeId).filter(
        (o) => !ownPid || o.pid !== ownPid
      );
      const decision = resolveClaudeDispatchGuard(liveOwners);
      if (decision.action === 'tmux') {
        return sendViaTmux(decision.tmuxTarget);
      }
      if (decision.action === 'block') {
        // Another Claude (the Desktop app or a terminal) is running this chat. A plain send is
        // refused; a steer is held until that turn ends, never forced into a second process.
        return opts?.force
          ? { ok: false, holdUntilIdle: true, error: decision.reason }
          : { ok: false, error: decision.reason };
      }
      // Nothing owns this chat right now, but it last ran in tmux (e.g. before a reboot):
      // bring it back in tmux rather than answering through a headless worker.
      if (decision.action === 'resume') {
        const rec = claudeTmuxRecords.get(session.nativeId);
        if (
          rec &&
          !streamPool.hasActiveTurn(session.id) &&
          !(await listTmuxSessionNames()).has(rec.tmuxSessionName)
        ) {
          return reviveInTmux(rec);
        }
      }
      // A steer never stops the running turn. The background CLI cannot take a message
      // mid-turn, so sendTurn holds it in the worker's queue and sends it when the turn ends.

      const cwd = fs.existsSync(session.cwd) ? session.cwd : os.homedir();
      const runId = crypto.randomBytes(6).toString('hex');
      const hasImages = Boolean(attachments && attachments.length > 0);

      // Primary path: persistent bidirectional `claude --input-format stream-json --output-format stream-json`
      // worker pool (same wire protocol Claude Desktop uses, with native base64 multimodal image blocks).
      try {
        await streamPool.sendTurn({
          shSessionId: session.id,
          nativeSessionId: session.nativeId,
          cwd,
          prompt,
          attachments,
          model: session.model,
          reasoningEffort: session.reasoningEffort,
          permissionMode: session.permissionMode,
          transcriptPath:
            session.transcriptPath || resolveClaudeTranscriptPath(session.nativeId, session.cwd),
          runId,
          onEvent: ctx.emitStream,
          onComplete: () => {
            ctx.triggerRefresh(500);
            ctx.triggerRefresh(1800);
          },
        });
        return {
          ok: true,
          runId,
          dispatchedVia: hasImages
            ? `Claude stream-json (${attachments!.length} image${attachments!.length === 1 ? '' : 's'})`
            : 'Claude stream-json',
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },

    abort(
      sessionId: string,
      emitStream: (ev: StreamEvent) => void,
      session?: UnifiedSession
    ): boolean {
      if (streamPool.abort(sessionId, emitStream)) return true;

      // For live tmux-backed Claude sessions (or Claude sessions owned by a live tmux pane),
      // send Escape to interrupt the active turn cleanly without killing the Claude Code TUI.
      const tmuxTarget = (() => {
        if (session?.dispatchMode === 'tmux-send' && session.tmuxTarget) {
          return session.tmuxTarget;
        }
        if (session) {
          const guard = resolveClaudeDispatchGuard(findLiveClaudeOwners(session.nativeId));
          if (guard.action === 'tmux') return guard.tmuxTarget;
        }
        return undefined;
      })();
      if (tmuxTarget) {
        void execFileAsync('tmux', ['send-keys', '-t', tmuxTarget, 'Escape'], {
          timeout: 3000,
        }).catch(() => {});
        emitStream({ sessionId, runId: 'abort', kind: 'done' });
        return true;
      }
      return false;
    },

    async promoteToTmux(
      session: UnifiedSession,
      ctx: DispatchContext
    ): Promise<{ ok: boolean; tmuxSession?: string; error?: string }> {
      if (session.dispatchMode === 'tmux-send' && session.tmuxSessionName) {
        return { ok: true, tmuxSession: session.tmuxSessionName };
      }
      const claudeBin = await whichBinary('claude');
      const tmuxBin = await whichBinary('tmux');
      if (!claudeBin) return { ok: false, error: 'claude CLI not found' };
      if (!tmuxBin) return { ok: false, error: 'tmux not found' };

      const cwd = fs.existsSync(session.cwd) ? session.cwd : os.homedir();
      const slug =
        (session.title || 'claude')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 20) || 'claude';
      const tmuxSession = `sh-${slug}-${session.nativeId.slice(0, 6)}`;

      const flags = ['--resume', session.nativeId, '--remote-control'];
      if (session.model?.trim()) flags.push('--model', session.model.trim());
      if (session.reasoningEffort?.trim()) flags.push('--effort', session.reasoningEffort.trim());
      if (session.permissionMode && VALID_CLAUDE_PERM_MODES.has(session.permissionMode)) {
        flags.push('--permission-mode', session.permissionMode);
      }
      const cmd = [claudeBin, ...flags].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');

      // Close any warm stream worker before handing ownership to tmux
      streamPool.abort(session.id, ctx.emitStream);

      try {
        await execFileAsync(tmuxBin, ['new-session', '-d', '-s', tmuxSession, '-c', cwd, cmd], {
          timeout: 5000,
        });
        ctx.triggerRefresh(1200);
        ctx.triggerRefresh(3000);
        return { ok: true, tmuxSession };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    shutdown(): void {
      streamPool.closeAll();
    },

    activeHostTurns(): number {
      return streamPool.activeTurnCount();
    },

    async restartHosts(): Promise<string[]> {
      const n = streamPool.closeIdle();
      return n > 0 ? [`${n} Claude ${n === 1 ? 'worker' : 'workers'}`] : [];
    },

    startSession: startClaudeSession,

    async controlDaemon(
      action: DaemonControlAction,
      ctx: DispatchContext
    ): Promise<{ ok: boolean; output?: string; error?: string }> {
      if (action === 'start_remote') {
        return startClaudeSession(
          {
            harness: 'claude-tmux',
            cwd: os.homedir(),
            title: `claude-rc-${Date.now().toString(36)}`,
            remoteControl: true,
          },
          ctx
        );
      }
      return { ok: false, error: `Action '${action}' not supported for claude` };
    },

    async archiveSession(
      session: UnifiedSession,
      opts?: { killTmux?: boolean }
    ) {
      if (
        session.harness === 'claude-desktop' &&
        session.nativeMetaPath &&
        fs.existsSync(session.nativeMetaPath)
      ) {
        const raw = JSON.parse(fs.readFileSync(session.nativeMetaPath, 'utf8')) as Record<
          string,
          unknown
        >;
        raw.isArchived = true;
        fs.writeFileSync(session.nativeMetaPath, JSON.stringify(raw, null, 2), 'utf8');
        return { ok: true, method: 'Claude Desktop isArchived' };
      }

      if (session.harness === 'claude-tmux' && opts?.killTmux && session.tmuxSessionName) {
        const tmuxBin = await whichBinary('tmux');
        if (tmuxBin) {
          await execFileAsync(tmuxBin, ['kill-session', '-t', session.tmuxSessionName], {
            timeout: 5000,
          });
        }
        return {
          ok: true,
          method: `tmux kill-session (${session.tmuxSessionName})`,
          hideLocally: true,
        };
      }

      return null;
    },
  };
}
