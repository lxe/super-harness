import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Pi model-call failures, worded for people. Pi records a failed provider call as an
 * assistant message with `stopReason: "error"` and a raw `errorMessage` (often just
 * "Connection error."), so we add which provider/model failed and, for network errors,
 * the host Pi tried to reach (from the provider's `baseUrl` in Pi's models.json).
 */

let hostCache: { mtimeMs: number; hosts: Map<string, string> } | null = null;

function modelsJsonPath(): string {
  const dir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
  return path.join(dir, 'models.json');
}

/** `host:port` of a custom provider's baseUrl, or undefined. Reads only `baseUrl`. */
export function piProviderHost(provider: string | undefined): string | undefined {
  if (!provider) return undefined;
  const file = modelsJsonPath();
  try {
    const st = fs.statSync(file);
    if (!hostCache || hostCache.mtimeMs !== st.mtimeMs) {
      const hosts = new Map<string, string>();
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { providers?: Record<string, { baseUrl?: unknown }> };
      for (const [name, p] of Object.entries(parsed.providers ?? {})) {
        if (typeof p?.baseUrl !== 'string') continue;
        try {
          hosts.set(name, new URL(p.baseUrl).host);
        } catch {
          // not a URL
        }
      }
      hostCache = { mtimeMs: st.mtimeMs, hosts };
    }
    return hostCache.hosts.get(provider);
  } catch {
    return undefined;
  }
}

/** Short, lower-case reason for a raw Pi/provider error message. */
export function summarizePiError(errorMessage: string, host?: string): string {
  const raw = errorMessage.trim();
  const m = raw.match(/\b(ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|EHOSTUNREACH|ENETUNREACH)\b\s*([^\s,)]+)?/);
  const at = (m?.[2] && /[.:]/.test(m[2]) ? m[2] : undefined) ?? host;
  const where = at ? ` at ${at}` : '';
  if (m) {
    switch (m[1]) {
      case 'ECONNREFUSED':
        return `connection refused${where}`;
      case 'ENOTFOUND':
      case 'EAI_AGAIN':
        return `host not found${where}`;
      case 'ETIMEDOUT':
        return `connection timed out${where}`;
      case 'ECONNRESET':
        return `connection reset${where}`;
      default:
        return `host unreachable${where}`;
    }
  }
  const conn = raw.match(/^connection error\.?(?::\s*([\s\S]+))?$/i);
  if (conn) {
    const why = conn[1]?.split('\n')[0].trim().replace(/\.$/, '');
    return `could not connect${at ? ` to ${at}` : ''}${why ? ` (${why})` : ''}`;
  }
  if (/timed? ?out/i.test(raw) && raw.length < 60) return `request timed out${where}`;
  const firstLine = raw.split('\n')[0].replace(/\.$/, '');
  return firstLine.length > 300 ? `${firstLine.slice(0, 300)}…` : firstLine || 'unknown error';
}

export interface PiModelError {
  provider?: string;
  model?: string;
  errorMessage: string;
}

/** "llama102 / qwen3.8-27b: connection refused at 192.168.0.102:8080" */
export function describePiModelError(err: PiModelError): string {
  const who = err.provider && err.model ? `${err.provider} / ${err.model}` : err.provider || err.model || 'Model';
  return `${who}: ${summarizePiError(err.errorMessage, piProviderHost(err.provider))}`;
}

/** Same identity → collapsed into one notice with a count. */
export function piModelErrorKey(err: PiModelError): string {
  return `${err.provider ?? ''}\u0000${err.model ?? ''}\u0000${err.errorMessage.trim()}`;
}

export function piErrorFromMessage(msg: Record<string, unknown>): PiModelError | null {
  if (msg.role !== 'assistant' || msg.stopReason !== 'error') return null;
  return {
    provider: typeof msg.provider === 'string' ? msg.provider : undefined,
    model: typeof msg.model === 'string' ? msg.model : undefined,
    errorMessage: typeof msg.errorMessage === 'string' && msg.errorMessage.trim() ? msg.errorMessage : 'The model call failed.',
  };
}
