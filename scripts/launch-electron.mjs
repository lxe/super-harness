#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function resolveElectronBinary() {
  const localPathTxt = path.join(rootDir, 'node_modules', 'electron', 'path.txt');
  if (fs.existsSync(localPathTxt)) {
    const rel = fs.readFileSync(localPathTxt, 'utf8').trim();
    const candidate = path.join(rootDir, 'node_modules', 'electron', 'dist', rel);
    if (fs.existsSync(candidate)) return candidate;
  }
  const systemCandidates = ['/usr/bin/electron', '/usr/local/bin/electron'];
  for (const c of systemCandidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'electron';
}

const bin = resolveElectronBinary();
const args = process.argv.slice(2);
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
