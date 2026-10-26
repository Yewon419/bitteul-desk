/**
 * Per-user touches for the Bitteul office: what the chat window calls the user and what
 * the wall board in the first room shows. Read from ~/.pixel-agents/bitteul-desk.json so a
 * published build carries no one's personal numbers; without the file, neutral defaults.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { LAYOUT_FILE_DIR } from './constants.js';

const FILE_NAME = 'bitteul-desk.json';
const MAX_NAME = 20;
const DEFAULT_USER_NAME = '나';
export const MAX_BOARD_TEXT = 300;
/** Fields of the old fixed-layout board; dropped from the file the next time the board is saved. */
const OLD_BOARD_FIELDS = [
  'boardTitle',
  'countdownLabel',
  'countdownDate',
  'salaryThisMonth',
  'salaryTarget',
];

export interface DeskProfile {
  userName: string;
  board: { text: string };
}

export class DeskProfileError extends Error {}

export function deskProfilePath(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, FILE_NAME);
}

function text(raw: Record<string, unknown>, key: string, fallback: string, file: string): string {
  const value = raw[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > MAX_NAME) {
    throw new DeskProfileError(`${file}: "${key}" must be text of 1-${MAX_NAME} characters`);
  }
  return value.trim();
}

function boardText(raw: Record<string, unknown>, file: string): string {
  const value = raw.boardText;
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.trim().length > MAX_BOARD_TEXT) {
    throw new DeskProfileError(
      `${file}: "boardText" must be text of up to ${MAX_BOARD_TEXT} characters`,
    );
  }
  return value.trim();
}

/** The profile file as written; a missing file is an empty profile, a broken one throws. */
function readRawProfile(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    throw new DeskProfileError(
      `${file}: not valid JSON (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new DeskProfileError(`${file}: expected a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function parseDeskProfile(raw: Record<string, unknown>, file: string): DeskProfile {
  return {
    userName: text(raw, 'userName', DEFAULT_USER_NAME, file),
    board: { text: boardText(raw, file) },
  };
}

/** Read and validate the profile; a missing file means defaults, a broken one throws. */
export function readDeskProfile(file: string = deskProfilePath()): DeskProfile {
  return parseDeskProfile(readRawProfile(file), file);
}

/** One wall-board edit: text replaces the board, null or empty clears it, a missing key leaves it. */
export interface BoardPatch {
  boardText?: string | null;
}

/**
 * Apply a wall-board edit from the office. The merged file is validated with the same
 * rules as a hand-edited one before anything is written, and written atomically.
 */
export function updateDeskBoard(patch: BoardPatch, file: string = deskProfilePath()): DeskProfile {
  const raw = readRawProfile(file);
  for (const key of OLD_BOARD_FIELDS) delete raw[key];
  const value = patch.boardText;
  if (value === null || value?.trim() === '') delete raw.boardText;
  else if (value !== undefined) raw.boardText = value.trim();
  const profile = parseDeskProfile(raw, file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmp, file);
  return profile;
}
