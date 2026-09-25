/**
 * Sessions the Bitteul dashboard owns: started or resumed through the Claude Agent SDK
 * with a streaming prompt, so the dashboard can keep sending turns and answer tool
 * permission prompts. Sessions still open in a terminal are never touched here.
 *
 * The SDK is ESM and this bundle is CJS, so it is loaded with a dynamic import.
 */

import type {
  CanUseTool,
  ModelInfo,
  PermissionResult,
  Query,
  SDKMessage,
  SDKUserMessage,
  SlashCommand,
} from '@anthropic-ai/claude-agent-sdk' with { 'resolution-mode': 'import' };
import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type { MessageBlock } from './uploads.js';

/** A user turn: plain text, or text plus embedded pictures from the chat's attachments. */
export type TurnContent = string | MessageBlock[];

export interface QuestionOption {
  label: string;
  description: string;
}

/** One multiple-choice question from the AskUserQuestion tool. */
export interface Question {
  question: string;
  header: string;
  multiSelect: boolean;
  options: QuestionOption[];
}

export interface PermissionAsk {
  requestId: string;
  sessionId: string;
  toolName: string;
  summary: string;
  /** Present when the agent is asking the user to choose, not asking for approval. */
  questions?: Question[];
}

export type SessionOwner = 'dashboard' | 'terminal' | 'none';

/** Permission modes the chat window offers; bypassPermissions and dontAsk stay off the menu. */
export const DASHBOARD_MODES = ['auto', 'default', 'acceptEdits', 'plan'] as const;
export type DashboardMode = (typeof DASHBOARD_MODES)[number];
/** Dashboard sessions start like the terminal: auto mode approves what its classifier deems safe. */
export const DEFAULT_DASHBOARD_MODE: DashboardMode = 'auto';

export interface SessionSettings {
  mode: DashboardMode;
  /** null = the CLI's default model. */
  model: string | null;
}

export interface SessionCatalog {
  commands: Array<{ name: string; description: string; argumentHint: string }>;
  models: Array<{ value: string; displayName: string; description: string }>;
}

/** What the running turn has done so far, for the chat's "작업 중… (1분 2초 · ↓ 3.5k)" line. */
export interface TurnActivity {
  elapsedMs: number;
  outputTokens: number;
}

interface Turn {
  startedAt: number;
  /** Output tokens per API message id; streamed messages repeat an id, so the latest wins. */
  tokensByMessage: Map<string, number>;
}

function newTurn(): Turn {
  return { startedAt: Date.now(), tokensByMessage: new Map() };
}

interface Managed {
  sessionId: string;
  busy: boolean;
  turn: Turn | null;
  /** The CLI's guess at the user's next message, offered once a turn ends. */
  suggestion: string | null;
  settings: SessionSettings;
  push: (content: TurnContent) => void;
  close: () => void;
  query: Query;
}

interface Pending extends PermissionAsk {
  input: Record<string, unknown>;
  resolve: (result: PermissionResult) => void;
}

interface LiveSession {
  sessionId?: string;
  kind?: string;
  pid?: number;
}

const LIVE_CACHE_MS = 3000;
const SUMMARY_CHARS = 200;
const QUESTION_TOOL = 'AskUserQuestion';
const MAX_ANSWER_CHARS = 2000;

export class DashboardSessionError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Resolve the installed claude executable: env override, else next to the npm shim on PATH. */
export function resolveClaudeExecutable(): string {
  const override = process.env.BITTEUL_CLAUDE_EXE;
  if (override) {
    if (!fs.existsSync(override)) throw new Error(`BITTEUL_CLAUDE_EXE not found: ${override}`);
    return override;
  }
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidates = [
      path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', exe),
      path.join(dir, exe),
    ];
    const hit = candidates.find((c) => fs.existsSync(c));
    if (hit) return hit;
  }
  throw new Error('claude executable not found on PATH; set BITTEUL_CLAUDE_EXE');
}

function summarize(toolName: string, input: Record<string, unknown>): string {
  const detail =
    (typeof input.command === 'string' && input.command) ||
    (typeof input.file_path === 'string' && input.file_path) ||
    (typeof input.url === 'string' && input.url) ||
    JSON.stringify(input);
  const text = `${toolName}: ${detail}`;
  return text.length > SUMMARY_CHARS ? `${text.slice(0, SUMMARY_CHARS - 1)}…` : text;
}

/** The AskUserQuestion input as questions the dashboard can render; null if it does not fit. */
export function parseQuestions(input: Record<string, unknown>): Question[] | null {
  const raw = input.questions;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const questions: Question[] = [];
  for (const q of raw as unknown[]) {
    if (typeof q !== 'object' || q === null) return null;
    const { question, header, multiSelect, options } = q as Record<string, unknown>;
    if (typeof question !== 'string' || !Array.isArray(options) || options.length === 0)
      return null;
    const opts: QuestionOption[] = [];
    for (const o of options as unknown[]) {
      if (typeof o !== 'object' || o === null) return null;
      const { label, description } = o as Record<string, unknown>;
      if (typeof label !== 'string') return null;
      opts.push({ label, description: typeof description === 'string' ? description : '' });
    }
    questions.push({
      question,
      header: typeof header === 'string' ? header : '',
      multiSelect: multiSelect === true,
      options: opts,
    });
  }
  return questions;
}

export class ManagedSessions {
  private readonly sessions = new Map<string, Managed>();
  private readonly pending = new Map<string, Pending>();
  private liveCache: { at: number; ids: Set<string> } | null = null;
  /** Mode/model chosen for a session before the dashboard holds it; applied when it opens. */
  private readonly preferred = new Map<string, SessionSettings>();
  /** Commands and models the CLI reported last; the same for every session on this machine. */
  private catalogCache: SessionCatalog | null = null;

  constructor(
    private readonly cwd: string,
    private readonly claudeExe: string,
    private readonly log: (msg: string, extra?: Record<string, unknown>) => void,
  ) {}

  owner(sessionId: string, liveTerminalIds: Set<string>): SessionOwner {
    if (this.sessions.has(sessionId)) return 'dashboard';
    return liveTerminalIds.has(sessionId) ? 'terminal' : 'none';
  }

  isBusy(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.busy ?? false;
  }

  pendingFor(sessionId: string): PermissionAsk[] {
    return [...this.pending.values()]
      .filter((p) => p.sessionId === sessionId)
      .map(({ requestId, sessionId: sid, toolName, summary, questions }) => ({
        requestId,
        sessionId: sid,
        toolName,
        summary,
        ...(questions ? { questions } : {}),
      }));
  }

  activity(sessionId: string): TurnActivity | null {
    const turn = this.sessions.get(sessionId)?.turn;
    if (!turn) return null;
    let outputTokens = 0;
    for (const n of turn.tokensByMessage.values()) outputTokens += n;
    return { elapsedMs: Date.now() - turn.startedAt, outputTokens };
  }

  suggestionFor(sessionId: string): string | null {
    const session = this.sessions.get(sessionId);
    return session && !session.busy ? session.suggestion : null;
  }

  settingsFor(sessionId: string): SessionSettings {
    return (
      this.sessions.get(sessionId)?.settings ??
      this.preferred.get(sessionId) ?? { mode: DEFAULT_DASHBOARD_MODE, model: null }
    );
  }

  /** Change mode and/or model; a live session switches now, any other one when it opens. */
  async updateSettings(
    sessionId: string,
    change: Partial<SessionSettings>,
  ): Promise<SessionSettings> {
    const next = { ...this.settingsFor(sessionId), ...change };
    const session = this.sessions.get(sessionId);
    if (session) {
      if (change.mode !== undefined) await session.query.setPermissionMode(change.mode);
      if (change.model !== undefined) await session.query.setModel(change.model ?? undefined);
      session.settings = next;
    } else {
      this.preferred.set(sessionId, next);
    }
    this.log('session settings changed', { sessionId, ...next });
    return next;
  }

  /** Slash commands and models the CLI offers. Needs one live session to have asked once. */
  async catalog(sessionId: string): Promise<SessionCatalog> {
    const session = this.sessions.get(sessionId) ?? [...this.sessions.values()][0];
    if (!session) return this.catalogCache ?? { commands: [], models: [] };
    const [commands, models] = await Promise.all([
      session.query.supportedCommands(),
      session.query.supportedModels(),
    ]);
    this.catalogCache = {
      commands: commands.map((c: SlashCommand) => ({
        name: c.name,
        description: c.description,
        argumentHint: c.argumentHint,
      })),
      models: models.map((m: ModelInfo) => ({
        value: m.value,
        displayName: m.displayName,
        description: m.description,
      })),
    };
    return this.catalogCache;
  }

  /** Session ids of interactive sessions currently running in a terminal (`claude agents --json`). */
  async liveTerminalSessions(): Promise<Set<string>> {
    if (this.liveCache && Date.now() - this.liveCache.at < LIVE_CACHE_MS) return this.liveCache.ids;
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        this.claudeExe,
        ['agents', '--json'],
        { timeout: 15000, windowsHide: true },
        (err, out, errOut) => {
          if (err) reject(new Error(`claude agents --json failed: ${err.message} ${errOut}`));
          else resolve(out);
        },
      );
    });
    const list = JSON.parse(stdout) as LiveSession[];
    const ids = new Set(
      list
        .filter(
          (s) =>
            s.sessionId &&
            !this.sessions.has(s.sessionId) &&
            (s.pid !== undefined || s.kind === 'background'),
        )
        .map((s) => s.sessionId as string),
    );
    this.liveCache = { at: Date.now(), ids };
    return ids;
  }

  /** Send a turn to a session, resuming it under the dashboard if nothing else holds it. */
  async send(sessionId: string, content: TurnContent): Promise<void> {
    const managed = this.sessions.get(sessionId);
    if (managed) {
      // A message sent mid-turn joins the running turn; keep its clock and token count.
      managed.busy = true;
      managed.turn ??= newTurn();
      managed.suggestion = null;
      managed.push(content);
      return;
    }
    if ((await this.liveTerminalSessions()).has(sessionId)) {
      throw new DashboardSessionError('session is open in a terminal', 409);
    }
    await this.open({ resume: sessionId }, content, this.settingsFor(sessionId));
  }

  /** Start a brand-new session with a first message. Resolves with its session id. */
  async start(content: TurnContent, settings?: Partial<SessionSettings>): Promise<string> {
    return this.open({}, content, { ...this.settingsFor(''), ...settings });
  }

  answer(requestId: string, allow: boolean): void {
    const ask = this.pending.get(requestId);
    if (!ask) throw new DashboardSessionError(`no pending permission ${requestId}`, 404);
    this.pending.delete(requestId);
    this.log('permission answered', {
      requestId,
      sessionId: ask.sessionId,
      tool: ask.toolName,
      allow,
    });
    ask.resolve(
      allow
        ? { behavior: 'allow' }
        : { behavior: 'deny', message: '사용자가 대시보드에서 거부했습니다.' },
    );
  }

  /**
   * Answer an AskUserQuestion prompt. The answers ride back in the tool input, which is how the
   * CLI itself hands a terminal user's choice to the model.
   */
  answerQuestion(requestId: string, answers: Record<string, string>): void {
    const ask = this.pending.get(requestId);
    if (!ask) throw new DashboardSessionError(`no pending question ${requestId}`, 404);
    if (!ask.questions) throw new DashboardSessionError(`${requestId} is not a question`, 400);
    for (const q of ask.questions) {
      const answer = answers[q.question];
      if (typeof answer !== 'string' || !answer.trim() || answer.length > MAX_ANSWER_CHARS) {
        throw new DashboardSessionError(`missing answer for "${q.question}"`, 400);
      }
    }
    this.pending.delete(requestId);
    this.log('question answered', { requestId, sessionId: ask.sessionId });
    ask.resolve({ behavior: 'allow', updatedInput: { ...ask.input, answers } });
  }

  /** Stop the running turn, like Esc in the terminal. The session stays open for the next message. */
  async interrupt(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new DashboardSessionError('not a dashboard session', 404);
    this.log('dashboard session interrupted by user', { sessionId });
    await session.query.interrupt();
    session.busy = false;
    session.turn = null;
  }

  /** End one dashboard session; its stream cleanup denies any approval still waiting. */
  end(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.log('dashboard session ended by user', { sessionId });
    session.close();
  }

  dispose(): void {
    for (const s of this.sessions.values()) s.close();
    this.sessions.clear();
  }

  private async open(
    opts: { resume?: string },
    firstContent: TurnContent,
    settings: SessionSettings,
  ): Promise<string> {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const queue: SDKUserMessage[] = [];
    let wake: (() => void) | null = null;
    let closed = false;
    const push = (content: TurnContent): void => {
      queue.push({
        type: 'user',
        message: { role: 'user', content },
        parent_tool_use_id: null,
      });
      wake?.();
    };
    const prompt: AsyncIterable<SDKUserMessage> = {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (queue.length) yield queue.shift() as SDKUserMessage;
          if (closed) return;
          await new Promise<void>((r) => (wake = r));
          wake = null;
        }
      },
    };
    let sessionId = opts.resume ?? '';
    const canUseTool: CanUseTool = (toolName, input, { signal }) =>
      new Promise<PermissionResult>((resolve) => {
        const requestId = crypto.randomUUID();
        const questions = toolName === QUESTION_TOOL ? parseQuestions(input) : null;
        this.pending.set(requestId, {
          requestId,
          sessionId,
          toolName,
          summary: summarize(toolName, input),
          ...(questions ? { questions } : {}),
          input,
          resolve,
        });
        // An interrupt aborts the prompt; drop it so the chat does not show a dead card.
        signal.addEventListener('abort', () => {
          if (!this.pending.delete(requestId)) return;
          resolve({ behavior: 'deny', message: 'interrupted' });
        });
        this.log('permission requested', { requestId, sessionId, toolName });
      });
    const q = query({
      prompt,
      options: {
        pathToClaudeCodeExecutable: this.claudeExe,
        cwd: this.cwd,
        permissionMode: settings.mode,
        promptSuggestions: true,
        ...(settings.model ? { model: settings.model } : {}),
        canUseTool,
        ...(opts.resume ? { resume: opts.resume } : {}),
      },
    });
    const close = (): void => {
      closed = true;
      wake?.();
    };
    push(firstContent);
    const firstTurn = newTurn();

    const ready = new Promise<string>((resolve, reject) => {
      void (async () => {
        try {
          for await (const m of q as AsyncIterable<SDKMessage>) {
            if (m.type === 'system' && m.subtype === 'init' && !this.sessions.has(m.session_id)) {
              sessionId = m.session_id;
              this.sessions.set(sessionId, {
                sessionId,
                busy: true,
                turn: firstTurn,
                suggestion: null,
                settings,
                push: (t) => push(t),
                close,
                query: q,
              });
              this.preferred.delete(sessionId);
              this.log('dashboard session started', { sessionId, resumed: !!opts.resume });
              resolve(sessionId);
            }
            if (m.type === 'assistant') {
              const s = this.sessions.get(sessionId);
              // A result can end one turn while the model keeps working on a message that
              // arrived mid-turn (or after a compaction turn): any assistant output means busy.
              if (s && !s.turn) {
                s.busy = true;
                s.turn = newTurn();
                s.suggestion = null;
              }
              const tokens = m.message.usage?.output_tokens;
              if (s?.turn && typeof tokens === 'number')
                s.turn.tokensByMessage.set(m.message.id, tokens);
            }
            if (m.type === 'result') {
              const s = this.sessions.get(sessionId);
              if (s) {
                s.busy = false;
                s.turn = null;
              }
            }
            if (m.type === 'prompt_suggestion') {
              const s = this.sessions.get(sessionId);
              if (s && !s.busy) s.suggestion = m.suggestion;
            }
          }
        } catch (err) {
          this.log('dashboard session failed', { sessionId, error: String(err) });
          reject(err instanceof Error ? err : new Error(String(err)));
        } finally {
          this.sessions.delete(sessionId);
          for (const [id, p] of this.pending) {
            if (p.sessionId === sessionId) {
              this.pending.delete(id);
              p.resolve({ behavior: 'deny', message: 'session ended' });
            }
          }
          this.log('dashboard session ended', { sessionId });
        }
      })();
    });
    return ready;
  }
}
