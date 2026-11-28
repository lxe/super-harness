import { describe, expect, it } from 'vitest';
import { buildRemoteTmuxTypingScript, shQuote, toUnifiedRemoteSession } from '../src/main/adapters/remoteClaude';
import { RemoteHostHealth } from '../src/main/adapters/remoteHostHealth';

describe('remote Claude mirror', () => {
  it('quotes for a remote shell', () => {
    expect(shQuote("it's")).toBe(`'it'\\''s'`);
  });
  it('types lines with Ctrl+J and submits once', () => {
    const script = buildRemoteTmuxTypingScript('s:@1.%1', "a'b\nc");
    expect(script).toContain(`tmux send-keys -t 's:@1.%1' -l 'a'\\''b'`);
    expect(script).toContain(`tmux send-keys -t 's:@1.%1' C-j`);
    expect(script.match(/C-m/g)).toHaveLength(1);
  });
  it('maps a remote entry to a session grouped under its host', () => {
    const s = toUnifiedRemoteSession({
      host: '192.168.0.3',
      label: 'mac',
      sessionId: 'abc',
      pid: 1,
      cwd: '/Users/x/proj',
      name: 'x-1',
      nameSource: 'derived',
      aiTitle: 'Declutter settings',
      tmux: 'sh-ios:@3.%3',
      status: 'busy',
    });
    expect(s).toMatchObject({
      id: 'claude:abc',
      title: 'Declutter settings',
      nativeSection: 'mac',
      harness: 'claude-tmux',
      status: 'running',
      dispatchMode: 'tmux-send',
      projectName: 'proj',
    });
  });
  it('shows a busy session as offline, not running, once its host stops answering', () => {
    const health = new RemoteHostHealth(3000);
    health.recordSuccess('mac', 1_000);
    health.recordFailure('mac', 4_000);
    expect(health.status('mac').offline).toBe(false); // one blip is not offline
    health.recordFailure('mac', 7_000);
    const s = toUnifiedRemoteSession(
      { host: 'mac', label: 'mac', sessionId: 'abc', pid: 1, cwd: '/p', status: 'busy' },
      health.status('mac')
    );
    expect(s).toMatchObject({ status: 'idle', isLive: false, hostOffline: true, hostLastSeenAt: 1_000 });
  });
  it('backs off polling a failing host and resumes after it answers', () => {
    const health = new RemoteHostHealth(3000);
    health.recordFailure('mac', 0);
    health.recordFailure('mac', 0); // 2 failures: wait 12 s
    expect(health.shouldPoll('mac', 11_999)).toBe(false);
    expect(health.shouldPoll('mac', 12_000)).toBe(true);
    for (let i = 0; i < 10; i++) health.recordFailure('mac', 0);
    expect(health.shouldPoll('mac', 60_000)).toBe(true); // capped at a minute
    health.recordSuccess('mac', 60_000);
    expect(health.shouldPoll('mac', 60_001)).toBe(true);
    expect(health.status('mac')).toEqual({ offline: false, lastSeenAt: 60_000 });
  });
});

import { hostBadgeLabel } from '../src/renderer/utils/sidebarGrouping';
describe('host badge', () => {
  it('shows the last IPv4 octet, else the short host name', () => {
    expect(hostBadgeLabel('192.168.0.3')).toBe('.3');
    expect(hostBadgeLabel('lxe@10.0.0.42')).toBe('.42');
    expect(hostBadgeLabel('lxebook-2021.local')).toBe('lxebook-');
    expect(hostBadgeLabel(undefined)).toBeUndefined();
  });
});
