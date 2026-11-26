/**
 * Standalone zero-dependency MCP stdio server (`super-harness-mcp`).
 * Spawned by Claude CLI (`--mcp-config`), Codex CLI (`-c mcp_servers...`), or
 * Antigravity CLI when running the Super Harness Master Session.
 *
 * Bridges MCP `tools/list` and `tools/call` to the Electron main process
 * loopback Control HTTP API (`SUPER_HARNESS_URL` + `SUPER_HARNESS_TOKEN`).
 */

import readline from 'node:readline';

const BASE_URL = process.env.SUPER_HARNESS_URL || '';
const TOKEN = process.env.SUPER_HARNESS_TOKEN || '';

const TOOLS = [
  {
    name: 'sh_list_harnesses',
    description:
      'List all detected local AI coding harnesses (Codex, Claude Desktop/tmux, Antigravity, Muse), their running process counts, daemon status, and remote-control state.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'sh_list_sessions',
    description:
      'List and search sessions across all harnesses (Codex, Claude tmux, Claude Desktop, Claude CLI, Antigravity, Muse).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional text filter across title, project, cwd, tags' },
        harness: {
          type: 'string',
          description: 'Optional harness filter: codex, claude, claude-tmux, claude-desktop, antigravity, muse',
        },
        liveOnly: { type: 'boolean', description: 'Only return currently live/running sessions' },
      },
    },
  },
  {
    name: 'sh_read_session',
    description: 'Read recent coalesced messages from any session by its Super Harness ID.',
    inputSchema: {
      type: 'object',
      required: ['sessionId'],
      properties: {
        sessionId: { type: 'string', description: 'Session ID such as codex:<uuid> or claude-tmux:<uuid>' },
        limit: { type: 'number', description: 'Max recent messages to return (default 15)' },
      },
    },
  },
  {
    name: 'sh_send_message',
    description:
      'Send a message/prompt directly to an existing session (via tmux send-keys for live tmux sessions, or CLI resume for Codex/Claude/Antigravity).',
    inputSchema: {
      type: 'object',
      required: ['sessionId', 'message'],
      properties: {
        sessionId: { type: 'string' },
        message: { type: 'string' },
      },
    },
  },
  {
    name: 'sh_start_session',
    description:
      'Launch a brand-new session on a chosen harness (e.g., claude-tmux with remote-control, codex, claude-cli, antigravity, or muse).',
    inputSchema: {
      type: 'object',
      required: ['harness', 'cwd'],
      properties: {
        harness: { type: 'string', enum: ['codex', 'claude-tmux', 'claude-cli', 'antigravity', 'muse'] },
        cwd: { type: 'string' },
        title: { type: 'string' },
        prompt: { type: 'string' },
        remoteControl: { type: 'boolean' },
      },
    },
  },
  {
    name: 'sh_organize',
    description:
      'Organize the Super Harness sidebar: create/rename/delete folders, assign sessions to folders, pin/unpin, rename, tag, or hide sessions.',
    inputSchema: {
      type: 'object',
      required: ['actions'],
      properties: {
        actions: {
          type: 'array',
          items: {
            type: 'object',
            required: ['type'],
            properties: {
              type: {
                type: 'string',
                enum: [
                  'create_folder',
                  'delete_folder',
                  'rename_folder',
                  'assign_folder',
                  'pin',
                  'unpin',
                  'pin_top',
                  'unpin_top',
                  'rename_session',
                  'tag_session',
                  'hide_session',
                  'unhide_session',
                ],
              },
              folderId: { type: 'string' },
              folderName: { type: 'string' },
              folderColor: { type: 'string' },
              sessionId: { type: 'string' },
              title: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
  },
  {
    name: 'sh_update_settings',
    description:
      'Update Super Harness settings such as sidebarGroupBy (folders|project|harness|recent), pollIntervalMs, maxSessionsPerHarness, showArchived, or enabledHarnesses.',
    inputSchema: {
      type: 'object',
      properties: {
        sidebarGroupBy: { type: 'string', enum: ['folders', 'project', 'harness', 'recent'] },
        pollIntervalMs: { type: 'number' },
        maxSessionsPerHarness: { type: 'number' },
        showArchived: { type: 'boolean' },
        showHidden: { type: 'boolean' },
      },
    },
  },
  {
    name: 'sh_control_harness',
    description: 'Start or stop a harness remote-control background daemon.',
    inputSchema: {
      type: 'object',
      required: ['harness', 'action'],
      properties: {
        harness: { type: 'string', enum: ['codex', 'claude', 'antigravity', 'muse'] },
        action: { type: 'string', enum: ['start_remote', 'stop_remote'] },
      },
    },
  },
  {
    name: 'sh_restart_app',
    description:
      'Safely restart Super Harness via a detached watchdog (optionally running npm run build first) so the app comes back cleanly without dying mid-shutdown.',
    inputSchema: {
      type: 'object',
      properties: {
        build: {
          type: 'boolean',
          description: 'If true, rebuild main and renderer before restarting.',
        },
      },
    },
  },
];

async function apiRequest(method: string, pathAndQuery: string, body?: unknown): Promise<unknown> {
  if (!BASE_URL || !TOKEN) {
    throw new Error('SUPER_HARNESS_URL / SUPER_HARNESS_TOKEN not configured');
  }
  const res = await fetch(`${BASE_URL}${pathAndQuery}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { status: res.status, text };
  }
}

async function executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'sh_list_harnesses':
      return apiRequest('GET', '/api/harnesses');
    case 'sh_list_sessions': {
      const qs = new URLSearchParams();
      if (args.query) qs.set('q', String(args.query));
      if (args.harness) qs.set('harness', String(args.harness));
      if (args.liveOnly) qs.set('live', 'true');
      return apiRequest('GET', `/api/sessions?${qs.toString()}`);
    }
    case 'sh_read_session': {
      const qs = new URLSearchParams();
      qs.set('sessionId', String(args.sessionId || ''));
      qs.set('limit', String(args.limit || 15));
      return apiRequest('GET', `/api/transcript?${qs.toString()}`);
    }
    case 'sh_send_message':
      return apiRequest('POST', '/api/send', args);
    case 'sh_start_session':
      return apiRequest('POST', '/api/start', args);
    case 'sh_organize':
      return apiRequest('POST', '/api/organize', args);
    case 'sh_update_settings':
      return apiRequest('POST', '/api/settings', args);
    case 'sh_control_harness':
      return apiRequest('POST', '/api/control-harness', args);
    case 'sh_restart_app':
      return apiRequest('POST', '/api/restart', args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function sendResponse(id: unknown, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function sendError(id: unknown, code: number, message: string): void {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`
  );
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req: { id?: unknown; method?: string; params?: Record<string, unknown> };
  try {
    req = JSON.parse(trimmed);
  } catch {
    return;
  }

  const { id, method, params } = req;
  if (!method) return;

  // Notifications have no id
  if (method === 'notifications/initialized' || id === undefined) return;

  try {
    if (method === 'initialize') {
      sendResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'super-harness-mcp', version: '0.1.0' },
      });
      return;
    }

    if (method === 'tools/list') {
      sendResponse(id, { tools: TOOLS });
      return;
    }

    if (method === 'tools/call') {
      const toolName = String(params?.name || '');
      const toolArgs = (params?.arguments ?? {}) as Record<string, unknown>;
      const data = await executeTool(toolName, toolArgs);
      sendResponse(id, {
        content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
      });
      return;
    }

    sendError(id, -32601, `Method not found: ${method}`);
  } catch (err) {
    sendError(id, -32000, err instanceof Error ? err.message : String(err));
  }
});
