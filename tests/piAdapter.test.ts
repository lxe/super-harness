import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assignPiHolders,
  buildPiUndeliverableError,
  createPiDriver,
  encodePiCwd,
  extractPiLinkedImages,
  MAX_PI_LINKED_IMAGES_PER_TURN,
  isPiProcessRow,
  parsePiJsonlLines,
  piActiveBranch,
  piRetryFocus,
  piSessionIdFromFilename,
  piTailState,
  scanPiSessionMeta,
} from '../src/main/adapters/piAdapter';
import { createDefaultDrivers } from '../src/main/adapters/index';
import { describePiModelError, summarizePiError } from '../src/main/adapters/piErrors';
import { buildPiRpcArgs, splitPiModelRef } from '../src/main/services/piRpcClient';
import { parsePiModels } from '../src/main/services/catalogService';
import { readLastUserText } from '../src/main/utils/lastUserText';

const line = (o: unknown) => JSON.stringify(o);
const msg = (id: string, parentId: string | null, message: Record<string, unknown>, ts = '2026-11-26T10:00:00.000Z') =>
  line({ type: 'message', id, parentId, timestamp: ts, message });

/** A Pi session with a bash call, a steer, an edit and a final answer (shape of Pi 1.4 files). */
function sampleSession(): string[] {
  return [
    line({ type: 'session', version: 3, id: 'sess-1', timestamp: '2026-11-26T10:00:00.000Z', cwd: '/home/u/proj' }),
    line({ type: 'session_info', id: 'i1', parentId: null, timestamp: '2026-11-26T10:00:00.000Z', name: 'probe' }),
    line({ type: 'model_change', id: 'm1', parentId: 'i1', timestamp: '2026-11-26T10:00:00.000Z', provider: 'ds41', modelId: 'deepseek-v4.1-flash' }),
    msg('s1', 'm1', { role: 'system', content: '', sections: { preamble: 'You are pi' } }),
    msg('u1', 's1', { role: 'user', content: [{ type: 'text', text: 'run sleep' }], timestamp: 1 }),
    msg('a1', 'u1', {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'I will run it' },
        { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'sleep 4; echo hi' } },
      ],
      provider: 'ds41',
      model: 'deepseek-v4.1-flash',
      usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110, cost: { total: 0.01 } },
      stopReason: 'toolUse',
      timestamp: 2,
    }),
    msg('r1', 'a1', { role: 'toolResult', toolCallId: 'c1', toolName: 'bash', content: [{ type: 'text', text: 'hi\n' }], isError: false, durationMs: 4000 }),
    msg('u2', 'r1', { role: 'user', content: [{ type: 'text', text: 'also say banana' }], timestamp: 3 }),
    msg('a2', 'u2', {
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'c2', name: 'edit', arguments: { path: '/home/u/proj/a.ts', edits: [{ oldText: 'x', newText: 'y' }] } }],
      provider: 'ds41',
      model: 'deepseek-v4.1-flash',
      usage: { input: 50, output: 5, cacheRead: 100, cacheWrite: 0, totalTokens: 155, cost: { total: 0.02 } },
      stopReason: 'toolUse',
      timestamp: 4,
    }),
    msg('r2', 'a2', { role: 'toolResult', toolCallId: 'c2', toolName: 'edit', content: [{ type: 'text', text: 'ok' }], details: { diff: '-1 x\n+1 y' }, isError: false }),
    msg('a3', 'r2', {
      role: 'assistant',
      content: [{ type: 'text', text: 'Banana!' }],
      provider: 'ds41',
      model: 'deepseek-v4.1-flash',
      usage: { input: 10, output: 2, cacheRead: 150, cacheWrite: 0, totalTokens: 162, cost: { total: 0 } },
      stopReason: 'stop',
      timestamp: 5,
    }),
  ];
}

describe('Pi session paths', () => {
  it('encodes the working folder the way Pi names session folders', () => {
    expect(encodePiCwd('/home/lxe/scratch/sh-harness-tests/pi')).toBe('--home-lxe-scratch-sh-harness-tests-pi--');
  });
  it('reads the session id from the file name', () => {
    expect(piSessionIdFromFilename('2026-11-18T06-33-02-791Z_01a1ed5b-dc46-75b2-8d5f-500b9045c14b.jsonl')).toBe(
      '01a1ed5b-dc46-75b2-8d5f-500b9045c14b'
    );
  });
});

describe('parsePiJsonlLines', () => {
  it('renders one assistant turn per prompt with tool results attached', () => {
    const res = parsePiJsonlLines(sampleSession(), 'pi:sess-1', Date.now());
    expect(res.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    const first = res.messages[1];
    expect(first.blocks[0]).toEqual({ type: 'thinking', text: 'I will run it' });
    expect(first.blocks[1]).toMatchObject({ type: 'command', command: 'sleep 4; echo hi', output: 'hi\n', status: 'completed' });
    const second = res.messages[3];
    expect(second.blocks[0]).toMatchObject({ type: 'file_change', status: 'completed', changes: [{ path: '/home/u/proj/a.ts', kind: 'edit', diff: '-1 x\n+1 y' }] });
    expect(second.blocks[1]).toEqual({ type: 'text', text: 'Banana!' });
    expect(res.liveActivity?.isWorking).toBe(false);
  });

  it('sums Pi-recorded cost and tokens into stats', () => {
    const res = parsePiJsonlLines(sampleSession(), 'pi:sess-1', Date.now());
    expect(res.stats?.estimatedCostUsd).toBeCloseTo(0.03);
    expect(res.stats?.turnCount).toBe(3);
    expect(res.stats?.contextUsedTokens).toBe(162);
  });

  it('reports a run in progress when the tail ends on a tool call', () => {
    const lines = sampleSession().slice(0, 6);
    const res = parsePiJsonlLines(lines, 'pi:sess-1', Date.now());
    expect(res.tail).toMatchObject({ midTurn: true, activeTool: 'bash' });
    expect(res.messages[1].blocks[1]).toMatchObject({ type: 'command', status: 'running' });
  });

  it('follows the active branch and drops abandoned ones', () => {
    const lines = [
      ...sampleSession().slice(0, 5),
      msg('a-old', 'u1', { role: 'assistant', content: [{ type: 'text', text: 'abandoned' }], stopReason: 'stop' }),
      line({ type: 'branch_summary', id: 'b1', parentId: 'u1', timestamp: '2026-11-26T10:01:00.000Z', fromId: 'a-old', summary: 'tried A' }),
      msg('a-new', 'b1', { role: 'assistant', content: [{ type: 'text', text: 'kept' }], stopReason: 'stop' }),
    ];
    const res = parsePiJsonlLines(lines, 'pi:sess-1', Date.now());
    const texts = res.messages.flatMap((m) => m.blocks).map((b) => (b.type === 'text' ? b.text : b.type === 'notice' ? b.title : ''));
    expect(texts).toContain('kept');
    expect(texts).not.toContain('abandoned');
    expect(texts).toContain('Returned from another branch');
  });

  it('shows compaction and model errors as notices', () => {
    const lines = [
      ...sampleSession().slice(0, 5),
      line({ type: 'compaction', id: 'k1', parentId: 'u1', timestamp: '2026-11-26T10:02:00.000Z', summary: 'did stuff', firstKeptEntryId: 'u1', tokensBefore: 181611 }),
      msg('a9', 'k1', { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'Request timed out.' }),
    ];
    const res = parsePiJsonlLines(lines, 'pi:sess-1', Date.now());
    const notice = res.messages.find((m) => m.harnessMeta?.sourceKind === 'compaction');
    expect(notice?.blocks[0]).toMatchObject({ type: 'notice', title: 'Context compacted (182k tokens)' });
    expect(res.messages[res.messages.length - 1].blocks[0]).toMatchObject({ type: 'notice', title: 'Model: request timed out', detail: 'Request timed out.' });
  });

  it('renders user images from base64 and ! shell runs as commands', () => {
    const lines = [
      msg('u1', null, { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' }] }),
      msg('x1', 'u1', { role: 'bashExecution', command: 'ls', output: 'a\n', exitCode: 0, cancelled: false, truncated: false }),
    ];
    const res = parsePiJsonlLines(lines, 'pi:s', Date.now());
    expect(res.messages[0].blocks[0]).toMatchObject({ type: 'image', dataUrl: 'data:image/jpeg;base64,AAAA' });
    expect(res.messages[1].blocks[0]).toMatchObject({ type: 'command', command: 'ls', output: 'a\n', exitCode: 0 });
  });
});

describe('piActiveBranch', () => {
  it('stops where the tail window cuts off a parent', () => {
    const entries = [
      { type: 'message', id: 'b', parentId: 'a-missing' },
      { type: 'message', id: 'c', parentId: 'b' },
    ];
    expect(piActiveBranch(entries).map((e) => e.id)).toEqual(['b', 'c']);
  });
});

describe('piTailState', () => {
  it('is idle after a final answer and mid-turn after a user message', () => {
    const s = sampleSession();
    expect(piTailState(s, 0).midTurn).toBe(false);
    expect(piTailState(s.slice(0, 5), 0).midTurn).toBe(true);
    expect(piTailState(s.slice(0, 7), 0).midTurn).toBe(true); // tool result landed, next model call pending
  });
});

describe('scanPiSessionMeta', () => {
  it('reads header, name, model and first prompt, then only the appended bytes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-meta-'));
    const file = path.join(dir, '2026-11-26T10-00-00-000Z_sess-1.jsonl');
    const lines = sampleSession();
    fs.writeFileSync(file, lines.slice(0, 5).join('\n') + '\n');
    let meta = scanPiSessionMeta(file, fs.statSync(file))!;
    expect(meta).toMatchObject({ nativeId: 'sess-1', cwd: '/home/u/proj', name: 'probe', model: 'ds41/deepseek-v4.1-flash', firstUserText: 'run sleep', userMessages: 1 });
    fs.appendFileSync(file, lines.slice(5).join('\n') + '\n' + line({ type: 'session_info', id: 'i2', parentId: 'a3', timestamp: 'x', name: 'renamed' }) + '\n{"type":"mess');
    meta = scanPiSessionMeta(file, fs.statSync(file))!;
    expect(meta.name).toBe('renamed');
    expect(meta.userMessages).toBe(2);
    // The partial trailing line is left for the next scan.
    expect(meta.offset).toBe(fs.statSync(file).size - '{"type":"mess'.length);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('Pi terminal holders', () => {
  it('recognises the retitled Pi process', () => {
    expect(isPiProcessRow({ pid: 1, comm: 'pi', args: 'pi' })).toBe(true);
    expect(isPiProcessRow({ pid: 1, comm: 'node', args: 'node /x/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js' })).toBe(true);
    expect(isPiProcessRow({ pid: 1, comm: 'pipewire', args: 'pipewire' })).toBe(false);
  });

  it('pairs confidently only with one holder and one written session in the folder', () => {
    const { byNativeId, ambiguous } = assignPiHolders(
      [{ pid: 12, cwd: '/q', startedAt: 1000000 }],
      [
        { nativeId: 'q-old', cwd: '/q', mtimeMs: 500000 },
        { nativeId: 'q-new', cwd: '/q', mtimeMs: 3000000 },
      ]
    );
    expect(byNativeId.get('q-new')?.pid).toBe(12);
    expect(byNativeId.has('q-old')).toBe(false);
    expect(ambiguous.size).toBe(0);
  });

  it('marks every possibly-held session ambiguous when the folder has several writers', () => {
    const { byNativeId, ambiguous } = assignPiHolders(
      [
        { pid: 10, cwd: '/p', startedAt: 1000000 },
        { pid: 11, cwd: '/p', startedAt: 5000000 },
      ],
      [
        { nativeId: 'old', cwd: '/p', mtimeMs: 500000 },
        { nativeId: 'a', cwd: '/p', mtimeMs: 3000000 },
        { nativeId: 'b', cwd: '/p', mtimeMs: 6000000 },
      ]
    );
    expect(byNativeId.get('b')?.pid).toBe(11);
    expect(byNativeId.get('a')?.pid).toBe(10);
    expect([...ambiguous].sort()).toEqual(['a', 'b']);
    expect(ambiguous.has('old')).toBe(false);
  });

  it('explains undeliverable messages in full', () => {
    expect(buildPiUndeliverableError('Fix auth', 'terminal')).toMatch(/not inside tmux/);
    expect(buildPiUndeliverableError('Fix auth', 'ambiguous')).toMatch(/fork the conversation/);
  });
});

describe('Pi RPC helpers', () => {
  it('splits provider/modelId at the first slash', () => {
    expect(splitPiModelRef('logits/moonshotai/kimi-k3.1-pro')).toEqual({ provider: 'logits', modelId: 'moonshotai/kimi-k3.1-pro' });
    expect(splitPiModelRef('sonnet')).toBeNull();
  });
  it('builds worker args for resuming and for new sessions', () => {
    expect(buildPiRpcArgs({ sessionFile: '/s.jsonl' })).toEqual(['--mode', 'rpc', '--session', '/s.jsonl']);
    expect(buildPiRpcArgs({ sessionId: 'abc', name: 'T', model: 'a/b', thinking: 'high' })).toEqual([
      '--mode', 'rpc', '--session-id', 'abc', '--name', 'T', '--model', 'a/b', '--thinking', 'high',
    ]);
  });
});

describe('Pi catalog', () => {
  it('maps RPC models with supported thinking levels and marks the default', () => {
    const models = parsePiModels(
      [
        { provider: 'logits', id: 'moonshotai/kimi', name: 'Kimi', reasoning: true, contextWindow: 1048576 },
        { provider: 'ds41', id: 'deepseek', name: 'DS', reasoning: true, thinkingLevelMap: { off: 'none', minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' } },
        { provider: 'x', id: 'plain', reasoning: false },
      ],
      'ds41/deepseek',
      'high'
    );
    expect(models[0]).toMatchObject({ id: 'ds41/deepseek', isDefault: true, reasoningLevels: ['off', 'low', 'high', 'max'], defaultReasoningLevel: 'high' });
    expect(models.find((m) => m.id === 'logits/moonshotai/kimi')?.reasoningLevels).toEqual(['off', 'minimal', 'low', 'medium', 'high']);
    expect(models.find((m) => m.id === 'x/plain')?.reasoningLevels).toBeUndefined();
  });
});

describe('Pi lastUserText', () => {
  it('returns the newest typed prompt', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-last-'));
    const file = path.join(dir, 's.jsonl');
    fs.writeFileSync(file, sampleSession().join('\n') + '\n');
    expect(readLastUserText(file, 'pi')).toBe('also say banana');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('Pi driver', () => {
  it('is registered and refuses permission modes honestly', async () => {
    expect(createDefaultDrivers().some((d) => d.id === 'pi')).toBe(true);
    const driver = createPiDriver();
    const session = { id: 'pi:x', nativeId: 'x', cwd: '/tmp', title: 't' } as never;
    const res = await driver.applySessionConfig!(session, { permissionMode: 'plan', model: 'ds41/deepseek', reasoningEffort: 'none' }, {} as never);
    expect(res.find((r) => r.field === 'permissionMode')?.status).toBe('unsupported');
    expect(res.find((r) => r.field === 'model')).toMatchObject({ status: 'next_message', value: 'ds41/deepseek' });
    expect(res.find((r) => r.field === 'reasoningEffort')).toMatchObject({ status: 'next_message', value: 'off' });
    driver.shutdown?.();
  });
});

describe('Pi linked images', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-linked-'));
  const png = (name: string) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, 'x');
    return p;
  };
  const smiley = png('smiley.png');
  const fresh = () => ({ seen: new Set<string>(), budget: { left: MAX_PI_LINKED_IMAGES_PER_TURN } });

  it('turns linked-image, image and link markdown into one image block and drops dead links', () => {
    const s = fresh();
    const r = extractPiLinkedImages(
      `Here it is:\n\n[![Smiley face](${smiley})](${smiley})\n\nAttached: [smiley.png](file://${smiley})`,
      s.seen,
      s.budget
    );
    expect(r.images).toEqual([{ type: 'image', path: smiley, name: 'Smiley face' }]);
    expect(r.text).toBe('Here it is:\n\nAttached: smiley.png');
  });

  it('shows bare paths and keeps them in the text', () => {
    const s = fresh();
    const r = extractPiLinkedImages(`Saved to ${smiley}.`, s.seen, s.budget);
    expect(r.images.map((i) => i.path)).toEqual([smiley]);
    expect(r.text).toBe(`Saved to ${smiley}.`);
  });

  it('leaves missing files, relative paths, web URLs and non-images alone', () => {
    const s = fresh();
    const text = `![a](${dir}/missing.png) [b](img/rel.png) ![c](https://x.com/c.png) [d](${dir}/notes.txt)`;
    const r = extractPiLinkedImages(text, s.seen, s.budget);
    expect(r.images).toEqual([]);
    expect(r.text).toBe(text);
  });

  it('caps images per turn', () => {
    const s = fresh();
    const paths = Array.from({ length: 6 }, (_, i) => png(`p${i}.png`));
    const r = extractPiLinkedImages(paths.map((p) => `![x](${p})`).join(' '), s.seen, s.budget);
    expect(r.images).toHaveLength(MAX_PI_LINKED_IMAGES_PER_TURN);
  });

  it('adds image blocks to the assistant turn in a parsed transcript', () => {
    const lines = [
      msg('u1', null, { role: 'user', content: 'draw a smiley' }),
      msg('a1', 'u1', {
        role: 'assistant',
        content: [{ type: 'text', text: `Done: ![Smiley](${smiley})` }],
        provider: 'p',
        model: 'm',
        stopReason: 'stop',
      }),
    ];
    const r = parsePiJsonlLines(lines, 'pi:x', Date.now());
    const blocks = r.messages[1].blocks;
    expect(blocks).toEqual([
      { type: 'text', text: 'Done: ' },
      { type: 'image', path: smiley, name: 'Smiley' },
    ]);
  });
});

describe('Pi model errors', () => {
  const user = (id: string, parentId: string | null, text: string) =>
    JSON.stringify({ type: 'message', id, parentId, timestamp: '2026-11-26T10:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text }] } });
  const failed = (id: string, parentId: string, errorMessage = 'Connection error.: connect ECONNREFUSED 127.0.0.1:9') =>
    JSON.stringify({
      type: 'message',
      id,
      parentId,
      timestamp: '2026-11-26T10:00:01.000Z',
      message: { role: 'assistant', content: [], provider: 'deadprov', model: 'm1', stopReason: 'error', errorMessage },
    });
  const removedBy = (id: string, parentId: string, target: string) =>
    JSON.stringify({ type: 'context_edit', id, parentId, timestamp: '2026-11-26T10:00:01.500Z', targetId: target, replacement: null });
  const ok = (id: string, parentId: string, text: string) =>
    JSON.stringify({
      type: 'message',
      id,
      parentId,
      timestamp: '2026-11-26T10:00:05.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text }], provider: 'deadprov', model: 'm1', stopReason: 'stop' },
    });

  it('describes provider failures in plain words', () => {
    expect(describePiModelError({ provider: 'p', model: 'm', errorMessage: 'Connection error.: connect ECONNREFUSED 10.0.0.1:8080' })).toBe(
      'p / m: connection refused at 10.0.0.1:8080'
    );
    expect(summarizePiError('getaddrinfo ENOTFOUND api.example.com')).toBe('host not found at api.example.com');
    expect(summarizePiError('Connection error.', '10.0.0.2:80')).toBe('could not connect to 10.0.0.2:80');
    expect(summarizePiError('529 overloaded')).toBe('529 overloaded');
    expect(summarizePiError('Connection error.: bad port', '127.0.0.1:9')).toBe('could not connect to 127.0.0.1:9 (bad port)');
  });

  it('keeps retried failures in the thread as one notice with a count', () => {
    const lines = [
      user('u1', null, 'hi'),
      failed('a1', 'u1'),
      removedBy('e1', 'a1', 'a1'),
      failed('a2', 'e1'),
      removedBy('e2', 'a2', 'a2'),
      failed('a3', 'e2'),
      removedBy('e3', 'a3', 'a3'),
      failed('a4', 'e3'),
    ];
    const r = parsePiJsonlLines(lines, 'pi:x', Date.now());
    expect(r.messages.map((m) => m.role)).toEqual(['user', 'system']);
    expect(r.messages[1].blocks[0]).toMatchObject({
      type: 'notice',
      title: 'deadprov / m1: connection refused at 127.0.0.1:9 (failed 4 times)',
    });
    // The last failure was not removed: Pi gave up, so the turn is over.
    expect(r.tail.midTurn).toBe(false);
    expect(r.tail.modelError).toMatchObject({ retrying: false, attempts: 4 });
  });

  it('reports a retry in progress while the newest failure was removed from context', () => {
    const lines = [user('u1', null, 'hi'), failed('a1', 'u1'), removedBy('e1', 'a1', 'a1'), failed('a2', 'e1'), removedBy('e2', 'a2', 'a2')];
    const r = parsePiJsonlLines(lines, 'pi:x', Date.now());
    expect(r.tail.midTurn).toBe(true);
    expect(r.liveActivity?.isWorking).toBe(true);
    expect(r.liveActivity?.focus).toBe('Retrying: connection refused at 127.0.0.1:9 (2 failed)');
    expect(piRetryFocus({ errorMessage: 'connect ECONNREFUSED 1.2.3.4:5' }, 1, 3)).toBe('Retrying: connection refused at 1.2.3.4:5 (attempt 2 of 4)');
  });

  it('keeps the notice when a retry then succeeds', () => {
    const lines = [user('u1', null, 'hi'), failed('a1', 'u1'), removedBy('e1', 'a1', 'a1'), ok('a2', 'e1', 'hello')];
    const r = parsePiJsonlLines(lines, 'pi:x', Date.now());
    expect(r.messages.map((m) => [m.role, m.blocks[0]?.type])).toEqual([
      ['user', 'text'],
      ['system', 'notice'],
      ['assistant', 'text'],
    ]);
    expect(r.tail.midTurn).toBe(false);
    expect(r.tail.modelError).toBeUndefined();
  });
});
