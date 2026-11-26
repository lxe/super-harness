import { execFile, spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  HarnessDetection,
  ImageAttachment,
  LiveActivityState,
  QueuedMessageItem,
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
  normalizeTimestamp,
  projectNameFromCwd,
  resolveCodexBinary,
  type ProcessRow,
} from '../utils/system';
import {
  createUniqueIdGenerator,
  formatPromptWithImagePaths,
  type DaemonControlAction,
  type DispatchContext,
  type HarnessDriver,
  type HarnessWatchSpec,
} from './types';

const execFileAsync = promisify(execFile);

const CODEX_DIR = path.join(os.homedir(), '.codex');
const STATE_DB = path.join(CODEX_DIR, 'state_5.sqlite');
const HISTORY_DB = path.join(CODEX_DIR, 'thread_history_1.sqlite');
const QUEUE_DB = path.join(CODEX_DIR, 'queue_1.sqlite');
const CODEX_DAEMON_SOCK = path.join(CODEX_DIR, 'app-server-control', 'app-server-control.sock');

function hasCodexDaemonSocket(): boolean {
  try {
    return fs.existsSync(CODEX_DAEMON_SOCK);
  } catch {
    return false;
  }
}

interface CodexThreadRow {
  id: string;
  rollout_path: string | null;
  created_at: number | null;
  updated_at: number | null;
  created_at_ms: number | null;
  updated_at_ms: number | null;
  source: string | null;
  originator: string | null;
  cwd: string | null;
  title: string | null;
  name: string | null;
  preview: string | null;
  first_user_message: string | null;
  model: string | null;
  git_branch: string | null;
  archived: number | null;
  is_pinned: number | null;
  tokens_used: number | null;
  project_id: string | null;
  thread_section_id: string | null;
}

interface CodexProjectRow {
  id: string;
  name: string | null;
}

interface CodexSectionRow {
  id: string;
  name: string | null;
}

interface CodexRemoteRow {
  server_name: string | null;
  remote_control_enabled: number | null;
}

interface CodexItemRow {
  turn_id: string;
  item_id: string;
  item_type: string;
  item_json: string;
  created_at_ms: number | null;
  rollout_ordinal: number;
}

let cachedCodexVersion: string | null | undefined;

function inspectCodexRolloutActivity(
  rolloutPath: string | undefined,
  codexAlive: boolean
): { working: boolean; mtimeMs: number } {
  if (!rolloutPath) return { working: false, mtimeMs: 0 };
  let st: fs.Stats;
  try {
    st = fs.statSync(rolloutPath);
  } catch {
    return { working: false, mtimeMs: 0 };
  }

  const ageMs = Date.now() - st.mtimeMs;
  if (ageMs > 30 * 60 * 1000) {
    return { working: false, mtimeMs: st.mtimeMs };
  }

  try {
    const readLen = Math.min(st.size, 49152);
    const fd = fs.openSync(rolloutPath, 'r');
    const buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, st.size - readLen);
    fs.closeSync(fd);
    const tail = buf.toString('utf8');
    const lines = tail.split('\n');
    const startIdx = st.size > readLen ? 1 : 0;

    let started = false;
    let sawTerminalEvent = false;
    let pendingCalls = 0;

    for (let i = startIdx; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      if (line.includes('"task_started"')) {
        started = true;
        sawTerminalEvent = false;
      } else if (line.includes('"task_complete"') || line.includes('"turn_aborted"')) {
        started = false;
        sawTerminalEvent = true;
        pendingCalls = 0;
      } else if (line.includes('"function_call"') || line.includes('"custom_tool_call"')) {
        pendingCalls++;
      } else if (
        line.includes('"function_call_output"') ||
        line.includes('"custom_tool_call_output"')
      ) {
        pendingCalls = Math.max(0, pendingCalls - 1);
      }
    }

    const maxActiveAge = codexAlive ? 20 * 60 * 1000 : 2 * 60 * 1000;
    const working =
      ((started || pendingCalls > 0) && ageMs < maxActiveAge) ||
      (!sawTerminalEvent && codexAlive && ageMs < 20_000);

    return { working, mtimeMs: st.mtimeMs };
  } catch {
    return { working: false, mtimeMs: st.mtimeMs };
  }
}

export async function detectCodex(
  processes: ProcessRow[],
  maxSessions: number,
  showArchived: boolean
): Promise<{ detection: HarnessDetection; sessions: UnifiedSession[] }> {
  const binPath = await resolveCodexBinary();
  if (cachedCodexVersion === undefined) {
    cachedCodexVersion = await getBinaryVersion(binPath);
  }

  const codexProcs = processes.filter(
    (p) =>
      p.args.includes('/codex') ||
      p.args.includes('codex-desktop') ||
      p.comm === 'codex'
  );
  const desktopRunning = codexProcs.some((p) => p.args.includes('codex-desktop'));
  const daemonRunning = codexProcs.some(
    (p) => p.args.includes('app-server') || p.args.includes('remote-control')
  );

  const remoteRows = await querySqliteReadOnly<CodexRemoteRow>(
    STATE_DB,
    'SELECT server_name, remote_control_enabled FROM remote_control_enrollments'
  );
  const remoteControlEnabled = remoteRows.some((r) => Boolean(r.remote_control_enabled));

  const projectRows = await querySqliteReadOnly<{
    id: string;
    name: string | null;
    position: number | null;
  }>(STATE_DB, 'SELECT id, name, position FROM projects');
  const projectMap = new Map<string, { name: string; order: number }>();
  for (const p of projectRows) {
    if (p.id && p.name) {
      projectMap.set(p.id, { name: p.name, order: 20 + Number(p.position ?? 50) });
    }
  }

  const projectRootRows = await querySqliteReadOnly<{
    project_id: string;
    path: string;
  }>(STATE_DB, 'SELECT project_id, path FROM project_roots');
  const rootToProject = projectRootRows
    .filter((r) => r.path && projectMap.has(r.project_id))
    .sort((a, b) => b.path.length - a.path.length);

  const sectionRows = await querySqliteReadOnly<CodexSectionRow>(
    STATE_DB,
    'SELECT id, name FROM thread_sections'
  );
  const sectionMap = new Map<string, { name: string; order: number }>();
  sectionRows.forEach((sec, idx) => {
    if (sec.id && sec.name) {
      sectionMap.set(sec.id, {
        name: sec.name,
        order: sec.name === 'Pinned' ? 0 : 1 + idx,
      });
    }
  });

  // Also check ~/.codex/.codex-global-state.json for thread-project-assignments ({ projectKind, projectId })
  const globalProjAssignments = new Map<string, { name: string; order: number }>();
  const globalPinnedIds = new Set<string>();
  try {
    const gsPath = path.join(CODEX_DIR, '.codex-global-state.json');
    if (fs.existsSync(gsPath)) {
      const gs = JSON.parse(fs.readFileSync(gsPath, 'utf8')) as Record<string, unknown>;
      const pinnedArr = gs['pinned-thread-ids'];
      if (Array.isArray(pinnedArr)) {
        for (const id of pinnedArr) if (typeof id === 'string') globalPinnedIds.add(id);
      }
      const localProjs = (gs['local-projects'] ?? {}) as Record<string, { name?: string }>;
      const legacyByHost = (gs['app-server-project-id-by-legacy-project-id-by-host'] ?? {}) as Record<
        string,
        Record<string, string>
      >;
      const legacyMap = new Map<string, string>();
      for (const m of Object.values(legacyByHost)) {
        for (const [oldId, newId] of Object.entries(m || {})) {
          legacyMap.set(oldId, newId);
        }
      }
      const assigns = (gs['thread-project-assignments'] ?? {}) as Record<
        string,
        string | { projectId?: string }
      >;
      for (const [tid, rawVal] of Object.entries(assigns)) {
        const pid = typeof rawVal === 'string' ? rawVal : rawVal?.projectId;
        if (!pid) continue;
        const mappedId = legacyMap.get(pid) || pid;
        const fromSql = projectMap.get(mappedId);
        if (fromSql) {
          globalProjAssignments.set(tid, fromSql);
        } else if (localProjs[pid]?.name) {
          globalProjAssignments.set(tid, { name: localProjs[pid].name!, order: 60 });
        }
      }
    }
  } catch {
    // ignore
  }

  // Detect Codex spawned child subagent threads from thread_spawn_edges
  const edgeRows = await querySqliteReadOnly<{
    parent_thread_id: string;
    child_thread_id: string;
  }>(STATE_DB, 'SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges');
  const childToParent = new Map<string, string>();
  const subCountByParent = new Map<string, number>();
  for (const e of edgeRows) {
    if (e.child_thread_id && e.parent_thread_id) {
      childToParent.set(e.child_thread_id, e.parent_thread_id);
      subCountByParent.set(
        e.parent_thread_id,
        (subCountByParent.get(e.parent_thread_id) ?? 0) + 1
      );
    }
  }

  const countRows = await querySqliteReadOnly<{ cnt: number }>(
    STATE_DB,
    'SELECT count(*) as cnt FROM threads WHERE COALESCE(archived, 0) = 0'
  );
  const totalCount = Number(countRows[0]?.cnt ?? 0);

  const whereClause = showArchived ? '' : 'WHERE COALESCE(archived, 0) = 0';
  const rows = await querySqliteReadOnly<CodexThreadRow>(
    STATE_DB,
    `SELECT id, rollout_path, created_at, updated_at, created_at_ms, updated_at_ms,
            source, originator, cwd, title, name, preview, first_user_message,
            model, git_branch, archived, is_pinned, tokens_used, project_id, thread_section_id
     FROM threads
     ${whereClause}
     ORDER BY COALESCE(updated_at_ms, updated_at * 1000, created_at * 1000) DESC
     LIMIT ?`,
    [maxSessions]
  );

  const sessions: UnifiedSession[] = rows.map((row) => {
    const cwd = row.cwd || os.homedir();
    const updatedAt = normalizeTimestamp(row.updated_at_ms ?? row.updated_at ?? row.created_at);
    const createdAt = normalizeTimestamp(row.created_at_ms ?? row.created_at ?? updatedAt);
    const rawTitle = row.name || row.title || row.first_user_message || 'Codex Session';
    const title = cleanTextPreview(rawTitle, 90) || 'Codex Session';
    const preview = cleanTextPreview(row.preview || row.first_user_message || title, 140);
    const secInfo = row.thread_section_id ? sectionMap.get(row.thread_section_id) : undefined;
    const assignedProj =
      (row.project_id && projectMap.get(row.project_id)) ||
      globalProjAssignments.get(row.id) ||
      (() => {
        const homeDir = os.homedir();
        const match = rootToProject.find((r) =>
          r.path === homeDir
            ? false
            : cwd === r.path || cwd.startsWith(`${r.path}/`)
        );
        return match ? projectMap.get(match.project_id) : undefined;
      })();

    const projectName = assignedProj?.name || projectNameFromCwd(cwd);
    const chosenGroup = secInfo || assignedProj;
    const nativeSection = chosenGroup ? chosenGroup.name : 'Ungrouped';
    const nativeSectionOrder = chosenGroup ? chosenGroup.order : 9999;
    const codexAlive = desktopRunning || daemonRunning || codexProcs.length > 0;
    const rolloutActivity = inspectCodexRolloutActivity(row.rollout_path || undefined, codexAlive);
    const effectiveUpdatedAt = Math.max(updatedAt, rolloutActivity.mtimeMs);
    const isWorking = !row.archived && rolloutActivity.working;
    const isLive =
      isWorking ||
      (codexAlive && Date.now() - effectiveUpdatedAt < 30 * 60 * 1000);

    const parentId = childToParent.get(row.id);
    const isSubagent = Boolean(parentId);
    const subCount = subCountByParent.get(row.id);

    return {
      id: `codex:${row.id}`,
      nativeId: row.id,
      harness: 'codex',
      harnessGroup: 'codex',
      title,
      preview,
      cwd,
      projectName,
      nativeSection,
      nativeSectionOrder,
      gitBranch: row.git_branch || undefined,
      model: row.model || undefined,
      status: row.archived ? 'archived' : isWorking ? 'running' : 'idle',
      isLive,
      isRemote: remoteControlEnabled,
      transcriptPath: row.rollout_path || undefined,
      createdAt,
      updatedAt: effectiveUpdatedAt,
      tokenCount: typeof row.tokens_used === 'number' ? row.tokens_used : undefined,
      pinned: Boolean(row.is_pinned) || globalPinnedIds.has(row.id) || secInfo?.name === 'Pinned',
      folderId: null,
      tags: isSubagent ? ['subagent'] : row.source ? [row.source] : [],
      hidden: false,
      dispatchMode: 'codex-resume',
      isSubagent,
      parentSessionId: parentId ? `codex:${parentId}` : undefined,
      subagentCount: subCount,
    };
  });

  const detection: HarnessDetection = {
    id: 'codex',
    name: 'OpenAI Codex',
    installed: Boolean(binPath) || fs.existsSync(STATE_DB),
    binaryPath: binPath,
    version: cachedCodexVersion,
    runningProcesses: codexProcs.length,
    desktopAppRunning: desktopRunning,
    daemonRunning,
    remoteControlEnabled,
    activeSessionCount: sessions.filter((s) => s.isLive).length,
    totalSessionCount: totalCount || sessions.length,
    capabilities: {
      canStartNew: Boolean(binPath),
      canResume: Boolean(binPath),
      canTmuxMirror: false,
      canControlDaemon: Boolean(binPath),
    },
    notes: desktopRunning
      ? 'Codex Desktop app + SQLite thread store detected'
      : 'Codex CLI & local SQLite thread store detected',
  };

  return { detection, sessions };
}

function parseCodexItemToBlock(itemType: string, raw: Record<string, unknown>): {
  role: 'user' | 'assistant' | 'system';
  block: UnifiedBlock | null;
} {
  if (itemType === 'userMessage') {
    const content = raw.content;
    let text = '';
    if (Array.isArray(content)) {
      text = content
        .map((c) => {
          if (typeof c === 'string') return c;
          if (c && typeof c === 'object') {
            const obj = c as Record<string, unknown>;
            if (typeof obj.text === 'string') return obj.text;
          }
          return '';
        })
        .filter(Boolean)
        .join('\n');
    } else if (typeof content === 'string') {
      text = content;
    } else if (typeof raw.text === 'string') {
      text = raw.text;
    }
    if (!text.trim()) return { role: 'user', block: null };
    return { role: 'user', block: { type: 'text', text } };
  }

  if (itemType === 'agentMessage') {
    const text = typeof raw.text === 'string' ? raw.text : '';
    if (!text.trim()) return { role: 'assistant', block: null };
    return { role: 'assistant', block: { type: 'text', text } };
  }

  if (itemType === 'reasoning') {
    const summaryArr = Array.isArray(raw.summary) ? raw.summary : [];
    const contentArr = Array.isArray(raw.content) ? raw.content : [];
    const summary = summaryArr
      .map((s) => (typeof s === 'string' ? s : (s as Record<string, unknown>)?.text || ''))
      .filter(Boolean)
      .join('\n');
    const content = contentArr
      .map((s) => (typeof s === 'string' ? s : (s as Record<string, unknown>)?.text || ''))
      .filter(Boolean)
      .join('\n');
    const body = content || summary;
    if (!body.trim()) return { role: 'assistant', block: null };
    return {
      role: 'assistant',
      block: { type: 'thinking', text: body, summary: summary || undefined },
    };
  }

  if (itemType === 'commandExecution') {
    const command = typeof raw.command === 'string' ? raw.command : '(command)';
    const output =
      typeof raw.aggregatedOutput === 'string'
        ? raw.aggregatedOutput.slice(0, 12000)
        : undefined;
    return {
      role: 'assistant',
      block: {
        type: 'command',
        command,
        cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
        output,
        exitCode: typeof raw.exitCode === 'number' ? raw.exitCode : null,
        durationMs: typeof raw.durationMs === 'number' ? raw.durationMs : undefined,
        status: typeof raw.status === 'string' ? raw.status : undefined,
      },
    };
  }

  if (itemType === 'fileChange') {
    const rawChanges = Array.isArray(raw.changes) ? raw.changes : [];
    const changes = rawChanges.map((ch) => {
      const obj = (ch ?? {}) as Record<string, unknown>;
      const kindObj = obj.kind as Record<string, unknown> | string | undefined;
      const kind =
        typeof kindObj === 'string'
          ? kindObj
          : typeof kindObj?.type === 'string'
            ? kindObj.type
            : 'update';
      return {
        path: String(obj.path ?? 'unknown'),
        kind,
        diff: typeof obj.diff === 'string' ? obj.diff.slice(0, 10000) : undefined,
      };
    });
    if (changes.length === 0) return { role: 'assistant', block: null };
    return {
      role: 'assistant',
      block: {
        type: 'file_change',
        changes,
        status: typeof raw.status === 'string' ? raw.status : undefined,
      },
    };
  }

  if (itemType === 'mcpToolCall' || itemType === 'dynamicToolCall' || itemType === 'collabAgentToolCall') {
    const name = String(raw.tool || raw.name || itemType);
    const server = typeof raw.server === 'string' ? raw.server : undefined;
    const args =
      raw.arguments !== undefined
        ? typeof raw.arguments === 'string'
          ? raw.arguments.slice(0, 4000)
          : JSON.stringify(raw.arguments, null, 2).slice(0, 4000)
        : undefined;
    let output: string | undefined;
    if (raw.error) {
      output = typeof raw.error === 'string' ? raw.error : JSON.stringify(raw.error, null, 2);
    } else if (raw.result !== undefined) {
      output =
        typeof raw.result === 'string'
          ? raw.result.slice(0, 8000)
          : JSON.stringify(raw.result, null, 2).slice(0, 8000);
    }
    return {
      role: 'assistant',
      block: {
        type: 'tool_call',
        name,
        server,
        args,
        output,
        status: typeof raw.status === 'string' ? raw.status : undefined,
        durationMs: typeof raw.durationMs === 'number' ? raw.durationMs : undefined,
      },
    };
  }

  if (itemType === 'webSearch') {
    const query = typeof raw.query === 'string' ? raw.query : '';
    const action = raw.action as Record<string, unknown> | undefined;
    const url = typeof action?.url === 'string' ? action.url : undefined;
    if (!query && !url) return { role: 'assistant', block: null };
    return {
      role: 'assistant',
      block: { type: 'web_search', query: query || url || 'Web search', url },
    };
  }

  if (itemType === 'contextCompaction') {
    return {
      role: 'system',
      block: { type: 'notice', title: 'Context compacted' },
    };
  }

  if (itemType === 'subAgentActivity') {
    return {
      role: 'assistant',
      block: {
        type: 'notice',
        title: 'Subagent activity',
        detail: JSON.stringify(raw).slice(0, 300),
      },
    };
  }

  return { role: 'assistant', block: null };
}

export interface CodexTranscriptDbPaths {
  historyDb: string;
  queueDb: string;
}

export async function getCodexTranscriptFingerprint(
  nativeId: string,
  rolloutPath: string | undefined,
  dbs: CodexTranscriptDbPaths = { historyDb: HISTORY_DB, queueDb: QUEUE_DB }
): Promise<string> {
  let rolloutPart = '0:0';
  if (rolloutPath) {
    try {
      const st = fs.statSync(rolloutPath);
      rolloutPart = `${st.size}:${Math.floor(st.mtimeMs)}`;
    } catch {
      // ignore
    }
  }

  let itemsPart = '0:0';
  if (fs.existsSync(dbs.historyDb)) {
    const statRows = await querySqliteReadOnly<{ cnt: number; maxOrd: number | null }>(
      dbs.historyDb,
      'SELECT COUNT(*) as cnt, MAX(rollout_ordinal) as maxOrd FROM thread_items WHERE thread_id = ?',
      [nativeId]
    );
    if (statRows[0]) {
      itemsPart = `${Number(statRows[0].cnt ?? 0)}:${Number(statRows[0].maxOrd ?? 0)}`;
    }
  }

  let queuePart = '0';
  if (fs.existsSync(dbs.queueDb)) {
    const qStat = await querySqliteReadOnly<{ cnt: number; maxTs: number | null }>(
      dbs.queueDb,
      'SELECT COUNT(*) as cnt, MAX(created_at_ms) as maxTs FROM queued_items WHERE thread_id = ?',
      [nativeId]
    );
    if (qStat[0]) {
      queuePart = `${Number(qStat[0].cnt ?? 0)}:${Number(qStat[0].maxTs ?? 0)}`;
    }
  }

  return `codex:${itemsPart}|${rolloutPart}|${queuePart}`;
}

export function coalesceCodexItemRows(rowsAsc: CodexItemRow[]): UnifiedMessage[] {
  const messages: UnifiedMessage[] = [];
  const uniqueId = createUniqueIdGenerator();

  let currentAssistant: UnifiedMessage | null = null;
  for (const r of rowsAsc) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(r.item_json) as Record<string, unknown>;
    } catch {
      continue;
    }
    const { role, block } = parseCodexItemToBlock(r.item_type, parsed);
    if (!block) continue;
    const ts = normalizeTimestamp(r.created_at_ms);

    if (role === 'user') {
      currentAssistant = null;
      messages.push({
        id: uniqueId(r.item_id || `u-${r.rollout_ordinal}`),
        role: 'user',
        timestamp: ts,
        blocks: [block],
        harnessMeta: { turnId: r.turn_id },
      });
    } else if (role === 'system') {
      currentAssistant = null;
      messages.push({
        id: uniqueId(r.item_id || `s-${r.rollout_ordinal}`),
        role: 'system',
        timestamp: ts,
        blocks: [block],
      });
    } else {
      if (!currentAssistant || currentAssistant.harnessMeta?.turnId !== r.turn_id) {
        currentAssistant = {
          id: uniqueId(r.item_id || `a-${r.rollout_ordinal}`),
          role: 'assistant',
          timestamp: ts,
          blocks: [block],
          harnessMeta: { turnId: r.turn_id },
        };
        messages.push(currentAssistant);
      } else {
        currentAssistant.blocks.push(block);
        currentAssistant.timestamp = ts;
      }
    }
  }
  return messages;
}

function parseCodexRolloutLines(lines: string[]): UnifiedMessage[] {
  const messages: UnifiedMessage[] = [];
  let currentAssistant: UnifiedMessage | null = null;
  let idx = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const ts = normalizeTimestamp(obj.timestamp);
    if (obj.type === 'response_item') {
      const pl = (obj.payload ?? {}) as Record<string, unknown>;
      if (pl.type === 'message' && (pl.role === 'user' || pl.role === 'assistant')) {
        const contentArr = Array.isArray(pl.content) ? pl.content : [];
        const txt = contentArr
          .map((c) => {
            const o = c as Record<string, unknown>;
            return typeof o?.text === 'string' ? o.text : '';
          })
          .filter(Boolean)
          .join('\n');
        if (!txt.trim()) continue;
        if (pl.role === 'user') {
          currentAssistant = null;
          messages.push({
            id: `jsonl-u-${idx++}`,
            role: 'user',
            timestamp: ts,
            blocks: [{ type: 'text', text: txt }],
          });
        } else {
          if (!currentAssistant) {
            currentAssistant = {
              id: `jsonl-a-${idx++}`,
              role: 'assistant',
              timestamp: ts,
              blocks: [{ type: 'text', text: txt }],
            };
            messages.push(currentAssistant);
          } else {
            currentAssistant.blocks.push({ type: 'text', text: txt });
          }
        }
      } else if (pl.type === 'function_call' || pl.type === 'custom_tool_call') {
        const blk: UnifiedBlock = {
          type: 'tool_call',
          name: String(pl.name || pl.type),
          args: String(pl.arguments ?? pl.input ?? '').slice(0, 4000),
        };
        if (!currentAssistant) {
          currentAssistant = {
            id: `jsonl-a-${idx++}`,
            role: 'assistant',
            timestamp: ts,
            blocks: [blk],
          };
          messages.push(currentAssistant);
        } else {
          currentAssistant.blocks.push(blk);
        }
      }
    }
  }
  return messages;
}

export async function loadCodexTranscriptFromPaths(
  nativeId: string,
  rolloutPath: string | undefined,
  limit = 120,
  dbs: CodexTranscriptDbPaths = { historyDb: HISTORY_DB, queueDb: QUEUE_DB }
): Promise<SessionTranscriptResult> {
  const sessionId = `codex:${nativeId}`;
  let sourceMtimeMs = Date.now();
  try {
    const dbMtime = fs.existsSync(dbs.historyDb) ? fs.statSync(dbs.historyDb).mtimeMs : 0;
    const walPath = `${dbs.historyDb}-wal`;
    const walMtime = fs.existsSync(walPath) ? fs.statSync(walPath).mtimeMs : 0;
    const rolloutMtime =
      rolloutPath && fs.existsSync(rolloutPath) ? fs.statSync(rolloutPath).mtimeMs : 0;
    sourceMtimeMs = Math.max(dbMtime, walMtime, rolloutMtime) || Date.now();
  } catch {
    // ignore stat errors
  }

  // Check if Codex rollout has an active in-flight turn (task_started without task_complete)
  const codexTurnActive = inspectCodexRolloutActivity(rolloutPath, true).working;

  // Primary: projected thread_items in thread_history_1.sqlite using idx_thread_items_page
  // (fetches ONLY tail rows via ORDER BY rollout_ordinal DESC LIMIT ? instead of scanning 20k+ rows!)
  let messages: UnifiedMessage[] = [];
  let truncated = false;
  let totalItemCount = 0;
  let fetchedItemCount = 0;

  if (fs.existsSync(dbs.historyDb)) {
    const countRows = await querySqliteReadOnly<{ cnt: number }>(
      dbs.historyDb,
      'SELECT COUNT(*) as cnt FROM thread_items WHERE thread_id = ?',
      [nativeId]
    );
    totalItemCount = Number(countRows[0]?.cnt ?? 0);

    if (totalItemCount > 0) {
      let rowBudget = Math.min(totalItemCount, Math.max(limit * 16, 400));
      const maxRowBudget = Math.min(totalItemCount, 25_000);

      while (true) {
        const descRows = await querySqliteReadOnly<CodexItemRow>(
          dbs.historyDb,
          `SELECT turn_id, item_id, item_type, item_json, created_at_ms, rollout_ordinal
           FROM thread_items
           WHERE thread_id = ?
           ORDER BY rollout_ordinal DESC
           LIMIT ?`,
          [nativeId, rowBudget]
        );
        fetchedItemCount = descRows.length;
        const rowsAsc = descRows.reverse();
        messages = coalesceCodexItemRows(rowsAsc);
        truncated = fetchedItemCount < totalItemCount;

        if (!truncated || messages.length >= limit || rowBudget >= maxRowBudget) {
          break;
        }
        rowBudget = Math.min(maxRowBudget, rowBudget * 4);
      }
    }
  }

  if (messages.length === 0 && rolloutPath && fs.existsSync(rolloutPath)) {
    // Fallback: progressive tail read of raw rollout JSONL (safe for 190MB+ files)
    const initialBytes = Math.max(768 * 1024, limit * 24 * 1024);
    const outcome = readProgressiveJsonlTail(
      rolloutPath,
      (lines) => parseCodexRolloutLines(lines),
      (parsed) => parsed.length >= limit,
      { initialBytes }
    );
    if (outcome) {
      messages = outcome.parsed;
      truncated = outcome.truncated;
      if (truncated && outcome.bytesRead > 0) {
        totalItemCount = Math.max(
          messages.length + 1,
          Math.round(messages.length * (outcome.fileSize / outcome.bytesRead))
        );
        fetchedItemCount = messages.length;
      }
    }
  }

  // Read any native Codex queued items from ~/.codex/queue_1.sqlite
  const nativeQueued: QueuedMessageItem[] = [];
  if (fs.existsSync(dbs.queueDb)) {
    try {
      const qRows = await querySqliteReadOnly<{
        id: string;
        payload_json: string;
        created_at_ms: number;
      }>(
        dbs.queueDb,
        `SELECT id, payload_json, created_at_ms
         FROM queued_items
         WHERE thread_id = ?
         ORDER BY queue_order ASC`,
        [nativeId]
      );
      for (const qr of qRows) {
        let text = '';
        try {
          const p = JSON.parse(qr.payload_json) as Record<string, unknown>;
          if (typeof p.text === 'string') text = p.text;
          else if (typeof p.prompt === 'string') text = p.prompt;
          else if (typeof p.message === 'string') text = p.message;
          else if (Array.isArray(p.input)) {
            text = (p.input as Array<Record<string, unknown>>)
              .map((x) => (typeof x?.text === 'string' ? x.text : ''))
              .filter(Boolean)
              .join('\n');
          } else {
            text = qr.payload_json.slice(0, 300);
          }
        } catch {
          text = qr.payload_json.slice(0, 300);
        }
        if (text.trim()) {
          nativeQueued.push({
            id: `codex-q-${qr.id}`,
            text: text.trim(),
            createdAt: normalizeTimestamp(qr.created_at_ms),
            source: 'native',
          });
        }
      }
    } catch {
      // ignore queue read errors
    }
  }

  const liveActivity: LiveActivityState = {
    isWorking: codexTurnActive,
    focus: codexTurnActive ? 'Codex turn in progress' : undefined,
    queuedMessages: nativeQueued.length > 0 ? nativeQueued : undefined,
    lastEventAt: sourceMtimeMs,
  };

  const sliced = messages.length > limit ? messages.slice(messages.length - limit) : messages;
  let totalCount = messages.length;
  if (truncated) {
    const ratio = fetchedItemCount > 0 ? totalItemCount / fetchedItemCount : 2;
    totalCount = Math.max(messages.length + 1, Math.round(messages.length * ratio));
  }
  return {
    sessionId,
    messages: sliced,
    totalCount,
    hasMore: truncated || messages.length > limit,
    sourceMtimeMs,
    liveActivity,
  };
}

export async function loadCodexTranscript(
  nativeId: string,
  rolloutPath: string | undefined,
  limit = 120
): Promise<SessionTranscriptResult> {
  return loadCodexTranscriptFromPaths(nativeId, rolloutPath, limit);
}

/**
 * Parses one JSONL stdout line emitted by `codex exec --json`.
 */
function parseCodexStreamLine(
  sessionId: string,
  runId: string,
  line: string,
  emitStream: (ev: StreamEvent) => void
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

  if (obj.type === 'error' || obj.type === 'turn.failed') {
    const errMsg =
      typeof obj.message === 'string'
        ? obj.message
        : typeof (obj.error as Record<string, unknown>)?.message === 'string'
          ? String((obj.error as Record<string, unknown>).message)
          : JSON.stringify(obj);
    emitStream({ sessionId, runId, kind: 'error', error: errMsg });
    return false;
  }

  const item = obj.item as Record<string, unknown> | undefined;
  if (item) {
    if (item.type === 'agent_message' && typeof item.text === 'string' && item.text) {
      emitStream({ sessionId, runId, kind: 'delta', text: item.text });
      return true;
    }
    if (item.type === 'reasoning' && typeof item.text === 'string' && item.text) {
      emitStream({
        sessionId,
        runId,
        kind: 'block',
        block: { type: 'thinking', text: item.text },
      });
      return false;
    }
    if (item.type === 'command_execution') {
      emitStream({
        sessionId,
        runId,
        kind: 'block',
        block: {
          type: 'command',
          command: String(item.command ?? ''),
          output: typeof item.aggregated_output === 'string' ? item.aggregated_output : undefined,
          exitCode: typeof item.exit_code === 'number' ? item.exit_code : null,
          status: typeof item.status === 'string' ? item.status : undefined,
        },
      });
      return false;
    }
    if (item.type === 'file_change' && Array.isArray(item.changes)) {
      emitStream({
        sessionId,
        runId,
        kind: 'block',
        block: {
          type: 'file_change',
          changes: (item.changes as Array<Record<string, unknown>>).map((c) => ({
            path: String(c.path ?? 'file'),
            kind: String(c.kind ?? 'update'),
          })),
        },
      });
      return false;
    }
    if (item.type === 'mcp_tool_call') {
      emitStream({
        sessionId,
        runId,
        kind: 'block',
        block: {
          type: 'tool_call',
          name: String(item.tool ?? 'mcp'),
          server: typeof item.server === 'string' ? item.server : undefined,
          args: JSON.stringify(item.arguments ?? {}, null, 2).slice(0, 2000),
          status: typeof item.status === 'string' ? item.status : undefined,
        },
      });
      return false;
    }
    if (item.type === 'error' && typeof item.message === 'string') {
      // Ignore harmless config deprecation warnings from ~/.codex/config.toml
      if (!item.message.includes('is deprecated')) {
        emitStream({ sessionId, runId, kind: 'error', error: item.message });
      }
      return false;
    }
  }
  if (typeof obj.delta === 'string' && obj.delta) {
    emitStream({ sessionId, runId, kind: 'delta', text: obj.delta });
    return true;
  }
  return false;
}

/**
 * Matches transient Codex daemon concurrency rejections (`already has an active writer`
 * or `remote thread already has an active turn`) that should transparently fall back
 * to `codex queue --resume` instead of surfacing an error to the user.
 */
export function isCodexActiveWriterError(text: string): boolean {
  return /already has an active (?:writer|turn)|turn already in progress|thread is busy/i.test(
    text
  );
}

/**
 * Cohesive HarnessDriver encapsulating all OpenAI Codex integration
 * (SQLite state/history/queue stores, rollouts, app-server daemon, CLI).
 */
export function createCodexDriver(): HarnessDriver {
  const activeRuns = new Map<string, ChildProcess>();

  const killActiveRun = (sessionId: string) => {
    const prev = activeRuns.get(sessionId);
    if (!prev) return;
    try {
      prev.kill('SIGTERM');
    } catch {
      // ignore
    }
    activeRuns.delete(sessionId);
  };

  return {
    id: 'codex',
    displayName: 'OpenAI Codex',

    detect(processes, maxSessions, showArchived) {
      return detectCodex(processes, maxSessions, showArchived);
    },

    getTranscriptFingerprint(session) {
      return getCodexTranscriptFingerprint(session.nativeId, session.transcriptPath);
    },

    loadTranscript(session, limit) {
      return loadCodexTranscript(session.nativeId, session.transcriptPath, limit);
    },

    getGlobalWatchDirs(): HarnessWatchSpec[] {
      const specs: HarnessWatchSpec[] = [
        {
          dir: CODEX_DIR,
          filter: (fn) =>
            fn.startsWith('state_5.sqlite') || fn.startsWith('thread_history_1.sqlite'),
        },
      ];
      // Watch today's Codex rollout directory so active working spinners update immediately
      const now = new Date();
      const todayDir = path.join(
        CODEX_DIR,
        'sessions',
        String(now.getFullYear()),
        String(now.getMonth() + 1).padStart(2, '0'),
        String(now.getDate()).padStart(2, '0')
      );
      if (fs.existsSync(todayDir)) {
        specs.push({ dir: todayDir, filter: (fn) => fn.endsWith('.jsonl') });
      }
      return specs;
    },

    getSessionWatchFiles(session: UnifiedSession): string[] {
      const files: string[] = [];
      if (session.transcriptPath) files.push(session.transcriptPath);
      files.push(
        HISTORY_DB,
        `${HISTORY_DB}-wal`,
        QUEUE_DB,
        `${QUEUE_DB}-wal`
      );
      return files;
    },

    async sendMessage(
      session: UnifiedSession,
      prompt: string,
      attachments: ImageAttachment[] | undefined,
      ctx: DispatchContext
    ): Promise<SendMessageResult> {
      const bin = await resolveCodexBinary();
      if (!bin) return { ok: false, error: 'codex binary not found in PATH' };

      const cwd = fs.existsSync(session.cwd) ? session.cwd : os.homedir();
      const runId = crypto.randomBytes(6).toString('hex');
      const hasImages = Boolean(attachments && attachments.length > 0);
      const useDaemon = hasCodexDaemonSocket();
      const promptWithImages = formatPromptWithImagePaths(prompt, attachments);

      // Route through `--remote unix://` whenever the Codex app-server daemon is running
      // to avoid `thread already has an active writer` conflicts. Because `--remote` + `-i`
      // hits an upstream clap parsing bug, pass image paths inline in daemon mode and use
      // `-i <path> --` in standalone CLI mode.
      const args = ['exec', 'resume'];
      if (useDaemon) {
        args.push(
          '--remote',
          'unix://',
          '--skip-git-repo-check',
          '--json',
          session.nativeId,
          promptWithImages
        );
      } else {
        args.push('--skip-git-repo-check', '--json');
        if (hasImages) {
          for (const att of attachments!) {
            args.push('-i', att.path);
          }
          args.push('--');
        }
        args.push(session.nativeId, prompt.trim() || 'Inspect the attached image(s).');
      }

      killActiveRun(session.id);
      const child = spawn(bin, args, {
        cwd,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      activeRuns.set(session.id, child);
      ctx.emitStream({ sessionId: session.id, runId, kind: 'start' });

      let stdoutBuf = '';
      let stderrBuf = '';
      let gotAnyDelta = false;
      let hitActiveWriter = false;

      const handleLine = (line: string) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        if (isCodexActiveWriterError(trimmed)) {
          hitActiveWriter = true;
          return;
        }
        if (parseCodexStreamLine(session.id, runId, trimmed, ctx.emitStream)) {
          gotAnyDelta = true;
        }
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString('utf8');
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop() ?? '';
        for (const line of lines) handleLine(line);
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        stderrBuf = (stderrBuf + chunk.toString('utf8')).slice(-4000);
        if (isCodexActiveWriterError(stderrBuf)) {
          hitActiveWriter = true;
        }
      });

      child.on('error', (err) => {
        activeRuns.delete(session.id);
        ctx.emitStream({ sessionId: session.id, runId, kind: 'error', error: err.message });
        ctx.emitStream({ sessionId: session.id, runId, kind: 'done' });
      });

      child.on('close', (code) => {
        if (stdoutBuf.trim()) handleLine(stdoutBuf);
        activeRuns.delete(session.id);

        if (hitActiveWriter || isCodexActiveWriterError(stderrBuf)) {
          // Another Codex client (e.g. Codex Desktop) holds the active writer lock on this thread.
          // Route seamlessly through `codex queue --resume` so the active writer receives and runs
          // the message directly with zero error banner.
          const queueArgs = ['queue'];
          if (useDaemon) queueArgs.push('--remote', 'unix://');
          queueArgs.push(
            '--thread',
            session.nativeId,
            '--message',
            promptWithImages,
            '--resume'
          );
          execFile(bin, queueArgs, { cwd, timeout: 15_000 }, (qErr, _qOut, qStderr) => {
            if (qErr) {
              ctx.emitStream({
                sessionId: session.id,
                runId,
                kind: 'error',
                error: (qStderr || qErr.message || 'Failed to queue message for active Codex thread').slice(
                  0,
                  1000
                ),
              });
            }
            ctx.emitStream({ sessionId: session.id, runId, kind: 'done' });
            ctx.triggerRefresh(250);
            ctx.triggerRefresh(1200);
            ctx.triggerRefresh(3000);
          });
          return;
        }

        if (code && code !== 0) {
          const errText = stderrBuf.trim() || `Codex exited with code ${code}`;
          ctx.emitStream({
            sessionId: session.id,
            runId,
            kind: 'error',
            error: errText.slice(0, 1500),
          });
        }
        ctx.emitStream({ sessionId: session.id, runId, kind: 'done' });
        ctx.triggerRefresh(600);
        ctx.triggerRefresh(2200);
      });

      return {
        ok: true,
        runId,
        dispatchedVia: useDaemon
          ? hasImages
            ? `Codex live daemon (${attachments!.length} image${attachments!.length === 1 ? '' : 's'})`
            : 'Codex live daemon'
          : 'Codex CLI',
      };
    },

    async startSession(
      req: StartSessionRequest,
      ctx: DispatchContext
    ): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
      const bin = await resolveCodexBinary();
      if (!bin) return { ok: false, error: 'codex CLI not found' };
      const cwd = fs.existsSync(req.cwd) ? req.cwd : os.homedir();
      const args = ['exec'];
      if (hasCodexDaemonSocket()) args.push('--remote', 'unix://');
      args.push('--skip-git-repo-check', '--json', '-C', cwd);
      if (req.model) args.push('-m', req.model);
      if (req.reasoningEffort) {
        args.push('-c', `model_reasoning_effort="${req.reasoningEffort}"`);
      }
      args.push(req.prompt || 'Inspect this directory and wait for further instructions.');

      const runId = crypto.randomBytes(6).toString('hex');
      const child = spawn(bin, args, {
        cwd,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      return new Promise((resolve) => {
        let settled = false;
        let sessionId: string | null = null;
        let stdoutBuf = '';
        let stderrBuf = '';
        let gotAnyDelta = false;
        const bufferedLines: string[] = [];

        const finishResolve = (res: { ok: boolean; sessionId?: string; error?: string }) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve(res);
        };

        const timeout = setTimeout(() => {
          finishResolve({
            ok: true,
            sessionId: sessionId ?? undefined,
          });
        }, 8000);

        const handleLine = (line: string) => {
          const trimmed = line.trim();
          if (!trimmed) return;
          if (!sessionId) {
            try {
              const obj = JSON.parse(trimmed) as { type?: string; thread_id?: string };
              if (obj.type === 'thread.started' && typeof obj.thread_id === 'string' && obj.thread_id) {
                sessionId = `codex:${obj.thread_id}`;
                activeRuns.set(sessionId, child);
                ctx.emitStream({ sessionId, runId, kind: 'start' });
                for (const pending of bufferedLines) {
                  if (parseCodexStreamLine(sessionId, runId, pending, ctx.emitStream)) {
                    gotAnyDelta = true;
                  }
                }
                bufferedLines.length = 0;
                ctx.triggerRefresh(400);
                ctx.triggerRefresh(2000);
                finishResolve({ ok: true, sessionId });
                return;
              }
            } catch {
              // Not JSON yet; buffer until thread.started arrives
            }
            bufferedLines.push(trimmed);
            return;
          }
          if (parseCodexStreamLine(sessionId, runId, trimmed, ctx.emitStream)) {
            gotAnyDelta = true;
          }
        };

        child.stdout?.on('data', (chunk: Buffer) => {
          stdoutBuf += chunk.toString('utf8');
          const lines = stdoutBuf.split('\n');
          stdoutBuf = lines.pop() ?? '';
          for (const line of lines) handleLine(line);
        });

        child.stderr?.on('data', (chunk: Buffer) => {
          stderrBuf = (stderrBuf + chunk.toString('utf8')).slice(-4000);
        });

        child.on('error', (err) => {
          if (sessionId) {
            activeRuns.delete(sessionId);
            ctx.emitStream({ sessionId, runId, kind: 'error', error: err.message });
            ctx.emitStream({ sessionId, runId, kind: 'done' });
          }
          finishResolve({ ok: false, error: err.message });
        });

        child.on('close', (code) => {
          if (stdoutBuf.trim()) handleLine(stdoutBuf);
          if (sessionId) {
            activeRuns.delete(sessionId);
            if (code !== 0 && !gotAnyDelta && stderrBuf.trim()) {
              ctx.emitStream({
                sessionId,
                runId,
                kind: 'error',
                error: stderrBuf.trim().slice(-1000),
              });
            }
            ctx.emitStream({ sessionId, runId, kind: 'done' });
            ctx.triggerRefresh(300);
            ctx.triggerRefresh(1500);
            finishResolve({ ok: true, sessionId });
          } else {
            const errMsg =
              stderrBuf.trim() ||
              bufferedLines.join('\n').trim() ||
              `codex exec exited with code ${code ?? 'unknown'}`;
            finishResolve({ ok: false, error: errMsg.slice(0, 500) });
          }
        });
      });
    },

    abort(sessionId: string, emitStream: (ev: StreamEvent) => void): boolean {
      const proc = activeRuns.get(sessionId);
      if (!proc) return false;
      killActiveRun(sessionId);
      emitStream({ sessionId, runId: 'abort', kind: 'done' });
      return true;
    },

    shutdown(): void {
      for (const sid of Array.from(activeRuns.keys())) {
        killActiveRun(sid);
      }
    },

    async controlDaemon(
      action: DaemonControlAction,
      ctx: DispatchContext
    ): Promise<{ ok: boolean; output?: string; error?: string }> {
      const bin = await resolveCodexBinary();
      if (!bin) return { ok: false, error: 'codex CLI not found' };
      if (action === 'start_remote' || action === 'stop_remote') {
        const sub = action === 'start_remote' ? 'start' : 'stop';
        const { stdout, stderr } = await execFileAsync(bin, ['remote-control', sub], {
          timeout: 10000,
        });
        ctx.triggerRefresh(1000);
        return {
          ok: true,
          output: (stdout || stderr).trim() || `Codex remote-control ${sub}ed`,
        };
      }
      return { ok: false, error: `Action '${action}' not supported for codex` };
    },

    async archiveSession(
      session: UnifiedSession
    ): Promise<{ ok: boolean; method?: string; error?: string } | null> {
      const bin = await resolveCodexBinary();
      if (!bin) return null;
      await execFileAsync(bin, ['archive', session.nativeId], { timeout: 8000 });
      return { ok: true, method: 'codex archive' };
    },
  };
}
