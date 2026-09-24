import * as fs from 'fs';
import type * as nodeOs from 'os';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { parseArgs } from '../src/cli.js';
import { loadOrCreatePhoneToken, phoneAddresses } from '../src/phoneAccess.js';

function iface(address: string, internal = false): nodeOs.NetworkInterfaceInfo {
  return {
    address,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal,
    cidr: `${address}/24`,
  };
}

describe('--phone arguments', () => {
  it('listens on the network unless a host is given, in either order', () => {
    expect(parseArgs(['--phone'])).toMatchObject({ phone: true, host: '0.0.0.0' });
    expect(parseArgs(['--phone', '--host', '100.101.1.2']).host).toBe('100.101.1.2');
    expect(parseArgs(['--host', '100.101.1.2', '--phone']).host).toBe('100.101.1.2');
    expect(parseArgs([])).toMatchObject({ phone: false, host: '127.0.0.1' });
  });
});

describe('phoneAddresses', () => {
  it('drops loopback and IPv6, and ranks Tailscale, real adapters, then virtual ones', () => {
    const v6: nodeOs.NetworkInterfaceInfo = {
      address: 'fe80::1',
      netmask: 'ffff:ffff:ffff:ffff::',
      family: 'IPv6',
      mac: '00:00:00:00:00:00',
      internal: false,
      cidr: 'fe80::1/64',
      scopeid: 1,
    };
    const found = phoneAddresses({
      Loopback: [iface('127.0.0.1', true)],
      CloudflareWARP: [iface('172.16.0.2')],
      'Wi-Fi': [iface('192.168.0.12'), v6],
      'vEthernet (WSL (Hyper-V firewall))': [iface('172.31.240.1')],
      Tailscale: [iface('100.101.1.2')],
      Ethernet: [iface('100.128.0.1')],
    });
    expect(found.map((f) => [f.address, f.kind])).toEqual([
      ['100.101.1.2', 'tailscale'],
      ['192.168.0.12', 'lan'],
      ['100.128.0.1', 'lan'],
      ['172.16.0.2', 'virtual'],
      ['172.31.240.1', 'virtual'],
    ]);
  });
});

describe('loadOrCreatePhoneToken', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

  it('mints once, then returns the same token; a damaged file is refused, not replaced', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitteul-phone-'));
    dirs.push(dir);
    const file = path.join(dir, 'nested', 'token');
    const first = loadOrCreatePhoneToken(file);
    expect(first.length).toBeGreaterThanOrEqual(32);
    expect(loadOrCreatePhoneToken(file)).toBe(first);

    fs.writeFileSync(file, 'short');
    expect(() => loadOrCreatePhoneToken(file)).toThrow(/delete it/);
    expect(fs.readFileSync(file, 'utf-8')).toBe('short');
  });
});
