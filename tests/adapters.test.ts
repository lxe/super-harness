import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  loadAntigravityTranscript,
  parseAntigravityJsonlLines,
} from '../src/main/adapters/antigravityAdapter';
import {
  createClaudeDriver,
  loadClaudeTranscript,
  parseClaudeJsonlLines,
} from '../src/main/adapters/claudeAdapter';
import {
  getCodexTranscriptFingerprint,
  loadCodexTranscriptFromPaths,
} from '../src/main/adapters/codexAdapter';
import { closeSqlitePool } from '../src/main/utils/sqlite';
import {
  inferWeeklyResetFromSamples,
  parseAntigravityCliUsageJson,
} from '../src/main/services/usageService';
import {
  computeWindowPace,
  pickHeroWindow,
} from '../src/renderer/components/HarnessUsageHoverCard';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-adapters-test-'));

afterAll(() => {
  closeSqlitePool();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('Claude transcript parsing & tail parity', () => {
  it('parses tool calls, AskUserQuestion answers, local commands, queue ops, and unique IDs', () => {
    const lines = [
      // Telemetry noise skipped by pre-filter
      JSON.stringify({ type: 'api-request-blob', blob: 'x'.repeat(500) }),
      JSON.stringify({ type: 'file-history-snapshot', files: [] }),
      // Local command caveat (hidden) + /effort command + stdout (coalesced into system notice)
      JSON.stringify({
        type: 'user',
        uuid: 'u-cav',
        timestamp: 1000,
        message: { role: 'user', content: '<local-command-caveat>caveat</local-command-caveat>' },
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'u-cmd',
        timestamp: 1001,
        message: {
          role: 'user',
          content: '<command-name>/effort</command-name><command-args>medium</command-args>',
        },
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'u-out',
        timestamp: 1002,
        message: {
          role: 'user',
          content: '<local-command-stdout>Effort set to medium</local-command-stdout>',
        },
      }),
      // Human prompt
      JSON.stringify({
        type: 'user',
        uuid: 'dup-id',
        timestamp: 1010,
        message: { role: 'user', content: 'Run ls and ask me a question' },
      }),
      // Assistant runs Bash + AskUserQuestion
      JSON.stringify({
        type: 'assistant',
        uuid: 'dup-id',
        timestamp: 1020,
        message: {
          role: 'assistant',
          model: 'claude-opus-4',
          content: [
            { type: 'thinking', thinking: 'Checking directory' },
            { type: 'tool_use', id: 'tu-1', name: 'Bash', input: { command: 'ls -la' } },
            {
              type: 'tool_use',
              id: 'tu-q1',
              name: 'AskUserQuestion',
              input: {
                questions: [{ question: 'Pick a color?', options: [{ label: 'Blue' }, { label: 'Green' }] }],
              },
            },
          ],
        },
      }),
      // Tool results (Bash output + answered question)
      JSON.stringify({
        type: 'user',
        uuid: 'u-tr',
        timestamp: 1030,
        message: {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu-1', content: 'file1.ts\nfile2.ts' },
            {
              type: 'tool_result',
              tool_use_id: 'tu-q1',
              content: 'User has answered your questions: "Pick a color?"="Blue"',
            },
          ],
        },
      }),
      // Final assistant text coalesced into same assistant turn
      JSON.stringify({
        type: 'assistant',
        uuid: 'a-final',
        timestamp: 1040,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Great, going with Blue!' }] },
      }),
      // Queue operations: enqueue 2, dequeue 1 -> 1 remaining
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: 'First queued', timestamp: 1050 }),
      JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: 'Second queued', timestamp: 1051 }),
      JSON.stringify({ type: 'queue-operation', operation: 'dequeue', timestamp: 1052 }),
    ];

    const res = parseClaudeJsonlLines(lines, 'claude-desktop:test', 2000, 60);
    // 1 system notice + 1 user + 1 coalesced assistant
    expect(res.messages).toHaveLength(3);
    // Unique IDs even with duplicate uuid
    const ids = res.messages.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);

    expect(res.messages[0].role).toBe('system');
    expect(res.messages[0].blocks[0]).toMatchObject({
      type: 'notice',
      title: '/effort medium',
      detail: 'Effort set to medium',
    });

    const assistant = res.messages[2];
    expect(assistant.role).toBe('assistant');
    const cmd = assistant.blocks.find((b) => b.type === 'command');
    expect(cmd).toMatchObject({ command: 'ls -la', output: 'file1.ts\nfile2.ts', status: 'completed' });

    const q = assistant.blocks.find((b) => b.type === 'question');
    expect(q).toBeDefined();
    if (q?.type === 'question') {
      expect(q.answered).toBe(true);
      expect(q.questions[0].answer).toBe('Blue');
    }

    expect(res.liveActivity?.queuedMessages).toHaveLength(1);
    expect(res.liveActivity?.queuedMessages?.[0].text).toBe('Second queued');
  });

  it('matches tail messages identically on multi-MB truncated Claude JSONL', async () => {
    const file = path.join(tmpDir, 'claude-large.jsonl');
    const allLines: string[] = [];
    for (let i = 0; i < 180; i++) {
      // Interleave realistic noise lines so file exceeds initial 768KB window
      allLines.push(JSON.stringify({ type: 'api-request-blob', seq: i, data: 'N'.repeat(12_000) }));
      allLines.push(
        JSON.stringify({
          type: 'user',
          uuid: `u-${i}`,
          timestamp: 10_000 + i * 2,
          message: { role: 'user', content: `User prompt #${i}` },
        })
      );
      allLines.push(
        JSON.stringify({
          type: 'assistant',
          uuid: `a-${i}`,
          timestamp: 10_001 + i * 2,
          message: { role: 'assistant', content: [{ type: 'text', text: `Assistant reply #${i}` }] },
        })
      );
    }
    fs.writeFileSync(file, allLines.join('\n') + '\n', 'utf8');

    const full = parseClaudeJsonlLines(allLines, 'claude-cli:large', Date.now(), 20);
    const tail = await loadClaudeTranscript('claude-cli:large', 'large', file, tmpDir, 20);

    expect(tail.messages).toHaveLength(20);
    expect(tail.hasMore).toBe(true);
    expect(tail.totalCount).toBeGreaterThan(20);
    expect(tail.messages.map((m) => m.id)).toEqual(full.messages.map((m) => m.id));
    expect(tail.messages.map((m) => m.blocks)).toEqual(full.messages.map((m) => m.blocks));
  });

  it('forwards valid session permissionMode to claude --resume in sendMessage', async () => {
    const driver = createClaudeDriver();
    const spawned: Array<{ args: string[] }> = [];
    const ctx = {
      spawnStreaming: (opts: { args: string[] }) => {
        spawned.push({ args: opts.args });
      },
      emitStream: () => {},
      triggerRefresh: () => {},
    };

    const res = await driver.sendMessage(
      {
        id: 'claude:abc-123',
        nativeId: 'abc-123',
        harness: 'claude-desktop',
        harnessGroup: 'claude',
        title: 'Test Desktop',
        preview: 'Test',
        cwd: tmpDir,
        projectName: 'tmp',
        status: 'idle',
        isLive: false,
        isRemote: false,
        createdAt: 1,
        updatedAt: 2,
        pinned: false,
        tags: ['desktop'],
        hidden: false,
        dispatchMode: 'claude-resume',
        permissionMode: 'bypassPermissions',
      },
      'Hello Claude',
      undefined,
      ctx
    );

    if (res.ok) {
      expect(spawned).toHaveLength(1);
      expect(spawned[0].args).toContain('--permission-mode');
      expect(spawned[0].args).toContain('bypassPermissions');
      expect(spawned[0].args).toContain('--resume');
      expect(spawned[0].args).toContain('abc-123');
    }
  });
});

describe('Antigravity transcript parsing & tail parity', () => {
  it('deduplicates repeated step_index IDs, pairs command outputs, and marks ask_question answered', () => {
    const lines = [
      JSON.stringify({
        step_index: 10,
        type: 'USER_INPUT',
        created_at: 1000,
        content: '<USER_REQUEST>\nBuild a fast cache\n</USER_REQUEST>',
      }),
      JSON.stringify({
        step_index: 11,
        type: 'PLANNER_RESPONSE',
        created_at: 1010,
        thinking: 'Let me check files',
        tool_calls: [
          { name: 'update_focus', args: { focus: 'Checking cache' } },
          {
            name: 'update_steps',
            args: { steps: [{ title: 'Build cache', status: 'in_progress' }] },
          },
          { name: 'run_command', args: { CommandLine: 'npm test' } },
          {
            name: 'ask_question',
            args: {
              questions: [
                { question: 'Cache size?', options: ['32', '64'] },
                { question: 'Enable prefetch?', options: ['Yes', 'No'] },
              ],
            },
          },
        ],
      }),
      JSON.stringify({
        step_index: 12,
        type: 'GENERIC',
        created_at: 1020,
        content: 'Created At: 2026-11-25\nA1: 64\nA2: Yes',
      }),
      JSON.stringify({
        step_index: 13,
        type: 'GENERIC',
        created_at: 1025,
        content: 'All 12 tests passed',
      }),
      // Duplicate step_index on next user/assistant turn (regression for unexpandable trace groups)
      JSON.stringify({
        step_index: 10,
        type: 'USER_INPUT',
        created_at: 1030,
        content: 'Looks great!',
      }),
      JSON.stringify({
        step_index: 11,
        type: 'PLANNER_RESPONSE',
        created_at: 1040,
        content: 'Done!',
      }),
    ];

    const res = parseAntigravityJsonlLines(lines, 'antigravity:test', Date.now(), 60);
    expect(res.messages).toHaveLength(4);
    const ids = res.messages.map((m) => m.id);
    expect(new Set(ids).size).toBe(4);

    const firstAssistant = res.messages[1];
    const qBlock = firstAssistant.blocks.find((b) => b.type === 'question');
    expect(qBlock?.type).toBe('question');
    if (qBlock?.type === 'question') {
      expect(qBlock.answered).toBe(true);
      expect(qBlock.questions[0].answer).toBe('64');
      expect(qBlock.questions[1].answer).toBe('Yes');
    }
    // New USER_INPUT clears stale focus & steps from the earlier turn
    expect(res.liveActivity?.steps).toBeUndefined();
    expect(res.liveActivity?.focus).toBeUndefined();
    expect(res.liveActivity?.isWorking).toBe(false);

    // Within an active turn (before the next USER_INPUT), focus & steps are preserved
    const activeTurn = parseAntigravityJsonlLines(lines.slice(0, 4), 'antigravity:active', Date.now(), 60);
    expect(activeTurn.liveActivity?.steps?.[0]).toEqual({ title: 'Build cache', status: 'in_progress' });
    expect(activeTurn.liveActivity?.focus).toBe('Checking cache');
    expect(activeTurn.liveActivity?.isWorking).toBe(true);
  });

  it('loads multi-MB Antigravity transcript via progressive tail reader', async () => {
    const file = path.join(tmpDir, 'agy-large.jsonl');
    const lines: string[] = [];
    for (let i = 0; i < 120; i++) {
      lines.push(
        JSON.stringify({
          step_index: i * 2,
          type: 'USER_INPUT',
          created_at: 1000 + i * 2,
          content: `<USER_REQUEST>Question ${i}</USER_REQUEST>`,
        })
      );
      lines.push(
        JSON.stringify({
          step_index: i * 2 + 1,
          type: 'PLANNER_RESPONSE',
          created_at: 1001 + i * 2,
          thinking: 'T'.repeat(6000),
          content: `Answer ${i}`,
        })
      );
    }
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');

    const tail = await loadAntigravityTranscript('large', file, 16);
    expect(tail.messages).toHaveLength(16);
    expect(tail.hasMore).toBe(true);
    const lastBlock = tail.messages[15].blocks.find((b) => b.type === 'text');
    expect(lastBlock).toEqual({ type: 'text', text: 'Answer 119' });
  });

  it('tracks Antigravity running background tasks accurately across CHECKPOINT, start, finish, and kill', () => {
    const lines = [
      // Pre-checkpoint task that should be cleared by CHECKPOINT snapshot
      JSON.stringify({
        step_index: 5,
        type: 'GENERIC',
        status: 'RUNNING',
        created_at: 1000,
        content: 'Tool is running as a background task with task id: conv-1/task-5',
      }),
      // Checkpoint resets active task map to task-10 + task-11
      JSON.stringify({
        step_index: 50,
        type: 'CHECKPOINT',
        created_at: 2000,
        content: `# Running Background Tasks\n{\n  "taskId": "conv-1/task-10",\n  "toolName": "run_command",\n  "toolSummary": "Start Storybook",\n  "description": "npm run storybook",\n  "logUri": "file:///tmp/task-10.log",\n  "isDaemon": true\n}\n{\n  "taskId": "conv-1/task-11",\n  "toolName": "run_command",\n  "toolSummary": "Old electron",\n  "description": "node launch.mjs",\n  "logUri": "file:///tmp/task-11.log",\n  "isDaemon": true\n}`,
      }),
      // New task started after checkpoint
      JSON.stringify({
        step_index: 60,
        type: 'PLANNER_RESPONSE',
        created_at: 3000,
        tool_calls: [
          {
            name: 'run_command',
            args: {
              toolSummary: 'Launch Electron',
              CommandLine: 'node scripts/launch-electron.mjs .',
              IsDaemon: true,
            },
          },
        ],
      }),
      JSON.stringify({
        step_index: 61,
        type: 'GENERIC',
        status: 'RUNNING',
        created_at: 3001,
        content:
          'Tool is running as a background task with task id: conv-1/task-61\nTask logs are available at: file:///tmp/task-61.log',
      }),
      // Old task-11 finishes
      JSON.stringify({
        step_index: 62,
        type: 'SYSTEM_MESSAGE',
        created_at: 3005,
        content: '<SYSTEM_MESSAGE>Task id "conv-1/task-11" finished with result: exit 0</SYSTEM_MESSAGE>',
      }),
    ];

    const res = parseAntigravityJsonlLines(lines, 'antigravity:conv-1', Date.now(), 40);
    expect(res.liveActivity?.runningTasks).toHaveLength(2);
    expect(res.liveActivity?.runningTasks?.map((t) => t.id)).toEqual([
      'conv-1/task-10',
      'conv-1/task-61',
    ]);
    expect(res.liveActivity?.runningTasks?.[0]).toMatchObject({
      summary: 'Start Storybook',
      logPath: '/tmp/task-10.log',
      isDaemon: true,
    });
    expect(res.liveActivity?.runningTasks?.[1]).toMatchObject({
      summary: 'Launch Electron',
      logPath: '/tmp/task-61.log',
      isDaemon: true,
    });
  });

  it('parses live Antigravity quota and credits from agy -p /usage and /credits JSON', () => {
    const usageJson = JSON.stringify({
      status: 'SUCCESS',
      command: {
        name: 'usage',
        data: {
          groups: [
            {
              name: 'Gemini Models',
              buckets: [
                {
                  id: 'gemini-weekly',
                  window: 'weekly',
                  remaining_fraction: 0.94,
                  reset_time: '2026-12-02T20:26:40Z',
                },
                {
                  id: 'gemini-5h',
                  window: '5h',
                  remaining_fraction: 0.77,
                  reset_time: '2026-11-26T01:26:40Z',
                },
              ],
            },
            {
              name: 'Claude and GPT models',
              buckets: [
                {
                  id: '3p-weekly',
                  window: 'weekly',
                  remaining_fraction: 1,
                  reset_time: '1970-01-01T00:00:00Z',
                },
                {
                  id: '3p-5h',
                  window: '5h',
                  remaining_fraction: 1,
                  reset_time: '1970-01-01T00:00:00Z',
                },
              ],
            },
          ],
        },
      },
    });
    const creditsJson = JSON.stringify({
      status: 'SUCCESS',
      command: { name: 'credits', data: { remaining_credits: 250 } },
    });

    const parsed = parseAntigravityCliUsageJson(usageJson, creditsJson);
    expect(parsed.creditsBalance).toBe(250);
    expect(parsed.windows).toHaveLength(4);
    expect(parsed.windows[0]).toMatchObject({
      id: 'five_hour',
      label: 'Gemini · 5h limit',
      usedPercent: 23,
    });
    expect(parsed.windows[0].resetsAt).toBe(Date.parse('2026-11-26T01:26:40Z'));
    expect(parsed.windows[1]).toMatchObject({
      id: 'weekly',
      label: 'Gemini · Weekly',
      usedPercent: 6,
    });
    // Epoch-zero reset timestamps should be omitted cleanly
    expect(parsed.windows[2].resetsAt).toBeUndefined();
    expect(parsed.windows[2].usedPercent).toBe(0);
  });
});

describe('Codex SQLite paginated loading & fingerprinting', () => {
  it('queries indexed tail rows in DESC order, reverses to ASC, reads native queue, and updates fingerprint', async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { DatabaseSync } = require('node:sqlite') as {
      DatabaseSync: new (p: string) => { exec: (s: string) => void; prepare: (s: string) => { run: (...a: unknown[]) => void }; close: () => void };
    };

    const historyDb = path.join(tmpDir, 'thread_history_1.sqlite');
    const queueDb = path.join(tmpDir, 'queue_1.sqlite');

    const hdb = new DatabaseSync(historyDb);
    hdb.exec(`
      CREATE TABLE thread_items (
        thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        rollout_ordinal INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        item_json TEXT NOT NULL,
        item_type TEXT NOT NULL DEFAULT ''
      );
      CREATE UNIQUE INDEX idx_thread_items_page ON thread_items(thread_id, rollout_ordinal);
      BEGIN;
    `);

    const insertItem = hdb.prepare(
      'INSERT INTO thread_items (thread_id, turn_id, item_id, rollout_ordinal, created_at_ms, item_json, item_type) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    let ordinal = 1;
    for (let t = 0; t < 150; t++) {
      const turnId = `turn-${t}`;
      insertItem.run(
        'thr-1',
        turnId,
        `u-${t}`,
        ordinal++,
        10000 + t * 10,
        JSON.stringify({ content: [{ text: `Codex user ${t}` }] }),
        'userMessage'
      );
      insertItem.run(
        'thr-1',
        turnId,
        `r-${t}`,
        ordinal++,
        10001 + t * 10,
        JSON.stringify({ summary: [`Thinking ${t}`] }),
        'reasoning'
      );
      insertItem.run(
        'thr-1',
        turnId,
        `a-${t}`,
        ordinal++,
        10002 + t * 10,
        JSON.stringify({ text: `Codex reply ${t}` }),
        'agentMessage'
      );
    }
    hdb.exec('COMMIT;');
    hdb.close();

    const qdb = new DatabaseSync(queueDb);
    qdb.exec(`
      CREATE TABLE queued_items (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        queue_order INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      );
    `);
    qdb
      .prepare('INSERT INTO queued_items VALUES (?, ?, ?, ?, ?)')
      .run('q1', 'thr-1', 1, JSON.stringify({ text: 'Follow up after tests' }), 99999);
    qdb.close();

    const dbs = { historyDb, queueDb };
    const fp1 = await getCodexTranscriptFingerprint('thr-1', undefined, dbs);
    const res = await loadCodexTranscriptFromPaths('thr-1', undefined, 20, dbs);

    expect(res.messages).toHaveLength(20);
    expect(res.hasMore).toBe(true);
    expect(res.totalCount).toBeGreaterThan(20);
    // Verify chronological ASC ordering ending at turn 149
    expect(res.messages[18].role).toBe('user');
    expect(res.messages[18].blocks[0]).toEqual({ type: 'text', text: 'Codex user 149' });
    expect(res.messages[19].role).toBe('assistant');
    expect(res.messages[19].blocks).toHaveLength(2); // reasoning + agentMessage coalesced
    expect(res.messages[19].blocks[1]).toEqual({ type: 'text', text: 'Codex reply 149' });

    // Verify native queue item loaded
    expect(res.liveActivity?.queuedMessages).toHaveLength(1);
    expect(res.liveActivity?.queuedMessages?.[0].text).toBe('Follow up after tests');

    // Verify fingerprint invalidates when a new item is appended
    closeSqlitePool();
    const hdb2 = new DatabaseSync(historyDb);
    hdb2
      .prepare(
        'INSERT INTO thread_items (thread_id, turn_id, item_id, rollout_ordinal, created_at_ms, item_json, item_type) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        'thr-1',
        'turn-150',
        'u-150',
        ordinal++,
        999999,
        JSON.stringify({ content: [{ text: 'Brand new prompt' }] }),
        'userMessage'
      );
    hdb2.close();

    const fp2 = await getCodexTranscriptFingerprint('thr-1', undefined, dbs);
    expect(fp2).not.toBe(fp1);
  });

  it('infers Claude weekly reset timestamps and computes hero window + pace projection', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const resetT = 1795384800000;
    const now = resetT + 3 * DAY; // ~43% through the 7-day window

    const nextReset = inferWeeklyResetFromSamples(
      [
        { t: resetT - 60_000, u: { sd: 98 } },
        { t: resetT, u: { sd: 0 } },
        { t: now, u: { sd: 32 } },
      ],
      now
    );
    expect(nextReset).toBe(resetT + 7 * DAY);

    const { hero, secondary } = pickHeroWindow([
      { id: 'five_hour', label: '5-hour session', usedPercent: 0, windowMinutes: 300 },
      {
        id: 'weekly',
        label: 'Weekly limit',
        usedPercent: 32,
        resetsAt: nextReset,
        windowMinutes: 10080,
      },
      { id: 'extra', label: 'Extra usage', usedPercent: 45 },
    ]);
    // Extra usage is overflow, so Weekly limit (32%) wins as hero over 5-hour (0%)
    expect(hero?.id).toBe('weekly');
    expect(secondary.map((w) => w.id)).toEqual(['five_hour', 'extra']);

    const pace = computeWindowPace(hero!, now);
    expect(pace).not.toBeNull();
    expect(Math.round(pace!.elapsedPercent)).toBe(43);
    expect(pace!.projectedPercent).toBe(75);
    expect(pace!.windowWord).toBe('week');
  });
});
