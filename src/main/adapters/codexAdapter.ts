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
  QueuedMessageItem,
  SendMessageResult,
  SessionTranscriptResult,
  StartSessionRequest,
  StreamEvent,
  UnifiedBlock,
  UnifiedMessage,
  UnifiedSession,
} from '../../shared/types';
import { CodexAppServerClient } from '../services/codexAppServerClient';
import { querySqliteReadOnly } from '../utils/sqlite';
import {
  CODEX_EFFORTS,
  CODEX_PERMISSION_MODES,
  invalid,
  normalizeCodexPermissionMode,
  normalizeEffort,
  resultsFor,
} from './sessionConfig';
import { readProgressiveJsonlTail } from '../utils/tailReader';
import { computeCodexSessionStats } from '../utils/sessionStats';
import {
  cleanTextPreview,
  getBinaryVersionCached,
  normalizeTimestamp,
  projectNameFromCwd,
  resolveCodexBinary,
  type ProcessRow,
} from '../utils/system';
import {
  createUniqueIdGenerator,
  extractAttachedImagesFromText,
  type DaemonControlAction,
  type DispatchContext,
  type HarnessDriver,
  type HarnessWatchSpec,
} from './types';
import { readJsonFileCached } from '../utils/jsonFileCache';

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
  cachedCodexVersion = await getBinaryVersionCached(binPath);

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
      // 4.8 MB and rarely changes; parsed once per file version (read-only below).
      const gs = readJsonFileCached<Record<string, unknown>>(gsPath);
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
      liveOwner: daemonRunning ? 'daemon' : undefined,
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

function parseCodexImageContentItem(
  obj: Record<string, unknown>
): Extract<UnifiedBlock, { type: 'image' }> | null {
  const t = String(obj.type || '');
  if (
    t !== 'localImage' &&
    t !== 'local_image' &&
    t !== 'image' &&
    t !== 'input_image'
  ) {
    return null;
  }

  const rawPath =
    typeof obj.path === 'string'
      ? obj.path
      : typeof obj.image_path === 'string'
        ? obj.image_path
        : '';
  const rawUrl =
    typeof obj.image_url === 'string'
      ? obj.image_url
      : typeof obj.url === 'string'
        ? obj.url
        : typeof obj.image_url === 'object' && obj.image_url !== null && typeof (obj.image_url as Record<string, unknown>).url === 'string'
          ? String((obj.image_url as Record<string, unknown>).url)
          : '';

  if (rawPath && rawPath.trim()) {
    const clean = rawPath.trim();
    return {
      type: 'image',
      path: clean,
      name: path.basename(clean),
    };
  }
  if (rawUrl && (rawUrl.startsWith('data:image/') || rawUrl.startsWith('http://') || rawUrl.startsWith('https://'))) {
    if (rawUrl.length > 10_000_000) return null;
    return {
      type: 'image',
      path: '',
      dataUrl: rawUrl,
      name: 'Attached image',
    };
  }
  return null;
}

function extractCodexContentBlocks(content: unknown, fallbackText?: string): UnifiedBlock[] {
  const images: Array<Extract<UnifiedBlock, { type: 'image' }>> = [];
  const seenImages = new Set<string>();
  const textParts: string[] = [];

  const pushImage = (img: Extract<UnifiedBlock, { type: 'image' }>) => {
    const key = img.path || img.dataUrl || '';
    if (!key || seenImages.has(key)) return;
    seenImages.add(key);
    images.push(img);
  };

  if (Array.isArray(content)) {
    for (const c of content) {
      if (typeof c === 'string') {
        textParts.push(c);
        continue;
      }
      if (!c || typeof c !== 'object') continue;
      const obj = c as Record<string, unknown>;
      const img = parseCodexImageContentItem(obj);
      if (img) {
        pushImage(img);
        continue;
      }
      if (typeof obj.text === 'string') {
        textParts.push(obj.text);
      }
    }
  } else if (typeof content === 'string') {
    textParts.push(content);
  } else if (typeof fallbackText === 'string') {
    textParts.push(fallbackText);
  }

  const rawJoined = textParts.filter(Boolean).join('\n');
  const extracted = extractAttachedImagesFromText(rawJoined);
  for (const img of extracted.images) {
    pushImage(img);
  }

  // Strip Codex Desktop's redundant "# Files mentioned by the user" image-attachment preamble
  // when matching localImage entries were already extracted into visual thumbnails.
  let cleanText = extracted.text;
  if (images.length > 0 && cleanText.includes('Image attachment: true')) {
    cleanText = cleanText
      .replace(/^# Files mentioned by the user:\s*/gm, '')
      .replace(/^## [^\n]+?:\s*[^\n]+\nImage attachment: true\s*/gm, '')
      .trim();
  }

  const blocks: UnifiedBlock[] = [...images];
  if (cleanText.trim()) {
    blocks.push({ type: 'text', text: cleanText });
  }
  return blocks;
}

function parseCodexItemToBlocks(itemType: string, raw: Record<string, unknown>): {
  role: 'user' | 'assistant' | 'system';
  blocks: UnifiedBlock[];
} {
  if (itemType === 'userMessage') {
    const blocks = extractCodexContentBlocks(
      raw.content,
      typeof raw.text === 'string' ? raw.text : undefined
    );
    return { role: 'user', blocks };
  }

  if (itemType === 'agentMessage') {
    const text = typeof raw.text === 'string' ? raw.text : '';
    if (!text.trim()) return { role: 'assistant', blocks: [] };
    return { role: 'assistant', blocks: [{ type: 'text', text }] };
  }

  if (itemType === 'imageView') {
    const imgPath = typeof raw.path === 'string' ? raw.path.trim() : '';
    if (!imgPath) return { role: 'assistant', blocks: [] };
    return {
      role: 'assistant',
      blocks: [
        {
          type: 'image',
          path: imgPath,
          name: path.basename(imgPath),
        },
      ],
    };
  }

  if (itemType === 'imageGeneration') {
    const savedPath = typeof raw.savedPath === 'string' ? raw.savedPath.trim() : '';
    const result = typeof raw.result === 'string' ? raw.result : '';
    if (savedPath && (fs.existsSync(savedPath) || !result)) {
      return {
        role: 'assistant',
        blocks: [
          {
            type: 'image',
            path: savedPath,
            name: path.basename(savedPath),
          },
        ],
      };
    }
    if (result && result.length <= 10_000_000) {
      return {
        role: 'assistant',
        blocks: [
          {
            type: 'image',
            path: savedPath,
            dataUrl: result.startsWith('data:') ? result : `data:image/png;base64,${result}`,
            name: savedPath ? path.basename(savedPath) : 'Generated image',
          },
        ],
      };
    }
    return { role: 'assistant', blocks: [] };
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
    if (!body.trim()) return { role: 'assistant', blocks: [] };
    return {
      role: 'assistant',
      blocks: [{ type: 'thinking', text: body, summary: summary || undefined }],
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
      blocks: [
        {
          type: 'command',
          command,
          cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
          output,
          exitCode: typeof raw.exitCode === 'number' ? raw.exitCode : null,
          durationMs: typeof raw.durationMs === 'number' ? raw.durationMs : undefined,
          status: typeof raw.status === 'string' ? raw.status : undefined,
        },
      ],
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
    if (changes.length === 0) return { role: 'assistant', blocks: [] };
    return {
      role: 'assistant',
      blocks: [
        {
          type: 'file_change',
          changes,
          status: typeof raw.status === 'string' ? raw.status : undefined,
        },
      ],
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
      blocks: [
        {
          type: 'tool_call',
          name,
          server,
          args,
          output,
          status: typeof raw.status === 'string' ? raw.status : undefined,
          durationMs: typeof raw.durationMs === 'number' ? raw.durationMs : undefined,
        },
      ],
    };
  }

  if (itemType === 'webSearch') {
    const query = typeof raw.query === 'string' ? raw.query : '';
    const action = raw.action as Record<string, unknown> | undefined;
    const url = typeof action?.url === 'string' ? action.url : undefined;
    if (!query && !url) return { role: 'assistant', blocks: [] };
    return {
      role: 'assistant',
      blocks: [{ type: 'web_search', query: query || url || 'Web search', url }],
    };
  }

  if (itemType === 'contextCompaction') {
    return {
      role: 'system',
      blocks: [{ type: 'notice', title: 'Context compacted' }],
    };
  }

  if (itemType === 'subAgentActivity') {
    return {
      role: 'assistant',
      blocks: [
        {
          type: 'notice',
          title: 'Subagent activity',
          detail: JSON.stringify(raw).slice(0, 300),
        },
      ],
    };
  }

  return { role: 'assistant', blocks: [] };
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
    const qStat = await querySqliteReadOnly<{
      cnt: number;
      maxTs: number | null;
      maxUpdated: number | null;
    }>(
      dbs.queueDb,
      'SELECT COUNT(*) as cnt, MAX(created_at_ms) as maxTs, MAX(updated_at_ms) as maxUpdated FROM queued_items WHERE thread_id = ?',
      [nativeId]
    );
    if (qStat[0]) {
      queuePart = `${Number(qStat[0].cnt ?? 0)}:${Number(qStat[0].maxTs ?? 0)}:${Number(qStat[0].maxUpdated ?? 0)}`;
    }
  }

  return `codex:${itemsPart}|${rolloutPart}|${queuePart}`;
}

export function coalesceCodexItemRows(rowsAsc: CodexItemRow[]): UnifiedMessage[] {
  const messages: UnifiedMessage[] = [];
  const uniqueId = createUniqueIdGenerator();

  let currentAssistant: UnifiedMessage | null = null;
  let lastUserImagePaths = new Set<string>();
  for (const r of rowsAsc) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(r.item_json) as Record<string, unknown>;
    } catch {
      continue;
    }
    const { role, blocks } = parseCodexItemToBlocks(r.item_type, parsed);
    if (blocks.length === 0) continue;
    const ts = normalizeTimestamp(r.created_at_ms);

    if (role === 'user') {
      currentAssistant = null;
      lastUserImagePaths = new Set(
        blocks
          .filter((b): b is Extract<UnifiedBlock, { type: 'image' }> => b.type === 'image' && Boolean(b.path))
          .map((b) => b.path)
      );
      messages.push({
        id: uniqueId(r.item_id || `u-${r.rollout_ordinal}`),
        role: 'user',
        timestamp: ts,
        blocks,
        harnessMeta: { turnId: r.turn_id },
      });
    } else if (role === 'system') {
      currentAssistant = null;
      messages.push({
        id: uniqueId(r.item_id || `s-${r.rollout_ordinal}`),
        role: 'system',
        timestamp: ts,
        blocks,
      });
    } else {
      // Avoid duplicating the user's own attached image when Codex immediately calls imageView on it
      const filteredBlocks =
        r.item_type === 'imageView'
          ? blocks.filter(
              (b) => !(b.type === 'image' && b.path && lastUserImagePaths.has(b.path))
            )
          : blocks;
      if (filteredBlocks.length === 0) continue;

      if (!currentAssistant || currentAssistant.harnessMeta?.turnId !== r.turn_id) {
        currentAssistant = {
          id: uniqueId(r.item_id || `a-${r.rollout_ordinal}`),
          role: 'assistant',
          timestamp: ts,
          blocks: [...filteredBlocks],
          harnessMeta: { turnId: r.turn_id },
        };
        messages.push(currentAssistant);
      } else {
        currentAssistant.blocks.push(...filteredBlocks);
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
        const blocks = extractCodexContentBlocks(pl.content);
        if (blocks.length === 0) continue;
        if (pl.role === 'user') {
          currentAssistant = null;
          messages.push({
            id: `jsonl-u-${idx++}`,
            role: 'user',
            timestamp: ts,
            blocks,
          });
        } else {
          if (!currentAssistant) {
            currentAssistant = {
              id: `jsonl-a-${idx++}`,
              role: 'assistant',
              timestamp: ts,
              blocks: [...blocks],
            };
            messages.push(currentAssistant);
          } else {
            currentAssistant.blocks.push(...blocks);
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

export function parseCodexQueuedPayload(payloadJson: string): {
  text: string;
  attachments?: ImageAttachment[];
} {
  const texts: string[] = [];
  const attachments: ImageAttachment[] = [];

  const collectParts = (items: unknown[]) => {
    for (const raw of items) {
      if (!raw || typeof raw !== 'object') continue;
      const item = raw as Record<string, unknown>;
      const t = String(item.type || '');
      if (typeof item.text === 'string' && item.text.trim()) {
        texts.push(item.text.trim());
      } else if (
        t === 'local_image' ||
        t === 'image' ||
        t === 'input_image'
      ) {
        const imgPath =
          typeof item.path === 'string'
            ? item.path
            : typeof item.image_path === 'string'
              ? item.image_path
              : '';
        if (imgPath && path.isAbsolute(imgPath)) {
          attachments.push({
            id: `codex-q-att-${attachments.length + 1}`,
            name: path.basename(imgPath),
            path: imgPath,
            mimeType: typeof item.mime_type === 'string' ? item.mime_type : 'image/png',
          });
        }
      }
    }
  };

  try {
    const p = JSON.parse(payloadJson) as Record<string, unknown>;
    const userInput = (p.UserInput ?? p.user_input) as Record<string, unknown> | undefined;
    if (userInput && typeof userInput === 'object') {
      if (Array.isArray(userInput.content)) {
        collectParts(userInput.content);
      } else if (typeof userInput.text === 'string') {
        texts.push(userInput.text.trim());
      }
    } else if (typeof p.text === 'string') {
      texts.push(p.text.trim());
    } else if (typeof p.prompt === 'string') {
      texts.push(p.prompt.trim());
    } else if (typeof p.message === 'string') {
      texts.push(p.message.trim());
    } else if (Array.isArray(p.input)) {
      collectParts(p.input);
    } else if (Array.isArray(p.content)) {
      collectParts(p.content);
    } else {
      texts.push(payloadJson.slice(0, 300).trim());
    }
  } catch {
    texts.push(payloadJson.slice(0, 300).trim());
  }

  return {
    text: texts.filter(Boolean).join('\n').trim(),
    attachments: attachments.length > 0 ? attachments : undefined,
  };
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
    const queueMtime = fs.existsSync(dbs.queueDb) ? fs.statSync(dbs.queueDb).mtimeMs : 0;
    const queueWalPath = `${dbs.queueDb}-wal`;
    const queueWalMtime = fs.existsSync(queueWalPath) ? fs.statSync(queueWalPath).mtimeMs : 0;
    const rolloutMtime =
      rolloutPath && fs.existsSync(rolloutPath) ? fs.statSync(rolloutPath).mtimeMs : 0;
    sourceMtimeMs = Math.max(dbMtime, walMtime, queueMtime, queueWalMtime, rolloutMtime) || Date.now();
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
        const parsed = parseCodexQueuedPayload(qr.payload_json);
        if (parsed.text || (parsed.attachments && parsed.attachments.length > 0)) {
          nativeQueued.push({
            id: `codex-q-${qr.id}`,
            text: parsed.text,
            attachments: parsed.attachments,
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
  let stats = undefined;
  if (rolloutPath && fs.existsSync(rolloutPath)) {
    try {
      const st = fs.statSync(rolloutPath);
      const readBytes = Math.min(st.size, 262_144);
      if (readBytes > 0) {
        const fd = fs.openSync(rolloutPath, 'r');
        try {
          const buf = Buffer.allocUnsafe(readBytes);
          const n = fs.readSync(fd, buf, 0, readBytes, Math.max(0, st.size - readBytes));
          stats = computeCodexSessionStats(buf.subarray(0, n).toString('utf8').split('\n'));
        } finally {
          fs.closeSync(fd);
        }
      }
    } catch {
      // ignore rollout stats read errors
    }
  }

  return {
    sessionId,
    messages: sliced,
    totalCount,
    hasMore: truncated || messages.length > limit,
    sourceMtimeMs,
    liveActivity,
    stats,
  };
}

export async function loadCodexTranscript(
  nativeId: string,
  rolloutPath: string | undefined,
  limit = 120
): Promise<SessionTranscriptResult> {
  return loadCodexTranscriptFromPaths(nativeId, rolloutPath, limit);
}

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
  let activitySink: ((sessionId: string) => void) | null = null;
  const activityCounters = new Map<string, number>();
  const appServer = new CodexAppServerClient(
    undefined,
    (itemType, raw) => parseCodexItemToBlocks(itemType, raw),
    (threadId) => {
      activityCounters.set(threadId, (activityCounters.get(threadId) ?? 0) + 1);
      activitySink?.(`codex:${threadId}`);
    }
  );

  /**
   * Makes sure the managed app-server daemon is listening, starting it when it is not. A
   * socket file left behind by a daemon that died counts as not running: `daemon start`
   * replaces it.
   */
  const ensureDaemon = async (): Promise<boolean> => {
    if (await appServer.isSocketAlive()) return true;
    const bin = await resolveCodexBinary();
    if (!bin) return false;
    try {
      await execFileAsync(bin, ['app-server', 'daemon', 'start'], { timeout: 15_000 });
    } catch {
      // fall through to socket check
    }
    for (let i = 0; i < 20; i++) {
      if (await appServer.isSocketAlive()) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return appServer.isSocketAlive();
  };

  return {
    async applySessionConfig(session, change) {
      const next =
        'Applies to the next turn Superharness starts in this thread; turns started from the Codex app keep the app\'s own settings.';
      return resultsFor(change, (field, requested) => {
        if (!requested.trim()) return { status: 'next_message', value: '', detail: 'Override cleared. ' + next };
        if (field === 'model') return { status: 'next_message', value: requested.trim(), detail: next };
        if (field === 'reasoningEffort') {
          const v = normalizeEffort(requested, CODEX_EFFORTS);
          return v ? { status: 'next_message', value: v, detail: next } : invalid(CODEX_EFFORTS);
        }
        const mode = normalizeCodexPermissionMode(requested);
        if (!mode) return invalid(CODEX_PERMISSION_MODES);
        return {
          status: 'next_message',
          value: mode === 'default' ? '' : mode,
          detail:
            (mode === 'default' ? 'Back to your Codex config. ' : '') +
            next +
            ' Superharness auto-accepts Codex approvals, so escalation is off and the sandbox is the boundary.',
        };
      });
    },

    id: 'codex',
    displayName: 'OpenAI Codex',

    detect(processes, maxSessions, showArchived) {
      return detectCodex(processes, maxSessions, showArchived);
    },

    async getTranscriptFingerprint(session) {
      const base = await getCodexTranscriptFingerprint(session.nativeId, session.transcriptPath);
      // Daemon push notifications advance the fingerprint even when the
      // SQLite projection has not caught up yet.
      return `${base}|a:${activityCounters.get(session.nativeId) ?? 0}`;
    },

    async loadTranscript(session, limit) {
      // Native mirror first: thread/items/list on the shared app-server
      // daemon (the API Codex Desktop renders). SQLite/rollout below stays
      // only as the offline cold fallback when no daemon can answer.
      if (appServer.isSocketAvailable()) {
        try {
          // Read without resuming first: items/list is store-backed on the
          // daemon, while resume would load (and potentially claim) a
          // thread another client owns. Subscribe afterwards, best-effort.
          const pageLimit = Math.min(2000, Math.max(400, limit * 16));
          const rowsDesc: CodexItemRow[] = [];
          let cursor: string | null = null;
          let ordinal = 0;
          for (let page = 0; page < 4; page++) {
            const res = await appServer.listItemsPage(session.nativeId, pageLimit, cursor);
            for (const entry of res.data) {
              const item = (entry.item ?? {}) as Record<string, unknown>;
              rowsDesc.push({
                turn_id: typeof entry.turnId === 'string' ? entry.turnId : '',
                item_id: typeof item.id === 'string' ? item.id : `rpc-${ordinal}`,
                item_type: typeof item.type === 'string' ? item.type : '',
                item_json: JSON.stringify(item),
                created_at_ms:
                  typeof entry.startedAtMs === 'number' ? entry.startedAtMs : null,
                rollout_ordinal: ordinal++,
              });
            }
            cursor = res.nextCursor;
            if (!cursor) break;
          }
          if (rowsDesc.length > 0) {
            void appServer.resumeThread(session.nativeId).catch(() => {});
            const messagesAll = coalesceCodexItemRows(rowsDesc.reverse());
            let queuedMessages: QueuedMessageItem[] | undefined;
            try {
              const q = await appServer.queueList(session.nativeId);
              if (q.length > 0) queuedMessages = q;
            } catch {
              // queue stays undefined; transcript is unaffected
            }
            let isWorking = appServer.hasActiveTurn(session.nativeId);
            if (!isWorking) {
              try {
                const turns = await appServer.listTurns(session.nativeId, 3);
                isWorking = turns.some(
                  (t) => String(t.status || '').toLowerCase() === 'inprogress'
                );
              } catch {
                // keep own-turn signal
              }
            }
            const sliced =
              messagesAll.length > limit
                ? messagesAll.slice(messagesAll.length - limit)
                : messagesAll;
            return {
              sessionId: session.id,
              messages: sliced,
              totalCount: messagesAll.length,
              hasMore: messagesAll.length > limit || cursor !== null,
              sourceMtimeMs: Date.now(),
              liveActivity: {
                isWorking,
                focus: isWorking ? 'Codex turn in progress' : undefined,
                queuedMessages,
                lastEventAt: Date.now(),
              },
            };
          }
        } catch {
          // Daemon refused (e.g. Desktop-private thread unknown to it):
          // cold store fallback below.
        }
      }
      return loadCodexTranscript(session.nativeId, session.transcriptPath, limit);
    },

    getGlobalWatchDirs(): HarnessWatchSpec[] {
      const specs: HarnessWatchSpec[] = [
        {
          dir: CODEX_DIR,
          filter: (fn) =>
            fn.startsWith('state_5.sqlite') ||
            fn.startsWith('thread_history_1.sqlite') ||
            fn.startsWith('queue_1.sqlite'),
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
      ctx: DispatchContext,
      opts?: { force?: boolean }
    ): Promise<SendMessageResult> {
      const cwd = fs.existsSync(session.cwd) ? session.cwd : os.homedir();
      const runId = crypto.randomBytes(6).toString('hex');
      const hasImages = Boolean(attachments && attachments.length > 0);

      // Sole transport: Codex's shared app-server daemon — the exact
      // JSON-RPC API Codex Desktop uses. There is deliberately no
      // `codex exec`/queue-CLI fallback: switching APIs on failure would
      // deliver through a different surface than the native UI.
      if (!(await ensureDaemon())) {
        return {
          ok: false,
          error:
            'Your message was not delivered: the Codex app-server daemon is not running and could not be started. Open Codex Desktop or run `codex app-server daemon start`, then press Retry.',
        };
      }

      if (opts?.force) {
        const steered = await appServer.steerTurn(session.nativeId, prompt, attachments);
        if (steered) {
          ctx.triggerRefresh(300);
          return { ok: true, runId, dispatchedVia: 'Codex live steer' };
        }
        // A steer never stops the running turn: when Codex can't take it live, it goes into
        // Codex's own queue and runs after the turn.
        if (appServer.hasActiveTurn?.(session.nativeId)) {
          try {
            await appServer.queueAdd(session.nativeId, prompt, attachments);
            ctx.triggerRefresh(150);
            return { ok: true, runId, dispatchedVia: 'Codex queue (turn still running)' };
          } catch {
            return { ok: false, holdUntilIdle: true, error: 'Codex is mid-turn; holding the message until it ends.' };
          }
        }
      }

      try {
        await appServer.sendTurn({
          shSessionId: session.id,
          nativeThreadId: session.nativeId,
          cwd,
          prompt,
          attachments,
          model: session.model,
          reasoningEffort: session.reasoningEffort,
          permissionMode: session.permissionMode,
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
          dispatchedVia: hasImages
            ? `Codex app-server (${attachments!.length} image${attachments!.length === 1 ? '' : 's'})`
            : 'Codex app-server',
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isCodexActiveWriterError(msg)) {
          // Another Codex client (e.g. Codex Desktop's private app-server)
          // owns the active turn. Deliver natively through the thread queue
          // so that owner runs it next — same queue Desktop renders.
          try {
            await appServer.queueAdd(session.nativeId, prompt, attachments);
            ctx.emitStream({ sessionId: session.id, runId, kind: 'done' });
            ctx.triggerRefresh(200);
            ctx.triggerRefresh(1000);
            return { ok: true, runId, dispatchedVia: 'Codex queue (app-server)' };
          } catch {
            return {
              ok: false,
              error:
                'Your message was not delivered: another Codex client (for example Codex Desktop) is running this thread and the shared daemon could not queue for it. Send it from that Codex window, or wait for its turn to finish and press Retry.',
            };
          }
        }
        return { ok: false, error: msg.slice(0, 1000) };
      }
    },

    async queueMessage(
      session: UnifiedSession,
      prompt: string,
      attachments: ImageAttachment[] | undefined,
      ctx: DispatchContext
    ): Promise<SendMessageResult | null> {
      if (!(await ensureDaemon())) {
        return {
          ok: false,
          error:
            'Your message was not queued: the Codex app-server daemon is not running and could not be started. Open Codex Desktop or run `codex app-server daemon start`, then press Retry.',
        };
      }
      try {
        await appServer.queueAdd(session.nativeId, prompt, attachments);
        ctx.triggerRefresh(150);
        ctx.triggerRefresh(800);
        return { ok: true, dispatchedVia: 'Codex queue (app-server)' };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { ok: false, error: msg.slice(0, 1000) };
      }
    },

    async startSession(
      req: StartSessionRequest,
      ctx: DispatchContext
    ): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
      const cwd = fs.existsSync(req.cwd) ? req.cwd : os.homedir();
      // Threads are born on the shared daemon so Codex Desktop sees the new
      // conversation immediately — never on a private CLI app-server.
      if (!(await ensureDaemon())) {
        return {
          ok: false,
          error:
            'Could not start the Codex session: the Codex app-server daemon is not running and could not be started. Open Codex Desktop or run `codex app-server daemon start`, then try again.',
        };
      }
      try {
        const threadId = await appServer.startThread({
          cwd,
          model: req.model,
          reasoningEffort: req.reasoningEffort,
        });
        const shId = `codex:${threadId}`;
        const prompt = req.prompt?.trim();
        if (prompt) {
          const runId = crypto.randomBytes(6).toString('hex');
          await appServer.sendTurn({
            shSessionId: shId,
            nativeThreadId: threadId,
            cwd,
            prompt,
            model: req.model,
            reasoningEffort: req.reasoningEffort,
            runId,
            onEvent: ctx.emitStream,
            onComplete: () => {
              ctx.triggerRefresh(400);
              ctx.triggerRefresh(1600);
            },
          });
        }
        ctx.triggerRefresh(400);
        ctx.triggerRefresh(1800);
        return { ok: true, sessionId: shId };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message.slice(0, 1000) : 'Codex thread/start failed',
        };
      }
    },

    abort(sessionId: string, emitStream: (ev: StreamEvent) => void): boolean {
      if (!sessionId.startsWith('codex:')) return false;
      if (!appServer.isSocketAvailable()) return false;
      const nativeId = sessionId.slice('codex:'.length);
      // Native interrupt for any turn (own or Desktop/TUI-started); the
      // client discovers the active turn from notifications/turns/list.
      void appServer.interruptTurn(nativeId);
      emitStream({ sessionId, runId: 'abort', kind: 'done' });
      return true;
    },

    async moveSection(session: UnifiedSession, sectionName: string | null): Promise<boolean> {
      if (!appServer.isSocketAvailable()) return false;
      return appServer.moveThreadToSectionByName(session.nativeId, sectionName);
    },

    shutdown(): void {
      appServer.close();
    },

    async restartHosts(): Promise<string[]> {
      // `codex app-server daemon update` restarts the daemon itself; drop the old socket so the
      // next request connects to the new one.
      appServer.close();
      return [];
    },

    setActivitySink(sink: ((sessionId: string) => void) | null): void {
      activitySink = sink;
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
      if (appServer.isSocketAvailable()) {
        const ok = await appServer.archiveThread(session.nativeId);
        if (ok) return { ok: true, method: 'Codex app-server archive' };
      }
      // No daemon: fall back to Superharness local hide (dispatcher).
      return null;
    },
  };
}
