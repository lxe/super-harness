import { Bonjour, type Service } from 'bonjour-service';

/**
 * Advertises the phone API as `_superharness._tcp` while mobile access is on, so the iOS app can
 * list nearby desktops. TXT carries only v, id and name (never a token or pairing code).
 *
 * bonjour-service would publish A records for every interface (including Docker bridges) under
 * the machine's own hostname, which avahi/mDNSResponder already own. We give the service its own
 * host name (`sh-<hostId>.local`) and answer A records only for the addresses a phone can use.
 */

export interface BonjourConfig {
  port: number;
  hostId: string;
  name: string;
  addresses: string[];
}

type DnsRecord = { name: string; type: string; ttl: number; data: unknown };

export class BonjourAdvertiser {
  private bonjour: Bonjour | null = null;
  private service: Service | null = null;
  private key = '';

  get active(): boolean {
    return this.service !== null;
  }

  sync(cfg: BonjourConfig | null): void {
    const ipv4 = cfg?.addresses.filter((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) ?? [];
    if (!cfg || !cfg.port || ipv4.length === 0) {
      this.stop();
      return;
    }
    const key = JSON.stringify({ ...cfg, addresses: ipv4 });
    if (key === this.key && this.service) return;
    this.stop();
    this.key = key;
    try {
      this.bonjour = new Bonjour({}, (err: unknown) => {
        console.error('[Bonjour] mDNS error:', err instanceof Error ? err.message : err);
      });
      const host = `sh-${cfg.hostId}.local`;
      const svc = this.bonjour.publish({
        name: cfg.name.slice(0, 63) || 'Super Harness',
        type: 'superharness',
        protocol: 'tcp',
        port: cfg.port,
        host,
        txt: { v: '1', id: cfg.hostId, name: cfg.name },
        disableIPv6: true,
      });
      // Records are first built after the async name probe, so this override is in time.
      const original = svc.records.bind(svc) as () => DnsRecord[];
      (svc as unknown as { records: () => DnsRecord[] }).records = () => [
        ...original().filter((r) => r.type !== 'A' && r.type !== 'AAAA'),
        ...ipv4.map((ip) => ({ name: host, type: 'A', ttl: 120, data: ip })),
      ];
      svc.on('error', (err: unknown) => {
        console.error('[Bonjour] publish failed:', err instanceof Error ? err.message : err);
      });
      this.service = svc;
    } catch (err) {
      console.error('[Bonjour] could not start:', err instanceof Error ? err.message : err);
      this.stop();
    }
  }

  stop(): void {
    this.key = '';
    const bonjour = this.bonjour;
    this.service = null;
    this.bonjour = null;
    if (!bonjour) return;
    try {
      bonjour.unpublishAll(() => bonjour.destroy());
    } catch {
      try {
        bonjour.destroy();
      } catch {
        // ignore
      }
    }
  }
}
