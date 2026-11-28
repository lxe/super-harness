import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { StreamEvent, UnifiedSession } from '../src/shared/types';
import { acpModelsFor, createAcpDriver, loadAcpAgents, saveAcpAgents, testAcpAgent, type AcpAgentConfig } from '../src/main/adapters/acpAdapter';
import { parseAcpModels } from '../src/main/services/acpClient';
import type { DispatchContext, HarnessDriver } from '../src/main/adapters/types';

const FAKE_AGENT = path.resolve(__dirname, 'fixtures/fakeAcpAgent.mjs');

function setup(env: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-acp-'));
  const agent: AcpAgentConfig = {
    id: 'fake',
    name: 'Fake Agent',
    command: process.execPath,
    args: [FAKE_AGENT],
    env: { FAKE_ACP_STATE: path.join(dir, 'agent-state.json'), ...env },
  };
  const modelsFile = path.join(dir, 'acp-models.json');
  const make = () => createAcpDriver({ agents: () => [agent], sessionsDir: path.join(dir, 'sessions'), modelsFile });
  const events: StreamEvent[] = [];
  const ctx = {
    emitStream: (ev: StreamEvent) => events.push(ev),
    triggerRefresh: () => {},
    spawnStreaming: () => {},
  } as DispatchContext;
  return { dir, agent, modelsFile, make, events, ctx };
}

async function waitForDone(events: StreamEvent[], runs: number) {
  for (let i = 0; i < 200 && events.filter((e) => e.kind === 'done').length < runs; i++) {
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(events.filter((e) => e.kind === 'done')).toHaveLength(runs);
}

async function sessionById(driver: HarnessDriver, id: string): Promise<UnifiedSession> {
  const { sessions } = await driver.detect([], 50, false);
  const s = sessions.find((x) => x.id === id);
  expect(s).toBeDefined();
  return s!;
}

const drivers: HarnessDriver[] = [];
afterEach(() => {
  for (const d of drivers.splice(0)) d.shutdown?.();
});

describe('ACP driver', () => {
  it('starts a session, auto-approves permissions, streams and records the turn', async () => {
    const { make, events, ctx } = setup();
    const driver = make();
    drivers.push(driver);
    const started = await driver.startSession({ harness: 'acp', cwd: os.tmpdir(), prompt: 'hello' }, ctx);
    expect(started.ok).toBe(true);
    await waitForDone(events, 1);

    expect(events.filter((e) => e.kind === 'delta').map((e) => e.text).join('')).toBe('Echo: hello (turn 1)');
    const session = await sessionById(driver, started.sessionId!);
    expect(session).toMatchObject({ harness: 'acp', title: 'hello', model: 'Fake Agent', status: 'idle', isLive: true });

    const tr = await driver.loadTranscript(session, 20);
    expect(tr.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(tr.messages[1].blocks).toEqual([
      { type: 'thinking', text: 'thinking' },
      { type: 'tool_call', name: 'Read file', status: 'completed' },
      { type: 'text', text: 'Echo: hello (turn 1)' },
    ]);
  });

  it('resumes a session after a restart through session/load, keeping the agent’s context', async () => {
    const { make, events, ctx } = setup();
    const first = make();
    const started = await first.startSession({ harness: 'acp', cwd: os.tmpdir(), prompt: 'one' }, ctx);
    await waitForDone(events, 1);
    first.shutdown?.();

    const second = make();
    drivers.push(second);
    const session = await sessionById(second, started.sessionId!);
    expect(session.isLive).toBe(false);
    const sent = await second.sendMessage(session, 'two', undefined, ctx);
    expect(sent).toMatchObject({ ok: true });
    await waitForDone(events, 2);

    const tr = await second.loadTranscript(session, 20);
    // The replayed history is not logged twice; the agent counted this as its second turn.
    expect(tr.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(tr.messages[3].blocks.at(-1)).toEqual({ type: 'text', text: 'Echo: two (turn 2)' });
  });

  it('refuses to resume with an agent that cannot load sessions, instead of starting over silently', async () => {
    const { make, events, ctx } = setup({ FAKE_ACP_NO_LOAD: '1' });
    const first = make();
    const started = await first.startSession({ harness: 'acp', cwd: os.tmpdir(), prompt: 'one' }, ctx);
    await waitForDone(events, 1);
    first.shutdown?.();

    const second = make();
    drivers.push(second);
    const sent = await second.sendMessage(await sessionById(second, started.sessionId!), 'two', undefined, ctx);
    expect(sent.ok).toBe(false);
    expect(sent.error).toMatch(/can’t reopen a session/);
  });

  it('explains where to configure agents when none are set up', async () => {
    const driver = createAcpDriver({ agents: () => [], sessionsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sh-acp-')) });
    const { detection } = await driver.detect([], 50, false);
    expect(detection.installed).toBe(false);
    const res = await driver.startSession({ harness: 'acp', cwd: os.tmpdir() }, {} as DispatchContext);
    expect(res.error).toMatch(/acp-agents\.json/);
  });
});

describe('ACP driver errors', () => {
  it('reports a failed turn once, in the transcript, not also as a stream error', async () => {
    const { make, events, ctx } = setup({ FAKE_ACP_FAIL: '1' });
    const driver = make();
    drivers.push(driver);
    const started = await driver.startSession({ harness: 'acp', cwd: os.tmpdir(), prompt: 'hello' }, ctx);
    expect(started.ok).toBe(true);
    await waitForDone(events, 1);
    expect(events.filter((e) => e.kind === 'error')).toEqual([]);
    const session = await sessionById(driver, started.sessionId!);
    const { messages } = await driver.loadTranscript(session, 10);
    expect(messages.filter((m) => m.error).map((m) => [m.role, m.error])).toEqual([['assistant', 'Free usage limit reached']]);
  });
});

describe('ACP agent settings', () => {
  it('saves agents, keeps other keys in the file, and rejects bad entries', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sh-acp-cfg-')), 'acp-agents.json');
    fs.writeFileSync(file, JSON.stringify({ note: 'keep me', agents: [] }));
    expect(saveAcpAgents([{ id: 'gemini', name: ' Gemini ', command: ' gemini ', args: ['--experimental-acp', ''] }], file)).toEqual({ ok: true });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).note).toBe('keep me');
    expect(loadAcpAgents(file)).toEqual([{ id: 'gemini', name: 'Gemini', command: 'gemini', args: ['--experimental-acp'] }]);

    const before = fs.readFileSync(file, 'utf8');
    expect(saveAcpAgents([{ id: 'has space', command: 'x' }], file).ok).toBe(false);
    expect(saveAcpAgents([{ id: 'a', command: '  ' }], file).ok).toBe(false);
    expect(saveAcpAgents([{ id: 'a', command: 'x' }, { id: 'a', command: 'y' }], file).ok).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('tests an agent with the ACP handshake', async () => {
    const modelsFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sh-acp-m-')), 'm.json');
    const ok = await testAcpAgent({ id: 'fake', command: process.execPath, args: [FAKE_AGENT], env: { FAKE_ACP_NO_LOAD: '1' } }, 20_000, modelsFile);
    expect(ok).toMatchObject({ ok: true, agentName: 'fake-agent', agentVersion: '9.9.9', canLoadSession: false, modelCount: 2 });

    const missing = await testAcpAgent({ id: 'nope', command: '/nonexistent/acp-agent' });
    expect(missing.ok).toBe(false);

    // A process that never answers initialize must time out, not hang Settings.
    const silent = await testAcpAgent({ id: 'cat', command: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] }, 300);
    expect(silent).toMatchObject({ ok: false });
    expect(silent.error).toMatch(/no ACP answer/);
  });
});

describe('ACP models', () => {
  it('lists the models an agent reports, runs the chosen one, and keeps it after a restart', async () => {
    const { agent, modelsFile, make, events, ctx } = setup();
    // Nothing cached: the probe asks the agent.
    expect(await acpModelsFor(agent, modelsFile)).toMatchObject({
      current: 'fake/a',
      configId: 'model',
      models: [{ id: 'fake/a', label: 'FAKE/A' }, { id: 'fake/b', label: 'FAKE/B' }],
    });

    const first = make();
    drivers.push(first);
    const started = await first.startSession({ harness: 'acp', cwd: os.tmpdir(), prompt: 'hi', model: 'fake/b' }, ctx);
    expect(started.ok).toBe(true);
    await waitForDone(events, 1);
    expect(events.filter((e) => e.kind === 'delta').map((e) => e.text).join('')).toBe('Echo: hi (turn 1) [fake/b]');

    // A new process forgets the model; resuming sets it again.
    first.shutdown?.();
    const second = make();
    drivers.push(second);
    events.length = 0;
    expect((await second.sendMessage(await sessionById(second, started.sessionId!), 'again', undefined, ctx)).ok).toBe(true);
    await waitForDone(events, 1);
    expect(events.filter((e) => e.kind === 'delta').map((e) => e.text).join('')).toBe('Echo: again (turn 2) [fake/b]');

    const bad = await second.startSession({ harness: 'acp', cwd: os.tmpdir(), prompt: 'hi', model: 'fake/zzz' }, ctx);
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/no model "fake\/zzz"/);
  });

  it('reads grouped configOptions and the older models field', () => {
    expect(
      parseAcpModels({
        configOptions: [
          { id: 'mode', category: 'mode', options: [{ value: 'ask', name: 'Ask' }] },
          { id: 'm', category: 'model', currentValue: 'y', options: [{ group: 'g', name: 'G', options: [{ value: 'x', name: 'X' }, { value: 'y' }] }] },
        ],
      })
    ).toEqual({ models: [{ id: 'x', label: 'X' }, { id: 'y', label: 'y' }], current: 'y', configId: 'm' });
    expect(
      parseAcpModels({ models: { currentModelId: 'gemini-pro', availableModels: [{ modelId: 'gemini-pro', name: 'Gemini Pro' }] } })
    ).toEqual({ models: [{ id: 'gemini-pro', label: 'Gemini Pro' }], current: 'gemini-pro' });
    expect(parseAcpModels({ sessionId: 's' })).toBeNull();
  });
});
