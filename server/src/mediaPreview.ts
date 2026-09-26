/**
 * Pictures, videos and sound files a session mentions, so the chat window can preview the
 * agent's work in place. Only paths found in the session's own transcript are ever served.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type MediaKind = 'image' | 'video' | 'audio';

const MEDIA_TYPES: Record<string, { kind: MediaKind; mime: string }> = {
  '.png': { kind: 'image', mime: 'image/png' },
  '.jpg': { kind: 'image', mime: 'image/jpeg' },
  '.jpeg': { kind: 'image', mime: 'image/jpeg' },
  '.gif': { kind: 'image', mime: 'image/gif' },
  '.webp': { kind: 'image', mime: 'image/webp' },
  '.svg': { kind: 'image', mime: 'image/svg+xml' },
  '.bmp': { kind: 'image', mime: 'image/bmp' },
  '.mp4': { kind: 'video', mime: 'video/mp4' },
  '.m4v': { kind: 'video', mime: 'video/mp4' },
  '.webm': { kind: 'video', mime: 'video/webm' },
  '.mov': { kind: 'video', mime: 'video/quicktime' },
  '.mp3': { kind: 'audio', mime: 'audio/mpeg' },
  '.wav': { kind: 'audio', mime: 'audio/wav' },
  '.ogg': { kind: 'audio', mime: 'audio/ogg' },
  '.m4a': { kind: 'audio', mime: 'audio/mp4' },
  '.aac': { kind: 'audio', mime: 'audio/aac' },
  '.flac': { kind: 'audio', mime: 'audio/flac' },
};

/** Past this size the chat shows the file name only; the browser would hold it all in memory. */
export const MAX_PREVIEW_BYTES = 200 * 1024 * 1024;

const EXT = Object.keys(MEDIA_TYPES)
  .map((e) => e.slice(1))
  .join('|');
/** Paths in backticks may contain spaces; bare ones end at whitespace or punctuation. */
const QUOTED = new RegExp(`[\`"']([^\`"'\\n]+\\.(?:${EXT}))[\`"']`, 'gi');
/** Directory segments exclude separators: a segment class that also matched `/` and `\`
 *  made the nested repeat ambiguous and backtracked exponentially on long slashy text,
 *  freezing the server's event loop. */
const BARE = new RegExp(
  `(?:[A-Za-z]:[\\\\/]|[\\\\/~.])?(?:[^\\s\`"'<>|*?()\\[\\]\\\\/]+[\\\\/])*[^\\s\`"'<>|*?()\\[\\]\\\\/]+\\.(?:${EXT})(?![\\w.])`,
  'gi',
);
/** Whitespace-free runs longer than this (base64, minified code) are never a bare path,
 *  and scanning them would still cost time quadratic in their length. */
const MAX_BARE_RUN = 1024;

export function mediaType(file: string): { kind: MediaKind; mime: string } | null {
  return MEDIA_TYPES[path.extname(file).toLowerCase()] ?? null;
}

/** Media file paths in a piece of text, made absolute against the session's folder. */
export function findMediaPaths(text: string, cwd: string | undefined): string[] {
  const found = new Set<string>();
  const add = (raw: string): void => {
    const trimmed = raw.trim();
    if (/^[a-z]+:\/\//i.test(trimmed)) return;
    const expanded = /^~[\\/]/.test(trimmed) ? path.join(os.homedir(), trimmed.slice(2)) : trimmed;
    if (path.isAbsolute(expanded) || /^[A-Za-z]:[\\/]/.test(expanded)) {
      found.add(path.normalize(expanded));
    } else if (cwd) {
      found.add(path.resolve(cwd, expanded));
    }
  };
  for (const m of text.matchAll(QUOTED)) add(m[1]);
  for (const run of text.split(/\s+/)) {
    if (run.length > MAX_BARE_RUN) continue;
    for (const m of run.matchAll(BARE)) {
      const before = m.index > 0 ? run[m.index - 1] : '';
      if (before === '/' || before === ':') continue; // the tail of a URL
      add(m[0]);
    }
  }
  return [...found];
}

export interface MediaRef {
  path: string;
  name: string;
  kind: MediaKind;
  size: number;
  /** Changes when the file is rewritten, so the chat reloads it. */
  version: number;
  tooLarge: boolean;
}

/** The mentioned files that exist right now; missing ones are dropped. */
export function describeMedia(paths: string[]): MediaRef[] {
  const refs: MediaRef[] = [];
  for (const file of paths) {
    const type = mediaType(file);
    if (!type) continue;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    refs.push({
      path: file,
      name: path.basename(file),
      kind: type.kind,
      size: stat.size,
      version: Math.round(stat.mtimeMs),
      tooLarge: stat.size > MAX_PREVIEW_BYTES,
    });
  }
  return refs;
}
