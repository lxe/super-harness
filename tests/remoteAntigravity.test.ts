import { describe, expect, it } from 'vitest';
import {
  buildRemoteAgyPrintCommand,
  toUnifiedRemoteAntigravitySession,
} from '../src/main/adapters/remoteAntigravity';

describe('remote Antigravity mirror', () => {
  it('builds a quoted remote agy print command with cwd and model', () => {
    const cmd = buildRemoteAgyPrintCommand({
      sessionId: '53939ee5-be41-4559-8470-8a9e6e359d03',
      prompt: "Check lxe's Mac build",
      cwd: '/Users/lxe/Developer/super-harness',
      model: 'gemini-4-neon-high',
    });
    expect(cmd).toContain("cd '/Users/lxe/Developer/super-harness'");
    expect(cmd).toContain("agy --conversation '53939ee5-be41-4559-8470-8a9e6e359d03'");
    expect(cmd).toContain("--print 'Check lxe'\\''s Mac build'");
    expect(cmd).toContain("--model 'gemini-4-neon-high'");
  });

  it('maps a remote Antigravity CLI entry to a session grouped under its host', () => {
    const now = Date.now();
    const s = toUnifiedRemoteAntigravitySession({
      host: '10.0.0.42',
      label: 'macbook',
      sessionId: '53939ee5-be41-4559-8470-8a9e6e359d03',
      originApp: 'antigravity-cli',
      transcriptPath:
        '/Users/dev/.gemini/antigravity-cli/brain/53939ee5-be41-4559-8470-8a9e6e359d03/.system_generated/logs/transcript.jsonl',
      size: 1392144,
      mtimeMs: now - 5_000,
      ctimeMs: now - 60_000,
      firstUserTitle: 'Build the native SwiftUI iOS companion app',
      lastUserText: 'Verify the OTA build on iPhone',
      workspaceUris: '["file:///Users/dev/Developer/super-harness"]',
      status: 'CASCADE_RUN_STATUS_RUNNING',
      model: 'gemini-4-neon-high',
      tailWorking: true,
      hubAvailable: true,
    });

    expect(s).toMatchObject({
      id: 'antigravity:53939ee5-be41-4559-8470-8a9e6e359d03',
      nativeId: '53939ee5-be41-4559-8470-8a9e6e359d03',
      harness: 'antigravity',
      harnessGroup: 'antigravity',
      title: 'Build the native SwiftUI iOS companion app',
      lastUserText: 'Verify the OTA build on iPhone',
      cwd: '/Users/dev/Developer/super-harness',
      projectName: 'super-harness',
      nativeSection: 'macbook',
      hostAddress: '10.0.0.42',
      hostLabel: 'macbook',
      status: 'running',
      isLive: true,
      isRemote: true,
      originApp: 'antigravity-cli',
    });
    expect(s.transcriptPath).toBeUndefined();
    expect(s.tags).toContain('remote-host');
    expect(s.tags).toContain('cli');
  });

  it('marks remote Antigravity Desktop sessions with liveOwner desktop when hub is running', () => {
    const now = Date.now();
    const s = toUnifiedRemoteAntigravitySession({
      host: '10.0.0.42',
      label: 'macbook',
      sessionId: 'abc-desktop',
      originApp: 'antigravity-app',
      transcriptPath: '/Users/dev/.gemini/antigravity/brain/abc-desktop/.system_generated/logs/transcript.jsonl',
      size: 4096,
      mtimeMs: now - 1000,
      ctimeMs: now - 5000,
      title: 'Mac Desktop Session',
      status: 'CASCADE_RUN_STATUS_RUNNING',
      hubAvailable: true,
    });
    expect(s.liveOwner).toBe('desktop');
    expect(s.tags).toContain('desktop');
  });
});
