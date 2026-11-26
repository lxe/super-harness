import { describe, expect, it } from 'vitest';
import {
  buildMuseResumeCommand,
  buildMuseTmuxSessionName,
  buildMuseUndeliverableError,
  classifyMuseHolderCmdline,
  createMuseDriver,
  extractMuseResumeFlags,
  parseMuseRegistryPid,
  parseMuseJsonlLines,
  museTranscriptIsWorking,
  parseMuseLiveSessionsJson,
  findTmuxPaneForPids,
  parseTmuxPaneList,
  resolveMuseSessionStatus,
  waitForMuseTranscriptDelivery,
  stripRuntimeInjectedText,
  unwrapMuseRecordLine,
} from '../src/main/adapters/museAdapter';
import { createDefaultDrivers } from '../src/main/adapters/index';
import { parseMuseModelsOutput } from '../src/main/services/catalogService';
import {
  appendMuseQuotaSample,
  computeMuseQuotaDelta24h,
  parseMuseUsageJson,
  parseMuseUsageOutput,
} from '../src/main/services/usageService';
import {
  filterSidebarSessions,
  groupSessionsForSidebar,
  isSingleHarnessFilter,
} from '../src/renderer/utils/sidebarGrouping';
import type { UnifiedSession } from '../src/shared/types';

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

describe('Muse MSP dispatch primitives', () => {
  it('parses live sessions including attachable flags for the MSP lanes', () => {
    const stdout = JSON.stringify({
      sessions: [
        {
          sessionId: 'live-tui',
          name: 'west-vega',
          workspaceLabel: 'super-harness',
          openedBy: 'tui',
          attachable: false,
        },
        { sessionId: 'hosted', name: 'east', openedBy: 'serve', attachable: true },
      ],
    });
    const parsed = parseMuseLiveSessionsJson(stdout);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].attachable).toBe(false);
    expect(parsed[1].attachable).toBe(true);
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
        windowMinutes: 300,
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

describe('Muse daemon control (no remote daemon exists)', () => {
  it('reports canControlDaemon=false in detection shape and fails cleanly', async () => {
    const driver = createMuseDriver();
    const ctx = {
      spawnStreaming: () => {},
      emitStream: () => {},
      triggerRefresh: () => {},
    };
    const res = await driver.controlDaemon('start_remote', ctx);
    expect(res.ok).toBe(false);
    expect(res.error).toBe('Muse has no remote daemon to start or stop.');
    expect(res.error).not.toContain('start_remote');
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
      dispatchMode: 'muse-msp',
    };
    expect(filterSidebarSessions([session], 'muse', '')).toHaveLength(1);
    expect(filterSidebarSessions([session], 'codex', '')).toHaveLength(0);

    const groups = groupSessionsForSidebar([session], 'native', [], 'all');
    expect(groups.map((g) => g.id)).toContain('harness:muse');
    const single = groupSessionsForSidebar([session], 'native', [], 'muse');
    expect(single[0]?.items).toEqual([session]);
    expect(isSingleHarnessFilter('muse')).toBe(true);
    expect(isSingleHarnessFilter('antigravity')).toBe(true);
    expect(isSingleHarnessFilter('codex')).toBe(true);
    expect(isSingleHarnessFilter('claude')).toBe(true);
    expect(isSingleHarnessFilter('all')).toBe(false);
    expect(isSingleHarnessFilter('live')).toBe(false);
    expect(isSingleHarnessFilter('tmux')).toBe(false);
  });
});

describe('Muse session status (spinner) semantics', () => {
  const now = 1_800_000_000_000;

  it('idle live TUI (open segment, stale transcript) is NOT running', () => {
    expect(
      resolveMuseSessionStatus({
        isLiveRegistered: true,
        latestSegmentTerminated: 0,
        updatedAt: now - 10 * 60_000,
        now,
      })
    ).toBe('idle');
  });

  it('live TUI mid-turn (open segment, fresh transcript writes) is running', () => {
    expect(
      resolveMuseSessionStatus({
        isLiveRegistered: true,
        latestSegmentTerminated: 0,
        updatedAt: now - 5_000,
        now,
      })
    ).toBe('running');
  });

  it('terminated segment is idle even with fresh writes (just-finished exec)', () => {
    expect(
      resolveMuseSessionStatus({
        isLiveRegistered: false,
        latestSegmentTerminated: 1,
        updatedAt: now - 1_000,
        now,
      })
    ).toBe('idle');
  });

  it('headless exec in flight (open segment, fresh, unregistered) is running', () => {
    expect(
      resolveMuseSessionStatus({
        isLiveRegistered: false,
        latestSegmentTerminated: 0,
        updatedAt: now - 3_000,
        now,
      })
    ).toBe('running');
  });

  it('crashed session (open segment, unregistered, stale) is idle', () => {
    expect(
      resolveMuseSessionStatus({
        isLiveRegistered: false,
        latestSegmentTerminated: 0,
        updatedAt: now - 3600_000,
        now,
      })
    ).toBe('idle');
  });

  it('just-finished turn (terminal in tail) is idle immediately, no 90s linger', () => {
    expect(
      resolveMuseSessionStatus({
        isLiveRegistered: true,
        latestSegmentTerminated: 0,
        updatedAt: now - 1_000,
        now,
        transcriptWorking: false,
      })
    ).toBe('idle');
  });

  it('reads turn-boundary verdict from a transcript tail file', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const pathMod = await import('node:path');
    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'muse-tail-'));
    const file = pathMod.join(dir, 'session.jsonl');
    fs.writeFileSync(
      file,
      [
        userIntentLine('first', 1),
        runEventLine({ kind: 'terminal', terminal: 'completed' }, 2),
      ].join('\n')
    );
    expect(museTranscriptIsWorking(file)).toBe(false);
    fs.appendFileSync(file, `\n${userIntentLine('second', 3)}\n`);
    expect(museTranscriptIsWorking(file)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('Muse tmux terminal typing lane', () => {
  it('parses tmux pane list and resolves the pane by ancestor pid', () => {
    const panes = parseTmuxPaneList('%1 1000\n%7 2000\n%9 3000\n');
    expect(panes.get(2000)).toBe('%7');
    // muse pid 2500 -> shell 2000 (pane pid) -> tmux server
    expect(findTmuxPaneForPids(panes, [2500, 2000, 999])).toBe('%7');
    expect(findTmuxPaneForPids(panes, [2500, 2600])).toBeNull();
    expect(findTmuxPaneForPids(parseTmuxPaneList('garbage'), [1])).toBeNull();
  });

  it('acks delivery when the prompt lands in the session log tail', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const pathMod = await import('node:path');
    const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'muse-ack-'));
    const file = pathMod.join(dir, 'session.jsonl');
    fs.writeFileSync(file, '{"payload_type":"runtime.session"}\n');
    setTimeout(() => {
      fs.appendFileSync(
        file,
        `${JSON.stringify({ payload_type: 'runtime.user_intent.accepted', payload: { model_messages: [{ content: [{ kind: 'text', text: 'typed via tmux hello' }] }] } })}\n`
      );
    }, 200);
    await expect(waitForMuseTranscriptDelivery(file, 'typed via tmux hello', 3000)).resolves.toBe(true);
    await expect(waitForMuseTranscriptDelivery(file, 'never typed this', 300)).resolves.toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('Muse terminal-held undeliverable error', () => {
  it('builds a human undeliverable error without the raw CLI dump', () => {
    const err = buildMuseUndeliverableError(
      { title: 'Hey, what is this project', tags: ['@west-vega'] },
      'tui-held'
    );
    expect(err).toContain('west-vega');
    expect(err).toContain('was not delivered');
    expect(err).toContain('close the terminal session');
    expect(err).toContain('Restart in tmux');
    expect(err).not.toContain('Command failed');
    expect(err).not.toContain('--target');
  });
});

describe('Muse restart-in-tmux holder safety', () => {
  it('parses the holding pid from a live-registry entry', () => {
    expect(
      parseMuseRegistryPid(
        '{"schema_version":1,"session_id":"s1","process_generation_hint":"pid=2540883"}'
      )
    ).toBe(2540883);
    expect(parseMuseRegistryPid('{"session_id":"s1"}')).toBeNull();
    expect(parseMuseRegistryPid('{"process_generation_hint":"pid=0"}')).toBeNull();
    expect(parseMuseRegistryPid('{"process_generation_hint":"gen=7"}')).toBeNull();
    expect(parseMuseRegistryPid('not json')).toBeNull();
    expect(parseMuseRegistryPid('')).toBeNull();
  });

  it('classifies holder cmdlines so only a plain terminal muse is ever signalled', () => {
    // /proc cmdline is NUL-separated.
    expect(classifyMuseHolderCmdline('/home/u/.local/bin/muse-bin-1.4.25\0--yolo\0resume\0')).toBe('tui');
    expect(classifyMuseHolderCmdline('/home/u/.local/bin/muse-bin-1.4.25\0--yolo\0')).toBe('tui');
    expect(classifyMuseHolderCmdline('muse\0resume\0abc\0')).toBe('tui');
    expect(
      classifyMuseHolderCmdline('/home/u/.local/bin/muse-bin-1.4.25\0serve\0--enable-attach\0')
    ).toBe('serve');
    expect(classifyMuseHolderCmdline('muse\0exec\0--session-id\0abc\0')).toBe('other');
    expect(classifyMuseHolderCmdline('muse\0attach\0--stdio\0abc\0')).toBe('other');
    expect(classifyMuseHolderCmdline('/usr/bin/node\0server.js\0')).toBe('other');
    expect(classifyMuseHolderCmdline('')).toBe('other');
  });

  it('builds a deterministic sanitized tmux session name and resume command', () => {
    expect(buildMuseTmuxSessionName('Fix the Auth Bug!', '01a2168a-0e0a-7461')).toBe(
      'sh-muse-fix-the-auth-bug-01a216'
    );
    expect(buildMuseTmuxSessionName('', '01a2168a-0e0a-7461')).toBe('sh-muse-muse-01a216');
    expect(buildMuseResumeCommand('/home/u/.local/bin/muse', '01a2168a-x')).toBe(
      `'/home/u/.local/bin/muse' 'resume' '01a2168a-x'`
    );
    expect(buildMuseResumeCommand('/home/u/.local/bin/muse', '01a2168a-x', ['--yolo'])).toBe(
      `'/home/u/.local/bin/muse' 'resume' '01a2168a-x' '--yolo'`
    );
  });

  it('replays only whitelisted posture flags from the original terminal launch', () => {
    expect(
      extractMuseResumeFlags(
        '/home/u/.local/bin/muse-bin\0--yolo\0--model\0muse-wonder\0--provider\0echo\0resume\0'
      )
    ).toEqual(['--yolo', '--model', 'muse-wonder', '--provider', 'echo']);
    expect(
      extractMuseResumeFlags('muse\0--reasoning-effort=xhigh\0--trust-workspace\0fix the bug\0')
    ).toEqual(['--reasoning-effort', 'xhigh', '--trust-workspace']);
    // Unknown flags, the binary, subcommands, and prompt text never carry over.
    expect(extractMuseResumeFlags('muse\0--base-url\0http://x\0hello\0')).toEqual([]);
    expect(extractMuseResumeFlags('muse\0')).toEqual([]);
    expect(extractMuseResumeFlags('')).toEqual([]);
    // A valued flag with no value is dropped rather than dangling.
    expect(extractMuseResumeFlags('muse\0--model\0')).toEqual([]);
  });

  it('exposes promoteToTmux on the muse driver', () => {
    const muse = createMuseDriver();
    expect(typeof muse.promoteToTmux).toBe('function');
  });
});


describe('Muse usage parity (JSON, pace window, 24h delta)', () => {
  it('parses `muse usage --json` with absolute resets and pace window lengths', () => {
    const parsed = parseMuseUsageJson(
      JSON.stringify({
        allowance: {
          asOfMs: 1795671261315,
          source: 'mint',
          tier: 'Muse Code Power Usage',
          weekly: { resetsAtMs: 1795996800000, usedPercent: 4 },
          window: { resetsAtMs: 1795687080000, usedPercent: 14 },
        },
        hint: null,
        reason: null,
        schemaVersion: 1,
      })
    );
    expect(parsed).not.toBeNull();
    expect(parsed!.planLabel).toBe('Muse Code Power Usage');
    expect(parsed!.windows).toEqual([
      {
        id: 'five_hour',
        label: 'Window',
        usedPercent: 14,
        resetsAt: 1795687080000,
        windowMinutes: 300,
      },
      {
        id: 'weekly',
        label: 'Weekly (7d)',
        usedPercent: 4,
        resetsAt: 1795996800000,
        windowMinutes: 10080,
      },
    ]);
    expect(parseMuseUsageJson('not json')).toBeNull();
  });

  it('text fallback also carries the 5h window length for pace', () => {
    const { windows } = parseMuseUsageOutput(
      'Tier: X\nWindow: 10% used, resets in 4h 0m\nWeekly: 2% used, resets in 3d 1h\n',
      1_800_000_000_000
    );
    expect(windows[0].windowMinutes).toBe(300);
  });

  it('samples quota history with throttling and computes +24h delta like Claude', () => {
    const day = 24 * 3600_000;
    const t0 = 1_800_000_000_000;
    let samples = appendMuseQuotaSample([], { t: t0, w: 10, wk: 30 }, t0);
    // Same values 1 minute later → throttled, no new sample.
    samples = appendMuseQuotaSample(samples, { t: t0 + 60_000, w: 10, wk: 30 }, t0 + 60_000);
    expect(samples).toHaveLength(1);
    // Changed value → recorded immediately.
    samples = appendMuseQuotaSample(samples, { t: t0 + 120_000, w: 12, wk: 30 }, t0 + 120_000);
    expect(samples).toHaveLength(2);

    const now = t0 + day + 3600_000;
    samples = appendMuseQuotaSample(samples, { t: now, w: 25, wk: 41 }, now);
    expect(computeMuseQuotaDelta24h(samples, 'wk', 41, now)).toBe(11);
    expect(computeMuseQuotaDelta24h(samples, 'w', 25, now)).toBe(13);
    // No sample old enough → undefined (delta hidden, as with Claude).
    expect(computeMuseQuotaDelta24h(samples.slice(-1), 'wk', 41, now)).toBeUndefined();
    // Negative movement (reset crossed) → undefined, never a negative "+% today".
    expect(computeMuseQuotaDelta24h(samples, 'wk', 5, now)).toBeUndefined();
  });
});
