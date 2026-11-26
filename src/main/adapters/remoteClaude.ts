import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ImageAttachment, SessionTranscriptResult, UnifiedSession } from '../../shared/types';
import { formatPromptWithImagePaths } from './types';
import { claudeTmuxTypingSteps, parseClaudeJsonlLines, pickClaudeTitle } from './claudeAdapter';

/**
 * Claude sessions running on other machines (e.g. lxe's Mac), mirrored over SSH.
 *
 * Hosts come from ~/.config/super-harness/remote-hosts.json:
 *   { "hosts": [{ "host": "192.168.0.3", "label": "lxebook-2021" }] }
 *
 * One SSH call per host every few seconds lists the live Claude processes there
 * (~/.claude/sessions/*.json), their transcript size and titles. Transcripts are read
 * with `tail -c` over SSH, and messages to tmux sessions are typed with `tmux send-keys`
 * over SSH, the same way local tmux sessions are driven.
 */

export interface RemoteHostConfig {
  host: string;
  label?: string;
}

interface RemoteClaudeEntry {
  host: string;
  label: string;
  sessionId: string;
  pid: number;
  cwd?: string;
  name?: string;
  nameSource?: string;
  status?: string;
  tmux?: string;
  bridgeSessionId?: string;
  startedAt?: number;
  transcriptPath?: string;
  size?: number;
  mtimeMs?: number;
  customTitle?: string;
  aiTitle?: string;
  preview?: string;
  model?: string;
}

const CONFIG_PATH = path.join(os.homedir(), '.config', 'super-harness', 'remote-hosts.json');
const POLL_MS = 3000;
const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;

const SSH_BASE = [
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=5',
  '-o', 'ServerAliveInterval=10',
  '-o', 'ControlMaster=auto',
  '-o', `ControlPath=${path.join(os.tmpdir(), 'sh-ssh-%C')}`,
  '-o', 'ControlPersist=300',
];
const REMOTE_PATH = 'export PATH=/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH;';

/** Lists live Claude sessions on the remote machine as one JSON array. */
const DISCOVERY_SCRIPT = String.raw`
import json, os, glob
home = os.path.expanduser('~')
out = []
for f in glob.glob(home + '/.claude/sessions/*.json'):
    try:
        d = json.load(open(f))
        os.kill(int(d.get('pid')), 0)
    except Exception:
        continue
    sid = d.get('sessionId')
    if not sid:
        continue
    e = {k: d.get(k) for k in ('sessionId', 'pid', 'cwd', 'name', 'nameSource', 'status', 'tmux', 'bridgeSessionId', 'startedAt')}
    tps = glob.glob(home + '/.claude/projects/*/' + sid + '.jsonl')
    if tps:
        tp = tps[0]
        st = os.stat(tp)
        e.update(transcriptPath=tp, size=st.st_size, mtimeMs=st.st_mtime * 1000)
        with open(tp, 'rb') as fh:
            head = fh.read(65536).decode('utf8', 'replace')
            fh.seek(max(0, st.st_size - 262144))
            tail = fh.read().decode('utf8', 'replace')
        for line in head.split('\n'):
            if '"user"' not in line and '"assistant"' not in line:
                continue
            try:
                o = json.loads(line)
            except Exception:
                continue
            m = o.get('message') or {}
            if o.get('type') == 'user' and 'preview' not in e and isinstance(m.get('content'), str):
                e['preview'] = m['content'][:200]
            if o.get('type') == 'assistant' and 'model' not in e and m.get('model'):
                e['model'] = m['model']
        for line in tail.split('\n'):
            if '"custom-title"' not in line and '"ai-title"' not in line:
                continue
            try:
                o = json.loads(line)
            except Exception:
                continue
            if o.get('type') == 'custom-title' and o.get('customTitle'):
                e['customTitle'] = o['customTitle']
            elif o.get('type') == 'ai-title' and o.get('aiTitle'):
                e['aiTitle'] = o['aiTitle']
    out.append(e)
print(json.dumps(out))
`;

export function loadRemoteHosts(configPath = CONFIG_PATH): RemoteHostConfig[] {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { hosts?: unknown };
    if (!Array.isArray(raw.hosts)) return [];
    return raw.hosts.filter(
      (h): h is RemoteHostConfig =>
        Boolean(h) && typeof (h as RemoteHostConfig).host === 'string' && Boolean((h as RemoteHostConfig).host)
    );
  } catch {
    return [];
  }
}

function ssh(
  host: string,
  remoteCmd: string,
  opts: { input?: string; timeout?: number; maxBuffer?: number } = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'ssh',
      [...SSH_BASE, host, remoteCmd],
      { timeout: opts.timeout ?? 8000, maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

function scp(localPath: string, host: string, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('scp', [...SSH_BASE, '-q', localPath, `${host}:${remotePath}`], { timeout: 30000 }, (err) =>
      err ? reject(err) : resolve()
    );
  });
}

/** POSIX single-quote a string for a remote shell. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Shell script that types `text` into a Claude TUI in tmux and presses Enter. */
export function buildRemoteTmuxTypingScript(target: string, text: string): string {
  const t = shQuote(target);
  const lines = [REMOTE_PATH];
  for (const step of claudeTmuxTypingSteps(text)) {
    lines.push(step === '\n' ? `tmux send-keys -t ${t} C-j` : `tmux send-keys -t ${t} -l ${shQuote(step)}`);
    lines.push('sleep 0.03');
  }
  lines.push('sleep 0.15', `tmux send-keys -t ${t} C-m`);
  return lines.join('\n') + '\n';
}

export function toUnifiedRemoteSession(e: RemoteClaudeEntry): UnifiedSession {
  const cwd = e.cwd || '~';
  const tmuxSessionName = e.tmux ? e.tmux.split(':')[0] : undefined;
  const title =
    (pickClaudeTitle({
      name: e.name,
      nameSource: e.nameSource,
      customTitle: e.customTitle,
      aiTitle: e.aiTitle,
      tmuxSessionName,
      preview: e.preview?.replace(/\s+/g, ' ').trim(),
    }) || `Claude on ${e.label}`).slice(0, 90);
  const running = e.status === 'busy' || e.status === 'running';
  const updatedAt = Math.max(e.mtimeMs ?? 0, e.startedAt ?? 0);
  return {
    id: `claude:${e.sessionId}`,
    nativeId: e.sessionId,
    harness: e.tmux ? 'claude-tmux' : 'claude-cli',
    harnessGroup: 'claude',
    title,
    preview: e.preview || `Claude on ${e.label}`,
    cwd,
    projectName: path.basename(cwd) || cwd,
    nativeSection: e.label,
    nativeSectionOrder: 50,
    model: e.model,
    status: running ? 'running' : 'idle',
    isLive: true,
    isRemote: Boolean(e.bridgeSessionId),
    remoteId: e.bridgeSessionId || undefined,
    tmuxTarget: e.tmux || undefined,
    tmuxSessionName,
    createdAt: e.startedAt ?? updatedAt,
    updatedAt,
    pinned: false,
    folderId: null,
    tags: ['remote-host', e.label, ...(e.tmux ? ['tmux'] : []), ...(e.bridgeSessionId ? ['remote-control'] : [])],
    hidden: false,
    dispatchMode: e.tmux ? 'tmux-send' : 'claude-resume',
    liveOwner: e.tmux ? 'tmux' : 'super-harness',
  };
}

export class RemoteClaudeMirror {
  private entries = new Map<string, RemoteClaudeEntry>();
  private timer: NodeJS.Timeout | null = null;
  private polling: Promise<void> | null = null;
  private firstPoll: Promise<void> | null = null;
  private sink: ((sessionId: string) => void) | null = null;

  constructor(private readonly hostsProvider: () => RemoteHostConfig[] = () => loadRemoteHosts()) {}

  setActivitySink(sink: ((sessionId: string) => void) | null): void {
    this.sink = sink;
  }

  isRemote(sessionId: string): boolean {
    return this.entries.has(sessionId);
  }

  /** Current remote sessions; starts polling on first use and waits briefly for the first poll. */
  async sessions(): Promise<UnifiedSession[]> {
    if (!this.timer && this.hostsProvider().length > 0) {
      this.firstPoll = this.poll();
      this.timer = setInterval(() => void this.poll(), POLL_MS);
      this.timer.unref?.();
    }
    if (this.firstPoll) {
      await Promise.race([this.firstPoll, new Promise((r) => setTimeout(r, 4000))]);
      this.firstPoll = null;
    }
    return Array.from(this.entries.values()).map(toUnifiedRemoteSession);
  }

  fingerprint(sessionId: string): string | undefined {
    const e = this.entries.get(sessionId);
    return e ? `remote:${e.host}:${e.size ?? 0}:${e.mtimeMs ?? 0}` : undefined;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private poll(): Promise<void> {
    if (this.polling) return this.polling;
    this.polling = (async () => {
      const next = new Map<string, RemoteClaudeEntry>();
      const failedHosts = new Set<string>();
      await Promise.all(
        this.hostsProvider().map(async (h) => {
          const label = h.label || h.host;
          try {
            const out = await ssh(h.host, 'python3 -', { input: DISCOVERY_SCRIPT, timeout: 8000 });
            for (const raw of JSON.parse(out) as Array<Omit<RemoteClaudeEntry, 'host' | 'label'>>) {
              next.set(`claude:${raw.sessionId}`, { ...raw, host: h.host, label });
            }
          } catch {
            failedHosts.add(h.host);
          }
        })
      );
      // Keep the last known sessions of a host that failed one poll, so a blip doesn't
      // make its threads vanish and reappear.
      for (const [id, e] of this.entries) {
        if (failedHosts.has(e.host) && !next.has(id)) next.set(id, e);
      }
      const prev = this.entries;
      this.entries = next;
      for (const [id, e] of next) {
        const p = prev.get(id);
        if (
          !p ||
          p.size !== e.size ||
          p.status !== e.status ||
          p.aiTitle !== e.aiTitle ||
          p.customTitle !== e.customTitle
        ) {
          this.sink?.(id);
        }
      }
      for (const id of prev.keys()) if (!next.has(id)) this.sink?.(id);
    })().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  async loadTranscript(sessionId: string, limit: number): Promise<SessionTranscriptResult | null> {
    const e = this.entries.get(sessionId);
    if (!e?.transcriptPath) return null;
    const out = await ssh(e.host, `tail -c ${TRANSCRIPT_TAIL_BYTES} ${shQuote(e.transcriptPath)}`, {
      timeout: 15000,
      maxBuffer: TRANSCRIPT_TAIL_BYTES * 2,
    });
    const truncated = (e.size ?? 0) > TRANSCRIPT_TAIL_BYTES;
    const lines = out.split('\n');
    if (truncated) lines.shift(); // first line is cut mid-record
    const running = e.status === 'busy' || e.status === 'running';
    return parseClaudeJsonlLines(lines, sessionId, e.mtimeMs ?? Date.now(), limit, {
      truncated,
      fileSize: e.size,
      bytesRead: Math.min(e.size ?? 0, TRANSCRIPT_TAIL_BYTES),
      tailActivity: { working: running, mtimeMs: e.mtimeMs ?? Date.now() },
    });
  }

  async sendMessage(
    sessionId: string,
    prompt: string,
    attachments: ImageAttachment[] | undefined
  ): Promise<{ ok: boolean; error?: string; dispatchedVia?: string }> {
    const e = this.entries.get(sessionId);
    if (!e) return { ok: false, error: 'Remote Claude session is no longer listed on its host.' };
    if (!e.tmux) {
      return {
        ok: false,
        error: `This Claude session on ${e.label} is not running in tmux, so Super Harness cannot type into it. Use the Claude app for it.`,
      };
    }
    try {
      // Attachments live on this machine; copy them to the host so Claude there can read them.
      let remoteAttachments = attachments;
      if (attachments?.length) {
        const remoteDir = '.cache/super-harness/attachments';
        await ssh(e.host, `mkdir -p ${remoteDir}`);
        const home = (await ssh(e.host, 'printf %s "$HOME"')).trim();
        remoteAttachments = [];
        for (const a of attachments) {
          if (!a.path || !fs.existsSync(a.path)) continue;
          const rel = `${remoteDir}/${path.basename(a.path)}`;
          await scp(a.path, e.host, rel);
          remoteAttachments.push({ ...a, path: `${home}/${rel}` });
        }
      }
      const text = formatPromptWithImagePaths(prompt, remoteAttachments);
      await ssh(e.host, 'sh -s', { input: buildRemoteTmuxTypingScript(e.tmux, text), timeout: 60000 });
      setTimeout(() => void this.poll(), 800);
      return { ok: true, dispatchedVia: `tmux typing over SSH → ${e.label} ${e.tmux}` };
    } catch (err) {
      return { ok: false, error: `Sending to ${e.label} over SSH failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}
