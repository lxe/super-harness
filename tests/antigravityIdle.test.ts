import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isAntigravityTranscriptTerminal } from '../src/main/adapters/antigravityAdapter';

describe('isAntigravityTranscriptTerminal', () => {
  it('returns true for a completed text-only PLANNER_RESPONSE older than 4s (clears stuck CASCADE_RUN_STATUS_RUNNING)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-agy-idle-'));
    const tr = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(
      tr,
      [
        JSON.stringify({ step_index: 1, type: 'USER_INPUT', status: 'DONE', content: 'hi' }),
        JSON.stringify({
          step_index: 2,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          content: 'All done!',
          tool_calls: [],
        }),
      ].join('\n') + '\n'
    );
    const mtimeMs = Date.now() - 10_000;
    expect(isAntigravityTranscriptTerminal(tr, mtimeMs, Date.now())).toBe(true);
    // Within 4s grace window it stays false
    expect(isAntigravityTranscriptTerminal(tr, Date.now() - 1_000, Date.now())).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns false when the last step has pending tool calls or is USER_INPUT / GENERIC', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-agy-active-'));
    const tr = path.join(dir, 'transcript.jsonl');
    fs.writeFileSync(
      tr,
      JSON.stringify({
        step_index: 2,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [{ name: 'run_command' }],
      }) + '\n'
    );
    expect(isAntigravityTranscriptTerminal(tr, Date.now() - 30_000, Date.now())).toBe(false);

    fs.writeFileSync(
      tr,
      JSON.stringify({ step_index: 3, type: 'USER_INPUT', status: 'DONE', content: 'next' }) + '\n'
    );
    expect(isAntigravityTranscriptTerminal(tr, Date.now() - 30_000, Date.now())).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns false while waiting on an active non-daemon background task, and true once that task finishes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-agy-bgtask-'));
    const tr = path.join(dir, 'transcript.jsonl');
    const logFile = path.join(dir, 'task-7112.log');
    fs.writeFileSync(logFile, 'running tests...\n');

    const baseLines = [
      JSON.stringify({
        step_index: 1,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        tool_calls: [{ name: 'run_command', args: { CommandLine: 'xcodebuild test', IsDaemon: false } }],
      }),
      JSON.stringify({
        step_index: 2,
        type: 'GENERIC',
        status: 'RUNNING',
        content: `Tool is running as a background task with task id: conv-1/task-7112\nTask logs are available at: file://${logFile}`,
      }),
      JSON.stringify({
        step_index: 3,
        type: 'PLANNER_RESPONSE',
        status: 'DONE',
        content: 'Running tests now. Waiting for results.',
        tool_calls: [],
      }),
    ];
    fs.writeFileSync(tr, baseLines.join('\n') + '\n');

    const now = Date.now();
    // Even after 60s of quiet transcript, the active non-daemon background task keeps it non-terminal
    expect(isAntigravityTranscriptTerminal(tr, now - 60_000, now)).toBe(false);

    // Once the completion SYSTEM_MESSAGE and final reply arrive, it becomes terminal again
    fs.appendFileSync(
      tr,
      [
        JSON.stringify({
          step_index: 4,
          type: 'SYSTEM_MESSAGE',
          status: 'DONE',
          content: 'Task id "conv-1/task-7112" finished with result: ok',
        }),
        JSON.stringify({
          step_index: 5,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          content: 'All tests passed!',
          tool_calls: [],
        }),
      ].join('\n') + '\n'
    );
    expect(isAntigravityTranscriptTerminal(tr, now - 10_000, now)).toBe(true);

    // Daemon tasks (IsDaemon: true) do NOT keep the conversation permanently working
    const trDaemon = path.join(dir, 'transcript-daemon.jsonl');
    fs.writeFileSync(
      trDaemon,
      [
        JSON.stringify({
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          tool_calls: [{ name: 'run_command', args: { CommandLine: 'vite dev', IsDaemon: true } }],
        }),
        JSON.stringify({
          step_index: 2,
          type: 'GENERIC',
          status: 'RUNNING',
          content: `Tool is running as a background task with task id: conv-2/task-99\nTask logs are available at: file://${logFile}`,
        }),
        JSON.stringify({
          step_index: 3,
          type: 'PLANNER_RESPONSE',
          status: 'DONE',
          content: 'Dev server is running.',
          tool_calls: [],
        }),
      ].join('\n') + '\n'
    );
    expect(isAntigravityTranscriptTerminal(trDaemon, now - 10_000, now)).toBe(true);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
