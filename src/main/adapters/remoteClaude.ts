import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ImageAttachment, SessionTranscriptResult, UnifiedSession } from '../../shared/types';
import { formatPromptWithImagePaths } from './types';
import { cleanUserPreview } from '../utils/lastUserText';
import { claudeTmuxTypingSteps, parseClaudeJsonlLines, pickClaudeTitle } from './claudeAdapter';
import {
  buildRemoteClaudeQuestionTmuxScript,
  extractPendingQuestionBlock,
  resolveClaudeQuestionAnswers,
} from './claudeQuestionTui';

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
  lastPrompt?: string;
  preview?: string;
  model?: string;
}

const CONFIG_PATH = path.join(os.homedir(), '.config', 'super-harness', 'remote-hosts.json');
const POLL_MS = 3000;
const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;
const REMOTE_TRANSCRIPT_MAX_WIRE_BYTES = 16 * 1024 * 1024;

/**
 * Streams a large remote Claude JSONL transcript on the remote host, keeping only the
 * last `max_lines` conversation records (skipping telemetry blobs like `api-request-blob`).
 * If the selected tail exceeds `max_wire_bytes` due to embedded base64 screenshots, strips
 * base64 payloads from the oldest records first so recent screenshots stay intact and
 * "Load earlier" can page all the way to the start of 100+ MB transcripts.
 */
const REMOTE_TRANSCRIPT_SLICE_SCRIPT = String.raw`
import json, sys
from collections import deque

path = sys.argv[1]
max_lines = int(sys.argv[2])
max_wire_bytes = int(sys.argv[3])
keep_types = {"user", "assistant", "queue-operation", "system", "summary", "custom-title"}
skip_tokens = (
    '"type":"api-request',
    '"type":"data-flow-records"',
    '"type":"file-history-',
    '"type":"attachment"',
)

buf = deque(maxlen=max_lines)
total_kept = 0
with open(path, "r", encoding="utf-8", errors="replace") as f:
    for raw in f:
        if '"type"' not in raw:
            continue
        if any(tok in raw for tok in skip_tokens):
            continue
        try:
            obj = json.loads(raw)
        except Exception:
            continue
        if obj.get("type") in keep_types:
            total_kept += 1
            buf.append(raw.rstrip("\n"))

lines = list(buf)
truncated = total_kept > len(lines)

def strip_base64(node):
    if isinstance(node, dict):
        if node.get("type") == "base64" and isinstance(node.get("data"), str) and len(node["data"]) > 16384:
            node["data"] = ""
            return True
        changed = False
        for v in node.values():
            if strip_base64(v):
                changed = True
        return changed
    if isinstance(node, list):
        changed = False
        for item in node:
            if strip_base64(item):
                changed = True
        return changed
    return False

total_bytes = sum(len(l) + 1 for l in lines)
if total_bytes > max_wire_bytes:
    for i in range(len(lines)):
        if total_bytes <= max_wire_bytes:
            break
        if len(lines[i]) > 32768 and "base64" in lines[i]:
            try:
                obj = json.loads(lines[i])
                if strip_base64(obj):
                    compact = json.dumps(obj, separators=(",", ":"))
                    total_bytes -= len(lines[i]) - len(compact)
                    lines[i] = compact
            except Exception:
                pass

sys.stdout.write(json.dumps({"totalKept": total_kept, "returnedKept": len(lines), "truncated": truncated}) + "\n")
for l in lines:
    sys.stdout.write(l + "\n")
`;

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
            if '"last-prompt"' in line:
                try:
                    o = json.loads(line)
                    if o.get('lastPrompt'):
                        e['lastPrompt'] = o['lastPrompt'][:400]
                except Exception:
                    pass
                continue
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
    lastUserText: cleanUserPreview(e.lastPrompt),
    hostAddress: e.host,
    hostLabel: e.label,
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
    const running = e.status === 'busy' || e.status === 'running';
    const fileSize = e.size ?? 0;

    // Small transcripts: fast direct `tail -c` read
    if (fileSize > 0 && fileSize <= TRANSCRIPT_TAIL_BYTES) {
      const out = await ssh(e.host, `tail -c ${TRANSCRIPT_TAIL_BYTES} ${shQuote(e.transcriptPath)}`, {
        timeout: 15000,
        maxBuffer: TRANSCRIPT_TAIL_BYTES * 2,
      });
      const lines = out.split('\n');
      return parseClaudeJsonlLines(lines, sessionId, e.mtimeMs ?? Date.now(), limit, {
        truncated: false,
        fileSize,
        bytesRead: fileSize,
        tailActivity: { working: running, mtimeMs: e.mtimeMs ?? Date.now() },
      });
    }

    // Large transcripts (e.g. 50-150+ MB with base64 screenshots or telemetry blobs):
    // slice the exact last N conversation lines on the remote host so "Load earlier" scales cleanly.
    const maxLines = Math.max(480, limit * 8);
    try {
      const out = await ssh(
        e.host,
        `python3 - ${shQuote(e.transcriptPath)} ${maxLines} ${REMOTE_TRANSCRIPT_MAX_WIRE_BYTES}`,
        {
          input: REMOTE_TRANSCRIPT_SLICE_SCRIPT,
          timeout: 30000,
          maxBuffer: REMOTE_TRANSCRIPT_MAX_WIRE_BYTES + 4 * 1024 * 1024,
        }
      );
      const nl = out.indexOf('\n');
      const header = nl !== -1 ? (JSON.parse(out.slice(0, nl)) as { totalKept?: number; returnedKept?: number; truncated?: boolean }) : null;
      const lines = nl !== -1 ? out.slice(nl + 1).split('\n') : out.split('\n');
      const truncated = Boolean(header?.truncated);
      const totalKept = header?.totalKept ?? lines.length;
      const returnedKept = header?.returnedKept ?? lines.length;
      return parseClaudeJsonlLines(lines, sessionId, e.mtimeMs ?? Date.now(), limit, {
        truncated,
        fileSize: totalKept,
        bytesRead: returnedKept,
        tailActivity: { working: running, mtimeMs: e.mtimeMs ?? Date.now() },
      });
    } catch {
      // Fallback if python3 is unavailable on the remote host: scale tail bytes with limit
      const tailBytes = Math.min(REMOTE_TRANSCRIPT_MAX_WIRE_BYTES, Math.max(TRANSCRIPT_TAIL_BYTES, Math.round((limit / 60) * TRANSCRIPT_TAIL_BYTES)));
      const out = await ssh(e.host, `tail -c ${tailBytes} ${shQuote(e.transcriptPath)}`, {
        timeout: 20000,
        maxBuffer: tailBytes * 2,
      });
      const truncated = fileSize > tailBytes;
      const lines = out.split('\n');
      if (truncated) lines.shift();
      return parseClaudeJsonlLines(lines, sessionId, e.mtimeMs ?? Date.now(), limit, {
        truncated,
        fileSize,
        bytesRead: Math.min(fileSize, tailBytes),
        tailActivity: { working: running, mtimeMs: e.mtimeMs ?? Date.now() },
      });
    }
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
      // If Claude is waiting on an interactive AskUserQuestion TUI picker, drive the
      // arrow/Enter wizard directly instead of typing raw text into the option list.
      if (!attachments?.length) {
        try {
          const recent = await this.loadTranscript(sessionId, 10);
          const pendingQ = extractPendingQuestionBlock(recent);
          const choices = pendingQ ? resolveClaudeQuestionAnswers(pendingQ.questions, prompt) : null;
          if (pendingQ && choices) {
            const qScript = buildRemoteClaudeQuestionTmuxScript(e.tmux, pendingQ.questions, choices);
            try {
              await ssh(e.host, 'sh -s', { input: qScript, timeout: 30000 });
              setTimeout(() => void this.poll(), 800);
              return { ok: true, dispatchedVia: `tmux question picker over SSH → ${e.label} ${e.tmux}` };
            } catch (qErr: unknown) {
              const code = (qErr as { code?: number })?.code;
              if (code !== 42) throw qErr;
              // Exit 42: pane is no longer showing AskUserQuestion — fall through to normal typing.
            }
          }
        } catch {
          // Non-fatal: fall through to standard typing if transcript inspection fails.
        }
      }

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
