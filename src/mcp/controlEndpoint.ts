import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Where the running desktop app publishes its loopback Control API (URL + per-launch token),
 * readable only by the current user. Lets the `superharness` CLI and a standalone
 * `super-harness-mcp` reach the app from any terminal or harness, not only the Master Session.
 */
export const CONTROL_ENDPOINT_FILE = path.join(os.homedir(), '.config', 'super-harness', 'control.json');

export interface ControlEndpoint {
  url: string;
  token: string;
}

/** `SUPER_HARNESS_URL` + `SUPER_HARNESS_TOKEN` win; otherwise the file the running app wrote. */
export function resolveControlEndpoint(): ControlEndpoint | null {
  const envUrl = process.env.SUPER_HARNESS_URL || '';
  const envToken = process.env.SUPER_HARNESS_TOKEN || '';
  if (envUrl && envToken) return { url: envUrl, token: envToken };
  try {
    const raw = JSON.parse(fs.readFileSync(CONTROL_ENDPOINT_FILE, 'utf8')) as Partial<ControlEndpoint>;
    if (typeof raw.url === 'string' && typeof raw.token === 'string' && raw.url && raw.token) {
      return { url: raw.url, token: raw.token };
    }
  } catch {
    // Not running, or never started on this machine.
  }
  return null;
}

/** Called by the app once its Control API listens. Mode 0600: the token grants full control. */
export function writeControlEndpoint(endpoint: ControlEndpoint): void {
  fs.mkdirSync(path.dirname(CONTROL_ENDPOINT_FILE), { recursive: true });
  const tmp = `${CONTROL_ENDPOINT_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ ...endpoint, pid: process.pid }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, CONTROL_ENDPOINT_FILE);
}

/** Removes the file on shutdown, unless another instance has replaced it since. */
export function removeControlEndpoint(token: string): void {
  try {
    const raw = JSON.parse(fs.readFileSync(CONTROL_ENDPOINT_FILE, 'utf8')) as Partial<ControlEndpoint>;
    if (raw.token === token) fs.unlinkSync(CONTROL_ENDPOINT_FILE);
  } catch {
    // Already gone.
  }
}
