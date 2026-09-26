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
}

export type SessionOwner = 'dashboard' | 'terminal' | 'none';

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

export async function postJson<T>(path: string, token: string, body: object): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status} ${text}`);
  return (text ? JSON.parse(text) : {}) as T;
}

/** `seat`: for a new hire, the empty desk they were hired from. */
export function chatUrl(token: string, sessionId: string | null, seat?: number): string {
  const params = new URLSearchParams({ token });
  if (sessionId) params.set('session', sessionId);
  else params.set('new', '1');
  if (!sessionId && seat !== undefined) params.set('seat', String(seat));
  return `./chat.html?${params.toString()}`;
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

function chatIsOpen(sessionId: string): boolean {
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
    chatUrl(token, sessionId, seat),
    name,
    `popup,width=${width},height=${height}`,
  );
  return win ? 'opened' : 'blocked';
}
