/**
 * Bitteul scene arrangement shared by every viewer: which seat each session sits in and
 * the name written on each room's sign. Stored in ~/.pixel-agents/bitteul-scene.json,
 * keyed by session id so it survives server restarts (agent ids do not).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { LAYOUT_FILE_DIR } from './constants.js';

const FILE_NAME = 'bitteul-scene.json';
export const MAX_ROOM_TITLE = 40;

interface SceneFile {
  seats: Record<string, number>;
  rooms: Record<string, string>;
}

export interface SeatMove {
  sessionId: string;
  seat: number;
}

function filePath(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR, FILE_NAME);
}

export class SceneState {
  private data: SceneFile;

  constructor(private readonly file: string = filePath()) {
    this.data = SceneState.read(file);
  }

  private static read(file: string): SceneFile {
    if (!fs.existsSync(file)) return { seats: {}, rooms: {} };
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<SceneFile>;
    return { seats: parsed.seats ?? {}, rooms: parsed.rooms ?? {} };
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf-8');
    fs.renameSync(tmp, this.file);
  }

  seatOf(sessionId: string): number | undefined {
    return this.data.seats[sessionId];
  }

  rooms(): Record<string, string> {
    return { ...this.data.rooms };
  }

  /** Apply a set of seat moves at once (a swap is two moves). */
  moveSeats(moves: SeatMove[]): void {
    for (const { seat } of moves) {
      if (!Number.isInteger(seat) || seat < 0) throw new Error(`invalid seat ${seat}`);
    }
    const taken = new Set(moves.map((m) => m.seat));
    for (const [sid, seat] of Object.entries(this.data.seats)) {
      if (taken.has(seat) && !moves.some((m) => m.sessionId === sid)) delete this.data.seats[sid];
    }
    for (const { sessionId, seat } of moves) this.data.seats[sessionId] = seat;
    this.save();
  }

  /**
   * Replace the whole arrangement: `seats` is every seated session, so a session left out
   * (gone home) loses its old seat and cannot reopen a far room when it comes back.
   */
  arrange(seats: SeatMove[], rooms: Record<string, string>): void {
    const used = new Set<number>();
    for (const { seat } of seats) {
      if (!Number.isInteger(seat) || seat < 0) throw new Error(`invalid seat ${seat}`);
      if (used.has(seat)) throw new Error(`seat ${seat} given twice`);
      used.add(seat);
    }
    const nextRooms: Record<string, string> = {};
    for (const [index, title] of Object.entries(rooms)) {
      if (!/^[0-9]{1,3}$/.test(index)) throw new Error(`invalid room ${index}`);
      const clean = title.trim().slice(0, MAX_ROOM_TITLE);
      if (clean) nextRooms[index] = clean;
    }
    this.data = {
      seats: Object.fromEntries(seats.map(({ sessionId, seat }) => [sessionId, seat])),
      rooms: nextRooms,
    };
    this.save();
  }

  setRoomTitle(index: number, title: string): void {
    const clean = title.trim().slice(0, MAX_ROOM_TITLE);
    if (clean) this.data.rooms[String(index)] = clean;
    else delete this.data.rooms[String(index)];
    this.save();
  }
}
