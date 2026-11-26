import { describe, expect, it } from 'vitest';
import {
  buildMuseExecArgs,
  createMuseDriver,
  parseMuseExecStreamLine,
  parseMuseJsonlLines,
  parseMuseLiveSessionsJson,
  stripRuntimeInjectedText,
  unwrapMuseRecordLine,
} from '../src/main/adapters/museAdapter';
import { createDefaultDrivers } from '../src/main/adapters/index';
import { parseMuseModelsOutput } from '../src/main/services/catalogService';
import { parseMuseUsageOutput } from '../src/main/services/usageService';
import {
  filterSidebarSessions,
  groupSessionsForSidebar,
} from '../src/renderer/utils/sidebarGrouping';
import type { StreamEvent, UnifiedSession } from '../src/shared/types';

const US = 1795669080321460; // epoch microseconds, as Muse records them

function recordLine(payloadType: string, payload: Record<string, unknown>, seq = 1): string {
  return JSON.stringify({
    schema_version: 1,
    id: `rec-${seq}`,
    stream: { kind: 'session', id: 'sess-1' },
    sequence: seq,
    recorded_at: US + seq * 1000,
    record_type: 'event',
    durability: 'durable',
    causation_id: null,
    payload_type: payloadType,
    payload_schema_version: 1,
    payload,
  });
}

function userIntentLine(text: string, seq = 1): string {
  return recordLine(
    'runtime.user_intent.accepted',
    {
      intent_id: `intent-${seq}`,
      semantic_kind: { kind: 'chat' },
      surface: 'main',
      model_messages: [{ content: [{ kind: 'text', text }] }],
      refill_blocks: [{ kind: 'text', text }],
    },
    seq
  );
}

function runEventLine(event: Record<string, unknown>, seq = 2): string {
  return recordLine(
    'runtime.session',
    { kind: 'run', run_id: 'run-1', event },
    seq
  );
}

describe('Muse session.jsonl unwrapping', () => {
  it('unwraps retained_frame children and skips retained_marker tombstones', () => {
    const child = recordLine('runtime.session.metadata', { kind: 'metadata' }, 3);
    const frame = JSON.stringify({
      retained_frame: 'session_permission_transaction',
      frame_schema_version: 1,
      children: [{ child_index: 0, record_json: child }],
    });
    const unwrapped = unwrapMuseRecordLine(frame);
    expect(unwrapped).toHaveLength(1);
    expect(unwrapped[0].payload_type).toBe('runtime.session.metadata');

    const marker = JSON.stringify({
      retained_marker: 'omitted_live_only',
      schema_version: 1,
      stream: { kind: 'session', id: 'sess-1' },
    });
    expect(unwrapMuseRecordLine(marker)).toEqual([]);
    expect(unwrapMuseRecordLine('not json')).toEqual([]);
  });

  it('strips <system-reminder> envelopes from user text', () => {
    expect(
      stripRuntimeInjectedText(
        'Hello\n<system-reminder source="x">secret</system-reminder>\nworld'
      )
    ).toBe('Hello\n\nworld');
    expect(stripRuntimeInjectedText('<system-reminder>only</system-reminder>')).toBe('');
  });
});

describe('Muse transcript parsing', () => {
  it('coalesces user intent, thinking summary, text, bash tool call + result, todos, terminal', () => {
    const lines = [
      userIntentLine('Fix the bug please', 1),
      runEventLine(
        { kind: 'reasoning_summary_committed', text: 'Looking at the bug now.' },
        2
      ),
      runEventLine(
        { kind: 'reasoning_committed', text: '', encrypted_content: 'blob' },
        3
      ),
      runEventLine({ kind: 'assistant_message_committed', text: 'On it.', phase: 'commentary' }, 4),
      runEventLine(
        {
          kind: 'assistant_tool_calls_committed',
          message_id: 'msg-1',
          tool_calls: [
            {
              name: 'bash',
              call_id: 'call-1',
              args: JSON.stringify({ command: 'ls -la', description: 'List files' }),
            },
            {
              name: 'read_file',
              call_id: 'call-2',
              args: JSON.stringify({ path: 'src/index.ts' }),
            },
          ],
        },
        5
      ),
      runEventLine(
        {
          kind: 'tool_result_batch_committed',
          batch_id: 'msg-1',
          results: [
            {
              tool_call_id: 'call-1',
              tool_call_index: 0,
              text: JSON.stringify({
                exit_code: 0,
                terminal_status: 'completed',
                output: 'total 0\n',
              }),
            },
            { tool_call_id: 'call-2', tool_call_index: 1, text: 'file contents' },
          ],
        },
        6
      ),
      runEventLine(
        {
          kind: 'todo_snapshot_updated',
          items: [
            { text: 'Reproduce', status: 'completed' },
            { text: 'Fix it', status: 'in_progress' },
            { text: 'Ship', status: 'pending' },
          ],
        },
        7
      ),
      runEventLine({ kind: 'assistant_message_committed', text: 'Fixed.' }, 8),
      runEventLine({ kind: 'terminal', terminal: 'completed' }, 9),
    ];

    const res = parseMuseJsonlLines(lines, 'muse:sess-1', Date.now(), 120);
    expect(res.messages).toHaveLength(2);

    const [user, assistant] = res.messages;
    expect(user.role).toBe('user');
    expect(user.blocks).toEqual([{ type: 'text', text: 'Fix the bug please' }]);
    expect(user.timestamp).toBe(Math.floor((US + 1000) / 1000));

    expect(assistant.role).toBe('assistant');
    // Encrypted reasoning (empty text) is skipped; the summary renders once.
    const thinking = assistant.blocks.filter((b) => b.type === 'thinking');
    expect(thinking).toEqual([{ type: 'thinking', text: 'Looking at the bug now.' }]);

    const command = assistant.blocks.find((b) => b.type === 'command');
    expect(command).toMatchObject({
      type: 'command',
      command: 'ls -la',
      output: 'total 0\n',
      exitCode: 0,
      status: 'completed',
    });

    const toolCall = assistant.blocks.find((b) => b.type === 'tool_call');
    expect(toolCall).toMatchObject({
      type: 'tool_call',
      name: 'read_file',
      output: 'file contents',
      status: 'completed',
    });

    const texts = assistant.blocks.filter((b) => b.type === 'text');
    expect(texts.map((t) => (t as { text: string }).text)).toEqual(['On it.', 'Fixed.']);

    expect(res.liveActivity?.isWorking).toBe(false);
    expect(res.liveActivity?.steps).toEqual([
      { title: 'Reproduce', status: 'done' },
      { title: 'Fix it', status: 'in_progress' },
      { title: 'Ship', status: 'pending' },
    ]);
  });

  it('reports isWorking while a turn has no terminal record yet', () => {
    const lines = [
      userIntentLine('Long task', 1),
      runEventLine({ kind: 'assistant_message_committed', text: 'Working…' }, 2),
    ];
    const res = parseMuseJsonlLines(lines, 'muse:sess-1', Date.now(), 120);
    expect(res.liveActivity?.isWorking).toBe(true);
  });

  it('skips non-chat intents and reminder-only prompts', () => {
    const lines = [
      recordLine(
        'runtime.user_intent.accepted',
        {
          semantic_kind: { kind: 'scheduled_wake' },
          surface: 'main',
          model_messages: [{ content: [{ kind: 'text', text: 'wake up' }] }],
        },
        1
      ),
      userIntentLine('<system-reminder>background done</system-reminder>', 2),
      userIntentLine('Real prompt', 3),
    ];
    const res = parseMuseJsonlLines(lines, 'muse:sess-1', Date.now(), 120);
    expect(res.messages).toHaveLength(1);
    expect(res.messages[0].blocks).toEqual([{ type: 'text', text: 'Real prompt' }]);
  });

  it('maps request_user_input tool calls to question blocks', () => {
    const lines = [
      userIntentLine('Pick one', 1),
      runEventLine(
        {
          kind: 'assistant_tool_calls_committed',
          tool_calls: [
            {
              name: 'request_user_input',
              call_id: 'q-1',
              args: JSON.stringify({
                questions: [
                  {
                    question: 'Which theme?',
                    options: [{ label: 'Dark' }, { label: 'Light' }],
                    selection: { mode: 'single' },
                  },
                ],
              }),
            },
          ],
        },
        2
      ),
      runEventLine(
        {
          kind: 'tool_result_batch_committed',
          results: [
            {
              tool_call_id: 'q-1',
              text: JSON.stringify({ answers: [{ answer: 'Dark' }] }),
            },
          ],
        },
        3
      ),
    ];
    const res = parseMuseJsonlLines(lines, 'muse:sess-1', Date.now(), 120);
    const q = res.messages[1].blocks.find((b) => b.type === 'question');
    expect(q).toMatchObject({
      type: 'question',
      answered: true,
      questions: [{ question: 'Which theme?', options: ['Dark', 'Light'], answer: 'Dark' }],
    });
  });
});

describe('Muse exec dispatch primitives', () => {
  it('builds exec argv with session continuation, yolo, model, effort, and images', () => {
    const args = buildMuseExecArgs({
      nativeId: 'uuid-1',
      cwd: '/repo',
      prompt: 'hello',
      model: 'muse-wonder-1.0',
      reasoningEffort: 'HIGH',
      attachments: [
        { id: 'a', name: 'x.png', path: '/tmp/x.png', mimeType: 'image/png' },
      ],
    });
    expect(args).toEqual([
      'exec',
      '--json',
      '--session-id',
      'uuid-1',
      '--workspace',
      '/repo',
      '--yolo',
      '--model',
      'muse-wonder-1.0',
      '--reasoning-effort',
      'high',
      '--image',
      '/tmp/x.png',
      'hello',
    ]);
  });

  it('drops unknown reasoning effort values', () => {
    const args = buildMuseExecArgs({
      nativeId: 'uuid-1',
      cwd: '/repo',
      prompt: 'hi',
      reasoningEffort: 'ludicrous',
    });
    expect(args).not.toContain('--reasoning-effort');
  });

  it('streams run.output.delta and falls back to terminal text', () => {
    const events: StreamEvent[] = [];
    const emit = (ev: StreamEvent) => events.push(ev);
    const delta = JSON.stringify({
      payload_type: 'run.output.delta',
      payload: { kind: 'run_output_delta', text: 'partial ' },
    });
    expect(parseMuseExecStreamLine('muse:s', 'r1', delta, false, emit)).toBe(true);
    const terminal = JSON.stringify({
      payload_type: 'run.terminal.completed',
      payload: { kind: 'run_terminal', text: 'partial done' },
    });
    // Already streamed → terminal text must not duplicate.
    expect(parseMuseExecStreamLine('muse:s', 'r1', terminal, true, emit)).toBe(false);
    expect(parseMuseExecStreamLine('muse:s', 'r1', terminal, false, emit)).toBe(true);
    expect(parseMuseExecStreamLine('muse:s', 'r1', 'muse: notice', false, emit)).toBe(false);
    expect(events.map((e) => e.text)).toEqual(['partial ', 'partial done']);
  });

  it('parses `muse sessions --json` output', () => {
    const stdout = JSON.stringify({
      sessions: [
        {
          sessionId: 'abc',
          name: 'west-vega',
          workspaceLabel: 'super-harness',
          openedBy: 'tui',
          attachable: false,
        },
        { bad: true },
      ],
    });
    expect(parseMuseLiveSessionsJson(stdout)).toEqual([
      {
        sessionId: 'abc',
        name: 'west-vega',
        workspaceLabel: 'super-harness',
        attachable: false,
      },
    ]);
    expect(parseMuseLiveSessionsJson('nope')).toEqual([]);
  });
});

describe('Muse catalog & usage parsing', () => {
  it('parses `muse exec --list-models` output', () => {
    const models = parseMuseModelsOutput(
      'muse: local session messaging disabled\nmuse-wonder-1.0\nmuse-wonder-full-1.0\nmuse-wonder-1.0\n',
      'muse-wonder-full-1.0'
    );
    expect(models.map((m) => m.id)).toEqual(['muse-wonder-1.0', 'muse-wonder-full-1.0']);
    expect(models[1].isDefault).toBe(true);
    expect(models[0].reasoningLevels).toContain('ultra');
  });

  it('parses `muse usage` human output with reset horizons', () => {
    const now = 1_800_000_000_000;
    const { planLabel, windows } = parseMuseUsageOutput(
      'Tier: Muse Code Power Usage\nWindow: 1% used, resets in 4h 56m\nWeekly: 0% used, resets in 3d 18h\n',
      now
    );
    expect(planLabel).toBe('Muse Code Power Usage');
    expect(windows).toEqual([
      {
        id: 'five_hour',
        label: 'Window',
        usedPercent: 1,
        resetsAt: now + (4 * 60 + 56) * 60_000,
      },
      {
        id: 'weekly',
        label: 'Weekly (7d)',
        usedPercent: 0,
        resetsAt: now + (3 * 24 + 18) * 3600_000,
        windowMinutes: 10080,
      },
    ]);
  });
});

describe('Muse driver registration & sidebar integration', () => {
  it('registers the muse driver in the default driver set', () => {
    const drivers = createDefaultDrivers();
    expect(drivers.map((d) => d.id)).toContain('muse');
    const muse = createMuseDriver();
    expect(muse.displayName).toBe('Muse');
  });

  it('filters and groups muse sessions in the sidebar', () => {
    const session: UnifiedSession = {
      id: 'muse:abc',
      nativeId: 'abc',
      harness: 'muse',
      harnessGroup: 'muse',
      title: 'Hello',
      preview: 'Hello',
      cwd: '/repo',
      projectName: 'repo',
      nativeSection: 'repo',
      nativeSectionOrder: 10,
      status: 'idle',
      isLive: false,
      isRemote: false,
      createdAt: 1,
      updatedAt: 2,
      pinned: false,
      folderId: null,
      tags: [],
      hidden: false,
      dispatchMode: 'muse-exec',
    };
    expect(filterSidebarSessions([session], 'muse', '')).toHaveLength(1);
    expect(filterSidebarSessions([session], 'codex', '')).toHaveLength(0);

    const groups = groupSessionsForSidebar([session], 'native', [], 'all');
    expect(groups.map((g) => g.id)).toContain('harness:muse');
    const single = groupSessionsForSidebar([session], 'native', [], 'muse');
    expect(single[0]?.items).toEqual([session]);
  });
});
