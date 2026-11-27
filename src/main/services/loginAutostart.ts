import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Adds Superharness to the desktop's login autostart (Linux, XDG), so Claude
 * tmux sessions come back after a reboot without opening the app by hand.
 *
 * It installs the entry once. If the user later deletes
 * ~/.config/autostart/super-harness.desktop, the marker file keeps it from
 * coming back.
 */
export function ensureLoginAutostart(opts: { execLine: string; log?: (m: string) => void }): void {
  if (process.platform !== 'linux') return;
  const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const entry = path.join(configDir, 'autostart', 'super-harness.desktop');
  const marker = path.join(configDir, 'super-harness', 'login-autostart-installed');
  try {
    if (fs.existsSync(entry) || fs.existsSync(marker)) return;

    // Reuse the installed launcher's command when there is one; it carries the right flags.
    const installed = path.join(os.homedir(), '.local', 'share', 'applications', 'super-harness.desktop');
    let exec = opts.execLine;
    let workDir: string | undefined;
    if (fs.existsSync(installed)) {
      const text = fs.readFileSync(installed, 'utf8');
      exec = text.match(/^Exec=(.+)$/m)?.[1]?.trim() || exec;
      workDir = text.match(/^Path=(.+)$/m)?.[1]?.trim();
    }

    const lines = [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Superharness',
      'Comment=Start Superharness at login and bring back Claude tmux sessions',
      `Exec=${exec}`,
      ...(workDir ? [`Path=${workDir}`] : []),
      'Icon=super-harness',
      'Terminal=false',
      'X-GNOME-Autostart-enabled=true',
      '',
    ];
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, lines.join('\n'));
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, `${new Date().toISOString()}\n`);
    opts.log?.(`[autostart] added ${entry}`);
  } catch (err) {
    opts.log?.(`[autostart] could not add login entry: ${err instanceof Error ? err.message : String(err)}`);
  }
}
