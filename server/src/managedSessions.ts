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
import * as os from 'os';
import * as path from 'path';

import {
  leadInstructions,
  rosterProblem,
  TEAM_ENV,
  teamAgents,
  TeamRegistry,
  type TeamRoster,
} from './teams.js';
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
  /** Team sessions: the subagent asking (absent when the MD itself asks). */
  agentId?: string;
  /** Team sessions: who is asking, as the dashboard names them ('개발자', 'MD'). */
  member?: string;
}

/** 'teammate': a team member's own transcript; it takes work through the MD, not the chat. */
export type SessionOwner = 'dashboard' | 'terminal' | 'teammate' | 'none';

/** A subagent's transcript is `subagents/agent-<agentId>.jsonl`; its basename is its session key. */
const MEMBER_SESSION_PREFIX = 'agent-';

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
  /** The models[] value a new session would run with no model chosen; null if unmatched. */
  defaultModel: string | null;
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
  team: TeamRoster | null;
  /** Team sessions: agent id -> member key, learned from each member's task_started. */
  members: Map<string, string>;
  /** Team sessions: members working right now. They keep going after the MD's turn ends. */
  running: Set<string>;
}

interface Pending extends PermissionAsk {
  input: Record<string, unknown>;
  resolve: (result: PermissionResult) => void;
}

interface LiveSession {
  sessionId?: string;
  kind?: string;
  pid?: number;
  /** Interactive sessions: 'idle' between turns, 'busy' inside one. */
  status?: string;
}

const LIVE_CACHE_MS = 3000;
const TAKE_OVER_WAIT_MS = 5000;
/** A /desk hand-off waits this long for the terminal turn to end, checking every poll. */
const HANDOFF_WAIT_MS = 30 * 60_000;
const HANDOFF_POLL_MS = 2000;

/** Signal 0 probes without killing; EPERM still means the process exists. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
const SUMMARY_CHARS = 200;
const QUESTION_TOOL = 'AskUserQuestion';
const MAX_ANSWER_CHARS = 2000;

/** Claude in Chrome follows the user's own default (`/chrome` → enabled by default): an
 *  interactive terminal session applies it, an SDK session does not unless told `--chrome`. */
function chromeByDefault(log: (msg: string, extra?: Record<string, unknown>) => void): boolean {
  const file = path.join(os.homedir(), '.claude.json');
  try {
    const config = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
      claudeInChromeDefaultEnabled?: unknown;
    };
    return config.claudeInChromeDefaultEnabled === true;
  } catch (err) {
    log('could not read the Claude in Chrome default; sessions start without it', {
      file,
      err: String(err),
    });
    return false;
  }
}

export class DashboardSessionError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function toCommandList(commands: SlashCommand[]): SessionCatalog['commands'] {
  return commands.map((c) => ({
    name: c.name,
    description: c.description,
    argumentHint: c.argumentHint,
  }));
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
  /** What the CLI binary on disk reported, tagged with that binary and the user settings
   *  file so an update or a changed default model re-probes. */
  private catalogCache: { stamp: string; catalog: SessionCatalog; infos: ModelInfo[] } | null =
    null;

  constructor(
    private readonly cwd: string,
    /** The Claude Code executable itself (not a .cmd/.ps1 shim), for anything that launches it. */
    readonly claudeExe: string,
    private readonly log: (msg: string, extra?: Record<string, unknown>) => void,
    private readonly teams: TeamRegistry = new TeamRegistry(),
  ) {}

  /** Called the first time a member starts working, with the seat the team kept for it. */
  memberJoined: ((memberSessionId: string, seat: number) => void) | null = null;

  /** The live team session a member transcript ('agent-<id>') belongs to. */
  private teamOfMember(sessionId: string): Managed | undefined {
    if (!sessionId.startsWith(MEMBER_SESSION_PREFIX)) return undefined;
    const agentId = sessionId.slice(MEMBER_SESSION_PREFIX.length);
    return [...this.sessions.values()].find((s) => s.members.has(agentId));
  }

  owner(sessionId: string, liveTerminalIds: Set<string>): SessionOwner {
    if (this.sessions.has(sessionId)) return 'dashboard';
    if (this.teamOfMember(sessionId)) return 'teammate';
    return liveTerminalIds.has(sessionId) ? 'terminal' : 'none';
  }

  isBusy(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (session) return session.busy || session.running.size > 0;
    const team = this.teamOfMember(sessionId);
    return !!team && team.running.has(sessionId.slice(MEMBER_SESSION_PREFIX.length));
  }

  /** A team member's transcript lists only that member's asks; the MD's lists the whole team's. */
  pendingFor(sessionId: string): PermissionAsk[] {
    const memberId = this.teamOfMember(sessionId)
      ? sessionId.slice(MEMBER_SESSION_PREFIX.length)
      : null;
    return [...this.pending.values()]
      .filter((p) => (memberId ? p.agentId === memberId : p.sessionId === sessionId))
      .map(({ requestId, sessionId: sid, toolName, summary, questions, agentId, member }) => ({
        requestId,
        sessionId: sid,
        toolName,
        summary,
        ...(questions ? { questions } : {}),
        ...(agentId ? { agentId } : {}),
        ...(member ? { member } : {}),
      }));
  }

  /** Who is asking, by the name the dashboard gives them; undefined outside a team. */
  private memberLabel(sessionId: string, agentId: string | undefined): string | undefined {
    const session = this.sessions.get(sessionId);
    if (!session?.team) return undefined;
    if (!agentId) return session.team.leadLabel;
    const key = session.members.get(agentId);
    return session.team.members.find((m) => m.key === key)?.label ?? key ?? '팀원';
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

  /** A session nobody chose a model for keeps the one its transcript last ran on
   *  (`transcriptModel`), so a default changed elsewhere never reaches it on resume. */
  settingsFor(sessionId: string, transcriptModel: string | null = null): SessionSettings {
    return (
      this.sessions.get(sessionId)?.settings ??
      this.preferred.get(sessionId) ?? {
        mode: DEFAULT_DASHBOARD_MODE,
        model: transcriptModel ? this.aliasFor(transcriptModel) : null,
      }
    );
  }

  /** The catalog value ('opus') for a wire id ('claude-opus-5-5[1m]'): the alias keeps the
   *  context window the CLI gives that model, which the bare id may not. */
  private aliasFor(model: string): string {
    const wire = model.replace(/\[[^\]]*\]$/, '');
    const row = this.catalogCache?.infos.find(
      (m) => m.value !== 'default' && m.resolvedModel === wire,
    );
    return row?.value ?? model;
  }

  /** Change mode and/or model; a live session switches now, any other one when it opens. */
  async updateSettings(
    sessionId: string,
    change: Partial<SessionSettings>,
    transcriptModel: string | null,
  ): Promise<SessionSettings> {
    const next = { ...this.settingsFor(sessionId, transcriptModel), ...change };
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

  /** Slash commands and models the CLI offers. Without a live session, a short-lived CLI
   *  that is never sent a prompt answers instead (no turn, no tokens). */
  async catalog(sessionId: string): Promise<SessionCatalog> {
    const catalog = await this.probedCatalog();
    const session = this.sessions.get(sessionId) ?? [...this.sessions.values()][0];
    if (!session) return catalog;
    // A live session knows its own commands (project skills, plugins). Its models are not
    // asked: a session started before a CLI update still reports the old release's list.
    return { ...catalog, commands: toCommandList(await session.query.supportedCommands()) };
  }

  private async probedCatalog(): Promise<SessionCatalog> {
    const stamp = this.catalogStamp();
    if (this.catalogCache?.stamp !== stamp) {
      const [commands, models, defaultWire] = await this.probeCatalog();
      this.catalogCache = {
        stamp,
        infos: models,
        catalog: {
          commands: toCommandList(commands),
          models: models.map((m: ModelInfo) => ({
            value: m.value,
            displayName: m.displayName,
            description: m.description,
          })),
          defaultModel: null,
        },
      };
      const alias = this.aliasFor(defaultWire);
      this.catalogCache.catalog.defaultModel = models.some((m) => m.value === alias) ? alias : null;
    }
    return this.catalogCache.catalog;
  }

  /** Changes when Claude Code updates itself, which replaces the executable in place, and
   *  when the user settings file (where `/model` saves the default) is written. */
  private catalogStamp(): string {
    const exe = fs.statSync(this.claudeExe);
    const configDir = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
    const settings = fs.statSync(path.join(configDir, 'settings.json'), {
      throwIfNoEntry: false,
    });
    return `${exe.mtimeMs}:${exe.size}:${settings?.mtimeMs ?? 'none'}`;
  }

  private async probeCatalog(): Promise<[SlashCommand[], ModelInfo[], string]> {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    let release: (() => void) | null = null;
    const idle = new Promise<void>((r) => (release = r));
    const prompt: AsyncIterable<SDKUserMessage> = {
      async *[Symbol.asyncIterator]() {
        await idle;
      },
    };
    const q = query({
      prompt,
      options: { pathToClaudeCodeExecutable: this.claudeExe, cwd: this.cwd },
    });
    try {
      // The probe starts like any new session, so the model it reports is the default.
      const [commands, models, usage] = await Promise.all([
        q.supportedCommands(),
        q.supportedModels(),
        q.getContextUsage(),
      ]);
      return [commands, models, usage.model];
    } finally {
      (release as (() => void) | null)?.();
      q.close();
      this.log('catalog probed without a session');
    }
  }

  /** Session ids of interactive sessions currently running in a terminal (`claude agents --json`). */
  async liveTerminalSessions(): Promise<Set<string>> {
    if (this.liveCache && Date.now() - this.liveCache.at < LIVE_CACHE_MS) return this.liveCache.ids;
    const list = await this.listAgents();
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

  /** Take a session away from the terminal Claude holding it, so the next message from the
   *  dashboard resumes it here. Only between turns: a busy one is refused. */
  async takeOver(sessionId: string): Promise<void> {
    const live = (await this.listAgents()).find(
      (s) => s.sessionId === sessionId && s.pid !== undefined && !this.sessions.has(sessionId),
    );
    if (!live || live.pid === undefined) {
      throw new DashboardSessionError('session is not open in a terminal', 404);
    }
    if (live.status !== 'idle') {
      throw new DashboardSessionError(`terminal session is ${live.status ?? 'not idle'}`, 409);
    }
    const pid = live.pid;
    this.log('taking a session over from its terminal', { sessionId, pid });
    process.kill(pid);
    for (let waited = 0; waited < TAKE_OVER_WAIT_MS; waited += 100) {
      if (!processAlive(pid)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (processAlive(pid)) {
      throw new DashboardSessionError(`terminal Claude (pid ${pid}) did not exit`, 500);
    }
    this.liveCache = null;
  }

  /** /desk from a terminal: once that terminal Claude is idle (the turn that ran /desk has
   *  ended), take the session over. Resolves as soon as the request is accepted; the pid must
   *  be the terminal Claude holding this very session, so no other process can be stopped. */
  async handoffWhenIdle(sessionId: string, pid: number): Promise<void> {
    const live = (await this.listAgents()).find(
      (s) => s.sessionId === sessionId && s.pid === pid && !this.sessions.has(sessionId),
    );
    if (!live) {
      throw new DashboardSessionError(`pid ${pid} is not a terminal holding ${sessionId}`, 404);
    }
    this.log('hand-off requested from the terminal', { sessionId, pid });
    void (async () => {
      for (let waited = 0; waited < HANDOFF_WAIT_MS; waited += HANDOFF_POLL_MS) {
        await new Promise((r) => setTimeout(r, HANDOFF_POLL_MS));
        const now = (await this.listAgents()).find(
          (s) => s.sessionId === sessionId && s.pid === pid,
        );
        if (!now) {
          this.log('hand-off: the terminal closed on its own', { sessionId, pid });
          return;
        }
        if (now.status !== 'idle') continue;
        await this.takeOver(sessionId);
        this.log('hand-off done: the dashboard holds the session now', { sessionId, pid });
        return;
      }
      this.log('hand-off gave up: the terminal stayed busy', { sessionId, pid });
    })().catch((err: unknown) => {
      this.log('hand-off failed', { sessionId, pid, err: String(err) });
    });
  }

  private async listAgents(): Promise<LiveSession[]> {
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
    return JSON.parse(stdout) as LiveSession[];
  }

  /** Send a turn to a session, resuming it under the dashboard if nothing else holds it.
   *  `transcriptModel` is the model its transcript last ran on (see settingsFor). */
  async send(
    sessionId: string,
    content: TurnContent,
    transcriptModel: string | null,
  ): Promise<void> {
    if (this.teamOfMember(sessionId)) {
      throw new DashboardSessionError('team members take work through the MD', 409);
    }
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
    // aliasFor needs the model list; without it a bare id could resume on a smaller window.
    if (transcriptModel) await this.probedCatalog();
    await this.open(
      { resume: sessionId, team: this.teams.rosterOf(sessionId) },
      content,
      this.settingsFor(sessionId, transcriptModel),
    );
  }

  /** Start a brand-new session with a first message. Resolves with its session id. */
  async start(content: TurnContent, settings?: Partial<SessionSettings>): Promise<string> {
    return this.open({}, content, { ...this.settingsFor(''), ...settings });
  }

  /** Start a team: this session is the MD, and the brief is its first message. */
  async startTeam(
    team: TeamRoster,
    content: TurnContent,
    settings?: Partial<SessionSettings>,
  ): Promise<string> {
    const problem = rosterProblem(team);
    if (problem) throw new DashboardSessionError(problem, 400);
    return this.open({ team }, content, {
      ...this.settingsFor(''),
      model: team.leadModel,
      ...settings,
    });
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
    opts: { resume?: string; team?: TeamRoster },
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
    const team = opts.team ?? null;
    const canUseTool: CanUseTool = (toolName, input, { signal, agentID }) =>
      new Promise<PermissionResult>((resolve) => {
        const requestId = crypto.randomUUID();
        const questions = toolName === QUESTION_TOOL ? parseQuestions(input) : null;
        const member = this.memberLabel(sessionId, agentID);
        this.pending.set(requestId, {
          requestId,
          sessionId,
          toolName,
          summary: summarize(toolName, input),
          ...(questions ? { questions } : {}),
          ...(agentID ? { agentId: agentID } : {}),
          ...(member ? { member } : {}),
          input,
          resolve,
        });
        // An interrupt aborts the prompt; drop it so the chat does not show a dead card.
        signal.addEventListener('abort', () => {
          if (!this.pending.delete(requestId)) return;
          resolve({ behavior: 'deny', message: 'interrupted' });
        });
        this.log('permission requested', {
          requestId,
          sessionId,
          toolName,
          ...(agentID ? { agentId: agentID, member } : {}),
        });
      });
    const q = query({
      prompt,
      options: {
        pathToClaudeCodeExecutable: this.claudeExe,
        cwd: team?.cwd ?? this.cwd,
        permissionMode: settings.mode,
        promptSuggestions: true,
        ...(settings.model ? { model: settings.model } : {}),
        canUseTool,
        ...(opts.resume ? { resume: opts.resume } : {}),
        ...(chromeByDefault(this.log) ? { extraArgs: { chrome: null } } : {}),
        ...(team
          ? {
              env: { ...process.env, ...TEAM_ENV },
              agents: teamAgents(team),
              systemPrompt: {
                type: 'preset' as const,
                preset: 'claude_code' as const,
                append: leadInstructions(team),
              },
            }
          : {}),
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
                // "Default" means the default at launch; from here the chat names the model.
                settings: settings.model
                  ? settings
                  : { ...settings, model: this.aliasFor(m.model) },
                push: (t) => push(t),
                close,
                query: q,
                team,
                members: new Map(),
                running: new Set(),
              });
              this.preferred.delete(sessionId);
              if (team) this.teams.remember(sessionId, team);
              this.log('dashboard session started', {
                sessionId,
                resumed: !!opts.resume,
                team: !!team,
              });
              resolve(sessionId);
            }
            if (m.type === 'system' && m.subtype === 'task_started') {
              const s = this.sessions.get(sessionId);
              const key = m.subagent_type;
              // A member woken by SendMessage starts again under the same task id.
              const index = s?.team?.members.findIndex((mem) => mem.key === key) ?? -1;
              if (s?.team && key && index >= 0) {
                const seat = s.team.seats?.[index + 1];
                if (!s.members.has(m.task_id) && seat !== undefined) {
                  this.memberJoined?.(MEMBER_SESSION_PREFIX + m.task_id, seat);
                }
                s.members.set(m.task_id, key);
                s.running.add(m.task_id);
                this.log('team member working', { sessionId, agentId: m.task_id, member: key });
              }
            }
            if (m.type === 'system' && m.subtype === 'task_notification') {
              const s = this.sessions.get(sessionId);
              if (s?.running.delete(m.task_id)) {
                this.log('team member stopped', {
                  sessionId,
                  agentId: m.task_id,
                  status: m.status,
                });
              }
            }
            if (m.type === 'assistant') {
              const s = this.sessions.get(sessionId);
              // A member's own output is not the MD's turn; running tracks the members.
              const memberOutput = !!s?.team && m.parent_tool_use_id !== null;
              // A result can end one turn while the model keeps working on a message that
              // arrived mid-turn (or after a compaction turn): any assistant output means busy.
              if (s && !s.turn && !memberOutput) {
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
