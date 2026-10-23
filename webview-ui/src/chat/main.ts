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
  type CreditStatus,
  dropTeamDraft,
  fetchJson,
  type MediaRef,
  type MemberStatus,
  type PermissionAsk,
  type PlanPermission,
  postJson,
  type Question,
  readTeamDraft,
  takeChatDraft,
  type TeamPlan,
  type TeamStatus,
  type WorkLimit,
} from '../scene/api.js';
import { reportSeen } from '../scene/push.js';
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
/** A team the office composed: the first message is its brief and starts the MD. */
const teamDraftId = creating ? params.get('team') : null;
const teamDraft = teamDraftId ? readTeamDraft(teamDraftId) : null;

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
const boardEl = byId<HTMLDetailsElement>('team-board');
const input = byId<HTMLTextAreaElement>('input');
const sendBtn = byId<HTMLButtonElement>('send');
const errorEl = byId<HTMLParagraphElement>('error');
const backEl = byId<HTMLAnchorElement>('back');
const dismissBtn = byId<HTMLButtonElement>('dismiss');
const terminalBtn = byId<HTMLButtonElement>('to-terminal');
const takeOverBtn = byId<HTMLButtonElement>('take-over');
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
let catalog: { commands: CatalogCommand[]; models: CatalogModel[]; defaultModel: string | null } = {
  commands: [],
  models: [],
  defaultModel: null,
};
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

/** Where a bare URL really ends. GFM runs it to the next space, so in Korean, where a
 *  particle follows with no space ("(http://x/)를"), the link swallowed ")를". A Hangul
 *  letter or a ")" with no "(" to close ends it; agents write Hangul in URLs encoded. */
function bareUrlLength(url: string): number {
  let depth = 0;
  for (let i = 0; i < url.length; i++) {
    const ch = url[i];
    if (/[ᄀ-ᇿ㄰-㆏가-힣]/.test(ch)) return i;
    if (ch === '(') depth++;
    if (ch === ')' && depth-- === 0) return i;
  }
  return url.length;
}

marked.use({
  tokenizer: {
    url(src) {
      const token = marked.Tokenizer.prototype.url.call(this, src);
      if (!token || token.href.startsWith('mailto:')) return token ?? false;
      let end = bareUrlLength(token.text);
      while (end > 0 && '.,:;!?\'"'.includes(token.text[end - 1])) end--;
      const cut = token.text.length - end;
      if (cut === 0 || end === 0) return token;
      const text = token.text.slice(0, end);
      return {
        ...token,
        raw: token.raw.slice(0, token.raw.length - cut),
        text,
        href: token.href.slice(0, token.href.length - cut),
        tokens: [{ type: 'text', raw: text, text, escaped: false }],
      };
    },
  },
});

// Links open in a new tab, so the chat window never navigates away from the conversation.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node instanceof HTMLAnchorElement && /^https?:$/.test(node.protocol)) {
    node.target = '_blank';
    node.rel = 'noopener noreferrer';
  }
});

const COPIED_RESET_MS = 1_500;

function markdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: true }));
}

/** navigator.clipboard needs a secure page; the plain-http LAN link falls back to execCommand. */
async function copyText(text: string): Promise<void> {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  if (!ok) throw new Error('copy command refused');
}

function addCopyButtons(body: HTMLElement): void {
  for (const pre of Array.from(body.querySelectorAll('pre'))) {
    const wrap = el('div', 'code-wrap');
    pre.replaceWith(wrap);
    const btn = el('button', 'code-copy', '복사');
    btn.type = 'button';
    btn.addEventListener('click', () => {
      copyText(pre.textContent ?? '').then(
        () => {
          btn.textContent = '복사됨';
          window.setTimeout(() => (btn.textContent = '복사'), COPIED_RESET_MS);
        },
        (err: unknown) => {
          btn.textContent = '실패';
          errorEl.textContent = `복사하지 못했습니다: ${String(err)}`;
        },
      );
    });
    wrap.append(pre, btn);
  }
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
  if (entry.kind === 'assistant') {
    body.innerHTML = markdown(entry.text);
    addCopyButtons(body);
  } else body.textContent = entry.text;
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
const MEDIA_LABEL: Record<MediaRef['kind'], string> = {
  image: '사진',
  video: '영상',
  audio: '소리',
};
/** Per device: 'off' turns the touch low-data mode off; anything else leaves it on. */
const LOW_DATA_KEY = 'bitteul-chat-low-data';
const lowDataWrap = byId<HTMLLabelElement>('low-data-wrap');
const lowDataBox = byId<HTMLInputElement>('low-data');
const modeWrap = byId<HTMLLabelElement>('mode-wrap');
const modelWrap = byId<HTMLLabelElement>('model-wrap');

function lowDataOn(): boolean {
  return window.matchMedia(TOUCH_MEDIA).matches && localStorage.getItem(LOW_DATA_KEY) !== 'off';
}

lowDataBox.addEventListener('change', () => {
  localStorage.setItem(LOW_DATA_KEY, lowDataBox.checked ? 'on' : 'off');
  // Turning it off loads what still waits for a tap; turning it on affects new previews only.
  if (!lowDataBox.checked) {
    for (const box of mediaNodes.values()) {
      box.querySelector<HTMLButtonElement>('.media-tap')?.click();
    }
  }
});

const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP_PX = 10;

/**
 * The share sheet is the only route to the photo library or Files on iOS for audio and video,
 * and previews are blob: URLs that its own long-press menu does not reliably save.
 * Without Web Share (plain-http LAN link) the file is downloaded instead.
 */
async function saveMedia(file: File, url: string): Promise<void> {
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      errorEl.textContent = `저장하지 못했습니다: ${String(err)}`;
    }
    return;
  }
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  document.body.append(link);
  link.click();
  link.remove();
}

/** Fires on lift after a hold, so the share sheet opens inside a user gesture. */
function onLongPress(target: HTMLElement, action: () => void): void {
  let startedAt = 0;
  let startX = 0;
  let startY = 0;
  target.addEventListener(
    'touchstart',
    (ev) => {
      if (ev.touches.length !== 1) return;
      startedAt = Date.now();
      startX = ev.touches[0].clientX;
      startY = ev.touches[0].clientY;
    },
    { passive: true },
  );
  target.addEventListener(
    'touchmove',
    (ev) => {
      const t = ev.touches[0];
      const moved = Math.hypot(t.clientX - startX, t.clientY - startY);
      if (moved > LONG_PRESS_SLOP_PX) startedAt = 0;
    },
    { passive: true },
  );
  target.addEventListener('touchcancel', () => (startedAt = 0));
  target.addEventListener('touchend', (ev) => {
    const held = startedAt !== 0 && Date.now() - startedAt >= LONG_PRESS_MS;
    startedAt = 0;
    if (!held) return;
    ev.preventDefault();
    action();
  });
}

async function loadMedia(m: MediaRef, key: string, holder: HTMLElement): Promise<void> {
  if (!meta) return;
  try {
    const res = await fetch(
      `./api/dashboard/agents/${meta.id}/media?path=${encodeURIComponent(m.path)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const file = new File([blob], m.name, { type: blob.type });
    const box = holder.closest('figure');
    if (box) onLongPress(box, () => void saveMedia(file, url));
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
  const hint = !m.tooLarge && window.matchMedia(TOUCH_MEDIA).matches ? ' · 꾹 눌러 저장' : '';
  const caption = el('figcaption', '', `${m.name} · ${formatSize(m.size)}${hint}`);
  caption.title = m.path;
  box.append(caption);
  mediaNodes.set(key, box);
  if (m.tooLarge) {
    box.prepend(el('div', 'media-note', '파일이 너무 커서 미리보기는 생략했어요'));
  } else if (lowDataOn()) {
    // Low-data on phones and tablets: nothing downloads until the preview is tapped.
    const tap = el('button', 'media-note media-tap', `눌러서 ${MEDIA_LABEL[m.kind]} 보기`);
    tap.setAttribute('type', 'button');
    tap.addEventListener(
      'click',
      () => {
        tap.textContent = '불러오는 중…';
        void loadMedia(m, key, tap);
      },
      { once: true },
    );
    box.prepend(tap);
  } else {
    const holder = el('div', 'media-note', '불러오는 중…');
    box.prepend(holder);
    void loadMedia(m, key, holder);
  }
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

const BUDGET_WARN = 0.8;
const LIMIT_NAMES: Record<string, string> = {
  five_hour: '5시간 한도',
  seven_day: '주간 한도',
  seven_day_opus: '주간 Opus 한도',
  seven_day_sonnet: '주간 Sonnet 한도',
  seven_day_overage_included: '주간 한도',
};
const MEMBER_STATES: Record<MemberStatus['state'], string> = {
  idle: '아직 안 불림',
  working: '작업 중',
  done: '끝냄',
  failed: '실패',
  stopped: '멈춤',
};

function dollars(n: number): string {
  return `$${n.toFixed(2)}`;
}

function tokensText(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k 토큰` : `${n} 토큰`;
}

function resetText(epochSeconds: number): string {
  const d = new Date(epochSeconds * 1000);
  const time = d.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString()
    ? `${time} 초기화`
    : `${d.getMonth() + 1}월 ${d.getDate()}일 ${time} 초기화`;
}

function limitText(l: WorkLimit): string {
  const name = LIMIT_NAMES[l.kind] ?? '사용 한도';
  const used =
    l.utilization !== null
      ? `${Math.round(l.utilization * 100)}% 사용`
      : l.status === 'rejected'
        ? '다 씀'
        : l.status === 'allowed_warning'
          ? '거의 다 씀'
          : '여유 있음';
  return [name, used, l.resetsAt ? resetText(l.resetsAt) : ''].filter(Boolean).join(' · ');
}

function creditText(c: CreditStatus | null): string {
  if (!c) return '정보 없음 (아직 알려온 게 없어요)';
  if (c.required) return '크레딧이 필요해요. 충전해야 이어서 할 수 있어요.';
  if (c.disabledReason === 'out_of_credits') return '크레딧을 다 썼어요';
  if (c.usingCredits) return '한도를 넘겨서 추가 크레딧으로 쓰는 중';
  if (c.status === 'rejected') return '추가 크레딧을 쓸 수 없어요';
  if (c.status) return '필요하면 추가 크레딧을 쓸 수 있어요';
  return '추가 크레딧 꺼짐';
}

function boardRow(label: string, ...content: Array<Node | string>): HTMLElement {
  const row = el('div', 'tb-row');
  const value = el('span', '');
  value.append(...content);
  row.append(el('strong', '', label), value);
  return row;
}

/** The MD window's team board: spend against the budget, account limits, credits, members. */
function renderBoard(team: TeamStatus | null): void {
  boardEl.hidden = !team;
  if (!team) return;
  const share = team.budgetUsd ? team.costUsd / team.budgetUsd : 0;
  const level = team.budgetStopped || share >= 1 ? 'stop' : share >= BUDGET_WARN ? 'warn' : '';
  if (level) boardEl.dataset.level = level;
  else delete boardEl.dataset.level;
  const money = team.budgetUsd
    ? `${dollars(team.costUsd)} / ${dollars(team.budgetUsd)}`
    : `${dollars(team.costUsd)} (한도 없음)`;
  const firstLimit = team.limits[0];
  const brief = boardEl.querySelector('.tb-brief');
  if (brief) {
    brief.textContent = [money, firstLimit ? limitText(firstLimit) : '']
      .filter(Boolean)
      .join(' · ');
  }
  const body = boardEl.querySelector('.tb-body');
  if (!body) return;
  const parts: HTMLElement[] = [];
  if (team.budgetStopped) {
    const alert = el(
      'p',
      'tb-alert',
      `예산 ${dollars(team.budgetUsd ?? 0)}을 다 써서 팀을 멈췄어요. 이 팀은 더 진행할 수 없어요. 이어서 하려면 예산을 넉넉히 잡아 새 팀을 만들어 주세요.`,
    );
    alert.dataset.level = 'stop';
    parts.push(alert);
  } else if (level === 'warn') {
    parts.push(
      el('p', 'tb-alert', `예산의 ${Math.round(share * 100)}%를 썼어요. 다 쓰면 팀이 멈춰요.`),
    );
  }
  const moneyCell: Array<Node | string> = [`${money} 사용 (예상치)`];
  if (team.budgetUsd) {
    const bar = el('div', 'tb-bar');
    if (level) bar.dataset.level = level;
    const fill = el('i', '');
    fill.style.width = `${Math.min(100, Math.round(share * 100))}%`;
    bar.append(fill);
    moneyCell.push(bar);
  }
  parts.push(boardRow('달러', ...moneyCell));
  parts.push(
    boardRow(
      '작업한도',
      team.limits.length
        ? team.limits.map(limitText).join(' / ')
        : '정보 없음 (아직 알려온 게 없어요)',
    ),
  );
  parts.push(boardRow('크레딧', creditText(team.credits)));
  const list = el('ul', 'tb-members');
  for (const m of team.members) {
    const li = el('li', '');
    const state = el('span', 'tb-state', MEMBER_STATES[m.state]);
    state.dataset.state = m.state;
    const detail =
      m.state === 'idle'
        ? ''
        : [tokensText(m.tokens), `도구 ${m.toolUses}회`, m.lastTool ? `마지막: ${m.lastTool}` : '']
            .filter(Boolean)
            .join(' · ');
    li.append(el('b', '', m.label), state);
    if (detail) li.append(el('small', '', detail));
    list.append(li);
  }
  parts.push(boardRow('팀원', list));
  body.replaceChildren(...parts);
}

/** A team MD's plan state, for the status line. */
function teamNote(m: AgentMeta): string {
  if (!m.team) return '';
  if (m.team.plan === 'approved') {
    return `${m.team.name} · 계획 승인됨 · 범위 안 요청 ${m.team.autoAllowed}건 자동 허용`;
  }
  return m.team.plan === 'waiting' ? `${m.team.name} · 계획 승인 대기` : m.team.name;
}

function renderStatus(): void {
  let status: string;
  let note = '';
  let locked = sending;
  if (creating && teamDraft) {
    const { team } = teamDraft;
    status = '새 팀';
    note = `${team.name}: ${team.leadLabel}(팀장), ${team.members.map((m) => m.label).join(', ')}. 첫 브리프를 보내면 팀장이 팀원에게 일을 나눠요.`;
  } else if (creating) {
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
    if (meta.owner === 'teammate') locked = true;
  } else if (meta.owner === 'teammate') {
    status = meta.busy ? '팀 작업 중' : '팀원 대기';
    note = '팀원은 MD를 통해 일을 받아요. 지시는 MD 창에서 해 주세요.';
    locked = true;
  } else if (meta.owner === 'terminal') {
    status = '보기 전용';
    note =
      '터미널에서 열려 있는 세션입니다. 터미널이 쉬는 중일 때 "여기서 이어받기"를 누르면 이 창에서 이어서 조작할 수 있어요.';
    locked = true;
  } else if (meta.team?.budgetStopped) {
    status = '예산 소진';
    note = teamNote(meta);
    locked = true;
  } else if (meta.busy) {
    status = '작업 중';
    note = teamNote(meta);
  } else if (meta.team) {
    status = '대기';
    note = teamNote(meta);
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
  takeOverBtn.hidden = !meta || creating || dismissed || meta.owner !== 'terminal';
  // Opens a window on the PC, so a phone never offers it.
  terminalBtn.hidden =
    !meta ||
    creating ||
    dismissed ||
    meta.owner === 'terminal' ||
    meta.owner === 'teammate' ||
    window.matchMedia(TOUCH_MEDIA).matches;
  terminalBtn.disabled = !meta || meta.busy || meta.pending.length > 0;
  dismissBtn.hidden = !meta || creating || dismissed || meta.owner === 'teammate';
  dismissBtn.disabled = !meta || meta.busy || meta.pending.length > 0;
  dismissBtn.title =
    meta?.owner === 'terminal'
      ? '사무실에서만 빠져요. 터미널의 Claude는 그대로 켜져 있어요.'
      : '이 세션을 끝내고 사무실에서 빼요.';
  statusEl.textContent = status;
  statusEl.dataset.state = status;
  noteEl.textContent = note;
  renderBoard(creating || meta?.owner !== 'dashboard' ? null : (meta?.team ?? null));
  input.disabled = locked;
  attachBtn.disabled = locked;
  sendBtn.disabled = locked;
  sendBtn.textContent = creating ? (teamDraft ? '팀 시작' : '출근시키기') : '보내기';
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

/** What a tool call would do, in plain words for the approval card. */
function askVerb(toolName: string): string {
  if (toolName === 'Bash' || toolName === 'PowerShell') return '명령을 실행하려고 해요';
  if (toolName === 'Write') return '파일을 새로 쓰려고 해요';
  if (toolName === 'Edit' || toolName === 'MultiEdit' || toolName === 'NotebookEdit')
    return '파일을 고치려고 해요';
  if (toolName === 'Read') return '파일을 읽으려고 해요';
  if (toolName === 'WebFetch') return '웹 페이지를 열려고 해요';
  if (toolName === 'WebSearch') return '웹을 검색하려고 해요';
  if (toolName === 'ExitPlanMode') return '계획을 마치고 실행하려고 해요';
  if (toolName.startsWith('mcp__')) return '연결된 외부 도구를 쓰려고 해요';
  return '도구를 쓰려고 해요';
}

/** The summary is "Tool: detail"; the card already names the tool. */
function askDetail(ask: PermissionAsk): string {
  const prefix = `${ask.toolName}: `;
  return ask.summary.startsWith(prefix) ? ask.summary.slice(prefix.length) : ask.summary;
}

function keyedButton(cls: string, label: string, key: string): HTMLButtonElement {
  const b = el('button', cls);
  b.type = 'button';
  b.append(el('span', '', label), el('span', 'key', key));
  return b;
}

function renderApproval(ask: PermissionAsk): HTMLElement {
  const card = el('div', 'ask ask-approval');
  const who = ask.member ?? (titleEl.textContent || '직원');
  const head = el('div', 'ask-head');
  const name = el('span', 'ask-who');
  name.append(el('span', 'ask-name', who), el('span', 'ask-what', askVerb(ask.toolName)));
  head.append(el('span', 'ask-avatar', Array.from(who)[0] ?? '?'), name);
  head.append(el('span', 'ask-tool', ask.toolName));
  const allow = keyedButton('btn btn-primary', '허용', '1');
  const deny = keyedButton('btn btn-deny', '거부', '2');
  allow.addEventListener('click', () => void answer(ask.requestId, true, card));
  deny.addEventListener('click', () => void answer(ask.requestId, false, card));
  const actions = el('div', 'ask-actions');
  actions.append(allow, deny);
  card.append(head, el('pre', 'ask-detail', askDetail(ask)), actions);
  return card;
}

function renderChatter(ask: PermissionAsk, count: number): HTMLElement {
  const card = el('div', 'ask ask-approval');
  const who = ask.member ?? 'MD';
  const head = el('div', 'ask-head');
  const name = el('span', 'ask-who');
  name.append(
    el('span', 'ask-name', who),
    el('span', 'ask-what', '팀원끼리 대화가 길어지고 있어요'),
  );
  head.append(el('span', 'ask-avatar', Array.from(who)[0] ?? '?'), name);
  const body = el('div', 'chatter-body');
  body.append(
    el('p', '', `대표님 말씀 없이 팀원끼리 메시지를 ${count}번 주고받았어요.`),
    el('p', '', '같은 이야기를 맴도는 중일 수 있어요. 계속 두면 비용이 늘어요.'),
  );
  const goOn = keyedButton('btn btn-primary', '계속하게 두기', '1');
  const stop = keyedButton('btn btn-deny', '멈추고 정리해서 보고받기', '2');
  goOn.addEventListener('click', () => void answer(ask.requestId, true, card));
  stop.addEventListener('click', () => void answer(ask.requestId, false, card));
  const actions = el('div', 'ask-actions');
  actions.append(goOn, stop);
  card.append(head, body, actions);
  return card;
}

function describePermission(p: PlanPermission): [string, string] {
  if (p.kind === 'files') return ['파일 쓰기·고치기', `${p.scope} 폴더 안`];
  if (p.kind === 'command') return ['명령 실행', `"${p.scope}"로 시작하는 명령`];
  if (p.scope.trim() === 'search') return ['웹 검색', '검색어는 그때그때'];
  return ['웹 페이지 열기', `${p.scope} 사이트`];
}

function renderPlan(ask: PermissionAsk, plan: TeamPlan): HTMLElement {
  const card = el('div', 'ask ask-approval ask-plan');
  const who = ask.member ?? 'MD';
  const head = el('div', 'ask-head');
  const name = el('span', 'ask-who');
  name.append(el('span', 'ask-name', who), el('span', 'ask-what', '팀 계획을 승인해 주세요'));
  head.append(el('span', 'ask-avatar', Array.from(who)[0] ?? '?'), name);
  const body = el('div', 'plan-body');
  body.append(el('p', 'plan-summary', plan.summary));
  if (plan.assignments.length) {
    const list = el('ul', 'plan-list');
    for (const a of plan.assignments) {
      const li = el('li', '');
      li.append(el('strong', '', a.member), el('span', '', a.task));
      list.append(li);
    }
    body.append(el('h4', 'plan-heading', '누가 무엇을'), list);
  }
  const perms = el('ul', 'plan-list plan-perms');
  for (const p of plan.permissions) {
    const [what, where] = describePermission(p);
    const li = el('li', '');
    li.append(el('strong', '', what), el('span', '', where), el('em', '', p.why));
    perms.append(li);
  }
  body.append(
    el('h4', 'plan-heading', '승인하면 묻지 않고 허용할 일'),
    plan.permissions.length ? perms : el('p', 'plan-none', '없음. 필요할 때마다 물어봐요.'),
    el(
      'p',
      'plan-note',
      '이 범위 밖의 일은 지금처럼 하나씩 물어봐요. 모든 허용은 기록으로 남아요.',
    ),
  );
  const approve = keyedButton('btn btn-primary', '승인하고 시작', '1');
  const revise = keyedButton('btn btn-deny', '고쳐 달라고 하기', '2');
  const feedback = el('textarea', 'plan-feedback') as HTMLTextAreaElement;
  feedback.placeholder = '무엇을 바꾸면 좋을지 적어 주세요';
  feedback.rows = 3;
  feedback.hidden = true;
  const sendFeedback = el('button', 'btn btn-deny plan-send') as HTMLButtonElement;
  sendFeedback.type = 'button';
  sendFeedback.textContent = '이대로 다시 짜 달라고 보내기';
  sendFeedback.hidden = true;
  approve.addEventListener('click', () => void answer(ask.requestId, true, card));
  revise.addEventListener('click', () => {
    feedback.hidden = false;
    sendFeedback.hidden = false;
    feedback.focus();
  });
  sendFeedback.addEventListener(
    'click',
    () => void answer(ask.requestId, false, card, feedback.value.trim()),
  );
  const actions = el('div', 'ask-actions');
  actions.append(approve, revise);
  card.append(head, body, actions, feedback, sendFeedback);
  return card;
}

function renderAsks(asks: PermissionAsk[]): void {
  const signature = asks.map((a) => a.requestId).join(',');
  if (signature === lastAsks) return;
  lastAsks = signature;
  activeQuestion = null;
  asksEl.replaceChildren(
    ...asks.map((ask) =>
      ask.questions
        ? renderQuestion(ask, ask.questions)
        : ask.plan
          ? renderPlan(ask, ask.plan)
          : ask.chatter
            ? renderChatter(ask, ask.chatter)
            : renderApproval(ask),
    ),
  );
}

async function answer(
  requestId: string,
  allow: boolean,
  card: HTMLElement,
  feedback?: string,
): Promise<void> {
  card.querySelectorAll('button').forEach((b) => (b.disabled = true));
  try {
    await postJson(`./api/dashboard/permissions/${requestId}`, token, {
      allow,
      ...(feedback ? { feedback } : {}),
    });
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
  if (searchQuery) applySearch(true);
  if (signature === lastSignature) return;
  else toBottomBtn.dataset.new = '1';
  updateToBottom();
  lastSignature = signature;
  const nearBottom = isNearBottom();
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
      const res = teamDraft
        ? await postJson<{ sessionId: string }>('./api/dashboard/teams', token, {
            text,
            attachments,
            team: teamDraft.team,
            seats: teamDraft.seats,
            rooms: teamDraft.rooms,
            mode: draftSettings.mode,
          })
        : await postJson<{ sessionId: string }>('./api/dashboard/sessions', token, {
            text,
            attachments,
            ...(Number.isFinite(hireSeat) ? { seat: hireSeat } : {}),
            mode: draftSettings.mode,
            model: draftSettings.model,
          });
      if (teamDraftId) dropTeamDraft(teamDraftId);
      sessionId = res.sessionId;
      creating = false;
      announceChatWindow(sessionId, () => input.value);
      const next = new URLSearchParams({ token, session: sessionId });
      window.history.replaceState(null, '', `?${next.toString()}`);
      setTitle(teamDraft ? `${teamDraft.team.name} 출근 중…` : '새 직원 출근 중…');
    } else if (meta) {
      // No retry: the server may have taken the turn even when the answer never arrived.
      await postJson(
        `./api/dashboard/agents/${meta.id}/messages`,
        token,
        { text, attachments },
        MESSAGE_TIMEOUT_MS,
      );
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

async function openInTerminal(): Promise<void> {
  if (!meta || terminalBtn.disabled) return;
  terminalBtn.disabled = true;
  try {
    await postJson(`./api/dashboard/agents/${meta.id}/open-terminal`, token, {});
    noteEl.textContent = '터미널에서 이어서 열었어요. 이제 이 창은 보기 전용이에요.';
  } catch (err) {
    errorEl.textContent = String(err).includes('409')
      ? '작업 중이거나 승인을 기다리는 중이라 지금은 옮길 수 없어요. 이미 터미널에서 열려 있을 수도 있어요.'
      : `터미널에서 열지 못했어요: ${String(err)}`;
    terminalBtn.disabled = false;
  }
}

terminalBtn.addEventListener('click', () => void openInTerminal());

async function takeOver(): Promise<void> {
  if (!meta || takeOverBtn.disabled) return;
  takeOverBtn.disabled = true;
  errorEl.textContent = '';
  try {
    await postJson(`./api/dashboard/agents/${meta.id}/take-over`, token, {});
    noteEl.textContent = '이어받았어요. 이제 여기서 보내면 이 세션이 이어서 움직여요.';
  } catch (err) {
    errorEl.textContent = String(err).includes('409')
      ? '터미널에서 아직 작업 중이에요. 끝나고 다시 눌러 주세요.'
      : `이어받지 못했어요: ${String(err)}`;
  } finally {
    takeOverBtn.disabled = false;
  }
}

takeOverBtn.addEventListener('click', () => void takeOver());

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
  if (!value) {
    // The default is whatever ~/.claude/settings.json says right now; name it so a default
    // changed in some other session doesn't go unnoticed here.
    const current = catalog.defaultModel ? modelName(catalog.defaultModel) : null;
    return current ? `기본 모델 (지금: ${current})` : '기본 모델';
  }
  return catalog.models.find((m) => m.value === value)?.displayName ?? value;
}

function renderControls(): void {
  const usable =
    creating ||
    (!!meta && !!meta.settings && meta.owner !== 'terminal' && meta.owner !== 'teammate');
  const touch = window.matchMedia(TOUCH_MEDIA).matches;
  controlsEl.hidden = dismissed || (!usable && !touch);
  lowDataWrap.hidden = !touch;
  lowDataBox.checked = lowDataOn();
  modeWrap.hidden = !usable;
  // A new team's models are set per member in the team dialog.
  modelWrap.hidden = !usable || (creating && !!teamDraft);
  if (controlsEl.hidden || !usable) return;
  const { mode, model } = currentSettings();
  if (modeSelect.options.length === 0) {
    modeSelect.append(...DASHBOARD_MODES.map((m) => new Option(MODE_LABELS[m], m)));
  }
  if (document.activeElement !== modeSelect) modeSelect.value = mode;
  const values = ['', ...catalog.models.map((m) => m.value)];
  if (model && !values.includes(model)) values.push(model);
  const signature = `${values.join('|')}:${catalog.defaultModel ?? ''}`;
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
  const choices = [
    { value: null, displayName: modelName(null), description: '' },
    ...catalog.models,
  ];
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

/**
 * Copy the bytes now: iOS hands over a temporary copy of a photo that can vanish once the
 * page is backgrounded, and a later fetch on it fails with "TypeError: Load failed".
 */
async function addFiles(files: Iterable<File>): Promise<void> {
  for (const raw of Array.from(files)) {
    const named = namedFile(raw);
    if (named.size > MAX_FILE_BYTES) {
      errorEl.textContent = `${named.name}: 25MB보다 큰 파일은 첨부할 수 없어요.`;
      continue;
    }
    try {
      const bytes = await named.arrayBuffer();
      pendingFiles.push(new File([bytes], named.name, { type: named.type }));
    } catch (err) {
      errorEl.textContent = `${named.name}: 파일을 읽지 못했어요. 다시 골라 주세요. (${String(err)})`;
    }
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

const MESSAGE_TIMEOUT_MS = 30_000;
const UPLOAD_ATTEMPTS = 3;
const UPLOAD_BASE_TIMEOUT_MS = 30_000;
const UPLOAD_MS_PER_MB = 10_000;
const UPLOAD_RETRY_DELAY_MS = 1_500;

/**
 * One file, retried when the phone's connection drops or stalls mid-upload (network switch,
 * VPN reconnect). Without a timeout a stalled request never settles and the send spins forever.
 */
async function uploadOne(file: File): Promise<Uploaded> {
  const params = new URLSearchParams({
    name: file.name,
    mime: file.type || 'application/octet-stream',
  });
  const timeoutMs = UPLOAD_BASE_TIMEOUT_MS + (file.size / 1024 / 1024) * UPLOAD_MS_PER_MB;
  let lastError: unknown;
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`./api/dashboard/uploads?${params.toString()}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
        body: file,
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`${file.name} 올리기 실패: ${res.status} ${await res.text()}`);
      return (await res.json()) as Uploaded;
    } catch (err) {
      // A server answer (4xx/5xx) will not change on retry; only network failures are retried.
      if (!(err instanceof TypeError) && !controller.signal.aborted) throw err;
      lastError = controller.signal.aborted
        ? new Error(`${Math.round(timeoutMs / 1000)}초 안에 응답 없음`)
        : err;
      if (attempt < UPLOAD_ATTEMPTS) {
        errorEl.textContent = `${file.name} 다시 올리는 중… (${attempt + 1}/${UPLOAD_ATTEMPTS})`;
        await new Promise((resolve) => window.setTimeout(resolve, UPLOAD_RETRY_DELAY_MS));
      }
    } finally {
      window.clearTimeout(timer);
    }
  }
  throw new Error(`${file.name} 올리기 실패 (${UPLOAD_ATTEMPTS}번 시도): ${String(lastError)}`);
}

/** Send the files first; the message then refers to where the server saved them. */
async function uploadPending(): Promise<Uploaded[]> {
  const uploaded: Uploaded[] = [];
  for (const file of pendingFiles) uploaded.push(await uploadOne(file));
  return uploaded;
}

attachBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  const files = fileInput.files ? Array.from(fileInput.files) : [];
  fileInput.value = '';
  void addFiles(files);
});
input.addEventListener('paste', (ev) => {
  const files = ev.clipboardData?.files;
  if (!files || files.length === 0) return;
  ev.preventDefault();
  void addFiles(Array.from(files));
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
  void addFiles(Array.from(ev.dataTransfer.files));
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

// ── Jump to the latest message ──

const toBottomBtn = byId<HTMLButtonElement>('to-bottom');

function isNearBottom(): boolean {
  return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < STICK_TO_BOTTOM_PX;
}

/** Shown while scrolled up; says "새 메시지" when something arrived out of view. */
function updateToBottom(): void {
  const away = !isNearBottom();
  toBottomBtn.hidden = !away;
  if (!away) delete toBottomBtn.dataset.new;
  toBottomBtn.textContent = toBottomBtn.dataset.new ? '↓ 새 메시지' : '↓ 맨 아래로';
}

logEl.addEventListener('scroll', updateToBottom, { passive: true });
// Instant, not smooth: logs run to tens of thousands of pixels, and a long smooth scroll
// stalls when the window is in the background.
toBottomBtn.addEventListener('click', () => {
  logEl.scrollTop = logEl.scrollHeight;
  updateToBottom();
});

// ── Find in the conversation ──

const searchBar = byId<HTMLDivElement>('search');
const searchInput = byId<HTMLInputElement>('search-input');
const searchCount = byId<HTMLSpanElement>('search-count');
let searchQuery = '';
let hits: HTMLElement[] = [];
let hitIndex = -1;

function clearHits(): void {
  logEl.querySelectorAll('mark.hit').forEach((mark) => {
    const parent = mark.parentNode;
    mark.replaceWith(mark.textContent ?? '');
    parent?.normalize();
  });
  hits = [];
}

/** Wraps every case-insensitive occurrence in the log's text in a <mark>, in reading order. */
function markMatches(query: string): HTMLElement[] {
  const needle = query.toLowerCase();
  const walker = document.createTreeWalker(logEl, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  const found: HTMLElement[] = [];
  for (const node of nodes) {
    const text = node.data;
    const lower = text.toLowerCase();
    let at = lower.indexOf(needle);
    if (at < 0) continue;
    const frag = document.createDocumentFragment();
    let from = 0;
    while (at >= 0) {
      frag.append(text.slice(from, at));
      const mark = el('mark', 'hit', text.slice(at, at + needle.length));
      found.push(mark);
      frag.append(mark);
      from = at + needle.length;
      at = lower.indexOf(needle, from);
    }
    frag.append(text.slice(from));
    node.replaceWith(frag);
  }
  return found;
}

function showHit(scroll: boolean): void {
  hits.forEach((h, i) => h.classList.toggle('hit-current', i === hitIndex));
  searchCount.textContent = !searchQuery
    ? ''
    : hits.length
      ? `${hitIndex + 1}/${hits.length}`
      : '없음';
  const current = hits[hitIndex];
  if (!current || !scroll) return;
  const fold = current.closest('details');
  if (fold && !fold.open) fold.open = true;
  current.scrollIntoView({ block: 'center' });
}

/** Marks the log for the current query. A fresh search starts at the newest match; after a
 *  poll re-render (`keepPlace`) the same match number stays selected and the view stays put. */
function applySearch(keepPlace: boolean): void {
  clearHits();
  hits = searchQuery ? markMatches(searchQuery) : [];
  if (!keepPlace || hitIndex < 0) hitIndex = hits.length - 1;
  else hitIndex = Math.min(hitIndex, hits.length - 1);
  showHit(!keepPlace);
}

/** -1 goes up to older matches, +1 down to newer ones, wrapping around. */
function stepHit(delta: number): void {
  if (hits.length === 0) return;
  hitIndex = (hitIndex + delta + hits.length) % hits.length;
  showHit(true);
}

function openSearch(): void {
  searchBar.hidden = false;
  searchInput.focus();
  searchInput.select();
}

function closeSearch(): void {
  searchBar.hidden = true;
  searchQuery = '';
  clearHits();
  hitIndex = -1;
  searchCount.textContent = '';
}

searchInput.addEventListener('input', () => {
  searchQuery = searchInput.value.trim();
  applySearch(false);
});
searchInput.addEventListener('keydown', (ev) => {
  if (ev.isComposing) return;
  if (ev.key === 'Enter') {
    ev.preventDefault();
    stepHit(ev.shiftKey ? 1 : -1);
  } else if (ev.key === 'Escape') {
    // Handled here so Esc never reaches the document handler, which would stop the agent.
    ev.preventDefault();
    ev.stopPropagation();
    closeSearch();
  }
});
byId<HTMLButtonElement>('search-open').addEventListener('click', () =>
  searchBar.hidden ? openSearch() : closeSearch(),
);
byId<HTMLButtonElement>('search-prev').addEventListener('click', () => stepHit(-1));
byId<HTMLButtonElement>('search-next').addEventListener('click', () => stepHit(1));
byId<HTMLButtonElement>('search-close').addEventListener('click', closeSearch);

document.addEventListener('keydown', (ev) => {
  if (ev.isComposing) return;
  if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'f') {
    ev.preventDefault();
    openSearch();
    return;
  }
  if (ev.key === 'Escape') {
    if (!searchBar.hidden) closeSearch();
    else if (!suggestEl.hidden) hideSuggest();
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
  if (sessionId) {
    input.value = takeChatDraft(sessionId) ?? '';
    announceChatWindow(sessionId, () => input.value);
  }
  setTitle(
    creating ? (teamDraft ? `새 팀: ${teamDraft.team.name}` : '새 직원 부르기') : '불러오는 중…',
  );
  renderStatus();
  void loadUserName()
    .then(() => pollAgents())
    .then(() => pollConversation());
  window.setInterval(() => void pollAgents(), AGENTS_POLL_MS);
  window.setInterval(() => void pollConversation(), CONVERSATION_POLL_MS);
  reportSeen(token);
  input.focus();
}
