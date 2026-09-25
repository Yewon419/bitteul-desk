import { execFileSync } from 'child_process';
import * as fs from 'fs';
import type * as nodeOs from 'os';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  autostartScriptPath,
  isEphemeralInstall,
  runKeyCommand,
  startupScript,
  writeStartupScript,
} from '../src/autostart.js';
import { parseArgs, PHONE_DEFAULT_PORT } from '../src/cli.js';
import {
  loadOrCreatePhoneToken,
  networkLinks,
  parseTailscaleStatus,
  phoneAddresses,
} from '../src/phoneAccess.js';

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
  it('picks a fixed port and leaves the bind address to the runtime Tailscale check', () => {
    expect(parseArgs(['--phone'])).toMatchObject({
      phone: true,
      host: '127.0.0.1',
      hostGiven: false,
      port: PHONE_DEFAULT_PORT,
    });
    expect(parseArgs(['--phone', '--port', '4000']).port).toBe(4000);
    expect(parseArgs(['--host', '100.101.1.2', '--phone'])).toMatchObject({
      host: '100.101.1.2',
      hostGiven: true,
    });
    expect(parseArgs([])).toMatchObject({ phone: false, autostart: null });
    expect(parseArgs([]).port).toBeUndefined();
    expect(parseArgs(['--install-autostart']).autostart).toBe('install');
    expect(parseArgs(['--remove-autostart']).autostart).toBe('remove');
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

describe('networkLinks', () => {
  it('builds one scene link per address with the token in the query', () => {
    const links = networkLinks(
      [{ address: '192.168.0.12', adapter: 'Wi-Fi', kind: 'lan' }],
      3100,
      'tok/en+=',
    );
    expect(links).toEqual([
      {
        url: 'http://192.168.0.12:3100/scene.html?token=tok%2Fen%2B%3D',
        kind: 'lan',
        where: 'Wi-Fi',
      },
    ]);
  });
});

describe('parseTailscaleStatus', () => {
  it('is ready only when running with a DNS name, and says why otherwise', () => {
    expect(
      parseTailscaleStatus(
        'tailscale',
        JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'desk.tail1234.ts.net.' } }),
      ),
    ).toEqual({ ready: true, exe: 'tailscale', dnsName: 'desk.tail1234.ts.net' });
    const loggedOut = parseTailscaleStatus(
      'tailscale',
      JSON.stringify({ BackendState: 'NeedsLogin' }),
    );
    expect(loggedOut).toMatchObject({ ready: false });
    expect(JSON.stringify(loggedOut)).toContain('NeedsLogin');
    expect(
      parseTailscaleStatus('tailscale', JSON.stringify({ BackendState: 'Running', Self: {} })),
    ).toMatchObject({ ready: false });
    expect(parseTailscaleStatus('tailscale', 'not json')).toMatchObject({ ready: false });
  });
});

describe('autostart script', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

  it('refuses a CLI that lives in the npx cache', () => {
    expect(
      isEphemeralInstall(
        'C:\\Users\\a\\AppData\\Local\\npm-cache\\_npx\\ab12\\node_modules\\bitteul-desk\\dist\\cli.js',
      ),
    ).toBe(true);
    expect(
      isEphemeralInstall(
        'C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\bitteul-desk\\dist\\cli.js',
      ),
    ).toBe(false);
  });

  it('keeps the script in ~/.pixel-agents and quotes the Run command for spaces', () => {
    expect(autostartScriptPath('C:\\Users\\a b')).toBe(
      path.join('C:\\Users\\a b', '.pixel-agents', 'bitteul-desk-autostart.vbs'),
    );
    expect(runKeyCommand('C:\\Windows\\System32\\wscript.exe', 'C:\\Users\\a b\\start.vbs')).toBe(
      '"C:\\Windows\\System32\\wscript.exe" "C:\\Users\\a b\\start.vbs"',
    );
  });

  it.skipIf(process.platform !== 'win32')(
    'runs hidden through Windows Script Host from paths with spaces and Korean',
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitteul 자동 시작 '));
      dirs.push(dir);
      const work = path.join(dir, '작업 폴더');
      fs.mkdirSync(work);
      const fakeCli = path.join(dir, 'fake cli.js');
      const report = path.join(dir, 'report.json');
      fs.writeFileSync(
        fakeCli,
        `require('fs').writeFileSync(${JSON.stringify(report)}, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() })); console.log('started');`,
      );
      const log = path.join(dir, 'desk log.txt');
      const script = path.join(dir, 'start.vbs');
      writeStartupScript(
        script,
        startupScript(process.execPath, fakeCli, work, log, [
          '--phone',
          '--no-open',
          '--port',
          '3100',
        ]),
      );
      execFileSync('cscript', ['//nologo', script], { timeout: 20_000 });
      const deadline = Date.now() + 15_000;
      while (!fs.existsSync(report) && Date.now() < deadline) {
        execFileSync(process.execPath, ['-e', 'setTimeout(() => {}, 200)']);
      }
      const seen = JSON.parse(fs.readFileSync(report, 'utf-8')) as { argv: string[]; cwd: string };
      expect(seen.argv).toEqual(['--phone', '--no-open', '--port', '3100']);
      expect(seen.cwd).toBe(work);
      expect(fs.readFileSync(log, 'utf-8')).toContain('started');
    },
    40_000,
  );
});
