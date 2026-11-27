import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DictationResult, DictationSettings, DictationStatus } from '../../shared/types';

/**
 * One dictation server per desktop (settings.dictation). Both the phone route
 * (/api/dictate) and the desktop composer (IPC) transcribe through `transcribeAudio`.
 */

export const DEFAULT_DICTATION_SHORTCUT = 'Ctrl+Shift+Space';

export function normalizeDictationBaseUrl(raw: string | undefined): string {
  let url = (raw ?? '').trim().replace(/\/+$/, '');
  // Accept a pasted endpoint URL as well as the server root.
  url = url.replace(/\/v1\/audio\/transcriptions$/, '').replace(/\/v1$/, '');
  return url;
}

export function isDictationConfigured(cfg: DictationSettings | undefined): cfg is DictationSettings {
  return Boolean(cfg && normalizeDictationBaseUrl(cfg.baseUrl));
}

/**
 * Reads `[server] url` and `token` from ~/.config/yapyap/config.toml, which is where the host
 * found its dictation server before settings.dictation existed. Used once to prefill settings.
 */
export function readYapYapConfig(home = os.homedir()): { baseUrl: string; apiKey: string } | null {
  try {
    const cfgPath = path.join(home, '.config', 'yapyap', 'config.toml');
    if (!fs.existsSync(cfgPath)) return null;
    const raw = fs.readFileSync(cfgPath, 'utf8');
    let inServer = false;
    let url = '';
    let token = '';
    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      if (line.startsWith('[')) {
        inServer = line === '[server]';
        continue;
      }
      if (!inServer) continue;
      const urlMatch = line.match(/^url\s*=\s*["']([^"']+)["']/);
      if (urlMatch) url = urlMatch[1].replace(/\/+$/, '');
      const tokMatch = line.match(/^token\s*=\s*["']([^"']+)["']/);
      if (tokMatch) token = tokMatch[1];
    }
    if (!url) return null;
    return { baseUrl: url, apiKey: token };
  } catch {
    return null;
  }
}

function authHeaders(cfg: DictationSettings): Record<string, string> {
  const key = cfg.apiKey?.trim();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

function describeFetchError(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'AbortError') return 'Timed out reaching the dictation server';
    const cause = (err as { cause?: { code?: string; errors?: Array<{ code?: string }> } }).cause;
    const code = cause?.code || cause?.errors?.find((e) => e?.code)?.code;
    if (code) return `Can't reach the dictation server (${code})`;
    if (err.message === 'fetch failed') return "Can't reach the dictation server";
    return err.message;
  }
  return String(err);
}

/**
 * Health check: GET /v1/models with the API key (this also proves the key works); servers without
 * a models endpoint fall back to GET /health.
 */
export async function checkDictationServer(
  cfg: DictationSettings | undefined,
  timeoutMs = 4000
): Promise<DictationStatus> {
  if (!isDictationConfigured(cfg)) return { ok: true, configured: false, healthy: false };
  const base = normalizeDictationBaseUrl(cfg.baseUrl);
  try {
    const res = await fetchWithTimeout(`${base}/v1/models`, { headers: authHeaders(cfg) }, timeoutMs);
    if (res.ok) {
      const body = (await res.json().catch(() => ({}))) as { data?: Array<{ id?: unknown }> };
      const first = Array.isArray(body.data) ? body.data.find((m) => typeof m?.id === 'string') : undefined;
      return {
        ok: true,
        configured: true,
        healthy: true,
        model: cfg.model?.trim() || (first?.id as string | undefined),
      };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: true, configured: true, healthy: false, error: `API key rejected (HTTP ${res.status})` };
    }
    const health = await fetchWithTimeout(`${base}/health`, { headers: authHeaders(cfg) }, timeoutMs);
    if (health.ok) {
      const info = (await health.json().catch(() => ({}))) as Record<string, unknown>;
      return {
        ok: true,
        configured: true,
        healthy: true,
        model: cfg.model?.trim() || (typeof info.model === 'string' ? info.model : undefined),
      };
    }
    return { ok: true, configured: true, healthy: false, error: `Server answered HTTP ${res.status}` };
  } catch (err) {
    return { ok: true, configured: true, healthy: false, error: describeFetchError(err) };
  }
}

const AUDIO_EXT_BY_TYPE: Array<[RegExp, string]> = [
  [/m4a|mp4|aac/, 'm4a'],
  [/ogg|opus/, 'ogg'],
  [/webm/, 'webm'],
  [/mpeg|mp3/, 'mp3'],
  [/wav|wave/, 'wav'],
];

export function audioExtensionFor(contentType: string): string {
  const ct = contentType.split(';')[0].trim().toLowerCase();
  for (const [re, ext] of AUDIO_EXT_BY_TYPE) if (re.test(ct)) return ext;
  return 'wav';
}

export class DictationError extends Error {
  constructor(
    message: string,
    readonly statusCode: number
  ) {
    super(message);
  }
}

/** Sends one recording to {baseUrl}/v1/audio/transcriptions and returns the text. */
export async function transcribeAudio(
  cfg: DictationSettings | undefined,
  audio: Buffer,
  contentType: string,
  opts: { language?: string; prompt?: string } = {}
): Promise<DictationResult & { ok: true; text: string; timing: { upstreamMs: number } }> {
  if (!isDictationConfigured(cfg)) {
    throw new DictationError('Dictation is not set up. Add a server in Superharness Settings → Dictation.', 503);
  }
  if (audio.length === 0) throw new DictationError('Empty audio payload', 400);
  const base = normalizeDictationBaseUrl(cfg.baseUrl);
  const mime = (contentType || 'audio/wav').split(';')[0].trim() || 'audio/wav';
  const ext = audioExtensionFor(mime);

  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: mime }), `dictation.${ext}`);
  const model = cfg.model?.trim();
  if (model) form.append('model', model);
  const language = opts.language?.trim() || cfg.language?.trim();
  if (language) form.append('language', language);
  if (opts.prompt) form.append('prompt', opts.prompt);
  form.append('response_format', 'json');

  const t0 = Date.now();
  let res: Response;
  try {
    res = await fetchWithTimeout(
      `${base}/v1/audio/transcriptions`,
      { method: 'POST', headers: authHeaders(cfg), body: form },
      120_000
    );
  } catch (err) {
    throw new DictationError(describeFetchError(err), 502);
  }
  const rawText = await res.text();
  const upstreamMs = Date.now() - t0;
  if (!res.ok) {
    throw new DictationError(`Dictation server HTTP ${res.status}: ${rawText.slice(0, 240)}`, 502);
  }
  let text = rawText.trim();
  try {
    const parsed = JSON.parse(rawText) as { text?: unknown };
    if (typeof parsed.text === 'string') text = parsed.text.trim();
  } catch {
    // plain-text response
  }
  return { ok: true, text, timing: { upstreamMs } };
}
