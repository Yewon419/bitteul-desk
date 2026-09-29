import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  deskCommandPath,
  deskCommandText,
  installDeskCommand,
  removeDeskCommand,
  requestHandoff,
} from '../src/deskCommand.js';

let home: string;
const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'bitteul-desk-cmd-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
});

afterEach(() => {
  process.env.HOME = saved.HOME;
  process.env.USERPROFILE = saved.USERPROFILE;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('/desk command file', () => {
  it('runs the hand-off through the given node and cli, with forward slashes', () => {
    const text = deskCommandText('C:\\node\\node.exe', 'C:\\app\\dist\\cli.js');
    expect(text).toContain('"C:/node/node.exe" "C:/app/dist/cli.js" --handoff');
    expect(text.startsWith('---\n')).toBe(true);
  });

  it('installs, reinstalls over its own file, and removes only its own file', () => {
    const file = installDeskCommand('node', '/app/cli.js');
    expect(file).toBe(deskCommandPath(home));
    expect(installDeskCommand('node', '/app/other.js')).toBe(file);
    expect(fs.readFileSync(file, 'utf-8')).toContain('/app/other.js');
    expect(removeDeskCommand()).toBe(file);
    expect(fs.existsSync(file)).toBe(false);
    expect(removeDeskCommand()).toBeNull();
  });

  it('never overwrites or deletes a /desk the user wrote', () => {
    const file = deskCommandPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'my own desk command');
    expect(() => installDeskCommand('node', '/app/cli.js')).toThrow(/not written by Bitteul Desk/);
    expect(() => removeDeskCommand()).toThrow(/not written by Bitteul Desk/);
    expect(fs.readFileSync(file, 'utf-8')).toBe('my own desk command');
  });
});

describe('--handoff', () => {
  it('refuses outside Claude Code, where the session id and pid are missing', async () => {
    await expect(requestHandoff({})).rejects.toThrow(/inside Claude Code/);
  });

  it('says the server is not running when there is no server.json', async () => {
    await expect(
      requestHandoff({ CLAUDE_CODE_SESSION_ID: 'abc', CLAUDE_PID: '1234' }),
    ).rejects.toThrow(/not running/);
  });
});
