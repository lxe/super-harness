import { spawn, type ChildProcess } from 'node:child_process';

/** A session/update notification from an Agent Client Protocol agent (`params.update`). */
export interface AcpUpdate {
  sessionUpdate: string;
  [key: string]: unknown;
}

export interface AcpAgentCommand {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * The models an agent offers for a session. Agents report them in `session/new` (and
 * `session/load`) either as a `configOptions` select with category `model` (current ACP), or as
 * the older `models: { availableModels, currentModelId }` set with `session/set_model`.
 */
export interface AcpModels {
  models: Array<{ id: string; label: string }>;
  current?: string;
  /** The config option ID to set, when the agent uses `configOptions`. */
  configId?: string;
}

export function parseAcpModels(res: Record<string, unknown>): AcpModels | null {
  const opts = Array.isArray(res.configOptions) ? (res.configOptions as Array<Record<string, unknown>>) : [];
  const opt = opts.find((o) => o.category === 'model') ?? opts.find((o) => o.id === 'model');
  if (opt && Array.isArray(opt.options)) {
    const models: AcpModels['models'] = [];
    // Options may be flat or grouped ({ group, name, options: [...] }).
    const walk = (list: unknown[]) => {
      for (const o of list as Array<Record<string, unknown>>) {
        if (Array.isArray(o.options)) walk(o.options);
        else if (typeof o.value === 'string') models.push({ id: o.value, label: typeof o.name === 'string' ? o.name : o.value });
      }
    };
    walk(opt.options);
    if (models.length) {
      return { models, current: typeof opt.currentValue === 'string' ? opt.currentValue : undefined, configId: String(opt.id) };
    }
  }
  const legacy = res.models as { availableModels?: Array<Record<string, unknown>>; currentModelId?: unknown } | undefined;
  if (legacy && Array.isArray(legacy.availableModels) && legacy.availableModels.length) {
    return {
      models: legacy.availableModels
        .filter((m) => typeof m.modelId === 'string')
        .map((m) => ({ id: String(m.modelId), label: typeof m.name === 'string' ? m.name : String(m.modelId) })),
      current: typeof legacy.currentModelId === 'string' ? legacy.currentModelId : undefined,
    };
  }
  return null;
}

type Pending = { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void };

/**
 * One running ACP agent process (https://agentclientprotocol.com): newline-delimited JSON-RPC
 * over its stdin/stdout. Works with any agent that speaks ACP (Gemini CLI, OpenCode, `agy acp`,
 * and the Claude Code / Codex ACP adapters).
 *
 * The client advertises no file-system or terminal capabilities, so the agent uses its own
 * tools. Permission prompts are approved with the first "allow" option, like Superharness's
 * other harness hosts: sessions run unattended.
 */
export class AcpConnection {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buf = '';
  private stderrTail = '';
  private listeners = new Map<string, (u: AcpUpdate) => void>();
  private exitHandlers: Array<(err: Error) => void> = [];
  /** Agent capabilities from `initialize`. */
  canLoadSession = false;
  /** `agentInfo` from `initialize`, when the agent reports it. */
  agentInfo: { name?: string; version?: string } | null = null;

  constructor(private readonly agent: AcpAgentCommand) {}

  get alive(): boolean {
    return Boolean(this.proc && this.proc.exitCode === null && !this.proc.killed);
  }

  async start(cwd: string): Promise<void> {
    const child = spawn(this.agent.command, this.agent.args ?? [], {
      cwd,
      env: { ...process.env, ...this.agent.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = child;
    const spawned = new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      this.buf += chunk.toString('utf8');
      const lines = this.buf.split('\n');
      this.buf = lines.pop() ?? '';
      for (const line of lines) this.handleLine(line);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString('utf8')).slice(-2000);
    });
    child.on('exit', (code, signal) => {
      if (this.proc !== child) return;
      this.proc = null;
      const detail = this.stderrTail.trim();
      const err = new Error(`${this.agent.command} exited (${code ?? signal})${detail ? `: ${detail}` : ''}`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      for (const h of this.exitHandlers) h(err);
    });
    await spawned;
    const init = await this.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    });
    const caps = (init.agentCapabilities ?? {}) as { loadSession?: unknown };
    this.canLoadSession = caps.loadSession === true;
    const info = init.agentInfo as { name?: unknown; version?: unknown } | undefined;
    this.agentInfo = info
      ? { name: typeof info.name === 'string' ? info.name : undefined, version: typeof info.version === 'string' ? info.version : undefined }
      : null;
  }

  onExit(handler: (err: Error) => void): void {
    this.exitHandlers.push(handler);
  }

  async newSession(cwd: string): Promise<{ sessionId: string; models: AcpModels | null }> {
    const res = await this.request('session/new', { cwd, mcpServers: [] });
    const id = typeof res.sessionId === 'string' ? res.sessionId : '';
    if (!id) throw new Error('The agent did not return a session ID.');
    return { sessionId: id, models: parseAcpModels(res) };
  }

  /** Reopens a session after a restart. The agent replays its history, which callers ignore. */
  async loadSession(sessionId: string, cwd: string): Promise<AcpModels | null> {
    const res = await this.request('session/load', { sessionId, cwd, mcpServers: [] });
    return parseAcpModels(res ?? {});
  }

  /** Switches the session's model the way the agent reported its models. */
  async setModel(sessionId: string, models: AcpModels, modelId: string): Promise<void> {
    if (models.configId) {
      await this.request('session/set_config_option', { sessionId, configId: models.configId, value: modelId });
    } else {
      await this.request('session/set_model', { sessionId, modelId });
    }
  }

  /** Sends one prompt turn; `onUpdate` sees the streamed updates until it ends. */
  async prompt(sessionId: string, text: string, onUpdate: (u: AcpUpdate) => void): Promise<string> {
    this.listeners.set(sessionId, onUpdate);
    try {
      const res = await this.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
      return typeof res.stopReason === 'string' ? res.stopReason : 'end_turn';
    } finally {
      this.listeners.delete(sessionId);
    }
  }

  cancel(sessionId: string): void {
    this.send({ method: 'session/cancel', params: { sessionId } });
  }

  close(): void {
    const p = this.proc;
    this.proc = null;
    p?.kill('SIGTERM');
  }

  private send(msg: Record<string, unknown>): void {
    if (!this.proc?.stdin?.writable) throw new Error(`${this.agent.command} is not running.`);
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
  }

  private request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      try {
        this.send({ id, method, params });
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private handleLine(line: string): void {
    let msg: { id?: unknown; method?: unknown; params?: Record<string, unknown>; result?: unknown; error?: { message?: unknown } };
    try {
      msg = JSON.parse(line.trim());
    } catch {
      return; // agents may log non-JSON lines
    }
    if (typeof msg.id === 'number' && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(String(msg.error.message ?? JSON.stringify(msg.error))));
      else p.resolve((msg.result ?? {}) as Record<string, unknown>);
      return;
    }
    const params = msg.params ?? {};
    if (msg.method === 'session/update') {
      const update = params.update as AcpUpdate | undefined;
      const listener = this.listeners.get(String(params.sessionId ?? ''));
      if (update && listener) listener(update);
      return;
    }
    if (msg.id === undefined) return;
    if (msg.method === 'session/request_permission') {
      const options = Array.isArray(params.options) ? (params.options as Array<{ optionId?: string; kind?: string }>) : [];
      const allow = options.find((o) => String(o.kind ?? '').startsWith('allow')) ?? options[0];
      this.send({
        id: msg.id,
        result: allow?.optionId ? { outcome: { outcome: 'selected', optionId: allow.optionId } } : { outcome: { outcome: 'cancelled' } },
      });
      return;
    }
    // We advertised no fs/terminal capabilities, so anything else is unsupported.
    this.send({ id: msg.id, error: { code: -32601, message: `Method not supported: ${String(msg.method)}` } });
  }
}
