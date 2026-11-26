import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanUserPreview, readLastUserText } from '../src/main/utils/lastUserText';

const write = (lines: unknown[]) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-last-'));
  const f = path.join(dir, 't.jsonl');
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return f;
};

describe('last user text', () => {
  it('Claude: newest of last-prompt and delivered queued_command', () => {
    const f = write([
      { type: 'last-prompt', lastPrompt: 'first' },
      { type: 'attachment', attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'steer   now' } },
    ]);
    expect(readLastUserText(f, 'claude')).toBe('steer now');
  });
  it('Codex: skips injected context messages', () => {
    const f = write([
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix the build' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }] } },
    ]);
    expect(readLastUserText(f, 'codex')).toBe('fix the build');
  });
  it('Antigravity and Muse formats', () => {
    expect(readLastUserText(write([{ type: 'USER_INPUT', content: 'hello agy' }]), 'antigravity')).toBe('hello agy');
    const m = write([
      { payload_type: 'runtime.user_intent.accepted', payload: { semantic_kind: { kind: 'chat' }, surface: 'main', refill_blocks: [{ kind: 'text', text: 'hi muse' }] } },
    ]);
    expect(readLastUserText(m, 'muse')).toBe('hi muse');
  });
  it('cleans to one capped line', () => {
    expect(cleanUserPreview('[Attached image: /x.png]\n\nLook  here')).toBe('Look here');
    expect(cleanUserPreview('x'.repeat(300))!.length).toBe(160);
    expect(cleanUserPreview('<USER_REQUEST>\nship it\n</USER_REQUEST>')).toBe('ship it');
  });
});
