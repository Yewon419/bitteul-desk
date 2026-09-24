/**
 * Chat window for one agent session: a plain, readable, terminal-style view of the
 * conversation with a composer. Opened from the office scene, one window per session.
 */

import DOMPurify from 'dompurify';
import { marked } from 'marked';

import {
  type AgentMeta,
  type AgentsResponse,
  type ConversationEntry,
  type ConversationResponse,
  fetchJson,
  type PermissionAsk,
  postJson,
} from '../scene/api.js';

const CONVERSATION_POLL_MS = 1500;
const AGENTS_POLL_MS = 2000;
const STICK_TO_BOTTOM_PX = 120;

const params = new URLSearchParams(window.location.search);
const token = params.get('token') ?? '';
let sessionId = params.get('session');
let creating = params.get('new') === '1' && !sessionId;

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`[Chat] #${id} missing`);
  return el as T;
}

const titleEl = byId<HTMLHeadingElement>('title');
const statusEl = byId<HTMLSpanElement>('status');
const logEl = byId<HTMLDivElement>('log');
const asksEl = byId<HTMLDivElement>('asks');
const noteEl = byId<HTMLParagraphElement>('note');
const input = byId<HTMLTextAreaElement>('input');
const sendBtn = byId<HTMLButtonElement>('send');
const errorEl = byId<HTMLParagraphElement>('error');

let meta: AgentMeta | undefined;
let lastSignature = '';
let lastAsks = '';
let sending = false;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function clock(ts: string | undefined): string {
  if (!ts) return '';
  const d = new Date(ts);
  return Number.isNaN(d.getTime())
    ? ''
    : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function markdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: true }));
}

function renderEntry(entry: ConversationEntry): HTMLElement {
  const row = el('div', `msg msg-${entry.kind}`);
  const time = clock(entry.timestamp);
  if (entry.kind === 'tool') {
    row.append(el('span', 'tool-dot', '●'), el('span', 'tool-text', entry.text));
    return row;
  }
  const head = el('div', 'msg-head');
  head.append(el('span', 'msg-who', entry.kind === 'user' ? '대표님' : '직원'));
  if (time) head.append(el('span', 'msg-time', time));
  const body = el('div', 'msg-body');
  if (entry.kind === 'assistant') body.innerHTML = markdown(entry.text);
  else body.textContent = entry.text;
  row.append(head, body);
  return row;
}

function setTitle(text: string): void {
  titleEl.textContent = text;
  document.title = `${text} · 빛뜰 컴퍼니`;
}

function renderStatus(): void {
  let status: string;
  let note = '';
  let locked = sending;
  if (creating) {
    status = '새 직원';
    note = '첫 업무 지시를 보내면 새 직원이 출근합니다.';
  } else if (!meta) {
    status = '연결 중';
    note = sessionId
      ? '사무실에서 이 세션을 찾는 중입니다. 서버가 아직 못 봤거나 세션이 끝났을 수 있어요.'
      : '';
    locked = true;
  } else if (meta.pending.length) {
    status = '승인 대기';
  } else if (meta.owner === 'terminal') {
    status = '보기 전용';
    note = '터미널에서 열려 있는 세션입니다. 터미널을 닫으면 여기서 이어받을 수 있어요.';
    locked = true;
  } else if (meta.busy) {
    status = '작업 중';
  } else {
    status = meta.owner === 'dashboard' ? '대기' : '대기 (보내면 이어받음)';
  }
  statusEl.textContent = status;
  statusEl.dataset.state = status;
  noteEl.textContent = note;
  input.disabled = locked;
  sendBtn.disabled = locked;
  sendBtn.textContent = creating ? '출근시키기' : '보내기';
  renderAsks(meta?.pending ?? []);
}

function renderAsks(asks: PermissionAsk[]): void {
  const signature = asks.map((a) => a.requestId).join(',');
  if (signature === lastAsks) return;
  lastAsks = signature;
  asksEl.replaceChildren(
    ...asks.map((ask) => {
      const card = el('div', 'ask');
      const allow = el('button', 'btn btn-primary', '허용');
      const deny = el('button', 'btn', '거부');
      allow.type = 'button';
      deny.type = 'button';
      allow.addEventListener('click', () => void answer(ask.requestId, true, card));
      deny.addEventListener('click', () => void answer(ask.requestId, false, card));
      const actions = el('div', 'ask-actions');
      actions.append(allow, deny);
      card.append(el('p', 'ask-title', '승인 요청'), el('pre', 'ask-text', ask.summary), actions);
      return card;
    }),
  );
}

async function answer(requestId: string, allow: boolean, card: HTMLElement): Promise<void> {
  card.querySelectorAll('button').forEach((b) => (b.disabled = true));
  try {
    await postJson(`./api/dashboard/permissions/${requestId}`, token, { allow });
    card.remove();
  } catch (err) {
    errorEl.textContent = `승인 처리 실패: ${String(err)}`;
    card.querySelectorAll('button').forEach((b) => (b.disabled = false));
  }
}

async function pollAgents(): Promise<void> {
  try {
    const data = await fetchJson<AgentsResponse>('./api/dashboard/agents', token);
    meta = sessionId ? data.agents.find((a) => a.sessionId === sessionId) : undefined;
    if (meta?.title) setTitle(meta.title);
    renderStatus();
  } catch (err) {
    errorEl.textContent = `서버 연결 실패: ${String(err)}`;
  }
}

async function pollConversation(): Promise<void> {
  if (!meta) return;
  let data: ConversationResponse;
  try {
    data = await fetchJson<ConversationResponse>(
      `./api/dashboard/agents/${meta.id}/conversation`,
      token,
    );
  } catch (err) {
    errorEl.textContent = `대화를 불러오지 못했습니다: ${String(err)}`;
    return;
  }
  errorEl.textContent = '';
  if (data.title) setTitle(data.title);
  const last = data.entries[data.entries.length - 1];
  const signature = `${data.entries.length}:${last?.text.length ?? 0}`;
  if (signature === lastSignature) return;
  lastSignature = signature;
  const nearBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < STICK_TO_BOTTOM_PX;
  logEl.replaceChildren(...data.entries.map(renderEntry));
  if (nearBottom) logEl.scrollTop = logEl.scrollHeight;
}

async function send(): Promise<void> {
  const text = input.value.trim();
  if (!text || sending || input.disabled) return;
  sending = true;
  renderStatus();
  try {
    if (creating) {
      const res = await postJson<{ sessionId: string }>('./api/dashboard/sessions', token, {
        text,
      });
      sessionId = res.sessionId;
      creating = false;
      const next = new URLSearchParams({ token, session: sessionId });
      window.history.replaceState(null, '', `?${next.toString()}`);
      setTitle('새 직원 출근 중…');
    } else if (meta) {
      await postJson(`./api/dashboard/agents/${meta.id}/messages`, token, { text });
    }
    input.value = '';
    errorEl.textContent = '';
  } catch (err) {
    errorEl.textContent = `보내지 못했습니다: ${String(err)}`;
  } finally {
    sending = false;
    renderStatus();
    input.focus();
  }
}

input.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
    ev.preventDefault();
    void send();
  }
});
sendBtn.addEventListener('click', () => void send());

if (!token) {
  setTitle('토큰이 없습니다');
  noteEl.textContent = '사무실 화면(토큰 포함 주소)에서 직원을 눌러 여세요.';
  input.disabled = true;
  sendBtn.disabled = true;
} else {
  setTitle(creating ? '새 직원 부르기' : '불러오는 중…');
  renderStatus();
  void pollAgents().then(() => pollConversation());
  window.setInterval(() => void pollAgents(), AGENTS_POLL_MS);
  window.setInterval(() => void pollConversation(), CONVERSATION_POLL_MS);
  input.focus();
}
