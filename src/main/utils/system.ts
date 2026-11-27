import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const binCache = new Map<string, string | null>();

/**
 * macOS/Linux GUI-launched packaged apps often inherit a minimal PATH
 * (`/usr/bin:/bin`). Append common user & Homebrew bin directories so
 * bundled adapters can discover claude, codex, agy, muse, pi, tmux, and node.
 */
export function ensureRichPath(): void {
  if (process.platform === 'win32') return;
  const home = os.homedir();
  const extras = [
    path.join(home, '.gemini', 'antigravity', 'bin'),
    path.join(home, '.local', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.cargo', 'bin'),
    path.join(home, '.local', 'share', 'mise', 'shims'),
    path.join(home, '.npm-global', 'bin'),
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
  ];
  const current = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const seen = new Set(current);
  let changed = false;
  for (const dir of extras) {
    if (!seen.has(dir) && fs.existsSync(dir)) {
      current.push(dir);
      seen.add(dir);
      changed = true;
    }
  }
  if (changed) {
    process.env.PATH = current.join(path.delimiter);
    binCache.clear();
  }
}

export async function whichBinary(name: string): Promise<string | null> {
  if (binCache.has(name)) return binCache.get(name)!;
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const { stdout } = await execFileAsync(cmd, [name], { timeout: 2000 });
    const p = stdout.trim().split(/\r?\n/)[0]?.trim() || null;
    binCache.set(name, p);
    return p;
  } catch {
    binCache.set(name, null);
    return null;
  }
}

/**
 * Resolves the newest installed Codex binary, preferring the managed app-server
 * daemon release (`~/.codex/packages/app-server-daemon/releases/.../bin/codex`)
 * so Superharness always matches the running daemon & `~/.codex/config.toml` schema.
 */
export async function resolveCodexBinary(): Promise<string | null> {
  const daemonDir = path.join(os.homedir(), '.codex', 'packages', 'app-server-daemon');
  const releasesDir = path.join(daemonDir, 'releases');
  // `current` is the release the daemon runs; old releases can linger after an update.
  const current = path.join(daemonDir, 'current', 'bin', 'codex');
  if (fs.existsSync(current)) return current;
  try {
    if (fs.existsSync(releasesDir)) {
      const entries = fs
        .readdirSync(releasesDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort()
        .reverse();
      for (const dir of entries) {
        const candidate = path.join(releasesDir, dir, 'bin', 'codex');
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  } catch {
    // fall back to PATH
  }
  return whichBinary('codex');
}

const versionCache = new Map<string, { key: string; version: string | null }>();

/**
 * `--version` of a binary, cached until the file it resolves to changes (an update swaps the
 * symlink target or rewrites the file), so updates show up without restarting Superharness.
 */
export async function getBinaryVersionCached(
  binPath: string | null,
  /** Other files whose change means a new version (e.g. a launcher's version-state file). */
  alsoWatch: Array<string | null> = []
): Promise<string | null> {
  if (!binPath) return null;
  let key = '';
  try {
    const real = fs.realpathSync(binPath);
    const st = fs.statSync(real);
    key = `${real}:${st.size}:${Math.floor(st.mtimeMs)}`;
    for (const extra of alsoWatch) {
      if (!extra) continue;
      try {
        key += `|${Math.floor(fs.statSync(extra).mtimeMs)}`;
      } catch {
        key += '|-';
      }
    }
  } catch {
    key = '';
  }
  const hit = versionCache.get(binPath);
  if (hit && key && hit.key === key) return hit.version;
  const version = await getBinaryVersion(binPath);
  if (key) versionCache.set(binPath, { key, version });
  return version;
}

/**
 * The Muse launcher (`~/.local/bin/muse`) keeps the version it runs in `.muse-version` beside
 * itself and replaces only `muse-bin-<version>` on update, so that file marks a new version.
 */
export function museVersionStateFile(launcherPath: string | null): string | null {
  if (!launcherPath) return null;
  try {
    return path.join(path.dirname(fs.realpathSync(launcherPath)), '.muse-version');
  } catch {
    return null;
  }
}

export async function getBinaryVersion(binPath: string | null): Promise<string | null> {
  if (!binPath) return null;
  try {
    const { stdout } = await execFileAsync(binPath, ['--version'], { timeout: 3000 });
    return stdout.trim().split('\n')[0]?.slice(0, 60) || null;
  } catch {
    return null;
  }
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    // EPERM means the process exists, we just don't have signal permission
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * Like isPidAlive, but when the recorded process start time (`/proc/<pid>/stat`
 * field 22, which Claude Code writes as `procStart`) is known, also checks the
 * live process is the same one. After a reboot PIDs get reused, so a bare
 * liveness check makes dead sessions look alive.
 */
export function isSameProcessAlive(pid: number, procStart?: string | number): boolean {
  if (!isPidAlive(pid)) return false;
  if (procStart === undefined || procStart === null || procStart === '') return true;
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    // fields[0] is field 3 (state), so field 22 (starttime) is fields[19]
    return fields[19] === String(procStart);
  } catch {
    return true; // no /proc (macOS): fall back to the plain liveness check
  }
}

export interface ProcessRow {
  pid: number;
  comm: string;
  args: string;
}

export async function listProcesses(): Promise<ProcessRow[]> {
  try {
    const { stdout } = await execFileAsync(
      'ps',
      ['-eo', 'pid=,comm=,args='],
      { maxBuffer: 4 * 1024 * 1024, timeout: 3000 }
    );
    const rows: ProcessRow[] = [];
    for (const line of stdout.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
      if (m) {
        rows.push({
          pid: Number(m[1]),
          comm: m[2],
          args: m[3],
        });
      }
    }
    return rows;
  } catch {
    return [];
  }
}

export function projectNameFromCwd(cwd: string | undefined | null): string {
  if (!cwd) return 'General';
  const home = os.homedir();
  const normalized = cwd.replace(/\/+$/, '');
  if (!normalized || normalized === home) return 'Home (~)';
  return path.basename(normalized) || normalized;
}

export function normalizeTimestamp(raw: unknown): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // Convert seconds to ms if clearly epoch seconds
    return raw < 1e12 ? raw * 1000 : raw;
  }
  if (typeof raw === 'string') {
    const asNum = Number(raw);
    if (Number.isFinite(asNum) && asNum > 0) {
      return asNum < 1e12 ? asNum * 1000 : asNum;
    }
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

export function cleanTextPreview(text: string | undefined | null, maxLen = 140): string {
  if (!text) return '';
  return text
    .replace(/<USER_REQUEST>|<\/USER_REQUEST>|<ADDITIONAL_METADATA>[\s\S]*$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}
