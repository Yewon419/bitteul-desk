import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { SceneState } from '../src/sceneState.js';

const dirs: string[] = [];
function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitteul-scene-'));
  dirs.push(dir);
  return path.join(dir, 'bitteul-scene.json');
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('SceneState.arrange', () => {
  it('replaces every seat and sign, dropping sessions that were left out', () => {
    const file = tempFile();
    const scene = new SceneState(file);
    scene.moveSeats([
      { sessionId: 'gone', seat: 14 },
      { sessionId: 'stay', seat: 20 },
    ]);
    scene.setRoomTitle(7, 'Empty');
    scene.arrange([{ sessionId: 'stay', seat: 2 }], { '0': 'HQ', '1': '  Music  ' });
    const reread = new SceneState(file);
    expect(reread.seatOf('stay')).toBe(2);
    expect(reread.seatOf('gone')).toBeUndefined();
    expect(reread.rooms()).toEqual({ '0': 'HQ', '1': 'Music' });
  });

  it('refuses two sessions on one seat and leaves the file alone', () => {
    const file = tempFile();
    const scene = new SceneState(file);
    scene.moveSeats([{ sessionId: 'a', seat: 3 }]);
    expect(() =>
      scene.arrange(
        [
          { sessionId: 'a', seat: 1 },
          { sessionId: 'b', seat: 1 },
        ],
        {},
      ),
    ).toThrow('seat 1 given twice');
    expect(new SceneState(file).seatOf('a')).toBe(3);
  });
});
