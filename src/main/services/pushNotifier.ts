import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface RegisteredPushDevice {
  rid: string;
  relayUrl: string;
  enabled: boolean;
  updatedAt: number;
}

export type PushNotificationKind = 'task_completed' | 'input_needed' | 'background_sync' | 'test';

export interface PushSendPayload {
  kind: PushNotificationKind;
  sessionId?: string;
  title: string;
  body: string;
  harness?: string;
  threadId?: string;
}

const DEFAULT_RELAY_URL = 'https://super-harness-push.lxe-sh.workers.dev';
const COOLDOWN_MS = 12_000;

function sha256Buf(data: string | Buffer): Buffer {
  return crypto.createHash('sha256').update(data).digest();
}

function sha256Hex(data: string | Buffer): string {
  return sha256Buf(data).toString('hex');
}

export function deriveRelayCredentials(mobileApiToken: string): { rid: string; key: Buffer } {
  const key = sha256Buf(`super-harness-push-key:${mobileApiToken}`);
  const rid = sha256Hex(key).slice(0, 32);
  return { rid, key };
}

export function signRelayRequest(
  key: Buffer,
  method: string,
  urlPath: string,
  body: Buffer,
  timestampSec = Math.floor(Date.now() / 1000),
  nonce = crypto.randomBytes(12).toString('hex')
): Record<string, string> {
  const msg = `${method.toUpperCase()}\n${urlPath}\n${timestampSec}\n${nonce}\n${sha256Hex(body)}`;
  const sig = crypto.createHmac('sha256', key).update(msg).digest('hex');
  return {
    'x-sh-time': String(timestampSec),
    'x-sh-nonce': nonce,
    'x-sh-sig': sig,
  };
}

/**
 * Sends APNs push notifications through the Super Harness Cloudflare Push Relay
 * whenever a session completes a task or requests user input / approval.
 */
export class PushNotifier {
  private readonly devicesFile: string;
  private devices = new Map<string, RegisteredPushDevice>();
  private lastSentByKey = new Map<string, number>();

  constructor(private readonly getMobileToken: () => string) {
    this.devicesFile = path.join(os.homedir(), '.config', 'super-harness', 'push-devices.json');
    this.loadDevices();
  }

  private loadDevices(): void {
    try {
      if (!fs.existsSync(this.devicesFile)) return;
      const raw = JSON.parse(fs.readFileSync(this.devicesFile, 'utf8')) as RegisteredPushDevice[];
      if (Array.isArray(raw)) {
        for (const d of raw) {
          if (d && typeof d.rid === 'string' && d.rid.length > 0) {
            this.devices.set(d.rid, {
              rid: d.rid,
              relayUrl: (d.relayUrl || DEFAULT_RELAY_URL).replace(/\/+$/, ''),
              enabled: d.enabled !== false,
              updatedAt: typeof d.updatedAt === 'number' ? d.updatedAt : Date.now(),
            });
          }
        }
      }
    } catch {
      // ignore corrupt file
    }
  }

  private saveDevices(): void {
    try {
      fs.mkdirSync(path.dirname(this.devicesFile), { recursive: true });
      fs.writeFileSync(this.devicesFile, JSON.stringify([...this.devices.values()], null, 2));
    } catch {
      // ignore write errors
    }
  }

  registerDevice(opts: { rid?: string; relayUrl?: string; enabled?: boolean }): RegisteredPushDevice | null {
    const token = this.getMobileToken().trim();
    if (!token) return null;
    const derived = deriveRelayCredentials(token);
    const rid = (opts.rid || derived.rid).trim();
    const relayUrl = (opts.relayUrl || DEFAULT_RELAY_URL).trim().replace(/\/+$/, '');
    const record: RegisteredPushDevice = {
      rid,
      relayUrl,
      enabled: opts.enabled !== false,
      updatedAt: Date.now(),
    };
    this.devices.set(rid, record);
    this.saveDevices();
    return record;
  }

  getRegisteredDevices(): RegisteredPushDevice[] {
    return [...this.devices.values()];
  }

  async notify(payload: PushSendPayload, opts?: { bypassCooldown?: boolean }): Promise<{ sent: number; results: Array<{ rid: string; status: number; reason?: string }> }> {
    const token = this.getMobileToken().trim();
    if (!token || this.devices.size === 0) {
      return { sent: 0, results: [] };
    }

    const dedupeKey = `${payload.kind}:${payload.sessionId ?? 'global'}`;
    const now = Date.now();
    if (!opts?.bypassCooldown) {
      const prev = this.lastSentByKey.get(dedupeKey) ?? 0;
      if (now - prev < COOLDOWN_MS) {
        return { sent: 0, results: [] };
      }
      this.lastSentByKey.set(dedupeKey, now);
    }

    const { key } = deriveRelayCredentials(token);
    const bodyBuf = Buffer.from(JSON.stringify(payload), 'utf8');
    const results: Array<{ rid: string; status: number; reason?: string }> = [];
    let sent = 0;

    for (const dev of this.devices.values()) {
      if (!dev.enabled) continue;
      const urlPath = `/v1/push/${encodeURIComponent(dev.rid)}`;
      const headers = {
        'content-type': 'application/json',
        ...signRelayRequest(key, 'POST', urlPath, bodyBuf),
      };
      try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 8000);
        const res = await fetch(`${dev.relayUrl}${urlPath}`, {
          method: 'POST',
          headers,
          body: bodyBuf,
          signal: ac.signal,
        });
        clearTimeout(timer);
        const data = (await res.json().catch(() => ({}))) as { status?: number; reason?: string; error?: string };
        const status = typeof data.status === 'number' ? data.status : res.status;
        if (res.ok && (status === 200 || status === 202)) sent += 1;
        results.push({ rid: dev.rid.slice(0, 8), status, reason: data.reason || data.error });
      } catch (err) {
        results.push({
          rid: dev.rid.slice(0, 8),
          status: 0,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { sent, results };
  }
}
