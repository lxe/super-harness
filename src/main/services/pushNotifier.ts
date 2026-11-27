import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface RegisteredPushDevice {
  rid: string;
  relayUrl: string;
  enabled: boolean;
  /** Whether the phone opted into showing an app-icon unread count badge via APNs. */
  badgeEnabled?: boolean;
  updatedAt: number;
  /**
   * Relay signing key (hex) derived from the token the phone registered with. Paired phones
   * each have their own token, so each needs its own key; legacy registrations omit it and
   * use the key derived from settings.mobileApi.token.
   */
  keyHex?: string;
  /** The paired device this registration belongs to (dropped when that device is revoked). */
  pairedDeviceId?: string;
}

export type PushNotificationKind = 'task_completed' | 'input_needed' | 'background_sync' | 'test';

export interface PushSendPayload {
  kind: PushNotificationKind;
  sessionId?: string;
  title: string;
  body: string;
  harness?: string;
  threadId?: string;
  /** Unread session count to show on the iOS app icon for devices with `badgeEnabled: true`. */
  badge?: number;
  /** Optional APNs collapse identifier (<= 64 ASCII chars) to prevent duplicate banners for the same event. */
  collapseId?: string;
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
 * Sends APNs push notifications through the Superharness Cloudflare Push Relay
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
        const latestByPairedId = new Map<string, RegisteredPushDevice>();
        let hadDuplicates = false;
        for (const d of raw) {
          if (d && typeof d.rid === 'string' && d.rid.length > 0) {
            const normalized: RegisteredPushDevice = {
              rid: d.rid,
              relayUrl: (d.relayUrl || DEFAULT_RELAY_URL).replace(/\/+$/, ''),
              enabled: d.enabled !== false,
              ...(typeof d.badgeEnabled === 'boolean' ? { badgeEnabled: d.badgeEnabled } : {}),
              updatedAt: typeof d.updatedAt === 'number' ? d.updatedAt : Date.now(),
              ...(typeof d.keyHex === 'string' && /^[0-9a-f]{64}$/.test(d.keyHex) ? { keyHex: d.keyHex } : {}),
              ...(typeof d.pairedDeviceId === 'string' ? { pairedDeviceId: d.pairedDeviceId } : {}),
            };
            if (normalized.pairedDeviceId) {
              const prev = latestByPairedId.get(normalized.pairedDeviceId);
              if (prev) {
                hadDuplicates = true;
                if (normalized.updatedAt >= prev.updatedAt) {
                  this.devices.delete(prev.rid);
                  latestByPairedId.set(normalized.pairedDeviceId, normalized);
                  this.devices.set(normalized.rid, normalized);
                }
              } else {
                latestByPairedId.set(normalized.pairedDeviceId, normalized);
                this.devices.set(normalized.rid, normalized);
              }
            } else {
              this.devices.set(normalized.rid, normalized);
            }
          }
        }
        if (hadDuplicates) {
          this.saveDevices();
        }
      }
    } catch {
      // ignore corrupt file
    }
  }

  private saveDevices(): void {
    try {
      fs.mkdirSync(path.dirname(this.devicesFile), { recursive: true });
      fs.writeFileSync(this.devicesFile, JSON.stringify([...this.devices.values()], null, 2), { mode: 0o600 });
    } catch {
      // ignore write errors
    }
  }

  registerDevice(opts: {
    rid?: string;
    relayUrl?: string;
    enabled?: boolean;
    badgeEnabled?: boolean;
    authToken?: string;
    pairedDeviceId?: string;
  }): RegisteredPushDevice | null {
    const legacy = this.getMobileToken().trim();
    const authToken = opts.authToken?.trim() || legacy;
    if (!authToken) return null;
    const derived = deriveRelayCredentials(authToken);
    const rid = (opts.rid || derived.rid).trim();
    const relayUrl = (opts.relayUrl || DEFAULT_RELAY_URL).trim().replace(/\/+$/, '');
    const prevSame = this.devices.get(rid);
    const resolvedBadgeEnabled =
      typeof opts.badgeEnabled === 'boolean' ? opts.badgeEnabled : prevSame?.badgeEnabled;
    const record: RegisteredPushDevice = {
      rid,
      relayUrl,
      enabled: opts.enabled !== false,
      ...(typeof resolvedBadgeEnabled === 'boolean' ? { badgeEnabled: resolvedBadgeEnabled } : {}),
      updatedAt: Date.now(),
      ...(authToken !== legacy ? { keyHex: derived.key.toString('hex') } : {}),
      ...(opts.pairedDeviceId ? { pairedDeviceId: opts.pairedDeviceId } : {}),
    };
    // Replace any stale registrations for the same paired device so re-pairing never sends duplicate pushes
    if (record.pairedDeviceId) {
      for (const [existingRid, existing] of this.devices) {
        if (existingRid !== rid && existing.pairedDeviceId === record.pairedDeviceId) {
          this.devices.delete(existingRid);
        }
      }
    }
    this.devices.set(rid, record);
    this.saveDevices();
    return { ...record, keyHex: undefined };
  }

  /** Forgets push registrations of a revoked paired device. */
  removePairedDevice(pairedDeviceId: string): void {
    let changed = false;
    for (const [rid, dev] of this.devices) {
      if (dev.pairedDeviceId === pairedDeviceId) {
        this.devices.delete(rid);
        changed = true;
      }
    }
    if (changed) this.saveDevices();
  }

  getRegisteredDevices(): RegisteredPushDevice[] {
    return [...this.devices.values()].map(({ keyHex: _key, ...d }) => d);
  }

  async notify(payload: PushSendPayload, opts?: { bypassCooldown?: boolean }): Promise<{ sent: number; results: Array<{ rid: string; status: number; reason?: string }> }> {
    const token = this.getMobileToken().trim();
    if (this.devices.size === 0) {
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

    const legacyKey = token ? deriveRelayCredentials(token).key : null;
    const { badge: rawBadge, collapseId: explicitCollapseId, ...restPayload } = payload;
    const collapseId =
      explicitCollapseId ||
      (payload.kind !== 'test'
        ? sha256Hex(`${payload.kind}\n${payload.sessionId ?? ''}\n${payload.body}`).slice(0, 32)
        : undefined);
    const basePayload = collapseId ? { ...restPayload, collapseId } : restPayload;
    const validBadge =
      typeof rawBadge === 'number' && Number.isFinite(rawBadge) && rawBadge >= 0
        ? Math.floor(rawBadge)
        : undefined;
    const results: Array<{ rid: string; status: number; reason?: string }> = [];
    let sent = 0;

    for (const dev of this.devices.values()) {
      if (!dev.enabled) continue;
      const key = dev.keyHex ? Buffer.from(dev.keyHex, 'hex') : legacyKey;
      if (!key) continue;
      const devicePayload =
        dev.badgeEnabled === true && validBadge !== undefined
          ? { ...basePayload, badge: validBadge }
          : basePayload;
      const bodyBuf = Buffer.from(JSON.stringify(devicePayload), 'utf8');
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
