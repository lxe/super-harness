import crypto from 'node:crypto';
import os from 'node:os';
import type { MobileApiSettings, PairedDevice, SuperHarnessSettings, SuperHarnessState } from '../../shared/types';

/**
 * Phone pairing: the desktop shows a one-time 6-digit code (and a QR code carrying it); a phone
 * that POSTs the code to /api/pair gets its own Bearer token. Only a sha256 of each token is
 * stored (settings.mobileApi.pairedDevices). Codes and tokens are never logged.
 */

export const PAIRING_CODE_TTL_MS = 10 * 60 * 1000;
export const PAIRING_MAX_WRONG_ATTEMPTS = 5;
/** Per-address limit on POST /api/pair, independent of the code's own attempt counter. */
export const PAIRING_RATE_LIMIT = { windowMs: 60_000, max: 10 };
const LAST_SEEN_THROTTLE_MS = 2 * 60 * 1000;

interface StoreLike {
  getState(): SuperHarnessState;
  updateSettings(patch: Partial<SuperHarnessSettings>): SuperHarnessState;
}

export interface PairingCode {
  code: string;
  expiresAt: number;
}

export type PairingEvent =
  | { type: 'paired'; device: { id: string; name: string } }
  | { type: 'closed'; reason: 'expired' | 'too_many_attempts' | 'cancelled' | 'paired' };

export type PairAttemptResult =
  | { status: 200; body: { ok: true; token: string; hostId: string; hostName: string } }
  | { status: 401 | 429 | 400; body: { ok: false; error: string } };

export type AuthResult = { kind: 'legacy' } | { kind: 'device'; deviceId: string };

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function desktopName(): string {
  const h = os.hostname().replace(/\.local$/, '');
  return h || 'Desktop';
}

export interface PairingServiceOptions {
  now?: () => number;
  hostName?: () => string;
  version?: string;
  onEvent?: (ev: PairingEvent) => void;
  /** Called after a device is revoked, so open connections and push keys can be dropped. */
  onRevoke?: (deviceId: string) => void;
}

export class PairingService {
  private active: (PairingCode & { wrongAttempts: number }) | null = null;
  private expiryTimer: NodeJS.Timeout | null = null;
  private attemptsByAddress = new Map<string, number[]>();
  private lastSeenWritten = new Map<string, number>();
  private readonly now: () => number;

  constructor(
    private readonly store: StoreLike,
    private readonly opts: PairingServiceOptions = {}
  ) {
    this.now = opts.now ?? Date.now;
  }

  get hostName(): string {
    return this.opts.hostName?.() ?? desktopName();
  }

  get version(): string {
    return this.opts.version ?? '';
  }

  private mobile(): MobileApiSettings | undefined {
    return this.store.getState().settings.mobileApi;
  }

  /** The stable host id (created and saved on first use). */
  hostId(): string {
    const mobile = this.mobile();
    if (mobile?.hostId) return mobile.hostId;
    const hostId = crypto.randomBytes(8).toString('hex');
    this.updateMobile({ hostId });
    return hostId;
  }

  private updateMobile(patch: Partial<MobileApiSettings>): void {
    const cur = this.mobile();
    this.store.updateSettings({
      mobileApi: {
        enabled: cur?.enabled ?? false,
        bindHost: cur?.bindHost ?? '0.0.0.0',
        port: cur?.port ?? 47890,
        token: cur?.token ?? '',
        ...cur,
        ...patch,
      },
    });
  }

  pairingOpen(): boolean {
    this.expireIfDue();
    return this.active !== null;
  }

  /** Starts (or restarts) pairing with a fresh one-time code. */
  open(): PairingCode {
    this.clearActive();
    const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
    const expiresAt = this.now() + PAIRING_CODE_TTL_MS;
    this.active = { code, expiresAt, wrongAttempts: 0 };
    this.expiryTimer = setTimeout(() => this.expireIfDue(), PAIRING_CODE_TTL_MS + 50);
    this.expiryTimer.unref?.();
    return { code, expiresAt };
  }

  close(reason: 'cancelled' | 'paired' | 'expired' | 'too_many_attempts' = 'cancelled'): void {
    const wasOpen = this.active !== null;
    this.clearActive();
    if (wasOpen) this.opts.onEvent?.({ type: 'closed', reason });
  }

  private clearActive(): void {
    this.active = null;
    if (this.expiryTimer) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
  }

  private expireIfDue(): void {
    if (this.active && this.now() >= this.active.expiresAt) this.close('expired');
  }

  private rateLimited(address: string): boolean {
    const t = this.now();
    const recent = (this.attemptsByAddress.get(address) ?? []).filter(
      (at) => t - at < PAIRING_RATE_LIMIT.windowMs
    );
    recent.push(t);
    this.attemptsByAddress.set(address, recent);
    if (this.attemptsByAddress.size > 1000) {
      for (const [k, v] of this.attemptsByAddress) {
        if (v.every((at) => t - at >= PAIRING_RATE_LIMIT.windowMs)) this.attemptsByAddress.delete(k);
      }
    }
    return recent.length > PAIRING_RATE_LIMIT.max;
  }

  /** Handles POST /api/pair. */
  attempt(
    body: { code?: unknown; deviceName?: unknown; deviceId?: unknown },
    address: string
  ): PairAttemptResult {
    if (this.rateLimited(address)) {
      return { status: 429, body: { ok: false, error: 'Too many attempts. Wait a minute and try again.' } };
    }
    this.expireIfDue();
    const code = typeof body.code === 'string' ? body.code.replace(/\s+/g, '') : '';
    const deviceName = typeof body.deviceName === 'string' ? body.deviceName.trim().slice(0, 80) : '';
    const deviceId = typeof body.deviceId === 'string' ? body.deviceId.trim().slice(0, 128) : '';
    if (!/^\d{6}$/.test(code) || !deviceId) {
      return { status: 400, body: { ok: false, error: 'Send a 6-digit code, deviceName and deviceId.' } };
    }
    const active = this.active;
    if (!active) {
      return {
        status: 401,
        body: { ok: false, error: 'Pairing isn’t open. Choose “Pair a phone” on the desktop for a new code.' },
      };
    }
    if (!safeEqual(code, active.code)) {
      active.wrongAttempts += 1;
      if (active.wrongAttempts >= PAIRING_MAX_WRONG_ATTEMPTS) {
        this.close('too_many_attempts');
        return {
          status: 401,
          body: { ok: false, error: 'Too many wrong codes. Start pairing again on the desktop.' },
        };
      }
      return { status: 401, body: { ok: false, error: 'Wrong code.' } };
    }

    // One-time: the code is spent as soon as it pairs a device.
    this.clearActive();
    const token = crypto.randomBytes(32).toString('hex');
    const now = this.now();
    const device: PairedDevice = {
      id: deviceId,
      name: deviceName || 'iPhone',
      tokenHash: hashToken(token),
      createdAt: now,
      lastSeenAt: now,
    };
    const hostId = this.hostId();
    const others = (this.mobile()?.pairedDevices ?? []).filter((d) => d.id !== deviceId);
    const replaced = others.length !== (this.mobile()?.pairedDevices ?? []).length;
    if (replaced) this.opts.onRevoke?.(deviceId);
    this.updateMobile({ pairedDevices: [...others, device] });
    this.lastSeenWritten.set(deviceId, now);
    this.opts.onEvent?.({ type: 'paired', device: { id: device.id, name: device.name } });
    this.opts.onEvent?.({ type: 'closed', reason: 'paired' });
    return { status: 200, body: { ok: true, token, hostId, hostName: this.hostName } };
  }

  /**
   * Checks a Bearer token against the legacy shared token and every paired device. Updates the
   * device's lastSeenAt (at most every two minutes, so requests don't rewrite settings).
   */
  authenticate(bearer: string, legacyToken: string | undefined): AuthResult | null {
    if (!bearer) return null;
    if (legacyToken && safeEqual(bearer, legacyToken)) return { kind: 'legacy' };
    const hash = hashToken(bearer);
    const devices = this.mobile()?.pairedDevices ?? [];
    const device = devices.find((d) => safeEqual(d.tokenHash, hash));
    if (!device) return null;
    const t = this.now();
    const last = this.lastSeenWritten.get(device.id) ?? device.lastSeenAt ?? 0;
    if (t - last >= LAST_SEEN_THROTTLE_MS) {
      this.lastSeenWritten.set(device.id, t);
      this.updateMobile({
        pairedDevices: devices.map((d) => (d.id === device.id ? { ...d, lastSeenAt: t } : d)),
      });
    }
    return { kind: 'device', deviceId: device.id };
  }

  revoke(deviceId: string): boolean {
    const devices = this.mobile()?.pairedDevices ?? [];
    const next = devices.filter((d) => d.id !== deviceId);
    if (next.length === devices.length) return false;
    this.updateMobile({ pairedDevices: next });
    this.lastSeenWritten.delete(deviceId);
    this.opts.onRevoke?.(deviceId);
    return true;
  }

  info(): { ok: true; hostId: string; hostName: string; version: string; pairingOpen: boolean } {
    return {
      ok: true,
      hostId: this.hostId(),
      hostName: this.hostName,
      version: this.version,
      pairingOpen: this.pairingOpen(),
    };
  }
}
