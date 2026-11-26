import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import type { ImageAttachment } from '../../shared/types';
import { whichBinary } from '../utils/system';

const execFileAsync = promisify(execFile);

export interface A11yDispatchResult {
  ok: boolean;
  dispatchedVia?: string;
  reason?: string;
}

const PY_SELECT_AND_FOCUS = `
import json, sys, time
import gi
gi.require_version("Atspi", "2.0")
from gi.repository import Atspi

target_title = (sys.argv[1] or "").strip().lower()
desktop = Atspi.get_desktop(0)
app = None
for i in range(desktop.get_child_count()):
    c = desktop.get_child_at_index(i)
    if c and "claude" in (c.get_name() or "").lower():
        app = c
        break

if not app:
    print(json.dumps({"ok": False, "reason": "claude_not_in_atspi"}))
    sys.exit(0)

def find_links(node, out, depth=0):
    if depth > 36:
        return
    try:
        if node.get_role_name() == "link":
            name = (node.get_name() or "").strip()
            if name:
                out.append((name, node))
        for i in range(min(node.get_child_count(), 350)):
            ch = node.get_child_at_index(i)
            if ch:
                find_links(ch, out, depth + 1)
    except Exception:
        pass

def find_prompt_entry(node, out, depth=0):
    if depth > 45:
        return
    try:
        role = node.get_role_name()
        if role == "entry":
            out.append((node.get_name() or "", node))
        for i in range(min(node.get_child_count(), 350)):
            ch = node.get_child_at_index(i)
            if ch:
                find_prompt_entry(ch, out, depth + 1)
    except Exception:
        pass

matched_link = None
if target_title:
    links = []
    find_links(app, links)
    best_score = -1
    for name, node in links:
        low = name.lower()
        score = -1
        if low == target_title or low == target_title + " open":
            score = 100 if low.endswith(" open") else 90
        elif low.startswith(target_title + " "):
            score = 80 if " open" in low else 70
        elif target_title in low:
            score = 50 if " open" in low else 40
        if score > best_score:
            best_score = score
            matched_link = (name, node)

if not matched_link:
    print(json.dumps({"ok": False, "reason": "session_not_found_in_sidebar"}))
    sys.exit(0)

link_name, link_node = matched_link
act = link_node.get_action_iface()
if act and act.get_n_actions() > 0:
    act.do_action(0)
    time.sleep(0.22)

entries = []
find_prompt_entry(app, entries)
if not entries:
    time.sleep(0.25)
    find_prompt_entry(app, entries)

if not entries:
    print(json.dumps({"ok": False, "reason": "prompt_entry_not_found"}))
    sys.exit(0)

# Prefer entry named Prompt / Reply, otherwise last visible entry in the web document
chosen_name, chosen_entry = entries[-1]
for ename, enode in entries:
    if any(k in ename.lower() for k in ("prompt", "reply", "message")):
        chosen_name, chosen_entry = ename, enode
        break

eact = chosen_entry.get_action_iface()
if eact and eact.get_n_actions() > 0:
    eact.do_action(0)
comp = chosen_entry.get_component_iface()
if comp:
    try:
        comp.grab_focus()
    except Exception:
        pass

print(json.dumps({"ok": True, "matchedLink": link_name, "entryName": chosen_name}))
`;

const PY_CHECK_AVAILABLE = `
import json
import gi
gi.require_version("Atspi", "2.0")
from gi.repository import Atspi
desktop = Atspi.get_desktop(0)
found = False
for i in range(desktop.get_child_count()):
    c = desktop.get_child_at_index(i)
    if c and "claude" in (c.get_name() or "").lower():
        found = True
        break
print(json.dumps({"available": found}))
`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeClipboardStdin(wlCopyBin: string, data: Buffer, mimeType?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = mimeType ? ['--type', mimeType] : [];
    const child = spawn(wlCopyBin, args, { stdio: ['pipe', 'ignore', 'ignore'] });
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
      resolve();
    }, 1500);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve();
    });
    child.stdin.end(data);
  });
}

async function getActiveHyprlandWindowAddress(hyprctlBin: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(hyprctlBin, ['activewindow', '-j'], { timeout: 1500 });
    const parsed = JSON.parse(stdout) as { address?: string };
    return typeof parsed.address === 'string' && parsed.address ? parsed.address : null;
  } catch {
    return null;
  }
}

/**
 * Checks whether Claude Desktop is currently exposing its documented AT-SPI2
 * accessibility tree (requires launching Claude Desktop with `--force-renderer-accessibility`
 * or desktop `ACCESSIBILITY_ENABLED=1`).
 */
export async function isClaudeDesktopA11yAvailable(): Promise<boolean> {
  const py = await whichBinary('python3');
  if (!py) return false;
  try {
    const { stdout } = await execFileAsync(py, ['-c', PY_CHECK_AVAILABLE], { timeout: 2500 });
    const parsed = JSON.parse(stdout.trim()) as { available?: boolean };
    return Boolean(parsed.available);
  } catch {
    return false;
  }
}

/**
 * Sends a prompt (and optional image attachments) directly into an open Claude Desktop
 * conversation tab via documented Linux AT-SPI2 + Wayland clipboard/wtype, restoring
 * Hyprland focus back to the caller window immediately after submission.
 *
 * Returns `{ ok: false }` cleanly whenever AT-SPI2 isn't active or tools are missing
 * so callers can fall back seamlessly to `ClaudeStreamPool`.
 */
export async function sendToClaudeDesktopViaA11y(opts: {
  sessionTitle: string;
  prompt: string;
  attachments?: ImageAttachment[];
}): Promise<A11yDispatchResult> {
  const [pyBin, hyprctlBin, wlCopyBin, wtypeBin] = await Promise.all([
    whichBinary('python3'),
    whichBinary('hyprctl'),
    whichBinary('wl-copy'),
    whichBinary('wtype'),
  ]);
  if (!pyBin || !hyprctlBin || !wlCopyBin || !wtypeBin) {
    return { ok: false, reason: 'missing_wayland_a11y_tools' };
  }

  // Fast pre-check before touching window focus
  if (!(await isClaudeDesktopA11yAvailable())) {
    return { ok: false, reason: 'claude_not_in_atspi' };
  }

  const prevAddress = await getActiveHyprlandWindowAddress(hyprctlBin);
  try {
    // 1. Select the target conversation in Claude Desktop & activate its Prompt entry via AT-SPI2
    const { stdout } = await execFileAsync(pyBin, ['-c', PY_SELECT_AND_FOCUS, opts.sessionTitle], {
      timeout: 5000,
    });
    const res = JSON.parse(stdout.trim()) as { ok?: boolean; reason?: string };
    if (!res.ok) {
      return { ok: false, reason: res.reason || 'a11y_select_failed' };
    }

    // 2. Focus Claude Desktop briefly so Wayland Ctrl+V + Return land in the activated Prompt box
    await execFileAsync(
      hyprctlBin,
      ['dispatch', 'focuswindow', 'class:^(com\\.anthropic\\.Claude|claude-desktop|Claude)$'],
      { timeout: 1500 }
    );
    await sleep(110);

    // 3. Paste any attached images directly into Claude Desktop's composer
    if (opts.attachments && opts.attachments.length > 0) {
      for (const att of opts.attachments) {
        if (!att.path || !fs.existsSync(att.path)) continue;
        const mime = att.mimeType && att.mimeType.startsWith('image/') ? att.mimeType : 'image/png';
        const bytes = fs.readFileSync(att.path);
        await writeClipboardStdin(wlCopyBin, bytes, mime);
        await sleep(50);
        await execFileAsync(wtypeBin, ['-M', 'ctrl', '-k', 'v', '-m', 'ctrl'], { timeout: 1500 });
        await sleep(180);
      }
    }

    // 4. Paste prompt text and submit with Return
    const trimmed = opts.prompt.trim();
    if (trimmed) {
      await writeClipboardStdin(wlCopyBin, Buffer.from(trimmed, 'utf8'));
      await sleep(40);
      await execFileAsync(wtypeBin, ['-M', 'ctrl', '-k', 'v', '-m', 'ctrl'], { timeout: 1500 });
      await sleep(90);
    }

    await execFileAsync(wtypeBin, ['-k', 'Return'], { timeout: 1500 });
    await sleep(80);

    return {
      ok: true,
      dispatchedVia:
        opts.attachments && opts.attachments.length > 0
          ? `Claude Desktop live (${opts.attachments.length} image${opts.attachments.length === 1 ? '' : 's'})`
          : 'Claude Desktop live',
    };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  } finally {
    // Always restore Hyprland focus right back to Super Harness (or previous window)
    if (prevAddress) {
      try {
        await execFileAsync(hyprctlBin, ['dispatch', 'focuswindow', `address:${prevAddress}`], {
          timeout: 1500,
        });
      } catch {
        // ignore focus restore failure
      }
    }
  }
}
