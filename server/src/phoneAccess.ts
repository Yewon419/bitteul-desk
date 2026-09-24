/**
 * `--phone` mode: reach the office from a phone. The server listens on every interface,
 * keeps one token across restarts (so a bookmarked phone link keeps working), and prints a
 * link plus a QR code per network address, Tailscale first because it also works outside
 * the home network.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import type * as os from 'os';
import * as path from 'path';
import * as QRCode from 'qrcode';

import { LAYOUT_FILE_DIR } from './constants.js';

const TOKEN_FILE = 'bitteul-desk-phone-token';
const MIN_TOKEN_LENGTH = 32;

export type AddressKind = 'tailscale' | 'lan' | 'virtual';

export interface PhoneAddress {
  address: string;
  adapter: string;
  kind: AddressKind;
}

/** VPN clients, WSL, containers and VMs: addresses a phone usually cannot reach. */
const VIRTUAL_ADAPTER =
  /vEthernet|WSL|Hyper-V|VirtualBox|VMware|docker|^br-|^veth|WARP|ZeroTier|^utun|^tun|^tap/i;
const KIND_ORDER: Record<AddressKind, number> = { tailscale: 0, lan: 1, virtual: 2 };

/** Tailscale hands out addresses from the carrier-grade NAT block 100.64.0.0/10. */
function kindOf(adapter: string, address: string): AddressKind {
  const [a, b] = address.split('.').map(Number);
  if (a === 100 && b >= 64 && b <= 127) return 'tailscale';
  return VIRTUAL_ADAPTER.test(adapter) ? 'virtual' : 'lan';
}

/** External IPv4 addresses a phone could use: Tailscale, then real adapters, then virtual ones. */
export function phoneAddresses(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>): PhoneAddress[] {
  const found: PhoneAddress[] = [];
  for (const [adapter, infos] of Object.entries(interfaces)) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      found.push({ address: info.address, adapter, kind: kindOf(adapter, info.address) });
    }
  }
  return found.sort((p, q) => KIND_ORDER[p.kind] - KIND_ORDER[q.kind]);
}

export function phoneTokenPath(home: string): string {
  return path.join(home, LAYOUT_FILE_DIR, TOKEN_FILE);
}

/**
 * The phone token survives restarts. Delete the file to revoke every phone link; the next
 * `--phone` start mints a new one.
 */
export function loadOrCreatePhoneToken(file: string): string {
  if (fs.existsSync(file)) {
    const saved = fs.readFileSync(file, 'utf-8').trim();
    if (saved.length >= MIN_TOKEN_LENGTH) return saved;
    throw new Error(
      `${file} holds a token shorter than ${MIN_TOKEN_LENGTH} characters; delete it to mint a new one`,
    );
  }
  const token = crypto.randomBytes(32).toString('base64url');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600, flag: 'wx' });
  return token;
}

export async function printPhoneLinks(
  addresses: PhoneAddress[],
  port: number,
  token: string,
): Promise<void> {
  if (addresses.length === 0) {
    console.log(
      '  No network address found for a phone. Connect this PC to Wi-Fi or install Tailscale.\n',
    );
    return;
  }
  const query = new URLSearchParams({ token }).toString();
  const label: Record<AddressKind, string> = {
    tailscale: 'Tailscale, works outside too',
    lan: 'same Wi-Fi only',
    virtual: 'virtual adapter, usually unreachable',
  };
  console.log('  Phone links (the token inside is a password; do not share them):');
  for (const { address, adapter, kind } of addresses) {
    console.log(`    ${label[kind]} (${adapter})`);
    console.log(`      http://${address}:${port}/scene.html?${query}`);
  }
  const best = addresses[0];
  const url = `http://${best.address}:${port}/scene.html?${query}`;
  console.log(`\n  Scan with your phone camera to open the ${best.adapter} link:\n`);
  console.log(await QRCode.toString(url, { type: 'terminal', small: true }));
  if (best.kind !== 'tailscale') {
    console.log(
      '  Outside your home network this link will not work. Install Tailscale on this PC and\n' +
        '  your phone, then restart with --phone to get a link that works anywhere.\n',
    );
  }
}
