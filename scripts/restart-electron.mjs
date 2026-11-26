#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const configDir = path.join(os.homedir(), '.config', 'super-harness');
const singletonLockPath = path.join(configDir, 'SingletonLock');
const restartLogPath = path.join(configDir, 'restart.log');

export function resolveElectronBinary() {
  if (process.env.SUPER_HARNESS_ELECTRON_BIN && fs.existsSync(process.env.SUPER_HARNESS_ELECTRON_BIN)) {
    return process.env.SUPER_HARNESS_ELECTRON_BIN;
  }
  const localPathTxt = path.join(rootDir, 'node_modules', 'electron', 'path.txt');
  if (fs.existsSync(localPathTxt)) {
    const rel = fs.readFileSync(localPathTxt, 'utf8').trim();
    const candidate = path.join(rootDir, 'node_modules', 'electron', 'dist', rel);
    if (fs.existsSync(candidate)) return candidate;
  }
  for (const c of ['/usr/bin/electron', '/usr/local/bin/electron']) {
    if (fs.existsSync(c)) return c;
  }
  return 'electron';
}

export function parseSingletonLockPid(lockPath = singletonLockPath) {
  try {
    const target = fs.readlinkSync(lockPath);
    const match = target.match(/-(\d+)$/);
    if (!match) return null;
    const pid = Number(match[1]);
    return Number.isInteger(pid) && pid > 1 ? pid : null;
  } catch {
    return null;
  }
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function logLine(msg) {
  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.appendFileSync(restartLogPath, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    // ignore log failures
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findRunningElectronPids(explicitPid) {
  const pids = new Set();
  if (Number.isInteger(explicitPid) && explicitPid > 1 && explicitPid !== process.pid) {
    pids.add(explicitPid);
  }
  const lockPid = parseSingletonLockPid();
  if (lockPid && lockPid !== process.pid) {
    pids.add(lockPid);
  }
  return Array.from(pids).filter((pid) => isPidAlive(pid));
}

async function stopExistingInstances(explicitPid) {
  const pids = findRunningElectronPids(explicitPid);
  if (pids.length > 0) {
    logLine(`Stopping existing Super Harness Electron PID(s): ${pids.join(', ')}`);
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // already exited
      }
    }

    const start = Date.now();
    let escalated = false;
    while (Date.now() - start < 5000) {
      const alive = pids.filter((pid) => isPidAlive(pid));
      if (alive.length === 0) break;
      if (!escalated && Date.now() - start >= 2800) {
        escalated = true;
        logLine(`Escalating to SIGKILL for lingering PID(s): ${alive.join(', ')}`);
        for (const pid of alive) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // ignore
          }
        }
      }
      await sleep(100);
    }
  }

  // Wait briefly for SingletonLock to unlink; remove only if its owner PID is confirmed dead
  const lockStart = Date.now();
  while (Date.now() - lockStart < 1500) {
    let exists = false;
    try {
      fs.lstatSync(singletonLockPath);
      exists = true;
    } catch {
      exists = false;
    }
    if (!exists) break;
    const ownerPid = parseSingletonLockPid();
    if (!ownerPid || !isPidAlive(ownerPid)) {
      try {
        fs.unlinkSync(singletonLockPath);
        logLine('Removed stale SingletonLock');
      } catch {
        // ignore
      }
      break;
    }
    await sleep(100);
  }
}

async function runWorker(argv) {
  const shouldBuild = argv.includes('--build');
  const waitArg = argv.find((a) => a.startsWith('--wait-pid='));
  const explicitPid = waitArg ? Number(waitArg.slice('--wait-pid='.length)) : NaN;
  const passthroughArgs = argv.filter(
    (a) => a !== '--worker' && a !== '--build' && !a.startsWith('--wait-pid=')
  );

  logLine(
    `Restart worker started (pid=${process.pid}, build=${shouldBuild}, waitPid=${Number.isFinite(explicitPid) ? explicitPid : 'auto'})`
  );

  if (shouldBuild) {
    logLine('Running npm run build before restarting...');
    const res = spawnSync('npm', ['run', 'build'], {
      cwd: rootDir,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    if (res.status !== 0) {
      logLine(`Build failed (exit ${res.status}): ${(res.stderr || res.stdout || '').slice(-1500)}`);
      process.exit(res.status ?? 1);
    }
    logLine('Build succeeded.');
  }

  await stopExistingInstances(explicitPid);

  const bin = resolveElectronBinary();
  const env = { ...process.env, NODE_ENV: 'production' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SUPER_HARNESS_APP_PID;
  delete env.VITE_DEV_SERVER_URL;

  const launchArgs = [];
  const hasOzone = passthroughArgs.some((a) => a.startsWith('--ozone-platform'));
  if (!hasOzone && process.env.WAYLAND_DISPLAY) {
    launchArgs.push('--ozone-platform=wayland');
  }
  launchArgs.push('--restarted');
  if (passthroughArgs.length > 0) {
    launchArgs.push(...passthroughArgs);
  } else {
    launchArgs.push('.');
  }

  fs.mkdirSync(configDir, { recursive: true });
  const logFd = fs.openSync(restartLogPath, 'a');
  logLine(`Spawning fresh Super Harness: ${bin} ${launchArgs.join(' ')}`);

  const child = spawn(bin, launchArgs, {
    cwd: rootDir,
    env,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();
  fs.closeSync(logFd);
  logLine(`Fresh Super Harness spawned (pid=${child.pid})`);
}

function scheduleDetachedWorker(argv) {
  const scriptPath = fileURLToPath(import.meta.url);
  const env = { ...process.env, NODE_ENV: 'production' };
  delete env.ELECTRON_RUN_AS_NODE;

  const workerArgs = [scriptPath, '--worker', ...argv];
  if (
    !argv.some((a) => a.startsWith('--wait-pid=')) &&
    process.env.SUPER_HARNESS_APP_PID
  ) {
    workerArgs.push(`--wait-pid=${process.env.SUPER_HARNESS_APP_PID}`);
  }

  const worker = spawn(process.execPath, workerArgs, {
    cwd: rootDir,
    env,
    detached: true,
    stdio: 'ignore',
  });
  worker.unref();
  console.log(`Scheduled detached Super Harness restart (worker pid ${worker.pid}).`);
}

const isDirectEntry =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectEntry) {
  const argv = process.argv.slice(2);
  if (argv.includes('--worker')) {
    runWorker(argv).catch((err) => {
      logLine(`Restart worker failed: ${err instanceof Error ? err.stack || err.message : String(err)}`);
      process.exit(1);
    });
  } else {
    scheduleDetachedWorker(argv);
  }
}
