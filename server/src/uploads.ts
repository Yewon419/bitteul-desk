/**
 * Files attached in the chat window (picked on a phone, dropped or pasted on a laptop).
 * They are saved under ~/.pixel-agents/uploads/<date>/ so the agent can read them by path;
 * pictures also travel inside the message so the model sees them, as a terminal paste does.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { LAYOUT_FILE_DIR } from './constants.js';

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
/** Larger pictures are still saved and linked by path, just not embedded in the message. */
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
const INLINE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
type InlineImageType = (typeof INLINE_IMAGE_TYPES)[number];
const MAX_NAME_CHARS = 120;

export interface Attachment {
  path: string;
  name: string;
  size: number;
  mime: string;
}

export type MessageBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: InlineImageType; data: string } };

export function uploadsRoot(home: string): string {
  return path.join(home, LAYOUT_FILE_DIR, 'uploads');
}

/** Keep the user's file name readable but safe on every file system. */
export function safeFileName(name: string): string {
  const base = path
    .basename(name)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .trim();
  const cleaned = base.replace(/^\.+/, '') || 'file';
  return cleaned.length > MAX_NAME_CHARS ? cleaned.slice(-MAX_NAME_CHARS) : cleaned;
}

export function saveUpload(root: string, name: string, mime: string, data: Buffer): Attachment {
  if (data.length === 0) throw new Error('empty upload');
  const day = new Date().toISOString().slice(0, 10);
  const dir = path.join(root, day);
  fs.mkdirSync(dir, { recursive: true });
  const fileName = `${crypto.randomBytes(4).toString('hex')}-${safeFileName(name)}`;
  const file = path.join(dir, fileName);
  fs.writeFileSync(file, data, { flag: 'wx' });
  return { path: file, name: safeFileName(name), size: data.length, mime };
}

/** Only files this server saved may be attached; anything else is refused. */
export function isInsideUploads(root: string, file: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function inlineType(mime: string): InlineImageType | null {
  return (INLINE_IMAGE_TYPES as readonly string[]).includes(mime)
    ? (mime as InlineImageType)
    : null;
}

/** The user turn: text with the attached paths listed, plus embedded pictures. */
export function messageContent(text: string, attachments: Attachment[]): string | MessageBlock[] {
  if (attachments.length === 0) return text;
  const list = attachments.map((a) => `- ${a.path}`).join('\n');
  const blocks: MessageBlock[] = [
    { type: 'text', text: `${text.trim() ? `${text.trim()}\n\n` : ''}첨부 파일:\n${list}` },
  ];
  for (const a of attachments) {
    const media = inlineType(a.mime);
    if (!media || a.size > MAX_INLINE_IMAGE_BYTES) continue;
    blocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: media,
        data: fs.readFileSync(a.path).toString('base64'),
      },
    });
  }
  return blocks;
}
