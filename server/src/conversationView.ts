/**
 * Read-only view of a Claude Code transcript (JSONL) for the Bitteul dashboard:
 * the session's title and a flat list of chat entries.
 */

import * as fs from 'fs';

import { findMediaPaths } from './mediaPreview.js';

export type EntryKind = 'user' | 'assistant' | 'tool';

export interface ConversationEntry {
  kind: EntryKind;
  text: string;
  timestamp?: string;
  /** Picture, video and sound files this entry mentions, as absolute paths. */
  media?: string[];
}

export interface ConversationView {
  title: string | null;
  entries: ConversationEntry[];
}

const MAX_ENTRY_CHARS = 4000;
const MAX_TOOL_CHARS = 160;
const HIDDEN_USER_PREFIXES = [
  '<command-',
  '<local-command',
  '<system-reminder',
  '<task-notification',
];

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  /** tool_result payload: plain text or text blocks. */
  content?: string | ContentBlock[];
}

interface TranscriptRecord {
  type?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  timestamp?: string;
  cwd?: string;
  aiTitle?: string;
  customTitle?: string;
  message?: { content?: string | ContentBlock[] };
  /** A message typed while the agent was busy lands as a queued_command attachment. */
  attachment?: { type?: string; prompt?: string | ContentBlock[]; timestamp?: string };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function toolLine(block: ContentBlock): string {
  const input = block.input ?? {};
  const detail =
    (typeof input.description === 'string' && input.description) ||
    (typeof input.command === 'string' && input.command) ||
    (typeof input.file_path === 'string' && input.file_path) ||
    (typeof input.pattern === 'string' && input.pattern) ||
    '';
  return clip(
    detail ? `${block.name ?? 'tool'}: ${detail}` : (block.name ?? 'tool'),
    MAX_TOOL_CHARS,
  );
}

function blockText(content: string | ContentBlock[] | undefined): string {
  if (typeof content === 'string') return content;
  return (content ?? [])
    .map((b) => (typeof b.text === 'string' ? b.text : blockText(b.content)))
    .join('\n');
}

function withMedia(entry: ConversationEntry, source: string, cwd: string | undefined): void {
  const found = findMediaPaths(source, cwd);
  if (found.length) entry.media = [...new Set([...(entry.media ?? []), ...found])];
}

function userText(content: string | ContentBlock[] | undefined): string | null {
  const text =
    typeof content === 'string'
      ? content
      : (content ?? [])
          .filter((b) => b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text)
          .join('\n');
  const trimmed = text.trim();
  if (!trimmed || HIDDEN_USER_PREFIXES.some((p) => trimmed.startsWith(p))) return null;
  return clip(trimmed, MAX_ENTRY_CHARS);
}

export function parseConversation(jsonl: string, maxEntries: number): ConversationView {
  let aiTitle: string | null = null;
  let customTitle: string | null = null;
  const entries: ConversationEntry[] = [];
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let rec: TranscriptRecord;
    try {
      rec = JSON.parse(line) as TranscriptRecord;
    } catch {
      continue; // a partially written last line
    }
    if (rec.type === 'ai-title' && rec.aiTitle) aiTitle = rec.aiTitle;
    if (rec.type === 'custom-title' && rec.customTitle) customTitle = rec.customTitle;
    if (rec.isSidechain || rec.isMeta) continue;
    const content = rec.message?.content;
    if (rec.type === 'user') {
      const text = userText(content);
      if (text) {
        const entry: ConversationEntry = { kind: 'user', text, timestamp: rec.timestamp };
        withMedia(entry, blockText(content), rec.cwd);
        entries.push(entry);
      } else if (Array.isArray(content)) {
        // A tool's output ("saved to out.png") belongs to the tool call before it.
        const last = entries[entries.length - 1];
        const results = content.filter((b) => b.type === 'tool_result');
        if (last?.kind === 'tool' && results.length) {
          withMedia(last, blockText(results), rec.cwd);
        }
      }
    } else if (rec.type === 'attachment' && rec.attachment?.type === 'queued_command') {
      const text = userText(rec.attachment.prompt);
      if (text) {
        entries.push({
          kind: 'user',
          text,
          timestamp: rec.attachment.timestamp ?? rec.timestamp,
        });
      }
    } else if (rec.type === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text?.trim()) {
          const entry: ConversationEntry = {
            kind: 'assistant',
            text: clip(block.text.trim(), MAX_ENTRY_CHARS),
            timestamp: rec.timestamp,
          };
          withMedia(entry, block.text, rec.cwd);
          entries.push(entry);
        } else if (block.type === 'tool_use') {
          const entry: ConversationEntry = {
            kind: 'tool',
            text: toolLine(block),
            timestamp: rec.timestamp,
          };
          const inputs = Object.values(block.input ?? {}).filter((v) => typeof v === 'string');
          withMedia(entry, inputs.join('\n'), rec.cwd);
          entries.push(entry);
        }
      }
    }
  }
  return { title: customTitle ?? aiTitle, entries: entries.slice(-maxEntries) };
}

export function readConversation(jsonlFile: string, maxEntries: number): ConversationView {
  return parseConversation(fs.readFileSync(jsonlFile, 'utf-8'), maxEntries);
}

/** Re-parses a transcript only when its size or mtime changed. */
export class ConversationCache {
  private readonly cache = new Map<
    string,
    { size: number; mtimeMs: number; view: ConversationView }
  >();

  constructor(private readonly maxEntries: number) {}

  get(jsonlFile: string): ConversationView {
    const stat = fs.statSync(jsonlFile);
    const hit = this.cache.get(jsonlFile);
    if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) return hit.view;
    const view = readConversation(jsonlFile, this.maxEntries);
    this.cache.set(jsonlFile, { size: stat.size, mtimeMs: stat.mtimeMs, view });
    return view;
  }
}
