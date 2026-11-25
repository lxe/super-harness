import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  DetectedAppOption,
  DetectedSystemApps,
  ExternalAppsSettings,
  FilePreviewData,
} from '../../shared/types';
import { whichBinary } from '../utils/system';

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
