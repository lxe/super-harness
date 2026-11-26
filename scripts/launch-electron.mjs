#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPidAlive, parseSingletonLockPid, resolveElectronBinary } from './restart-electron.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const singletonLockPath = path.join(os.homedir(), '.config', 'super-harness', 'SingletonLock');

/**
 * Determines whether launch-electron.mjs should delegate to the detached restart
 * watchdog instead of launching Electron inline.
 *
 * When invoked from inside a Super Harness child agent (`SUPER_HARNESS_APP_PID` set),
 * or when `--restart`/`--replace` is passed, delegating to the detached watchdog
 * prevents the restart command from being killed mid-flight when the old Electron exits
 * and avoids losing the single-instance lock race.
 */
export function shouldDelegateToDetachedRestart(argv, env = process.env) {
  if (env.SUPER_HARNESS_NO_REPLACE === '1') return false;
  if (argv.includes('--restart') || argv.includes('--replace')) return true;
  if (env.SUPER_HARNESS_REPLACE === '1') return true;
  const parentAppPid = Number(env.SUPER_HARNESS_APP_PID || '');
  if (Number.isInteger(parentAppPid) && parentAppPid > 1) return true;
  return false;
}

const isDirectEntry =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectEntry) {
  const rawArgs = process.argv.slice(2);

  if (shouldDelegateToDetachedRestart(rawArgs, process.env)) {
    const restartScript = path.join(__dirname, 'restart-electron.mjs');
    const forwarded = rawArgs.filter((a) => a !== '--restart' && a !== '--replace');
    const worker = spawn(process.execPath, [restartScript, ...forwarded], {
      cwd: rootDir,
      stdio: 'inherit',
      env: process.env,
    });
    worker.on('exit', (code) => process.exit(code ?? 0));
  } else {
    // Clean up a stale SingletonLock only if its owner PID is confirmed dead
    const lockPid = parseSingletonLockPid(singletonLockPath);
    if (lockPid && !isPidAlive(lockPid)) {
      try {
        fs.unlinkSync(singletonLockPath);
      } catch {
        // ignore
      }
    }

    const bin = resolveElectronBinary();
    const hasOzone = rawArgs.some((a) => a.startsWith('--ozone-platform'));
    const args =
      !hasOzone && process.env.WAYLAND_DISPLAY
        ? ['--ozone-platform=wayland', ...rawArgs]
        : rawArgs;
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;

    const child = spawn(bin, args, {
      stdio: 'inherit',
      env,
    });

    child.on('exit', (code, signal) => {
      if (signal) process.kill(process.pid, signal);
      process.exit(code ?? 0);
    });
  }
}
