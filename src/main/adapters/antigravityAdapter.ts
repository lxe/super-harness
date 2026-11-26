import { execFile } from 'node:child_process';
import { resultsFor } from './sessionConfig';
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
  QueuedMessageItem,
  RunningTaskItem,
  SendMessageResult,
  SessionTranscriptResult,
  StartSessionRequest,
  StreamEvent,
  UnifiedBlock,
  UnifiedMessage,
  UnifiedSession,
} from '../../shared/types';
import { AgyAcpPool } from '../services/agyAcpClient';
import { AntigravityLsClient } from '../services/antigravityLsClient';
import { RemoteAntigravityMirror } from './remoteAntigravity';
import { querySqliteReadOnly } from '../utils/sqlite';
import { readProgressiveJsonlTail } from '../utils/tailReader';
import {
  cleanTextPreview,
  getBinaryVersion,
  normalizeTimestamp,
  projectNameFromCwd,
  whichBinary,
  type ProcessRow,
} from '../utils/system';
import {
  computeFileFingerprint,
  createUniqueIdGenerator,
  type DaemonControlAction,
  type DispatchContext,
  type HarnessDriver,
  type HarnessWatchSpec,
} from './types';

const execFileAsync = promisify(execFile);

const AGY_APP_DIR = path.join(os.homedir(), '.gemini', 'antigravity');
const AGY_CLI_DIR = path.join(os.homedir(), '.gemini', 'antigravity-cli');

let cachedAgyVersion: string | null | undefined;
let cachedRemoteStatus: { checkedAt: number; running: boolean } | null = null;
const REMOTE_STATUS_TTL_MS = 30_000;
const headerInfoCache = new Map<
  string,
  { mtimeMs: number; info: { title?: string; preview?: string; isSubagent: boolean } }
>();
const terminalTailCache = new Map<string, { mtimeMs: number; isTerminal: boolean }>();

/**
 * Returns true when the last recorded step in an Antigravity `transcript.jsonl` is a
 * completed text-only `PLANNER_RESPONSE` (no pending tool calls) and the file has been
 * quiet for >4s. Guards against Antigravity Desktop's `conversation_summaries.db` and
 * hub LS occasionally staying stuck at `CASCADE_RUN_STATUS_RUNNING` (`not_fully_idle=1`)
 * long after a turn has finished.
 */
export function isAntigravityTranscriptTerminal(
  trPath: string | undefined,
  mtimeMs: number,
  nowMs: number = Date.now()
): boolean {
  if (!trPath || nowMs - mtimeMs <= 4_000) return false;
  const cached = terminalTailCache.get(trPath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.isTerminal;
  let isTerminal = false;
  try {
    const st = fs.statSync(trPath);
    const readBytes = Math.min(st.size, 32_768);
    if (readBytes > 0) {
      const fd = fs.openSync(trPath, 'r');
      let tail = '';
      try {
        const buf = Buffer.allocUnsafe(readBytes);
        const n = fs.readSync(fd, buf, 0, readBytes, Math.max(0, st.size - readBytes));
        tail = buf.subarray(0, n).toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
      const lines = tail.split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const trimmed = lines[i].trim();
        if (!trimmed) continue;
        try {
          const obj = JSON.parse(trimmed) as Record<string, unknown>;
          const stepType = typeof obj.type === 'string' ? obj.type : '';
          const status = typeof obj.status === 'string' ? obj.status : '';
          if (!stepType && !status) continue;
          const toolCalls = Array.isArray(obj.tool_calls) ? obj.tool_calls : [];
          isTerminal =
            stepType === 'PLANNER_RESPONSE' &&
            status === 'DONE' &&
            toolCalls.length === 0;
          break;
        } catch {
          continue;
        }
      }
    }
  } catch {
    isTerminal = false;
  }
  terminalTailCache.set(trPath, { mtimeMs, isTerminal });
  return isTerminal;
}

export function invalidateAgyRemoteStatusCache(): void {
  cachedRemoteStatus = null;
}

interface AgySummaryRow {
  conversation_id: string;
  title: string | null;
  preview: string | null;
  last_modified_time: string | null;
  workspace_uris: string | null;
  status: string | null;
  parent_conversation_id: string | null;
  nesting_depth: number | null;
  killed: number | null;
  app_data_dir: string | null;
}

function stripUserRequestTags(raw: string): string {
  const match = raw.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
  if (match) return match[1].trim();
  return raw
    .replace(/<USER_REQUEST>|<\/USER_REQUEST>/g, '')
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, '')
    .trim();
}

function extractCwdFromWorkspaceUris(raw: string | null): string {
  if (!raw) return os.homedir();
  try {
    const arr = JSON.parse(raw) as unknown;
    if (Array.isArray(arr) && typeof arr[0] === 'string') {
      return arr[0].replace(/^file:\/\//, '');
    }
  } catch {
    // ignore
  }
  return os.homedir();
}

function readTranscriptHeaderInfo(
  trPath: string,
  mtimeMs?: number
): {
  title?: string;
  preview?: string;
  isSubagent: boolean;
} {
  if (mtimeMs !== undefined) {
    const cached = headerInfoCache.get(trPath);
    if (cached && cached.mtimeMs === mtimeMs) return cached.info;
  }
  try {
    const fd = fs.openSync(trPath, 'r');
    const buf = Buffer.alloc(49152);
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const chunk = buf.subarray(0, bytesRead).toString('utf8');
    let isSubagent = false;
    let firstChecked = false;
    let result: { title?: string; preview?: string; isSubagent: boolean } = { isSubagent: false };
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        if (!firstChecked) {
          firstChecked = true;
          if (obj.source && obj.source !== 'USER_EXPLICIT') {
            isSubagent = true;
          }
        }
        if (obj.type === 'USER_INPUT' && typeof obj.content === 'string') {
          const cleaned = stripUserRequestTags(obj.content);
          if (cleaned) {
            result = {
              title: cleanTextPreview(cleaned, 90),
              preview: cleanTextPreview(cleaned, 140),
              isSubagent,
            };
            break;
          }
        }
      } catch {
        // ignore
      }
    }
    if (!result.title) result = { isSubagent };
    if (mtimeMs !== undefined) {
      headerInfoCache.set(trPath, { mtimeMs, info: result });
    }
    return result;
  } catch {
    return { isSubagent: false };
  }
}

export async function detectAntigravity(
  processes: ProcessRow[],
  maxSessions: number
): Promise<{ detection: HarnessDetection; sessions: UnifiedSession[] }> {
  const binPath = await whichBinary('agy');
  if (cachedAgyVersion === undefined) {
    cachedAgyVersion = await getBinaryVersion(binPath);
  }

  const agyProcs = processes.filter(
    (p) =>
      p.comm === 'agy' ||
      p.args.toLowerCase().includes('antigravity') ||
      p.args.includes('/agy')
  );
  const desktopRunning = agyProcs.some(
    (p) =>
      p.args.toLowerCase().includes('antigravity') &&
      (p.args.includes('--type=') || p.args.includes('electron') || p.args.includes('app'))
  );

  let daemonRunning = false;
  if (binPath) {
    const now = Date.now();
    if (cachedRemoteStatus && now - cachedRemoteStatus.checkedAt < REMOTE_STATUS_TTL_MS) {
      daemonRunning = cachedRemoteStatus.running;
    } else {
      try {
        const { stdout } = await execFileAsync(binPath, ['remote-control', 'status'], {
          timeout: 2000,
        });
        daemonRunning = /active/i.test(stdout) && !/inactive/i.test(stdout);
      } catch {
        daemonRunning = false;
      }
      cachedRemoteStatus = { checkedAt: now, running: daemonRunning };
    }
  }

  // Load summary metadata (real titles, workspaces, status, parent_conversation_id) from both App & CLI DBs
  const summaryMap = new Map<string, AgySummaryRow>();
  for (const baseDir of [AGY_APP_DIR, AGY_CLI_DIR]) {
    const dbPath = path.join(baseDir, 'conversation_summaries.db');
    const rows = await querySqliteReadOnly<AgySummaryRow>(
      dbPath,
      `SELECT conversation_id, title, preview, last_modified_time, workspace_uris,
              status, parent_conversation_id, nesting_depth, killed, app_data_dir
       FROM conversation_summaries`
    );
    for (const r of rows) {
      if (r.conversation_id) summaryMap.set(r.conversation_id, r);
    }
  }

  const discovered: Array<{
    id: string;
    transcriptPath: string;
    mtime: number;
    ctime: number;
    originApp: 'antigravity-app' | 'antigravity-cli';
  }> = [];
  const seenIds = new Set<string>();

  const sources: Array<[string, 'antigravity-app' | 'antigravity-cli']> = [
    [AGY_APP_DIR, 'antigravity-app'],
    [AGY_CLI_DIR, 'antigravity-cli'],
  ];
  for (const [baseDir, originApp] of sources) {
    const brainDir = path.join(baseDir, 'brain');
    if (!fs.existsSync(brainDir)) continue;
    try {
      for (const entry of fs.readdirSync(brainDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || seenIds.has(entry.name)) continue;
        const tr = path.join(
          brainDir,
          entry.name,
          '.system_generated',
          'logs',
          'transcript.jsonl'
        );
        if (!fs.existsSync(tr)) continue;
        try {
          const st = fs.statSync(tr);
          seenIds.add(entry.name);
          discovered.push({
            id: entry.name,
            transcriptPath: tr,
            mtime: st.mtimeMs,
            ctime: st.birthtimeMs || st.ctimeMs,
            originApp,
          });
        } catch {
          // ignore
        }
      }
    } catch {
      // ignore
    }
  }

  discovered.sort((a, b) => b.mtime - a.mtime);

  const sessions: UnifiedSession[] = [];
  for (const d of discovered.slice(0, maxSessions)) {
    const summary = summaryMap.get(d.id);
    const header = readTranscriptHeaderInfo(d.transcriptPath, d.mtime);
    const isSubagent =
      header.isSubagent ||
      Boolean(summary?.parent_conversation_id) ||
      Number(summary?.nesting_depth ?? 0) > 0;
    const parentSessionId = summary?.parent_conversation_id
      ? `antigravity:${summary.parent_conversation_id}`
      : undefined;

    const cwd = extractCwdFromWorkspaceUris(summary?.workspace_uris ?? null);
    const title =
      cleanTextPreview(summary?.title || header.title || summary?.preview, 90) ||
      `Antigravity ${d.id.slice(0, 8)}`;
    const preview =
      cleanTextPreview(summary?.preview || header.preview, 140) || 'Antigravity conversation';
    const terminalReply = isAntigravityTranscriptTerminal(d.transcriptPath, d.mtime);
    const isRunning =
      !terminalReply &&
      (summary?.status === 'CASCADE_RUN_STATUS_RUNNING' ||
        (summary?.status !== 'CASCADE_RUN_STATUS_IDLE' && Date.now() - d.mtime < 20_000));
    const isLive = Boolean(isRunning) || Date.now() - d.mtime < 10 * 60 * 1000;

    const hasWorkspaceProject = cwd !== os.homedir();
    const projName = hasWorkspaceProject ? projectNameFromCwd(cwd) : 'Antigravity';
    const isCliProj = d.originApp === 'antigravity-cli';
    const nativeSection = isCliProj
      ? 'CLI Project'
      : hasWorkspaceProject
        ? projName
        : 'Ungrouped';
    const nativeSectionOrder = hasWorkspaceProject ? 10 : isCliProj ? 20 : 9999;

    sessions.push({
      id: `antigravity:${d.id}`,
      nativeId: d.id,
      harness: 'antigravity',
      harnessGroup: 'antigravity',
      title,
      preview,
      cwd,
      projectName: projName,
      nativeSection,
      nativeSectionOrder,
      status: summary?.killed ? 'archived' : isRunning ? 'running' : 'idle',
      isLive,
      isRemote: daemonRunning,
      transcriptPath: d.transcriptPath,
      createdAt: d.ctime,
      updatedAt: Math.max(d.mtime, normalizeTimestamp(summary?.last_modified_time ?? 0)),
      pinned: false,
      folderId: null,
      tags: isSubagent ? ['subagent'] : [d.originApp === 'antigravity-cli' ? 'cli' : 'desktop'],
      hidden: false,
      dispatchMode: 'agy-resume',
      liveOwner:
        isRunning && d.originApp === 'antigravity-app' && desktopRunning
          ? 'desktop'
          : undefined,
      isSubagent,
      parentSessionId,
      originApp: d.originApp,
    });
  }

  // Count child subagents per parent
  const subCountByParent = new Map<string, number>();
  for (const s of sessions) {
    if (s.isSubagent && s.parentSessionId) {
      subCountByParent.set(
        s.parentSessionId,
        (subCountByParent.get(s.parentSessionId) ?? 0) + 1
      );
    }
  }
  for (const s of sessions) {
    const cnt = subCountByParent.get(s.id);
    if (cnt) s.subagentCount = cnt;
  }

  const topLevelSessions = sessions.filter((s) => !s.isSubagent);
  const detection: HarnessDetection = {
    id: 'antigravity',
    name: 'Google Antigravity',
    installed: Boolean(binPath) || fs.existsSync(AGY_APP_DIR),
    binaryPath: binPath,
    version: cachedAgyVersion,
    runningProcesses: agyProcs.length,
    desktopAppRunning: desktopRunning,
    daemonRunning,
    remoteControlEnabled: daemonRunning,
    activeSessionCount: topLevelSessions.filter((s) => s.isLive).length,
    totalSessionCount: topLevelSessions.length,
    capabilities: {
      canStartNew: Boolean(binPath),
      canResume: Boolean(binPath),
      canTmuxMirror: false,
      canControlDaemon: Boolean(binPath),
    },
    notes: `${topLevelSessions.length} conversations (${sessions.length - topLevelSessions.length} subagents nested)`,
  };

  return { detection, sessions };
}

export function resolveAntigravityTranscriptPath(
  nativeId: string,
  transcriptPath?: string
): string | undefined {
  const candidates = [
    transcriptPath,
    path.join(AGY_APP_DIR, 'brain', nativeId, '.system_generated', 'logs', 'transcript.jsonl'),
    path.join(AGY_CLI_DIR, 'brain', nativeId, '.system_generated', 'logs', 'transcript.jsonl'),
  ].filter(Boolean) as string[];
  return candidates.find((c) => fs.existsSync(c));
}

export function parseAntigravityJsonlLines(
  lines: string[],
  sessionId: string,
  sourceMtimeMs: number,
  limit = 120,
  meta?: { truncated?: boolean; fileSize?: number; bytesRead?: number }
): SessionTranscriptResult {
  const messages: UnifiedMessage[] = [];
  const uniqueId = createUniqueIdGenerator();
  let currentAssistant: UnifiedMessage | null = null;
  let seq = 0;

  let latestFocus: string | undefined;
  let latestSteps: LiveStepItem[] | undefined;
  let lastStepType = '';
  let lastPlannerHadToolCalls = false;
  let lastEventAt = sourceMtimeMs;
  const pendingOutputBlocks: Array<Extract<UnifiedBlock, { type: 'command' | 'tool_call' }>> = [];
  let pendingQuestionBlock: Extract<UnifiedBlock, { type: 'question' }> | null = null;
  const runningTasks = new Map<string, RunningTaskItem>();
  let pendingBgCmdMeta: Array<{ summary: string; command?: string; isDaemon: boolean }> = [];

  const applyAntigravityQuestionAnswers = (
    qBlock: Extract<UnifiedBlock, { type: 'question' }>,
    cleanedText: string
  ) => {
    const answerLines = cleanedText.split('\n');
    let matchedIndexed = false;
    for (const ln of answerLines) {
      const m = ln.match(/^A(\d+):\s*(.+)$/);
      if (m) {
        const idx = Number(m[1]) - 1;
        if (idx >= 0 && idx < qBlock.questions.length) {
          qBlock.questions[idx].answer = m[2].trim();
          matchedIndexed = true;
        }
      }
    }
    if (!matchedIndexed && cleanedText && qBlock.questions.length === 1) {
      qBlock.questions[0].answer = cleanedText;
    }
    qBlock.answered = true;
  };

  const parseMaybeJson = (val: unknown): unknown => {
    if (typeof val === 'string') {
      try {
        return JSON.parse(val);
      } catch {
        return val;
      }
    }
    return val;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    // Fast pre-filter before JSON.parse for non-rendered step types (always parse tail lines for lastStepType)
    if (
      i < lines.length - 5 &&
      !line.includes('USER_INPUT') &&
      !line.includes('PLANNER_RESPONSE') &&
      !line.includes('GENERIC') &&
      !line.includes('SYSTEM_MESSAGE') &&
      !line.includes('CHECKPOINT')
    ) {
      continue;
    }
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }

    const stepType = String(obj.type || '');
    const ts = normalizeTimestamp(obj.created_at);
    lastStepType = stepType;
    lastEventAt = ts;

    // Antigravity CHECKPOINT entries contain an exact snapshot of currently running background tasks.
    // Resetting the active task map here avoids ghost tasks from pre-compaction turns.
    if (stepType === 'CHECKPOINT' && typeof obj.content === 'string') {
      runningTasks.clear();
      const idx = obj.content.indexOf('# Running Background Tasks');
      if (idx >= 0) {
        const section = obj.content.slice(idx);
        const re =
          /"taskId":\s*"([^"]+)"[\s\S]*?"toolSummary":\s*"([^"]*)"[\s\S]*?"description":\s*"([^"]*)"[\s\S]*?"logUri":\s*"file:\/\/([^"]*)"[\s\S]*?"isDaemon":\s*(true|false)/g;
        for (const m of section.matchAll(re)) {
          runningTasks.set(m[1], {
            id: m[1],
            summary: m[2] || m[1].split('/').pop() || 'Background task',
            command: m[3] || undefined,
            logPath: m[4] || undefined,
            isDaemon: m[5] === 'true',
          });
        }
      }
      continue;
    }

    if (stepType === 'SYSTEM_MESSAGE' && typeof obj.content === 'string') {
      for (const m of obj.content.matchAll(
        /Task id "([^"]+)"\s+(?:finished|was canceled|canceled|cancelled|failed|stopped|completed|exited)/gi
      )) {
        runningTasks.delete(m[1]);
      }
      continue;
    }

    if (stepType === 'USER_INPUT') {
      const content = typeof obj.content === 'string' ? stripUserRequestTags(obj.content) : '';
      const mediaArr = Array.isArray(obj.media) ? obj.media : [];
      const userBlocks: UnifiedBlock[] = [];
      for (const m of mediaArr) {
        const mo = m as Record<string, unknown>;
        if (typeof mo?.uri !== 'string' || !mo.uri.trim()) continue;
        const uri = mo.uri.trim();
        const mime = String(mo.mime_type || '').toLowerCase();
        const displayName =
          typeof mo.name === 'string' && mo.name.trim() ? mo.name.trim() : path.basename(uri);
        if (mime.startsWith('video/') || /\.(mp4|mov|webm|mkv|m4v|avi)$/i.test(uri)) {
          userBlocks.push({
            type: 'video',
            path: uri,
            name: displayName,
            mimeType: mime.startsWith('video/') ? mime : undefined,
          });
        } else if (mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(uri)) {
          userBlocks.push({
            type: 'image',
            path: uri,
            name: displayName,
          });
        }
      }
      if (content) userBlocks.push({ type: 'text', text: content });
      if (userBlocks.length === 0) continue;

      currentAssistant = null;
      pendingOutputBlocks.length = 0;
      if (pendingQuestionBlock) {
        pendingQuestionBlock.answered = true;
        pendingQuestionBlock = null;
      }
      lastPlannerHadToolCalls = false;
      // Clear previous turn's live focus & checklist so old turns never bleed into new ones
      latestFocus = undefined;
      latestSteps = undefined;
      messages.push({
        id: uniqueId(`agy-u-${obj.step_index ?? seq++}`),
        role: 'user',
        timestamp: ts,
        blocks: userBlocks,
      });
      continue;
    }

    if (stepType === 'GENERIC' && typeof obj.content === 'string' && obj.content.trim()) {
      // Detect newly backgrounded tasks (status: RUNNING + task id line)
      if (obj.status === 'RUNNING') {
        const taskMatch = obj.content.match(
          /Tool is running as a background task with task id:\s*([a-zA-Z0-9_-]+\/task-\d+)/
        );
        if (taskMatch) {
          const taskId = taskMatch[1];
          const logMatch = obj.content.match(/Task logs are available at:\s*file:\/\/([^\s\n]+)/);
          const metaInfo = pendingBgCmdMeta.shift();
          runningTasks.set(taskId, {
            id: taskId,
            summary: metaInfo?.summary || taskId.split('/').pop() || 'Background task',
            command: metaInfo?.command,
            logPath: logMatch?.[1],
            isDaemon: metaInfo?.isDaemon ?? false,
          });
        }
      }

      const cleaned = obj.content
        .replace(/^(?:Created At:.*\n|Completed At:.*\n)+/gm, '')
        .trim()
        .slice(0, 8000);

      if (pendingQuestionBlock) {
        applyAntigravityQuestionAnswers(pendingQuestionBlock, cleaned);
        pendingQuestionBlock = null;
        continue;
      }

      const target = pendingOutputBlocks.shift();
      if (target && cleaned) {
        target.output = cleaned;
      }
      continue;
    }

    if (stepType === 'PLANNER_RESPONSE') {
      if (pendingQuestionBlock) {
        pendingQuestionBlock.answered = true;
        pendingQuestionBlock = null;
      }
      const blocks: UnifiedBlock[] = [];
      if (typeof obj.thinking === 'string' && obj.thinking.trim()) {
        blocks.push({ type: 'thinking', text: obj.thinking.trim() });
      }
      const toolCalls = Array.isArray(obj.tool_calls) ? obj.tool_calls : [];
      lastPlannerHadToolCalls = toolCalls.length > 0;
      pendingBgCmdMeta = [];

      for (const tc of toolCalls) {
        if (!tc || typeof tc !== 'object') continue;
        const t = tc as Record<string, unknown>;
        const name = String(t.name || 'tool');
        const argsObj = (t.args ?? {}) as Record<string, unknown>;

        if (name === 'manage_task' && String(argsObj.Action ?? '').replace(/^"|"$/g, '') === 'kill') {
          const tid = String(argsObj.TaskId ?? '').replace(/^"|"$/g, '');
          if (tid) runningTasks.delete(tid);
        }

        if (name === 'run_command' || name === 'schedule') {
          const rawSummary = String(
            argsObj.toolSummary ?? argsObj.CommandLine ?? argsObj.Prompt ?? name
          ).replace(/^"|"$/g, '');
          const rawCmd =
            typeof argsObj.CommandLine === 'string'
              ? argsObj.CommandLine.replace(/^"|"$/g, '')
              : undefined;
          pendingBgCmdMeta.push({
            summary: rawSummary,
            command: rawCmd,
            isDaemon: String(argsObj.IsDaemon) === 'true',
          });
        }

        if (name === 'update_focus') {
          if (typeof argsObj.focus === 'string' && argsObj.focus.trim()) {
            latestFocus = argsObj.focus.trim().replace(/^"|"$/g, '');
          }
          continue;
        }

        if (name === 'update_steps') {
          const parsedSteps = parseMaybeJson(argsObj.steps);
          if (Array.isArray(parsedSteps)) {
            latestSteps = parsedSteps
              .filter((s): s is Record<string, unknown> => Boolean(s && typeof s === 'object'))
              .map((s) => ({
                title: String(s.title ?? ''),
                status: (['pending', 'in_progress', 'done', 'skipped', 'failed'].includes(
                  String(s.status)
                )
                  ? String(s.status)
                  : 'pending') as LiveStepItem['status'],
              }))
              .filter((s) => s.title);
          }
          continue;
        }

        if (name === 'ask_question') {
          const parsedQ = parseMaybeJson(argsObj.questions);
          if (Array.isArray(parsedQ) && parsedQ.length > 0) {
            const qBlock: Extract<UnifiedBlock, { type: 'question' }> = {
              type: 'question',
              questions: parsedQ.map((q) => {
                const qo = (q ?? {}) as Record<string, unknown>;
                return {
                  question: String(qo.question ?? ''),
                  options: Array.isArray(qo.options) ? qo.options.map(String) : [],
                  multiSelect: Boolean(qo.is_multi_select),
                };
              }),
            };
            blocks.push(qBlock);
            pendingQuestionBlock = qBlock;
            continue;
          }
        }

        if (name === 'run_command') {
          const cmdBlock: Extract<UnifiedBlock, { type: 'command' }> = {
            type: 'command',
            command: String(argsObj.CommandLine ?? JSON.stringify(argsObj)),
            status: 'completed',
          };
          blocks.push(cmdBlock);
          pendingOutputBlocks.push(cmdBlock);
        } else if (name === 'write_file' || name === 'edit_file') {
          blocks.push({
            type: 'file_change',
            changes: [
              {
                path: String(argsObj.Path ?? 'file'),
                kind: name === 'write_file' ? 'write' : 'edit',
                diff:
                  typeof argsObj.Replacement === 'string'
                    ? `+ ${argsObj.Replacement.slice(0, 600)}`
                    : undefined,
              },
            ],
          });
        } else if (name === 'search_web') {
          blocks.push({
            type: 'web_search',
            query: String(argsObj.query ?? 'Web search'),
          });
        } else {
          const tcBlock: Extract<UnifiedBlock, { type: 'tool_call' }> = {
            type: 'tool_call',
            name,
            args: JSON.stringify(argsObj, null, 2).slice(0, 3000),
            status: 'completed',
          };
          blocks.push(tcBlock);
          pendingOutputBlocks.push(tcBlock);
        }
      }

      if (typeof obj.content === 'string' && obj.content.trim()) {
        blocks.push({ type: 'text', text: obj.content.trim() });
      }
      if (blocks.length > 0) {
        if (!currentAssistant) {
          currentAssistant = {
            id: uniqueId(`agy-a-${obj.step_index ?? seq++}`),
            role: 'assistant',
            timestamp: ts,
            blocks,
          };
          messages.push(currentAssistant);
        } else {
          currentAssistant.blocks.push(...blocks);
          currentAssistant.timestamp = ts;
        }
      }
    }
  }

  const hasInProgressStep = Boolean(latestSteps?.some((s) => s.status === 'in_progress'));
  const recentlyModified = Date.now() - sourceMtimeMs < 35_000;
  const isWorking =
    recentlyModified &&
    (hasInProgressStep ||
      lastStepType === 'GENERIC' ||
      lastStepType === 'SYSTEM_MESSAGE' ||
      lastStepType === 'USER_INPUT' ||
      (lastStepType === 'PLANNER_RESPONSE' && lastPlannerHadToolCalls));

  const nowMs = Date.now();
  const runningTasksList = Array.from(runningTasks.values()).filter((task) => {
    if (task.isDaemon) return true;
    // Prune ghost non-daemon tasks (e.g. from aborted/forked turns whose completion message never landed)
    if (task.logPath) {
      try {
        const logMtime = fs.statSync(task.logPath).mtimeMs;
        if (nowMs - logMtime > 180_000) return false;
      } catch {
        // If log file no longer exists, drop once the session has gone idle
        if (!isWorking) return false;
      }
    }
    return true;
  });

  const liveActivity: LiveActivityState = {
    isWorking,
    focus: isWorking ? latestFocus : undefined,
    // Suppress stale in-progress steps once a conversation has been idle for >2 minutes
    steps: isWorking || Date.now() - sourceMtimeMs < 120_000 ? latestSteps : undefined,
    runningTasks: runningTasksList.length > 0 ? runningTasksList : undefined,
    lastEventAt,
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
  };
}

interface ProtoField {
  field: number;
  wireType: number;
  bytes?: Buffer;
}

function readProtoVarint(buf: Buffer, offset: number): { value: number; next: number } | null {
  let result = 0;
  let shift = 0;
  let pos = offset;
  while (pos < buf.length && shift < 64) {
    const b = buf[pos++];
    if (shift < 49) {
      result += (b & 0x7f) * 2 ** shift;
    }
    if ((b & 0x80) === 0) {
      return { value: result, next: pos };
    }
    shift += 7;
  }
  return null;
}

function parseProtoFields(buf: Buffer): ProtoField[] {
  const out: ProtoField[] = [];
  let pos = 0;
  while (pos < buf.length) {
    const tagRes = readProtoVarint(buf, pos);
    if (!tagRes || tagRes.value <= 0) break;
    pos = tagRes.next;
    const wireType = tagRes.value & 7;
    const field = Math.floor(tagRes.value / 8);
    if (wireType === 0) {
      const v = readProtoVarint(buf, pos);
      if (!v) break;
      pos = v.next;
      out.push({ field, wireType });
    } else if (wireType === 1) {
      if (pos + 8 > buf.length) break;
      pos += 8;
      out.push({ field, wireType });
    } else if (wireType === 2) {
      const lenRes = readProtoVarint(buf, pos);
      if (!lenRes || lenRes.value < 0 || pos + lenRes.value > buf.length) break;
      const start = lenRes.next;
      const end = start + lenRes.value;
      if (end > buf.length) break;
      out.push({ field, wireType, bytes: buf.subarray(start, end) });
      pos = end;
    } else if (wireType === 5) {
      if (pos + 4 > buf.length) break;
      pos += 4;
      out.push({ field, wireType });
    } else {
      break;
    }
  }
  return out;
}

/**
 * Decodes an Antigravity `.system_generated/messages/<uuid>.json` base64
 * `stepPayload` protobuf (CortexStep -> field 19 UserInputStep -> field 2 text,
 * field 3 text chunks, field 9 media attachments).
 */
export function decodeAntigravityStepPayload(base64Payload: string): {
  text: string;
  attachments: ImageAttachment[];
} {
  if (!base64Payload) return { text: '', attachments: [] };
  let buf: Buffer;
  try {
    buf = Buffer.from(base64Payload, 'base64');
  } catch {
    return { text: '', attachments: [] };
  }
  if (buf.length === 0) return { text: '', attachments: [] };

  let primaryText = '';
  const fallbackChunks: string[] = [];
  const attachments: ImageAttachment[] = [];

  for (const top of parseProtoFields(buf)) {
    if (top.field !== 19 || top.wireType !== 2 || !top.bytes) continue;
    for (const sub of parseProtoFields(top.bytes)) {
      if (sub.field === 2 && sub.wireType === 2 && sub.bytes) {
        const s = sub.bytes.toString('utf8').trim();
        if (s) primaryText = s;
      } else if (sub.field === 3 && sub.wireType === 2 && sub.bytes) {
        for (const itemField of parseProtoFields(sub.bytes)) {
          if (itemField.field === 1 && itemField.wireType === 2 && itemField.bytes) {
            const chunk = itemField.bytes.toString('utf8');
            if (chunk) fallbackChunks.push(chunk);
          }
        }
      } else if (sub.field === 9 && sub.wireType === 2 && sub.bytes) {
        let mimeType = '';
        let name = '';
        let filePath = '';
        for (const mediaField of parseProtoFields(sub.bytes)) {
          if (mediaField.wireType !== 2 || !mediaField.bytes) continue;
          if (mediaField.field === 1) mimeType = mediaField.bytes.toString('utf8').trim();
          else if (mediaField.field === 4) name = mediaField.bytes.toString('utf8').trim();
          else if (mediaField.field === 5) filePath = mediaField.bytes.toString('utf8').trim();
        }
        if (
          filePath &&
          path.isAbsolute(filePath) &&
          (mimeType.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(filePath))
        ) {
          attachments.push({
            id: `agy-q-att-${attachments.length + 1}`,
            name: name || path.basename(filePath),
            path: filePath,
            mimeType: mimeType || 'image/png',
          });
        }
      }
    }
  }

  const text = (primaryText || fallbackChunks.join('')).trim();
  return { text, attachments };
}

function resolveAntigravityMessagesDir(
  nativeId: string,
  resolvedTranscriptPath?: string | null
): string {
  if (resolvedTranscriptPath) {
    // <brain>/<id>/.system_generated/logs/transcript.jsonl -> <brain>/<id>/.system_generated/messages
    return path.resolve(path.dirname(resolvedTranscriptPath), '..', 'messages');
  }
  for (const root of [AGY_APP_DIR, AGY_CLI_DIR]) {
    const dir = path.join(root, 'brain', nativeId, '.system_generated', 'messages');
    if (fs.existsSync(dir)) return dir;
  }
  return path.join(AGY_APP_DIR, 'brain', nativeId, '.system_generated', 'messages');
}

function readAntigravityReadMap(messagesDir: string): Set<string> {
  const readSet = new Set<string>();
  const readPath = path.join(messagesDir, 'read.json');
  if (!fs.existsSync(readPath)) return readSet;
  try {
    const parsed = JSON.parse(fs.readFileSync(readPath, 'utf8')) as unknown;
    if (Array.isArray(parsed)) {
      for (const id of parsed) {
        if (typeof id === 'string') readSet.add(id);
      }
    } else if (parsed && typeof parsed === 'object') {
      for (const [id, flag] of Object.entries(parsed as Record<string, unknown>)) {
        if (flag) readSet.add(id);
      }
    }
  } catch {
    // ignore transient read.json write races
  }
  return readSet;
}

/**
 * Reads pending (unread) user-queued messages persisted by Antigravity Desktop
 * or CLI in `<brain>/<conversation-id>/.system_generated/messages/`.
 */
export function readAntigravityNativeQueue(messagesDir: string | null | undefined): {
  items: QueuedMessageItem[];
  latestMtimeMs: number;
} {
  if (!messagesDir || !fs.existsSync(messagesDir)) {
    return { items: [], latestMtimeMs: 0 };
  }

  let latestMtimeMs = 0;
  try {
    latestMtimeMs = Math.max(latestMtimeMs, fs.statSync(messagesDir).mtimeMs);
    const readPath = path.join(messagesDir, 'read.json');
    if (fs.existsSync(readPath)) {
      latestMtimeMs = Math.max(latestMtimeMs, fs.statSync(readPath).mtimeMs);
    }
  } catch {
    // ignore stat errors
  }

  const readSet = readAntigravityReadMap(messagesDir);
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(messagesDir);
  } catch {
    return { items: [], latestMtimeMs };
  }

  const items: QueuedMessageItem[] = [];
  for (const fn of entries) {
    if (!fn.endsWith('.json') || fn === 'read.json') continue;
    const fileId = fn.slice(0, -5);
    if (readSet.has(fileId)) continue;

    const fullPath = path.join(messagesDir, fn);
    try {
      const st = fs.statSync(fullPath);
      latestMtimeMs = Math.max(latestMtimeMs, st.mtimeMs);
      const raw = fs.readFileSync(fullPath, 'utf8');
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const id = typeof obj.id === 'string' && obj.id ? obj.id : fileId;
      if (readSet.has(id)) continue;
      if (obj.sender !== 'user') continue;

      let text = '';
      let attachments: ImageAttachment[] = [];
      if (typeof obj.stepPayload === 'string' && obj.stepPayload) {
        const decoded = decodeAntigravityStepPayload(obj.stepPayload);
        text = decoded.text;
        attachments = decoded.attachments;
      }
      if (!text && typeof obj.content === 'string') {
        text = obj.content.trim();
      }
      if (!text && attachments.length === 0) continue;

      items.push({
        id: `agy-q-${id}`,
        text,
        attachments: attachments.length > 0 ? attachments : undefined,
        createdAt: normalizeTimestamp(obj.timestamp || st.mtimeMs),
        source: 'native',
      });
    } catch {
      // ignore malformed or mid-write message file
    }
  }

  items.sort((a, b) => a.createdAt - b.createdAt);
  return { items, latestMtimeMs };
}

function computeAntigravityMessagesFingerprint(messagesDir: string | null | undefined): string {
  if (!messagesDir || !fs.existsSync(messagesDir)) return 'q0';
  try {
    const readPath = path.join(messagesDir, 'read.json');
    const readStat = fs.existsSync(readPath) ? fs.statSync(readPath) : null;
    const readSet = readAntigravityReadMap(messagesDir);
    const entries = fs.readdirSync(messagesDir);
    const unreadIds: string[] = [];
    for (const fn of entries) {
      if (!fn.endsWith('.json') || fn === 'read.json') continue;
      const id = fn.slice(0, -5);
      if (!readSet.has(id)) unreadIds.push(id);
    }
    unreadIds.sort();
    return `q:${entries.length}:${readStat ? `${readStat.size}:${Math.floor(readStat.mtimeMs)}` : '0'}:${unreadIds.join(',')}`;
  } catch {
    return 'q0';
  }
}

export async function loadAntigravityTranscript(
  nativeId: string,
  transcriptPath: string | undefined,
  limit = 120
): Promise<SessionTranscriptResult> {
  const sessionId = `antigravity:${nativeId}`;
  const resolved = resolveAntigravityTranscriptPath(nativeId, transcriptPath);
  const messagesDir = resolveAntigravityMessagesDir(nativeId, resolved);
  const nativeQueue = readAntigravityNativeQueue(messagesDir);

  if (!resolved) {
    return {
      sessionId,
      messages: [],
      totalCount: 0,
      hasMore: false,
      sourceMtimeMs: nativeQueue.latestMtimeMs || Date.now(),
      liveActivity:
        nativeQueue.items.length > 0
          ? {
              isWorking: false,
              queuedMessages: nativeQueue.items,
              lastEventAt: nativeQueue.latestMtimeMs || Date.now(),
            }
          : undefined,
    };
  }

  const initialBytes = Math.max(1024 * 1024, limit * 24 * 1024);
  const outcome = readProgressiveJsonlTail(
    resolved,
    (lines, chunkMeta) =>
      parseAntigravityJsonlLines(lines, sessionId, chunkMeta.mtimeMs, limit, {
        truncated: chunkMeta.truncated,
        fileSize: chunkMeta.fileSize,
        bytesRead: lines.reduce((sum, l) => sum + l.length + 1, 0),
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
      sourceMtimeMs: nativeQueue.latestMtimeMs || Date.now(),
      liveActivity:
        nativeQueue.items.length > 0
          ? {
              isWorking: false,
              queuedMessages: nativeQueue.items,
              lastEventAt: nativeQueue.latestMtimeMs || Date.now(),
            }
          : undefined,
    };
  }

  const res = outcome.parsed;
  if (nativeQueue.latestMtimeMs > res.sourceMtimeMs) {
    res.sourceMtimeMs = nativeQueue.latestMtimeMs;
  }
  if (nativeQueue.items.length > 0) {
    res.liveActivity = {
      ...(res.liveActivity ?? { isWorking: false }),
      queuedMessages: nativeQueue.items,
    };
  }
  return res;
}

/**
 * Cohesive HarnessDriver encapsulating all Google Antigravity Desktop & CLI
 * integration (discovery, brain transcripts, ACP persistent pool, remote-control).
 */
export function createAntigravityDriver(): HarnessDriver {
  const acpPool = new AgyAcpPool();
  const lsClient = new AntigravityLsClient();
  const remote = new RemoteAntigravityMirror();
  let activitySink: ((sessionId: string) => void) | null = null;

  const ensureLsSubscription = (nativeId: string): void => {
    lsClient.subscribeAgentState(nativeId, () => {
      activitySink?.(`antigravity:${nativeId}`);
    });
  };

  return {
    async applySessionConfig(session, change) {
      return resultsFor(change, (field, requested) => {
        if (field === 'model') {
          if (!requested.trim()) return { status: 'next_message', value: '', detail: 'Override cleared; the cascade keeps its last model.' };
          return {
            status: 'next_message',
            value: requested.trim(),
            detail: 'Applies to the next message Super Harness sends (mapped to the hub\'s planModel; unknown slugs fall back to the recommended model).',
          };
        }
        return {
          status: 'unsupported',
          detail:
            field === 'reasoningEffort'
              ? 'The Antigravity language server takes no per-message reasoning effort; pick a model variant instead.'
              : 'Antigravity exposes no permission mode Super Harness can set per conversation.',
        };
      });
    },

    id: 'antigravity',
    displayName: 'Google Antigravity',

    async detect(processes, maxSessions) {
      const [local, remoteSessions] = await Promise.all([
        detectAntigravity(processes, maxSessions),
        remote.sessions().catch(() => [] as UnifiedSession[]),
      ]);
      const localIds = new Set(local.sessions.map((s) => s.id));
      const extra = remoteSessions.filter((s) => !localIds.has(s.id));
      if (extra.length === 0) return local;
      const extraTopLevel = extra.filter((s) => !s.isSubagent);
      return {
        detection: {
          ...local.detection,
          activeSessionCount:
            local.detection.activeSessionCount + extraTopLevel.filter((s) => s.isLive).length,
          totalSessionCount: local.detection.totalSessionCount + extraTopLevel.length,
        },
        sessions: [...extra, ...local.sessions],
      };
    },

    async getTranscriptFingerprint(session) {
      const remoteFp = remote.fingerprint(session.id);
      if (remoteFp) return remoteFp;
      const resolved = resolveAntigravityTranscriptPath(session.nativeId, session.transcriptPath);
      const messagesDir = resolveAntigravityMessagesDir(session.nativeId, resolved);
      return `${computeFileFingerprint(resolved)}|${computeAntigravityMessagesFingerprint(messagesDir)}`;
    },

    async loadTranscript(session, limit) {
      if (!remote.isRemote(session.id) && session.tags?.includes('remote-host')) {
        await remote.sessions();
      }
      if (remote.isRemote(session.id)) {
        const res = await remote.loadTranscript(session.id, limit);
        if (res) return res;
      }
      const resolved = resolveAntigravityTranscriptPath(session.nativeId, session.transcriptPath);
      const res = await loadAntigravityTranscript(session.nativeId, resolved, limit);
      // Native live lane: the hub LS agent-state stream drives refreshes
      // (signal-gated inside the client) and supplies working state, so
      // Desktop-side turns mirror here without mtime heuristics. Status
      // comes from already-observed stream signals - no extra RPC here.
      if (session.originApp !== 'antigravity-cli' && lsClient.isHubAvailable()) {
        ensureLsSubscription(session.nativeId);
        const status = lsClient.getObservedStatus(session.nativeId);
        if (status) {
          const hubSaysWorking = status !== 'CASCADE_RUN_STATUS_IDLE';
          const terminalReply = resolved
            ? isAntigravityTranscriptTerminal(resolved, res.sourceMtimeMs)
            : false;
          const isWorking = hubSaysWorking && !terminalReply;
          res.liveActivity = { ...(res.liveActivity ?? { isWorking }), isWorking, lastEventAt: Date.now() };
        }
      }
      return res;
    },

    getGlobalWatchDirs(): HarnessWatchSpec[] {
      return [
        { dir: path.join(AGY_APP_DIR, 'brain') },
        { dir: path.join(AGY_CLI_DIR, 'brain') },
      ];
    },

    getSessionWatchFiles(session: UnifiedSession): string[] {
      if (remote.isRemote(session.id) || session.tags?.includes('remote-host')) {
        return [];
      }
      const tr =
        resolveAntigravityTranscriptPath(session.nativeId, session.transcriptPath) ||
        path.join(
          AGY_APP_DIR,
          'brain',
          session.nativeId,
          '.system_generated',
          'logs',
          'transcript.jsonl'
        );
      const messagesDir = resolveAntigravityMessagesDir(session.nativeId, tr);
      return [tr, messagesDir, path.join(messagesDir, 'read.json')];
    },

    async sendMessage(
      session: UnifiedSession,
      prompt: string,
      attachments: ImageAttachment[] | undefined,
      ctx: DispatchContext,
      opts?: { force?: boolean }
    ): Promise<SendMessageResult> {
      if (remote.isRemote(session.id) || session.tags?.includes('remote-host')) {
        return remote.sendMessage(session, prompt, attachments, ctx);
      }
      const cwd = fs.existsSync(session.cwd) ? session.cwd : os.homedir();
      const runId = crypto.randomBytes(6).toString('hex');
      const originApp =
        session.originApp === 'antigravity-cli' ? 'antigravity-cli' : 'antigravity-app';

      // Desktop sessions with a live hub LS: dispatch exactly as Desktop
      // does (SendUserCascadeMessage into the running cascade) - a true
      // single-writer live attach, so no fork guard is needed on this lane.
      if (originApp === 'antigravity-app' && lsClient.isHubAvailable()) {
        try {
          ensureLsSubscription(session.nativeId);
          ctx.emitStream({ sessionId: session.id, runId, kind: 'start' });
          await lsClient.sendUserMessage({
            cascadeId: session.nativeId,
            text: prompt,
            attachments,
            modelSlug: session.model,
          });
          ctx.emitStream({ sessionId: session.id, runId, kind: 'done' });
          ctx.triggerRefresh(400);
          ctx.triggerRefresh(1800);
          return {
            ok: true,
            runId,
            dispatchedVia: 'Antigravity Desktop (hub LS SendUserCascadeMessage)',
          };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }

      try {
        await acpPool.sendPrompt(
          originApp,
          session.id,
          session.nativeId,
          cwd,
          prompt,
          attachments,
          runId,
          ctx.emitStream,
          () => {
            ctx.triggerRefresh(500);
            ctx.triggerRefresh(2000);
          },
          session.model,
          Boolean(opts?.force)
        );
        return {
          ok: true,
          runId,
          dispatchedVia:
            originApp === 'antigravity-app'
              ? 'Antigravity Desktop (ACP — separate engine, Desktop not running)'
              : 'Antigravity CLI (ACP cold resume)',
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },

    async startSession(
      req: StartSessionRequest,
      ctx: DispatchContext
    ): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
      const cwd = fs.existsSync(req.cwd) ? req.cwd : os.homedir();
      if (lsClient.isHubAvailable()) {
        try {
          const nativeId = crypto.randomUUID();
          const shId = `antigravity:${nativeId}`;
          await lsClient.startCascade(nativeId);
          ensureLsSubscription(nativeId);
          const promptText = req.prompt?.trim() || '';
          const hasAttachments = Boolean(req.attachments && req.attachments.length > 0);
          if (promptText || hasAttachments) {
            const runId = crypto.randomBytes(6).toString('hex');
            ctx.emitStream({ sessionId: shId, runId, kind: 'start' });
            await lsClient.sendUserMessage({
              cascadeId: nativeId,
              text: promptText,
              attachments: req.attachments,
              modelSlug: req.model,
            });
            ctx.emitStream({ sessionId: shId, runId, kind: 'done' });
          }
          ctx.triggerRefresh(800);
          ctx.triggerRefresh(2500);
          return { ok: true, sessionId: shId };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
      try {
        const nativeId = await acpPool.createSession('antigravity-app', cwd, req.model);
        const shId = `antigravity:${nativeId}`;
        const promptText = req.prompt?.trim() || '';
        const hasAttachments = Boolean(req.attachments && req.attachments.length > 0);
        if (promptText || hasAttachments) {
          const runId = crypto.randomBytes(6).toString('hex');
          await acpPool.sendPrompt(
            'antigravity-app',
            shId,
            nativeId,
            cwd,
            promptText,
            req.attachments,
            runId,
            ctx.emitStream,
            () => ctx.triggerRefresh(),
            req.model
          );
        }
        ctx.triggerRefresh(800);
        return { ok: true, sessionId: shId };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    async controlDaemon(
      action: DaemonControlAction,
      ctx: DispatchContext
    ): Promise<{ ok: boolean; output?: string; error?: string }> {
      const bin = await whichBinary('agy');
      if (!bin) return { ok: false, error: 'agy CLI not found' };
      if (action === 'start_remote' || action === 'stop_remote') {
        const sub = action === 'start_remote' ? 'start' : 'stop';
        const { stdout, stderr } = await execFileAsync(bin, ['remote-control', sub], {
          timeout: 10000,
        });
        invalidateAgyRemoteStatusCache();
        ctx.triggerRefresh(1000);
        return {
          ok: true,
          output: (stdout || stderr).trim() || `Antigravity remote-control ${sub}ed`,
        };
      }
      return { ok: false, error: `Action '${action}' not supported for antigravity` };
    },

    async archiveSession(): Promise<null> {
      // Fall back to Super Harness local hide-session behavior
      return null;
    },

    abort(sessionId: string, emitStream: (ev: StreamEvent) => void): boolean {
      if (!sessionId.startsWith('antigravity:')) return false;
      if (remote.isRemote(sessionId)) {
        return remote.abort(sessionId, emitStream);
      }
      const nativeId = sessionId.slice('antigravity:'.length);
      if (lsClient.isHubAvailable()) {
        void lsClient.cancelInvocation(nativeId).catch(() => {});
      }
      void acpPool.cancel(nativeId);
      emitStream({ sessionId, runId: 'abort', kind: 'done' });
      return true;
    },

    shutdown(): void {
      remote.stop();
      lsClient.closeAll();
      acpPool.closeAll();
    },

    setActivitySink(sink: ((sessionId: string) => void) | null): void {
      activitySink = sink;
      remote.setActivitySink(sink);
    },
  };
}
