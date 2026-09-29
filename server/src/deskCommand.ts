/**
 * `/desk`: a Claude Code slash command that hands the running terminal session to the
 * office, so it carries on from the phone or another browser. The command runs
 * `bitteul-desk --handoff`, which reads the session id and pid Claude Code exports to its
 * tools and asks the local server to stop that terminal Claude once the turn ends.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export function deskCommandPath(home: string): string {
  return path.join(home, '.claude', 'commands', 'desk.md');
}

/** Marks the file as ours, so remove never deletes a /desk the user wrote themselves. */
const DESK_MARKER = '<!-- bitteul-desk:desk-command -->';

export function deskCommandText(nodeExe: string, cliPath: string): string {
  const run = `"${nodeExe.replace(/\\/g, '/')}" "${cliPath.replace(/\\/g, '/')}" --handoff`;
  return [
    '---',
    'description: 이 세션을 빛뜰 데스크 사무실로 넘깁니다 (폰·패드에서 이어서 조작)',
    'allowed-tools: Bash',
    '---',
    DESK_MARKER,
    'Run this exact command with the Bash tool and nothing else:',
    '',
    '```',
    run,
    '```',
    '',
    'Then reply with one short line in the language of the conversation: the session moves to',
    'the Bitteul Desk office once this reply ends, and the terminal Claude will close. If the',
    'command failed, show its output instead.',
    '',
  ].join('\n');
}

export function installDeskCommand(nodeExe: string, cliPath: string): string {
  const file = deskCommandPath(os.homedir());
  if (fs.existsSync(file) && !fs.readFileSync(file, 'utf-8').includes(DESK_MARKER)) {
    throw new Error(`${file} already exists and was not written by Bitteul Desk; left as is.`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, deskCommandText(nodeExe, cliPath), 'utf-8');
  return file;
}

/** Returns the removed file, or null when there was nothing of ours to remove. */
export function removeDeskCommand(): string | null {
  const file = deskCommandPath(os.homedir());
  if (!fs.existsSync(file)) return null;
  if (!fs.readFileSync(file, 'utf-8').includes(DESK_MARKER)) {
    throw new Error(`${file} was not written by Bitteul Desk; left as is.`);
  }
  fs.unlinkSync(file);
  return file;
}

interface ServerInfo {
  port: number;
  token: string;
}

function readServerInfo(): ServerInfo {
  const file = path.join(os.homedir(), '.pixel-agents', 'server.json');
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    throw new Error(`Bitteul Desk is not running (no ${file}). Start it, then run /desk again.`);
  }
  const info = JSON.parse(raw) as Partial<ServerInfo>;
  if (typeof info.port !== 'number' || typeof info.token !== 'string') {
    throw new Error(`${file} has no port or token; restart Bitteul Desk.`);
  }
  return { port: info.port, token: info.token };
}

/** Ask the running server to take this terminal session over once the current turn ends. */
export async function requestHandoff(env: NodeJS.ProcessEnv): Promise<string> {
  const sessionId = env.CLAUDE_CODE_SESSION_ID;
  const pid = Number(env.CLAUDE_PID);
  if (!sessionId || !Number.isInteger(pid) || pid <= 0) {
    throw new Error(
      'Run this from inside Claude Code (type /desk there); CLAUDE_CODE_SESSION_ID and CLAUDE_PID are missing.',
    );
  }
  const { port, token } = readServerInfo();
  const res = await fetch(`http://127.0.0.1:${port}/api/dashboard/handoff`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, pid }),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(
      `Hand-off refused (HTTP ${res.status}, session ${sessionId}, pid ${pid}): ${body}`,
    );
  }
  return `Hand-off accepted for session ${sessionId}: this terminal Claude closes when the current reply ends, and the office carries on.`;
}
