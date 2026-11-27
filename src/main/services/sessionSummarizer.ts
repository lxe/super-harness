import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  SummarizerRunRecord,
  SummarizerUsageStats,
  UnifiedMessage,
  UnifiedSession,
} from '../../shared/types';
import { cleanUserPreview, isInjectedText } from '../utils/lastUserText';
import { whichBinary } from '../utils/system';

/**
 * One-line "what this thread is doing now" summaries for list rows.
 *
 * After discovery passes, sessions whose `updatedAt` moved since their last summary are
 * collected. Once they have been quiet for a short while, one batched call to a small model
 * (Claude Haiku via `claude -p`, stripped to ~600 tokens of overhead: no tools, MCP, Chrome,
 * settings, skills or CLAUDE.md) receives a compact digest per thread — title, the previous
 * summary, and the tail of the new conversation text — and returns one line per thread.
 *
 * Running sessions are left alone until they go idle (or their summary is stale), so a busy
 * thread costs at most one refresh per STALE_RUNNING_MS.
 */

export interface SummaryEntry {
  text: string;
  /** The session's `updatedAt` that this summary covers. */
  updatedAt: number;
  /** When the summary was written. */
  at: number;
  /** Compact hash of title + conversation digest so metadata-only bumps skip model calls. */
  digestHash?: string;
}

export interface SummarizerModelUsage {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
}

export interface SummaryRefreshResult {
  ok: boolean;
  summarized: number;
  pending: number;
  costUsd?: number;
  tokens?: number;
  error?: string;
}

export interface SummarizerOptions {
  loadTranscript: (sessionId: string, limit: number) => Promise<{ messages: UnifiedMessage[] }>;
  getWorkingIds: () => string[];
  getConfig: () => { enabled: boolean; model: string };
  onUpdated: () => void;
  /** Injectable model call (tests). Receives the prompt, returns raw JSON text of `{items:[{n,s}]}`. */
  callModel?: (
    prompt: string,
    model: string
  ) => Promise<{ text: string; costUsd?: number; usage?: Partial<SummarizerModelUsage> }>;
  filePath?: string;
  usageFilePath?: string;
  now?: () => number;
}

export const SUMMARIZER_CWD_BASENAME = 'super-harness-summaries';

const activeSummarizerPids = new Set<number>();

/** Returns true if `cwd` is the temporary working directory used by the background summarizer. */
export function isInternalSummarizerCwd(cwd?: string | null): boolean {
  if (!cwd) return false;
  const norm = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  return norm === SUMMARIZER_CWD_BASENAME || norm.endsWith(`/${SUMMARIZER_CWD_BASENAME}`);
}

/** Returns true if `pid` belongs to a currently running internal summarizer subprocess. */
export function isSummarizerPid(pid?: number | null): boolean {
  return typeof pid === 'number' && Number.isFinite(pid) && activeSummarizerPids.has(pid);
}

const FILE = path.join(os.homedir(), '.config', 'super-harness', 'summaries.json');
const QUIET_MS = 20_000;
const MIN_GAP_MS = 90_000;
const STALE_RUNNING_MS = 15 * 60_000;
/** Sessions never summarized are only picked up if they changed this recently (no mass backfill). */
const FIRST_SEEN_WINDOW_MS = 3 * 24 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;
const USAGE_HISTORY_RETENTION_MS = 14 * DAY_MS;
const MAX_USAGE_RUNS = 500;
const BATCH = 12;
const PER_MSG_USER = 240;
const PER_MSG_ASSISTANT = 360;
const PER_THREAD = 1000;
const MAX_SUMMARY = 110;

interface PersistedUsageFile {
  totalRuns: number;
  totalThreads: number;
  totalInputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  runs: SummarizerRunRecord[];
}

function emptyPersistedUsage(): PersistedUsageFile {
  return {
    totalRuns: 0,
    totalThreads: 0,
    totalInputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheCreationTokens: 0,
    totalOutputTokens: 0,
    totalCostUsd: 0,
    runs: [],
  };
}

function digestHashFor(title: string, digest: string): string {
  return crypto.createHash('sha1').update(`${oneLine(title)}\n${digest}`).digest('hex').slice(0, 12);
}

function totalTokensOf(r: {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
}): number {
  return r.inputTokens + r.cacheReadTokens + r.cacheCreationTokens + r.outputTokens;
}

export const SUMMARY_SYSTEM_PROMPT = [
  'You label chat threads in a session list. Each thread is a person working with a coding agent.',
  'For every thread, write ONE line of at most 90 characters saying what the thread is doing now,',
  'or what it last finished. Name the concrete thing (feature, bug, file, service), not the people.',
  'Do not start with "The user", "User", "Agent", "Assistant" or "This thread". No trailing period.',
  'If the agent is waiting on the person (a question, approval, or a choice), start with "Waiting: ".',
  'If the agent finished and reported back, start with "Done: ".',
  'A previous summary is context only; replace it when the new text shows a change.',
  'Return JSON only: {"items":[{"n":<thread number>,"s":"<summary>"}]} covering every thread.',
].join(' ');

const clip = (t: string, n: number): string => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
const oneLine = (t: string): string => t.replace(/\s+/g, ' ').trim();

/** Conversation text of one message (user + assistant text blocks only; no tools or thinking). */
function messageText(m: UnifiedMessage): string {
  const parts: string[] = [];
  for (const b of m.blocks) {
    if (b.type === 'text' && b.text && !isInjectedText(b.text)) parts.push(b.text);
  }
  return oneLine(parts.join(' '));
}

/** Compact digest of the newest conversation in a thread, newest text kept when over budget. */
export function buildThreadDigest(messages: UnifiedMessage[], sinceMs: number): string {
  const convo = messages.filter((m) => (m.role === 'user' || m.role === 'assistant') && !m.streaming);
  let fresh = convo.filter((m) => m.timestamp > sinceMs);
  // Keep at least the last exchange so the model sees the current state.
  if (fresh.length < 2) fresh = convo.slice(-2);
  const lines: string[] = [];
  for (const m of fresh) {
    const t = messageText(m);
    if (!t) continue;
    lines.push(m.role === 'user' ? `P: ${clip(t, PER_MSG_USER)}` : `A: ${clip(t, PER_MSG_ASSISTANT)}`);
  }
  let out = lines.join('\n');
  if (out.length > PER_THREAD) out = `…${out.slice(out.length - PER_THREAD)}`;
  return out;
}

export function buildPrompt(
  threads: Array<{ n: number; title: string; project: string; previous?: string; digest: string }>
): string {
  return threads
    .map((t) =>
      [
        `## ${t.n}. ${clip(oneLine(t.title), 80)} (${t.project})`,
        t.previous ? `Previous summary: ${t.previous}` : '',
        t.digest || '(no new conversation text)',
      ]
        .filter(Boolean)
        .join('\n')
    )
    .join('\n\n');
}

/** Parses the model reply (plain JSON, fenced JSON, or a `structured_output` envelope). */
export function parseSummaryReply(raw: string): Map<number, string> {
  const out = new Map<number, string>();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return out;
  let obj: unknown;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return out;
  }
  const items = (obj as { items?: unknown }).items;
  if (!Array.isArray(items)) return out;
  for (const it of items) {
    const r = it as { n?: unknown; s?: unknown };
    if (typeof r.n !== 'number' || typeof r.s !== 'string') continue;
    const s = cleanUserPreview(r.s.replace(/\.$/, ''));
    if (s) out.set(r.n, clip(s, MAX_SUMMARY));
  }
  return out;
}

async function callClaude(
  prompt: string,
  model: string
): Promise<{ text: string; costUsd?: number; usage?: SummarizerModelUsage }> {
  const bin = await whichBinary('claude');
  if (!bin) throw new Error('claude binary not found');
  const cwd = path.join(os.tmpdir(), SUMMARIZER_CWD_BASENAME);
  fs.mkdirSync(cwd, { recursive: true });
  // Intentionally omit `--json-schema`: Claude Code implements schema mode by injecting a
  // StructuredOutput tool + extra turn + thinking tokens (~2.3x cost and ~2x tokens).
  // Plain JSON via SUMMARY_SYSTEM_PROMPT runs in a single turn with 0 thinking tokens and
  // is parsed cleanly by parseSummaryReply().
  const args = [
    '-p',
    '--model',
    model,
    '--output-format',
    'json',
    '--system-prompt',
    SUMMARY_SYSTEM_PROMPT,
    '--tools',
    '',
    '--strict-mcp-config',
    '--no-chrome',
    '--setting-sources',
    '',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--exclude-dynamic-system-prompt-sections',
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd,
      env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const childPid = child.pid;
    if (childPid) activeSummarizerPids.add(childPid);
    const releasePid = () => {
      if (childPid) activeSummarizerPids.delete(childPid);
    };
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('error', (e) => {
      clearTimeout(timer);
      releasePid();
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      releasePid();
      try {
        const env = JSON.parse(stdout) as {
          result?: string;
          structured_output?: unknown;
          total_cost_usd?: number;
          is_error?: boolean;
          usage?: {
            input_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
            output_tokens?: number;
          };
        };
        if (env.is_error) throw new Error(env.result || 'model error');
        const text = env.structured_output ? JSON.stringify(env.structured_output) : env.result ?? '';
        const u = env.usage;
        const usage: SummarizerModelUsage | undefined = u
          ? {
              inputTokens: Math.max(0, Number(u.input_tokens || 0)),
              cacheReadTokens: Math.max(0, Number(u.cache_read_input_tokens || 0)),
              cacheCreationTokens: Math.max(0, Number(u.cache_creation_input_tokens || 0)),
              outputTokens: Math.max(0, Number(u.output_tokens || 0)),
            }
          : undefined;
        resolve({ text, costUsd: env.total_cost_usd, usage });
      } catch (e) {
        reject(new Error(`summary call failed (exit ${code}): ${(stderr || stdout || String(e)).slice(0, 300)}`));
      }
    });
    child.stdin.end(prompt);
  });
}

export class SessionSummarizer {
  private entries: Record<string, SummaryEntry> = {};
  private usageData: PersistedUsageFile = emptyPersistedUsage();
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<SummaryRefreshResult> | null = null;
  private lastRunAt = 0;
  private failures = 0;
  private latest: UnifiedSession[] = [];
  private readonly filePath: string;
  private readonly usageFilePath: string;
  private readonly now: () => number;

  constructor(private readonly opts: SummarizerOptions) {
    this.filePath = opts.filePath ?? FILE;
    this.usageFilePath =
      opts.usageFilePath ??
      (this.filePath.endsWith('.json')
        ? `${this.filePath.slice(0, -5)}-usage.json`
        : `${this.filePath}.usage.json`);
    this.now = opts.now ?? Date.now;
    try {
      this.entries = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) as Record<string, SummaryEntry>;
    } catch {
      this.entries = {};
    }
    this.loadUsage();
  }

  private loadUsage(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.usageFilePath, 'utf8')) as Partial<PersistedUsageFile>;
      this.usageData = {
        totalRuns: Math.max(0, Number(raw.totalRuns || 0)),
        totalThreads: Math.max(0, Number(raw.totalThreads || 0)),
        totalInputTokens: Math.max(0, Number(raw.totalInputTokens || 0)),
        totalCacheReadTokens: Math.max(0, Number(raw.totalCacheReadTokens || 0)),
        totalCacheCreationTokens: Math.max(0, Number(raw.totalCacheCreationTokens || 0)),
        totalOutputTokens: Math.max(0, Number(raw.totalOutputTokens || 0)),
        totalCostUsd: Math.max(0, Number(raw.totalCostUsd || 0)),
        runs: Array.isArray(raw.runs) ? raw.runs : [],
      };
    } catch {
      this.usageData = emptyPersistedUsage();
    }
  }

  private saveUsage(): void {
    try {
      fs.mkdirSync(path.dirname(this.usageFilePath), { recursive: true });
      const tmp = `${this.usageFilePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.usageData));
      fs.renameSync(tmp, this.usageFilePath);
    } catch {
      // best effort
    }
  }

  private recordUsageRun(record: SummarizerRunRecord): void {
    const cutoff = record.at - USAGE_HISTORY_RETENTION_MS;
    const pruned = this.usageData.runs.filter((r) => r.at >= cutoff);
    pruned.push(record);
    this.usageData = {
      totalRuns: this.usageData.totalRuns + 1,
      totalThreads: this.usageData.totalThreads + record.threads,
      totalInputTokens: this.usageData.totalInputTokens + record.inputTokens,
      totalCacheReadTokens: this.usageData.totalCacheReadTokens + record.cacheReadTokens,
      totalCacheCreationTokens: this.usageData.totalCacheCreationTokens + record.cacheCreationTokens,
      totalOutputTokens: this.usageData.totalOutputTokens + record.outputTokens,
      totalCostUsd: this.usageData.totalCostUsd + record.costUsd,
      runs: pruned.length > MAX_USAGE_RUNS ? pruned.slice(pruned.length - MAX_USAGE_RUNS) : pruned,
    };
    this.saveUsage();
  }

  getUsageStats(): SummarizerUsageStats {
    const cutoff24h = this.now() - DAY_MS;
    let last24hRuns = 0;
    let last24hTokens = 0;
    let last24hCostUsd = 0;
    for (const r of this.usageData.runs) {
      if (r.at >= cutoff24h) {
        last24hRuns += 1;
        last24hTokens += totalTokensOf(r);
        last24hCostUsd += r.costUsd;
      }
    }
    return {
      totalRuns: this.usageData.totalRuns,
      totalThreads: this.usageData.totalThreads,
      totalInputTokens: this.usageData.totalInputTokens,
      totalCacheReadTokens: this.usageData.totalCacheReadTokens,
      totalCacheCreationTokens: this.usageData.totalCacheCreationTokens,
      totalOutputTokens: this.usageData.totalOutputTokens,
      totalCostUsd: this.usageData.totalCostUsd,
      last24hRuns,
      last24hTokens,
      last24hCostUsd,
      lastRun: this.usageData.runs[this.usageData.runs.length - 1],
    };
  }

  resetUsageStats(): SummarizerUsageStats {
    this.usageData = emptyPersistedUsage();
    this.saveUsage();
    return this.getUsageStats();
  }

  get(sessionId: string): string | undefined {
    return this.entries[sessionId]?.text;
  }

  getAll(): Record<string, SummaryEntry> {
    return { ...this.entries };
  }

  /** Sessions whose conversation moved since their summary and are ready to be summarized now. */
  pendingSessions(sessions: UnifiedSession[], force = false): UnifiedSession[] {
    const now = this.now();
    const working = new Set(this.opts.getWorkingIds());
    return sessions
      .filter((s) => {
        if (s.harness === 'master' || s.hidden || s.isSubagent || s.status === 'archived') return false;
        const e = this.entries[s.id];
        if (e && s.updatedAt <= e.updatedAt) return false;
        if (!e && now - s.updatedAt > FIRST_SEEN_WINDOW_MS) return false;
        if (force) return true;
        const busy = working.has(s.id) || s.status === 'running';
        if (busy) return !e || now - e.at > STALE_RUNNING_MS;
        return now - s.updatedAt >= QUIET_MS;
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Called after every discovery pass; schedules a batched refresh when threads changed. */
  noteSessions(sessions: UnifiedSession[]): void {
    this.latest = sessions;
    if (!this.opts.getConfig().enabled || this.running || this.timer) return;
    const changed = sessions.some((s) => {
      if (s.harness === 'master' || s.hidden || s.isSubagent) return false;
      const e = this.entries[s.id];
      return e ? s.updatedAt > e.updatedAt : this.now() - s.updatedAt <= FIRST_SEEN_WINDOW_MS;
    });
    if (!changed) return;
    // Back off after failed calls (missing binary, auth, rate limits): 90 s, 3 min, 6 min … 30 min.
    const gap = Math.min(MIN_GAP_MS * 2 ** this.failures, 30 * 60_000);
    const delay = Math.max(QUIET_MS, this.lastRunAt + gap - this.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh();
    }, delay);
    this.timer.unref?.();
  }

  /** Summarizes pending threads now. `force` ignores the quiet/idle gating; `sessionIds` narrows it. */
  refresh(opts: { force?: boolean; sessionIds?: string[] } = {}): Promise<SummaryRefreshResult> {
    if (this.running) return this.running;
    this.running = this.run(opts).then((r) => {
      this.failures = r.ok || r.summarized > 0 || (r.pending === 0 && !r.error) ? 0 : this.failures + 1;
      return r;
    }).finally(() => {
      this.running = null;
      this.lastRunAt = this.now();
    });
    return this.running;
  }

  private async run(opts: { force?: boolean; sessionIds?: string[] }): Promise<SummaryRefreshResult> {
    const cfg = this.opts.getConfig();
    if (!cfg.enabled && !opts.force) return { ok: true, summarized: 0, pending: 0 };
    let pending = this.pendingSessions(this.latest, opts.force);
    if (opts.sessionIds?.length) {
      const want = new Set(opts.sessionIds);
      pending = this.latest.filter((s) => want.has(s.id));
    }
    const batch = pending.slice(0, BATCH);
    if (batch.length === 0) return { ok: true, summarized: 0, pending: 0 };

    const threads: Array<{
      n: number;
      session: UnifiedSession;
      title: string;
      project: string;
      previous?: string;
      digest: string;
      digestHash: string;
    }> = [];
    let skippedUnchanged = 0;
    for (const s of batch) {
      const prev = this.entries[s.id];
      let digest = '';
      try {
        const t = await this.opts.loadTranscript(s.id, 16);
        digest = buildThreadDigest(t.messages, prev?.updatedAt ?? 0);
      } catch {
        digest = '';
      }
      if (!digest && s.lastUserText) digest = `P: ${s.lastUserText}`;
      const digestHash = digestHashFor(s.title, digest);
      // Skip calling the model when conversation text has not changed since the last summary
      // (e.g. metadata/mtime flush without a new user or assistant message).
      if (!opts.force && prev?.digestHash && prev.digestHash === digestHash) {
        this.entries[s.id] = { ...prev, updatedAt: s.updatedAt };
        skippedUnchanged++;
        continue;
      }
      threads.push({
        n: threads.length + 1,
        session: s,
        title: s.title,
        project: s.projectName || path.basename(s.cwd || '') || s.harness,
        previous: prev?.text,
        digest,
        digestHash,
      });
    }
    if (threads.length === 0) {
      if (skippedUnchanged > 0) this.save();
      return { ok: true, summarized: 0, pending: Math.max(0, pending.length - batch.length) };
    }

    let reply: { text: string; costUsd?: number; usage?: Partial<SummarizerModelUsage> };
    try {
      reply = await (this.opts.callModel ?? callClaude)(buildPrompt(threads), cfg.model);
    } catch (e) {
      return { ok: false, summarized: 0, pending: pending.length, error: (e as Error).message };
    }
    const parsed = parseSummaryReply(reply.text);
    const at = this.now();
    const runRecord: SummarizerRunRecord = {
      at,
      model: cfg.model,
      threads: threads.length,
      inputTokens: Math.max(0, Number(reply.usage?.inputTokens || 0)),
      cacheReadTokens: Math.max(0, Number(reply.usage?.cacheReadTokens || 0)),
      cacheCreationTokens: Math.max(0, Number(reply.usage?.cacheCreationTokens || 0)),
      outputTokens: Math.max(0, Number(reply.usage?.outputTokens || 0)),
      costUsd: Math.max(0, Number(reply.costUsd || 0)),
    };
    this.recordUsageRun(runRecord);
    const runTokens = totalTokensOf(runRecord);

    let summarized = 0;
    for (const t of threads) {
      const s = parsed.get(t.n);
      if (!s) continue;
      this.entries[t.session.id] = {
        text: s,
        updatedAt: t.session.updatedAt,
        at,
        digestHash: t.digestHash,
      };
      summarized++;
    }
    if (summarized > 0 || skippedUnchanged > 0) {
      this.save();
      if (summarized > 0) this.opts.onUpdated();
    }
    return {
      ok: summarized > 0,
      summarized,
      pending: Math.max(0, pending.length - summarized - skippedUnchanged),
      costUsd: reply.costUsd,
      tokens: runTokens > 0 ? runTokens : undefined,
    };
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.entries));
      fs.renameSync(tmp, this.filePath);
    } catch {
      // best effort; summaries are regenerable
    }
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
