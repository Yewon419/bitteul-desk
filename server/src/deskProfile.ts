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
const DEFAULT_BOARD_TITLE = '빛뜰 데스크';
const DEFAULT_COUNTDOWN_LABEL = '마감까지';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface DeskProfile {
  userName: string;
  board: {
    title: string;
    countdown: { label: string; date: string } | null;
    salary: { thisMonth: number; target: number } | null;
  };
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

function amount(raw: Record<string, unknown>, key: string, file: string): number {
  const value = raw[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new DeskProfileError(`${file}: "${key}" must be a number of 0 or more`);
  }
  return value;
}

function countdown(raw: Record<string, unknown>, file: string): DeskProfile['board']['countdown'] {
  const date = raw.countdownDate;
  if (date === undefined) return null;
  if (typeof date !== 'string' || !DATE_RE.test(date) || Number.isNaN(Date.parse(date))) {
    throw new DeskProfileError(`${file}: "countdownDate" must be a date like 2027-08-31`);
  }
  return { label: text(raw, 'countdownLabel', DEFAULT_COUNTDOWN_LABEL, file), date };
}

function salary(raw: Record<string, unknown>, file: string): DeskProfile['board']['salary'] {
  if (raw.salaryTarget === undefined && raw.salaryThisMonth === undefined) return null;
  const target = amount(raw, 'salaryTarget', file);
  if (target === 0) throw new DeskProfileError(`${file}: "salaryTarget" must be above 0`);
  const thisMonth = raw.salaryThisMonth === undefined ? 0 : amount(raw, 'salaryThisMonth', file);
  return { thisMonth, target };
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
    board: {
      title: text(raw, 'boardTitle', DEFAULT_BOARD_TITLE, file),
      countdown: countdown(raw, file),
      salary: salary(raw, file),
    },
  };
}

/** Read and validate the profile; a missing file means defaults, a broken one throws. */
export function readDeskProfile(file: string = deskProfilePath()): DeskProfile {
  return parseDeskProfile(readRawProfile(file), file);
}

export const BOARD_FIELDS = [
  'boardTitle',
  'countdownLabel',
  'countdownDate',
  'salaryThisMonth',
  'salaryTarget',
] as const;

/** One wall-board edit: a value sets the field, null removes it, a missing key leaves it. */
export type BoardPatch = Partial<Record<(typeof BOARD_FIELDS)[number], string | number | null>>;

/**
 * Apply a wall-board edit from the office. The merged file is validated with the same
 * rules as a hand-edited one before anything is written, and written atomically.
 */
export function updateDeskBoard(patch: BoardPatch, file: string = deskProfilePath()): DeskProfile {
  const raw = readRawProfile(file);
  for (const key of BOARD_FIELDS) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === null || value === '') delete raw[key];
    else raw[key] = value;
  }
  const profile = parseDeskProfile(raw, file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');
  fs.renameSync(tmp, file);
  return profile;
}
