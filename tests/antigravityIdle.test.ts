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
});
