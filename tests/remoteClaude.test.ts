import { describe, expect, it } from 'vitest';
import { buildRemoteTmuxTypingScript, shQuote, toUnifiedRemoteSession } from '../src/main/adapters/remoteClaude';

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
