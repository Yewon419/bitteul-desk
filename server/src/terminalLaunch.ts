/**
 * Reopen a session in a real terminal (`claude --resume <id>`), for the work only an
 * interactive session can do: an SDK session never gets the claude.ai Artifact tools.
 */

import { spawn } from 'child_process';

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Starts a detached program; resolves once it runs, rejects with the spawn error. */
function launch(
  command: string,
  args: string[],
  options: { cwd?: string; windowsVerbatimArguments?: boolean } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

function appleScriptString(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** `claudeExe` must be the executable itself: Windows Terminal runs only real programs, and
 *  on PATH npm installs `claude` as .cmd/.ps1 shims it cannot start (0x80070002). */
export async function openSessionInTerminal(
  sessionId: string,
  cwd: string,
  claudeExe: string,
): Promise<void> {
  if (!SESSION_ID.test(sessionId)) throw new Error(`not a session id: ${sessionId}`);
  if (process.platform === 'win32') {
    try {
      await launch('wt.exe', ['-d', cwd, claudeExe, '--resume', sessionId]);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      // No Windows Terminal: a plain console window. `start` needs its title argument.
      const line = `/c start "Claude" /D "${cwd}" "${claudeExe}" --resume ${sessionId}`;
      await launch('cmd.exe', [line], { windowsVerbatimArguments: true });
    }
    return;
  }
  if (process.platform === 'darwin') {
    const script = `cd ${JSON.stringify(cwd)} && ${JSON.stringify(claudeExe)} --resume ${sessionId}`;
    await launch('osascript', [
      '-e',
      `tell application "Terminal" to do script ${appleScriptString(script)}`,
      '-e',
      'tell application "Terminal" to activate',
    ]);
    return;
  }
  await launch('x-terminal-emulator', ['-e', claudeExe, '--resume', sessionId], { cwd });
}
