/** Token-gated dashboard API shared by the office scene and the chat windows. */

export interface MediaRef {
  path: string;
  name: string;
  kind: 'image' | 'video' | 'audio';
  size: number;
  version: number;
  tooLarge: boolean;
}

export interface ConversationEntry {
  kind: 'user' | 'assistant' | 'tool';
  text: string;
  timestamp?: string;
  /** Pictures, videos and sound files the entry mentions that exist on disk now. */
  media?: MediaRef[];
}

export interface ConversationResponse {
  id: number;
  title: string | null;
  entries: ConversationEntry[];
}

export interface QuestionOption {
  label: string;
  description: string;
}

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
  /** Set when the agent asks the user to choose (AskUserQuestion) instead of asking approval. */
  questions?: Question[];
  /** Team sessions: the member asking ('개발자', or 'MD' when the lead asks). */
  member?: string;
  /** Set when the MD submits its team plan for approval. */
  plan?: TeamPlan;
  /** Set when members kept messaging each other this many times with no word from the user. */
  chatter?: number;
}

export interface PlanPermission {
  kind: 'files' | 'command' | 'web';
  scope: string;
  why: string;
}

export interface TeamPlan {
  summary: string;
  assignments: Array<{ member: string; task: string }>;
  permissions: PlanPermission[];
}

export interface MemberStatus {
  label: string;
  state: 'idle' | 'working' | 'done' | 'failed' | 'stopped';
  tokens: number;
  toolUses: number;
  lastTool: string | null;
}

export interface WorkLimit {
  kind: string;
  status: 'allowed' | 'allowed_warning' | 'rejected';
  utilization: number | null;
  /** Epoch seconds. */
  resetsAt: number | null;
}

export interface CreditStatus {
  usingCredits: boolean;
  status: 'allowed' | 'allowed_warning' | 'rejected' | null;
  disabledReason: string | null;
  required: boolean;
}

export interface TeamStatus {
  name: string;
  plan: 'none' | 'waiting' | 'approved';
  autoAllowed: number;
  costUsd: number;
  budgetUsd: number | null;
  budgetStopped: boolean;
  limits: WorkLimit[];
  credits: CreditStatus | null;
  members: MemberStatus[];
  ended: boolean;
}

/** 'teammate': a team member's own window; work reaches it through the MD. */
export type SessionOwner = 'dashboard' | 'terminal' | 'teammate' | 'none';

export interface SessionSettings {
  mode: 'auto' | 'default' | 'acceptEdits' | 'plan';
  model: string | null;
}

export interface AgentMeta {
  id: number;
  sessionId: string;
  title: string | null;
  owner: SessionOwner;
  busy: boolean;
  pending: PermissionAsk[];
  /** Mode and model the dashboard uses for this session; null inside VS Code. */
  settings: SessionSettings | null;
  /** The running dashboard turn: time so far and output tokens. */
  activity: { elapsedMs: number; outputTokens: number } | null;
  /** The CLI's guess at the next message once a dashboard turn ends; Tab puts it in the box. */
  suggestion: string | null;
  /** Tools a session is running right now, as read from its transcript. */
  activeTools: string[];
  /** Set on a team's MD. */
  team: TeamStatus | null;
}

export interface AgentsResponse {
  canReply: boolean;
  agents: AgentMeta[];
}

export async function fetchJson<T>(path: string, token: string): Promise<T> {
  const res = await fetch(path, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/** `timeoutMs`: give up instead of waiting forever on a connection that stalled silently. */
export async function postJson<T>(
  path: string,
  token: string,
  body: object,
  timeoutMs?: number,
): Promise<T> {
  const controller = new AbortController();
  const timer =
    timeoutMs === undefined ? undefined : setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`POST ${path} -> ${res.status} ${text}`);
    return (text ? JSON.parse(text) : {}) as T;
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`POST ${path}: ${Math.round((timeoutMs ?? 0) / 1000)}초 안에 응답 없음`, {
        cause: err,
      });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** `seat`: for a new hire, the empty desk they were hired from. `team`: a saved team draft. */
export function chatUrl(
  token: string,
  sessionId: string | null,
  seat?: number,
  team?: string,
): string {
  const params = new URLSearchParams({ token });
  if (sessionId) params.set('session', sessionId);
  else params.set('new', '1');
  if (!sessionId && seat !== undefined) params.set('seat', String(seat));
  if (!sessionId && team) params.set('team', team);
  return `./chat.html?${params.toString()}`;
}

// ── Teams ─────────────────────────────────────────────────────

export interface TeamMember {
  key: string;
  label: string;
  role: string;
  model: string;
}

export interface TeamRoster {
  name: string;
  leadLabel: string;
  leadModel: string;
  members: TeamMember[];
  cwd?: string;
  /** Spend cap in dollars for one run of the team. */
  budgetUsd?: number;
}

export interface TeamTemplatesResponse {
  defaultTeam: TeamRoster;
  templates: TeamRoster[];
}

/** A team the office composed, waiting in its chat window for the first brief. */
export interface TeamDraft {
  team: TeamRoster;
  seats: number[];
  rooms: number[];
}

const TEAM_DRAFT_KEY = 'bitteul-team-draft:';

/** Hand a composed team to the chat window that will start it; returns the draft id. */
export function saveTeamDraft(draft: TeamDraft): string {
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  window.localStorage.setItem(TEAM_DRAFT_KEY + id, JSON.stringify(draft));
  return id;
}

export function readTeamDraft(id: string): TeamDraft | null {
  try {
    const raw = window.localStorage.getItem(TEAM_DRAFT_KEY + id);
    return raw ? (JSON.parse(raw) as TeamDraft) : null;
  } catch {
    return null;
  }
}

export function dropTeamDraft(id: string): void {
  try {
    window.localStorage.removeItem(TEAM_DRAFT_KEY + id);
  } catch {
    // nothing to clean
  }
}

// ── One chat window per session ──────────────────────────────
// A chat window checks in every couple of seconds. Opening a session that already has a
// window closes that one and opens a fresh window, which comes up in front. Browsers ignore
// focus() on an existing window, and a window only knows the tab that opened it by name.

const CHAT_OPEN_KEY = 'bitteul-chat-open:';
const CHAT_DRAFT_KEY = 'bitteul-chat-draft:';
const CHAT_CHANNEL = 'bitteul-chat';
const CHAT_HEARTBEAT_MS = 2000;
const CHAT_STALE_MS = 6000;

/** A chat window for this session checked in lately (only windows in this browser can). */
export function chatIsOpen(sessionId: string): boolean {
  try {
    const seen = Number(window.localStorage.getItem(CHAT_OPEN_KEY + sessionId));
    return Number.isFinite(seen) && Date.now() - seen < CHAT_STALE_MS;
  } catch {
    return false;
  }
}

function channel(): BroadcastChannel | null {
  return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHAT_CHANNEL);
}

/** Called by a chat window: keep checking in, and step aside for a fresh window when an
 *  office tab reopens this session, handing over the unsent text. */
export function announceChatWindow(sessionId: string, unsentText: () => string): () => void {
  let replaced = false;
  const beat = (): void => {
    try {
      window.localStorage.setItem(CHAT_OPEN_KEY + sessionId, String(Date.now()));
    } catch {
      // Storage off (private mode): the office just opens windows as before.
    }
  };
  beat();
  const timer = window.setInterval(beat, CHAT_HEARTBEAT_MS);
  const bc = channel();
  bc?.addEventListener('message', (ev: MessageEvent<{ replace?: string }>) => {
    if (ev.data?.replace !== sessionId) return;
    replaced = true;
    try {
      const text = unsentText();
      if (text.trim()) window.localStorage.setItem(CHAT_DRAFT_KEY + sessionId, text);
    } catch {
      // The draft is lost with the window; nothing else is.
    }
    window.close();
  });
  const stop = (): void => {
    window.clearInterval(timer);
    bc?.close();
    // The replacement is already checking in under this key.
    if (replaced) return;
    try {
      window.localStorage.removeItem(CHAT_OPEN_KEY + sessionId);
    } catch {
      // nothing to clean
    }
  };
  window.addEventListener('pagehide', stop);
  return stop;
}

/** Unsent text a replaced window left for this session, taken once. */
export function takeChatDraft(sessionId: string): string | null {
  try {
    const text = window.localStorage.getItem(CHAT_DRAFT_KEY + sessionId);
    window.localStorage.removeItem(CHAT_DRAFT_KEY + sessionId);
    return text;
  } catch {
    return null;
  }
}

export type ChatOpenResult = 'opened' | 'blocked';

/** Open the chat window for one session, replacing the one already open anywhere. */
export function openChatWindow(
  token: string,
  sessionId: string | null,
  seat?: number,
  team?: string,
): ChatOpenResult {
  if (sessionId && chatIsOpen(sessionId)) {
    const bc = channel();
    bc?.postMessage({ replace: sessionId });
    bc?.close();
  }
  // A fresh name every time: reusing one would land in the old window before it closes.
  const name = `bitteul-chat-${sessionId ?? 'new'}-${Date.now()}`;
  // Window size excludes the title bar and frame; the margin keeps the whole window on a
  // short screen (a 1440p monitor at 150% leaves under 960px).
  const width = Math.min(760, window.screen.availWidth - 40);
  const height = Math.min(900, window.screen.availHeight - 100);
  const win = window.open(
    chatUrl(token, sessionId, seat, team),
    name,
    `popup,width=${width},height=${height}`,
  );
  return win ? 'opened' : 'blocked';
}
