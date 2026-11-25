import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const binCache = new Map<string, string | null>();

export async function whichBinary(name: string): Promise<string | null> {
  if (binCache.has(name)) return binCache.get(name)!;
  try {
    const { stdout } = await execFileAsync('which', [name], { timeout: 2000 });
    const p = stdout.trim().split('\n')[0] || null;
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
 * so Super Harness always matches the running daemon & `~/.codex/config.toml` schema.
 */
export async function resolveCodexBinary(): Promise<string | null> {
  const releasesDir = path.join(os.homedir(), '.codex', 'packages', 'app-server-daemon', 'releases');
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
