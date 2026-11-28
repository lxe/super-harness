import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  HarnessDetection,
  BuiltinHarnessGroup,
  HarnessGroup,
  HarnessUpdateInfo,
  HarnessUpdateJob,
} from '../../shared/types';

/**
 * Harness updates: what's installed vs the latest release, and running each harness's own
 * updater with live output. Latest versions come from each tool's own update check where it
 * keeps one (Codex `~/.codex/version.json`, agy's updater status), else the registry or
 * release channel its updater installs from. Checked at most every few hours and cached.
 */

export const LATEST_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;
/** Local checks (daemon versions, processes on an old build) are cheap and run more often. */
export const LOCAL_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const WAIT_POLL_MS = 5000;
const STEP_TIMEOUT_MS = 10 * 60 * 1000;
const LOG_LINES = 300;
const MAX_LINE = 400;

// ---------------------------------------------------------------------------------------------
// Versions

/** Pulls a version out of `--version` output (`codex-cli 0.172.0`, `Muse Code 1.4.25 (1.4.25-R9361.1)`). */
export function parseVersion(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const all = raw.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?/g);
  if (!all || all.length === 0) return null;
  // The longest form carries the most detail (Muse prints the short and the build version).
  return all.reduce((a, b) => (b.length > a.length ? b : a));
}

const PRERELEASE = /-(alpha|beta|rc|pre|next|canary|dev|snapshot)/i;

/** Compares dotted versions numerically; a pre-release sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const core = (v: string) => v.split('-')[0]!.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const ca = core(a);
  const cb = core(b);
  for (let i = 0; i < Math.max(ca.length, cb.length); i++) {
    const d = (ca[i] ?? 0) - (cb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  const pa = PRERELEASE.test(a);
  const pb = PRERELEASE.test(b);
  if (pa !== pb) return pa ? -1 : 1;
  // Same core: compare the rest numerically (Muse builds: `-R9361.1`).
  const rest = (v: string) =>
    (v.split('-').slice(1).join('-').match(/\d+/g) ?? []).map((n) => Number.parseInt(n, 10));
  const ra = rest(a);
  const rb = rest(b);
  for (let i = 0; i < Math.max(ra.length, rb.length); i++) {
    const d = (ra[i] ?? 0) - (rb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function isNewer(latest: string | null, current: string | null): boolean {
  return Boolean(latest && current && compareVersions(latest, current) > 0);
}

// ---------------------------------------------------------------------------------------------
// Per-harness knowledge

export interface UpdaterIO {
  home: string;
  now: () => number;
  /** Runs a command and returns stdout (throws on failure). */
  exec: (bin: string, args: string[], timeoutMs: number) => Promise<string>;
  fetchJson: (url: string) => Promise<unknown>;
  readFile: (p: string) => string | null;
  mtimeMs: (p: string) => number | null;
  env: NodeJS.ProcessEnv;
}

export interface LatestResult {
  version: string | null;
  source: string;
  error?: string;
}

export interface UpdateStep {
  bin: string;
  args: string[];
  env?: Record<string, string>;
  /** How the step reads to people (`codex update`). */
  display: string;
}

export interface CodexDaemonStatus {
  status?: string;
  managedCodexPath?: string;
  managedCodexVersion?: string;
  cliVersion?: string;
  appServerVersion?: string;
}

interface HarnessSpec {
  name: string;
  latest(io: UpdaterIO, current: string | null): Promise<LatestResult>;
  steps(local: LocalState): UpdateStep[];
  selfUpdating?: string;
  /** Linux `/proc/<pid>/exe` of this harness's processes; group 1 is the version when the path has one. */
  exe?: RegExp;
}

interface LocalState {
  codexDaemon?: CodexDaemonStatus | null;
}

async function npmLatest(io: UpdaterIO, pkg: string, tag = 'latest'): Promise<LatestResult> {
  const source = `npm registry (${pkg}${tag === 'latest' ? '' : `, ${tag}`})`;
  try {
    const tags = (await io.fetchJson(
      `https://registry.npmjs.org/-/package/${pkg.replace('/', '%2F')}/dist-tags`
    )) as Record<string, unknown>;
    const v = typeof tags?.[tag] === 'string' ? (tags[tag] as string) : null;
    return v ? { version: v, source } : { version: null, source, error: `No "${tag}" release listed.` };
  } catch (err) {
    return { version: null, source, error: describeError(err) };
  }
}

function readJson(io: UpdaterIO, p: string): Record<string, unknown> | null {
  const raw = io.readFile(p);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export const HARNESS_UPDATE_SPECS: Record<BuiltinHarnessGroup, HarnessSpec> = {
  codex: {
    name: 'Codex',
    async latest(io) {
      // Codex's own update check (written by the CLI) when it's recent, else npm.
      const own = readJson(io, path.join(io.home, '.codex', 'version.json'));
      const checked = typeof own?.last_checked_at === 'string' ? Date.parse(own.last_checked_at) : NaN;
      if (typeof own?.latest_version === 'string' && io.now() - checked < LATEST_CHECK_INTERVAL_MS) {
        return { version: own.latest_version, source: 'Codex’s own update check' };
      }
      return npmLatest(io, '@openai/codex');
    },
    steps(local) {
      const steps: UpdateStep[] = [{ bin: 'codex', args: ['update'], display: 'codex update' }];
      // The app-server daemon is its own install (`~/.codex/packages/app-server-daemon`); this
      // updates it and restarts the managed daemon.
      if (local.codexDaemon?.managedCodexPath) {
        steps.push({
          bin: 'codex',
          args: ['app-server', 'daemon', 'update', '--yes'],
          display: 'codex app-server daemon update --yes',
        });
      }
      return steps;
    },
    // A daemon on an old build is reported as staleDaemon (from `codex app-server daemon version`).
  },
  claude: {
    name: 'Claude Code',
    async latest(io) {
      // `claude update` follows settings.autoUpdatesChannel ("latest" unless set to "stable").
      const settings = readJson(io, path.join(io.home, '.claude', 'settings.json'));
      const channel = settings?.autoUpdatesChannel === 'stable' ? 'stable' : 'latest';
      return npmLatest(io, '@anthropic-ai/claude-code', channel);
    },
    steps: () => [{ bin: 'claude', args: ['update'], display: 'claude update' }],
    exe: /\/claude\/versions\/(\d+\.\d+\.\d+[^/ ]*)(?: \(deleted\))?$/,
  },
  pi: {
    name: 'Pi',
    latest: (io) => npmLatest(io, '@earendil-works/pi-coding-agent'),
    steps: () => [{ bin: 'pi', args: ['update', '--self'], display: 'pi update --self' }],
  },
  muse: {
    name: 'Muse',
    async latest(io) {
      // The release channel the Muse launcher (`~/.local/bin/muse`) updates from.
      const channel = io.env.MUSE_CHANNEL === 'muse-canary' ? 'muse-canary' : 'muse-stable';
      const source = `Muse ${channel} channel`;
      try {
        const doc = (await io.fetchJson(`https://api.meta.ai/muse-code/channels/${channel}`)) as {
          version?: unknown;
        };
        const v = typeof doc?.version === 'string' ? doc.version : null;
        return v ? { version: v, source } : { version: null, source, error: 'The channel lists no version.' };
      } catch (err) {
        return { version: null, source, error: describeError(err) };
      }
    },
    // The launcher's install mode downloads the channel's release and exits without starting Muse.
    steps: () => [
      {
        bin: 'muse',
        args: [],
        env: { MUSE_LAUNCHER_INSTALL: '1' },
        display: 'MUSE_LAUNCHER_INSTALL=1 muse',
      },
    ],
    selfUpdating: 'The muse launcher also checks for a new release when Muse starts (at most hourly).',
    exe: /\/muse-bin-(\d+\.\d+\.\d+[^/ ]*?)(?: \(deleted\))?$/,
  },
  antigravity: {
    name: 'Antigravity',
    async latest(io, current) {
      // agy has no "check only" command; it checks on every launch and records the outcome.
      const statusFile = path.join(io.home, '.gemini', 'antigravity-cli', 'updater', 'update_status.json');
      const status = readJson(io, statusFile);
      const source = 'agy’s own updater';
      if (!status) return { version: null, source };
      const message = typeof status.message === 'string' ? status.message : '';
      if (status.success === true && /latest/i.test(message)) return { version: current, source };
      if (status.success === false) return { version: null, source, error: message || 'The last update failed.' };
      return { version: null, source };
    },
    steps: () => [{ bin: 'agy', args: ['update'], display: 'agy update' }],
    selfUpdating: 'agy checks for updates itself each time it starts (at most every 15 minutes).',
    exe: /\/agy(?: \(deleted\))?$/,
  },
};

/** The updater for a harness, or undefined for one Superharness doesn't update (ACP agents). */
function specOf(harness: HarnessGroup): HarnessSpec | undefined {
  return Object.prototype.hasOwnProperty.call(HARNESS_UPDATE_SPECS, harness)
    ? HARNESS_UPDATE_SPECS[harness as BuiltinHarnessGroup]
    : undefined;
}

// ---------------------------------------------------------------------------------------------
// Running processes on an old build (Linux)

export interface ExeLookup {
  pids: () => Promise<number[]>;
  exeOf: (pid: number) => string | null;
}

/** Counts processes whose executable is an older build of the harness (or was replaced on disk). */
export async function countStaleProcesses(
  spec: Pick<HarnessSpec, 'exe'>,
  current: string | null,
  lookup: ExeLookup
): Promise<number> {
  if (!spec.exe) return 0;
  let n = 0;
  for (const pid of await lookup.pids()) {
    const exe = lookup.exeOf(pid);
    if (!exe) continue;
    const m = exe.match(spec.exe);
    if (!m) continue;
    if (exe.endsWith(' (deleted)')) n++;
    else if (m[1] && current && compareVersions(m[1], current) < 0) n++;
  }
  return n;
}

const linuxExeLookup: ExeLookup = {
  async pids() {
    if (process.platform !== 'linux') return [];
    try {
      const uid = process.getuid?.();
      return fs
        .readdirSync('/proc')
        .filter((d) => /^\d+$/.test(d))
        .map(Number)
        .filter((pid) => {
          if (uid === undefined) return true;
          try {
            return fs.statSync(`/proc/${pid}`).uid === uid;
          } catch {
            return false;
          }
        });
    } catch {
      return [];
    }
  },
  exeOf(pid) {
    try {
      return fs.readlinkSync(`/proc/${pid}/exe`);
    } catch {
      return null;
    }
  },
};

// ---------------------------------------------------------------------------------------------
// Running an updater

export function cleanOutputLine(line: string): string {
  // Progress bars redraw with \r; keep the last frame. Drop ANSI colour and cursor codes.
  const last = line.split('\r').filter((s) => s.trim()).pop() ?? '';
  return last
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .trimEnd()
    .slice(0, MAX_LINE);
}

export type StepRunner = (step: UpdateStep, onLine: (line: string) => void) => Promise<number>;

const spawnStep: StepRunner = (step, onLine) =>
  new Promise((resolve) => {
    let child;
    try {
      child = spawn(step.bin, step.args, {
        env: { ...process.env, ...step.env, NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      onLine(describeError(err));
      resolve(127);
      return;
    }
    const timer = setTimeout(() => {
      onLine(`Stopped after ${STEP_TIMEOUT_MS / 60000} minutes without finishing.`);
      child.kill('SIGTERM');
    }, STEP_TIMEOUT_MS);
    const feed = (stream: NodeJS.ReadableStream | null) => {
      let buf = '';
      stream?.setEncoding('utf8');
      stream?.on('data', (chunk: string) => {
        buf += chunk;
        const parts = buf.split('\n');
        buf = parts.pop() ?? '';
        for (const p of parts) onLine(p);
      });
      stream?.on('end', () => {
        if (buf) onLine(buf);
        buf = '';
      });
    };
    feed(child.stdout);
    feed(child.stderr);
    child.on('error', (err) => {
      onLine(
        (err as NodeJS.ErrnoException).code === 'ENOENT' ? `${step.bin} isn’t on PATH.` : describeError(err)
      );
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve(code ?? (signal ? 128 : 1));
    });
  });

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: { code?: string } }).cause;
    if (err.message === 'fetch failed') return cause?.code ? `Couldn’t connect (${cause.code}).` : 'Couldn’t connect.';
    return err.message;
  }
  return String(err);
}

// ---------------------------------------------------------------------------------------------
// The service

interface CachedLatest {
  version: string | null;
  source: string;
  checkedAt: number;
  error?: string;
}

export interface HarnessUpdateServiceOptions {
  cacheFile: string;
  /** The latest detections (from the registry). */
  getDetections: () => HarnessDetection[];
  /** Sessions on this harness that are working now. */
  workingSessions: (harness: HarnessGroup) => number;
  /** Turns in Superharness's own hosts (driver.activeHostTurns). */
  activeHostTurns: (harness: HarnessGroup) => number;
  restartHosts: (harness: HarnessGroup) => Promise<string[]>;
  /** Re-runs detection and returns it (after an update). */
  refreshDetections: () => Promise<HarnessDetection[]>;
  /** Update info changed: rebroadcast detections. */
  onInfoChanged: () => void;
  onJob: (job: HarnessUpdateJob) => void;
  io?: Partial<UpdaterIO>;
  runStep?: StepRunner;
  exeLookup?: ExeLookup;
  waitPollMs?: number;
}

function defaultIO(): UpdaterIO {
  return {
    home: os.homedir(),
    now: Date.now,
    env: process.env,
    exec: (bin, args, timeoutMs) =>
      new Promise((resolve, reject) => {
        execFile(bin, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout) =>
          err ? reject(err) : resolve(String(stdout))
        );
      }),
    fetchJson: async (url) => {
      const res = await fetch(url, {
        headers: { Accept: 'application/json', 'User-Agent': 'super-harness' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`${new URL(url).host} answered HTTP ${res.status}.`);
      return res.json();
    },
    readFile: (p) => {
      try {
        return fs.readFileSync(p, 'utf8');
      } catch {
        return null;
      }
    },
    mtimeMs: (p) => {
      try {
        return fs.statSync(p).mtimeMs;
      } catch {
        return null;
      }
    },
  };
}

export class HarnessUpdateService {
  private readonly io: UpdaterIO;
  private readonly runStep: StepRunner;
  private readonly exeLookup: ExeLookup;
  private latest: Partial<Record<HarnessGroup, CachedLatest>> = {};
  private local: LocalState = {};
  private stale: Partial<Record<HarnessGroup, number>> = {};
  private jobsByHarness = new Map<HarnessGroup, HarnessUpdateJob>();
  private cancelled = new Set<string>();
  private timers: NodeJS.Timeout[] = [];
  private checking: Promise<void> | null = null;

  constructor(private readonly opts: HarnessUpdateServiceOptions) {
    this.io = { ...defaultIO(), ...opts.io };
    this.runStep = opts.runStep ?? spawnStep;
    this.exeLookup = opts.exeLookup ?? linuxExeLookup;
    this.loadCache();
  }

  private loadCache(): void {
    const raw = this.io.readFile(this.opts.cacheFile);
    if (!raw) return;
    try {
      const parsed = JSON.parse(raw) as { latest?: Partial<Record<HarnessGroup, CachedLatest>> };
      this.latest = parsed.latest ?? {};
    } catch {
      this.latest = {};
    }
  }

  private saveCache(): void {
    try {
      fs.mkdirSync(path.dirname(this.opts.cacheFile), { recursive: true });
      fs.writeFileSync(this.opts.cacheFile, JSON.stringify({ latest: this.latest }, null, 2));
    } catch {
      // the cache is only an optimisation
    }
  }

  /**
   * Starts background checks. The first runs shortly after launch (anything not checked in the
   * last 4 hours, which is everything on a fresh install); if detection hasn't finished by then
   * it retries until it has.
   */
  start(opts: { firstCheckMs?: number; retryMs?: number } = {}): void {
    const firstCheckMs = opts.firstCheckMs ?? 8000;
    const retryMs = opts.retryMs ?? 5000;
    let tries = 0;
    const kickoff = () => {
      if (this.installed().length === 0 && tries++ < 24) {
        const retry = setTimeout(kickoff, retryMs);
        retry.unref?.();
        this.timers.push(retry);
        return;
      }
      void this.checkAll(false);
    };
    const kick = setTimeout(kickoff, firstCheckMs);
    kick.unref?.();
    const latest = setInterval(() => void this.checkAll(false), 15 * 60 * 1000);
    latest.unref?.();
    const local = setInterval(() => void this.checkLocal(), LOCAL_CHECK_INTERVAL_MS);
    local.unref?.();
    this.timers.push(kick, latest, local);
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  private installed(): HarnessDetection[] {
    return this.opts.getDetections().filter((d) => d.installed && d.id in HARNESS_UPDATE_SPECS);
  }

  private currentOf(d: HarnessDetection): string | null {
    // Codex: the CLI on PATH is what `codex update` updates; detection reports the daemon's build.
    if (d.id === 'codex' && this.local.codexDaemon?.cliVersion) return this.local.codexDaemon.cliVersion;
    return parseVersion(d.version);
  }

  /** Checks latest versions that are older than the interval (or all, when forced). */
  checkAll(force: boolean): Promise<void> {
    if (this.checking) return this.checking;
    this.checking = (async () => {
      await this.checkLocal(false);
      const now = this.io.now();
      const due = this.installed().filter(
        (d) => force || !this.latest[d.id] || now - this.latest[d.id]!.checkedAt >= LATEST_CHECK_INTERVAL_MS
      );
      await Promise.all(due.map((d) => this.checkLatest(d.id, this.currentOf(d))));
      if (due.length > 0) this.saveCache();
      this.opts.onInfoChanged();
    })().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  private async checkLatest(harness: HarnessGroup, current: string | null): Promise<void> {
    const spec = specOf(harness);
    if (!spec) return;
    const res = await spec.latest(this.io, current);
    const prev = this.latest[harness];
    this.latest[harness] = {
      // Keep the last good answer through a failed check.
      version: res.version ?? (res.error ? (prev?.version ?? null) : null),
      source: res.source,
      checkedAt: this.io.now(),
      error: res.error,
    };
  }

  /** Daemon versions and processes still on an old build. */
  async checkLocal(notify = true): Promise<void> {
    const detections = this.installed();
    if (detections.some((d) => d.id === 'codex')) {
      try {
        const out = await this.io.exec('codex', ['app-server', 'daemon', 'version'], 8000);
        this.local.codexDaemon = JSON.parse(out.trim().split('\n').pop() || '{}') as CodexDaemonStatus;
      } catch {
        this.local.codexDaemon = null;
      }
    }
    for (const d of detections) {
      const spec = specOf(d.id);
      if (spec) this.stale[d.id] = await countStaleProcesses(spec, this.currentOf(d), this.exeLookup);
    }
    if (notify) this.opts.onInfoChanged();
  }

  /** Update info for one detection (attached by the registry). */
  infoFor(d: HarnessDetection): HarnessUpdateInfo | undefined {
    const spec = d.installed ? specOf(d.id) : undefined;
    if (!spec) return undefined;
    const current = this.currentOf(d);
    const cached = this.latest[d.id];
    const latest = cached?.version ?? null;
    const steps = spec.steps(this.local);
    const info: HarnessUpdateInfo = {
      current,
      latest,
      updateAvailable: isNewer(latest, current),
      checkedAt: cached?.checkedAt ?? null,
      latestSource: cached?.source,
      method: 'command',
      command: steps.map((s) => s.display).join(' && '),
    };
    if (spec.selfUpdating) info.selfUpdating = spec.selfUpdating;
    if (cached?.error) info.checkError = cached.error;
    const staleCount = this.stale[d.id];
    if (staleCount) info.staleProcesses = staleCount;
    if (d.id === 'codex') {
      const daemon = this.local.codexDaemon;
      const running = daemon?.appServerVersion;
      const cli = daemon?.cliVersion;
      if (daemon?.status === 'running' && running && cli && running !== cli) {
        info.staleDaemon = {
          name: 'Codex app-server daemon',
          version: running,
          expected: cli,
          detail: `The Codex app-server daemon runs ${running} but the codex CLI is ${cli}. Update restarts the daemon on the new version.`,
        };
      }
    }
    return info;
  }

  jobs(): HarnessUpdateJob[] {
    return Array.from(this.jobsByHarness.values());
  }

  private emit(job: HarnessUpdateJob): void {
    this.opts.onJob({ ...job, log: job.log.slice() });
  }

  /** Blockers: turns an update would cut off. Codex restarts its shared daemon, so any working Codex session counts. */
  private blockers(harness: HarnessGroup): number {
    return harness === 'codex' ? this.opts.workingSessions('codex') : this.opts.activeHostTurns(harness);
  }

  startUpdate(harness: HarnessGroup): { ok: true; job: HarnessUpdateJob } | { ok: false; error: string } {
    const spec = specOf(harness);
    if (!spec) return { ok: false, error: `Unknown harness: ${String(harness)}` };
    const detection = this.opts.getDetections().find((d) => d.id === harness);
    if (!detection?.installed) return { ok: false, error: `${spec.name} isn’t installed.` };
    const existing = this.jobsByHarness.get(harness);
    if (existing && (existing.phase === 'waiting' || existing.phase === 'updating' || existing.phase === 'restarting')) {
      return { ok: true, job: existing };
    }
    const job: HarnessUpdateJob = {
      id: crypto.randomBytes(6).toString('hex'),
      harness,
      phase: 'updating',
      startedAt: this.io.now(),
      from: this.currentOf(detection),
      to: null,
      log: [],
    };
    this.jobsByHarness.set(harness, job);
    void this.run(job);
    return { ok: true, job };
  }

  /** Cancels an update that is still waiting for sessions to finish. */
  cancel(harness: HarnessGroup): boolean {
    const job = this.jobsByHarness.get(harness);
    if (!job || job.phase !== 'waiting') return false;
    this.cancelled.add(job.id);
    job.phase = 'cancelled';
    job.finishedAt = this.io.now();
    job.message = 'Update cancelled.';
    this.emit(job);
    return true;
  }

  private async run(job: HarnessUpdateJob): Promise<void> {
    const spec = specOf(job.harness);
    if (!spec) return;
    const pollMs = this.opts.waitPollMs ?? WAIT_POLL_MS;
    let lastEmit = 0;
    let pendingEmit: NodeJS.Timeout | null = null;
    const emitSoon = () => {
      const now = Date.now();
      if (now - lastEmit >= 250) {
        lastEmit = now;
        this.emit(job);
      } else if (!pendingEmit) {
        pendingEmit = setTimeout(() => {
          pendingEmit = null;
          lastEmit = Date.now();
          this.emit(job);
        }, 250);
      }
    };

    // 1. Never cut off a running turn: wait until none would be interrupted.
    let busy = this.blockers(job.harness);
    while (busy > 0) {
      if (this.cancelled.has(job.id)) return;
      job.phase = 'waiting';
      job.waitingFor = busy;
      job.message = `Waiting for ${busy} working ${spec.name} ${busy === 1 ? 'session' : 'sessions'} to finish.`;
      this.emit(job);
      await new Promise((r) => setTimeout(r, pollMs));
      if (this.cancelled.has(job.id)) return;
      busy = this.blockers(job.harness);
    }
    job.phase = 'updating';
    job.waitingFor = undefined;
    job.message = undefined;

    // 2. The harness's own updater.
    await this.checkLocal(false);
    for (const step of spec.steps(this.local)) {
      job.step = step.display;
      job.log.push(`$ ${step.display}`);
      this.emit(job);
      const code = await this.runStep(step, (raw) => {
        const line = cleanOutputLine(raw);
        if (!line) return;
        job.log.push(line);
        if (job.log.length > LOG_LINES) job.log.splice(0, job.log.length - LOG_LINES);
        emitSoon();
      });
      if (pendingEmit) {
        clearTimeout(pendingEmit);
        pendingEmit = null;
      }
      if (code !== 0) {
        const last = [...job.log].reverse().find((l) => !l.startsWith('$ ')) ?? '';
        job.phase = 'failed';
        job.finishedAt = this.io.now();
        job.message = `${step.display} failed (exit ${code})${last ? `: ${last}` : '.'}`;
        this.emit(job);
        await this.afterUpdate(job.harness);
        return;
      }
    }

    // 3. Restart what runs the old binary, then detect again.
    job.phase = 'restarting';
    job.step = undefined;
    this.emit(job);
    let restarted: string[] = [];
    try {
      restarted = await this.opts.restartHosts(job.harness);
    } catch (err) {
      job.log.push(`Restarting Superharness’s ${spec.name} hosts failed: ${describeError(err)}`);
    }
    const detection = await this.afterUpdate(job.harness);
    job.to = detection ? this.currentOf(detection) : null;
    const info = detection ? this.infoFor(detection) : undefined;

    const parts: string[] = [];
    if (job.to && job.from && job.to !== job.from) parts.push(`Updated ${spec.name} ${job.from} → ${job.to}.`);
    else if (job.to) parts.push(`${spec.name} is on ${job.to}${info?.updateAvailable ? '' : ', the latest version'}.`);
    else parts.push(`${spec.name}’s updater finished.`);
    if (restarted.length > 0) parts.push(`Restarted ${restarted.join(' and ')}.`);
    if (info?.staleDaemon) parts.push(info.staleDaemon.detail);
    if (info?.staleProcesses) {
      const n = info.staleProcesses;
      parts.push(
        `${n} running ${spec.name} ${n === 1 ? 'process keeps' : 'processes keep'} the old version until ${n === 1 ? 'it’s' : 'they’re'} restarted (sessions in tmux or a terminal).`
      );
    }
    job.phase = 'done';
    job.finishedAt = this.io.now();
    job.message = parts.join(' ');
    this.emit(job);
  }

  private async afterUpdate(harness: HarnessGroup): Promise<HarnessDetection | undefined> {
    let detections: HarnessDetection[] = [];
    try {
      detections = await this.opts.refreshDetections();
    } catch {
      detections = this.opts.getDetections();
    }
    await this.checkLocal(false);
    const d = detections.find((x) => x.id === harness);
    if (d) {
      await this.checkLatest(harness, this.currentOf(d));
      this.saveCache();
    }
    this.opts.onInfoChanged();
    return d;
  }
}
