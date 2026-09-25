import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { isInsideUploads, messageContent, safeFileName, saveUpload } from '../src/uploads.js';

describe('chat attachments', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

  it('keeps names readable but strips path tricks and reserved characters', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('보고서: 최종?.pdf')).toBe('보고서_ 최종_.pdf');
    expect(safeFileName('...')).toBe('file');
  });

  it('attaches only files inside the uploads folder', () => {
    const root = path.join(os.tmpdir(), 'bitteul-up-root');
    expect(isInsideUploads(root, path.join(root, '2026-09-26', 'a.png'))).toBe(true);
    expect(isInsideUploads(root, path.join(root, '..', 'secret.txt'))).toBe(false);
    expect(isInsideUploads(root, root)).toBe(false);
  });

  it('lists every file by path and embeds pictures so the model can see them', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bitteul-up-'));
    dirs.push(root);
    const png = saveUpload(root, 'shot.png', 'image/png', Buffer.from([137, 80, 78, 71]));
    const pdf = saveUpload(root, 'doc.pdf', 'application/pdf', Buffer.from('%PDF'));
    expect(messageContent('그냥 글', [])).toBe('그냥 글');
    const blocks = messageContent('이거 봐줘', [png, pdf]);
    expect(Array.isArray(blocks)).toBe(true);
    const [text, image] = blocks as Array<{
      type: string;
      text?: string;
      source?: { data: string };
    }>;
    expect(text.text).toContain('이거 봐줘');
    expect(text.text).toContain(png.path);
    expect(text.text).toContain(pdf.path);
    expect(image.type).toBe('image');
    expect(image.source?.data).toBe(Buffer.from([137, 80, 78, 71]).toString('base64'));
    expect((blocks as unknown[]).length).toBe(2);
  });
});
