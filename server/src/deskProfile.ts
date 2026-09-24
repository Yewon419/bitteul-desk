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

/** Read and validate the profile; a missing file means defaults, a broken one throws. */
export function readDeskProfile(file: string = deskProfilePath()): DeskProfile {
  if (!fs.existsSync(file)) {
    return {
      userName: DEFAULT_USER_NAME,
      board: { title: DEFAULT_BOARD_TITLE, countdown: null, salary: null },
    };
  }
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
  const raw = parsed as Record<string, unknown>;
  return {
    userName: text(raw, 'userName', DEFAULT_USER_NAME, file),
    board: {
      title: text(raw, 'boardTitle', DEFAULT_BOARD_TITLE, file),
      countdown: countdown(raw, file),
      salary: salary(raw, file),
    },
  };
}
