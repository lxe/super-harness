import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildClaudeTmuxResumeCommand,
  ClaudeTmuxRecords,
} from '../src/main/adapters/claudeTmuxRevival';
import type { UnifiedSession } from '../src/shared/types';

const dirs: string[] = [];
function tmpFile(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-tmux-rec-'));
  dirs.push(d);
  return path.join(d, 'records.json');
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function liveTmux(nativeId: string, tmux: string, extra: Partial<UnifiedSession> = {}): UnifiedSession {
  return {
    id: `claude:${nativeId}`,
    nativeId,
    harness: 'claude-tmux',
    harnessGroup: 'claude',
    title: tmux,
    cwd: '/tmp',
    dispatchMode: 'tmux-send',
    tmuxSessionName: tmux,
    tmuxTarget: `${tmux}:@1.%1`,
    tags: ['tmux', 'remote-control'],
    ...extra,
  } as UnifiedSession;
}

describe('Claude tmux revival records', () => {
  it('records live local tmux sessions and ignores remote-host ones', async () => {
    const file = tmpFile();
    const recs = new ClaudeTmuxRecords({ file, bootId: 'boot-A' });
    await recs.noteSessions(
      [
        liveTmux('a', 'sh-a', { model: 'opus', permissionMode: 'bypassPermissions' }),
        liveTmux('r', 'sh-r', { tags: ['remote-host', 'tmux'] }),
      ],
      new Set(['sh-a'])
    );
    expect(recs.get('a')).toMatchObject({
      tmuxSessionName: 'sh-a',
      model: 'opus',
      permissionMode: 'bypassPermissions',
      remoteControl: true,
      bootId: 'boot-A',
    });
    expect(recs.get('r')).toBeUndefined();
  });

  it('drops a record whose tmux session closed during the same boot', async () => {
    const file = tmpFile();
    const recs = new ClaudeTmuxRecords({ file, bootId: 'boot-A' });
    await recs.noteSessions([liveTmux('a', 'sh-a')], new Set(['sh-a']));
    await recs.noteSessions([], new Set());
    expect(recs.get('a')).toBeUndefined();
  });

  it('keeps a same-boot record while its tmux session still exists (Claude still starting)', async () => {
    const file = tmpFile();
    const recs = new ClaudeTmuxRecords({ file, bootId: 'boot-A' });
    await recs.noteSessions([liveTmux('a', 'sh-a')], new Set(['sh-a']));
    await recs.noteSessions([], new Set(['sh-a']));
    expect(recs.get('a')).toBeDefined();
  });

  it('after a reboot, offers sessions from the old boot whose tmux session is gone', async () => {
    const file = tmpFile();
    await new ClaudeTmuxRecords({ file, bootId: 'boot-A' }).noteSessions(
      [liveTmux('a', 'sh-a'), liveTmux('b', 'sh-b')],
      new Set(['sh-a', 'sh-b'])
    );
    const afterReboot = new ClaudeTmuxRecords({ file, bootId: 'boot-B' });
    // Old-boot records are never pruned as "closed on purpose"
    await afterReboot.noteSessions([], new Set());
    const pending = await afterReboot.pendingRevivals(new Set(['sh-b']));
    expect(pending.map((r) => r.nativeId)).toEqual(['a']);
  });

  it('builds a quoted resume command with the saved settings and an optional first prompt', () => {
    const cmd = buildClaudeTmuxResumeCommand(
      '/bin/claude',
      {
        nativeId: 'abc',
        model: 'opus',
        reasoningEffort: 'high',
        permissionMode: 'bypassPermissions',
        remoteControl: true,
      },
      "it's back"
    );
    expect(cmd).toBe(
      "'/bin/claude' '--resume' 'abc' '--remote-control' '--model' 'opus' '--effort' 'high' '--permission-mode' 'bypassPermissions' -- 'it'\\''s back'"
    );
  });
});
