import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error ESM .mjs helper script
import { shouldDelegateToDetachedRestart } from '../scripts/launch-electron.mjs';
// @ts-expect-error ESM .mjs helper script
import { parseSingletonLockPid } from '../scripts/restart-electron.mjs';

describe('Detached Super Harness restart flow', () => {
  it('parses Electron SingletonLock symlink PIDs cleanly and rejects invalid targets', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sh-restart-test-'));
    const validLock = path.join(tmpDir, 'SingletonLock');
    fs.symlinkSync('archlinux-424242', validLock);
    expect(parseSingletonLockPid(validLock)).toBe(424242);

    const invalidLock = path.join(tmpDir, 'SingletonLockBad');
    fs.symlinkSync('not-a-pid', invalidLock);
    expect(parseSingletonLockPid(invalidLock)).toBeNull();

    expect(parseSingletonLockPid(path.join(tmpDir, 'missing'))).toBeNull();
  });

  it('delegates launch-electron.mjs to detached restart when invoked inside Super Harness or with --restart/--replace', () => {
    expect(shouldDelegateToDetachedRestart(['.'], {})).toBe(false);
    expect(shouldDelegateToDetachedRestart(['--restart', '.'], {})).toBe(true);
    expect(shouldDelegateToDetachedRestart(['--replace', '.'], {})).toBe(true);
    expect(shouldDelegateToDetachedRestart(['.'], { SUPER_HARNESS_REPLACE: '1' })).toBe(true);
    expect(shouldDelegateToDetachedRestart(['.'], { SUPER_HARNESS_APP_PID: '12345' })).toBe(true);
    expect(
      shouldDelegateToDetachedRestart(['.'], {
        SUPER_HARNESS_APP_PID: '12345',
        SUPER_HARNESS_NO_REPLACE: '1',
      })
    ).toBe(false);
  });
});
