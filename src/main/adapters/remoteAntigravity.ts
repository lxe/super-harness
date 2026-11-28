import { execFile, spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  ImageAttachment,
  SendMessageResult,
  SessionTranscriptResult,
  StreamEvent,
  UnifiedSession,
} from '../../shared/types';
import { cleanUserPreview } from '../utils/lastUserText';
import { cleanTextPreview, normalizeTimestamp, projectNameFromCwd } from '../utils/system';
import { loadRemoteHosts, shQuote, type RemoteHostConfig } from './remoteClaude';
import { formatPromptWithImagePaths, isImageAttachment, type DispatchContext } from './types';
import { parseAntigravityJsonlLines } from './antigravityAdapter';
import { RemoteHostHealth } from './remoteHostHealth';

/**
 * Google Antigravity sessions (both Antigravity Desktop and `agy` CLI) running on
 * other machines (e.g. lxe's MacBook), mirrored over SSH.
 *
 * Uses the same ~/.config/super-harness/remote-hosts.json and ControlMaster SSH
 * socket pool as RemoteClaudeMirror so discovery adds negligible latency.
 */

export interface RemoteAntigravityEntry {
  host: string;
  label: string;
  sessionId: string;
  originApp: 'antigravity-app' | 'antigravity-cli';
  transcriptPath: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  title?: string;
  preview?: string;
  firstUserTitle?: string;
  firstUserPreview?: string;
  lastUserText?: string;
  workspaceUris?: string;
  status?: string;
  lastModifiedTime?: string;
  parentConversationId?: string;
  nestingDepth?: number;
  killed?: boolean;
  isSubagent?: boolean;
  model?: string;
  tailWorking?: boolean;
  hubAvailable?: boolean;
}

const POLL_MS = 4000;
const TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;
const MAX_REMOTE_SESSIONS_PER_HOST = 40;

const SSH_BASE = [
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=5',
  '-o', 'ServerAliveInterval=10',
  '-o', 'ControlMaster=auto',
  '-o', `ControlPath=${path.join(os.tmpdir(), 'sh-ssh-%C')}`,
  '-o', 'ControlPersist=300',
];

const REMOTE_PATH =
  'export PATH=/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.gemini/antigravity/bin:$PATH;';

/** Lists Antigravity Desktop & CLI sessions on the remote host as one JSON array. */
export const ANTIGRAVITY_DISCOVERY_SCRIPT = String.raw`
import glob, json, os, re, sqlite3, time

home = os.path.expanduser('~')
now_ms = time.time() * 1000.0

USER_REQ_RE = re.compile(r'<USER_REQUEST>([\s\S]*?)</USER_REQUEST>')
TAG_RE = re.compile(r'<USER_REQUEST>|</USER_REQUEST>|<ADDITIONAL_METADATA>[\s\S]*?</ADDITIONAL_METADATA>')

def strip_tags(raw):
    if not isinstance(raw, str):
        return ''
    m = USER_REQ_RE.search(raw)
    if m:
        return m.group(1).strip()
    return TAG_RE.sub('', raw).strip()

def check_hub_alive(app_dir):
    for p in sorted(glob.glob(os.path.join(app_dir, 'daemon', 'hub_*.json')), reverse=True):
        try:
            d = json.load(open(p))
            pid = int(d.get('pid', 0))
            if pid > 0 and d.get('httpsPort') and d.get('csrfToken'):
                os.kill(pid, 0)
                return True
        except Exception:
            continue
    return False

def load_summaries(base_dir):
    db_path = os.path.join(base_dir, 'conversation_summaries.db')
    res = {}
    if not os.path.isfile(db_path):
        return res
    try:
        conn = sqlite3.connect(f'file:{db_path}?mode=ro', uri=True, timeout=1.5)
        cur = conn.cursor()
        cur.execute(
            'SELECT conversation_id, title, preview, last_modified_time, workspace_uris, '
            'status, parent_conversation_id, nesting_depth, killed '
            'FROM conversation_summaries'
        )
        for row in cur.fetchall():
            cid = row[0]
            if cid:
                res[cid] = {
                    'title': row[1] or '',
                    'preview': row[2] or '',
                    'lastModifiedTime': row[3] or '',
                    'workspaceUris': row[4] or '',
                    'status': row[5] or '',
                    'parentConversationId': row[6] or '',
                    'nestingDepth': int(row[7] or 0),
                    'killed': bool(row[8]),
                }
        conn.close()
    except Exception:
        pass
    return res

def inspect_transcript(tr_path, size, mtime_ms):
    info = {'isSubagent': False, 'tailWorking': False}
    try:
        with open(tr_path, 'rb') as fh:
            head = fh.read(49152).decode('utf8', 'replace')
            first_checked = False
            for line in head.split('\n'):
                s = line.strip()
                if not s:
                    continue
                try:
                    o = json.loads(s)
                except Exception:
                    continue
                if not first_checked:
                    first_checked = True
                    src = o.get('source')
                    if src and src != 'USER_EXPLICIT':
                        info['isSubagent'] = True
                if o.get('type') == 'USER_INPUT' and isinstance(o.get('content'), str):
                    cleaned = strip_tags(o['content'])
                    if cleaned:
                        info['firstUserTitle'] = cleaned[:120]
                        info['firstUserPreview'] = cleaned[:200]
                        break

            tail_len = min(size, 131072)
            fh.seek(max(0, size - tail_len))
            tail = fh.read(tail_len).decode('utf8', 'replace')
            lines = tail.split('\n')
            checked_last = False
            for line in reversed(lines):
                s = line.strip()
                if not s:
                    continue
                try:
                    o = json.loads(s)
                except Exception:
                    continue
                step_type = o.get('type') or ''
                status = o.get('status') or ''
                if not checked_last and (step_type or status):
                    checked_last = True
                    if now_ms - mtime_ms < 35000.0:
                        if status == 'RUNNING':
                            info['tailWorking'] = True
                        elif step_type in ('GENERIC', 'SYSTEM_MESSAGE', 'USER_INPUT'):
                            info['tailWorking'] = True
                        elif step_type == 'PLANNER_RESPONSE' and isinstance(o.get('tool_calls'), list) and len(o['tool_calls']) > 0:
                            info['tailWorking'] = True
                if 'model' not in info and step_type == 'PLANNER_RESPONSE' and isinstance(o.get('model'), str) and o['model']:
                    info['model'] = o['model']
                if 'lastUserText' not in info and step_type == 'USER_INPUT' and o.get('source', 'USER_EXPLICIT') == 'USER_EXPLICIT' and isinstance(o.get('content'), str):
                    cleaned = strip_tags(o['content'])
                    if cleaned:
                        info['lastUserText'] = cleaned[:400]
                if 'model' in info and 'lastUserText' in info and checked_last:
                    break
    except Exception:
        pass
    return info

app_dir = os.path.join(home, '.gemini', 'antigravity')
cli_dir = os.path.join(home, '.gemini', 'antigravity-cli')
hub_alive = check_hub_alive(app_dir)

summaries = {}
for base in (app_dir, cli_dir):
    summaries.update(load_summaries(base))

seen = set()
found = []
for base, origin in ((app_dir, 'antigravity-app'), (cli_dir, 'antigravity-cli')):
    brain = os.path.join(base, 'brain')
    if not os.path.isdir(brain):
        continue
    try:
        for name in os.listdir(brain):
            if name in seen:
                continue
            tr = os.path.join(brain, name, '.system_generated', 'logs', 'transcript.jsonl')
            if not os.path.isfile(tr):
                continue
            try:
                st = os.stat(tr)
            except Exception:
                continue
            seen.add(name)
            found.append((st.st_mtime * 1000.0, getattr(st, 'st_birthtime', st.st_ctime) * 1000.0, st.st_size, name, origin, tr))
    except Exception:
        pass

found.sort(key=lambda x: x[0], reverse=True)
out = []
for mtime_ms, ctime_ms, size, cid, origin, tr in found[:40]:
    sm = summaries.get(cid, {})
    insp = inspect_transcript(tr, size, mtime_ms)
    is_sub = bool(insp.get('isSubagent') or sm.get('parentConversationId') or (sm.get('nestingDepth', 0) > 0))
    entry = {
        'sessionId': cid,
        'originApp': origin,
        'transcriptPath': tr,
        'size': size,
        'mtimeMs': mtime_ms,
        'ctimeMs': ctime_ms,
        'isSubagent': is_sub,
        'tailWorking': bool(insp.get('tailWorking')),
        'hubAvailable': hub_alive,
    }
    for k in ('title', 'preview', 'lastModifiedTime', 'workspaceUris', 'status', 'parentConversationId', 'nestingDepth', 'killed'):
        if sm.get(k):
            entry[k] = sm[k]
    for k in ('firstUserTitle', 'firstUserPreview', 'lastUserText', 'model'):
        if insp.get(k):
            entry[k] = insp[k]
    out.append(entry)

print(json.dumps(out))
`;

/** Remote script to send a message or cancel a cascade via the remote host's live Antigravity Desktop hub LS. */
const REMOTE_HUB_RPC_SCRIPT = String.raw`
import glob, json, os, ssl, sys, urllib.request

payload = json.loads(sys.stdin.read())
action = payload.get('action', 'send')
cascade_id = payload['cascadeId']

hub = None
for p in sorted(glob.glob(os.path.expanduser('~/.gemini/antigravity/daemon/hub_*.json')), reverse=True):
    try:
        d = json.load(open(p))
        pid = int(d.get('pid', 0))
        if pid > 0 and d.get('httpsPort') and d.get('csrfToken'):
            os.kill(pid, 0)
            hub = d
            break
    except Exception:
        continue

if not hub:
    print(json.dumps({'ok': False, 'error': 'Remote Antigravity Desktop hub is not running'}))
    sys.exit(0)

ctx = ssl._create_unverified_context()
base = f"https://127.0.0.1:{hub['httpsPort']}/exa.language_server_pb.LanguageServerService"
headers = {
    'Content-Type': 'application/json',
    'Connect-Protocol-Version': '1',
    'x-codeium-csrf-token': hub['csrfToken'],
}

def post(method, body):
    req = urllib.request.Request(f'{base}/{method}', data=json.dumps(body).encode('utf8'), headers=headers)
    with urllib.request.urlopen(req, context=ctx, timeout=20) as resp:
        raw = resp.read().decode('utf8', 'replace')
        return json.loads(raw) if raw.strip() else {}

try:
    if action == 'cancel':
        post('CancelCascadeInvocation', {'cascadeId': cascade_id})
        print(json.dumps({'ok': True}))
        sys.exit(0)

    plan_model = None
    model_slug = (payload.get('modelSlug') or '').strip()
    if model_slug:
        try:
            avail = post('GetAvailableModels', {})
            models = avail.get('models') or avail.get('clientModelConfigs') or []
            norm = model_slug.lower()
            for m in models:
                mid = str(m.get('modelOrAlias', {}).get('model') or m.get('model') or m.get('id') or '')
                label = str(m.get('label') or m.get('name') or '')
                if mid.lower() == norm or label.lower() == norm or norm in mid.lower() or norm in label.lower():
                    plan_model = mid or None
                    break
        except Exception:
            pass

    req_body = {
        'cascadeId': cascade_id,
        'items': [{'text': payload['text']}] if (payload.get('text') or '').strip() else [],
    }
    if payload.get('media'):
        req_body['media'] = payload['media']
    if plan_model:
        req_body['cascadeConfig'] = {'plannerConfig': {'planModel': plan_model}}

    try:
        post('SendUserCascadeMessage', req_body)
    except Exception:
        post('StartCascade', {'cascadeId': cascade_id, 'source': 1})
        post('SendUserCascadeMessage', req_body)

    print(json.dumps({'ok': True}))
except Exception as e:
    print(json.dumps({'ok': False, 'error': str(e)}))
`;

function ssh(
  host: string,
  remoteCmd: string,
  opts: { input?: string; timeout?: number; maxBuffer?: number } = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'ssh',
      [...SSH_BASE, host, remoteCmd],
      { timeout: opts.timeout ?? 10000, maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(stdout))
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

function scp(localPath: string, host: string, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      'scp',
      [...SSH_BASE, '-q', localPath, `${host}:${remotePath}`],
      { timeout: 30000 },
      (err) => (err ? reject(err) : resolve())
    );
  });
}

function extractRemoteCwd(workspaceUris?: string): string {
  if (!workspaceUris) return '~';
  try {
    const arr = JSON.parse(workspaceUris) as unknown;
    if (Array.isArray(arr) && typeof arr[0] === 'string' && arr[0].trim()) {
      return arr[0].replace(/^file:\/\//, '');
    }
  } catch {
    // ignore
  }
  return '~';
}

export function buildRemoteAgyPrintCommand(opts: {
  sessionId: string;
  prompt: string;
  cwd?: string;
  model?: string;
}): string {
  const parts: string[] = [REMOTE_PATH];
  if (opts.cwd && opts.cwd !== '~') {
    parts.push(`cd ${shQuote(opts.cwd)} 2>/dev/null || true;`);
  }
  const args = ['agy', '--conversation', shQuote(opts.sessionId), '--print', shQuote(opts.prompt)];
  if (opts.model && opts.model.trim()) {
    args.push('--model', shQuote(opts.model.trim()));
  }
  parts.push(args.join(' '));
  return parts.join(' ');
}

export function toUnifiedRemoteAntigravitySession(
  e: RemoteAntigravityEntry,
  host: { offline: boolean; lastSeenAt?: number } = { offline: false }
): UnifiedSession {
  const cwd = extractRemoteCwd(e.workspaceUris);
  const title =
    cleanTextPreview(e.title || e.firstUserTitle || e.preview, 90) ||
    `Antigravity ${e.sessionId.slice(0, 8)}`;
  const preview =
    cleanTextPreview(e.preview || e.firstUserPreview, 140) || `Antigravity on ${e.label}`;
  const updatedAt = Math.max(e.mtimeMs || 0, normalizeTimestamp(e.lastModifiedTime ?? 0));
  const isRunning =
    !host.offline &&
    (e.status === 'CASCADE_RUN_STATUS_RUNNING' ||
    Boolean(e.tailWorking) ||
      (e.status !== 'CASCADE_RUN_STATUS_IDLE' && Date.now() - e.mtimeMs < 20_000));
  const isLive = !host.offline && (isRunning || Date.now() - updatedAt < 10 * 60 * 1000);
  const projectName = cwd !== '~' ? projectNameFromCwd(cwd) : e.label;

  return {
    id: `antigravity:${e.sessionId}`,
    nativeId: e.sessionId,
    harness: 'antigravity',
    harnessGroup: 'antigravity',
    title,
    preview,
    lastUserText: cleanUserPreview(e.lastUserText),
    cwd,
    projectName,
    nativeSection: e.label,
    nativeSectionOrder: 50,
    model: e.model,
    status: e.killed ? 'archived' : isRunning ? 'running' : 'idle',
    isLive,
    isRemote: true,
    hostAddress: e.host,
    hostLabel: e.label,
    hostOffline: host.offline || undefined,
    hostLastSeenAt: host.lastSeenAt,
    createdAt: e.ctimeMs || updatedAt,
    updatedAt,
    pinned: false,
    folderId: null,
    tags: e.isSubagent
      ? ['remote-host', e.label, 'subagent']
      : ['remote-host', e.label, e.originApp === 'antigravity-cli' ? 'cli' : 'desktop'],
    hidden: false,
    dispatchMode: 'agy-resume',
    liveOwner:
      isRunning && e.originApp === 'antigravity-app' && e.hubAvailable ? 'desktop' : undefined,
    isSubagent: Boolean(e.isSubagent),
    parentSessionId: e.parentConversationId
      ? `antigravity:${e.parentConversationId}`
      : undefined,
    originApp: e.originApp,
  };
}

export class RemoteAntigravityMirror {
  private entries = new Map<string, RemoteAntigravityEntry>();
  private timer: NodeJS.Timeout | null = null;
  private polling: Promise<void> | null = null;
  private firstPoll: Promise<void> | null = null;
  private sink: ((sessionId: string) => void) | null = null;
  private readonly health = new RemoteHostHealth(POLL_MS);
  private activeProcs = new Map<string, ChildProcess>();

  constructor(private readonly hostsProvider: () => RemoteHostConfig[] = () => loadRemoteHosts()) {}

  setActivitySink(sink: ((sessionId: string) => void) | null): void {
    this.sink = sink;
  }

  isRemote(sessionId: string): boolean {
    return this.entries.has(sessionId);
  }

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
    const list = Array.from(this.entries.values()).map((e) => toUnifiedRemoteAntigravitySession(e, this.health.status(e.host)));
    const subCountByParent = new Map<string, number>();
    for (const s of list) {
      if (s.isSubagent && s.parentSessionId) {
        subCountByParent.set(
          s.parentSessionId,
          (subCountByParent.get(s.parentSessionId) ?? 0) + 1
        );
      }
    }
    for (const s of list) {
      const cnt = subCountByParent.get(s.id);
      if (cnt) s.subagentCount = cnt;
    }
    return list;
  }

  fingerprint(sessionId: string): string | undefined {
    const e = this.entries.get(sessionId);
    return e
      ? `remote-agy:${e.host}:${e.size}:${Math.floor(e.mtimeMs)}:${e.status ?? ''}:${e.tailWorking ? 1 : 0}`
      : undefined;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const proc of this.activeProcs.values()) {
      try {
        proc.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
    this.activeProcs.clear();
  }

  private poll(): Promise<void> {
    if (this.polling) return this.polling;
    this.polling = (async () => {
      const next = new Map<string, RemoteAntigravityEntry>();
      const failedHosts = new Set<string>();
      await Promise.all(
        this.hostsProvider().map(async (h) => {
          const label = h.label || h.host;
          if (!this.health.shouldPoll(h.host)) {
            failedHosts.add(h.host);
            return;
          }
          try {
            const out = await ssh(h.host, 'python3 -', {
              input: ANTIGRAVITY_DISCOVERY_SCRIPT,
              timeout: 10000,
            });
            const parsed = JSON.parse(out) as Array<Omit<RemoteAntigravityEntry, 'host' | 'label'>>;
            for (const raw of parsed.slice(0, MAX_REMOTE_SESSIONS_PER_HOST)) {
              if (!raw?.sessionId) continue;
              next.set(`antigravity:${raw.sessionId}`, { ...raw, host: h.host, label });
            }
            this.health.recordSuccess(h.host);
          } catch {
            this.health.recordFailure(h.host);
            failedHosts.add(h.host);
          }
        })
      );
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
          p.mtimeMs !== e.mtimeMs ||
          p.status !== e.status ||
          p.tailWorking !== e.tailWorking ||
          p.title !== e.title
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
    const truncated = e.size > TRANSCRIPT_TAIL_BYTES;
    const lines = out.split('\n');
    if (truncated) lines.shift();
    const res = parseAntigravityJsonlLines(lines, sessionId, e.mtimeMs || Date.now(), limit, {
      truncated,
      fileSize: e.size,
      bytesRead: Math.min(e.size, TRANSCRIPT_TAIL_BYTES),
    });
    const isWorking =
      e.status === 'CASCADE_RUN_STATUS_RUNNING' ||
      Boolean(e.tailWorking) ||
      this.activeProcs.has(sessionId);
    if (isWorking) {
      res.liveActivity = {
        ...(res.liveActivity ?? { isWorking: true }),
        isWorking: true,
        lastEventAt: Math.max(res.liveActivity?.lastEventAt ?? 0, e.mtimeMs || Date.now()),
      };
    }
    return res;
  }

  async sendMessage(
    session: UnifiedSession,
    prompt: string,
    attachments: ImageAttachment[] | undefined,
    ctx: DispatchContext
  ): Promise<SendMessageResult> {
    let e = this.entries.get(session.id);
    if (!e) {
      await this.poll();
      e = this.entries.get(session.id);
    }
    if (!e) {
      return { ok: false, error: 'Remote Antigravity session is no longer listed on its host.' };
    }

    const runId = crypto.randomBytes(6).toString('hex');

    // Lane 1: Antigravity Desktop with a live hub LS on the remote host
    if (e.originApp === 'antigravity-app' && e.hubAvailable) {
      try {
        const media: Array<{ mediaId: string; mimeType: string; inlineData: string }> = [];
        // The hub only takes inline images; copy other files to the host and reference their paths.
        const fileAtts = (attachments ?? []).filter(
          (a) => !isImageAttachment(a) && a.path && fs.existsSync(a.path)
        );
        let hubText = prompt;
        if (fileAtts.length > 0) {
          const remoteDir = '.cache/super-harness/attachments';
          await ssh(e.host, `mkdir -p ${remoteDir}`);
          const home = (await ssh(e.host, 'printf %s "$HOME"')).trim();
          const copied: ImageAttachment[] = [];
          for (const a of fileAtts) {
            const rel = `${remoteDir}/${path.basename(a.path)}`;
            await scp(a.path, e.host, rel);
            copied.push({ ...a, path: `${home}/${rel}` });
          }
          hubText = formatPromptWithImagePaths(prompt, copied);
        }
        for (const att of (attachments ?? []).filter(isImageAttachment)) {
          if (!att.path || !fs.existsSync(att.path)) continue;
          media.push({
            mediaId: att.name || path.basename(att.path),
            mimeType: att.mimeType && att.mimeType.startsWith('image/') ? att.mimeType : 'image/png',
            inlineData: fs.readFileSync(att.path).toString('base64'),
          });
        }
        ctx.emitStream({ sessionId: session.id, runId, kind: 'start' });
        const payload = JSON.stringify({
          action: 'send',
          cascadeId: e.sessionId,
          text: hubText,
          modelSlug: session.model,
          media,
        });
        const wrappedScript = `PAYLOAD_JSON = ${JSON.stringify(payload)}\nimport io, sys\nsys.stdin = io.StringIO(PAYLOAD_JSON)\n${REMOTE_HUB_RPC_SCRIPT}`;
        const rpcOut = await ssh(e.host, 'python3 -', { input: wrappedScript, timeout: 25000 });
        const rpcRes = JSON.parse(rpcOut.trim() || '{}') as { ok?: boolean; error?: string };
        ctx.emitStream({ sessionId: session.id, runId, kind: 'done' });
        if (!rpcRes.ok) {
          return {
            ok: false,
            error: rpcRes.error || `Remote Antigravity hub rejected message on ${e.label}`,
          };
        }
        setTimeout(() => void this.poll(), 600);
        ctx.triggerRefresh(600);
        ctx.triggerRefresh(2000);
        return {
          ok: true,
          runId,
          dispatchedVia: `Antigravity Desktop hub over SSH → ${e.label}`,
        };
      } catch (err) {
        ctx.emitStream({ sessionId: session.id, runId, kind: 'done' });
        return {
          ok: false,
          error: `Sending to Antigravity Desktop on ${e.label} failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    // Lane 2: Antigravity CLI (`agy --conversation <id> --print ...`) over SSH
    try {
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
      const remoteCmd = buildRemoteAgyPrintCommand({
        sessionId: e.sessionId,
        prompt: text,
        cwd: extractRemoteCwd(e.workspaceUris),
        model: session.model,
      });

      const prev = this.activeProcs.get(session.id);
      if (prev) {
        try {
          prev.kill('SIGTERM');
        } catch {
          // ignore
        }
      }

      ctx.emitStream({ sessionId: session.id, runId, kind: 'start' });
      const child = spawn('ssh', [...SSH_BASE, e.host, remoteCmd], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.activeProcs.set(session.id, child);
      let stderrTail = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderrTail = (stderrTail + chunk.toString('utf8')).slice(-1000);
      });

      const earlyFailure = await new Promise<string | null>((resolve) => {
        let settled = false;
        const finish = (err: string | null) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(err);
        };
        const timer = setTimeout(() => finish(null), 900);
        child.once('error', (err) => finish(err.message));
        child.once('exit', (code) => {
          this.activeProcs.delete(session.id);
          ctx.emitStream({ sessionId: session.id, runId, kind: 'done' });
          void this.poll();
          ctx.triggerRefresh(400);
          if (code && code !== 0) {
            finish(stderrTail.trim() || `agy exited with code ${code}`);
          } else {
            finish(null);
          }
        });
      });

      if (earlyFailure) {
        this.activeProcs.delete(session.id);
        ctx.emitStream({ sessionId: session.id, runId, kind: 'done' });
        return { ok: false, error: `Remote agy on ${e.label} failed: ${earlyFailure}` };
      }

      // If still running after initial startup check, clean up on completion
      child.once('exit', () => {
        this.activeProcs.delete(session.id);
        ctx.emitStream({ sessionId: session.id, runId, kind: 'done' });
        void this.poll();
        ctx.triggerRefresh(400);
      });

      setTimeout(() => void this.poll(), 800);
      ctx.triggerRefresh(1000);
      return {
        ok: true,
        runId,
        dispatchedVia: `agy CLI over SSH → ${e.label}`,
      };
    } catch (err) {
      ctx.emitStream({ sessionId: session.id, runId, kind: 'done' });
      return {
        ok: false,
        error: `Sending to Antigravity on ${e.label} failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  abort(sessionId: string, emitStream: (ev: StreamEvent) => void): boolean {
    const e = this.entries.get(sessionId);
    const proc = this.activeProcs.get(sessionId);
    if (!e && !proc) return false;
    if (proc) {
      try {
        proc.kill('SIGTERM');
      } catch {
        // ignore
      }
      this.activeProcs.delete(sessionId);
    }
    if (e?.originApp === 'antigravity-app' && e.hubAvailable) {
      const payload = JSON.stringify({ action: 'cancel', cascadeId: e.sessionId });
      const wrappedScript = `PAYLOAD_JSON = ${JSON.stringify(payload)}\nimport io, sys\nsys.stdin = io.StringIO(PAYLOAD_JSON)\n${REMOTE_HUB_RPC_SCRIPT}`;
      void ssh(e.host, 'python3 -', { input: wrappedScript, timeout: 10000 }).catch(() => {});
    }
    emitStream({ sessionId, runId: 'abort', kind: 'done' });
    return true;
  }
}
