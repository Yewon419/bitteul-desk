/**
 * Start Bitteul Desk when the user logs in to Windows, hidden, so a paired phone finds the
 * office without anyone opening a terminal. Implemented as a VBScript under ~/.pixel-agents
 * launched from the per-user Run registry key: no admin rights. The Run key is used rather
 * than the Startup folder because Explorer was observed to run every Run entry at log-in
 * while never executing the Startup folder script.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const SCRIPT_NAME = 'bitteul-desk-autostart.vbs';
const LEGACY_SCRIPT_NAME = 'bitteul-desk.vbs';
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
export const RUN_VALUE_NAME = 'BitteulDesk';

/** VBScript string literal: quotes are escaped by doubling. */
function vbs(text: string): string {
  return `"${text.replace(/"/g, '""')}"`;
}

export function autostartScriptPath(home: string): string {
  return path.join(home, '.pixel-agents', SCRIPT_NAME);
}

/** Where earlier versions put the script; removed on install and remove so it cannot double-start. */
export function legacyStartupScriptPath(appData: string): string {
  return path.join(
    appData,
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
    LEGACY_SCRIPT_NAME,
  );
}

/** The script: run node on the CLI in `cwd`, no window, output appended to `log`. */
export function startupScript(
  node: string,
  cli: string,
  cwd: string,
  log: string,
  args: string[],
): string {
  const command = `cmd /c ""${node}" "${cli}" ${args.join(' ')} >> "${log}" 2>&1"`;
  return [
    "' Bitteul Desk autostart. Created by `bitteul-desk --install-autostart`;",
    "' remove it with `bitteul-desk --remove-autostart`.",
    'Set shell = CreateObject("WScript.Shell")',
    `shell.CurrentDirectory = ${vbs(cwd)}`,
    `shell.Run ${vbs(command)}, 0, False`,
    '',
  ].join('\r\n');
}

/** A CLI inside npx's cache can vanish on the next cache clean, so autostart refuses it. */
export function isEphemeralInstall(cli: string): boolean {
  return cli.split(/[\\/]/).includes('_npx');
}

/** Written as UTF-16LE with a BOM so Windows Script Host reads non-ASCII paths correctly. */
export function writeStartupScript(file: string, script: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(`﻿${script}`, 'utf16le'));
}

/** The Run value data: Windows Script Host on the script, quoted for spaces. */
export function runKeyCommand(wscript: string, script: string): string {
  return `"${wscript}" "${script}"`;
}

export function installRunKey(command: string): void {
  execFileSync('reg', ['add', RUN_KEY, '/v', RUN_VALUE_NAME, '/t', 'REG_SZ', '/d', command, '/f'], {
    stdio: 'ignore',
  });
}

/** Reads the registered command, or null when autostart is not installed. */
export function readRunKey(): string | null {
  try {
    const out = execFileSync('reg', ['query', RUN_KEY, '/v', RUN_VALUE_NAME], {
      encoding: 'utf-8',
    });
    const match = out.match(/REG_SZ\s+(.+)/);
    return match ? match[1].trim() : null;
  } catch {
    return null;
  }
}

export function removeRunKey(): void {
  if (readRunKey() === null) return;
  execFileSync('reg', ['delete', RUN_KEY, '/v', RUN_VALUE_NAME, '/f'], { stdio: 'ignore' });
}
