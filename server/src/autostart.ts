/**
 * Start Bitteul Desk when the user logs in to Windows, hidden, so a paired phone finds the
 * office without anyone opening a terminal. Implemented as a VBScript in the per-user
 * Startup folder: no admin rights, removable by deleting one file.
 */

import * as fs from 'fs';
import * as path from 'path';

const SCRIPT_NAME = 'bitteul-desk.vbs';

/** VBScript string literal: quotes are escaped by doubling. */
function vbs(text: string): string {
  return `"${text.replace(/"/g, '""')}"`;
}

export function startupFolder(appData: string): string {
  return path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
}

export function startupScriptPath(appData: string): string {
  return path.join(startupFolder(appData), SCRIPT_NAME);
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
    "' remove it with `bitteul-desk --remove-autostart` or by deleting this file.",
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
