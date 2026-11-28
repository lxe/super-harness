import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  AcpAgentDefinition,
  AcpAgentTestResult,
  HarnessDetection,
  StartSessionRequest,
  StreamEvent,
  UnifiedBlock,
  UnifiedMessage,
  UnifiedSession,
} from '../../shared/types';
import { AcpConnection, type AcpAgentCommand, type AcpModels, type AcpUpdate } from '../services/acpClient';
import { cleanTextPreview, projectNameFromCwd } from '../utils/system';
import { computeFileFingerprint, formatPromptWithImagePaths, type DispatchContext, type HarnessDriver } from './types';

/**
 * Generic driver for any Agent Client Protocol agent the user lists in
 * `~/.config/super-harness/acp-agents.json`:
 *
 *   { "agents": [{ "id": "gemini", "name": "Gemini CLI", "command": "gemini", "args": ["--experimental-acp"] }] }
 *
 * ACP agents keep no history in a shared format, so Superharness hosts these sessions itself and
 * logs each one to `~/.config/super-harness/acp-sessions/<id>.jsonl`, which is the transcript.
 */
export type AcpAgentConfig = AcpAgentDefinition & AcpAgentCommand;

const CONFIG_DIR = path.join(os.homedir(), '.config', 'super-harness');
export const ACP_AGENTS_PATH = path.join(CONFIG_DIR, 'acp-agents.json');
export const ACP_SESSIONS_DIR = path.join(CONFIG_DIR, 'acp-sessions');
/** The models each agent last reported, keyed by agent ID (see `acpModelsFor`). */
export const ACP_MODELS_PATH = path.join(CONFIG_DIR, 'acp-models.json');

type ModelCache = Record<string, AcpModels & { command: string; updatedAt: number }>;
const commandKey = (a: AcpAgentCommand) => JSON.stringify([a.command, ...(a.args ?? [])]);

function readModelCache(file: string): ModelCache {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as ModelCache;
  } catch {
    return {};
  }
}

/** Remembers what an agent reported, so the new-session picker can list its models. */
export function rememberAcpModels(agent: AcpAgentConfig, models: AcpModels | null, file = ACP_MODELS_PATH): void {
  if (!models) return;
  const cache = readModelCache(file);
  cache[agent.id] = { ...models, command: commandKey(agent), updatedAt: Date.now() };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(cache, null, 2)}\n`);
  } catch {
    // the picker just falls back to the agent's default model
  }
}

/**
 * The agent's models. ACP has no "list models" call: agents report them when a session is
 * created. So this uses what the last session (or Test) reported, and only when nothing is known
 * for this command does it start the agent and open a throwaway session to ask.
 */
export async function acpModelsFor(agent: AcpAgentConfig, file = ACP_MODELS_PATH, timeoutMs = 20_000): Promise<AcpModels | null> {
  const cached = readModelCache(file)[agent.id];
  if (cached && cached.command === commandKey(agent)) return cached;
  const conn = new AcpConnection(agent);
  let timer: NodeJS.Timeout | undefined;
  try {
    const { models } = await Promise.race([
      conn.start(os.homedir()).then(() => conn.newSession(os.homedir())),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      }),
    ]);
    rememberAcpModels(agent, models, file);
    return models;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    conn.close();
  }
}

export function loadAcpAgents(configPath = ACP_AGENTS_PATH): AcpAgentConfig[] {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { agents?: unknown };
    if (!Array.isArray(raw.agents)) return [];
    return raw.agents.filter(
      (a): a is AcpAgentConfig =>
        Boolean(a) &&
        typeof (a as AcpAgentConfig).id === 'string' &&
        typeof (a as AcpAgentConfig).command === 'string' &&
        Boolean((a as AcpAgentConfig).id && (a as AcpAgentConfig).command) &&
        ((a as AcpAgentConfig).args === undefined || Array.isArray((a as AcpAgentConfig).args))
    );
  } catch {
    return [];
  }
}

/** Checks and writes the agent list, keeping any other keys in the file. */
export function saveAcpAgents(agents: AcpAgentConfig[], configPath = ACP_AGENTS_PATH): { ok: boolean; error?: string } {
  const seen = new Set<string>();
  const clean: AcpAgentConfig[] = [];
  for (const a of agents) {
    const id = String(a.id ?? '').trim();
    const command = String(a.command ?? '').trim();
    if (!/^[A-Za-z0-9._-]+$/.test(id)) return { ok: false, error: `"${id || '(empty)'}" is not a valid ID: use letters, digits, dot, dash or underscore.` };
    if (!command) return { ok: false, error: `${id} needs a command.` };
    if (seen.has(id)) return { ok: false, error: `Two agents use the ID ${id}.` };
    seen.add(id);
    const args = (a.args ?? []).map(String).filter((x) => x.length > 0);
    const env = a.env && Object.keys(a.env).length ? a.env : undefined;
    clean.push({ id, ...(a.name?.trim() ? { name: a.name.trim() } : {}), command, ...(args.length ? { args } : {}), ...(env ? { env } : {}) });
  }
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  } catch {
    // new file
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify({ ...raw, agents: clean }, null, 2)}\n`);
  return { ok: true };
}

/** Where a command resolves on PATH (or the path itself, when it is one), or null. */
export function resolveAcpCommand(command: string, envPath = process.env.PATH ?? ''): string | null {
  const isExec = (p: string) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (command.includes('/')) return isExec(command) ? command : null;
  for (const dir of envPath.split(path.delimiter)) {
    if (dir && isExec(path.join(dir, command))) return path.join(dir, command);
  }
  return null;
}

/** Starts the agent, runs the ACP `initialize` handshake, and stops it. */
export async function testAcpAgent(agent: AcpAgentConfig, timeoutMs = 20_000, modelsFile = ACP_MODELS_PATH): Promise<AcpAgentTestResult> {
  const started = Date.now();
  const conn = new AcpConnection(agent);
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      conn.start(os.homedir()),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no ACP answer within ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
      }),
    ]);
    // A session reports the agent's models; refresh the picker's list while we're here.
    let models: AcpModels | null = null;
    try {
      models = (
        await Promise.race([
          conn.newSession(os.homedir()),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs).unref()),
        ])
      ).models;
      rememberAcpModels(agent, models, modelsFile);
    } catch {
      // handshake worked; the agent just would not open a session (e.g. not logged in)
    }
    return {
      ok: true,
      modelCount: models?.models.length ?? 0,
      agentName: conn.agentInfo?.name,
      agentVersion: conn.agentInfo?.version,
      canLoadSession: conn.canLoadSession,
      ms: Date.now() - started,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), ms: Date.now() - started };
  } finally {
    if (timer) clearTimeout(timer);
    conn.close();
  }
}

/** One line of a session log. */
type LogRecord =
  | { type: 'meta'; agentId: string; agentName: string; acpSessionId: string; cwd: string; title: string; createdAt: number; model?: string }
  | { type: 'user'; ts: number; text: string }
  | { type: 'turn'; ts: number; blocks: UnifiedBlock[]; stopReason?: string; error?: string };

function readLog(file: string): LogRecord[] {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as LogRecord];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

function appendLog(file: string, rec: LogRecord): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(rec)}\n`);
}

/** Collects one turn's streamed updates into transcript blocks. */
class TurnBuilder {
  readonly blocks: UnifiedBlock[] = [];
  private tools = new Map<string, Extract<UnifiedBlock, { type: 'tool_call' }>>();

  /** Returns what to stream to the open pane, if anything. */
  add(u: AcpUpdate): { delta?: string; block?: UnifiedBlock } {
    const content = u.content as { type?: string; text?: string } | undefined;
    const last = this.blocks[this.blocks.length - 1];
    if (u.sessionUpdate === 'agent_message_chunk' && content?.type === 'text' && content.text) {
      if (last?.type === 'text') last.text += content.text;
      else this.blocks.push({ type: 'text', text: content.text });
      return { delta: content.text };
    }
    if (u.sessionUpdate === 'agent_thought_chunk' && content?.type === 'text' && content.text) {
      if (last?.type === 'thinking') last.text += content.text;
      else this.blocks.push({ type: 'thinking', text: content.text });
      return {};
    }
    if (u.sessionUpdate === 'tool_call' || u.sessionUpdate === 'tool_call_update') {
      const id = String(u.toolCallId ?? '');
      let block = this.tools.get(id);
      if (!block) {
        block = { type: 'tool_call', name: String(u.title ?? u.kind ?? 'tool'), status: 'pending' };
        this.tools.set(id, block);
        this.blocks.push(block);
      }
      if (typeof u.title === 'string' && u.title) block.name = u.title;
      if (typeof u.status === 'string') block.status = u.status;
      return u.sessionUpdate === 'tool_call' ? { block: { ...block } } : {};
    }
    return {};
  }
}

interface LiveSession {
  conn: AcpConnection;
  acpSessionId: string;
  running: { runId: string } | null;
}

export function createAcpDriver(
  opts: { agents?: () => AcpAgentConfig[]; sessionsDir?: string; modelsFile?: string } = {}
): HarnessDriver {
  const agents = opts.agents ?? (() => loadAcpAgents());
  const sessionsDir = opts.sessionsDir ?? ACP_SESSIONS_DIR;
  const modelsFile = opts.modelsFile ?? ACP_MODELS_PATH;
  const live = new Map<string, LiveSession>();
  const logPath = (nativeId: string) => path.join(sessionsDir, `${nativeId}.jsonl`);
  const nativeIdOf = (sessionId: string) => sessionId.replace(/^acp:/, '');

  function metaOf(nativeId: string): Extract<LogRecord, { type: 'meta' }> | undefined {
    const first = readLog(logPath(nativeId))[0];
    return first?.type === 'meta' ? first : undefined;
  }

  /** The running agent for a session, starting it (and reloading the session) if needed. */
  async function connect(nativeId: string): Promise<LiveSession> {
    const existing = live.get(nativeId);
    if (existing?.conn.alive) return existing;
    const meta = metaOf(nativeId);
    if (!meta) throw new Error('This ACP session has no log, so it cannot be resumed.');
    const agent = agents().find((a) => a.id === meta.agentId);
    if (!agent) throw new Error(`The ACP agent "${meta.agentId}" is no longer in ${ACP_AGENTS_PATH}.`);
    // One directory for both the process and session/load: a deleted project folder falls back to home.
    const cwd = fs.existsSync(meta.cwd) ? meta.cwd : os.homedir();
    const conn = new AcpConnection(agent);
    await conn.start(cwd);
    if (!conn.canLoadSession) {
      conn.close();
      throw new Error(
        `${agent.name ?? agent.id} can’t reopen a session after its process ends (it doesn’t support session/load). Start a new session instead.`
      );
    }
    const models = await conn.loadSession(meta.acpSessionId, cwd);
    // Agents may not keep a session's model across restarts, so set it again.
    if (meta.model && models && models.current !== meta.model) {
      await conn.setModel(meta.acpSessionId, models, meta.model).catch(() => {});
    }
    return track(nativeId, conn, meta.acpSessionId);
  }

  function track(nativeId: string, conn: AcpConnection, acpSessionId: string): LiveSession {
    const entry: LiveSession = { conn, acpSessionId, running: null };
    live.set(nativeId, entry);
    conn.onExit(() => {
      if (live.get(nativeId) === entry) live.delete(nativeId);
    });
    return entry;
  }

  /** Runs one turn in the background, logging it and streaming it to open panes. */
  function runTurn(nativeId: string, entry: LiveSession, text: string, ctx: DispatchContext): string {
    const sessionId = `acp:${nativeId}`;
    const runId = crypto.randomBytes(6).toString('hex');
    const emit = (ev: Omit<StreamEvent, 'sessionId' | 'runId'>) => ctx.emitStream({ sessionId, runId, ...ev });
    appendLog(logPath(nativeId), { type: 'user', ts: Date.now(), text });
    entry.running = { runId };
    const turn = new TurnBuilder();
    emit({ kind: 'start' });
    ctx.triggerRefresh();
    void entry.conn
      .prompt(entry.acpSessionId, text, (u) => {
        const out = turn.add(u);
        if (out.delta) emit({ kind: 'delta', text: out.delta });
        if (out.block) emit({ kind: 'block', block: out.block });
      })
      .then(
        (stopReason) => appendLog(logPath(nativeId), { type: 'turn', ts: Date.now(), blocks: turn.blocks, stopReason }),
        (err: unknown) => {
          // The error is saved with the turn, so the transcript shows it once `done` reloads it.
          // Also emitting an `error` event would show it a second time as a stream error.
          const error = err instanceof Error ? err.message : String(err);
          appendLog(logPath(nativeId), { type: 'turn', ts: Date.now(), blocks: turn.blocks, error });
        }
      )
      .finally(() => {
        if (entry.running?.runId === runId) entry.running = null;
        emit({ kind: 'done' });
        ctx.triggerRefresh();
      });
    return runId;
  }

  function toSession(nativeId: string, file: string, mtimeMs: number): UnifiedSession | null {
    const log = readLog(file);
    const meta = log[0]?.type === 'meta' ? log[0] : undefined;
    if (!meta) return null;
    const lastUser = [...log].reverse().find((r): r is Extract<LogRecord, { type: 'user' }> => r.type === 'user');
    const running = Boolean(live.get(nativeId)?.running);
    const proj = projectNameFromCwd(meta.cwd);
    return {
      id: `acp:${nativeId}`,
      nativeId,
      harness: 'acp',
      harnessGroup: 'acp',
      title: meta.title,
      preview: cleanTextPreview(lastUser?.text, 140) || meta.agentName,
      lastUserText: cleanTextPreview(lastUser?.text, 140) || undefined,
      cwd: meta.cwd,
      projectName: proj,
      model: meta.agentName,
      nativeSection: meta.agentName,
      nativeSectionOrder: 10,
      status: running ? 'running' : 'idle',
      isLive: live.has(nativeId),
      isRemote: false,
      transcriptPath: file,
      createdAt: meta.createdAt,
      updatedAt: mtimeMs,
      pinned: false,
      folderId: null,
      tags: [meta.agentId],
      hidden: false,
      dispatchMode: 'acp-rpc',
      liveOwner: live.has(nativeId) ? 'super-harness' : undefined,
    };
  }

  return {
    id: 'acp',
    displayName: 'ACP agents',

    async detect(_processes, maxSessions) {
      const configured = agents();
      let files: Array<{ nativeId: string; file: string; mtimeMs: number }> = [];
      try {
        files = fs
          .readdirSync(sessionsDir)
          .filter((f) => f.endsWith('.jsonl'))
          .map((f) => {
            const file = path.join(sessionsDir, f);
            return { nativeId: f.slice(0, -'.jsonl'.length), file, mtimeMs: fs.statSync(file).mtimeMs };
          })
          .sort((a, b) => b.mtimeMs - a.mtimeMs)
          .slice(0, Math.max(1, maxSessions));
      } catch {
        // no ACP sessions yet
      }
      const sessions = files.flatMap((f) => toSession(f.nativeId, f.file, f.mtimeMs) ?? []);
      const detection: HarnessDetection = {
        id: 'acp',
        name: 'ACP agents',
        installed: configured.length > 0,
        binaryPath: null,
        version: null,
        runningProcesses: live.size,
        desktopAppRunning: false,
        daemonRunning: false,
        remoteControlEnabled: false,
        activeSessionCount: sessions.filter((s) => s.isLive).length,
        totalSessionCount: sessions.length,
        capabilities: { canStartNew: configured.length > 0, canResume: true, canTmuxMirror: false, canControlDaemon: false },
        notes: configured.length
          ? configured.map((a) => a.name ?? a.id).join(', ')
          : `Add agents in ${ACP_AGENTS_PATH}`,
      };
      return { detection, sessions };
    },

    async getTranscriptFingerprint(session) {
      return `${computeFileFingerprint(session.transcriptPath)}:${live.get(session.nativeId)?.running ? 'run' : ''}`;
    },

    async loadTranscript(session, limit) {
      const log = readLog(logPath(session.nativeId));
      const messages: UnifiedMessage[] = [];
      log.forEach((rec, i) => {
        if (rec.type === 'user') {
          messages.push({ id: `u${i}`, role: 'user', timestamp: rec.ts, blocks: [{ type: 'text', text: rec.text }] });
        } else if (rec.type === 'turn') {
          messages.push({
            id: `a${i}`,
            role: 'assistant',
            timestamp: rec.ts,
            blocks: rec.blocks,
            error: rec.error,
          });
        }
      });
      const isWorking = Boolean(live.get(session.nativeId)?.running);
      let mtime = 0;
      try {
        mtime = fs.statSync(logPath(session.nativeId)).mtimeMs;
      } catch {
        // deleted
      }
      return {
        sessionId: session.id,
        messages: messages.slice(-limit),
        totalCount: messages.length,
        hasMore: messages.length > limit,
        sourceMtimeMs: mtime,
        liveActivity: { isWorking },
      };
    },

    getGlobalWatchDirs() {
      return [{ dir: sessionsDir, filter: (f) => f.endsWith('.jsonl') }];
    },

    getSessionWatchFiles(session) {
      return [logPath(session.nativeId)];
    },

    async sendMessage(session, prompt, attachments, ctx) {
      const nativeId = nativeIdOf(session.id);
      try {
        const entry = await connect(nativeId);
        if (entry.running) {
          return { ok: false, error: 'The agent is still working on the last message. Wait for it, or stop it first.' };
        }
        const runId = runTurn(nativeId, entry, formatPromptWithImagePaths(prompt, attachments), ctx);
        return { ok: true, dispatchedVia: 'acp', runId };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    async startSession(req: StartSessionRequest, ctx: DispatchContext) {
      const configured = agents();
      const agent = req.agent ? configured.find((a) => a.id === req.agent) : configured.length === 1 ? configured[0] : undefined;
      if (!agent) {
        return {
          ok: false,
          error: configured.length
            ? `Choose an ACP agent: ${configured.map((a) => a.id).join(', ')}.`
            : `No ACP agents configured. Add them to ${ACP_AGENTS_PATH}.`,
        };
      }
      const cwd = fs.existsSync(req.cwd) ? req.cwd : os.homedir();
      const conn = new AcpConnection(agent);
      try {
        await conn.start(cwd);
        const { sessionId: acpSessionId, models } = await conn.newSession(cwd);
        rememberAcpModels(agent, models, modelsFile);
        const model = req.model?.trim() || undefined;
        if (model && model !== models?.current) {
          if (!models?.models.some((m) => m.id === model)) throw new Error(`it has no model "${model}".`);
          await conn.setModel(acpSessionId, models, model);
        }
        const nativeId = crypto.randomUUID();
        const name = agent.name ?? agent.id;
        appendLog(logPath(nativeId), {
          type: 'meta',
          agentId: agent.id,
          agentName: name,
          acpSessionId,
          cwd,
          title: req.title?.trim() || cleanTextPreview(req.prompt, 90) || `New ${name} session`,
          createdAt: Date.now(),
          model,
        });
        const entry = track(nativeId, conn, acpSessionId);
        const text = formatPromptWithImagePaths(req.prompt?.trim() ?? '', req.attachments);
        if (text) runTurn(nativeId, entry, text, ctx);
        else ctx.triggerRefresh();
        return { ok: true, sessionId: `acp:${nativeId}` };
      } catch (err) {
        conn.close();
        return { ok: false, error: `${agent.name ?? agent.id} could not start: ${err instanceof Error ? err.message : String(err)}` };
      }
    },

    abort(sessionId, emitStream) {
      const entry = live.get(nativeIdOf(sessionId));
      if (!entry?.running) return false;
      entry.conn.cancel(entry.acpSessionId);
      emitStream({ sessionId, runId: 'abort', kind: 'done' });
      return true;
    },

    async controlDaemon() {
      return { ok: false, error: 'ACP agents have no daemon; Superharness starts them per session.' };
    },

    async archiveSession(session) {
      const entry = live.get(session.nativeId);
      entry?.conn.close();
      live.delete(session.nativeId);
      return null;
    },

    activeHostTurns() {
      return [...live.values()].filter((e) => e.running).length;
    },

    shutdown() {
      for (const e of live.values()) e.conn.close();
      live.clear();
    },
  };
}
