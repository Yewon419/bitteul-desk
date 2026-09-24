/** Token-gated dashboard API shared by the office scene and the chat windows. */

export interface ConversationEntry {
  kind: 'user' | 'assistant' | 'tool';
  text: string;
  timestamp?: string;
}

export interface ConversationResponse {
  id: number;
  title: string | null;
  entries: ConversationEntry[];
}

export interface PermissionAsk {
  requestId: string;
  sessionId: string;
  toolName: string;
  summary: string;
}

export type SessionOwner = 'dashboard' | 'terminal' | 'none';

export interface AgentMeta {
  id: number;
  sessionId: string;
  title: string | null;
  owner: SessionOwner;
  busy: boolean;
  pending: PermissionAsk[];
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

export function chatUrl(token: string, sessionId: string | null): string {
  const params = new URLSearchParams({ token });
  if (sessionId) params.set('session', sessionId);
  else params.set('new', '1');
  return `./chat.html?${params.toString()}`;
}

/**
 * Open (or focus) the chat window for one session; one window per session.
 * Returns false when the browser blocked the popup.
 */
export function openChatWindow(token: string, sessionId: string | null): boolean {
  const name = sessionId ? `bitteul-chat-${sessionId}` : `bitteul-chat-new-${Date.now()}`;
  const win = window.open(chatUrl(token, sessionId), name, 'popup,width=760,height=900');
  if (!win) return false;
  win.focus();
  return true;
}
