import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { parseConversation } from '../src/conversationView.js';
import { describeMedia, findMediaPaths } from '../src/mediaPreview.js';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

describe('findMediaPaths', () => {
  it('finds absolute, quoted-with-spaces and relative media paths, not URLs or other files', () => {
    const cwd = path.resolve('/work/proj');
    const found = findMediaPaths(
      [
        '완성: C:\\Users\\a\\out\\final.mp4 그리고 `C:\\Users\\a\\내 폴더\\cover art.png`',
        '소리는 assets/bgm.mp3, 문서는 notes.md',
        'https://example.com/pic.png 는 웹 주소',
      ].join('\n'),
      cwd,
    );
    expect(found).toContain(path.normalize('C:\\Users\\a\\out\\final.mp4'));
    expect(found).toContain(path.normalize('C:\\Users\\a\\내 폴더\\cover art.png'));
    expect(found).toContain(path.resolve(cwd, 'assets/bgm.mp3'));
    expect(found.some((f) => f.endsWith('notes.md'))).toBe(false);
    expect(found.some((f) => f.includes('example.com'))).toBe(false);
  });

  it('returns quickly on long slash-heavy text with no media in it', () => {
    const slashy = 'a/'.repeat(40) + 'b'.repeat(40);
    const text = [slashy, 'x/'.repeat(200_000), slashy].join(' ');
    const started = Date.now();
    expect(findMediaPaths(text, undefined)).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('media in conversations', () => {
  it('attaches files from text, tool input and tool output, and describes only existing ones', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bitteul-media-'));
    dirs.push(dir);
    const shot = path.join(dir, 'shot.png');
    fs.writeFileSync(shot, 'png');
    const view = parseConversation(
      [
        {
          type: 'assistant',
          cwd: dir,
          message: {
            content: [
              {
                type: 'tool_use',
                name: 'Bash',
                input: { command: 'ffmpeg -i in.mov clip.mp4', description: 'Cut' },
              },
            ],
          },
        },
        {
          type: 'user',
          cwd: dir,
          message: { content: [{ type: 'tool_result', content: 'saved shot.png' }] },
        },
        {
          type: 'assistant',
          cwd: dir,
          message: { content: [{ type: 'text', text: '`shot.png` 확인해줘' }] },
        },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n'),
      100,
    );
    expect(view.entries[0].media).toEqual([
      path.join(dir, 'in.mov'),
      path.join(dir, 'clip.mp4'),
      shot,
    ]);
    expect(view.entries[1].media).toEqual([shot]);
    const described = describeMedia(view.entries[0].media ?? []);
    expect(described).toMatchObject([{ path: shot, name: 'shot.png', kind: 'image', size: 3 }]);
  });
});
