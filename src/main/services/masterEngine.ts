import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  HarnessGroup,
  ImageAttachment,
  MasterSegment,
  OrganizeAction,
  SendMessageResult,
  StreamEvent,
  UnifiedBlock,
  UnifiedMessage,
} from '../../shared/types';
import type { HarnessRegistry } from '../adapters/registry';
import { formatPromptWithImagePaths, isImageAttachment } from '../adapters/types';
import type { ConfigStore } from '../store/configStore';
import { resolveCodexBinary, whichBinary } from '../utils/system';
import type { ControlServer } from './controlServer';
import type { HarnessDispatcher } from './dispatcher';
import { ORCHESTRATOR_MEMORY_PATH, readOrchestratorMemory } from './orchestratorMemory';

const ENGINE_NAMES: Partial<Record<HarnessGroup, string>> = {
  claude: 'Claude',
  codex: 'Codex',
  muse: 'Muse',
  antigravity: 'Antigravity',
};

export class MasterEngine {
  private activeChild: ChildProcess | null = null;
  /** Orchestrator turns (and compactions) run one at a time, in order. */
  private turnChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: ConfigStore,
    private readonly registry: HarnessRegistry,
    private readonly dispatcher: HarnessDispatcher,
    private readonly controlServer: ControlServer,
    private readonly emitStream: (ev: StreamEvent) => void,
    private readonly triggerRefresh: () => Promise<void>
  ) {
    setTimeout(() => this.hideLegacyOrchestratorSessions(), 2000).unref?.();
  }

  /**
   * One-time cleanup: before the orchestrator kept one persistent session, every turn ran
   * as a fresh `claude -p` in the orchestrator's cwd and showed up as its own sidebar entry.
   * Those are SDK-launched sessions (entrypoint sdk-cli) that called the super_harness MCP
   * tools; hide them behind the pinned thread.
   */
  private hideLegacyOrchestratorSessions(): void {
    if (this.store.getMasterThread().legacyScanDone) return;
    const found: string[] = [];
    try {
      const cwd = this.store.getState().settings.master.cwd || os.homedir();
      const dir = path.join(os.homedir(), '.claude', 'projects', path.resolve(cwd.replace(/^~/, os.homedir())).replace(/[^a-zA-Z0-9]/g, '-'));
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.jsonl')) continue;
        const full = path.join(dir, f);
        const fd = fs.openSync(full, 'r');
        const head = Buffer.alloc(65536);
        const n = fs.readSync(fd, head, 0, head.length, 0);
        fs.closeSync(fd);
        if (!head.subarray(0, n).toString('utf8').includes('"entrypoint":"sdk-cli"')) continue;
        if (!fs.readFileSync(full, 'utf8').includes('mcp__super_harness__')) continue;
        found.push(f.slice(0, -'.jsonl'.length));
      }
    } catch {
      // no project dir: nothing to hide
    }
    this.store.updateMasterThread((t) => ({
      ...t,
      legacyNativeIds: Array.from(new Set([...(t.legacyNativeIds ?? []), ...found])),
      legacyScanDone: true,
    }));
    if (found.length) void this.triggerRefresh();
  }

  abort(): boolean {
    if (!this.activeChild) return false;
    try {
      this.activeChild.kill('SIGTERM');
    } catch {
      // ignore
    }
    this.activeChild = null;
    this.emitStream({ sessionId: 'master:root', runId: 'abort', kind: 'done' });
    return true;
  }

  async handlePrompt(
    prompt: string,
    attachments?: ImageAttachment[]
  ): Promise<SendMessageResult> {
    const trimmed = prompt.trim();
    if (!trimmed && (!attachments || attachments.length === 0)) {
      return { ok: false, error: 'Empty prompt' };
    }

    const userBlocks: UnifiedBlock[] = [];
    if (attachments && attachments.length > 0) {
      for (const att of attachments.filter(isImageAttachment)) {
        userBlocks.push({
          type: 'image',
          path: att.path,
          name: att.name,
          dataUrl: att.previewDataUrl,
        });
      }
    }
    const fileRefs = (attachments ?? [])
      .filter((a) => !isImageAttachment(a))
      .map((a) => `[Attached file: ${a.path}]`)
      .join('\n');
    const shownText = [fileRefs, trimmed].filter(Boolean).join('\n\n');
    if (shownText) userBlocks.push({ type: 'text', text: shownText });

    const userMsg: UnifiedMessage = {
      id: `m-u-${crypto.randomBytes(4).toString('hex')}`,
      role: 'user',
      timestamp: Date.now(),
      blocks: userBlocks,
    };
    this.store.appendMasterMessage(userMsg);

    const effectivePrompt = formatPromptWithImagePaths(trimmed, attachments);

    // 1. Built-in instant slash commands for zero-latency control
    if (trimmed.startsWith('/')) {
      const handled = await this.tryHandleSlashCommand(trimmed);
      if (handled) {
        return { ok: true, dispatchedVia: 'Master Control Plane (instant)' };
      }
    }

    // 2. Run the turn on the orchestrator's persistent native session (queued behind any
    //    turn or compaction already in flight, so the thread stays one ordered conversation).
    this.turnChain = this.turnChain
      .catch(() => {})
      .then(() => this.runOrchestratorTurn(effectivePrompt, attachments));
    const engine = this.store.getState().settings.master.harness;
    return { ok: true, dispatchedVia: `Master → ${engine} (persistent orchestrator thread)` };
  }

  /** Current segment, starting (and, on a harness switch, compacting into) a new one when needed. */
  private async ensureSegment(engine: HarnessGroup, model: string, cwd: string): Promise<{ seg: MasterSegment; firstTurn: boolean; switchedFrom?: HarnessGroup }> {
    const thread = this.store.getMasterThread();
    const current = thread.segments[thread.segments.length - 1];
    if (current && current.engine === engine) {
      if (model && current.model !== model) {
        this.store.updateMasterThread((t) => ({
          ...t,
          segments: t.segments.map((sg, i) => (i === t.segments.length - 1 ? { ...sg, model } : sg)),
        }));
      }
      return { seg: { ...current, model: model || current.model }, firstTurn: !current.nativeId || !current.turns };
    }
    if (current?.nativeId) {
      await this.compactSegment(current, engine, cwd);
    }
    const seg: MasterSegment = {
      engine,
      model: model || undefined,
      startedAt: Date.now(),
      // Claude and Muse accept an id we choose; Codex/Antigravity report theirs on the first turn.
      nativeId: engine === 'claude' || engine === 'muse' ? crypto.randomUUID() : undefined,
    };
    this.store.updateMasterThread((t) => ({ ...t, segments: [...t.segments, seg] }));
    if (current) {
      this.store.appendMasterMessage({
        id: `m-s-${crypto.randomBytes(4).toString('hex')}`,
        role: 'system',
        timestamp: Date.now(),
        blocks: [
          {
            type: 'notice',
            title: `Orchestrator switched from ${ENGINE_NAMES[current.engine] ?? current.engine} to ${ENGINE_NAMES[engine] ?? engine}`,
            detail: `${ENGINE_NAMES[current.engine] ?? current.engine} compacted this conversation into the orchestrator memory; ${ENGINE_NAMES[engine] ?? engine} continues from it.`,
          },
        ],
      });
    }
    return { seg, firstTurn: true, switchedFrom: current?.engine };
  }

  private async runOrchestratorTurn(effectivePrompt: string, attachments?: ImageAttachment[]): Promise<void> {
    const state = this.store.getState();
    const engine = state.settings.master.harness;
    const model = state.settings.master.model;
    const cwd = fs.existsSync(state.settings.master.cwd) ? state.settings.master.cwd : os.homedir();
    const { seg, firstTurn, switchedFrom } = await this.ensureSegment(engine, model, cwd);

    const memorySeed = firstTurn ? this.buildMemorySeed(switchedFrom) : '';
    const prompt = `${memorySeed}${effectivePrompt}`;
    await this.runSegmentTurn(seg, prompt, firstTurn, cwd, attachments, { label: model || `${engine} (default)` });
  }

  /** Ask the outgoing harness to fold the conversation into MEMORY.md before a switch. */
  private async compactSegment(seg: MasterSegment, nextEngine: HarnessGroup, cwd: string): Promise<void> {
    const prompt = [
      `Superharness is moving this orchestrator conversation from ${ENGINE_NAMES[seg.engine] ?? seg.engine} to ${ENGINE_NAMES[nextEngine] ?? nextEngine}.`,
      'Before the switch: call sh_read_memory, then call sh_write_memory with a compact but complete markdown summary that lets the next orchestrator continue this conversation without losing context:',
      "what's going on, open threads and which sessions own them (with session ids), lxe's decisions and preferences, next steps, and a brief note on the last few exchanges.",
      'Keep the existing headings. Then reply with one line: "Memory compacted for the switch."',
    ].join('\n');
    await this.runSegmentTurn(seg, prompt, false, cwd, undefined, { label: `${ENGINE_NAMES[seg.engine] ?? seg.engine} (compacting)` });
  }

  private buildMemorySeed(switchedFrom?: HarnessGroup): string {
    const memory = readOrchestratorMemory().trim();
    const lead = switchedFrom
      ? `You are continuing the Master Orchestrator conversation after it moved here from ${ENGINE_NAMES[switchedFrom] ?? switchedFrom}. The orchestrator memory below is the hand-off; treat it as what you already know.`
      : 'This is the start of the Master Orchestrator conversation. The orchestrator memory below is what earlier orchestrator conversations recorded.';
    return `${lead}\n\n<orchestrator-memory path="${ORCHESTRATOR_MEMORY_PATH}">\n${memory}\n</orchestrator-memory>\n\nlxe's message:\n`;
  }

  /** Runs one turn on a segment's native session, resuming it after the first turn. */
  private async runSegmentTurn(
    seg: MasterSegment,
    prompt: string,
    firstTurn: boolean,
    cwd: string,
    attachments: ImageAttachment[] | undefined,
    meta: { label: string }
  ): Promise<void> {
    const assistantId = `m-a-${crypto.randomBytes(4).toString('hex')}`;
    const runId = crypto.randomBytes(6).toString('hex');
    this.store.appendMasterMessage({
      id: assistantId,
      role: 'assistant',
      timestamp: Date.now(),
      blocks: [],
      streaming: true,
      harnessMeta: { model: meta.label },
    });

    const mcpServerPath = path.resolve(__dirname, '../../mcp/server.js');
    const systemPreamble = this.buildMasterPreamble();
    const controlUrl = `http://127.0.0.1:${this.controlServer.port}`;
    const httpNote = `Note: If sh_* MCP tools are not directly mounted, you have full live control via HTTP using \`$SUPER_HARNESS_URL\` and \`Authorization: Bearer $SUPER_HARNESS_TOKEN\` (\`GET /api/sessions\`, \`GET /api/transcript?sessionId=...\`, \`POST /api/organize\`, \`POST /api/send\`, \`POST /api/session-config\`, \`GET|POST /api/orchestrator/memory\`).`;
    // Harnesses without a system-prompt flag get the preamble in the first message of a segment.
    const inlinePrompt = firstTurn ? `${systemPreamble}\n\n${httpNote}\n\n${prompt}` : prompt;
    const remember = (nativeId: string) => {
      if (!nativeId || seg.nativeId === nativeId) return;
      seg.nativeId = nativeId;
      this.store.updateMasterThread((t) => ({
        ...t,
        segments: t.segments.map((sg) => (sg.startedAt === seg.startedAt && sg.engine === seg.engine ? { ...sg, nativeId } : sg)),
      }));
    };
    const done = (): void => {
      this.store.updateMasterThread((t) => ({
        ...t,
        segments: t.segments.map((sg) =>
          sg.startedAt === seg.startedAt && sg.engine === seg.engine ? { ...sg, turns: (sg.turns ?? 0) + 1 } : sg
        ),
      }));
    };

    if (seg.engine === 'claude') {
      const bin = await whichBinary('claude');
      if (!bin) return this.failMasterMsg(assistantId, 'claude binary not found. Switch the Master engine in Settings.');
      const mcpConfigPath = path.join(os.tmpdir(), `super-harness-mcp-${process.pid}.json`);
      fs.writeFileSync(
        mcpConfigPath,
        JSON.stringify(
          {
            mcpServers: {
              super_harness: {
                command: process.execPath,
                args: [mcpServerPath],
                env: { ELECTRON_RUN_AS_NODE: '1', SUPER_HARNESS_URL: controlUrl, SUPER_HARNESS_TOKEN: this.controlServer.token },
              },
            },
          },
          null,
          2
        ),
        { mode: 0o600 }
      );
      const args = [
        ...(firstTurn ? ['--session-id', seg.nativeId!] : ['--resume', seg.nativeId!]),
        '-p',
        prompt,
        '--output-format',
        'stream-json',
        '--verbose',
        '--mcp-config',
        mcpConfigPath,
        '--append-system-prompt',
        systemPreamble,
        '--allowedTools',
        'mcp__super_harness__*',
      ];
      if (seg.model) args.push('--model', seg.model);
      await this.runMasterSubprocess(assistantId, runId, bin, args, cwd, 'claude');
      return done();
    }

    if (seg.engine === 'codex') {
      const bin = await resolveCodexBinary();
      if (!bin) return this.failMasterMsg(assistantId, 'codex binary not found. Switch the Master engine in Settings.');
      const mcp = [
        '-c', `mcp_servers.super_harness.command=${JSON.stringify(process.execPath)}`,
        '-c', `mcp_servers.super_harness.args=${JSON.stringify([mcpServerPath])}`,
        '-c', `mcp_servers.super_harness.env.ELECTRON_RUN_AS_NODE="1"`,
        '-c', `mcp_servers.super_harness.env.SUPER_HARNESS_URL=${JSON.stringify(controlUrl)}`,
        '-c', `mcp_servers.super_harness.env.SUPER_HARNESS_TOKEN=${JSON.stringify(this.controlServer.token)}`,
      ];
      const resume = !firstTurn && seg.nativeId;
      const args = resume
        ? ['exec', 'resume', seg.nativeId!, '--skip-git-repo-check', '--json', ...mcp]
        : ['exec', '--skip-git-repo-check', '--json', '-C', cwd, ...mcp];
      for (const att of attachments ?? []) args.push(resume ? '--image' : '-i', att.path);
      if (seg.model) args.push(resume ? '--model' : '-m', seg.model);
      args.push(resume ? prompt : inlinePrompt);
      await this.runMasterSubprocess(assistantId, runId, bin, args, cwd, 'codex', remember);
      return done();
    }

    if (seg.engine === 'muse') {
      const bin = await whichBinary('muse');
      if (!bin) return this.failMasterMsg(assistantId, 'muse binary not found. Switch the Master engine in Settings.');
      const args = ['exec', '--json', '--workspace', cwd, '--yolo', '--session-id', seg.nativeId!];
      if (seg.model) args.push('--model', seg.model);
      for (const att of attachments ?? []) args.push('--image', att.path);
      args.push(inlinePrompt);
      await this.runMasterSubprocess(assistantId, runId, bin, args, cwd, 'muse');
      return done();
    }

    // Antigravity (`agy --print`): resumes the conversation id reported by its first turn.
    const bin = await whichBinary('agy');
    if (!bin) return this.failMasterMsg(assistantId, 'agy binary not found. Switch the Master engine in Settings.');
    const args = ['--output-format', 'stream-json'];
    if (seg.model) args.push('--model', seg.model);
    if (!firstTurn && seg.nativeId) args.push('--conversation', seg.nativeId);
    args.push('--print', firstTurn || !seg.nativeId ? inlinePrompt : prompt);
    await this.runMasterSubprocess(assistantId, runId, bin, args, cwd, 'antigravity', remember);
    return done();
  }

  private buildMasterPreamble(): string {
    const { harnesses, sessions } = this.registry.getCached();
    const state = this.store.getState();
    const liveSummary = sessions
      .filter((s) => s.harness !== 'master' && s.isLive)
      .slice(0, 20)
      .map((s) => `- ${s.id} | ${s.harness} | "${s.title}" | cwd=${s.cwd}${s.folderId ? ` | folderId=${s.folderId}` : ''}${s.tmuxTarget ? ` | tmux=${s.tmuxTarget}` : ''}${s.isRemote ? ' | REMOTE' : ''}${s.summary ? ` | now: ${s.summary}` : ''}`)
      .join('\n');

    return [
      'You are the Master Orchestrator inside Superharness — a unified desktop & mobile multiplexer over Codex, Claude Desktop, Claude tmux/remote-control, Antigravity, and Muse.',
      'You have MCP tools (`sh_list_harnesses`, `sh_list_folders`, `sh_list_sessions`, `sh_read_session`, `sh_send_message`, `sh_start_session`, `sh_organize`, `sh_update_settings`, `sh_control_harness`, `sh_restart_app`) — and equivalent local Control API endpoints at `$SUPER_HARNESS_URL` (Bearer `$SUPER_HARNESS_TOKEN`) — to inspect, organize, configure, and drive Superharness live across both Desktop and Mobile.',
      'Use these tools proactively whenever the user asks to organize sessions into folders, inspect/search sessions, send instructions to another harness, launch new sessions, or update Superharness settings.',
      'This is one continuous conversation with lxe, pinned at the top of Superharness. Your memory lives in ~/.config/super-harness/orchestrator/MEMORY.md: read it with `sh_read_memory` when you need context, and keep it current with `sh_write_memory` (a compact summary, not a log) whenever work starts or finishes, lxe decides something, or a task changes owner.',
      'To change another session\'s model, reasoning effort or permission mode, use `sh_update_session` and report its per-field status honestly (applied / next message / needs restart / unsupported).',
      'When asked to put sessions working on a topic/project into a new or existing folder:',
      '  1. Call `sh_list_folders` and `sh_list_sessions` (without overly narrow filters first if titles may be generic) — and call `sh_read_session` on any ambiguous session to confirm what it is working on.',
      '  2. Call `sh_organize` with `create_folder` (if creating a new folder) and `assign_folder` (`sessionId` + `folderName` or `folderId`) for every matching session in one batch. Changes automatically sync to both Desktop and Mobile.',
      '  3. If `sidebarGroupBy` is not `"folders"` and the user is organizing into folders, switch it via `sh_update_settings({ sidebarGroupBy: "folders" })` (or keep it if they only asked to move native sections).',
      '  4. When referencing sessions in your reply, format them as clickable markdown links `[Session Title](session://<sessionId>)` so clicking them switches directly to that session on Desktop and Mobile.',
      '',
      `Detected harnesses: ${harnesses.map((h) => `${h.name} (installed=${h.installed}, active=${h.activeSessionCount}, total=${h.totalSessionCount}, remote=${h.remoteControlEnabled})`).join('; ')}`,
      `Sidebar grouping: ${state.settings.sidebarGroupBy}`,
      `Existing folders: ${state.folders.map((f) => `${f.name} (${f.id})`).join(', ') || 'none'}`,
      `Live sessions (${sessions.filter((s) => s.harness !== 'master' && s.isLive).length}):`,
      liveSummary || '(none)',
    ].join('\n');
  }

  private runMasterSubprocess(
    assistantId: string,
    runId: string,
    bin: string,
    args: string[],
    cwd: string,
    flavor: HarnessGroup,
    onNativeId?: (nativeId: string) => void
  ): Promise<void> {
    this.abort();
    let resolveDone: () => void = () => {};
    const finished = new Promise<void>((r) => (resolveDone = r));
    const child = spawn(bin, args, {
      cwd,
      env: {
        ...process.env,
        SUPER_HARNESS_URL: `http://127.0.0.1:${this.controlServer.port}`,
        SUPER_HARNESS_TOKEN: this.controlServer.token,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.activeChild = child;
    this.emitStream({ sessionId: 'master:root', runId, kind: 'start' });

    let stdoutBuf = '';
    let stderrBuf = '';
    let textAccum = '';
    const extraBlocks: UnifiedBlock[] = [];

    const flushToStore = (streaming: boolean, error?: string) => {
      const blocks: UnifiedBlock[] = [...extraBlocks];
      if (textAccum.trim()) blocks.push({ type: 'text', text: textAccum });
      this.store.updateMasterMessage(assistantId, (m) => ({
        ...m,
        blocks,
        streaming,
        error,
        timestamp: Date.now(),
      }));
    };

    const parseLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        textAccum += `${trimmed}\n`;
        flushToStore(true);
        return;
      }

      if (flavor === 'claude') {
        if (obj.type === 'assistant') {
          const msg = obj.message as Record<string, unknown> | undefined;
          const content = msg?.content;
          if (Array.isArray(content)) {
            for (const part of content) {
              const p = part as Record<string, unknown>;
              if (p.type === 'text' && typeof p.text === 'string') {
                textAccum = p.text;
              } else if (p.type === 'tool_use') {
                extraBlocks.push({
                  type: 'tool_call',
                  name: String(p.name ?? 'tool'),
                  args: JSON.stringify(p.input ?? {}, null, 2).slice(0, 2000),
                  status: 'completed',
                });
              }
            }
            flushToStore(true);
          }
        } else if (obj.type === 'result' && typeof obj.result === 'string' && !textAccum.trim()) {
          textAccum = obj.result;
          flushToStore(true);
        }
      } else if (flavor === 'codex') {
        if (obj.type === 'thread.started' && typeof obj.thread_id === 'string') onNativeId?.(obj.thread_id);
        const item = obj.item as Record<string, unknown> | undefined;
        if (item?.type === 'agent_message' && typeof item.text === 'string') {
          textAccum = item.text;
          flushToStore(true);
        } else if (item?.type === 'mcp_tool_call') {
          extraBlocks.push({
            type: 'tool_call',
            name: String(item.tool ?? 'mcp'),
            server: typeof item.server === 'string' ? item.server : undefined,
            args: JSON.stringify(item.arguments ?? {}, null, 2).slice(0, 2000),
            status: typeof item.status === 'string' ? item.status : 'completed',
          });
          flushToStore(true);
        } else if (typeof obj.delta === 'string') {
          textAccum += obj.delta;
          flushToStore(true);
        }
      } else if (flavor === 'muse') {
        const payload = (obj.payload ?? {}) as Record<string, unknown>;
        if (obj.payload_type === 'run.output.delta' && typeof payload.text === 'string') {
          textAccum += payload.text;
          flushToStore(true);
        } else if (
          typeof obj.payload_type === 'string' &&
          obj.payload_type.startsWith('run.terminal') &&
          typeof payload.text === 'string' &&
          !textAccum.trim()
        ) {
          textAccum = payload.text;
          flushToStore(true);
        }
      } else {
        // Antigravity (`agy --output-format stream-json`)
        if (obj.event === 'step_update') {
          const su = (obj.step_update ?? {}) as Record<string, unknown>;
          if (typeof su.text_delta === 'string' && su.text_delta) {
            textAccum += su.text_delta;
            flushToStore(true);
          }
        } else if (obj.event === 'result') {
          const res = (obj.result ?? {}) as Record<string, unknown>;
          if (typeof res.conversation_id === 'string' && res.conversation_id) onNativeId?.(res.conversation_id);
          if (!textAccum.trim() && typeof res.response === 'string') {
            textAccum = res.response;
            flushToStore(true);
          }
        }
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8');
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() ?? '';
      for (const l of lines) parseLine(l);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      this.activeChild = null;
      this.failMasterMsg(assistantId, err.message);
      this.emitStream({ sessionId: 'master:root', runId, kind: 'done' });
      resolveDone();
    });

    child.on('close', (code) => {
      if (stdoutBuf.trim()) parseLine(stdoutBuf);
      this.activeChild = null;
      const errMsg =
        code && code !== 0 && !textAccum.trim()
          ? stderrBuf.trim().slice(0, 1000) || `Exited with code ${code}`
          : undefined;
      if (!textAccum.trim() && extraBlocks.length === 0 && !errMsg) {
        textAccum = 'Done.';
      }
      flushToStore(false, errMsg);
      this.emitStream({ sessionId: 'master:root', runId, kind: 'done' });
      void this.triggerRefresh();
      resolveDone();
    });
    return finished;
  }

  private failMasterMsg(assistantId: string, error: string): void {
    this.store.updateMasterMessage(assistantId, (m) => ({
      ...m,
      streaming: false,
      error,
      blocks: m.blocks.length ? m.blocks : [{ type: 'notice', title: 'Error', detail: error }],
    }));
  }

  private async tryHandleSlashCommand(raw: string): Promise<boolean> {
    const [cmd, ...rest] = raw.split(/\s+/);
    const arg = rest.join(' ').trim();

    const reply = (text: string, extraBlocks: UnifiedBlock[] = []) => {
      this.store.appendMasterMessage({
        id: `m-a-${crypto.randomBytes(4).toString('hex')}`,
        role: 'assistant',
        timestamp: Date.now(),
        blocks: [...extraBlocks, { type: 'text', text }],
      });
    };

    if (cmd === '/help') {
      reply(
        [
          '### Master Slash Commands (Instant)',
          '- `/status` — Show all auto-detected harnesses, PIDs, daemons, and session counts',
          '- `/sessions [query]` — List sessions across every harness matching query',
          '- `/folder <name>` — Create a new sidebar folder',
          '- `/auto-organize` — Automatically group live tmux, remote, and project sessions into folders',
          '- `/pin <sessionId>` — Pin a session to the top of the sidebar',
          '- `/send <sessionId> <prompt>` — Send a prompt to any session',
          '- `/engine <claude|codex|antigravity|muse>` — Switch which harness drives this Master Session',
          '- `/group <folders|project|harness|recent>` — Switch sidebar grouping mode',
        ].join('\n')
      );
      return true;
    }

    if (cmd === '/status') {
      const { harnesses, sessions } = await this.registry.discover();
      const lines = harnesses.map(
        (h) =>
          `- **${h.name}**: ${h.installed ? 'Installed' : 'Not found'} | Active: **${h.activeSessionCount}** | Total: ${h.totalSessionCount} | Remote: ${h.remoteControlEnabled ? 'ON' : 'off'} | Procs: ${h.runningProcesses}${h.notes ? `\n  _${h.notes}_` : ''}`
      );
      reply(
        `### Detected Harnesses (${sessions.length - 1} sessions indexed)\n\n${lines.join('\n')}`
      );
      return true;
    }

    if (cmd === '/sessions') {
      const { sessions } = await this.registry.discover();
      const q = arg.toLowerCase();
      const matches = sessions
        .filter((s) => s.harness !== 'master')
        .filter(
          (s) =>
            !q ||
            `${s.title} ${s.projectName} ${s.harness} ${s.cwd} ${s.tmuxTarget || ''}`
              .toLowerCase()
              .includes(q)
        )
        .slice(0, 20);
      if (matches.length === 0) {
        reply(`No sessions matched \`${arg}\`.`);
        return true;
      }
      const lines = matches.map(
        (s) =>
          `- \`${s.id}\` **[${s.harness}]** ${s.isLive ? '🟢 ' : ''}${s.isRemote ? '🌐 ' : ''}**${s.title}** _(${s.projectName})_`
      );
      reply(`### Matching Sessions (${matches.length})\n\n${lines.join('\n')}`);
      return true;
    }

    if (cmd === '/folder') {
      if (!arg) {
        reply('Usage: `/folder <Folder Name>`');
        return true;
      }
      this.store.applyOrganize([{ type: 'create_folder', folderName: arg }]);
      await this.triggerRefresh();
      reply(`Created folder **${arg}** in the sidebar.`);
      return true;
    }

    if (cmd === '/auto-organize') {
      const { sessions } = await this.registry.discover();
      const actions: OrganizeAction[] = [
        { type: 'create_folder', folderName: 'Live tmux & Remote', folderColor: '#a855f7' },
        { type: 'create_folder', folderName: 'Active Codex', folderColor: '#10b981' },
        { type: 'create_folder', folderName: 'Antigravity', folderColor: '#3b82f6' },
      ];
      let assigned = 0;
      for (const s of sessions) {
        if (s.harness === 'master') continue;
        if (s.harness === 'claude-tmux' && s.isLive) {
          actions.push({ type: 'assign_folder', sessionId: s.id, folderName: 'Live tmux & Remote' });
          assigned++;
        } else if (s.harness === 'codex' && s.isLive) {
          actions.push({ type: 'assign_folder', sessionId: s.id, folderName: 'Active Codex' });
          assigned++;
        } else if (s.harness === 'antigravity') {
          actions.push({ type: 'assign_folder', sessionId: s.id, folderName: 'Antigravity' });
          assigned++;
        }
      }
      this.store.applyOrganize(actions);
      this.store.updateSettings({ sidebarGroupBy: 'folders' });
      await this.triggerRefresh();
      reply(
        `Auto-organized **${assigned} sessions** across folders (**Live tmux & Remote**, **Active Codex**, **Antigravity**) and switched sidebar grouping to **Folders**.`
      );
      return true;
    }

    if (cmd === '/pin') {
      if (!arg) {
        reply('Usage: `/pin <sessionId>`');
        return true;
      }
      this.store.applyOrganize([{ type: 'pin', sessionId: arg }]);
      await this.triggerRefresh();
      reply(`Pinned \`${arg}\`.`);
      return true;
    }

    if (cmd === '/engine') {
      if (arg === 'claude' || arg === 'codex' || arg === 'antigravity' || arg === 'muse') {
        const cur = this.store.getState().settings.master;
        this.store.updateSettings({ master: { ...cur, harness: arg } });
        await this.triggerRefresh();
        reply(`Switched Master Orchestrator engine to **${arg}**.`);
      } else {
        reply('Usage: `/engine <claude|codex|antigravity|muse>`');
      }
      return true;
    }

    if (cmd === '/group') {
      if (arg === 'folders' || arg === 'project' || arg === 'harness' || arg === 'recent') {
        this.store.updateSettings({ sidebarGroupBy: arg });
        await this.triggerRefresh();
        reply(`Switched sidebar grouping to **${arg}**.`);
      } else {
        reply('Usage: `/group <folders|project|harness|recent>`');
      }
      return true;
    }

    if (cmd === '/send') {
      const spaceIdx = arg.indexOf(' ');
      if (spaceIdx === -1) {
        reply('Usage: `/send <sessionId> <message>`');
        return true;
      }
      const targetId = arg.slice(0, spaceIdx).trim();
      const message = arg.slice(spaceIdx + 1).trim();
      const res = await this.dispatcher.sendToSession(targetId, message);
      if (res.ok) {
        reply(`Dispatched to \`${targetId}\` via **${res.dispatchedVia}**.`);
      } else {
        reply(`Failed to send to \`${targetId}\`: ${res.error}`);
      }
      return true;
    }

    return false;
  }
}
