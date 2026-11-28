#!/usr/bin/env node
// Minimal Agent Client Protocol agent for tests. Remembers how many prompts each session got in
// $FAKE_ACP_STATE so a restarted process can prove session/load restored the session.
// FAKE_ACP_NO_LOAD=1 makes it an agent without loadSession support; FAKE_ACP_FAIL=1 fails every prompt.
import fs from 'node:fs';
import readline from 'node:readline';

const stateFile = process.env.FAKE_ACP_STATE;
const canLoad = process.env.FAKE_ACP_NO_LOAD !== '1';
const state = () => (stateFile && fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {});
const save = (s) => stateFile && fs.writeFileSync(stateFile, JSON.stringify(s));
const loaded = new Set();
// Models live in the process, like a real agent that forgets a session's model on restart.
const MODELS = ['fake/a', 'fake/b'];
const modelOf = new Map();
const configOptions = (sid) => [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: modelOf.get(sid) ?? 'fake/a', options: MODELS.map((m) => ({ value: m, name: m.toUpperCase() })) },
];
let nextId = 1000;
const waiting = new Map();

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    send({ id, method, params });
  });

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const msg = JSON.parse(line);
  if (msg.id !== undefined && msg.method === undefined) {
    waiting.get(msg.id)?.(msg.result);
    return;
  }
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: canLoad }, agentInfo: { name: 'fake-agent', version: '9.9.9' } } });
  } else if (method === 'session/new') {
    const s = state();
    const sessionId = `fake-${Object.keys(s).length + 1}`;
    s[sessionId] = 0;
    save(s);
    loaded.add(sessionId);
    send({ id, result: { sessionId, configOptions: configOptions(sessionId) } });
  } else if (method === 'session/load') {
    if (!(params.sessionId in state())) return send({ id, error: { code: -32002, message: 'unknown session' } });
    loaded.add(params.sessionId);
    update(params.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'replayed history' } });
    send({ id, result: { configOptions: configOptions(params.sessionId) } });
  } else if (method === 'session/set_config_option') {
    if (!MODELS.includes(params.value)) return send({ id, error: { code: -32602, message: 'bad model' } });
    modelOf.set(params.sessionId, params.value);
    send({ id, result: { configOptions: configOptions(params.sessionId) } });
  } else if (method === 'session/prompt') {
    const sid = params.sessionId;
    if (!loaded.has(sid)) return send({ id, error: { code: -32002, message: 'session not loaded' } });
    if (process.env.FAKE_ACP_FAIL === '1') return send({ id, error: { code: -32603, message: 'Free usage limit reached' } });
    const s = state();
    s[sid] += 1;
    save(s);
    const text = params.prompt.map((b) => b.text ?? '').join('');
    update(sid, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } });
    update(sid, { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Read file', kind: 'read', status: 'pending' });
    const answer = await ask('session/request_permission', {
      sessionId: sid,
      toolCall: { toolCallId: 't1' },
      options: [
        { optionId: 'no', name: 'Reject', kind: 'reject_once' },
        { optionId: 'yes', name: 'Allow', kind: 'allow_once' },
      ],
    });
    const approved = answer?.outcome?.optionId === 'yes';
    update(sid, { sessionUpdate: 'tool_call_update', toolCallId: 't1', status: approved ? 'completed' : 'failed' });
    update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Echo: ${text}` } });
    update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ` (turn ${s[sid]})` } });
    if (modelOf.has(sid)) update(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ` [${modelOf.get(sid)}]` } });
    send({ id, result: { stopReason: 'end_turn' } });
  } else if (method === 'session/cancel') {
    // notification: nothing to stop in this fake
  } else if (id !== undefined) {
    send({ id, error: { code: -32601, message: `unknown method ${method}` } });
  }
});
