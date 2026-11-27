import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type {
  DetectedAppOption,
  DetectedSystemApps,
  ExternalAppsSettings,
  FilePreviewData,
  UnifiedSession,
} from '../../shared/types';
import { whichBinary } from '../utils/system';

const execFileAsync = promisify(execFile);

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.bmp', '.ico']);
const MARKDOWN_EXTS = new Set(['.md', '.mdx', '.markdown']);
const MAX_PREVIEW_BYTES = 512 * 1024;

let cachedApps: DetectedSystemApps | null = null;

export async function detectSystemApps(): Promise<DetectedSystemApps> {
  if (cachedApps) return cachedApps;

  const editorCandidates: Array<{ id: string; label: string; bin: string; tpl: string }> = [
    { id: 'cursor', label: 'Cursor', bin: 'cursor', tpl: 'cursor --goto {path}:{line}' },
    { id: 'code', label: 'VS Code', bin: 'code', tpl: 'code --goto {path}:{line}' },
    { id: 'zed', label: 'Zed', bin: 'zed', tpl: 'zed {path}:{line}' },
    { id: 'zeditor', label: 'Zed', bin: 'zeditor', tpl: 'zeditor {path}:{line}' },
    { id: 'subl', label: 'Sublime Text', bin: 'subl', tpl: 'subl {path}:{line}' },
    { id: 'kate', label: 'Kate', bin: 'kate', tpl: 'kate -l {line} {path}' },
    { id: 'nvim', label: 'Neovim (in terminal)', bin: 'nvim', tpl: 'nvim +{line} {path}' },
    { id: 'hx', label: 'Helix (in terminal)', bin: 'hx', tpl: 'hx {path}:{line}' },
  ];

  const fmCandidates: Array<{ id: string; label: string; bin: string; tpl: string }> = [
    { id: 'dolphin', label: 'Dolphin', bin: 'dolphin', tpl: 'dolphin {path}' },
    { id: 'nautilus', label: 'Files (Nautilus)', bin: 'nautilus', tpl: 'nautilus {path}' },
    { id: 'thunar', label: 'Thunar', bin: 'thunar', tpl: 'thunar {path}' },
    { id: 'nemo', label: 'Nemo', bin: 'nemo', tpl: 'nemo {path}' },
    { id: 'pcmanfm', label: 'PCManFM', bin: 'pcmanfm', tpl: 'pcmanfm {path}' },
    { id: 'xdg-open', label: 'System Default (xdg-open)', bin: 'xdg-open', tpl: 'xdg-open {path}' },
  ];

  const termCandidates: Array<{ id: string; label: string; bin: string; tpl: string }> = [
    { id: 'kitty', label: 'Kitty', bin: 'kitty', tpl: 'kitty --directory {cwd}' },
    { id: 'ghostty', label: 'Ghostty', bin: 'ghostty', tpl: 'ghostty --working-directory={cwd}' },
    { id: 'alacritty', label: 'Alacritty', bin: 'alacritty', tpl: 'alacritty --working-directory {cwd}' },
    { id: 'wezterm', label: 'WezTerm', bin: 'wezterm', tpl: 'wezterm start --cwd {cwd}' },
    { id: 'foot', label: 'Foot', bin: 'foot', tpl: 'foot --working-directory {cwd}' },
    { id: 'konsole', label: 'Konsole', bin: 'konsole', tpl: 'konsole --workdir {cwd}' },
    { id: 'gnome-terminal', label: 'GNOME Terminal', bin: 'gnome-terminal', tpl: 'gnome-terminal --working-directory={cwd}' },
  ];

  const resolveList = async (
    items: Array<{ id: string; label: string; bin: string; tpl: string }>
  ): Promise<DetectedAppOption[]> => {
    const out: DetectedAppOption[] = [];
    for (const item of items) {
      const bp = await whichBinary(item.bin);
      if (bp) {
        out.push({ id: item.id, label: item.label, command: item.tpl, binaryPath: bp });
      }
    }
    return out;
  };

  const [editors, fileManagers, terminals] = await Promise.all([
    resolveList(editorCandidates),
    resolveList(fmCandidates),
    resolveList(termCandidates),
  ]);

  cachedApps = { editors, fileManagers, terminals };
  return cachedApps;
}

function splitCommandArgs(template: string, vars: Record<string, string>): string[] {
  // Tokenize respecting simple single/double quotes, then substitute placeholders
  const tokens: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < template.length; i++) {
    const ch = template[i];
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) {
        tokens.push(cur);
        cur = '';
      }
    } else {
      cur += ch;
    }
  }
  if (cur) tokens.push(cur);

  return tokens.map((tok) => {
    let out = tok;
    for (const [k, v] of Object.entries(vars)) {
      out = out.replaceAll(`{${k}}`, v);
    }
    return out;
  });
}

function spawnDetached(argv: string[], cwd?: string): void {
  if (argv.length === 0) return;
  const [bin, ...args] = argv;
  const child = spawn(bin, args, {
    cwd: cwd && fs.existsSync(cwd) ? cwd : os.homedir(),
    env: { ...process.env },
    stdio: 'ignore',
    detached: true,
  });
  child.unref();
}

export async function readFilePreview(
  rawPath: string,
  startLine?: number,
  endLine?: number
): Promise<FilePreviewData> {
  const filePath = rawPath.replace(/^file:\/\//, '');
  const name = path.basename(filePath) || filePath;

  if (!fs.existsSync(filePath)) {
    return {
      path: filePath,
      name,
      isDirectory: false,
      kind: 'binary',
      sizeBytes: 0,
      error: `Path does not exist: ${filePath}`,
    };
  }

  try {
    const st = fs.statSync(filePath);
    if (st.isDirectory()) {
      const dirents = fs.readdirSync(filePath, { withFileTypes: true });
      const entries = dirents
        .filter((d) => !d.name.startsWith('.git') || d.name === '.gitignore')
        .map((d) => {
          const full = path.join(filePath, d.name);
          let sizeBytes: number | undefined;
          if (!d.isDirectory()) {
            try {
              sizeBytes = fs.statSync(full).size;
            } catch {
              // ignore
            }
          }
          return { name: d.name, path: full, isDirectory: d.isDirectory(), sizeBytes };
        })
        .sort((a, b) => {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
          return a.name.localeCompare(b.name);
        })
        .slice(0, 300);

      return {
        path: filePath,
        name,
        isDirectory: true,
        kind: 'directory',
        sizeBytes: entries.length,
        entries,
      };
    }

    const ext = path.extname(filePath).toLowerCase();
    if (IMAGE_EXTS.has(ext)) {
      return {
        path: filePath,
        name,
        isDirectory: false,
        kind: 'image',
        sizeBytes: st.size,
      };
    }

    const readBytes = Math.min(st.size, MAX_PREVIEW_BYTES);
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(readBytes);
    fs.readSync(fd, buf, 0, readBytes, 0);
    fs.closeSync(fd);

    // Detect binary files via NUL byte in first 4KB
    const sample = buf.subarray(0, Math.min(buf.length, 4096));
    if (sample.includes(0)) {
      return {
        path: filePath,
        name,
        isDirectory: false,
        kind: 'binary',
        sizeBytes: st.size,
      };
    }

    let content = buf.toString('utf8');
    if (st.size > MAX_PREVIEW_BYTES) {
      content += `\n\n… (truncated at ${Math.round(MAX_PREVIEW_BYTES / 1024)} KB of ${Math.round(st.size / 1024)} KB)`;
    }
    const lineCount = content.split('\n').length;

    return {
      path: filePath,
      name,
      isDirectory: false,
      kind: MARKDOWN_EXTS.has(ext) ? 'markdown' : 'code',
      content,
      sizeBytes: st.size,
      lineCount,
      startLine,
      endLine,
    };
  } catch (err) {
    return {
      path: filePath,
      name,
      isDirectory: false,
      kind: 'binary',
      sizeBytes: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function openPathWithApp(
  rawPath: string,
  requestedMode: 'auto' | 'internal' | 'editor' | 'file-manager' | 'terminal' | 'system',
  apps: ExternalAppsSettings,
  opts?: { line?: number; tmuxSession?: string }
): Promise<{ ok: boolean; action?: 'internal' | 'launched'; error?: string }> {
  const targetPath = rawPath.replace(/^file:\/\//, '');
  if (!fs.existsSync(targetPath)) {
    return { ok: false, error: `Path does not exist: ${targetPath}` };
  }

  const st = fs.statSync(targetPath);
  const isDir = st.isDirectory();
  const dirForTarget = isDir ? targetPath : path.dirname(targetPath);

  const effectiveMode =
    requestedMode === 'auto'
      ? isDir
        ? apps.folderClickAction
        : apps.fileClickAction
      : requestedMode;

  if (effectiveMode === 'internal') {
    return { ok: true, action: 'internal' };
  }

  const detected = await detectSystemApps();

  try {
    if (effectiveMode === 'system') {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { shell } = require('electron') as typeof import('electron');
        const errMsg = await shell.openPath(targetPath);
        return errMsg ? { ok: false, error: errMsg } : { ok: true, action: 'launched' };
      } catch {
        spawnDetached(['xdg-open', targetPath], dirForTarget);
        return { ok: true, action: 'launched' };
      }
    }

    if (effectiveMode === 'editor') {
      const tpl =
        apps.editorCommand?.trim() ||
        detected.editors[0]?.command ||
        'xdg-open {path}';
      const lineStr = String(opts?.line && opts.line > 0 ? opts.line : 1);

      // If user chose a terminal editor (nvim/hx/vim), launch inside their default terminal!
      const firstBin = tpl.trim().split(/\s+/)[0];
      if (['nvim', 'vim', 'hx', 'helix', 'nano'].includes(firstBin)) {
        const termTpl =
          apps.terminalCommand?.trim() ||
          detected.terminals[0]?.command ||
          'kitty --directory {cwd}';
        const termArgv = splitCommandArgs(termTpl, { cwd: dirForTarget, path: dirForTarget });
        const edArgv = splitCommandArgs(tpl, { path: targetPath, line: lineStr, cwd: dirForTarget });
        spawnDetached([...termArgv, '-e', ...edArgv], dirForTarget);
      } else {
        const argv = splitCommandArgs(tpl, {
          path: targetPath,
          line: lineStr,
          cwd: dirForTarget,
        });
        // If template didn't include {path}, append targetPath automatically
        if (!tpl.includes('{path}')) argv.push(targetPath);
        spawnDetached(argv, dirForTarget);
      }
      return { ok: true, action: 'launched' };
    }

    if (effectiveMode === 'file-manager') {
      const tpl =
        apps.fileManagerCommand?.trim() ||
        detected.fileManagers[0]?.command ||
        'xdg-open {path}';
      const argv = splitCommandArgs(tpl, { path: dirForTarget, cwd: dirForTarget });
      if (!tpl.includes('{path}') && !tpl.includes('{cwd}')) argv.push(dirForTarget);
      spawnDetached(argv, dirForTarget);
      return { ok: true, action: 'launched' };
    }

    if (effectiveMode === 'terminal') {
      const tpl =
        apps.terminalCommand?.trim() ||
        detected.terminals[0]?.command ||
        'kitty --directory {cwd}';
      const argv = splitCommandArgs(tpl, { cwd: dirForTarget, path: dirForTarget });
      if (opts?.tmuxSession) {
        argv.push('-e', 'tmux', 'attach-session', '-t', opts.tmuxSession);
      }
      spawnDetached(argv, dirForTarget);
      return { ok: true, action: 'launched' };
    }

    return { ok: false, error: `Unknown open mode: ${effectiveMode}` };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function findDesktopExecBinary(desktopNames: string[]): string | null {
  if (process.platform !== 'linux') return null;
  const dirs = [
    path.join(os.homedir(), '.local', 'share', 'applications'),
    '/usr/local/share/applications',
    '/usr/share/applications',
  ];
  for (const name of desktopNames) {
    for (const dir of dirs) {
      const p = path.join(dir, name);
      if (!fs.existsSync(p)) continue;
      try {
        const text = fs.readFileSync(p, 'utf8');
        const match = text.match(/^Exec=(.+)$/m);
        if (!match) continue;
        const tokens = match[1]
          .trim()
          .split(/\s+/)
          .filter((t) => !/^%[a-zA-Z]$/.test(t));
        let idx = 0;
        if (tokens[0] === 'env') {
          idx = 1;
          while (idx < tokens.length && tokens[idx].includes('=')) idx++;
        }
        const bin = tokens[idx]?.replace(/^["']|["']$/g, '');
        if (bin && (!bin.startsWith('/') || fs.existsSync(bin))) {
          return bin;
        }
      } catch {
        // ignore unreadable desktop entries
      }
    }
  }
  return null;
}

async function focusDesktopWindowByClass(classes: string[]): Promise<boolean> {
  if (process.platform !== 'linux') return false;
  const targets = classes.map((c) => c.toLowerCase());
  if (process.env.HYPRLAND_INSTANCE_SIGNATURE) {
    try {
      const { stdout } = await execFileAsync('hyprctl', ['clients', '-j'], { timeout: 2000 });
      const clients = JSON.parse(stdout) as Array<{
        address?: string;
        class?: string;
        initialClass?: string;
      }>;
      const hit = clients.find((c) => {
        const cls = (c.class || '').toLowerCase();
        const init = (c.initialClass || '').toLowerCase();
        return targets.includes(cls) || targets.includes(init);
      });
      if (hit?.address) {
        await execFileAsync('hyprctl', ['dispatch', 'focuswindow', `address:${hit.address}`], {
          timeout: 2000,
        });
        return true;
      }
    } catch {
      // ignore compositor errors
    }
  }
  return false;
}

async function focusExistingTmuxClientWindow(tmuxSessionName: string): Promise<boolean> {
  if (process.platform !== 'linux' || !process.env.HYPRLAND_INSTANCE_SIGNATURE) return false;
  try {
    const { stdout: clientOut } = await execFileAsync(
      'tmux',
      ['list-clients', '-t', tmuxSessionName, '-F', '#{client_pid}'],
      { timeout: 2000 }
    );
    const clientPids = clientOut
      .split('\n')
      .map((l) => Number.parseInt(l.trim(), 10))
      .filter((n) => Number.isFinite(n) && n > 1);
    if (clientPids.length === 0) return false;

    const ancestorPids = new Set<number>();
    for (const startPid of clientPids) {
      let pid = startPid;
      for (let depth = 0; depth < 8 && pid > 1; depth++) {
        ancestorPids.add(pid);
        try {
          const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
          const afterComm = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
          const ppid = Number.parseInt(afterComm[1] || '', 10);
          if (!Number.isFinite(ppid) || ppid <= 1 || ppid === pid) break;
          pid = ppid;
        } catch {
          break;
        }
      }
    }

    const { stdout: hyprOut } = await execFileAsync('hyprctl', ['clients', '-j'], { timeout: 2000 });
    const clients = JSON.parse(hyprOut) as Array<{ address?: string; pid?: number }>;
    const hit = clients.find(
      (c) => c.address && typeof c.pid === 'number' && ancestorPids.has(c.pid)
    );
    if (hit?.address) {
      await execFileAsync('hyprctl', ['dispatch', 'focuswindow', `address:${hit.address}`], {
        timeout: 2000,
      });
      return true;
    }
  } catch {
    // fall back to spawning a new terminal attached to the tmux session
  }
  return false;
}

async function launchTerminalWithCommand(
  cmdArgv: string[],
  cwd: string,
  apps: ExternalAppsSettings
): Promise<void> {
  const detected = await detectSystemApps();
  const safeCwd = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  const tpl =
    apps.terminalCommand?.trim() ||
    detected.terminals[0]?.command ||
    'kitty --directory {cwd}';
  const argv = splitCommandArgs(tpl, { cwd: safeCwd, path: safeCwd });
  const firstBin = path.basename(argv[0] || '');
  if (firstBin === 'kitty') {
    argv.push(...cmdArgv);
  } else if (firstBin === 'wezterm') {
    argv.push('--', ...cmdArgv);
  } else {
    argv.push('-e', ...cmdArgv);
  }
  spawnDetached(argv, safeCwd);
}

/**
 * Opens a session directly in its native external harness (desktop app deep link
 * with compositor focus on Hyprland/Wayland, or configured terminal attached to
 * tmux / CLI resume).
 */
export async function openSessionInHarness(
  session: UnifiedSession,
  apps: ExternalAppsSettings
): Promise<{ ok: boolean; via?: string; error?: string }> {
  const cwd = session.cwd && fs.existsSync(session.cwd) ? session.cwd : os.homedir();

  const openDesktopDeepLink = async (
    url: string,
    desktopNames: string[],
    windowClasses: string[]
  ): Promise<boolean> => {
    const directBin = findDesktopExecBinary(desktopNames);
    if (directBin) {
      spawnDetached([directBin, url], cwd);
      // Wayland compositors (e.g. Hyprland) block background apps from stealing focus; focus explicitly
      void focusDesktopWindowByClass(windowClasses);
      return true;
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { shell } = require('electron') as typeof import('electron');
      await shell.openExternal(url);
      void focusDesktopWindowByClass(windowClasses);
      return true;
    } catch {
      return false;
    }
  };

  try {
    // 1. Live tmux session (Claude tmux or Muse tmux, local or remote SSH)
    if (session.tmuxSessionName) {
      const tmuxSession = session.tmuxSessionName.split(':')[0];
      if (session.hostAddress) {
        const remoteCmd = `export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; exec tmux attach-session -t ${shSingleQuote(tmuxSession)}`;
        await launchTerminalWithCommand(
          ['ssh', '-t', session.hostAddress, remoteCmd],
          os.homedir(),
          apps
        );
        return { ok: true, via: `ssh tmux (${session.hostAddress})` };
      }

      // Select the exact window/pane if tmuxTarget includes one
      if (session.tmuxTarget && session.tmuxTarget.includes(':')) {
        try {
          await execFileAsync('tmux', ['select-window', '-t', session.tmuxTarget], { timeout: 1500 });
          await execFileAsync('tmux', ['select-pane', '-t', session.tmuxTarget], { timeout: 1500 });
        } catch {
          // ignore if session has only one pane
        }
      }

      if (await focusExistingTmuxClientWindow(tmuxSession)) {
        return { ok: true, via: `focused tmux:${tmuxSession}` };
      }

      await launchTerminalWithCommand(
        ['tmux', 'attach-session', '-t', tmuxSession],
        cwd,
        apps
      );
      return { ok: true, via: `tmux:${tmuxSession}` };
    }

    // 2. OpenAI Codex: deep-link Codex Desktop straight to the thread, fallback to CLI resume
    if (session.harness === 'codex') {
      const codexUrl = `codex://threads/${encodeURIComponent(session.nativeId)}`;
      const hasCodexDesktop =
        Boolean(findDesktopExecBinary(['codex-desktop.desktop'])) || process.platform === 'darwin';
      if (
        hasCodexDesktop &&
        (await openDesktopDeepLink(codexUrl, ['codex-desktop.desktop'], ['codex-desktop', 'ChatGPT']))
      ) {
        return { ok: true, via: 'Codex Desktop' };
      }
      const codexBin = (await whichBinary('codex')) || 'codex';
      await launchTerminalWithCommand([codexBin, 'resume', session.nativeId], cwd, apps);
      return { ok: true, via: 'Codex CLI' };
    }

    // 3. Google Antigravity: deep-link Antigravity Desktop to conversation, fallback to agy CLI
    if (session.harness === 'antigravity') {
      const agyUrl = `antigravity://conversation/${encodeURIComponent(session.nativeId)}`;
      const hasAgyDesktop =
        Boolean(findDesktopExecBinary(['antigravity.desktop'])) || process.platform === 'darwin';
      if (
        hasAgyDesktop &&
        (await openDesktopDeepLink(agyUrl, ['antigravity.desktop'], ['antigravity', 'Antigravity']))
      ) {
        return { ok: true, via: 'Antigravity Desktop' };
      }
      const agyBin = (await whichBinary('agy')) || 'agy';
      await launchTerminalWithCommand([agyBin, '--resume', session.nativeId], cwd, apps);
      return { ok: true, via: 'Antigravity CLI' };
    }

    // 4. Claude Desktop: deep-link directly to the Claude Code session when nativeId is present
    if (session.harness === 'claude-desktop') {
      const claudeUrl = session.nativeId
        ? `claude://code/continue?session=${encodeURIComponent(session.nativeId)}`
        : 'claude://';
      if (
        await openDesktopDeepLink(
          claudeUrl,
          ['com.anthropic.Claude.desktop', 'claude-desktop.desktop'],
          ['com.anthropic.Claude', 'claude-desktop', 'Claude']
        )
      ) {
        return { ok: true, via: 'Claude Desktop' };
      }
      return { ok: false, error: 'Could not open Claude Desktop' };
    }

    // 5. Claude CLI (local or remote SSH)
    if (session.harness === 'claude-cli' || session.harness === 'claude-tmux') {
      if (session.hostAddress) {
        const remoteDir = session.cwd ? `cd ${shSingleQuote(session.cwd)} && ` : '';
        const remoteCmd = `export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; ${remoteDir}exec claude --resume ${shSingleQuote(session.nativeId)}`;
        await launchTerminalWithCommand(
          ['ssh', '-t', session.hostAddress, remoteCmd],
          os.homedir(),
          apps
        );
        return { ok: true, via: `ssh claude (${session.hostAddress})` };
      }
      const claudeBin = (await whichBinary('claude')) || 'claude';
      await launchTerminalWithCommand([claudeBin, '--resume', session.nativeId], cwd, apps);
      return { ok: true, via: 'Claude CLI' };
    }

    // 6. Muse
    if (session.harness === 'muse') {
      const museBin = (await whichBinary('muse')) || 'muse';
      await launchTerminalWithCommand([museBin, 'resume', session.nativeId], cwd, apps);
      return { ok: true, via: 'Muse CLI' };
    }

    // 7. Pi
    if (session.harness === 'pi') {
      const piBin = (await whichBinary('pi')) || 'pi';
      const args = session.nativeId ? [piBin, '--session', session.nativeId] : [piBin];
      await launchTerminalWithCommand(args, cwd, apps);
      return { ok: true, via: 'Pi CLI' };
    }

    return { ok: false, error: `Opening external harness is not supported for ${session.harness}` };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
