import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';
import type {
  DailySpendPoint,
  HarnessUsageSummary,
  UsageQuotaWindow,
  UsageSnapshot,
} from '../../shared/types';
import { querySqliteReadOnly } from '../utils/sqlite';
import { whichBinary } from '../utils/system';

const execFileAsync = promisify(execFile);

const HOME = os.homedir();
const CLAUDE_PLAN_HISTORY = path.join(HOME, '.config', 'Claude', 'plan-usage-history.json');
const CLAUDE_PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const CODEX_SESSIONS_DIR = path.join(HOME, '.codex', 'sessions');
const CODEX_STATE_DB = path.join(HOME, '.codex', 'state_5.sqlite');
const AGY_APP_BRAIN = path.join(HOME, '.gemini', 'antigravity', 'brain');
const AGY_CLI_BRAIN = path.join(HOME, '.gemini', 'antigravity-cli', 'brain');
const MUSE_SESSIONS_DIR = path.join(
  process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share'),
  'muse',
  'sessions'
);
const USAGE_CACHE_PATH = path.join(HOME, '.config', 'super-harness', 'usage-cache.json');

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

interface FileHourBucket {
  /** Hour bucket epoch ms (floored to 1 hour) */
  h: number;
  /** USD spend in this hour */
  s: number;
  /** Total tokens in this hour */
  t: number;
}

interface CachedFileSummary {
  mtimeMs: number;
  size: number;
  buckets: FileHourBucket[];
  /** Optional latest Codex rate limits snapshot from this rollout */
  rlTs?: number;
  rl?: Record<string, unknown>;
}

interface CachedAgyLiveQuota {
  fetchedAt: number;
  windows: UsageQuotaWindow[];
  creditsBalance?: number;
}

export interface MuseQuotaSample {
  t: number;
  w?: number;
  wk?: number;
}

interface DiskUsageCache {
  version: number;
  files: Record<string, CachedFileSummary>;
  agyLiveQuota?: CachedAgyLiveQuota;
  museQuotaSamples?: MuseQuotaSample[];
}

interface SpendBucketAccumulator {
  spend5h: number;
  spend24h: number;
  spend7d: number;
  spend14d: number;
  tokens7d: number;
  byDate: Map<string, { spend: number; tokens: number }>;
}

function localDateKey(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function createAccumulator(): SpendBucketAccumulator {
  return {
    spend5h: 0,
    spend24h: 0,
    spend7d: 0,
    spend14d: 0,
    tokens7d: 0,
    byDate: new Map(),
  };
}

function foldBuckets(
  acc: SpendBucketAccumulator,
  buckets: FileHourBucket[],
  now: number
): void {
  const currentHour = Math.floor(now / HOUR_MS) * HOUR_MS;
  for (const b of buckets) {
    const age = currentHour - b.h;
    if (age < -HOUR_MS || age > 14 * DAY_MS) continue;
    acc.spend14d += b.s;
    if (age <= 7 * DAY_MS) {
      acc.spend7d += b.s;
      acc.tokens7d += b.t;
      const key = localDateKey(b.h + HOUR_MS / 2);
      const cur = acc.byDate.get(key) ?? { spend: 0, tokens: 0 };
      cur.spend += b.s;
      cur.tokens += b.t;
      acc.byDate.set(key, cur);
    }
    if (age <= DAY_MS) acc.spend24h += b.s;
    if (age <= 5 * HOUR_MS) acc.spend5h += b.s;
  }
}

function addEventToHourMap(
  hourMap: Map<number, FileHourBucket>,
  ts: number,
  spendUsd: number,
  tokens: number
): void {
  if (!Number.isFinite(ts) || ts <= 0) return;
  const h = Math.floor(ts / HOUR_MS) * HOUR_MS;
  const cur = hourMap.get(h);
  if (cur) {
    cur.s += spendUsd;
    cur.t += tokens;
  } else {
    hourMap.set(h, { h, s: spendUsd, t: tokens });
  }
}

function buildDailySeries7d(acc: SpendBucketAccumulator, now: number): DailySpendPoint[] {
  const out: DailySpendPoint[] = [];
  for (let i = 6; i >= 0; i--) {
    const t = now - i * DAY_MS;
    const d = new Date(t);
    const key = localDateKey(t);
    const entry = acc.byDate.get(key);
    out.push({
      date: key,
      dayLabel: DAY_NAMES[d.getDay()],
      spendUsd: round2(entry?.spend ?? 0),
      tokens: Math.round(entry?.tokens ?? 0),
    });
  }
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function priceClaudeTokens(
  model: string,
  input: number,
  cacheCreate: number,
  cacheRead: number,
  output: number
): number {
  const m = model.toLowerCase();
  let inRate = 3.0;
  let outRate = 15.0;
  let cacheWriteRate = 3.75;
  let cacheReadRate = 0.3;

  if (m.includes('opus')) {
    inRate = 5.0;
    outRate = 25.0;
    cacheWriteRate = 6.25;
    cacheReadRate = 0.5;
  } else if (m.includes('haiku')) {
    inRate = 1.0;
    outRate = 5.0;
    cacheWriteRate = 1.25;
    cacheReadRate = 0.1;
  }

  return (
    (input * inRate +
      cacheCreate * cacheWriteRate +
      cacheRead * cacheReadRate +
      output * outRate) /
    1_000_000
  );
}

export function priceCodexTokens(
  model: string,
  uncachedInput: number,
  cachedInput: number,
  output: number
): number {
  const m = model.toLowerCase();
  let inRate = 2.5;
  let cachedRate = 0.25;
  let outRate = 15.0;

  if (m.includes('mini') || m.includes('spark') || m.includes('nano')) {
    inRate = 0.4;
    cachedRate = 0.04;
    outRate = 1.6;
  } else if (m.includes('pro')) {
    inRate = 5.0;
    cachedRate = 0.5;
    outRate = 25.0;
  }

  return (uncachedInput * inRate + cachedInput * cachedRate + output * outRate) / 1_000_000;
}

function priceMuseTokens(
  model: string,
  uncachedInput: number,
  cacheWrite: number,
  cacheRead: number,
  output: number
): number {
  const m = model.toLowerCase();
  let inRate = 3.0;
  let cacheWriteRate = 3.75;
  let cacheReadRate = 0.3;
  let outRate = 15.0;

  if (m.includes('mini') || m.includes('flash') || m.includes('fast') || m.includes('lite')) {
    inRate = 0.8;
    cacheWriteRate = 1.0;
    cacheReadRate = 0.08;
    outRate = 4.0;
  }

  return (
    (uncachedInput * inRate +
      cacheWrite * cacheWriteRate +
      cacheRead * cacheReadRate +
      output * outRate) /
    1_000_000
  );
}

export function priceAntigravityTokens(
  model: string,
  uncachedInput: number,
  cacheRead: number,
  output: number
): number {
  const m = model.toLowerCase();
  if (m.includes('claude')) {
    return priceClaudeTokens(model, uncachedInput, 0, cacheRead, output);
  }
  if (m.includes('flash')) {
    return (uncachedInput * 0.3 + cacheRead * 0.03 + output * 2.5) / 1_000_000;
  }
  // Gemini Pro flagship API-equivalent rates ($1.25/M in, $0.125/M cached, $10/M out)
  return (uncachedInput * 1.25 + cacheRead * 0.125 + output * 10.0) / 1_000_000;
}

async function scanJsonlLines(
  filePath: string,
  onLine: (line: string) => void
): Promise<void> {
  return new Promise((resolve) => {
    let stream: fs.ReadStream;
    try {
      stream = fs.createReadStream(filePath, { encoding: 'utf8', highWaterMark: 64 * 1024 });
    } catch {
      resolve();
      return;
    }
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    rl.on('line', onLine);
    rl.on('close', () => resolve());
    rl.on('error', () => resolve());
    stream.on('error', () => {
      try {
        rl.close();
      } catch {
        // ignore
      }
      resolve();
    });
  });
}

const CACHE_VERSION = 2;

function loadDiskCache(): {
  files: Record<string, CachedFileSummary>;
  agyLiveQuota?: CachedAgyLiveQuota;
  museQuotaSamples: MuseQuotaSample[];
} {
  try {
    if (!fs.existsSync(USAGE_CACHE_PATH)) return { files: {}, museQuotaSamples: [] };
    const parsed = JSON.parse(fs.readFileSync(USAGE_CACHE_PATH, 'utf8')) as DiskUsageCache;
    if (parsed?.version === CACHE_VERSION && parsed.files && typeof parsed.files === 'object') {
      return {
        files: parsed.files,
        agyLiveQuota: parsed.agyLiveQuota,
        museQuotaSamples: Array.isArray(parsed.museQuotaSamples)
          ? parsed.museQuotaSamples
          : [],
      };
    }
  } catch {
    // ignore corrupt cache
  }
  return { files: {}, museQuotaSamples: [] };
}

function saveDiskCache(
  files: Record<string, CachedFileSummary>,
  agyLiveQuota?: CachedAgyLiveQuota,
  museQuotaSamples: MuseQuotaSample[] = []
): void {
  try {
    fs.mkdirSync(path.dirname(USAGE_CACHE_PATH), { recursive: true });
    // Prune entries older than 21 days so cache stays tiny
    const minMtime = Date.now() - 21 * DAY_MS;
    const pruned: Record<string, CachedFileSummary> = {};
    for (const [k, v] of Object.entries(files)) {
      if (v.mtimeMs >= minMtime) pruned[k] = v;
    }
    const tmp = `${USAGE_CACHE_PATH}.tmp`;
    fs.writeFileSync(
      tmp,
      JSON.stringify({ version: CACHE_VERSION, files: pruned, agyLiveQuota, museQuotaSamples }),
      'utf8'
    );
    fs.renameSync(tmp, USAGE_CACHE_PATH);
  } catch {
    // ignore write failures
  }
}

/**
 * Parses structured JSON emitted by the official `agy -p "/usage" --output-format json`
 * and `agy -p "/credits" --output-format json` CLI commands into UsageQuotaWindow[].
 */
function parseMuseResetDurationMs(raw: string): number | undefined {
  let total = 0;
  let matched = false;
  for (const m of raw.matchAll(/(\d+)\s*(d|h|m)\b/g)) {
    matched = true;
    const value = Number(m[1]);
    if (m[2] === 'd') total += value * 24 * HOUR_MS;
    else if (m[2] === 'h') total += value * HOUR_MS;
    else total += value * 60_000;
  }
  return matched ? total : undefined;
}

/**
 * Parses human `muse usage` output, e.g.:
 *   Tier: Muse Code Power Usage
 *   Window: 1% used, resets in 4h 56m
 *   Weekly: 0% used, resets in 3d 18h
 */
export function parseMuseUsageOutput(
  stdout: string,
  now: number
): { planLabel?: string; windows: UsageQuotaWindow[] } {
  const windows: UsageQuotaWindow[] = [];
  let planLabel: string | undefined;
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    const tierMatch = line.match(/^Tier:\s*(.+)$/i);
    if (tierMatch) {
      planLabel = tierMatch[1].trim();
      continue;
    }
    const windowMatch = line.match(/^Window:\s*(\d+(?:\.\d+)?)%\s*used(?:,\s*resets in\s*(.+))?$/i);
    if (windowMatch) {
      const resetMs = windowMatch[2] ? parseMuseResetDurationMs(windowMatch[2]) : undefined;
      windows.push({
        id: 'five_hour',
        label: 'Window',
        usedPercent: Number(windowMatch[1]),
        resetsAt: resetMs !== undefined ? now + resetMs : undefined,
        windowMinutes: 300,
      });
      continue;
    }
    const weeklyMatch = line.match(/^Weekly:\s*(\d+(?:\.\d+)?)%\s*used(?:,\s*resets in\s*(.+))?$/i);
    if (weeklyMatch) {
      const resetMs = weeklyMatch[2] ? parseMuseResetDurationMs(weeklyMatch[2]) : undefined;
      windows.push({
        id: 'weekly',
        label: 'Weekly (7d)',
        usedPercent: Number(weeklyMatch[1]),
        resetsAt: resetMs !== undefined ? now + resetMs : undefined,
        windowMinutes: 7 * 24 * 60,
      });
    }
  }
  return { planLabel, windows };
}

/**
 * Parses structured `muse usage --json` output (schemaVersion 1) with
 * absolute reset timestamps — preferred over the human text form, which
 * the collector keeps as a fallback for older CLIs.
 */
export function parseMuseUsageJson(
  stdout: string
): { planLabel?: string; windows: UsageQuotaWindow[]; asOfMs?: number } | null {
  try {
    const parsed = JSON.parse(stdout.trim()) as {
      allowance?: {
        asOfMs?: number;
        tier?: string;
        window?: { usedPercent?: number; resetsAtMs?: number };
        weekly?: { usedPercent?: number; resetsAtMs?: number };
      };
    };
    const allowance = parsed.allowance;
    if (!allowance) return null;
    const windows: UsageQuotaWindow[] = [];
    if (typeof allowance.window?.usedPercent === 'number') {
      windows.push({
        id: 'five_hour',
        label: 'Window',
        usedPercent: allowance.window.usedPercent,
        resetsAt:
          typeof allowance.window.resetsAtMs === 'number'
            ? allowance.window.resetsAtMs
            : undefined,
        windowMinutes: 300,
      });
    }
    if (typeof allowance.weekly?.usedPercent === 'number') {
      windows.push({
        id: 'weekly',
        label: 'Weekly (7d)',
        usedPercent: allowance.weekly.usedPercent,
        resetsAt:
          typeof allowance.weekly.resetsAtMs === 'number'
            ? allowance.weekly.resetsAtMs
            : undefined,
        windowMinutes: 7 * 24 * 60,
      });
    }
    if (windows.length === 0) return null;
    return {
      planLabel: typeof allowance.tier === 'string' ? allowance.tier : undefined,
      windows,
      asOfMs: typeof allowance.asOfMs === 'number' ? allowance.asOfMs : undefined,
    };
  } catch {
    return null;
  }
}

const MUSE_QUOTA_SAMPLE_MIN_GAP_MS = 10 * 60_000;
const MUSE_QUOTA_SAMPLE_MAX_AGE_MS = 14 * DAY_MS;

/**
 * Appends a Muse quota sample to the persisted history (throttled to one
 * per 10 min unless a percentage changed, pruned to 14 days). Super Harness
 * builds this history itself — Muse exposes no quota history file like
 * Claude Desktop's plan-usage-history — so "+N% today" appears once the app
 * has sampled across a day boundary. Returns the same array reference when
 * nothing changed so callers can detect no-ops.
 */
export function appendMuseQuotaSample(
  samples: MuseQuotaSample[],
  sample: MuseQuotaSample,
  now: number
): MuseQuotaSample[] {
  const pruned = samples.filter((s) => now - s.t <= MUSE_QUOTA_SAMPLE_MAX_AGE_MS);
  const last = pruned[pruned.length - 1];
  if (
    last &&
    sample.t - last.t < MUSE_QUOTA_SAMPLE_MIN_GAP_MS &&
    last.w === sample.w &&
    last.wk === sample.wk
  ) {
    return samples;
  }
  const next = [...pruned, sample];
  return next.length > 1000 ? next.slice(next.length - 1000) : next;
}

/**
 * "+N% today" delta for one quota window, mirroring Claude's sample math:
 * latest sample at or before (now − 24h) vs the current value. Negative
 * movement (a reset was crossed) yields undefined so the card hides it.
 */
export function computeMuseQuotaDelta24h(
  samples: MuseQuotaSample[],
  key: 'w' | 'wk',
  currentPercent: number,
  now: number
): number | undefined {
  const target24h = now - DAY_MS;
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i];
    if (s.t <= target24h && typeof s[key] === 'number') {
      const diff = Math.round(currentPercent - (s[key] as number));
      return diff >= 0 ? diff : undefined;
    }
  }
  return undefined;
}

export function parseAntigravityCliUsageJson(
  usageStdout: string,
  creditsStdout?: string
): { windows: UsageQuotaWindow[]; creditsBalance?: number } {
  const windows: UsageQuotaWindow[] = [];

  try {
    const parsed = JSON.parse(usageStdout.trim()) as {
      command?: {
        name?: string;
        data?: {
          groups?: Array<{
            name?: string;
            buckets?: Array<{
              id?: string;
              name?: string;
              window?: string;
              remaining_fraction?: number;
              reset_time?: string;
            }>;
          }>;
        };
      };
    };

    const groups = parsed?.command?.data?.groups ?? [];
    for (const grp of groups) {
      const grpName = grp.name || 'Antigravity';
      const isGemini = /gemini/i.test(grpName);
      const shortGroup = isGemini
        ? 'Gemini'
        : /claude|gpt/i.test(grpName)
          ? 'Claude & GPT'
          : grpName;

      // Sort 5h before weekly within each group
      const buckets = [...(grp.buckets ?? [])].sort((a, b) => {
        const rank = (w?: string) => (w === '5h' ? 0 : w === 'weekly' ? 1 : 2);
        return rank(a.window) - rank(b.window);
      });

      for (const b of buckets) {
        if (typeof b.remaining_fraction !== 'number' || !Number.isFinite(b.remaining_fraction)) {
          continue;
        }
        const usedPercent = round2(Math.min(100, Math.max(0, (1 - b.remaining_fraction) * 100)));
        const parsedReset = b.reset_time ? Date.parse(b.reset_time) : NaN;
        // Ignore epoch-zero placeholder timestamps (1970-01-01T00:00:00Z) on unused buckets
        const resetsAt =
          Number.isFinite(parsedReset) && parsedReset > 86_400_000 ? parsedReset : undefined;

        const is5h = b.window === '5h';
        const isWeekly = b.window === 'weekly';
        // Give primary Gemini buckets canonical 'five_hour'/'weekly' IDs for the All-Harnesses rollup
        const id = isGemini
          ? is5h
            ? 'five_hour'
            : isWeekly
              ? 'weekly'
              : b.id || `${shortGroup}-${b.window}`
          : b.id || `${shortGroup.toLowerCase().replace(/\W+/g, '_')}_${b.window || 'limit'}`;

        const windowLabel = is5h ? '5h limit' : isWeekly ? 'Weekly' : b.name || 'Limit';
        windows.push({
          id,
          label: `${shortGroup} · ${windowLabel}`,
          usedPercent,
          resetsAt,
          windowMinutes: is5h ? 300 : isWeekly ? 10080 : undefined,
        });
      }
    }
  } catch {
    // ignore malformed usage JSON
  }

  let creditsBalance: number | undefined;
  if (creditsStdout) {
    try {
      const cParsed = JSON.parse(creditsStdout.trim()) as {
        command?: { data?: { remaining_credits?: number } };
      };
      const val = cParsed?.command?.data?.remaining_credits;
      if (typeof val === 'number' && Number.isFinite(val)) {
        creditsBalance = val;
      }
    } catch {
      // ignore malformed credits JSON
    }
  }

  return { windows, creditsBalance };
}

function classifyCodexWindowLabel(windowMinutes?: number): { id: string; label: string } {
  if (!windowMinutes) return { id: 'primary', label: 'Plan limit' };
  if (windowMinutes <= 360) {
    const hrs = Math.round(windowMinutes / 60);
    return { id: 'five_hour', label: `${hrs}-hour` };
  }
  if (windowMinutes >= 7200) {
    const days = Math.round(windowMinutes / 1440);
    return { id: 'weekly', label: days === 7 ? 'Weekly (7d)' : `${days}-day` };
  }
  const hrs = Math.round(windowMinutes / 60);
  return { id: `win_${windowMinutes}`, label: `${hrs}h window` };
}

const AGY_LIVE_QUOTA_TTL_MS = 120_000;

/**
 * Infers the next weekly reset timestamp from historical `sd` drop-to-zero
 * transitions in Claude Desktop's `plan-usage-history.json`.
 */
export function inferWeeklyResetFromSamples(
  samples: Array<{ t: number; u?: { sd?: number } }>,
  now: number
): number | undefined {
  let prevSd: number | null = null;
  let lastResetTs: number | null = null;
  for (const s of samples) {
    const sd = s.u?.sd;
    if (typeof sd === 'number') {
      if (prevSd !== null && prevSd - sd >= 15 && sd <= 10) {
        lastResetTs = s.t;
      }
      prevSd = sd;
    }
  }
  if (!lastResetTs) return undefined;
  let nextReset = lastResetTs + 7 * DAY_MS;
  while (nextReset <= now) nextReset += 7 * DAY_MS;
  return nextReset;
}

export class UsageService {
  private cache: UsageSnapshot | null = null;
  private lastComputedAt = 0;
  private inFlight: Promise<UsageSnapshot> | null = null;
  private fileCache: Record<string, CachedFileSummary>;
  private agyLiveQuota?: CachedAgyLiveQuota;
  private museQuotaSamples: MuseQuotaSample[];
  private agyQuotaInFlight: Promise<CachedAgyLiveQuota | undefined> | null = null;

  constructor() {
    const loaded = loadDiskCache();
    this.fileCache = loaded.files;
    this.agyLiveQuota = loaded.agyLiveQuota;
    this.museQuotaSamples = loaded.museQuotaSamples;
  }

  async getUsage(force = false): Promise<UsageSnapshot> {
    const now = Date.now();
    if (!force && this.cache && now - this.lastComputedAt < 30_000) {
      return this.cache;
    }
    if (this.inFlight) return this.inFlight;

    this.inFlight = (async () => {
      let dirty = false;
      const markDirty = () => {
        dirty = true;
      };
      const [antigravity, codex, claude, muse] = await Promise.all([
        this.collectAntigravityUsage(now, markDirty, force),
        this.collectCodexUsage(now, markDirty),
        this.collectClaudeUsage(now, markDirty),
        this.collectMuseUsage(now, markDirty),
      ]);
      if (dirty) {
        saveDiskCache(this.fileCache, this.agyLiveQuota, this.museQuotaSamples);
      }
      const snapshot: UsageSnapshot = {
        antigravity,
        codex,
        claude,
        muse,
      };
      this.cache = snapshot;
      this.lastComputedAt = Date.now();
      return snapshot;
    })();

    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async fetchAntigravityLiveQuota(
    now: number,
    markDirty: () => void,
    force: boolean
  ): Promise<CachedAgyLiveQuota | undefined> {
    if (!force && this.agyLiveQuota && now - this.agyLiveQuota.fetchedAt < AGY_LIVE_QUOTA_TTL_MS) {
      return this.agyLiveQuota;
    }
    if (this.agyQuotaInFlight) return this.agyQuotaInFlight;

    this.agyQuotaInFlight = (async () => {
      try {
        const bin = await whichBinary('agy');
        if (!bin) return this.agyLiveQuota;
        const [usageRes, creditsRes] = await Promise.all([
          execFileAsync(bin, ['-p', '/usage', '--output-format', 'json'], {
            timeout: 12_000,
            maxBuffer: 2 * 1024 * 1024,
          }).catch(() => null),
          execFileAsync(bin, ['-p', '/credits', '--output-format', 'json'], {
            timeout: 12_000,
            maxBuffer: 1024 * 1024,
          }).catch(() => null),
        ]);
        if (!usageRes?.stdout) return this.agyLiveQuota;
        const parsed = parseAntigravityCliUsageJson(usageRes.stdout, creditsRes?.stdout);
        if (parsed.windows.length > 0) {
          this.agyLiveQuota = {
            fetchedAt: Date.now(),
            windows: parsed.windows,
            creditsBalance: parsed.creditsBalance,
          };
          markDirty();
        }
        return this.agyLiveQuota;
      } catch {
        return this.agyLiveQuota;
      }
    })();

    try {
      return await this.agyQuotaInFlight;
    } finally {
      this.agyQuotaInFlight = null;
    }
  }

  private async collectMuseUsage(
    now: number,
    markDirty: () => void
  ): Promise<HarnessUsageSummary> {
    const cutoff = now - 14 * DAY_MS;
    const recentFiles: Array<{ path: string; mtimeMs: number; size: number }> = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 5 || !fs.existsSync(dir)) return;
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
        } else if (e.isFile() && e.name.endsWith('.jsonl')) {
          try {
            const st = fs.statSync(p);
            if (st.mtimeMs >= cutoff) {
              recentFiles.push({ path: p, mtimeMs: st.mtimeMs, size: st.size });
            }
          } catch {
            // ignore
          }
        }
      }
    };
    walk(MUSE_SESSIONS_DIR, 0);

    const acc = createAccumulator();
    for (const file of recentFiles) {
      const cacheKey = `muse:${file.path}`;
      const cached = this.fileCache[cacheKey];
      if (cached && cached.mtimeMs === file.mtimeMs && cached.size === file.size) {
        foldBuckets(acc, cached.buckets, now);
        continue;
      }

      const hourMap = new Map<number, FileHourBucket>();
      await scanJsonlLines(file.path, (line) => {
        if (!line.includes('"model_completed"')) return;
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }
        const payload = obj.payload as Record<string, unknown> | undefined;
        const ev = payload?.event as Record<string, unknown> | undefined;
        if (!ev || ev.kind !== 'model_completed') return;
        const usage = ev.usage as Record<string, unknown> | undefined;
        if (!usage) return;

        const rawTs = Number(obj.recorded_at || 0);
        const ts = rawTs > 1e14 ? Math.floor(rawTs / 1000) : rawTs;
        if (!Number.isFinite(ts) || ts < cutoff) return;

        const model = String(ev.model || 'muse-wonder-full-1.0');
        const input = Math.max(0, Number(usage.input_tokens || 0));
        const cacheRead = Math.max(
          0,
          Number(usage.cache_read_tokens || usage.cached_tokens || 0)
        );
        const cacheWrite = Math.max(0, Number(usage.cache_write_tokens || 0));
        const output =
          Math.max(0, Number(usage.output_tokens || 0)) +
          Math.max(0, Number(usage.reasoning_tokens || 0));
        const uncachedInput = Math.max(0, input - cacheRead);
        const totalTokens = input + cacheWrite + output;
        if (totalTokens <= 0) return;

        const spend = priceMuseTokens(model, uncachedInput, cacheWrite, cacheRead, output);
        addEventToHourMap(hourMap, ts, spend, totalTokens);
      });

      const buckets = Array.from(hourMap.values());
      this.fileCache[cacheKey] = { mtimeMs: file.mtimeMs, size: file.size, buckets };
      markDirty();
      foldBuckets(acc, buckets, now);
    }

    const base: HarnessUsageSummary = {
      harness: 'muse',
      updatedAt: now,
      planLabel: 'Muse',
      barPercent: null,
      barIsEstimated: false,
      windows: [],
      spend5hUsd: round2(acc.spend5h),
      spend24hUsd: round2(acc.spend24h),
      spend7dUsd: round2(acc.spend7d),
      spend14dUsd: round2(acc.spend14d),
      tokens7d: Math.round(acc.tokens7d),
      dailySpend7d: buildDailySeries7d(acc, now),
      spendIsEstimated: true,
      note: 'Quota from `muse usage`; API-equivalent spend from local transcripts',
    };
    try {
      const bin = await whichBinary('muse');
      if (!bin) return base;
      // Prefer structured JSON (absolute reset timestamps); fall back to the
      // human text form for older CLIs without `--json`.
      let quota: { planLabel?: string; windows: UsageQuotaWindow[] } | null = null;
      try {
        const { stdout } = await execFileAsync(bin, ['usage', '--json'], {
          timeout: 8000,
          maxBuffer: 256 * 1024,
        });
        quota = parseMuseUsageJson(stdout);
      } catch {
        quota = null;
      }
      if (!quota) {
        const { stdout } = await execFileAsync(bin, ['usage'], {
          timeout: 8000,
          maxBuffer: 256 * 1024,
        });
        quota = parseMuseUsageOutput(stdout, now);
      }
      const { planLabel, windows } = quota;
      if (windows.length === 0) return base;

      // Record quota history so the hover card can show Claude-style
      // "+N% today" deltas, then decorate each window with its delta.
      const fiveHour = windows.find((w) => w.id === 'five_hour');
      const weekly = windows.find((w) => w.id === 'weekly');
      const prevSamples = this.museQuotaSamples;
      this.museQuotaSamples = appendMuseQuotaSample(
        prevSamples,
        { t: now, w: fiveHour?.usedPercent, wk: weekly?.usedPercent },
        now
      );
      if (this.museQuotaSamples !== prevSamples) markDirty();
      if (fiveHour) {
        fiveHour.delta24h = computeMuseQuotaDelta24h(
          this.museQuotaSamples,
          'w',
          fiveHour.usedPercent,
          now
        );
      }
      if (weekly) {
        weekly.delta24h = computeMuseQuotaDelta24h(
          this.museQuotaSamples,
          'wk',
          weekly.usedPercent,
          now
        );
      }

      return {
        ...base,
        planLabel: planLabel || base.planLabel,
        barPercent: Math.max(...windows.map((w) => w.usedPercent)),
        windows,
      };
    } catch {
      return base;
    }
  }

  private async collectClaudeUsage(
    now: number,
    markDirty: () => void
  ): Promise<HarnessUsageSummary> {
    const windows: UsageQuotaWindow[] = [];
    let updatedAt = now;

    // 1. Official Claude Desktop plan-usage-history.json (5h, 7d weekly, extra usage)
    try {
      if (fs.existsSync(CLAUDE_PLAN_HISTORY)) {
        const parsed = JSON.parse(fs.readFileSync(CLAUDE_PLAN_HISTORY, 'utf8')) as {
          samples?: Array<{ t: number; u?: { fh?: number; sd?: number; xu?: number } }>;
        };
        const samples = Array.isArray(parsed.samples) ? parsed.samples : [];
        if (samples.length > 0) {
          const latest = samples[samples.length - 1];
          updatedAt = latest.t || now;

          let fhVal: number | null = null;
          for (let i = samples.length - 1; i >= 0; i--) {
            const s = samples[i];
            if (now - s.t > 5 * HOUR_MS) break;
            if (typeof s.u?.fh === 'number') {
              fhVal = s.u.fh;
              break;
            }
          }
          if (fhVal !== null) {
            windows.push({
              id: 'five_hour',
              label: '5-hour session',
              usedPercent: Math.min(100, Math.max(0, round2(fhVal))),
              windowMinutes: 300,
            });
          } else if (now - latest.t < 2 * HOUR_MS && typeof latest.u?.sd === 'number') {
            windows.push({
              id: 'five_hour',
              label: '5-hour session',
              usedPercent: 0,
              windowMinutes: 300,
            });
          }

          let sdVal: number | null = null;
          let sdTs = 0;
          for (let i = samples.length - 1; i >= 0; i--) {
            const s = samples[i];
            if (typeof s.u?.sd === 'number') {
              sdVal = s.u.sd;
              sdTs = s.t;
              break;
            }
          }
          if (sdVal !== null && now - sdTs < 7 * DAY_MS) {
            let delta24h: number | undefined;
            const target24h = sdTs - DAY_MS;
            for (let i = samples.length - 1; i >= 0; i--) {
              const s = samples[i];
              if (s.t <= target24h && typeof s.u?.sd === 'number') {
                const diff = Math.round(sdVal - s.u.sd);
                if (diff >= 0) delta24h = diff;
                break;
              }
            }
            const weeklyResetsAt = inferWeeklyResetFromSamples(samples, now);
            windows.push({
              id: 'weekly',
              label: 'Weekly limit',
              usedPercent: Math.min(100, Math.max(0, round2(sdVal))),
              resetsAt: weeklyResetsAt,
              delta24h,
              windowMinutes: 10080,
            });
          }

          for (let i = samples.length - 1; i >= 0; i--) {
            const s = samples[i];
            if (now - s.t > 7 * DAY_MS) break;
            if (typeof s.u?.xu === 'number' && s.u.xu > 0) {
              windows.push({
                id: 'extra',
                label: 'Extra usage',
                usedPercent: Math.min(100, Math.max(0, round2(s.u.xu))),
              });
              break;
            }
          }
        }
      }
    } catch {
      // ignore parse error
    }

    // 2. Scan Claude transcripts modified in last 14 days (with per-file mtime+size cache!)
    const acc = createAccumulator();
    const cutoff = now - 14 * DAY_MS;
    const recentFiles: Array<{ path: string; mtimeMs: number; size: number }> = [];

    if (fs.existsSync(CLAUDE_PROJECTS_DIR)) {
      try {
        for (const projDir of fs.readdirSync(CLAUDE_PROJECTS_DIR)) {
          const fullDir = path.join(CLAUDE_PROJECTS_DIR, projDir);
          let entries: fs.Dirent[];
          try {
            entries = fs.readdirSync(fullDir, { withFileTypes: true });
          } catch {
            continue;
          }
          for (const e of entries) {
            if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
            const p = path.join(fullDir, e.name);
            try {
              const st = fs.statSync(p);
              if (st.mtimeMs >= cutoff) {
                recentFiles.push({ path: p, mtimeMs: st.mtimeMs, size: st.size });
              }
            } catch {
              // ignore
            }
          }
        }
      } catch {
        // ignore
      }
    }

    for (const file of recentFiles) {
      const cacheKey = `claude:${file.path}`;
      const cached = this.fileCache[cacheKey];
      if (cached && cached.mtimeMs === file.mtimeMs && cached.size === file.size) {
        foldBuckets(acc, cached.buckets, now);
        continue;
      }

      const msgUsageById = new Map<
        string,
        { ts: number; model: string; input: number; cacheCreate: number; cacheRead: number; output: number }
      >();

      await scanJsonlLines(file.path, (line) => {
        if (!line.includes('"usage"') || !line.includes('"assistant"')) return;
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }
        if (obj.type !== 'assistant') return;
        const msg = obj.message as Record<string, unknown> | undefined;
        const usage = msg?.usage as Record<string, unknown> | undefined;
        if (!usage) return;

        const ts =
          typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : Number(obj.timestamp || 0);
        if (!Number.isFinite(ts) || ts < cutoff) return;

        const msgId = String(msg?.id || obj.uuid || `${ts}`);
        const model = String(msg?.model || 'claude-sonnet');
        const input = Number(usage.input_tokens || 0);
        const cacheCreate = Number(usage.cache_creation_input_tokens || 0);
        const cacheRead = Number(usage.cache_read_input_tokens || 0);
        const output = Number(usage.output_tokens || 0);

        const prev = msgUsageById.get(msgId);
        if (!prev || output >= prev.output) {
          msgUsageById.set(msgId, { ts, model, input, cacheCreate, cacheRead, output });
        }
      });

      const hourMap = new Map<number, FileHourBucket>();
      for (const rec of msgUsageById.values()) {
        const spend = priceClaudeTokens(
          rec.model,
          rec.input,
          rec.cacheCreate,
          rec.cacheRead,
          rec.output
        );
        const totalTokens = rec.input + rec.cacheCreate + rec.cacheRead + rec.output;
        addEventToHourMap(hourMap, rec.ts, spend, totalTokens);
      }

      const buckets = Array.from(hourMap.values());
      this.fileCache[cacheKey] = { mtimeMs: file.mtimeMs, size: file.size, buckets };
      markDirty();
      foldBuckets(acc, buckets, now);
    }

    const weekly = windows.find((w) => w.id === 'weekly');
    const fiveHour = windows.find((w) => w.id === 'five_hour');
    const barPercent =
      weekly && fiveHour
        ? Math.max(weekly.usedPercent, fiveHour.usedPercent)
        : (weekly?.usedPercent ?? fiveHour?.usedPercent ?? null);

    return {
      harness: 'claude',
      updatedAt,
      planLabel: 'Claude Plan',
      barPercent,
      barIsEstimated: false,
      windows,
      spend5hUsd: round2(acc.spend5h),
      spend24hUsd: round2(acc.spend24h),
      spend7dUsd: round2(acc.spend7d),
      spend14dUsd: round2(acc.spend14d),
      tokens7d: Math.round(acc.tokens7d),
      dailySpend7d: buildDailySeries7d(acc, now),
      spendIsEstimated: true,
      note: 'API-equivalent spend from local transcripts',
    };
  }

  private async collectCodexUsage(
    now: number,
    markDirty: () => void
  ): Promise<HarnessUsageSummary> {
    const cutoff = now - 14 * DAY_MS;

    const modelByThread = new Map<string, string>();
    try {
      const rows = await querySqliteReadOnly<{ id: string; model: string | null }>(
        CODEX_STATE_DB,
        'SELECT id, model FROM threads'
      );
      for (const r of rows) {
        if (r.id && r.model) modelByThread.set(r.id, r.model);
      }
    } catch {
      // ignore
    }

    const recentFiles: Array<{ path: string; mtimeMs: number; size: number }> = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 4 || !fs.existsSync(dir)) return;
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
        } else if (e.isFile() && e.name.endsWith('.jsonl')) {
          try {
            const st = fs.statSync(p);
            if (st.mtimeMs >= cutoff) {
              recentFiles.push({ path: p, mtimeMs: st.mtimeMs, size: st.size });
            }
          } catch {
            // ignore
          }
        }
      }
    };
    walk(CODEX_SESSIONS_DIR, 0);
    recentFiles.sort((a, b) => b.mtimeMs - a.mtimeMs);

    let latestRlTs = 0;
    let latestRateLimits: Record<string, unknown> | null = null;
    const acc = createAccumulator();

    for (const file of recentFiles) {
      const cacheKey = `codex:${file.path}`;
      const cached = this.fileCache[cacheKey];
      if (cached && cached.mtimeMs === file.mtimeMs && cached.size === file.size) {
        foldBuckets(acc, cached.buckets, now);
        if (cached.rl && cached.rlTs && cached.rlTs > latestRlTs) {
          latestRlTs = cached.rlTs;
          latestRateLimits = cached.rl;
        }
        continue;
      }

      const base = path.basename(file.path, '.jsonl');
      const uuidMatch = base.match(
        /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i
      );
      const threadModel = (uuidMatch && modelByThread.get(uuidMatch[1])) || 'gpt-5-codex';

      const hourMap = new Map<number, FileHourBucket>();
      const seenResponseIds = new Set<string>();
      let fileRlTs = 0;
      let fileRl: Record<string, unknown> | undefined;

      await scanJsonlLines(file.path, (line) => {
        const hasRateLimits = line.includes('"rate_limits"');
        const hasTokenRecord = line.includes('"token_usage_record"');
        if (!hasRateLimits && !hasTokenRecord) return;

        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }

        const ts =
          typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : Number(obj.timestamp || 0);
        if (!Number.isFinite(ts) || ts <= 0) return;

        const payload = (obj.payload ?? {}) as Record<string, unknown>;

        if (hasRateLimits && payload.rate_limits && typeof payload.rate_limits === 'object') {
          if (ts > fileRlTs) {
            fileRlTs = ts;
            fileRl = payload.rate_limits as Record<string, unknown>;
          }
        }

        if (hasTokenRecord && obj.type === 'token_usage_record' && ts >= cutoff) {
          const respId = typeof payload.response_id === 'string' ? payload.response_id : '';
          if (respId) {
            if (seenResponseIds.has(respId)) return;
            seenResponseIds.add(respId);
          }
          const usage = payload.usage as Record<string, unknown> | undefined;
          if (!usage) return;
          const input = Number(usage.input_tokens || 0);
          const cachedIn = Number(usage.cached_input_tokens || 0);
          const uncached = Math.max(0, input - cachedIn);
          const output = Number(usage.output_tokens || 0);
          const totalTokens = Number(usage.total_tokens || input + output);
          const tid = typeof payload.thread_id === 'string' ? payload.thread_id : '';
          const model = (tid && modelByThread.get(tid)) || threadModel;

          const spend = priceCodexTokens(model, uncached, cachedIn, output);
          addEventToHourMap(hourMap, ts, spend, totalTokens);
        }
      });

      const buckets = Array.from(hourMap.values());
      this.fileCache[cacheKey] = {
        mtimeMs: file.mtimeMs,
        size: file.size,
        buckets,
        rlTs: fileRlTs || undefined,
        rl: fileRl,
      };
      markDirty();
      foldBuckets(acc, buckets, now);
      if (fileRl && fileRlTs > latestRlTs) {
        latestRlTs = fileRlTs;
        latestRateLimits = fileRl;
      }
    }

    const windows: UsageQuotaWindow[] = [];
    let creditsBalance: number | undefined;
    let planLabel: string | undefined;

    if (latestRateLimits) {
      const rl = latestRateLimits as {
        primary?: { used_percent?: number; window_minutes?: number; resets_at?: number } | null;
        secondary?: { used_percent?: number; window_minutes?: number; resets_at?: number } | null;
        credits?: { has_credits?: boolean; balance?: string | number } | null;
        plan_type?: string | null;
      };

      if (rl.plan_type) {
        planLabel = `Codex ${rl.plan_type.charAt(0).toUpperCase()}${rl.plan_type.slice(1)}`;
      }

      const pushWin = (
        w: { used_percent?: number; window_minutes?: number; resets_at?: number } | null | undefined
      ) => {
        if (!w || typeof w.used_percent !== 'number') return;
        const meta = classifyCodexWindowLabel(w.window_minutes);
        const resetsAt =
          typeof w.resets_at === 'number'
            ? w.resets_at < 1e12
              ? w.resets_at * 1000
              : w.resets_at
            : undefined;
        windows.push({
          id: meta.id,
          label: meta.label,
          usedPercent: Math.min(100, Math.max(0, round2(w.used_percent))),
          resetsAt,
          windowMinutes: w.window_minutes,
        });
      };

      pushWin(rl.primary);
      pushWin(rl.secondary);
      windows.sort((a, b) => (a.windowMinutes ?? 99999) - (b.windowMinutes ?? 99999));

      if (rl.credits?.has_credits && rl.credits.balance !== undefined) {
        const bal = Number(rl.credits.balance);
        if (Number.isFinite(bal)) creditsBalance = round2(bal);
      }
    }

    const barPercent =
      windows.length > 0 ? Math.max(...windows.map((w) => w.usedPercent)) : null;

    return {
      harness: 'codex',
      updatedAt: latestRlTs || now,
      planLabel: planLabel || 'Codex',
      barPercent,
      barIsEstimated: false,
      windows,
      creditsBalance,
      spend5hUsd: round2(acc.spend5h),
      spend24hUsd: round2(acc.spend24h),
      spend7dUsd: round2(acc.spend7d),
      spend14dUsd: round2(acc.spend14d),
      tokens7d: Math.round(acc.tokens7d),
      dailySpend7d: buildDailySeries7d(acc, now),
      spendIsEstimated: true,
      note: 'API-equivalent spend from rollout token records',
    };
  }

  private async collectAntigravityUsage(
    now: number,
    markDirty: () => void,
    force = false
  ): Promise<HarnessUsageSummary> {
    const liveQuotaPromise = this.fetchAntigravityLiveQuota(now, markDirty, force);
    const cutoff = now - 14 * DAY_MS;
    const acc = createAccumulator();
    const seenIds = new Set<string>();
    const recentFiles: Array<{ path: string; mtimeMs: number; size: number }> = [];

    for (const brainDir of [AGY_APP_BRAIN, AGY_CLI_BRAIN]) {
      if (!fs.existsSync(brainDir)) continue;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(brainDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isDirectory() || seenIds.has(e.name)) continue;
        const tr = path.join(brainDir, e.name, '.system_generated', 'logs', 'transcript.jsonl');
        if (!fs.existsSync(tr)) continue;
        seenIds.add(e.name);
        try {
          const st = fs.statSync(tr);
          if (st.mtimeMs >= cutoff) {
            recentFiles.push({ path: tr, mtimeMs: st.mtimeMs, size: st.size });
          }
        } catch {
          // ignore
        }
      }
    }

    for (const file of recentFiles) {
      const cacheKey = `agy:${file.path}`;
      const cached = this.fileCache[cacheKey];
      if (cached && cached.mtimeMs === file.mtimeMs && cached.size === file.size) {
        foldBuckets(acc, cached.buckets, now);
        continue;
      }

      const hourMap = new Map<number, FileHourBucket>();
      let rollingContextTokens = 2500;
      await scanJsonlLines(file.path, (line) => {
        if (!line.trim()) return;
        let obj: Record<string, unknown>;
        try {
          obj = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }
        const stepType = String(obj.type || '');
        if (stepType === 'PLANNER_RESPONSE') {
          const ts = typeof obj.created_at === 'string' ? Date.parse(obj.created_at) : 0;
          if (ts < cutoff) return;

          const model = String(obj.model || 'gemini-pro');
          const hasRealTokens =
            typeof obj.input_tokens === 'number' ||
            typeof obj.cache_read_tokens === 'number' ||
            typeof obj.output_tokens === 'number';

          if (hasRealTokens) {
            const uncachedIn = Math.max(0, Number(obj.input_tokens || 0));
            const cacheRead = Math.max(0, Number(obj.cache_read_tokens || 0));
            const output = Math.max(0, Number(obj.output_tokens || 0));
            const spend = priceAntigravityTokens(model, uncachedIn, cacheRead, output);
            addEventToHourMap(hourMap, ts, spend, uncachedIn + cacheRead + output);
          } else {
            const contentLen = typeof obj.content === 'string' ? obj.content.length : 0;
            const thinkingLen = typeof obj.thinking === 'string' ? obj.thinking.length : 0;
            const toolLen = Array.isArray(obj.tool_calls) ? JSON.stringify(obj.tool_calls).length : 0;
            const outputEst = Math.max(20, Math.round((contentLen + thinkingLen + toolLen) / 4));
            const inputEst = Math.min(rollingContextTokens, 160_000);
            const spend = priceAntigravityTokens(model, Math.round(inputEst * 0.1), Math.round(inputEst * 0.9), outputEst);
            addEventToHourMap(hourMap, ts, spend, inputEst + outputEst);
            rollingContextTokens = Math.min(rollingContextTokens + outputEst, 180_000);
          }
        } else {
          const contentLen = typeof obj.content === 'string' ? obj.content.length : 0;
          rollingContextTokens = Math.min(
            rollingContextTokens + Math.max(20, Math.round(contentLen / 4)),
            180_000
          );
        }
      });

      const buckets = Array.from(hourMap.values());
      this.fileCache[cacheKey] = { mtimeMs: file.mtimeMs, size: file.size, buckets };
      markDirty();
      foldBuckets(acc, buckets, now);
    }

    const daily = buildDailySeries7d(acc, now);
    const liveQuota = await liveQuotaPromise;
    const windows = liveQuota?.windows ?? [];
    const primaryWindows = windows.filter((w) => w.id === 'five_hour' || w.id === 'weekly');
    const barPool = primaryWindows.length > 0 ? primaryWindows : windows;
    const barPercent =
      barPool.length > 0 ? Math.max(...barPool.map((w) => w.usedPercent)) : null;

    return {
      harness: 'antigravity',
      updatedAt: liveQuota?.fetchedAt || now,
      planLabel: 'Antigravity',
      barPercent,
      barIsEstimated: false,
      windows,
      creditsBalance: liveQuota?.creditsBalance,
      spend5hUsd: round2(acc.spend5h),
      spend24hUsd: round2(acc.spend24h),
      spend7dUsd: round2(acc.spend7d),
      spend14dUsd: round2(acc.spend14d),
      tokens7d: Math.round(acc.tokens7d),
      dailySpend7d: daily,
      spendIsEstimated: true,
      note:
        windows.length > 0
          ? 'Live quota via `agy -p /usage` · API-equivalent spend from transcripts'
          : 'Run `agy` CLI login to enable live Antigravity quota bars.',
    };
  }
}
