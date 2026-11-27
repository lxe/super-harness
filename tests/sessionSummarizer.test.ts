import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { UnifiedMessage, UnifiedSession } from '../src/shared/types';
import {
  SessionSummarizer,
  buildThreadDigest,
  isInternalSummarizerCwd,
  parseSummaryReply,
} from '../src/main/services/sessionSummarizer';

const msg = (role: 'user' | 'assistant', text: string, timestamp: number): UnifiedMessage => ({
  id: `${role}-${timestamp}`,
  role,
  timestamp,
  blocks: [{ type: 'text', text }],
});

const session = (id: string, updatedAt: number, extra: Partial<UnifiedSession> = {}): UnifiedSession => ({
  id,
  nativeId: id,
  harness: 'claude-tmux',
  harnessGroup: 'claude',
  title: `Title ${id}`,
  preview: '',
  cwd: '/tmp/proj',
  projectName: 'proj',
  status: 'idle',
  isLive: true,
  isRemote: false,
  createdAt: 0,
  updatedAt,
  pinned: false,
  tags: [],
  hidden: false,
  dispatchMode: 'tmux-send',
  ...extra,
});

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shsum-')), 'summaries.json');

describe('buildThreadDigest', () => {
  it('keeps only text since the last summary, labels speakers, drops injected context', () => {
    const d = buildThreadDigest(
      [
        msg('user', 'old request', 100),
        msg('assistant', 'old answer', 110),
        msg('user', '<system-reminder>ignore me</system-reminder>', 210),
        msg('user', 'add a retry to the uploader', 220),
        msg('assistant', 'Added retries with backoff in uploader.ts', 230),
      ],
      200
    );
    expect(d).toBe('P: add a retry to the uploader\nA: Added retries with backoff in uploader.ts');
  });

  it('falls back to the last exchange when nothing is new', () => {
    const d = buildThreadDigest([msg('user', 'a', 1), msg('assistant', 'b', 2)], 999);
    expect(d).toBe('P: a\nA: b');
  });

  it('caps the digest, keeping the newest text', () => {
    const long = 'x'.repeat(490);
    const msgs = Array.from({ length: 10 }, (_, i) => msg('assistant', `${i}${long}`, i + 1));
    const d = buildThreadDigest(msgs, 0);
    expect(d.length).toBeLessThanOrEqual(1601);
    expect(d).toContain('A: 9');
  });
});

describe('parseSummaryReply', () => {
  it('reads plain or fenced JSON and trims trailing periods', () => {
    const m = parseSummaryReply('```json\n{"items":[{"n":1,"s":"Fixing the login redirect."},{"n":2,"s":"  "}]}\n```');
    expect(m.get(1)).toBe('Fixing the login redirect');
    expect(m.has(2)).toBe(false);
  });

  it('returns nothing for garbage', () => {
    expect(parseSummaryReply('no json here').size).toBe(0);
  });
});

describe('SessionSummarizer', () => {
  it('batches changed idle sessions into one call and skips running and unchanged ones', async () => {
    const now = 1_000_000_000;
    const prompts: string[] = [];
    const filePath = tmpFile();
    fs.writeFileSync(filePath, JSON.stringify({
        'c:same': { text: 'Old', updatedAt: now - 60_000, at: now - 60_000 },
        // Running and summarized 2 min ago: waits until idle or 15 min stale.
        'c:busy': { text: 'Busy', updatedAt: now - 120_000, at: now - 120_000 },
      }));
    const s = new SessionSummarizer({
      filePath,
      now: () => now,
      getWorkingIds: () => ['c:busy'],
      getConfig: () => ({ enabled: true, model: 'haiku' }),
      onUpdated: () => {},
      loadTranscript: async (id) => ({ messages: [msg('user', `work on ${id}`, now - 50_000), msg('assistant', 'ok', now - 40_000)] }),
      callModel: async (prompt) => {
        prompts.push(prompt);
        return { text: '{"items":[{"n":1,"s":"Working on a"},{"n":2,"s":"Working on b"}]}' };
      },
    });
    s.noteSessions([
      session('c:a', now - 30_000),
      session('c:b', now - 40_000),
      session('c:same', now - 60_000),
      session('c:busy', now - 1_000),
      session('c:fresh', now - 5_000),
      session('c:ancient', now - 30 * 24 * 3600_000),
    ]);
    s.dispose();
    const r = await s.refresh();
    expect(r).toMatchObject({ ok: true, summarized: 2 });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('## 1. Title c:a');
    expect(prompts[0]).not.toContain('c:busy');
    expect(s.get('c:a')).toBe('Working on a');
    expect(s.get('c:same')).toBe('Old');
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))['c:b'].text).toBe('Working on b');
    // Unchanged now: nothing pending.
    expect(s.pendingSessions([session('c:a', now - 30_000)])).toHaveLength(0);
  });

  it('includes the previous summary as context', async () => {
    const now = 5_000_000;
    let prompt = '';
    const filePath = tmpFile();
    fs.writeFileSync(filePath, JSON.stringify({ 'c:a': { text: 'Drafting the API', updatedAt: 1, at: 1 } }));
    const s = new SessionSummarizer({
      filePath,
      now: () => now,
      getWorkingIds: () => [],
      getConfig: () => ({ enabled: true, model: 'haiku' }),
      onUpdated: () => {},
      loadTranscript: async () => ({ messages: [msg('assistant', 'Shipped it', 100)] }),
      callModel: async (p) => {
        prompt = p;
        return { text: '{"items":[{"n":1,"s":"Done: API shipped"}]}' };
      },
    });
    s.noteSessions([session('c:a', now - 60_000)]);
    s.dispose();
    await s.refresh();
    expect(prompt).toContain('Previous summary: Drafting the API');
    expect(s.get('c:a')).toBe('Done: API shipped');
  });

  it('recognizes internal summarizer temp working directories across platforms', () => {
    expect(isInternalSummarizerCwd('/tmp/super-harness-summaries')).toBe(true);
    expect(isInternalSummarizerCwd('/var/folders/xx/T/super-harness-summaries/')).toBe(true);
    expect(isInternalSummarizerCwd('C:\\Users\\lxe\\AppData\\Local\\Temp\\super-harness-summaries')).toBe(true);
    expect(isInternalSummarizerCwd('/home/lxe/super-harness')).toBe(false);
    expect(isInternalSummarizerCwd(undefined)).toBe(false);
  });
});
