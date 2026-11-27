import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { HarnessDetection, HarnessGroup, HarnessUpdateJob } from '../src/shared/types';
import {
  HARNESS_UPDATE_SPECS,
  HarnessUpdateService,
  cleanOutputLine,
  compareVersions,
  countStaleProcesses,
  isNewer,
  parseVersion,
  type HarnessUpdateServiceOptions,
  type UpdaterIO,
} from '../src/main/services/harnessUpdates';

function detection(id: HarnessGroup, version: string): HarnessDetection {
  return {
    id,
    name: id,
    installed: true,
    binaryPath: `/bin/${id}`,
    version,
    runningProcesses: 0,
    desktopAppRunning: false,
    daemonRunning: false,
    remoteControlEnabled: false,
    activeSessionCount: 0,
    totalSessionCount: 0,
    capabilities: { canStartNew: true, canResume: true, canTmuxMirror: false, canControlDaemon: false },
  };
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sh-updates-'));
}

function makeIO(home: string, over: Partial<UpdaterIO> = {}): Partial<UpdaterIO> {
  return {
    home,
    env: {},
    exec: async () => {
      throw new Error('not installed');
    },
    fetchJson: async (url: string) => {
      if (url.includes('pi-coding-agent')) return { latest: '1.6.1' };
      if (url.includes('claude-code')) return { latest: '2.1.332', stable: '2.1.326' };
      if (url.includes('codex')) return { latest: '0.172.0' };
      if (url.includes('muse-stable')) return { version: '1.4.26-R9400.1' };
      throw new Error('unexpected ' + url);
    },
    ...over,
  };
}

describe('versions', () => {
  it('parses version output from each harness', () => {
    expect(parseVersion('codex-cli 0.172.0')).toBe('0.172.0');
    expect(parseVersion('2.1.332 (Claude Code)')).toBe('2.1.332');
    expect(parseVersion('Muse Code 1.4.25 (1.4.25-R9361.1)')).toBe('1.4.25-R9361.1');
    expect(parseVersion('opencode v2.3.2')).toBe('2.3.2');
    expect(parseVersion('1.5.18')).toBe('1.5.18');
    expect(parseVersion(null)).toBeNull();
    expect(parseVersion('unknown')).toBeNull();
  });

  it('compares numerically, builds included, pre-releases first', () => {
    expect(compareVersions('0.99.0', '0.172.0')).toBe(-1);
    expect(compareVersions('1.6.1', '1.4.0')).toBe(1);
    expect(compareVersions('1.4.25-R9400.1', '1.4.25-R9361.1')).toBe(1);
    expect(compareVersions('0.174.0-alpha.8', '0.174.0')).toBe(-1);
    expect(compareVersions('2.1.332', '2.1.332')).toBe(0);
    expect(isNewer('1.6.1', '1.4.0')).toBe(true);
    expect(isNewer('1.4.0', '1.6.1')).toBe(false);
    expect(isNewer(null, '1.4.0')).toBe(false);
  });

  it('cleans updater output (ANSI, carriage-return progress)', () => {
    expect(cleanOutputLine('\x1b[32mDone\x1b[0m')).toBe('Done');
    expect(cleanOutputLine('10%\r50%\r100%')).toBe('100%');
  });
});

describe('processes on an old build', () => {
  it('counts older Claude versions and replaced binaries', async () => {
    const exes: Record<number, string> = {
      1: '/home/u/.local/share/claude/versions/2.1.330',
      2: '/home/u/.local/share/claude/versions/2.1.332',
      3: '/usr/lib/claude-desktop/claude-desktop',
      4: '/home/u/.local/bin/agy (deleted)',
    };
    const lookup = { pids: async () => [1, 2, 3, 4], exeOf: (pid: number) => exes[pid] ?? null };
    expect(await countStaleProcesses(HARNESS_UPDATE_SPECS.claude, '2.1.332', lookup)).toBe(1);
    expect(await countStaleProcesses(HARNESS_UPDATE_SPECS.antigravity, '1.5.18', lookup)).toBe(1);
    expect(await countStaleProcesses(HARNESS_UPDATE_SPECS.pi, '1.4.0', lookup)).toBe(0);
  });
});

function makeService(over: Partial<HarnessUpdateServiceOptions> & { dets: HarnessDetection[] }) {
  const home = tmpDir();
  const jobs: HarnessUpdateJob[] = [];
  const svc = new HarnessUpdateService({
    cacheFile: path.join(home, 'cache.json'),
    getDetections: () => over.dets,
    workingSessions: () => 0,
    activeHostTurns: () => 0,
    restartHosts: async () => [],
    refreshDetections: async () => over.dets,
    onInfoChanged: () => {},
    onJob: (j) => jobs.push(j),
    exeLookup: { pids: async () => [], exeOf: () => null },
    waitPollMs: 5,
    ...over,
    io: makeIO(home, over.io),
  });
  return { svc, jobs, home };
}

async function until(fn: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('HarnessUpdateService', () => {
  it('reports an available update and caches the check', async () => {
    const dets = [detection('pi', '1.4.0'), detection('claude', '2.1.332 (Claude Code)')];
    const { svc, home } = makeService({ dets });
    await svc.checkAll(true);
    expect(svc.infoFor(dets[0]!)).toMatchObject({
      current: '1.4.0',
      latest: '1.6.1',
      updateAvailable: true,
      command: 'pi update --self',
    });
    expect(svc.infoFor(dets[1]!)).toMatchObject({ updateAvailable: false, latest: '2.1.332' });
    const cached = JSON.parse(fs.readFileSync(path.join(home, 'cache.json'), 'utf8'));
    expect(cached.latest.pi.version).toBe('1.6.1');
  });

  it('follows Claude’s stable channel when settings ask for it', async () => {
    const dets = [detection('claude', '2.1.326 (Claude Code)')];
    const { svc, home } = makeService({ dets });
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ autoUpdatesChannel: 'stable' }));
    await svc.checkAll(true);
    expect(svc.infoFor(dets[0]!)).toMatchObject({ latest: '2.1.326', updateAvailable: false });
  });

  it('keeps the last good latest version when a check fails', async () => {
    const dets = [detection('pi', '1.4.0')];
    let fail = false;
    const { svc } = makeService({
      dets,
      io: {
        fetchJson: async () => {
          if (fail) throw new Error('fetch failed');
          return { latest: '1.6.1' };
        },
      },
    });
    await svc.checkAll(true);
    fail = true;
    await svc.checkAll(true);
    expect(svc.infoFor(dets[0]!)).toMatchObject({ latest: '1.6.1', updateAvailable: true, checkError: 'Couldn’t connect.' });
  });

  it('reads agy’s own updater status', async () => {
    const dets = [detection('antigravity', '1.5.18')];
    const { svc, home } = makeService({ dets });
    const dir = path.join(home, '.gemini', 'antigravity-cli', 'updater');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'update_status.json'), JSON.stringify({ success: true, message: 'Already on the latest version.' }));
    await svc.checkAll(true);
    expect(svc.infoFor(dets[0]!)).toMatchObject({ current: '1.5.18', latest: '1.5.18', updateAvailable: false, command: 'agy update' });
  });

  it('flags a Codex daemon that runs a different version than the CLI', async () => {
    const dets = [detection('codex', 'codex-cli 0.171.0')];
    const { svc } = makeService({
      dets,
      io: {
        exec: async () =>
          JSON.stringify({
            status: 'running',
            managedCodexPath: '/x/codex',
            cliVersion: '0.172.0',
            appServerVersion: '0.171.0',
          }),
      },
    });
    await svc.checkAll(true);
    const info = svc.infoFor(dets[0]!)!;
    expect(info.current).toBe('0.172.0');
    expect(info.staleDaemon).toMatchObject({ version: '0.171.0', expected: '0.172.0' });
    expect(info.command).toBe('codex update && codex app-server daemon update --yes');
  });

  it('waits for working turns, runs the updater, restarts hosts and reports the new version', async () => {
    const dets = [detection('pi', '1.4.0')];
    let busy = 1;
    const ran: string[] = [];
    const { svc, jobs } = makeService({
      dets,
      activeHostTurns: () => busy,
      restartHosts: async () => ['2 Pi workers'],
      refreshDetections: async () => {
        dets[0] = detection('pi', '1.6.1');
        return dets;
      },
      runStep: async (step, onLine) => {
        ran.push(step.display);
        onLine('\x1b[1mchanged 1 package\x1b[0m');
        return 0;
      },
    });
    await svc.checkAll(true);
    const started = svc.startUpdate('pi');
    expect(started.ok).toBe(true);
    await until(() => jobs.some((j) => j.phase === 'waiting'));
    expect(ran).toEqual([]);
    expect(jobs.find((j) => j.phase === 'waiting')?.message).toBe('Waiting for 1 working Pi session to finish.');
    busy = 0;
    await until(() => jobs.some((j) => j.phase === 'done'));
    const done = jobs.find((j) => j.phase === 'done')!;
    expect(ran).toEqual(['pi update --self']);
    expect(done.from).toBe('1.4.0');
    expect(done.to).toBe('1.6.1');
    expect(done.message).toBe('Updated Pi 1.4.0 → 1.6.1. Restarted 2 Pi workers.');
    expect(done.log).toContain('changed 1 package');
    expect(svc.infoFor(dets[0]!)?.updateAvailable).toBe(false);
  });

  it('waits on any working Codex session, since the daemon restarts', async () => {
    const dets = [detection('codex', 'codex-cli 0.171.0')];
    const { svc, jobs } = makeService({ dets, workingSessions: (h) => (h === 'codex' ? 2 : 0), activeHostTurns: () => 0 });
    svc.startUpdate('codex');
    await until(() => jobs.some((j) => j.phase === 'waiting'));
    expect(jobs.at(-1)?.waitingFor).toBe(2);
    expect(svc.cancel('codex')).toBe(true);
    expect(jobs.at(-1)?.phase).toBe('cancelled');
  });

  it('reports a failed updater with its last output line', async () => {
    const dets = [detection('claude', '2.1.330 (Claude Code)')];
    const { svc, jobs } = makeService({
      dets,
      runStep: async (_step, onLine) => {
        onLine('Error: EACCES: permission denied');
        return 1;
      },
    });
    svc.startUpdate('claude');
    await until(() => jobs.some((j) => j.phase === 'failed'));
    expect(jobs.at(-1)?.message).toBe('claude update failed (exit 1): Error: EACCES: permission denied');
  });

  it('runs one update per harness at a time', () => {
    const dets = [detection('pi', '1.4.0')];
    const { svc } = makeService({ dets, activeHostTurns: () => 1 });
    const a = svc.startUpdate('pi');
    const b = svc.startUpdate('pi');
    expect(a.ok && b.ok && a.job.id === b.job.id).toBe(true);
    svc.cancel('pi');
  });
});

describe('HarnessUpdateService.start', () => {
  it('checks soon after launch, waiting for the first detection', async () => {
    const dets: HarnessDetection[] = [];
    const { svc } = makeService({ dets });
    svc.start({ firstCheckMs: 5, retryMs: 5 });
    await new Promise((r) => setTimeout(r, 30));
    dets.push(detection('pi', '1.4.0'));
    await until(() => svc.infoFor(dets[0]!)?.latest === '1.6.1');
    expect(svc.infoFor(dets[0]!)?.updateAvailable).toBe(true);
    svc.stop();
  });

  it('skips the startup check for harnesses checked in the last 4 hours', async () => {
    const dets = [detection('pi', '1.4.0')];
    let fetches = 0;
    const first = makeService({ dets, io: { fetchJson: async () => (fetches++, { latest: '1.6.1' }) } });
    await first.svc.checkAll(true);
    const cacheFile = path.join(first.home, 'cache.json');
    const second = makeService({ dets, cacheFile, io: { fetchJson: async () => (fetches++, { latest: '1.6.1' }) } });
    second.svc.start({ firstCheckMs: 5, retryMs: 5 });
    await new Promise((r) => setTimeout(r, 40));
    expect(fetches).toBe(1);
    expect(second.svc.infoFor(dets[0]!)?.latest).toBe('1.6.1');
    second.svc.stop();
  });
});
