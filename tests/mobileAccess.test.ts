import { describe, expect, it } from 'vitest';
import type os from 'node:os';
import { buildPairingUrl, lanAddresses } from '../src/main/services/mobileAccess';

const v4 = (address: string, internal = false) =>
  ({ address, family: 'IPv4', internal, netmask: '', mac: '11:22:33:44:55:66', cidr: null }) as os.NetworkInterfaceInfo;

describe('pairing QR payload', () => {
  it('builds the superharness:// URL with every value encoded', () => {
    const url = buildPairingUrl({
      name: 'Studio PC & co',
      hostId: 'abc123',
      port: 47890,
      code: '012345',
      hosts: ['archlinux.tail6026.ts.net', '100.76.24.95', '192.168.0.134'],
    });
    expect(url.startsWith('superharness://pair?')).toBe(true);
    const q = new URL(url.replace('superharness://', 'http://x/')).searchParams;
    expect(q.get('v')).toBe('1');
    expect(q.get('name')).toBe('Studio PC & co');
    expect(q.get('id')).toBe('abc123');
    expect(q.get('port')).toBe('47890');
    expect(q.get('code')).toBe('012345');
    expect(q.get('hosts')?.split(',')).toEqual(['archlinux.tail6026.ts.net', '100.76.24.95', '192.168.0.134']);
  });
});

describe('lanAddresses', () => {
  it('skips loopback, Tailscale, container bridges and public addresses, best first', () => {
    const ifaces = {
      lo: [v4('127.0.0.1', true)],
      docker0: [v4('172.17.0.1')],
      'br-30f9cb68a91e': [v4('172.27.0.1')],
      veth1: [v4('172.18.0.5')],
      tailscale0: [v4('100.76.24.95')],
      enp5s0: [v4('192.168.0.134')],
      wlan0: [v4('10.0.0.7')],
      eth9: [v4('8.8.8.8')],
    } as NodeJS.Dict<os.NetworkInterfaceInfo[]>;
    expect(lanAddresses(ifaces)).toEqual(['192.168.0.134', '10.0.0.7']);
  });
});
