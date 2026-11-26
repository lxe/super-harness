import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  buildMuseTurnInputs,
  classifyMspError,
  createMspItemStore,
  decodeMspLine,
  encodeMspFrame,
  extractMspHistoryItems,
  foldMspItems,
  isValidMspClientName,
  MuseMspConnection,
  MspNdjsonDecoder,
  uuidv7,
  type MspItem,
} from '../src/main/services/museMspClient';
import type { StreamEvent } from '../src/shared/types';

describe('MSP NDJSON codec', () => {
  it('encodes one JSON-RPC frame per LF-terminated line', () => {
    const out = encodeMspFrame({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(out.endsWith('\n')).toBe(true);
    expect(out.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(out)).toMatchObject({ id: 1, method: 'initialize' });
  });

  it('decodes split and coalesced lines, skipping unparseable lines', () => {
    const dec = new MspNdjsonDecoder();
    expect(dec.push('{"jsonrpc":"2.0","id":1,"res')).toEqual([]);
    const frames = dec.push(
      'ult":{}}\nnot json at all\n{"jsonrpc":"2.0","method":"turn/completed","params":{}}\nContent-Length: 42\n'
    );
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ id: 1 });
    expect(frames[1]).toMatchObject({ method: 'turn/completed' });
  });

  it('decodeMspLine returns null for blank/garbage lines', () => {
    expect(decodeMspLine('')).toBeNull();
    expect(decodeMspLine('muse: notice')).toBeNull();
    expect(decodeMspLine('{"a":1}')).toEqual({ a: 1 });
  });
});

describe('MSP identity helpers', () => {
  it('mints UUIDv7 command ids', () => {
    const id = uuidv7();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(uuidv7()).not.toBe(id);
  });

  it('validates initialize client names against ^[a-z0-9_]+$', () => {
    expect(isValidMspClientName('super_harness')).toBe(true);
    expect(isValidMspClientName('super-harness')).toBe(false);
    expect(isValidMspClientName('SuperHarness')).toBe(false);
  });

  it('classifies host errors by JSON-RPC code', () => {
    expect(classifyMspError({ code: -32021, message: 'x' })).toBe('session-in-use');
    expect(classifyMspError({ code: -32024, message: 'x' })).toBe('session-not-loaded');
    expect(
      classifyMspError({ code: -32030, message: 'x', data: { reason: 'missing_run' } })
    ).toBe('missing-run');
    expect(classifyMspError({ code: -32601, message: 'x' })).toBe('method-not-found');
    expect(classifyMspError(new Error('boom'))).toBe('other');
    expect(classifyMspError('nope')).toBe('other');
  });
});

describe('buildMuseTurnInputs', () => {
  it('orders image parts (base64 from disk) before the text part, no synthesized text', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msp-inputs-'));
    const imgPath = path.join(dir, 'x.png');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    fs.writeFileSync(imgPath, png);
    const parts = buildMuseTurnInputs('look at this', [
      { id: 'a', name: 'x.png', path: imgPath, mimeType: 'image/png' },
    ]);
    expect(parts).toEqual([
      { type: 'image', mediaType: 'image/png', base64Data: png.toString('base64') },
      { type: 'text', text: 'look at this' },
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('sends image-only turns without inventing prompt text', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msp-inputs-'));
    const imgPath = path.join(dir, 'y.jpg');
    fs.writeFileSync(imgPath, Buffer.from([1, 2, 3]));
    expect(
      buildMuseTurnInputs('', [
        { id: 'a', name: 'y.jpg', path: imgPath, mimeType: 'image/jpeg' },
      ])
    ).toEqual([
      { type: 'image', mediaType: 'image/jpeg', base64Data: Buffer.from([1, 2, 3]).toString('base64') },
    ]);
    expect(buildMuseTurnInputs('hi')).toEqual([{ type: 'text', text: 'hi' }]);
    expect(buildMuseTurnInputs('   ')).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

function item(partial: Partial<MspItem> & { kind: string }): MspItem {
  return { itemId: partial.itemId ?? `i-${Math.random()}`, revision: 1, ...partial } as MspItem;
}

describe('foldMspItems (host-folded items -> unified transcript)', () => {
  it('coalesces a turn: user, reasoning, agent text, bash + generic tool calls', () => {
    const items: MspItem[] = [
      item({ kind: 'userMessage', itemId: 'u1', turnId: 't1', text: 'Fix it' }),
      item({ kind: 'reasoning', itemId: 'r1', turnId: 't1', summary: ['thinking hard'] }),
      item({ kind: 'agentMessage', itemId: 'a1', turnId: 't1', text: 'On it.' }),
      item({
        kind: 'toolCall',
        itemId: 'c1',
        turnId: 't1',
        tool: 'bash',
        args: JSON.stringify({ command: 'ls -la', description: 'List' }),
        status: 'completed',
      }),
      item({
        kind: 'toolCall',
        itemId: 'c2',
        turnId: 't1',
        tool: 'read_file',
        args: JSON.stringify({ path: 'x.ts' }),
        status: 'completed',
      }),
      item({ kind: 'agentMessage', itemId: 'a2', turnId: 't1', text: 'Done.' }),
    ];
    const msgs = foldMspItems(items);
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].blocks).toEqual([{ type: 'text', text: 'Fix it' }]);
    expect(msgs[1].role).toBe('assistant');
    expect(msgs[1].blocks.map((b) => b.type)).toEqual([
      'thinking',
      'text',
      'command',
      'tool_call',
      'text',
    ]);
    expect(msgs[1].blocks[2]).toMatchObject({ type: 'command', command: 'ls -la' });
    expect(msgs[1].blocks[3]).toMatchObject({ type: 'tool_call', name: 'read_file' });
  });

  it('renders peerMessage items as agent-sourced user messages (host kind, not human)', () => {
    const msgs = foldMspItems([
      item({
        kind: 'peerMessage',
        itemId: 'p1',
        peerMessage: { body: 'Very cool.' },
      }),
    ]);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].harnessMeta?.sourceKind).toBe('agent');
    expect(msgs[0].blocks).toEqual([{ type: 'text', text: 'Very cool.' }]);
  });

  it('renders unknown kinds generically from fallbackText and userShell as command', () => {
    const msgs = foldMspItems([
      item({ kind: 'someFutureKind', itemId: 'z1', fallback: undefined, fallbackText: 'Did a thing', status: 'completed' } as Partial<MspItem> & { kind: string }),
      item({ kind: 'userShell', itemId: 's1', commandText: 'pwd', exitCode: 0 }),
    ]);
    expect(msgs[0].blocks).toEqual([
      { type: 'notice', title: 'someFutureKind', detail: 'Did a thing' },
    ]);
    expect(msgs[1].blocks).toEqual([
      { type: 'command', command: 'pwd', exitCode: 0, status: undefined },
    ]);
  });

  it('extracts history items from inline and snapshot envelopes', () => {
    const it1 = item({ kind: 'userMessage', itemId: 'u1', text: 'hi' });
    expect(extractMspHistoryItems({ mode: 'inline', items: [it1] })).toEqual([it1]);
    expect(
      extractMspHistoryItems({
        mode: 'snapshot',
        items: null,
        snapshot: { state: { items: [it1] } },
      })
    ).toEqual([it1]);
    expect(extractMspHistoryItems({ mode: 'none', items: null })).toEqual([]);
    expect(extractMspHistoryItems(undefined)).toEqual([]);
  });
});

describe('createMspItemStore reducer', () => {
  it('replaces iff higher revision, appends deltas, accepts completed without started', () => {
    const store = createMspItemStore();
    store.applyItem(item({ kind: 'agentMessage', itemId: 'a1', revision: 2, text: 'new' }));
    store.applyItem(item({ kind: 'agentMessage', itemId: 'a1', revision: 1, text: 'old' }));
    expect(store.items()).toHaveLength(1);
    expect((store.items()[0] as { text?: string }).text).toBe('new');
    store.applyDelta('a1', 'text', 'er');
    expect((store.items()[0] as { text?: string }).text).toBe('newer');
    store.applyDelta('missing', 'text', 'x'); // ignored, no crash
    store.applyItem(item({ kind: 'agentMessage', itemId: 'a2', revision: 1, text: 'second' }));
    expect(store.items().map((i) => i.itemId)).toEqual(['a1', 'a2']);
  });
});

describe('MuseMspConnection against a scripted fake host', () => {
  it('handshakes, receipts server requests, and streams a turn lifecycle', async () => {
    const toHost = new PassThrough();
    const fromHost = new PassThrough();
    const hostLines: Array<Record<string, unknown>> = [];
    let hostBuf = '';
    const hostSend = (obj: unknown) => fromHost.write(`${JSON.stringify(obj)}\n`);

    toHost.on('data', (chunk: Buffer) => {
      hostBuf += chunk.toString('utf8');
      let idx: number;
      while ((idx = hostBuf.indexOf('\n')) >= 0) {
        const line = hostBuf.slice(0, idx);
        hostBuf = hostBuf.slice(idx + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as Record<string, unknown>;
        hostLines.push(msg);
        if (msg.method === 'initialize') {
          hostSend({
            jsonrpc: '2.0',
            id: msg.id,
            result: { schema: { version: 1 }, serverInfo: { name: 'muse', version: 'x' } },
          });
          // Server-initiated request that must be receipted with {}.
          hostSend({
            jsonrpc: '2.0',
            id: 'srv-1',
            method: 'userInput/request',
            params: { userInputId: 'q1' },
          });
        } else if (msg.method === 'session/resume') {
          hostSend({
            jsonrpc: '2.0',
            id: msg.id,
            result: { session: { sessionId: 's1' }, history: { mode: 'none', items: null } },
          });
        } else if (msg.method && msg.id !== undefined && msg.method !== 'turn/start') {
          hostSend({ jsonrpc: '2.0', id: msg.id, result: {} });
        }
        if (msg.method === 'turn/start') {
          const params = msg.params as Record<string, unknown>;
          hostSend({
            jsonrpc: '2.0',
            id: msg.id,
            result: { status: 'accepted', disposition: 'started', turnId: params.commandId },
          });
          setImmediate(() => {
            hostSend({
              jsonrpc: '2.0',
              method: 'item/delta',
              params: { sessionId: 's1', itemId: 'a1', field: 'text', delta: 'echo: hi' },
            });
            hostSend({
              jsonrpc: '2.0',
              method: 'turn/completed',
              params: { sessionId: 's1', turnId: params.commandId, terminal: 'completed' },
            });
          });
        }
      }
    });

    const conn = new MuseMspConnection({ input: toHost, output: fromHost });
    const events: StreamEvent[] = [];
    let completed = false;
    await conn.initialize();
    const done = new Promise<void>((resolve) => {
      void conn
        .sendTurn({
          shSessionId: 'muse:s1',
          nativeSessionId: 's1',
          prompt: 'hi',
          runId: 'run-1',
          onEvent: (ev) => events.push(ev),
          onComplete: () => {
            completed = true;
            resolve();
          },
        })
        .catch(() => resolve());
    });
    await done;

    const methods = hostLines.map((l) => l.method).filter(Boolean);
    expect(methods.slice(0, 2)).toEqual(['initialize', 'initialized']);
    expect(methods).toContain('session/resume');
    expect(methods).toContain('turn/start');
    // Server request receipted with an empty-object result.
    const receipt = hostLines.find((l) => l.id === 'srv-1' && 'result' in l);
    expect(receipt?.result).toEqual({});
    expect(events.map((e) => e.kind)).toEqual(['start', 'delta', 'done']);
    expect(events[1].text).toBe('echo: hi');
    expect(completed).toBe(true);
    conn.close();
  });
});
