/**
 * Chat window for one agent session: a plain, readable, terminal-style view of the
 * conversation with a composer. Opened from the office scene, one window per session.
 */

import DOMPurify from 'dompurify';
import { marked } from 'marked';

import {
  type AgentMeta,
  type AgentsResponse,
  announceChatWindow,
  type ConversationEntry,
  type ConversationResponse,
  fetchJson,
  type MediaRef,
  type PermissionAsk,
  postJson,
  type Question,
} from '../scene/api.js';
import {
  type CatalogCommand,
  type CatalogModel,
  DASHBOARD_MODES,
  type DashboardMode,
  LOCAL_COMMANDS,
  MODE_LABELS,
  parseLocalCommand,
  resolveMode,
  resolveModel,
  suggestCommands,
} from './commands.js';

const CONVERSATION_POLL_MS = 1500;
const AGENTS_POLL_MS = 2000;
const STICK_TO_BOTTOM_PX = 120;
/** A run of this many tool calls or more folds into one line. */
const TOOL_FOLD_MIN = 3;
const DEFAULT_USER_NAME = '나';
/** On touch keyboards Enter makes a new line; the send button sends. */
const TOUCH_MEDIA = '(pointer: coarse)';

const params = new URLSearchParams(window.location.search);
const token = params.get('token') ?? '';
let sessionId = params.get('session');
let creating = params.get('new') === '1' && !sessionId;
/** A new hire from an empty desk in the office sits at that desk. */
const hireSeat = Number.parseInt(params.get('seat') ?? '', 10);

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
const backEl = byId<HTMLAnchorElement>('back');
const dismissBtn = byId<HTMLButtonElement>('dismiss');
const stopBtn = byId<HTMLButtonElement>('stop');
const controlsEl = byId<HTMLDivElement>('controls');
const modeSelect = byId<HTMLSelectElement>('mode');
const modelSelect = byId<HTMLSelectElement>('model');
const pickerEl = byId<HTMLDivElement>('picker');
const workingEl = byId<HTMLDivElement>('working');
/** Local clock of the last poll, so the elapsed time keeps ticking between polls. */
let activityAt = 0;
const suggestEl = byId<HTMLUListElement>('suggest');
const DEFAULT_PLACEHOLDER = input.placeholder;

/** Settings for a session not created yet; sent along with its first message. */
let draftSettings: { mode: DashboardMode; model: string | null } = { mode: 'auto', model: null };
let catalog: { commands: CatalogCommand[]; models: CatalogModel[] } = { commands: [], models: [] };
/** The numbered picker on screen (/model, /mode, /help), so number keys can choose from it. */
let activePicker: ((index: number) => void) | null = null;
let suggestIndex = 0;

let meta: AgentMeta | undefined;
let lastSignature = '';
let lastAsks = '';
let sending = false;
let userName = DEFAULT_USER_NAME;
let profileError = '';
let dismissed = false;
let confirmTimer: number | undefined;
/** How long the button waits for the second, confirming click. */
const DISMISS_CONFIRM_MS = 4000;
/** Folded tool runs the user opened, keyed by their first entry, so polling keeps them open. */
const openRuns = new Set<string>();

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
  head.append(el('span', 'msg-who', entry.kind === 'user' ? userName : '직원'));
  if (time) head.append(el('span', 'msg-time', time));
  const body = el('div', 'msg-body');
  if (entry.kind === 'assistant') body.innerHTML = markdown(entry.text);
  else body.textContent = entry.text;
  row.append(head, body);
  return row;
}

function renderToolRun(run: ConversationEntry[]): HTMLElement[] {
  if (run.length < TOOL_FOLD_MIN) return run.map(renderEntry);
  const key = `${run[0].timestamp ?? ''}|${run[0].text}`;
  const box = el('details', 'tools');
  box.open = openRuns.has(key);
  box.addEventListener('toggle', () => {
    if (box.open) openRuns.add(key);
    else openRuns.delete(key);
  });
  const summary = el('summary', '');
  summary.append(
    el('span', 'tools-count', `도구 ${run.length}번 사용`),
    el('span', 'tools-last', `마지막: ${run[run.length - 1].text}`),
  );
  box.append(summary, ...run.map(renderEntry));
  return [box];
}

// ── Previews of the pictures, videos and sounds the agent works on ──

/** Kept across re-renders: polling rebuilds the log, and a playing video must not restart. */
const mediaNodes = new Map<string, HTMLElement>();
/** The object URL shown for each path, released when a newer version of the file replaces it. */
const mediaUrls = new Map<string, { key: string; url: string }>();

async function loadMedia(m: MediaRef, key: string, holder: HTMLElement): Promise<void> {
  if (!meta) return;
  try {
    const res = await fetch(
      `./api/dashboard/agents/${meta.id}/media?path=${encodeURIComponent(m.path)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const url = URL.createObjectURL(await res.blob());
    const previous = mediaUrls.get(m.path);
    if (previous && previous.key !== key) {
      URL.revokeObjectURL(previous.url);
      mediaNodes.delete(previous.key);
    }
    mediaUrls.set(m.path, { key, url });
    let node: HTMLElement;
    if (m.kind === 'image') {
      const img = document.createElement('img');
      img.src = url;
      img.alt = m.name;
      img.title = '눌러서 크게 보기';
      img.addEventListener('click', () => window.open(url, '_blank'));
      node = img;
    } else {
      const player = document.createElement(m.kind);
      player.controls = true;
      player.preload = 'metadata';
      player.src = url;
      node = player;
    }
    holder.replaceWith(node);
  } catch (err) {
    holder.textContent = `미리보기를 불러오지 못했어요: ${String(err)}`;
  }
}

function mediaNode(m: MediaRef): HTMLElement {
  const key = `${m.path}|${m.version}`;
  const cached = mediaNodes.get(key);
  if (cached) return cached;
  const box = el('figure', `media media-${m.kind}`);
  const caption = el('figcaption', '', `${m.name} · ${formatSize(m.size)}`);
  caption.title = m.path;
  const holder = el(
    'div',
    'media-note',
    m.tooLarge ? '파일이 너무 커서 미리보기는 생략했어요' : '불러오는 중…',
  );
  box.append(holder, caption);
  mediaNodes.set(key, box);
  if (!m.tooLarge) void loadMedia(m, key, holder);
  return box;
}

function renderMedia(media: MediaRef[]): HTMLElement[] {
  if (media.length === 0) return [];
  const strip = el('div', 'media-strip');
  strip.append(...media.map(mediaNode));
  return [strip];
}

function renderLog(entries: ConversationEntry[]): HTMLElement[] {
  // A file mentioned many times is previewed once, at its latest mention.
  const lastMention = new Map<string, number>();
  entries.forEach((e, i) => e.media?.forEach((m) => lastMention.set(m.path, i)));
  const mediaOf = (e: ConversationEntry, i: number): MediaRef[] =>
    (e.media ?? []).filter((m) => lastMention.get(m.path) === i);

  const out: HTMLElement[] = [];
  let run: ConversationEntry[] = [];
  let runMedia: MediaRef[] = [];
  const flushRun = (): void => {
    out.push(...renderToolRun(run), ...renderMedia(runMedia));
    run = [];
    runMedia = [];
  };
  entries.forEach((entry, i) => {
    if (entry.kind === 'tool') {
      run.push(entry);
      runMedia.push(...mediaOf(entry, i));
      return;
    }
    flushRun();
    out.push(renderEntry(entry), ...renderMedia(mediaOf(entry, i)));
  });
  flushRun();
  return out;
}

async function loadUserName(): Promise<void> {
  try {
    const res = await fetch('./api/scene/profile');
    if (!res.ok) throw new Error(`GET ./api/scene/profile -> ${res.status} ${await res.text()}`);
    userName = ((await res.json()) as { userName: string }).userName;
  } catch (err) {
    profileError = `사용자 설정을 읽지 못해 기본 이름으로 보여요: ${String(err)}`;
    errorEl.textContent = profileError;
  }
}

function setTitle(text: string): void {
  titleEl.textContent = text;
  document.title = `${text} · 빛뜰 데스크`;
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
  } else if (meta.pending.some((p) => p.questions)) {
    status = '답 기다리는 중';
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
  if (dismissed) {
    status = '퇴근';
    note = '퇴근했어요. 이 세션이 다시 움직이면 사무실로 돌아와요.';
    locked = true;
  }
  renderControls();
  stopBtn.hidden = creating || dismissed || !meta || meta.owner !== 'dashboard' || !meta.busy;
  dismissBtn.hidden = !meta || creating || dismissed;
  dismissBtn.disabled = !meta || meta.busy || meta.pending.length > 0;
  dismissBtn.title =
    meta?.owner === 'terminal'
      ? '사무실에서만 빠져요. 터미널의 Claude는 그대로 켜져 있어요.'
      : '이 세션을 끝내고 사무실에서 빼요.';
  statusEl.textContent = status;
  statusEl.dataset.state = status;
  noteEl.textContent = note;
  input.disabled = locked;
  attachBtn.disabled = locked;
  sendBtn.disabled = locked;
  sendBtn.textContent = creating ? '출근시키기' : '보내기';
  renderAsks(meta?.pending ?? []);
}

/** The question card currently on screen, so number keys can answer it. */
let activeQuestion: {
  pick: (qi: number, oi: number) => void;
  submit: () => void;
  ready: () => boolean;
} | null = null;

async function submitAnswers(
  ask: PermissionAsk,
  answers: Record<string, string>,
  card: HTMLElement,
): Promise<void> {
  card.querySelectorAll('button, input').forEach((b) => ((b as HTMLButtonElement).disabled = true));
  try {
    await postJson(`./api/dashboard/questions/${ask.requestId}`, token, { answers });
    card.remove();
    activeQuestion = null;
  } catch (err) {
    errorEl.textContent = `답을 보내지 못했어요: ${String(err)}`;
    card
      .querySelectorAll('button, input')
      .forEach((b) => ((b as HTMLButtonElement).disabled = false));
  }
}

/** Multiple-choice card: numbered options, a free-text fallback, and 답하기 / 건너뛰기. */
function renderQuestion(ask: PermissionAsk, questions: Question[]): HTMLElement {
  const card = el('div', 'ask ask-question');
  const chosen = questions.map(() => new Set<string>());
  const typed = questions.map(() => '');
  const optionButtons: HTMLButtonElement[][] = [];
  const answerOf = (qi: number): string => typed[qi].trim() || [...chosen[qi]].join(', ');
  const ready = (): boolean => questions.every((_, qi) => answerOf(qi) !== '');
  const submitBtn = el('button', 'btn btn-primary', '답하기');
  const skipBtn = el('button', 'btn', '건너뛰기');
  submitBtn.type = 'button';
  skipBtn.type = 'button';
  const refresh = (): void => {
    optionButtons.forEach((buttons, qi) =>
      buttons.forEach((b, oi) =>
        b.setAttribute('aria-pressed', String(chosen[qi].has(questions[qi].options[oi].label))),
      ),
    );
    submitBtn.disabled = !ready();
  };
  const submit = (): void => {
    if (!ready()) return;
    const answers = Object.fromEntries(questions.map((q, qi) => [q.question, answerOf(qi)]));
    void submitAnswers(ask, answers, card);
  };
  const pick = (qi: number, oi: number): void => {
    const q = questions[qi];
    const option = q?.options[oi];
    if (!option) return;
    if (q.multiSelect) {
      if (chosen[qi].has(option.label)) chosen[qi].delete(option.label);
      else chosen[qi].add(option.label);
    } else {
      chosen[qi] = new Set([option.label]);
    }
    refresh();
    // One single-choice question: choosing is answering, like the terminal.
    if (questions.length === 1 && !q.multiSelect) submit();
  };

  card.append(el('p', 'ask-title', questions.length > 1 ? `질문 ${questions.length}개` : '질문'));
  questions.forEach((q, qi) => {
    const block = el('div', 'question');
    if (q.header) block.append(el('span', 'q-chip', q.header));
    block.append(el('p', 'q-text', q.question));
    const list = el('div', 'q-options');
    optionButtons[qi] = q.options.map((o, oi) => {
      const b = el('button', 'q-option');
      b.type = 'button';
      b.append(el('span', 'q-num', String(oi + 1)), el('span', 'q-label', o.label));
      if (o.description) b.append(el('span', 'q-desc', o.description));
      b.addEventListener('click', () => pick(qi, oi));
      list.append(b);
      return b;
    });
    const other = el('input', 'q-other');
    other.placeholder = '직접 입력';
    other.addEventListener('input', () => {
      typed[qi] = other.value;
      refresh();
    });
    other.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.isComposing) submit();
    });
    block.append(list, other);
    card.append(block);
  });
  card.append(
    el(
      'p',
      'q-hint',
      questions.some((q) => q.multiSelect)
        ? '숫자 키로 고르고 Enter로 보내요. 여러 개 고를 수 있어요.'
        : '숫자 키나 버튼으로 고르면 바로 보내요.',
    ),
  );
  submitBtn.addEventListener('click', submit);
  skipBtn.addEventListener('click', () => {
    activeQuestion = null;
    void answer(ask.requestId, false, card);
  });
  const actions = el('div', 'ask-actions');
  actions.append(submitBtn, skipBtn);
  card.append(actions);
  refresh();
  activeQuestion = { pick: (qi, oi) => pick(qi, oi), submit, ready };
  return card;
}

function renderAsks(asks: PermissionAsk[]): void {
  const signature = asks.map((a) => a.requestId).join(',');
  if (signature === lastAsks) return;
  lastAsks = signature;
  activeQuestion = null;
  asksEl.replaceChildren(
    ...asks.map((ask) => {
      if (ask.questions) return renderQuestion(ask, ask.questions);
      const card = el('div', 'ask');
      const allow = el('button', 'btn btn-primary', '1 허용');
      const deny = el('button', 'btn', '2 거부');
      allow.type = 'button';
      deny.type = 'button';
      allow.addEventListener('click', () => void answer(ask.requestId, true, card));
      deny.addEventListener('click', () => void answer(ask.requestId, false, card));
      const actions = el('div', 'ask-actions');
      actions.append(allow, deny);
      card.append(
        el('p', 'ask-title', '승인 요청'),
        el('pre', 'ask-text', ask.summary),
        actions,
        el('p', 'q-hint', '숫자 키 1 = 허용, 2 = 거부'),
      );
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
  if (dismissed) return;
  try {
    const data = await fetchJson<AgentsResponse>('./api/dashboard/agents', token);
    meta = sessionId ? data.agents.find((a) => a.sessionId === sessionId) : undefined;
    activityAt = Date.now();
    if (catalog.models.length === 0 && (meta || creating)) void loadCatalog();
    if (meta?.title) setTitle(meta.title);
    renderStatus();
    renderNextSuggestion();
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
  errorEl.textContent = profileError;
  if (data.title) setTitle(data.title);
  const last = data.entries[data.entries.length - 1];
  const versions = data.entries.flatMap((e) => (e.media ?? []).map((m) => m.version));
  const signature = `${data.entries.length}:${last?.text.length ?? 0}:${versions.join(',')}`;
  if (signature === lastSignature) return;
  lastSignature = signature;
  const nearBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < STICK_TO_BOTTOM_PX;
  logEl.replaceChildren(...renderLog(data.entries));
  if (nearBottom) logEl.scrollTop = logEl.scrollHeight;
}

async function send(): Promise<void> {
  const text = input.value.trim();
  if ((!text && pendingFiles.length === 0) || sending || input.disabled) return;
  hideSuggest();
  if (pendingFiles.length === 0 && runLocalCommand(text)) {
    input.value = '';
    return;
  }
  sending = true;
  renderStatus();
  try {
    const attachments = await uploadPending();
    if (creating) {
      const res = await postJson<{ sessionId: string }>('./api/dashboard/sessions', token, {
        text,
        attachments,
        ...(Number.isFinite(hireSeat) ? { seat: hireSeat } : {}),
        mode: draftSettings.mode,
        model: draftSettings.model,
      });
      sessionId = res.sessionId;
      creating = false;
      announceChatWindow(sessionId);
      const next = new URLSearchParams({ token, session: sessionId });
      window.history.replaceState(null, '', `?${next.toString()}`);
      setTitle('새 직원 출근 중…');
    } else if (meta) {
      await postJson(`./api/dashboard/agents/${meta.id}/messages`, token, { text, attachments });
    }
    input.value = '';
    pendingFiles = [];
    renderAttachments();
    errorEl.textContent = profileError;
  } catch (err) {
    errorEl.textContent = `보내지 못했습니다: ${String(err)}`;
  } finally {
    sending = false;
    renderStatus();
    input.focus();
  }
}

function resetDismissConfirm(): void {
  window.clearTimeout(confirmTimer);
  delete dismissBtn.dataset.confirm;
  dismissBtn.textContent = '퇴근';
}

/** First click arms, second click within a few seconds sends the agent home. */
async function dismiss(): Promise<void> {
  if (!meta || dismissBtn.disabled) return;
  if (dismissBtn.dataset.confirm !== '1') {
    dismissBtn.dataset.confirm = '1';
    dismissBtn.textContent = '정말 퇴근?';
    confirmTimer = window.setTimeout(resetDismissConfirm, DISMISS_CONFIRM_MS);
    return;
  }
  resetDismissConfirm();
  dismissBtn.disabled = true;
  try {
    await postJson(`./api/dashboard/agents/${meta.id}/dismiss`, token, {});
  } catch (err) {
    errorEl.textContent = String(err).includes('409')
      ? '작업 중이거나 승인을 기다리는 중이라 지금은 퇴근시킬 수 없어요.'
      : `퇴근시키지 못했어요: ${String(err)}`;
    renderStatus();
    return;
  }
  dismissed = true;
  renderStatus();
  window.setTimeout(() => {
    if (window.opener && !window.matchMedia(TOUCH_MEDIA).matches) window.close();
    else window.location.assign(backEl.href);
  }, 1200);
}

dismissBtn.addEventListener('click', () => void dismiss());

input.addEventListener('keydown', (ev) => {
  if (window.matchMedia(TOUCH_MEDIA).matches) return;
  if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
    ev.preventDefault();
    void send();
  }
});
sendBtn.addEventListener('click', () => void send());

// ── Mode, model and slash commands ────────────────────────────

function currentSettings(): { mode: DashboardMode; model: string | null } {
  return creating ? draftSettings : (meta?.settings ?? draftSettings);
}

function modelName(value: string | null): string {
  if (!value) return '기본 모델';
  return catalog.models.find((m) => m.value === value)?.displayName ?? value;
}

function renderControls(): void {
  const usable = creating || (!!meta && !!meta.settings && meta.owner !== 'terminal');
  controlsEl.hidden = !usable || dismissed;
  if (controlsEl.hidden) return;
  const { mode, model } = currentSettings();
  if (modeSelect.options.length === 0) {
    modeSelect.append(...DASHBOARD_MODES.map((m) => new Option(MODE_LABELS[m], m)));
  }
  if (document.activeElement !== modeSelect) modeSelect.value = mode;
  const values = ['', ...catalog.models.map((m) => m.value)];
  if (model && !values.includes(model)) values.push(model);
  const signature = values.join('|');
  if (modelSelect.dataset.signature !== signature) {
    modelSelect.dataset.signature = signature;
    modelSelect.replaceChildren(...values.map((v) => new Option(modelName(v || null), v)));
  }
  if (document.activeElement !== modelSelect) modelSelect.value = model ?? '';
}

async function loadCatalog(): Promise<void> {
  const path = meta ? `./api/dashboard/agents/${meta.id}/catalog` : './api/dashboard/catalog';
  try {
    catalog = await fetchJson<typeof catalog>(path, token);
    renderControls();
  } catch (err) {
    console.error('[Chat] catalog failed', err);
  }
}

async function applySettings(change: {
  mode?: DashboardMode;
  model?: string | null;
}): Promise<void> {
  if (creating || !meta) {
    draftSettings = { ...draftSettings, ...change };
    renderControls();
    noteEl.textContent = describeSettings(draftSettings);
    return;
  }
  try {
    const saved = await postJson<{ mode: DashboardMode; model: string | null }>(
      `./api/dashboard/agents/${meta.id}/settings`,
      token,
      change,
    );
    meta = { ...meta, settings: saved };
    renderControls();
    noteEl.textContent = describeSettings(saved);
  } catch (err) {
    errorEl.textContent = `설정을 바꾸지 못했어요: ${String(err)}`;
  }
}

function describeSettings(s: { mode: DashboardMode; model: string | null }): string {
  return `지금 설정: ${MODE_LABELS[s.mode]} 모드, ${modelName(s.model)}`;
}

function closePicker(): void {
  pickerEl.replaceChildren();
  activePicker = null;
}

/** A numbered list like the terminal's; a click or number key picks. */
function showPicker(
  title: string,
  items: Array<{ label: string; description: string; pick: () => void }>,
): void {
  const card = el('div', 'picker-card');
  card.append(el('p', 'ask-title', title));
  const list = el('div', 'q-options');
  items.forEach((item, i) => {
    const b = el('button', 'q-option');
    b.type = 'button';
    b.append(el('span', 'q-num', String(i + 1)), el('span', 'q-label', item.label));
    if (item.description) b.append(el('span', 'q-desc', item.description));
    b.addEventListener('click', () => {
      closePicker();
      item.pick();
    });
    list.append(b);
  });
  const cancel = el('button', 'btn', '닫기');
  cancel.type = 'button';
  cancel.addEventListener('click', closePicker);
  const actions = el('div', 'ask-actions');
  actions.append(cancel);
  card.append(list, el('p', 'q-hint', '숫자 키로 고르거나 Esc로 닫아요.'), actions);
  pickerEl.replaceChildren(card);
  activePicker = (index) => {
    const item = items[index];
    if (!item) return;
    closePicker();
    item.pick();
  };
}

/** Runs /model, /mode and /help here; returns false for anything meant for Claude. */
function runLocalCommand(text: string): boolean {
  const command = parseLocalCommand(text);
  if (!command) return false;
  if (!creating && (!meta?.settings || meta.owner === 'terminal')) {
    errorEl.textContent = '터미널에서 열려 있는 세션은 여기서 설정을 바꿀 수 없어요.';
    return true;
  }
  if (command.kind === 'help') {
    const all = [...LOCAL_COMMANDS, ...catalog.commands];
    showPicker(
      '쓸 수 있는 명령어',
      all.map((c) => ({
        label: `/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ''}`,
        description: c.description,
        pick: () => {
          input.value = `/${c.name} `;
          input.focus();
        },
      })),
    );
    return true;
  }
  if (command.kind === 'mode') {
    if (command.arg) {
      const mode = resolveMode(command.arg);
      if (mode) void applySettings({ mode });
      else
        errorEl.textContent = `모르는 모드예요: ${command.arg} (자동, 기본, 편집, 계획 중에서 골라 주세요)`;
      return true;
    }
    showPicker(
      '권한 모드',
      DASHBOARD_MODES.map((m) => ({
        label: MODE_LABELS[m],
        description: m === currentSettings().mode ? '지금 쓰는 모드' : '',
        pick: () => void applySettings({ mode: m }),
      })),
    );
    return true;
  }
  if (command.arg) {
    void applySettings({ model: resolveModel(command.arg, catalog.models) });
    return true;
  }
  const choices = [{ value: null, displayName: '기본 모델', description: '' }, ...catalog.models];
  showPicker(
    catalog.models.length ? '모델' : '모델 (목록은 세션이 한 번 켜진 뒤에 보여요)',
    choices.map((m) => ({
      label: m.displayName,
      description: (m.value ?? null) === currentSettings().model ? '지금 쓰는 모델' : m.description,
      pick: () => void applySettings({ model: m.value }),
    })),
  );
  return true;
}

function hideSuggest(): void {
  suggestEl.hidden = true;
  suggestEl.replaceChildren();
}

/** The next-message guess, while the box is empty and the agent is waiting for the user. */
function nextSuggestion(): string | null {
  if (input.value || input.disabled || !meta?.suggestion || meta.busy) return null;
  return meta.suggestion;
}

function acceptNextSuggestion(): boolean {
  const next = nextSuggestion();
  if (!next) return false;
  input.value = next;
  hideSuggest();
  renderNextSuggestion();
  input.focus();
  return true;
}

/** Shown greyed in the empty box like the terminal; on a phone also as a tappable row. */
function renderNextSuggestion(): void {
  const next = nextSuggestion();
  input.placeholder = next
    ? `${next}${window.matchMedia(TOUCH_MEDIA).matches ? '' : '  (Tab으로 쓰기)'}`
    : DEFAULT_PLACEHOLDER;
  if (!window.matchMedia(TOUCH_MEDIA).matches || input.value) return;
  if (!next) {
    if (suggestEl.dataset.kind === 'next') hideSuggest();
    return;
  }
  const li = el('li', '');
  li.setAttribute('role', 'option');
  li.append(el('span', 'sg-name', '제안'), el('span', 'sg-desc', next));
  li.addEventListener('mousedown', (ev) => {
    ev.preventDefault();
    acceptNextSuggestion();
  });
  suggestEl.dataset.kind = 'next';
  suggestEl.replaceChildren(li);
  suggestEl.hidden = false;
}

function renderSuggest(): void {
  const items = suggestCommands(input.value, catalog.commands);
  if (items.length === 0) {
    hideSuggest();
    renderNextSuggestion();
    return;
  }
  suggestEl.dataset.kind = 'command';
  suggestIndex = Math.min(suggestIndex, items.length - 1);
  suggestEl.replaceChildren(
    ...items.map((c, i) => {
      const li = el('li', '');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === suggestIndex));
      li.append(el('span', 'sg-name', `/${c.name}`), el('span', 'sg-desc', c.description));
      li.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        input.value = `/${c.name} `;
        hideSuggest();
        input.focus();
      });
      return li;
    }),
  );
  suggestEl.hidden = false;
}

input.addEventListener('input', () => {
  suggestIndex = 0;
  renderSuggest();
});
input.addEventListener('keydown', (ev) => {
  if (ev.key === 'Tab' && !ev.shiftKey && acceptNextSuggestion()) {
    ev.preventDefault();
    return;
  }
  if (suggestEl.hidden || suggestEl.dataset.kind !== 'command') return;
  const count = suggestEl.children.length;
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    ev.preventDefault();
    suggestIndex = (suggestIndex + (ev.key === 'ArrowDown' ? 1 : count - 1)) % count;
    renderSuggest();
  } else if (ev.key === 'Tab') {
    ev.preventDefault();
    const name = suggestEl.children[suggestIndex]?.querySelector('.sg-name')?.textContent;
    if (name) input.value = `${name} `;
    hideSuggest();
  }
});
modeSelect.addEventListener(
  'change',
  () => void applySettings({ mode: modeSelect.value as DashboardMode }),
);
modelSelect.addEventListener(
  'change',
  () => void applySettings({ model: modelSelect.value || null }),
);

// ── "작업 중…" line, like the terminal's spinner ─────────────────

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const min = Math.floor(total / 60);
  return min > 0 ? `${min}분 ${total % 60}초` : `${total}초`;
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

function renderWorking(): void {
  const activity = meta?.activity ?? null;
  const tools = meta?.activeTools ?? [];
  const show = !dismissed && !creating && !!meta && (!!activity || tools.length > 0);
  workingEl.hidden = !show;
  if (!show) return;
  const text = workingEl.querySelector('.wk-text');
  const metaEl = workingEl.querySelector('.wk-meta');
  if (activity) {
    const elapsed = activity.elapsedMs + (Date.now() - activityAt);
    if (text) text.textContent = meta?.pending.length ? '답을 기다리는 중…' : '작업 중…';
    if (metaEl) {
      metaEl.textContent = `(${formatElapsed(elapsed)} · ↓ ${formatTokens(activity.outputTokens)} 토큰${stopBtn.hidden ? '' : ' · Esc로 중단'})`;
    }
  } else {
    if (text) text.textContent = '작업 중…';
    if (metaEl) metaEl.textContent = tools[tools.length - 1] ?? '';
  }
}
window.setInterval(renderWorking, 150);

// ── Attachments: pick on a phone, drop or paste on a laptop ───────

interface Uploaded {
  path: string;
  name: string;
  size: number;
  mime: string;
}

const MAX_FILE_BYTES = 25 * 1024 * 1024;
const attachBtn = byId<HTMLButtonElement>('attach');
const fileInput = byId<HTMLInputElement>('file-input');
const attachmentsEl = byId<HTMLUListElement>('attachments');
let pendingFiles: File[] = [];

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  return `${Math.max(1, Math.round(bytes / 1024))}KB`;
}

/** Pasted screenshots arrive as "image.png"; give them a time so several stay apart. */
function namedFile(file: File): File {
  if (file.name && file.name !== 'image.png') return file;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const ext = file.type.split('/')[1] ?? 'png';
  return new File([file], `붙여넣은-이미지-${stamp}.${ext}`, { type: file.type });
}

function addFiles(files: Iterable<File>): void {
  for (const raw of files) {
    const file = namedFile(raw);
    if (file.size > MAX_FILE_BYTES) {
      errorEl.textContent = `${file.name}: 25MB보다 큰 파일은 첨부할 수 없어요.`;
      continue;
    }
    pendingFiles.push(file);
  }
  renderAttachments();
}

function renderAttachments(): void {
  attachmentsEl.replaceChildren(
    ...pendingFiles.map((file, i) => {
      const li = el('li', '');
      const remove = el('button', 'att-remove', '×');
      remove.type = 'button';
      remove.title = '첨부 빼기';
      remove.addEventListener('click', () => {
        pendingFiles.splice(i, 1);
        renderAttachments();
      });
      li.append(
        el('span', 'att-name', file.name),
        el('span', 'att-size', formatSize(file.size)),
        remove,
      );
      return li;
    }),
  );
}

/** Send the files first; the message then refers to where the server saved them. */
async function uploadPending(): Promise<Uploaded[]> {
  const uploaded: Uploaded[] = [];
  for (const file of pendingFiles) {
    const params = new URLSearchParams({
      name: file.name,
      mime: file.type || 'application/octet-stream',
    });
    const res = await fetch(`./api/dashboard/uploads?${params.toString()}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
      body: file,
    });
    if (!res.ok) throw new Error(`${file.name} 올리기 실패: ${res.status} ${await res.text()}`);
    uploaded.push((await res.json()) as Uploaded);
  }
  return uploaded;
}

attachBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files) addFiles(fileInput.files);
  fileInput.value = '';
});
input.addEventListener('paste', (ev) => {
  const files = ev.clipboardData?.files;
  if (!files || files.length === 0) return;
  ev.preventDefault();
  addFiles(files);
});
let dragDepth = 0;
document.addEventListener('dragenter', (ev) => {
  if (!ev.dataTransfer?.types.includes('Files')) return;
  dragDepth += 1;
  document.body.classList.add('dropping');
});
document.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) document.body.classList.remove('dropping');
});
document.addEventListener('dragover', (ev) => {
  if (ev.dataTransfer?.types.includes('Files')) ev.preventDefault();
});
document.addEventListener('drop', (ev) => {
  dragDepth = 0;
  document.body.classList.remove('dropping');
  if (!ev.dataTransfer?.files.length) return;
  ev.preventDefault();
  if (input.disabled) {
    errorEl.textContent = '이 세션에는 지금 첨부를 보낼 수 없어요.';
    return;
  }
  addFiles(ev.dataTransfer.files);
});

/** Stop the running turn, like Esc in the terminal. */
async function interrupt(): Promise<void> {
  if (!meta || stopBtn.hidden || stopBtn.disabled) return;
  stopBtn.disabled = true;
  try {
    await postJson(`./api/dashboard/agents/${meta.id}/interrupt`, token, {});
    noteEl.textContent = '멈췄어요. 이어서 지시를 보내면 돼요.';
  } catch (err) {
    errorEl.textContent = `멈추지 못했어요: ${String(err)}`;
  } finally {
    stopBtn.disabled = false;
  }
}
stopBtn.addEventListener('click', () => void interrupt());

document.addEventListener('keydown', (ev) => {
  if (ev.isComposing) return;
  if (ev.key === 'Escape') {
    if (!suggestEl.hidden) hideSuggest();
    else if (activePicker) closePicker();
    else void interrupt();
    return;
  }
  // Number keys answer the open question while the message box is empty, as in the terminal.
  const typing =
    ev.target instanceof HTMLInputElement ||
    (ev.target instanceof HTMLTextAreaElement && ev.target.value.trim() !== '');
  if (typing || ev.ctrlKey || ev.metaKey || ev.altKey) return;
  if (activePicker && /^[1-9]$/.test(ev.key)) {
    ev.preventDefault();
    activePicker(Number(ev.key) - 1);
    return;
  }
  // Approvals: 1 allows, 2 denies the first waiting request, like the terminal prompt.
  const approval = asksEl.querySelector<HTMLElement>('.ask:not(.ask-question)');
  if (!activeQuestion && approval && (ev.key === '1' || ev.key === '2')) {
    ev.preventDefault();
    approval
      .querySelectorAll<HTMLButtonElement>('.ask-actions button')
      [ev.key === '1' ? 0 : 1]?.click();
    return;
  }
  if (!activeQuestion) return;
  if (/^[1-9]$/.test(ev.key)) {
    ev.preventDefault();
    activeQuestion.pick(0, Number(ev.key) - 1);
  } else if (ev.key === 'Enter' && activeQuestion.ready()) {
    ev.preventDefault();
    activeQuestion.submit();
  }
});

if (!token) {
  setTitle('토큰이 없습니다');
  noteEl.textContent = '사무실 화면(토큰 포함 주소)에서 직원을 눌러 여세요.';
  input.disabled = true;
  sendBtn.disabled = true;
} else {
  backEl.href = `./scene.html?${new URLSearchParams({ token }).toString()}`;
  if (sessionId) announceChatWindow(sessionId);
  setTitle(creating ? '새 직원 부르기' : '불러오는 중…');
  renderStatus();
  void loadUserName()
    .then(() => pollAgents())
    .then(() => pollConversation());
  window.setInterval(() => void pollAgents(), AGENTS_POLL_MS);
  window.setInterval(() => void pollConversation(), CONVERSATION_POLL_MS);
  input.focus();
}
