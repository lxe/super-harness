import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  claudeTmuxTypingSteps,
  pickClaudeTitle,
  readJsonlTitleMeta,
  registerPendingClaudeStart,
  stripPastedContentWrappers,
  takePendingClaudeStarts,
} from '../src/main/adapters/claudeAdapter';

describe('Claude session titles', () => {
  it('ranks the AI title above a derived placeholder name', () => {
    expect(
      pickClaudeTitle({ name: 'lxe-73', nameSource: 'derived', aiTitle: 'Super harness overview' })
    ).toBe('Super harness overview');
  });
  it('keeps a name a person chose above the AI title', () => {
    expect(pickClaudeTitle({ name: 'my task', nameSource: 'user', aiTitle: 'AI' })).toBe('my task');
  });
  it('falls back to the derived name when nothing else exists', () => {
    expect(pickClaudeTitle({ name: 'lxe-73', nameSource: 'derived' })).toBe('lxe-73');
  });
  it('reads the latest ai-title and custom-title from the transcript tail', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-title-'));
    const f = path.join(dir, 's.jsonl');
    fs.writeFileSync(
      f,
      [
        JSON.stringify({ type: 'user', message: { content: 'hi' } }),
        JSON.stringify({ type: 'ai-title', aiTitle: 'Old' }),
        JSON.stringify({ type: 'ai-title', aiTitle: 'New' }),
      ].join('\n') + '\n'
    );
    expect(readJsonlTitleMeta(f)).toEqual({ aiTitle: 'New' });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('Claude tmux typing', () => {
  it('turns newlines into their own steps and chunks long lines', () => {
    expect(claudeTmuxTypingSteps('a\nb')).toEqual(['a', '\n', 'b']);
    expect(claudeTmuxTypingSteps('x'.repeat(250), 100).map((s) => s.length)).toEqual([100, 100, 50]);
  });
  it('strips pasted_content wrappers from displayed user text', () => {
    expect(stripPastedContentWrappers('<pasted_content id="4983">\nhello\n</pasted_content id="4983">')).toBe('hello');
    expect(stripPastedContentWrappers('plain')).toBe('plain');
  });
});

describe('pending Claude starts', () => {
  it('reports a new tmux session until Claude registers it', () => {
    registerPendingClaudeStart({
      nativeId: 'n1',
      cwd: '/tmp',
      title: 'Fix the bug',
      tmuxSessionName: 'sh-x',
      remoteControl: true,
    });
    expect(takePendingClaudeStarts(new Set()).map((s) => s.id)).toEqual(['claude:n1']);
    expect(takePendingClaudeStarts(new Set(['n1']))).toEqual([]);
    expect(takePendingClaudeStarts(new Set())).toEqual([]);
  });
});

import { sortSidebarGroups } from '../src/renderer/utils/sidebarGrouping';

describe('sidebar sort', () => {
  const s = (id: string, updatedAt: number, createdAt = 0) =>
    ({ id, updatedAt, createdAt }) as unknown as import('../src/shared/types').UnifiedSession;
  it('orders sections and threads by last activity', () => {
    const groups = [
      { id: 'h', label: 'H', sections: [
        { id: 'a', label: 'A', order: 1, harnessGroup: 'claude' as const, items: [s('1', 1), s('2', 5)] },
        { id: 'b', label: 'B', order: 2, harnessGroup: 'claude' as const, items: [s('3', 9)] },
      ] },
    ];
    const out = sortSidebarGroups(groups, 'active');
    expect(out[0].sections!.map((x) => x.id)).toEqual(['b', 'a']);
    expect(out[0].sections![1].items.map((x) => x.id)).toEqual(['2', '1']);
    expect(sortSidebarGroups(groups, 'native')).toBe(groups);
  });

  it('preserves top-level harness order when sorting threads by activity', () => {
    const groups = [
      { id: 'harness:antigravity', label: 'Antigravity', harnessLogo: 'antigravity' as const, items: [s('1', 10)] },
      { id: 'harness:pi', label: 'Pi', harnessLogo: 'pi' as const, items: [s('2', 999)] },
    ];
    const out = sortSidebarGroups(groups, 'active');
    expect(out.map((g) => g.id)).toEqual(['harness:antigravity', 'harness:pi']);
  });
});
