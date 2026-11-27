import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { UnifiedSession } from '../../shared/types';
import { whichBinary } from '../utils/system';

const execFileAsync = promisify(execFile);

/**
 * Brings Claude tmux sessions back after a reboot.
 *
 * Every refresh records the live Claude tmux sessions with the current boot
 * ID. A record whose tmux session disappears during the same boot was closed
 * on purpose and is dropped. A record from an earlier boot died with the
 * machine: on launch Superharness starts it again in a tmux session of the
 * same name with `claude --resume <id> --remote-control`.
 */

export interface ClaudeTmuxRecord {
  nativeId: string;
  tmuxSessionName: string;
  cwd: string;
  model?: string;
  reasoningEffort?: string;
  permissionMode?: string;
  remoteControl: boolean;
  bootId: string;
  seenAt: number;
}

interface RecordFile {
  version: 1;
  sessions: Record<string, ClaudeTmuxRecord>;
}

/** Don't resurrect sessions nobody has touched in two weeks. */
const MAX_REVIVE_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const REVIVE_STAGGER_MS = 400;

const VALID_PERMISSION_MODES = new Set([
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'manual',
  'dontAsk',
  'plan',
]);

export function defaultRecordPath(): string {
  return path.join(os.homedir(), '.config', 'super-harness', 'claude-tmux-sessions.json');
}

export function currentBootId(): string {
  try {
    return fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch {
    // No /proc (macOS): approximate the boot with the uptime-derived boot time, to the minute.
    return `boot-${Math.round((Date.now() - os.uptime() * 1000) / 60000)}`;
  }
}

function readRecords(file: string): RecordFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as RecordFile;
    if (parsed && parsed.version === 1 && parsed.sessions && typeof parsed.sessions === 'object') {
      return parsed;
    }
  } catch {
    // missing or unreadable: start fresh
  }
  return { version: 1, sessions: {} };
}

function writeRecords(file: string, data: RecordFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

/** Names of the tmux sessions that exist right now (empty when no tmux server is running). */
export async function listTmuxSessionNames(tmuxBin = 'tmux'): Promise<Set<string>> {
  try {
    const { stdout } = await execFileAsync(tmuxBin, ['list-sessions', '-F', '#{session_name}'], {
      timeout: 3000,
    });
    return new Set(
      stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
    );
  } catch {
    return new Set();
  }
}

function isLocalLiveClaudeTmux(s: UnifiedSession): boolean {
  return (
    s.harnessGroup === 'claude' &&
    s.harness === 'claude-tmux' &&
    s.dispatchMode === 'tmux-send' &&
    Boolean(s.tmuxSessionName) &&
    !s.tags?.includes('remote-host')
  );
}

export class ClaudeTmuxRecords {
  private readonly file: string;
  private readonly bootId: string;
  private pruning = false;

  constructor(opts: { file?: string; bootId?: string } = {}) {
    this.file = opts.file ?? defaultRecordPath();
    this.bootId = opts.bootId ?? currentBootId();
  }

  get(nativeId: string): ClaudeTmuxRecord | undefined {
    return readRecords(this.file).sessions[nativeId];
  }

  /**
   * Records every live local Claude tmux session, then drops records from this
   * boot whose tmux session no longer exists (closed or killed on purpose).
   */
  async noteSessions(sessions: UnifiedSession[], tmuxNames?: Set<string>): Promise<void> {
    const data = readRecords(this.file);
    const now = Date.now();
    const live = new Set<string>();
    let changed = false;

    for (const s of sessions) {
      if (!isLocalLiveClaudeTmux(s)) continue;
      live.add(s.nativeId);
      const prev = data.sessions[s.nativeId];
      const next: ClaudeTmuxRecord = {
        nativeId: s.nativeId,
        tmuxSessionName: s.tmuxSessionName!,
        cwd: s.cwd || prev?.cwd || os.homedir(),
        model: s.model || prev?.model,
        reasoningEffort: s.reasoningEffort || prev?.reasoningEffort,
        permissionMode: s.permissionMode || prev?.permissionMode,
        remoteControl: s.tags?.includes('remote-control') ?? prev?.remoteControl ?? true,
        bootId: this.bootId,
        seenAt: now,
      };
      // Only rewrite the file when something besides the timestamp changed, or once a minute.
      if (
        !prev ||
        prev.bootId !== next.bootId ||
        prev.tmuxSessionName !== next.tmuxSessionName ||
        prev.cwd !== next.cwd ||
        prev.model !== next.model ||
        prev.reasoningEffort !== next.reasoningEffort ||
        prev.permissionMode !== next.permissionMode ||
        now - prev.seenAt > 60_000
      ) {
        data.sessions[s.nativeId] = next;
        changed = true;
      }
    }

    const candidates = Object.values(data.sessions).filter(
      (r) => r.bootId === this.bootId && !live.has(r.nativeId)
    );
    if (candidates.length > 0 && !this.pruning) {
      this.pruning = true;
      try {
        const names = tmuxNames ?? (await listTmuxSessionNames());
        for (const r of candidates) {
          if (!names.has(r.tmuxSessionName)) {
            delete data.sessions[r.nativeId];
            changed = true;
          }
        }
      } finally {
        this.pruning = false;
      }
    }

    if (changed) writeRecords(this.file, data);
  }

  /** Marks a record as belonging to this boot (after it has been started again). */
  private markRevived(nativeId: string): void {
    const data = readRecords(this.file);
    const r = data.sessions[nativeId];
    if (!r) return;
    r.bootId = this.bootId;
    r.seenAt = Date.now();
    writeRecords(this.file, data);
  }

  /** Records from an earlier boot whose tmux session is gone and that are recent enough to revive. */
  async pendingRevivals(tmuxNames?: Set<string>): Promise<ClaudeTmuxRecord[]> {
    const data = readRecords(this.file);
    const names = tmuxNames ?? (await listTmuxSessionNames());
    const now = Date.now();
    return Object.values(data.sessions).filter(
      (r) =>
        r.bootId !== this.bootId &&
        now - r.seenAt <= MAX_REVIVE_AGE_MS &&
        !names.has(r.tmuxSessionName)
    );
  }

  /**
   * Starts `claude --resume` for one record in a detached tmux session of the
   * same name. With a prompt, Claude submits it as the first turn on startup.
   */
  async revive(
    rec: ClaudeTmuxRecord,
    opts: { prompt?: string } = {}
  ): Promise<{ ok: boolean; tmuxSession?: string; error?: string }> {
    const claudeBin = await whichBinary('claude');
    const tmuxBin = await whichBinary('tmux');
    if (!claudeBin) return { ok: false, error: 'claude CLI not found' };
    if (!tmuxBin) return { ok: false, error: 'tmux not found' };

    const cwd = fs.existsSync(rec.cwd) ? rec.cwd : os.homedir();
    const cmd = buildClaudeTmuxResumeCommand(claudeBin, rec, opts.prompt);
    try {
      await execFileAsync(
        tmuxBin,
        ['new-session', '-d', '-s', rec.tmuxSessionName, '-c', cwd, cmd],
        { timeout: 5000 }
      );
      this.markRevived(rec.nativeId);
      return { ok: true, tmuxSession: rec.tmuxSessionName };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Restarts every session that died with the previous boot, a little apart from each other. */
  async reviveAfterReboot(log: (msg: string) => void = console.log): Promise<string[]> {
    const pending = await this.pendingRevivals();
    const revived: string[] = [];
    for (const rec of pending) {
      const res = await this.revive(rec);
      if (res.ok) {
        revived.push(rec.tmuxSessionName);
        log(`[claude-tmux] restarted ${rec.tmuxSessionName} (claude --resume ${rec.nativeId})`);
      } else {
        log(`[claude-tmux] could not restart ${rec.tmuxSessionName}: ${res.error}`);
      }
      await new Promise((r) => setTimeout(r, REVIVE_STAGGER_MS));
    }
    return revived;
  }
}

/** Longest prompt passed on the command line; tmux caps a command near 16 KB. */
const MAX_ARGV_PROMPT = 8000;

export function buildClaudeTmuxResumeCommand(
  claudeBin: string,
  rec: Pick<
    ClaudeTmuxRecord,
    'nativeId' | 'model' | 'reasoningEffort' | 'permissionMode' | 'remoteControl'
  >,
  prompt?: string
): string {
  const quote = (a: string) => `'${a.replace(/'/g, `'\\''`)}'`;
  const flags = ['--resume', rec.nativeId];
  if (rec.remoteControl) flags.push('--remote-control');
  if (rec.model?.trim()) flags.push('--model', rec.model.trim());
  if (rec.reasoningEffort?.trim()) flags.push('--effort', rec.reasoningEffort.trim());
  if (rec.permissionMode && VALID_PERMISSION_MODES.has(rec.permissionMode)) {
    flags.push('--permission-mode', rec.permissionMode);
  }
  const base = [claudeBin, ...flags].map(quote).join(' ');
  const p = prompt?.trim();
  return p && p.length <= MAX_ARGV_PROMPT ? `${base} -- ${quote(p)}` : base;
}

export { MAX_ARGV_PROMPT };

/** Shared instance used by the Claude adapter and app startup. */
export const claudeTmuxRecords = new ClaudeTmuxRecords();
