import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  audioExtensionFor,
  checkDictationServer,
  DictationError,
  normalizeDictationBaseUrl,
  readYapYapConfig,
  transcribeAudio,
} from '../src/main/services/dictation';
import { redactStateForClients } from '../src/main/services/controlServer';
import type { SuperHarnessState } from '../src/shared/types';

interface Captured {
  method?: string;
  url?: string;
  auth?: string;
  body: string;
}

let server: http.Server | null = null;

async function fakeServer(
  handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void
): Promise<{ base: string; captured: Captured[] }> {
  const captured: Captured[] = [];
  server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString('latin1');
    captured.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
    handler(req, body, res);
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
  const addr = server.address() as { port: number };
  return { base: `http://127.0.0.1:${addr.port}`, captured };
}

afterEach(() => {
  server?.close();
  server = null;
});

describe('dictation settings helpers', () => {
  it('normalizes pasted base URLs', () => {
    expect(normalizeDictationBaseUrl(' http://h:8122/ ')).toBe('http://h:8122');
    expect(normalizeDictationBaseUrl('http://h:8122/v1')).toBe('http://h:8122');
    expect(normalizeDictationBaseUrl('http://h:8122/v1/audio/transcriptions')).toBe('http://h:8122');
    expect(normalizeDictationBaseUrl(undefined)).toBe('');
  });

  it('maps content types to upload extensions', () => {
    expect(audioExtensionFor('audio/webm;codecs=opus')).toBe('webm');
    expect(audioExtensionFor('audio/mp4')).toBe('m4a');
    expect(audioExtensionFor('audio/ogg')).toBe('ogg');
    expect(audioExtensionFor('audio/wav')).toBe('wav');
    expect(audioExtensionFor('')).toBe('wav');
  });

  it('reads the [server] section of a YapYap config for the one-time prefill', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-yap-'));
    fs.mkdirSync(path.join(home, '.config', 'yapyap'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.config', 'yapyap', 'config.toml'),
      '[client]\nurl = "http://wrong"\n\n[server]\n# comment\nurl = "http://10.0.0.2:8122/"\ntoken = "abc"\n'
    );
    expect(readYapYapConfig(home)).toEqual({ baseUrl: 'http://10.0.0.2:8122', apiKey: 'abc' });
    expect(readYapYapConfig(path.join(home, 'missing'))).toBeNull();
  });
});

describe('checkDictationServer', () => {
  it('reports not configured without a base URL', async () => {
    expect(await checkDictationServer({ baseUrl: '' })).toEqual({ ok: true, configured: false, healthy: false });
    expect(await checkDictationServer(undefined)).toMatchObject({ configured: false });
  });

  it('is healthy when /v1/models answers with the key, and reports the first model', async () => {
    const { base, captured } = await fakeServer((_req, _b, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'whisper-1' }] }));
    });
    const st = await checkDictationServer({ baseUrl: base, apiKey: 'k1' });
    expect(st).toEqual({ ok: true, configured: true, healthy: true, model: 'whisper-1' });
    expect(captured[0]).toMatchObject({ url: '/v1/models', auth: 'Bearer k1' });
  });

  it('reports a rejected key', async () => {
    const { base } = await fakeServer((_req, _b, res) => {
      res.statusCode = 401;
      res.end('{}');
    });
    const st = await checkDictationServer({ baseUrl: base, apiKey: 'bad' });
    expect(st.healthy).toBe(false);
    expect(st.error).toMatch(/401/);
  });

  it('falls back to /health for servers without a models endpoint', async () => {
    const { base } = await fakeServer((req, _b, res) => {
      if (req.url === '/health') {
        res.end(JSON.stringify({ status: 'ok', model: 'tiny' }));
      } else {
        res.statusCode = 404;
        res.end();
      }
    });
    expect(await checkDictationServer({ baseUrl: base })).toMatchObject({ healthy: true, model: 'tiny' });
  });

  it('reports an unreachable server', async () => {
    const st = await checkDictationServer({ baseUrl: 'http://127.0.0.1:1' }, 1500);
    expect(st).toMatchObject({ configured: true, healthy: false });
    expect(st.error).toBeTruthy();
  });
});

describe('transcribeAudio', () => {
  it('posts multipart audio with model, language and Bearer key and returns the text', async () => {
    const { base, captured } = await fakeServer((_req, _b, res) => {
      res.end(JSON.stringify({ text: '  hello world ' }));
    });
    const res = await transcribeAudio(
      { baseUrl: base, apiKey: 'k2', model: 'm1', language: 'en' },
      Buffer.from('RIFFxxxx'),
      'audio/webm;codecs=opus'
    );
    expect(res.text).toBe('hello world');
    expect(captured[0].url).toBe('/v1/audio/transcriptions');
    expect(captured[0].auth).toBe('Bearer k2');
    expect(captured[0].body).toContain('filename="dictation.webm"');
    expect(captured[0].body).toMatch(/name="model"\r\n\r\nm1/);
    expect(captured[0].body).toMatch(/name="language"\r\n\r\nen/);
    expect(captured[0].body).toMatch(/name="response_format"\r\n\r\njson/);
  });

  it('throws 503 when not configured and 502 on upstream errors', async () => {
    await expect(transcribeAudio({ baseUrl: '' }, Buffer.from('x'), 'audio/wav')).rejects.toMatchObject({
      statusCode: 503,
    });
    const { base } = await fakeServer((_req, _b, res) => {
      res.statusCode = 500;
      res.end('boom');
    });
    const err = await transcribeAudio({ baseUrl: base }, Buffer.from('x'), 'audio/wav').catch((e) => e);
    expect(err).toBeInstanceOf(DictationError);
    expect(err.statusCode).toBe(502);
  });
});

describe('redactStateForClients', () => {
  it('drops the legacy mobile token and the dictation API key', () => {
    const state = {
      settings: {
        mobileApi: { enabled: true, bindHost: '0.0.0.0', port: 47890, token: 'secret' },
        dictation: { baseUrl: 'http://h', apiKey: 'key' },
      },
    } as unknown as SuperHarnessState;
    const out = redactStateForClients(state);
    expect(JSON.stringify(out)).not.toContain('secret');
    expect(JSON.stringify(out)).not.toContain('"key"');
    expect(out.settings.dictation).toEqual({ baseUrl: 'http://h', hasApiKey: true });
    // The original object is untouched (the desktop renderer still needs the full state).
    expect(state.settings.mobileApi?.token).toBe('secret');
  });
});

describe('ConfigStore dictation prefill', () => {
  it('copies the YapYap server into settings.dictation once and keeps an emptied setting', async () => {
    const { vi } = await import('vitest');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-home-'));
    fs.mkdirSync(path.join(home, '.config', 'yapyap'), { recursive: true });
    fs.writeFileSync(
      path.join(home, '.config', 'yapyap', 'config.toml'),
      '[server]\nurl = "http://10.0.0.3:8122"\ntoken = "tok"\n'
    );
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      vi.resetModules();
      const { ConfigStore } = await import('../src/main/store/configStore');
      const store = new ConfigStore();
      expect(store.getState().settings.dictation).toEqual({ baseUrl: 'http://10.0.0.3:8122', apiKey: 'tok' });
      const saved = JSON.parse(fs.readFileSync(path.join(home, '.config', 'super-harness', 'state.json'), 'utf8'));
      expect(saved.settings.dictation.baseUrl).toBe('http://10.0.0.3:8122');

      store.updateSettings({ dictation: { baseUrl: '' } });
      expect(store.getState().settings.dictation?.apiKey).toBe('tok');
      vi.resetModules();
      const again = new (await import('../src/main/store/configStore')).ConfigStore();
      expect(again.getState().settings.dictation?.baseUrl).toBe('');
    } finally {
      process.env.HOME = prevHome;
      vi.resetModules();
    }
  });
});
