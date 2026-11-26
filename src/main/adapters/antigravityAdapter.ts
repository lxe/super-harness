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
    const isRunning =
      summary?.status === 'CASCADE_RUN_STATUS_RUNNING' ||
      (summary?.status !== 'CASCADE_RUN_STATUS_IDLE' && Date.now() - d.mtime < 20_000);
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
      for (const m of obj.content.matchAll(/Task id "([^"]+)" finished/g)) {
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
        if (typeof mo?.uri === 'string' && String(mo.mime_type || '').startsWith('image/')) {
          userBlocks.push({
            type: 'image',
            path: mo.uri,
            name: path.basename(mo.uri),
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

  const runningTasksList = Array.from(runningTasks.values());

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

export async function loadAntigravityTranscript(
  nativeId: string,
  transcriptPath: string | undefined,
  limit = 120
): Promise<SessionTranscriptResult> {
  const sessionId = `antigravity:${nativeId}`;
  const resolved = resolveAntigravityTranscriptPath(nativeId, transcriptPath);

  if (!resolved) {
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
      sourceMtimeMs: Date.now(),
    };
  }

  return outcome.parsed;
}

/**
 * Cohesive HarnessDriver encapsulating all Google Antigravity Desktop & CLI
 * integration (discovery, brain transcripts, ACP persistent pool, remote-control).
 */
export function createAntigravityDriver(): HarnessDriver {
  const acpPool = new AgyAcpPool();

  return {
    id: 'antigravity',
    displayName: 'Google Antigravity',

    detect(processes, maxSessions) {
      return detectAntigravity(processes, maxSessions);
    },

    async getTranscriptFingerprint(session) {
      const resolved = resolveAntigravityTranscriptPath(session.nativeId, session.transcriptPath);
      return computeFileFingerprint(resolved);
    },

    loadTranscript(session, limit) {
      const resolved = resolveAntigravityTranscriptPath(session.nativeId, session.transcriptPath);
      return loadAntigravityTranscript(session.nativeId, resolved, limit);
    },

    getGlobalWatchDirs(): HarnessWatchSpec[] {
      return [
        { dir: path.join(AGY_APP_DIR, 'brain') },
        { dir: path.join(AGY_CLI_DIR, 'brain') },
      ];
    },

    getSessionWatchFiles(session: UnifiedSession): string[] {
      const tr =
        session.transcriptPath ||
        path.join(
          AGY_APP_DIR,
          'brain',
          session.nativeId,
          '.system_generated',
          'logs',
          'transcript.jsonl'
        );
      return [tr];
    },

    async sendMessage(
      session: UnifiedSession,
      prompt: string,
      attachments: ImageAttachment[] | undefined,
      ctx: DispatchContext
    ): Promise<SendMessageResult> {
      const cwd = fs.existsSync(session.cwd) ? session.cwd : os.homedir();
      const runId = crypto.randomBytes(6).toString('hex');
      const originApp =
        session.originApp === 'antigravity-cli' ? 'antigravity-cli' : 'antigravity-app';
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
          }
        );
        return {
          ok: true,
          runId,
          dispatchedVia:
            originApp === 'antigravity-app'
              ? 'Antigravity Desktop (ACP)'
              : 'Antigravity CLI (ACP)',
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
      try {
        const nativeId = await acpPool.createSession('antigravity-app', cwd, req.model);
        const shId = `antigravity:${nativeId}`;
        if (req.prompt?.trim()) {
          const runId = crypto.randomBytes(6).toString('hex');
          await acpPool.sendPrompt(
            'antigravity-app',
            shId,
            nativeId,
            cwd,
            req.prompt.trim(),
            undefined,
            runId,
            ctx.emitStream,
            () => ctx.triggerRefresh()
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
      const nativeId = sessionId.slice('antigravity:'.length);
      void acpPool.cancel(nativeId);
      emitStream({ sessionId, runId: 'abort', kind: 'done' });
      return true;
    },

    shutdown(): void {
      acpPool.closeAll();
    },
  };
}
