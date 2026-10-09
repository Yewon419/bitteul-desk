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
const QUESTION_TOOL = 'AskUserQuestion';
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
  /** tool_use id, and the tool_use a tool_result answers. */
  id?: string;
  tool_use_id?: string;
  input?: Record<string, unknown>;
  /** tool_result payload: plain text or text blocks. */
  content?: string | ContentBlock[];
}

interface TranscriptRecord {
  type?: string;
  subtype?: string;
  /** A system record's text; for local_command, the command or its output. */
  content?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  timestamp?: string;
  cwd?: string;
  aiTitle?: string;
  customTitle?: string;
  message?: { content?: string | ContentBlock[] };
  /** Structured tool output; for a question, the answers keyed by question text. */
  toolUseResult?: unknown;
  /** A message typed while the agent was busy lands as a queued_command attachment. */
  attachment?: { type?: string; prompt?: string | ContentBlock[]; timestamp?: string };
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function tagText(text: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  return match ? match[1] : null;
}

/** A slash command the user ran ("/mcp") or what it printed, as the CLI records them:
 *  tagged text in a user record or a local_command system record. */
function commandEntry(text: string, timestamp: string | undefined): ConversationEntry | null {
  const name = tagText(text, 'command-name');
  if (name) {
    const args = tagText(text, 'command-args')?.trim() ?? '';
    return {
      kind: 'user',
      text: clip(args ? `${name} ${args}` : name, MAX_ENTRY_CHARS),
      timestamp,
    };
  }
  const output = tagText(text, 'local-command-stdout') ?? tagText(text, 'local-command-stderr');
  const plain = output?.replace(/\x1b\[[0-9;]*m/g, '').trim();
  return plain ? { kind: 'assistant', text: clip(plain, MAX_ENTRY_CHARS), timestamp } : null;
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

/** The questions an AskUserQuestion call put to the user, with their choices. */
function questionText(input: Record<string, unknown> | undefined): string {
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  const lines = questions.flatMap((q: unknown) => {
    if (!q || typeof q !== 'object') return [];
    const { question, options } = q as { question?: unknown; options?: unknown };
    if (typeof question !== 'string') return [];
    const labels = (Array.isArray(options) ? options : [])
      .map((o: unknown) => (o && typeof o === 'object' ? (o as { label?: unknown }).label : null))
      .filter((l): l is string => typeof l === 'string');
    return [labels.length ? `· ${question} (${labels.join(' / ')})` : `· ${question}`];
  });
  return clip(['질문', ...lines].join('\n'), MAX_ENTRY_CHARS);
}

/** The user's answers to a question call, or null when it was not answered. */
function answerText(toolUseResult: unknown): string | null {
  if (!toolUseResult || typeof toolUseResult !== 'object') return null;
  const answers = (toolUseResult as { answers?: unknown }).answers;
  if (!answers || typeof answers !== 'object') return null;
  const lines = Object.entries(answers as Record<string, unknown>)
    .filter((e): e is [string, string] => typeof e[1] === 'string')
    .map(([question, answer]) => `· ${question}\n  → ${answer}`);
  return lines.length ? clip(['답변', ...lines].join('\n'), MAX_ENTRY_CHARS) : null;
}

/** What parsing has gathered so far, so a growing transcript is read once, not per poll. */
interface ParseState {
  aiTitle: string | null;
  customTitle: string | null;
  entries: ConversationEntry[];
  questionIds: Set<string>;
}

function newParseState(): ParseState {
  return { aiTitle: null, customTitle: null, entries: [], questionIds: new Set() };
}

function parseLines(state: ParseState, jsonl: string, maxEntries: number): void {
  const { entries, questionIds } = state;
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let rec: TranscriptRecord;
    try {
      rec = JSON.parse(line) as TranscriptRecord;
    } catch {
      continue; // a partially written last line
    }
    if (rec.type === 'ai-title' && rec.aiTitle) state.aiTitle = rec.aiTitle;
    if (rec.type === 'custom-title' && rec.customTitle) state.customTitle = rec.customTitle;
    if (rec.isSidechain || rec.isMeta) continue;
    const content = rec.message?.content;
    if (rec.type === 'system' && rec.subtype === 'local_command' && rec.content) {
      const entry = commandEntry(rec.content, rec.timestamp);
      if (entry) entries.push(entry);
      continue;
    }
    if (rec.type === 'user') {
      // Only a record that IS a command, never a tool output that happens to quote one.
      const typed = (
        typeof content === 'string'
          ? content
          : (content ?? [])
              .filter((b) => b.type === 'text')
              .map((b) => b.text ?? '')
              .join('\n')
      ).trim();
      if (typed.startsWith('<command-') || typed.startsWith('<local-command-std')) {
        const entry = commandEntry(typed, rec.timestamp);
        if (entry) entries.push(entry);
        continue;
      }
      const text = userText(content);
      if (text) {
        const entry: ConversationEntry = { kind: 'user', text, timestamp: rec.timestamp };
        withMedia(entry, blockText(content), rec.cwd);
        entries.push(entry);
      } else if (Array.isArray(content)) {
        const results = content.filter((b) => b.type === 'tool_result');
        const answer = results.some((b) => b.tool_use_id && questionIds.has(b.tool_use_id))
          ? answerText(rec.toolUseResult)
          : null;
        if (answer) {
          entries.push({ kind: 'user', text: answer, timestamp: rec.timestamp });
          continue;
        }
        // A tool's output ("saved to out.png") belongs to the tool call before it.
        const last = entries[entries.length - 1];
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
        } else if (block.type === 'tool_use' && block.name === QUESTION_TOOL) {
          if (block.id) questionIds.add(block.id);
          entries.push({
            kind: 'assistant',
            text: questionText(block.input),
            timestamp: rec.timestamp,
          });
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
  // Only the newest entry is ever touched again (a tool output joins its call).
  if (entries.length > maxEntries) entries.splice(0, entries.length - maxEntries);
}

function viewOf(state: ParseState): ConversationView {
  return { title: state.customTitle ?? state.aiTitle, entries: [...state.entries] };
}

export function parseConversation(jsonl: string, maxEntries: number): ConversationView {
  const state = newParseState();
  parseLines(state, jsonl, maxEntries);
  return viewOf(state);
}

/** The folder the session last worked in, from the newest records (the tail only: a
 *  transcript can run past 100MB). Null when no record in the tail names one. */
export function readSessionCwd(jsonlFile: string): string | null {
  const TAIL_BYTES = 256 * 1024;
  const fd = fs.openSync(jsonlFile, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, size - length);
    const lines = buf.toString('utf-8').split('\n').reverse();
    for (const line of lines) {
      try {
        const cwd = (JSON.parse(line) as TranscriptRecord).cwd;
        if (typeof cwd === 'string' && cwd) return cwd;
      } catch {
        // the cut first line or a partial last one
      }
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

export function readConversation(jsonlFile: string, maxEntries: number): ConversationView {
  return parseConversation(fs.readFileSync(jsonlFile, 'utf-8'), maxEntries);
}

interface CachedTranscript {
  /** Bytes parsed so far: always the end of a complete line. */
  offset: number;
  size: number;
  mtimeMs: number;
  state: ParseState;
  view: ConversationView;
}

/** Parses a transcript once, then only the lines appended since. A live session's
 *  transcript changes every few seconds and can pass 100MB, so a full re-parse per
 *  poll blocks the server for seconds. A file that shrank is parsed again from the start. */
export class ConversationCache {
  private readonly cache = new Map<string, CachedTranscript>();

  constructor(private readonly maxEntries: number) {}

  get(jsonlFile: string): ConversationView {
    const stat = fs.statSync(jsonlFile);
    let hit = this.cache.get(jsonlFile);
    if (hit && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs) return hit.view;
    if (!hit || stat.size < hit.offset) {
      hit = {
        offset: 0,
        size: 0,
        mtimeMs: 0,
        state: newParseState(),
        view: viewOf(newParseState()),
      };
    }
    const added = readFrom(jsonlFile, hit.offset, stat.size);
    const end = added.lastIndexOf(0x0a) + 1; // a partly written last line waits for the next read
    if (end > 0) {
      parseLines(hit.state, added.subarray(0, end).toString('utf-8'), this.maxEntries);
      hit.offset += end;
      hit.view = viewOf(hit.state);
    }
    hit.size = stat.size;
    hit.mtimeMs = stat.mtimeMs;
    this.cache.set(jsonlFile, hit);
    return hit.view;
  }
}

function readFrom(file: string, start: number, end: number): Buffer {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(Math.max(0, end - start));
    let read = 0;
    while (read < buf.length) {
      const n = fs.readSync(fd, buf, read, buf.length - read, start + read);
      if (n === 0) break;
      read += n;
    }
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}
