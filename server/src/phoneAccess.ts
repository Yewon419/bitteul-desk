/**
 * `--phone` mode: reach the office from a phone. When Tailscale is running, the server
 * stays on 127.0.0.1 and `tailscale serve` gives it a fixed https address inside the
 * tailnet; otherwise the server listens on the network for phones on the same Wi-Fi. The
 * token is kept across restarts so a phone that was paired once keeps working.
 */

import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import type * as os from 'os';
import * as path from 'path';
import * as QRCode from 'qrcode';

import { LAYOUT_FILE_DIR } from './constants.js';

const TOKEN_FILE = 'bitteul-desk-phone-token';
const MIN_TOKEN_LENGTH = 32;
const STATUS_TIMEOUT_MS = 5_000;
const SERVE_TIMEOUT_MS = 20_000;

export type AddressKind = 'tailscale' | 'lan' | 'virtual';
export type LinkKind = 'tailscale-https' | AddressKind;

export interface PhoneAddress {
  address: string;
  adapter: string;
  kind: AddressKind;
}

export interface PhoneLink {
  url: string;
  kind: LinkKind;
  /** Adapter or host name, shown next to the link. */
  where: string;
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

export function sceneLink(origin: string, token: string): string {
  return `${origin}/scene.html?${new URLSearchParams({ token }).toString()}`;
}

/** Links for phones on the same network, used when Tailscale Serve is not available. */
export function networkLinks(addresses: PhoneAddress[], port: number, token: string): PhoneLink[] {
  return addresses.map(({ address, adapter, kind }) => ({
    url: sceneLink(`http://${address}:${port}`, token),
    kind,
    where: adapter,
  }));
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

// ── Tailscale ─────────────────────────────────────────────────

interface RunResult {
  ok: boolean;
  output: string;
}

function run(exe: string, args: string[], timeout: number): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(exe, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      const output = `${stdout}${stderr}`.trim();
      resolve({ ok: !err, output: err ? `${err.message}\n${output}`.trim() : output });
    });
  });
}

function tailscaleCandidates(platform: NodeJS.Platform): string[] {
  if (platform === 'win32') return ['tailscale', 'C:\\Program Files\\Tailscale\\tailscale.exe'];
  if (platform === 'darwin')
    return ['tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
  return ['tailscale'];
}

export type TailscaleState =
  { ready: true; exe: string; dnsName: string } | { ready: false; reason: string };

/** Reads `tailscale status --json`: ready only when logged in and the node has a DNS name. */
export function parseTailscaleStatus(exe: string, json: string): TailscaleState {
  let status: { BackendState?: unknown; Self?: { DNSName?: unknown } };
  try {
    status = JSON.parse(json) as typeof status;
  } catch {
    return { ready: false, reason: `${exe} status --json did not return JSON` };
  }
  if (status.BackendState !== 'Running') {
    return {
      ready: false,
      reason: `Tailscale is installed but not connected (state: ${String(status.BackendState)}). Log in to Tailscale on this PC.`,
    };
  }
  const dns =
    typeof status.Self?.DNSName === 'string' ? status.Self.DNSName.replace(/\.$/, '') : '';
  if (!dns)
    return {
      ready: false,
      reason:
        'Tailscale is connected but this PC has no DNS name. Turn on MagicDNS in the Tailscale admin console.',
    };
  return { ready: true, exe, dnsName: dns };
}

export async function detectTailscale(): Promise<TailscaleState> {
  let lastReason = 'Tailscale is not installed on this PC.';
  for (const exe of tailscaleCandidates(process.platform)) {
    const result = await run(exe, ['status', '--json'], STATUS_TIMEOUT_MS);
    if (!result.ok && /ENOENT|not recognized|not found/i.test(result.output)) continue;
    if (!result.ok) {
      lastReason = `${exe} status failed: ${result.output}`;
      continue;
    }
    return parseTailscaleStatus(exe, result.output);
  }
  return { ready: false, reason: lastReason };
}

/**
 * `tailscale serve --bg` persists in Tailscale itself, so the https address comes back after
 * a reboot. The https port matches the local port to leave any existing :443 share alone.
 */
export async function startTailscaleServe(exe: string, port: number): Promise<RunResult> {
  return run(
    exe,
    ['serve', '--bg', `--https=${port}`, `http://127.0.0.1:${port}`],
    SERVE_TIMEOUT_MS,
  );
}

// ── Output ────────────────────────────────────────────────────

const CONSOLE_LABEL: Record<LinkKind, string> = {
  'tailscale-https': 'Tailscale https, works anywhere your phone runs Tailscale',
  tailscale: 'Tailscale, works outside too',
  lan: 'same Wi-Fi only',
  virtual: 'virtual adapter, usually unreachable',
};

export function qrSvg(url: string): Promise<string> {
  return QRCode.toString(url, { type: 'svg', margin: 2 });
}

export async function printPhoneLinks(links: PhoneLink[]): Promise<void> {
  if (links.length === 0) {
    console.log(
      '  No network address found for a phone. Connect this PC to Wi-Fi or install Tailscale.\n',
    );
    return;
  }
  console.log('  Phone links (the token inside is a password; do not share them):');
  for (const { url, kind, where } of links) {
    console.log(`    ${CONSOLE_LABEL[kind]} (${where})`);
    console.log(`      ${url}`);
  }
  const best = links[0];
  console.log(`\n  Scan with your phone camera to open the ${best.where} link:\n`);
  console.log(await QRCode.toString(best.url, { type: 'terminal', small: true }));
  console.log('  The office screen has the same QR under "폰 연결".\n');
  if (best.kind !== 'tailscale-https' && best.kind !== 'tailscale') {
    console.log(
      '  Outside your home network this link will not work. Install Tailscale on this PC and\n' +
        '  your phone, then restart with --phone to get a link that works anywhere.\n',
    );
  }
}
