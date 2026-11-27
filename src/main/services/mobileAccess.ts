import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { promisify } from 'node:util';
import type { MobileAddress } from '../../shared/types';

const execFileAsync = promisify(execFile);

/**
 * Where a phone can reach this desktop, for the pairing QR code, Settings → Mobile and Bonjour.
 * Best first: Tailscale MagicDNS name, Tailscale IP, then LAN IPs.
 */

/** Interfaces that never carry phone traffic (containers, VMs, VPN tunnels other than Tailscale). */
const IGNORED_IFACE =
  /^(docker|br-|veth|virbr|vboxnet|vmnet|lxc|lxd|cni|flannel|podman|kube|zt|wg|utun|tun|tap|awdl|llw|anpi|ap\d|bridge)/;

function isTailscaleIPv4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return a === 100 && b >= 64 && b <= 127;
}

function isPrivateIPv4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
}

/** LAN IPv4 addresses, home-network ranges and physical-looking interfaces first. */
export function lanAddresses(ifaces = os.networkInterfaces()): string[] {
  const found: Array<{ ip: string; score: number }> = [];
  for (const [name, list] of Object.entries(ifaces)) {
    if (!list || IGNORED_IFACE.test(name) || /^tailscale/.test(name)) continue;
    for (const addr of list) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      if (isTailscaleIPv4(addr.address) || !isPrivateIPv4(addr.address)) continue;
      let score = 0;
      if (addr.address.startsWith('192.168.')) score += 2;
      else if (addr.address.startsWith('10.')) score += 1;
      if (/^(en|eth|wl|wlan)/.test(name)) score += 4;
      found.push({ ip: addr.address, score });
    }
  }
  return found.sort((a, b) => b.score - a.score).map((f) => f.ip);
}

interface TailscaleSelf {
  dnsName?: string;
  ipv4?: string;
}

async function tailscaleSelf(): Promise<TailscaleSelf> {
  const result: TailscaleSelf = {};
  for (const bin of ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']) {
    try {
      const { stdout } = await execFileAsync(bin, ['status', '--json', '--self=true', '--peers=false'], {
        timeout: 2000,
        maxBuffer: 4 * 1024 * 1024,
      });
      const self = (
        JSON.parse(stdout) as {
          Self?: {
            DNSName?: string;
            TailscaleIPs?: string[];
            Online?: boolean;
          };
        }
      ).Self;
      if (self?.DNSName) result.dnsName = self.DNSName.replace(/\.$/, '');
      result.ipv4 = self?.TailscaleIPs?.find((ip) => ip.includes('.'));
      break;
    } catch {
      // not installed or not running; try the next location
    }
  }
  if (!result.ipv4) {
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      const hit = list?.find((a) => a.family === 'IPv4' && isTailscaleIPv4(a.address));
      if (hit && (name.startsWith('tailscale') || name.startsWith('utun'))) {
        result.ipv4 = hit.address;
        break;
      }
    }
  }
  return result;
}

export async function mobileAddresses(): Promise<MobileAddress[]> {
  const ts = await tailscaleSelf();
  const out: MobileAddress[] = [];
  if (ts.dnsName) out.push({ address: ts.dnsName, kind: 'tailscale-dns' });
  if (ts.ipv4) out.push({ address: ts.ipv4, kind: 'tailscale-ip' });
  for (const ip of lanAddresses()) out.push({ address: ip, kind: 'lan' });
  return out;
}

/** The computer's friendly name: macOS ComputerName, Linux PRETTY_HOSTNAME, else the hostname. */
export async function defaultDesktopName(): Promise<string> {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('scutil', ['--get', 'ComputerName'], { timeout: 1500 });
      if (stdout.trim()) return stdout.trim();
    } catch {
      // fall through
    }
  } else if (process.platform === 'linux') {
    try {
      const m = fs.readFileSync('/etc/machine-info', 'utf8').match(/^PRETTY_HOSTNAME=["']?(.+?)["']?$/m);
      if (m?.[1]?.trim()) return m[1].trim();
    } catch {
      // fall through
    }
  }
  return os.hostname().replace(/\.local$/, '') || 'Desktop';
}

export function buildPairingUrl(p: {
  name: string;
  hostId: string;
  port: number;
  code: string;
  hosts: string[];
}): string {
  const enc = encodeURIComponent;
  return (
    `superharness://pair?v=1&name=${enc(p.name)}&id=${enc(p.hostId)}&port=${p.port}` +
    `&code=${enc(p.code)}&hosts=${enc(p.hosts.join(','))}`
  );
}
