import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  HarnessGroup,
  ImageAttachment,
  OrganizeAction,
  SendMessageResult,
  StreamEvent,
  UnifiedBlock,
  UnifiedMessage,
} from '../../shared/types';
import type { HarnessRegistry } from '../adapters/registry';
import type { ConfigStore } from '../store/configStore';
import { resolveCodexBinary, whichBinary } from '../utils/system';
import type { ControlServer } from './controlServer';
import type { HarnessDispatcher } from './dispatcher';

export class MasterEngine {
  private activeChild: ChildProcess | null = null;

  constructor(
    private readonly store: ConfigStore,
    private readonly registry: HarnessRegistry,
    private readonly dispatcher: HarnessDispatcher,
    private readonly controlServer: ControlServer,
    private readonly emitStream: (ev: StreamEvent) => void,
    private readonly triggerRefresh: () => Promise<void>
  ) {}

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
      for (const att of attachments) {
        userBlocks.push({
          type: 'image',
          path: att.path,
          name: att.name,
          dataUrl: att.previewDataUrl,
        });
      }
    }
    if (trimmed) userBlocks.push({ type: 'text', text: trimmed });

    const userMsg: UnifiedMessage = {
      id: `m-u-${crypto.randomBytes(4).toString('hex')}`,
      role: 'user',
      timestamp: Date.now(),
      blocks: userBlocks,
    };
    this.store.appendMasterMessage(userMsg);

    const effectivePrompt =
      attachments && attachments.length > 0
        ? `${attachments.map((a) => `[Attached image: ${a.path}]`).join('\n')}\n\n${trimmed || 'Inspect the attached image(s).'}`
        : trimmed;

    // 1. Built-in instant slash commands for zero-latency control
    if (trimmed.startsWith('/')) {
      const handled = await this.tryHandleSlashCommand(trimmed);
      if (handled) {
        return { ok: true, dispatchedVia: 'Master Control Plane (instant)' };
      }
    }

    // 2. Delegate to the configured Master harness (Claude, Codex, or Antigravity)
    //    with the live `super-harness-mcp` server wired in!
    const state = this.store.getState();
    const engine = state.settings.master.harness;
    const model = state.settings.master.model;
    const cwd = fs.existsSync(state.settings.master.cwd)
      ? state.settings.master.cwd
      : os.homedir();

    const assistantId = `m-a-${crypto.randomBytes(4).toString('hex')}`;
    const runId = crypto.randomBytes(6).toString('hex');
    const assistantMsg: UnifiedMessage = {
      id: assistantId,
      role: 'assistant',
      timestamp: Date.now(),
      blocks: [],
      streaming: true,
      harnessMeta: { model: model || `${engine} (default)` },
    };
    this.store.appendMasterMessage(assistantMsg);

    const mcpServerPath = path.resolve(__dirname, '../../mcp/server.js');
    const systemPreamble = this.buildMasterPreamble();

    if (engine === 'claude') {
      const bin = await whichBinary('claude');
      if (!bin) {
        this.failMasterMsg(assistantId, 'claude binary not found. Switch Master engine in Settings.');
        return { ok: false, error: 'claude binary not found' };
      }

      // Write ephemeral MCP config pointing to our live Control HTTP Server
      const mcpConfigPath = path.join(os.tmpdir(), `super-harness-mcp-${process.pid}.json`);
      const mcpConfig = {
        mcpServers: {
          super_harness: {
            command: process.execPath,
            args: [mcpServerPath],
            env: {
              ELECTRON_RUN_AS_NODE: '1',
              SUPER_HARNESS_URL: `http://127.0.0.1:${this.controlServer.port}`,
              SUPER_HARNESS_TOKEN: this.controlServer.token,
            },
          },
        },
      };
      fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2), { mode: 0o600 });

      const args = [
        '-p',
        effectivePrompt,
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
      if (model) args.push('--model', model);

      this.runMasterSubprocess(assistantId, runId, bin, args, cwd, 'claude');
      return { ok: true, runId, dispatchedVia: `Master → Claude + super-harness-mcp` };
    }

    if (engine === 'codex') {
      const bin = await resolveCodexBinary();
      if (!bin) {
        this.failMasterMsg(assistantId, 'codex binary not found. Switch Master engine in Settings.');
        return { ok: false, error: 'codex binary not found' };
      }

      const fullPrompt = `${systemPreamble}\n\nUser request:\n${trimmed || 'Inspect the attached image(s).'}`;
      const args = [
        'exec',
        '--skip-git-repo-check',
        '--ephemeral',
        '--json',
        '-C',
        cwd,
        '-c',
        `mcp_servers.super_harness.command=${JSON.stringify(process.execPath)}`,
        '-c',
        `mcp_servers.super_harness.args=${JSON.stringify([mcpServerPath])}`,
        '-c',
        `mcp_servers.super_harness.env.ELECTRON_RUN_AS_NODE="1"`,
        '-c',
        `mcp_servers.super_harness.env.SUPER_HARNESS_URL=${JSON.stringify(`http://127.0.0.1:${this.controlServer.port}`)}`,
        '-c',
        `mcp_servers.super_harness.env.SUPER_HARNESS_TOKEN=${JSON.stringify(this.controlServer.token)}`,
      ];
      if (attachments && attachments.length > 0) {
        for (const att of attachments) {
          args.push('-i', att.path);
        }
      }
      if (model) args.push('-m', model);
      args.push(fullPrompt);

      this.runMasterSubprocess(assistantId, runId, bin, args, cwd, 'codex');
      return { ok: true, runId, dispatchedVia: `Master → Codex + super-harness-mcp` };
    }

    if (engine === 'muse') {
      const bin = await whichBinary('muse');
      if (!bin) {
        this.failMasterMsg(assistantId, 'muse binary not found. Switch Master engine in Settings.');
        return { ok: false, error: 'muse binary not found' };
      }
      const fullPrompt = `${systemPreamble}\n\nNote: If sh_* MCP tools are not directly mounted, you have full live control via HTTP using \`$SUPER_HARNESS_URL\` and \`Authorization: Bearer $SUPER_HARNESS_TOKEN\` (\`GET /api/sessions\`, \`GET /api/folders\`, \`GET /api/transcript?sessionId=...\`, \`POST /api/organize\`, \`POST /api/settings\`, \`POST /api/send\`). Use curl/python/node as needed to carry out folder organization or session actions.\n\nUser request:\n${effectivePrompt}`;
      const args = ['exec', '--json', '--workspace', cwd, '--yolo'];
      if (model) args.push('--model', model);
      if (attachments && attachments.length > 0) {
        for (const att of attachments) args.push('--image', att.path);
      }
      args.push(fullPrompt);
      this.runMasterSubprocess(assistantId, runId, bin, args, cwd, 'muse');
      return { ok: true, runId, dispatchedVia: 'Master → Muse + Control API' };
    }

    // Antigravity engine
    const bin = await whichBinary('agy');
    if (!bin) {
      this.failMasterMsg(assistantId, 'agy binary not found. Switch Master engine in Settings.');
      return { ok: false, error: 'agy binary not found' };
    }
    const fullPrompt = `${systemPreamble}\n\nNote: If sh_* MCP tools are not directly mounted, you have full live control via HTTP using \`$SUPER_HARNESS_URL\` and \`Authorization: Bearer $SUPER_HARNESS_TOKEN\` (\`GET /api/sessions\`, \`GET /api/folders\`, \`GET /api/transcript?sessionId=...\`, \`POST /api/organize\`, \`POST /api/settings\`, \`POST /api/send\`).\n\nUser request:\n${effectivePrompt}`;
    const args = ['--output-format', 'stream-json'];
    if (model) args.push('--model', model);
    args.push('--print', fullPrompt);

    this.runMasterSubprocess(assistantId, runId, bin, args, cwd, 'antigravity');
    return { ok: true, runId, dispatchedVia: `Master → Antigravity + Control API` };
  }

  private buildMasterPreamble(): string {
    const { harnesses, sessions } = this.registry.getCached();
    const state = this.store.getState();
    const liveSummary = sessions
      .filter((s) => s.harness !== 'master' && s.isLive)
      .slice(0, 20)
      .map((s) => `- ${s.id} | ${s.harness} | "${s.title}" | cwd=${s.cwd}${s.folderId ? ` | folderId=${s.folderId}` : ''}${s.tmuxTarget ? ` | tmux=${s.tmuxTarget}` : ''}${s.isRemote ? ' | REMOTE' : ''}`)
      .join('\n');

    return [
      'You are the Master Orchestrator inside Super Harness — a unified desktop & mobile multiplexer over Codex, Claude Desktop, Claude tmux/remote-control, Antigravity, and Muse.',
      'You have MCP tools (`sh_list_harnesses`, `sh_list_folders`, `sh_list_sessions`, `sh_read_session`, `sh_send_message`, `sh_start_session`, `sh_organize`, `sh_update_settings`, `sh_control_harness`, `sh_restart_app`) — and equivalent local Control API endpoints at `$SUPER_HARNESS_URL` (Bearer `$SUPER_HARNESS_TOKEN`) — to inspect, organize, configure, and drive Super Harness live across both Desktop and Mobile.',
      'Use these tools proactively whenever the user asks to organize sessions into folders, inspect/search sessions, send instructions to another harness, launch new sessions, or update Super Harness settings.',
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
    flavor: HarnessGroup
  ): void {
    this.abort();
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
    });
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
