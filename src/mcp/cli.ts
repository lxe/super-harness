#!/usr/bin/env node
/**
 * `superharness` command line: talk to the running desktop app from any terminal, script,
 * or harness on this machine, over the same loopback Control API the Master Session uses.
 */

import { CONTROL_ENDPOINT_FILE, resolveControlEndpoint } from './controlEndpoint';

const USAGE = `Usage: superharness <command> [options]

  sessions [query] [--harness <h>] [--live]   List sessions across every harness
  read <sessionId> [--limit <n>]              Print a session's recent messages
  send <sessionId> [message...] [--queue]     Send a message (reads stdin when no message)
  start <harness> [prompt...] [--cwd <dir>] [--title <t>] [--model <id>]
                                              Start a session (codex, claude-tmux, claude-cli,
                                              antigravity, muse or pi)
  api <METHOD> <path> [json]                  Call any Control API route directly

Add --json to any command for the raw response.`;

interface Parsed {
  positional: string[];
  flags: Record<string, string | true>;
}

function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  const valued = new Set(['harness', 'limit', 'cwd', 'title', 'model']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const name = arg.slice(2);
      if (valued.has(name) && i + 1 < argv.length) flags[name] = argv[++i];
      else flags[name] = true;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

async function api(method: string, pathAndQuery: string, body?: unknown): Promise<unknown> {
  const endpoint = resolveControlEndpoint();
  if (!endpoint) {
    throw new Error(`Superharness is not running (no ${CONTROL_ENDPOINT_FILE}).`);
  }
  let res: Response;
  try {
    res = await fetch(`${endpoint.url}${pathAndQuery}`, {
      method,
      headers: { Authorization: `Bearer ${endpoint.token}`, 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(`Superharness is not reachable at ${endpoint.url}. Is the app running?`);
  }
  const text = await res.text();
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    // Plain-text response.
  }
  if (!res.ok) {
    const msg = typeof data === 'object' && data && 'error' in data ? String((data as { error: unknown }).error) : text;
    throw new Error(`${method} ${pathAndQuery} failed (${res.status}): ${msg}`);
  }
  return data;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

interface SessionRow {
  id: string;
  harness: string;
  status?: string;
  title?: string;
  projectName?: string;
}

interface MessageRow {
  role: string;
  error?: string;
  blocks?: Array<{ type: string; text?: string; name?: string; command?: string }>;
}

function blockText(block: NonNullable<MessageRow['blocks']>[number]): string {
  if (block.type === 'text' && block.text) return block.text.trim();
  if (block.command) return `$ ${block.command}`;
  if (block.name) return `[${block.type}: ${block.name}]`;
  return '';
}

/** Fails when the API reports `ok: false` (it answers 200 for refused sends). */
function ensureOk(result: unknown): void {
  if (result && typeof result === 'object' && (result as { ok?: unknown }).ok === false) {
    const err = (result as { error?: unknown }).error;
    throw new Error(typeof err === 'string' && err ? err : 'Superharness refused the request.');
  }
}

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, ...rest] = positional;
  const json = flags.json === true;
  const print = (value: unknown, human: () => string) => {
    process.stdout.write(`${json ? JSON.stringify(value, null, 2) : human()}\n`);
  };

  switch (command) {
    case 'sessions': {
      const qs = new URLSearchParams();
      if (rest.length) qs.set('q', rest.join(' '));
      if (typeof flags.harness === 'string') qs.set('harness', flags.harness);
      if (flags.live) qs.set('live', 'true');
      const data = (await api('GET', `/api/sessions?${qs}`)) as { sessions: SessionRow[] };
      print(data, () =>
        data.sessions
          .map((s) => [s.id, s.harness, s.status ?? '', s.projectName ?? '', s.title ?? ''].join('\t'))
          .join('\n')
      );
      return;
    }
    case 'read': {
      const [sessionId] = rest;
      if (!sessionId) throw new Error('read needs a session ID (see `superharness sessions`).');
      const qs = new URLSearchParams({ sessionId, limit: String(flags.limit ?? 15) });
      const data = (await api('GET', `/api/transcript?${qs}`)) as { messages?: MessageRow[] };
      print(data, () =>
        (data.messages ?? [])
          .map((m) => {
            const lines = (m.blocks ?? []).map(blockText).filter(Boolean);
            if (m.error) lines.push(`[error: ${m.error}]`);
            const body = lines.join('\n');
            return `## ${m.role}\n${body}`;
          })
          .join('\n\n')
      );
      return;
    }
    case 'send': {
      const [sessionId, ...words] = rest;
      if (!sessionId) throw new Error('send needs a session ID (see `superharness sessions`).');
      const message = words.length ? words.join(' ') : (await readStdin()).trim();
      if (!message) throw new Error('send needs a message, as arguments or on stdin.');
      const result = await api('POST', '/api/send', {
        sessionId,
        message,
        mode: flags.queue ? 'queue' : 'steer',
      });
      ensureOk(result);
      print(result, () => (flags.queue ? 'Queued.' : 'Sent.'));
      return;
    }
    case 'start': {
      const [harness, ...words] = rest;
      if (!harness) throw new Error('start needs a harness, e.g. `superharness start codex "fix the build"`.');
      const result = (await api('POST', '/api/start', {
        harness,
        cwd: typeof flags.cwd === 'string' ? flags.cwd : process.cwd(),
        title: typeof flags.title === 'string' ? flags.title : undefined,
        model: typeof flags.model === 'string' ? flags.model : undefined,
        prompt: words.length ? words.join(' ') : undefined,
      })) as { sessionId?: string };
      ensureOk(result);
      print(result, () => result.sessionId ?? 'Started.');
      return;
    }
    case 'api': {
      const [method, route, rawBody] = rest;
      if (!method || !route) throw new Error('api needs a method and a path, e.g. `superharness api GET /api/usage`.');
      const result = await api(method.toUpperCase(), route, rawBody ? JSON.parse(rawBody) : undefined);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    default:
      process.stdout.write(`${USAGE}\n`);
      if (command && command !== 'help' && !flags.help) process.exitCode = 2;
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`superharness: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
