#!/usr/bin/env node
/**
 * End-to-End Multi-Harness Verification Suite for Super Harness.
 *
 * Tests real live round-trips across:
 *  1. Discovery & subagent nesting + native sections
 *  2. OpenAI Codex (create -> resume text -> resume w/ image -> transcript -> native archive)
 *  3. Antigravity CLI (create -> discover -> resume text -> resume w/ image -> transcript -> archive)
 *     + Antigravity Desktop linked continuation (verifies zero `trajectory not found` errors)
 *  4. Claude CLI (create -> resume text + image -> transcript -> cleanup)
 *  5. tmux live mirror + tmux send-keys + killTmux archive
 *  6. LiveSyncService (Linux inotify sub-300ms push latency)
 *  7. ControlServer + super-harness-mcp stdio JSON-RPC + SSE /api/events
 */

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ConfigStore } = require('../dist/main/main/store/configStore');
const { HarnessRegistry } = require('../dist/main/main/adapters/registry');
const { HarnessDispatcher } = require('../dist/main/main/services/dispatcher');
const { LiveSyncService } = require('../dist/main/main/services/liveSync');
const { ControlServer } = require('../dist/main/main/services/controlServer');
const { resolveCodexBinary } = require('../dist/main/main/utils/system');

const PNG_1X1_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const results = [];

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function runTest(name, fn) {
  const t0 = Date.now();
  process.stdout.write(`\n[TEST] ${name} ... `);
  try {
    const detail = await fn();
    const ms = Date.now() - t0;
    console.log(`PASS (${ms}ms)${detail ? ` — ${detail}` : ''}`);
    results.push({ name, ok: true, ms, detail });
  } catch (err) {
    const ms = Date.now() - t0;
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`FAIL (${ms}ms)\n  Error: ${msg}`);
    results.push({ name, ok: false, ms, error: msg });
  }
}

function makeTempStore(tmpDir) {
  // Use real ConfigStore semantics without mutating user's ~/.config/super-harness/state.json
  const state = {
    settings: {
      pollIntervalMs: 5000,
      maxSessionsPerHarness: 80,
      sidebarGroupBy: 'native',
      showArchived: false,
      showHidden: false,
      enabledHarnesses: { codex: true, claude: true, antigravity: true },
      master: { harness: 'claude', model: '', cwd: tmpDir, autoApplyActions: true },
      defaultNewSessionCwd: tmpDir,
    },
    folders: [],
    overrides: {},
    linkedCliSessions: {},
    masterMessages: [],
  };
  return {
    getState: () => structuredClone(state),
    subscribe: () => () => {},
    updateSettings: (p) => {
      state.settings = { ...state.settings, ...p };
      return structuredClone(state);
    },
    applyOrganize: (actions) => {
      for (const a of actions) {
        if (a.type === 'hide_session' && a.sessionId) {
          state.overrides[a.sessionId] = { ...(state.overrides[a.sessionId] || {}), hidden: true };
        }
      }
      return structuredClone(state);
    },
    getLinkedCliSession: (sid) => state.linkedCliSessions[sid],
    setLinkedCliSession: (sid, cid) => {
      state.linkedCliSessions[sid] = cid;
    },
  };
}

async function dispatchAndCollect(dispatcher, sessionId, prompt, attachments) {
  const events = [];
  let doneResolve;
  const donePromise = new Promise((r) => {
    doneResolve = r;
  });
  const origEmit = dispatcher._testEmitHook;
  dispatcher._testEmitHook = (ev) => {
    if (ev.sessionId === sessionId) {
      events.push(ev);
      if (ev.kind === 'done') doneResolve();
    }
  };
  const sendRes = await dispatcher.sendToSession(sessionId, prompt, attachments);
  assert(sendRes.ok, `sendToSession failed: ${sendRes.error}`);
  await Promise.race([
    donePromise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('Stream timeout (60s)')), 60_000)),
  ]);
  dispatcher._testEmitHook = origEmit;
  const errors = events.filter((e) => e.kind === 'error').map((e) => e.error);
  const text = events
    .filter((e) => e.kind === 'delta' && e.text)
    .map((e) => e.text)
    .join('');
  return { sendRes, events, errors, text };
}

function createHookedDispatcher(registry, store) {
  const holder = { ref: null };
  const dispatcher = new HarnessDispatcher(
    registry,
    store,
    (ev) => {
      if (holder.ref && holder.ref._testEmitHook) holder.ref._testEmitHook(ev);
    },
    () => {}
  );
  holder.ref = dispatcher;
  return dispatcher;
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'super-harness-e2e-'));
const tmpImg = path.join(tmpDir, 'test-pixel.png');
fs.writeFileSync(tmpImg, Buffer.from(PNG_1X1_B64, 'base64'));
const testAttachment = {
  id: 'e2e-img-1',
  name: 'test-pixel.png',
  path: tmpImg,
  mimeType: 'image/png',
};

const cleanupTasks = [];

async function main() {
  const store = makeTempStore(tmpDir);
  const registry = new HarnessRegistry(store);
  const dispatcher = createHookedDispatcher(registry, store);
  cleanupTasks.push(() => dispatcher.shutdown());

  // 1. Discovery & subagent nesting
  await runTest('1. Multi-harness discovery, native sections & subagent nesting', async () => {
    const { harnesses, sessions } = await registry.discover();
    const byId = Object.fromEntries(harnesses.map((h) => [h.id, h]));
    assert(byId.codex?.installed, 'Codex should be detected');
    assert(byId.claude?.installed, 'Claude should be detected');
    assert(byId.antigravity?.installed, 'Antigravity should be detected');
    assert(sessions.length > 5, `Expected >5 sessions, got ${sessions.length}`);
    const agyTop = sessions.filter((s) => s.harness === 'antigravity' && !s.isSubagent);
    assert(agyTop.length > 0, 'Expected top-level Antigravity sessions');
    return `${sessions.length} sessions across 3 harnesses`;
  });

  // 2. Codex full round-trip
  await runTest('2. Codex: create -> resume text -> resume w/ image -> transcript -> archive', async () => {
    const codexBin = await resolveCodexBinary();
    assert(codexBin, 'Codex binary not found');
    const out = execFileSync(
      codexBin,
      ['exec', '--remote', 'unix://', '--skip-git-repo-check', '--json', 'Reply with ONLY the word CODEX_READY'],
      { encoding: 'utf8', timeout: 45_000 }
    );
    const started = out.split('\n').find((l) => l.includes('thread.started'));
    assert(started, 'Missing thread.started event from codex exec');
    const threadId = JSON.parse(started).thread_id;
    cleanupTasks.push(() => {
      try {
        execFileSync(codexBin, ['archive', threadId], { stdio: 'ignore', timeout: 5000 });
      } catch {}
    });

    await registry.discover();
    const sid = `codex:${threadId}`;
    assert(registry.getSession(sid), `Codex session ${sid} not discovered`);

    const r1 = await dispatchAndCollect(dispatcher, sid, 'Reply with ONLY the word CODEX_TEXT_OK');
    assert(r1.errors.length === 0, `Codex text resume errors: ${r1.errors.join('; ')}`);
    assert(r1.text.includes('CODEX_TEXT_OK'), `Unexpected Codex text reply: ${r1.text}`);

    const r2 = await dispatchAndCollect(
      dispatcher,
      sid,
      'Do not run tools. Reply with ONLY the word CODEX_IMG_OK',
      [testAttachment]
    );
    assert(r2.errors.length === 0, `Codex image resume errors: ${r2.errors.join('; ')}`);
    assert(r2.text.includes('CODEX_IMG_OK'), `Unexpected Codex image reply: ${r2.text}`);

    const tr = await registry.getTranscript(sid, 20);
    assert(tr.messages.length >= 4, `Expected >=4 transcript messages, got ${tr.messages.length}`);

    const arch = await dispatcher.archiveSession(sid);
    assert(arch.ok && arch.method === 'codex archive', `Archive failed: ${JSON.stringify(arch)}`);
    return `thread=${threadId.slice(0, 8)}, ${tr.messages.length} msgs, archived natively`;
  });

  // 3. Antigravity ACP bidirectional read+write (CLI + Desktop store verification!)
  await runTest('3. Antigravity ACP: create -> resume text -> resume w/ native image -> Desktop ACP verify', async () => {
    const out = execFileSync(
      'agy',
      ['--output-format', 'stream-json', '--print', 'Reply with ONLY the word AGY_READY'],
      { cwd: tmpDir, encoding: 'utf8', timeout: 45_000 }
    );
    const initLine = out.split('\n').find((l) => l.includes('"event":"init"'));
    assert(initLine, `Missing init event from agy: ${out.slice(0, 300)}`);
    const convId = JSON.parse(initLine).conversation_id;
    assert(convId, 'Missing conversation_id from agy init');

    cleanupTasks.push(() => {
      const cliBrain = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain', convId);
      try {
        fs.rmSync(cliBrain, { recursive: true, force: true });
      } catch {}
    });

    await registry.discover();
    const sid = `antigravity:${convId}`;
    const sess = registry.getSession(sid);
    assert(sess, `Antigravity CLI session ${sid} not discovered`);

    const r1 = await dispatchAndCollect(dispatcher, sid, 'Reply with ONLY the word AGY_ACP_TEXT_OK');
    assert(r1.errors.length === 0, `AGY ACP text resume errors: ${r1.errors.join('; ')}`);
    assert(r1.text.includes('AGY_ACP_TEXT_OK'), `Unexpected AGY ACP text reply: ${r1.text}`);

    const r2 = await dispatchAndCollect(
      dispatcher,
      sid,
      'Do not call any tools. Reply with ONLY the word AGY_ACP_IMG_OK',
      [testAttachment]
    );
    assert(r2.errors.length === 0, `AGY ACP image resume errors: ${r2.errors.join('; ')}`);
    assert(r2.text.includes('AGY_ACP_IMG_OK'), `Unexpected AGY ACP image reply: ${r2.text}`);

    const tr = await registry.getTranscript(sid, 20);
    assert(tr.messages.length >= 4, `Expected >=4 AGY messages, got ${tr.messages.length}`);

    // Verify Antigravity Desktop ACP (`--app-data-dir antigravity`) can directly resume a Desktop session too!
    const desktopSessions = (await registry.discover()).sessions.filter(
      (s) => s.harness === 'antigravity' && s.originApp === 'antigravity-app' && !s.isSubagent
    );
    assert(desktopSessions.length > 0, 'Expected at least one Antigravity Desktop session');
    const acpDesktopOk = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Desktop ACP timeout')), 10_000);
      const child = spawn('agy', ['acp', '--app-data-dir', 'antigravity'], { stdio: ['pipe', 'pipe', 'pipe'] });
      let b = '';
      const send = (o) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n');
      child.stdout.on('data', (d) => {
        b += d.toString('utf8');
        const lines = b.split('\n'); b = lines.pop() || '';
        for (const l of lines) {
          if (!l.trim()) continue;
          const m = JSON.parse(l);
          if (m.id === 1) {
            send({ id: 2, method: 'session/resume', params: { sessionId: desktopSessions[0].nativeId, cwd: desktopSessions[0].cwd, mcpServers: [] } });
          } else if (m.id === 2) {
            clearTimeout(timer);
            child.kill();
            resolve(Boolean(m.result?.sessionId));
          }
        }
      });
      send({ id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } });
    });
    assert(acpDesktopOk, 'Desktop ACP session/resume failed');

    return `cli ACP text+image + Desktop ACP resume verified`;
  });

  // 4. Claude CLI full round-trip
  await runTest('4. Claude CLI: create -> resume text + image -> transcript -> cleanup', async () => {
    const out = execFileSync(
      'claude',
      ['-p', 'Reply with ONLY the word CLAUDE_READY', '--output-format', 'stream-json', '--verbose', '--max-turns', '1'],
      { cwd: tmpDir, encoding: 'utf8', timeout: 45_000 }
    );
    const resultLine = out
      .split('\n')
      .reverse()
      .find((l) => l.includes('"type":"result"'));
    assert(resultLine, 'Missing result event from claude CLI');
    const claudeId = JSON.parse(resultLine).session_id;
    assert(claudeId, 'Missing session_id from claude CLI');

    const encDir = tmpDir.replace(/[^a-zA-Z0-9]/g, '-');
    const projDir = path.join(os.homedir(), '.claude', 'projects', encDir);
    cleanupTasks.push(() => {
      try {
        fs.rmSync(projDir, { recursive: true, force: true });
      } catch {}
    });

    await registry.discover();
    const sid = `claude-cli:${claudeId}`;
    assert(registry.getSession(sid), `Claude CLI session ${sid} not discovered`);

    const r1 = await dispatchAndCollect(
      dispatcher,
      sid,
      'Do not call tools. Reply with ONLY the word CLAUDE_RESUME_OK',
      [testAttachment]
    );
    assert(r1.errors.length === 0, `Claude resume errors: ${r1.errors.join('; ')}`);
    assert(r1.text.includes('CLAUDE_RESUME_OK'), `Unexpected Claude reply: ${r1.text}`);

    const tr = await registry.getTranscript(sid, 20);
    assert(tr.messages.length >= 2, `Expected >=2 Claude transcript messages, got ${tr.messages.length}`);
    return `session=${claudeId.slice(0, 8)}, ${tr.messages.length} msgs`;
  });

  // 5. tmux mirror + send-keys + killTmux archive
  await runTest('5. tmux: spawn -> capture-pane -> send-keys -> verify output -> kill & archive', async () => {
    const sessName = `sh-e2e-${Date.now().toString(36)}`;
    execFileSync('tmux', ['new-session', '-d', '-s', sessName, '-c', tmpDir, 'sh'], { timeout: 5000 });
    cleanupTasks.push(() => {
      try {
        execFileSync('tmux', ['kill-session', '-t', sessName], { stdio: 'ignore', timeout: 3000 });
      } catch {}
    });

    // Inject synthetic tmux session into registry map for direct dispatcher test
    const fakeId = `claude-tmux:${sessName}`;
    registry.sessionMap.set(fakeId, {
      id: fakeId,
      nativeId: sessName,
      harness: 'claude-tmux',
      harnessGroup: 'claude',
      title: sessName,
      preview: 'tmux e2e',
      cwd: tmpDir,
      projectName: 'e2e',
      status: 'running',
      isLive: true,
      isRemote: false,
      tmuxTarget: `${sessName}:0.0`,
      tmuxSessionName: sessName,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      pinned: false,
      folderId: null,
      tags: ['tmux'],
      hidden: false,
      dispatchMode: 'tmux-send',
    });

    const marker = `SH_TMUX_OK_${Date.now()}`;
    const sendRes = await dispatcher.sendToSession(fakeId, `echo ${marker}`);
    assert(sendRes.ok, `tmux send failed: ${sendRes.error}`);
    await new Promise((r) => setTimeout(r, 400));

    const cap = await registry.captureTmux(`${sessName}:0.0`);
    assert(!cap.error, `captureTmux failed: ${cap.error}`);
    assert(cap.content.includes(marker), `Marker ${marker} not found in tmux capture`);

    const arch = await dispatcher.archiveSession(fakeId, { killTmux: true });
    assert(arch.ok, `tmux kill & archive failed: ${arch.error}`);
    let stillAlive = true;
    try {
      execFileSync('tmux', ['has-session', '-t', sessName], { stdio: 'ignore' });
    } catch {
      stillAlive = false;
    }
    assert(!stillAlive, 'tmux session should have been killed by archiveSession({ killTmux: true })');
    return `target=${sessName}:0.0, verified send-keys + capture + kill`;
  });

  // 6. LiveSyncService inotify push latency
  await runTest('6. LiveSyncService: inotify real-time push latency (<300ms)', async () => {
    const trFile = path.join(tmpDir, 'live-transcript.jsonl');
    fs.writeFileSync(trFile, '{"type":"USER_INPUT","step_index":0,"content":"start"}\n');
    const fakeReg = {
      getSession: () => ({
        id: 'antigravity:live-test',
        nativeId: 'live-test',
        harness: 'antigravity',
        transcriptPath: trFile,
      }),
      discover: async () => ({ harnesses: [], sessions: [] }),
      getTranscript: async () => ({
        sessionId: 'antigravity:live-test',
        messages: [],
        totalCount: fs.readFileSync(trFile, 'utf8').trim().split('\n').length,
        hasMore: false,
        sourceMtimeMs: Date.now(),
      }),
    };

    let tWrite = 0;
    const pushed = await new Promise(async (resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('inotify push timed out')), 3000);
      const sync = new LiveSyncService(fakeReg, () => {}, (res) => {
        const latency = Date.now() - tWrite;
        clearTimeout(timer);
        sync.stop();
        resolve({ latency, totalCount: res.totalCount });
      });
      sync.start();
      await sync.watchPane('primary', 'antigravity:live-test', 60);
      tWrite = Date.now();
      fs.appendFileSync(trFile, '{"type":"PLANNER_RESPONSE","step_index":1,"content":"live!"}\n');
    });

    assert(pushed.latency < 300, `Expected push <300ms, got ${pushed.latency}ms`);
    assert(pushed.totalCount === 2, `Expected 2 lines, got ${pushed.totalCount}`);
    return `push latency=${pushed.latency}ms`;
  });

  // 7. ControlServer + MCP stdio + SSE /api/events
  await runTest('7. ControlServer + super-harness-mcp stdio JSON-RPC + SSE /api/events', async () => {
    const ctl = new ControlServer(store, registry, dispatcher, async () => {});
    const port = await ctl.start();
    try {
      // Verify MCP stdio
      const mcpRes = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('MCP timeout')), 8000);
        const child = spawn(process.execPath, [path.resolve('dist/main/mcp/server.js')], {
          env: {
            ...process.env,
            SUPER_HARNESS_URL: `http://127.0.0.1:${port}`,
            SUPER_HARNESS_TOKEN: ctl.token,
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let buf = '';
        child.stdout.on('data', (d) => {
          buf += d.toString('utf8');
          const lines = buf.trim().split('\n');
          if (lines.length >= 3) {
            clearTimeout(timer);
            child.kill();
            resolve(lines.map((l) => JSON.parse(l)));
          }
        });
        child.on('error', reject);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'sh_list_harnesses', arguments: {} } }) + '\n');
      });

      assert(mcpRes[1].result.tools.length === 8, `Expected 8 MCP tools, got ${mcpRes[1].result.tools.length}`);
      const hList = JSON.parse(mcpRes[2].result.content[0].text).harnesses;
      assert(hList.length === 3, `Expected 3 harnesses from MCP tool`);

      // Verify SSE /api/events live push
      const sseController = new AbortController();
      const ssePromise = fetch(`http://127.0.0.1:${port}/api/events`, {
        headers: { Authorization: `Bearer ${ctl.token}` },
        signal: sseController.signal,
      }).then(async (res) => {
        assert(res.status === 200, `SSE status ${res.status}`);
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let acc = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          acc += dec.decode(value, { stream: true });
          if (acc.includes('transcript_updated')) {
            sseController.abort();
            return acc;
          }
        }
        return acc;
      });

      setTimeout(() => ctl.broadcastEvent('transcript_updated', { sessionId: 'test:1' }), 100);
      const sseOut = await ssePromise;
      assert(sseOut.includes('transcript_updated'), 'SSE did not receive transcript_updated event');
      return `8 MCP tools + SSE live stream verified on port ${port}`;
    } finally {
      ctl.close();
    }
  });
}

main()
  .finally(() => {
    for (const fn of cleanupTasks.reverse()) {
      try {
        fn();
      } catch {}
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  })
  .then(() => {
    const passed = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\n========================================`);
    console.log(`E2E SUMMARY: ${passed}/${results.length} passed, ${failed} failed`);
    console.log(`========================================`);
    process.exit(failed > 0 ? 1 : 0);
  });
