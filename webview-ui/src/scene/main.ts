/**
 * Bitteul scene view: an illustrated office where every live agent session sits at a desk.
 *
 * Everything that moves comes from the server's agent events. With no sessions running,
 * the monitors stay dark and the chairs stay empty.
 */

import type { ServerMessage } from '../../../core/src/messages.js';
import { transport } from '../transport/index.js';
import { Ambient, type AmbientData } from './ambient.js';
import { type AgentMeta, chatUrl, fetchJson, openChatWindow, postJson } from './api.js';
import {
  ALERT_BLINK_MS,
  BLINK_EVERY_MS,
  BLINK_MS,
  BOARD_PREVIEW_H,
  BOARD_PREVIEW_W,
  BUBBLE_ALERT_BG,
  BUBBLE_BG,
  BUBBLE_BORDER,
  BUBBLE_STAGGER,
  BUBBLE_TEXT,
  CARRY_SCALE,
  CODE_SCROLL_MS,
  COMPACT_MAX_WIDTH_PX,
  DRAG_SLOP_PX,
  DROP_FILL,
  FONT_BIG,
  FONT_BODY,
  FONT_BOLD,
  FONT_BUBBLE,
  FONT_SIGN,
  FONT_SMALL,
  FONT_TITLE,
  HIT_PAD,
  HOLO_EDGE,
  HOLO_FILL,
  HOLO_TEXT,
  LONG_PRESS_MS,
  POLL_FAILURES_BEFORE_TOAST,
  READ_FRAME_MS,
  ROOM_TIME_SHIFT_MS,
  SAME_TAB_CHAT_MEDIA,
  SCENE_PAGE_BG,
  SCREEN_ALERT_BG,
  SCREEN_ALERT_FG,
  SCREEN_ALERT_GLOW,
  SCREEN_CODE_COLORS,
  SCREEN_IDLE_BG,
  SCREEN_IDLE_FG,
  SCREEN_ON_BG,
  SCREEN_ON_GLOW,
  SCREEN_TITLE_BG,
  SCREEN_TITLE_FG,
  SEAT_ZONE_BELOW,
  SEAT_ZONE_PAD,
  SELECT_MARK,
  SIGN_BG,
  SIGN_EDGE,
  SIGN_H,
  SIGN_HINT,
  SIGN_MIN_W,
  SIGN_TEXT,
  SIGN_Y,
  TITLE_LINE_H,
  TITLE_LINES,
  TITLE_POLL_MS,
  TYPE_FRAME_MS,
  WALL_ACCENT,
  WALL_BG,
  WALL_GAUGE_FILL,
  WALL_GAUGE_TRACK,
  WALL_LABEL,
  WALL_TITLE,
  WALL_VALUE,
} from './constants.js';
import {
  ACTIVITY_LABEL,
  type Body,
  drawProps,
  type Floor,
  frameFor,
  newBody,
  stepBody,
} from './idle.js';
import { READING_TOOLS, toolLabel } from './labels.js';
import { dropMoves, planSeats, type SeatPlan } from './seating.js';

type Point = [number, number];

type Pose = 'back' | 'front';

interface Seat {
  screen: Point[];
  anchor_x: number;
  anchor_y: number;
}

interface SceneLayout {
  width: number;
  height: number;
  rooms: number;
  seats: Seat[];
  wall: { x0: number; y0: number; y1: number; x1: number; y2: number; y3: number };
  standing: Array<[number, number]>;
  floor: Floor;
  step_off_y: number;
  ambient: AmbientData;
}

type StaffFrames = Record<Pose, HTMLImageElement[][]>;
const STAFF_FRAMES = ['a', 'b', 'c', 'd', 'e', 'f'];

interface Board {
  title: string;
  countdown: { label: string; date: string } | null;
  salary: { thisMonth: number; target: number } | null;
}

const DEFAULT_BOARD: Board = { title: '빛뜰 데스크', countdown: null, salary: null };

interface Tool {
  name?: string;
  status: string;
}

interface Agent {
  id: number;
  palette: number;
  tools: Map<string, Tool>;
  lastToolId: string | null;
  /** Starts true: a session the server has not seen working yet is shown resting. */
  turnDone: boolean;
  permission: boolean;
}

const STAFF_VARIANTS = 6;
const POSES: Pose[] = ['back', 'front'];

const agents = new Map<number, Agent>();
const bodies = new Map<number, Body>();
const metas = new Map<number, AgentMeta>();

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`[Scene] failed to load ${src}`));
    img.src = src;
  });
}

async function loadJson<T>(src: string): Promise<T> {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`[Scene] ${src} -> ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/** The wall board comes from the user's desk profile; a broken profile falls back to defaults. */
async function loadBoard(): Promise<Board> {
  try {
    return (await loadJson<{ board: Board }>('./api/scene/profile')).board;
  } catch (err) {
    console.error('[Scene] desk profile failed', err);
    showToast(`벽 게시판 설정을 읽지 못해 기본값으로 보여요. ${String(err)}`);
    return DEFAULT_BOARD;
  }
}

function ensureAgent(id: number, palette = 0): Agent {
  let a = agents.get(id);
  if (!a) {
    a = { id, palette, tools: new Map(), lastToolId: null, turnDone: true, permission: false };
    agents.set(id, a);
  }
  return a;
}

/** Whether the server adopts sessions from every project folder, as last reported. */
let watchAll: boolean | null = null;
/** Only a tokened (privileged) viewer gets the folder-scope toggle. */
let scopeEnabled = false;

function renderScope(): void {
  const btn = document.getElementById('scope');
  if (!btn) return;
  btn.hidden = !scopeEnabled || watchAll === null;
  btn.textContent = watchAll ? '모든 폴더 보는 중' : '이 폴더만 보는 중';
  btn.dataset.on = String(watchAll === true);
}

function toggleScope(): void {
  if (watchAll === null) return;
  watchAll = !watchAll;
  transport.send({ type: 'setWatchAllSessions', enabled: watchAll });
  renderScope();
  showToast(
    watchAll
      ? '다른 폴더의 세션도 불러와요. 최근 10분 안에 움직인 세션이 몇 초 안에 나타나요.'
      : '이제 이 폴더의 새 세션만 불러와요.',
  );
}

function handle(msg: ServerMessage): void {
  switch (msg.type) {
    case 'settingsLoaded':
      watchAll = msg.watchAllSessions;
      renderScope();
      break;
    case 'existingAgents':
      for (const id of msg.agents) ensureAgent(id, msg.agentMeta[String(id)]?.palette ?? 0);
      break;
    case 'agentCreated':
      ensureAgent(msg.id, msg.palette ?? 0);
      break;
    case 'agentClosed':
      agents.delete(msg.id);
      bodies.delete(msg.id);
      break;
    case 'agentStatus': {
      const a = ensureAgent(msg.id);
      a.turnDone = msg.status === 'waiting';
      if (msg.status === 'active') a.turnDone = false;
      break;
    }
    case 'agentToolStart': {
      const a = ensureAgent(msg.id);
      a.tools.set(msg.toolId, { name: msg.toolName, status: msg.status });
      a.lastToolId = msg.toolId;
      a.turnDone = false;
      if (msg.permissionActive) a.permission = true;
      break;
    }
    case 'agentToolDone':
      agents.get(msg.id)?.tools.delete(msg.toolId);
      break;
    case 'agentToolsClear': {
      const a = agents.get(msg.id);
      if (a) {
        a.tools.clear();
        a.permission = false;
      }
      break;
    }
    case 'agentToolPermission':
      ensureAgent(msg.id).permission = true;
      break;
    case 'agentToolPermissionClear':
      ensureAgent(msg.id).permission = false;
      break;
    default:
      break;
  }
}

function currentTool(a: Agent): Tool | null {
  if (a.lastToolId && a.tools.has(a.lastToolId)) return a.tools.get(a.lastToolId) ?? null;
  const last = [...a.tools.values()].pop();
  return last ?? null;
}

type Mood = 'working' | 'alert' | 'resting';

function moodOf(a: Agent): Mood {
  if (a.permission || (metas.get(a.id)?.pending.length ?? 0) > 0) return 'alert';
  // A dashboard turn counts as working between tools too, where hooks report nothing.
  if (a.tools.size > 0 || !a.turnDone || metas.get(a.id)?.busy) return 'working';
  return 'resting';
}

function labelOf(a: Agent): string {
  const mood = moodOf(a);
  if (mood === 'alert') return '승인 기다리는 중';
  if (mood === 'resting') return '보고 끝, 대기 중';
  const tool = currentTool(a);
  return tool ? toolLabel(tool.name, tool.status) : '생각하는 중';
}

function screenPath(ctx: CanvasRenderingContext2D, poly: Point[]): void {
  ctx.beginPath();
  poly.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
}

function drawScreen(
  ctx: CanvasRenderingContext2D,
  poly: Point[],
  a: Agent | undefined,
  t: number,
  title: string | undefined,
): void {
  if (!a) return;
  const xs = poly.map(([x]) => x);
  const ys = poly.map(([, y]) => y);
  const r = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  const w = r.x1 - r.x0 + 1;
  const h = r.y1 - r.y0 + 1;
  const mood = moodOf(a);
  const bg =
    mood === 'alert' ? SCREEN_ALERT_BG : mood === 'resting' ? SCREEN_IDLE_BG : SCREEN_ON_BG;
  ctx.save();
  if (mood !== 'resting') {
    ctx.shadowColor = mood === 'alert' ? SCREEN_ALERT_GLOW : SCREEN_ON_GLOW;
    ctx.shadowBlur = 24;
  }
  screenPath(ctx, poly);
  ctx.fillStyle = bg;
  ctx.fill();
  ctx.shadowBlur = 0;
  screenPath(ctx, poly);
  ctx.clip();
  if (mood === 'alert') {
    if (Math.floor(t / ALERT_BLINK_MS) % 2 === 0) {
      ctx.fillStyle = SCREEN_ALERT_FG;
      ctx.font = FONT_BIG;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('!', r.x0 + w / 2, r.y0 + h / 2);
    }
  } else if (mood === 'resting') {
    ctx.fillStyle = SCREEN_IDLE_FG;
    ctx.fillRect(r.x0 + w / 2 - 6, r.y0 + h / 2 - 1, 12, 3);
  } else {
    const step = Math.floor(t / CODE_SCROLL_MS) + a.id * 7;
    const lineH = 6;
    for (let i = 0; i * lineH + 8 < h; i++) {
      const seed = (step + i) * 2654435761;
      const indent = ((seed >>> 3) % 4) * 6;
      const len = 14 + ((seed >>> 7) % Math.max(1, w - 40));
      ctx.fillStyle = SCREEN_CODE_COLORS[(seed >>> 11) % SCREEN_CODE_COLORS.length];
      const lineW = Math.min(len, w - 14 - indent);
      if (lineW > 0) ctx.fillRect(r.x0 + 6 + indent, r.y0 + 6 + i * lineH, lineW, 3);
    }
  }
  if (title) drawScreenTitle(ctx, r, title);
  ctx.restore();
}

function wrapLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxW: number,
  maxLines: number,
): string[] {
  const lines: string[] = [];
  let line = '';
  for (const ch of text) {
    if (ctx.measureText(line + ch).width > maxW) {
      lines.push(line);
      line = ch.trim() ? ch : '';
      if (lines.length === maxLines) break;
    } else {
      line += ch;
    }
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines && lines.join('').length < [...text].length) {
    const lastLine = lines[maxLines - 1];
    lines[maxLines - 1] = `${lastLine.slice(0, Math.max(0, lastLine.length - 1))}…`;
  }
  return lines;
}

function drawScreenTitle(
  ctx: CanvasRenderingContext2D,
  r: { x0: number; y0: number; x1: number; y1: number },
  title: string,
): void {
  const pad = 6;
  ctx.font = FONT_TITLE;
  const lines = wrapLines(ctx, title, r.x1 - r.x0 - pad * 2, TITLE_LINES);
  const stripH = lines.length * TITLE_LINE_H + pad;
  ctx.fillStyle = SCREEN_TITLE_BG;
  ctx.fillRect(r.x0, r.y1 - stripH, r.x1 - r.x0 + 1, stripH + 1);
  ctx.fillStyle = SCREEN_TITLE_FG;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  lines.forEach((line, i) =>
    ctx.fillText(line, r.x0 + pad, r.y1 - stripH + pad / 2 + i * TITLE_LINE_H),
  );
}

interface HitBox {
  id: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function drawHologram(ctx: CanvasRenderingContext2D, x: number, y: number, t: number): void {
  const w = 34;
  const h = 26;
  ctx.save();
  ctx.fillStyle = HOLO_FILL;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = HOLO_EDGE;
  ctx.fillRect(x, y, w, 2);
  ctx.fillRect(x, y + h - 2, w, 2);
  ctx.fillRect(x, y, 2, h);
  ctx.fillRect(x + w - 2, y, 2, h);
  const page = Math.floor(t / READ_FRAME_MS);
  ctx.fillStyle = HOLO_TEXT;
  for (let i = 0; i < 4; i++) {
    const len = 22 - ((page + i) % 3) * 5;
    ctx.fillRect(x + 5, y + 5 + i * 5, len, 2);
  }
  ctx.restore();
}

function drawStaff(
  ctx: CanvasRenderingContext2D,
  a: Agent,
  staff: StaffFrames,
  pose: Pose,
  ax: number,
  ay: number,
  t: number,
): number {
  const frames = staff[pose][a.palette % STAFF_VARIANTS];
  const mood = moodOf(a);
  const tool = currentTool(a);
  const reading = mood === 'working' && !!tool?.name && READING_TOOLS.has(tool.name);
  const typing = mood === 'working' && !reading && pose === 'back';
  const blinking = pose === 'front' && (t + a.id * 1337) % BLINK_EVERY_MS < BLINK_MS;
  const frame = blinking ? 2 : typing && Math.floor(t / TYPE_FRAME_MS) % 2 === 1 ? 1 : 0;
  const img = frames[frame];
  const x = Math.round(ax - img.width / 2);
  const y = Math.round(ay - img.height);
  ctx.drawImage(img, x, y);
  if (reading) drawHologram(ctx, ax - 17, y - 34, t);
  return y;
}

function drawOffDuty(
  ctx: CanvasRenderingContext2D,
  a: Agent,
  b: Body,
  staff: StaffFrames,
  t: number,
): number {
  const { frame, lift } = frameFor(b, t, a.id);
  const img = staff.front[a.palette % STAFF_VARIANTS][frame];
  const x = Math.round(b.x - img.width / 2);
  const y = Math.round(b.y - img.height - lift);
  ctx.drawImage(img, x, y);
  drawProps(ctx, b, x, y, img.width, t);
  return y;
}

function ctxScale(ctx: CanvasRenderingContext2D): number {
  return ctx.getTransform().a || 1;
}

function drawBubble(
  ctx: CanvasRenderingContext2D,
  cx: number,
  bottom: number,
  text: string,
  alert: boolean,
): void {
  ctx.save();
  ctx.font = FONT_BUBBLE;
  const padX = 12;
  const width = Math.ceil(ctx.measureText(text).width) + padX * 2;
  const height = 38;
  const x = Math.round(
    Math.min(Math.max(cx - width / 2, 8), ctx.canvas.width / ctxScale(ctx) - width - 8),
  );
  const y = Math.round(bottom - height - 10);
  ctx.fillStyle = alert ? BUBBLE_ALERT_BG : BUBBLE_BG;
  ctx.fillRect(x, y, width, height);
  ctx.fillStyle = BUBBLE_BORDER;
  ctx.fillRect(x, y - 3, width, 3);
  ctx.fillRect(x, y + height, width, 3);
  ctx.fillRect(x - 3, y, 3, height);
  ctx.fillRect(x + width, y, 3, height);
  ctx.fillRect(Math.round(cx) - 3, y + height + 3, 6, 6);
  ctx.fillStyle = BUBBLE_TEXT;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + padX, y + height / 2 + 1);
  ctx.restore();
}

function daysUntil(deadline: string): number {
  const end = new Date(`${deadline}T23:59:59`);
  const now = new Date();
  return Math.max(0, Math.ceil((end.getTime() - now.getTime()) / 86_400_000));
}

function won(n: number): string {
  return `${n.toLocaleString('ko-KR')}원`;
}

function drawWallContent(board: Board, working: number, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('[Scene] 2d context unavailable');
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = WALL_BG;
  ctx.fillRect(0, 0, w, h);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const mid = w / 2;
  ctx.fillStyle = WALL_TITLE;
  ctx.font = FONT_BOLD;
  ctx.fillText(board.title, mid, 12);
  let y = 44;
  if (board.countdown) {
    ctx.fillStyle = WALL_LABEL;
    ctx.font = FONT_SMALL;
    ctx.fillText(board.countdown.label, mid, y);
    ctx.fillStyle = WALL_ACCENT;
    ctx.font = FONT_BIG;
    ctx.fillText(`D-${daysUntil(board.countdown.date)}`, mid, y + 14);
    y += 60;
  }
  if (board.salary) {
    ctx.fillStyle = WALL_LABEL;
    ctx.font = FONT_SMALL;
    ctx.fillText('이번 달 월급', mid, y);
    ctx.fillStyle = WALL_VALUE;
    ctx.font = FONT_BOLD;
    ctx.fillText(won(board.salary.thisMonth), mid, y + 14);
    const barW = w - 16;
    const ratio = Math.min(1, board.salary.thisMonth / board.salary.target);
    ctx.fillStyle = WALL_GAUGE_TRACK;
    ctx.fillRect(8, y + 34, barW, 8);
    ctx.fillStyle = WALL_GAUGE_FILL;
    ctx.fillRect(8, y + 34, Math.round(barW * ratio), 8);
    ctx.fillStyle = WALL_LABEL;
    ctx.font = FONT_SMALL;
    ctx.fillText(`목표 ${won(board.salary.target)}`, mid, y + 48);
    y += 84;
  }
  ctx.fillStyle = WALL_LABEL;
  ctx.font = FONT_SMALL;
  ctx.fillText('근무 중인 직원', mid, y);
  ctx.fillStyle = WALL_VALUE;
  ctx.font = FONT_BODY;
  ctx.fillText(`${working}명 (AI)`, mid, y + 14);
  return c;
}

function drawWall(
  ctx: CanvasRenderingContext2D,
  layout: SceneLayout,
  board: Board,
  working: number,
): void {
  const q = layout.wall;
  const w = q.x1 - q.x0 + 1;
  const h = q.y1 - q.y0 + 1;
  const content = drawWallContent(board, working, w, h);
  for (let i = 0; i < w; i++) {
    const t = i / (w - 1);
    const top = q.y0 + (q.y2 - q.y0) * t;
    const bottom = q.y1 + (q.y3 - q.y1) * t;
    ctx.drawImage(content, i, 0, 1, h, q.x0 + i, top, 1, bottom - top);
  }
}

function drawSign(
  ctx: CanvasRenderingContext2D,
  roomW: number,
  title: string | undefined,
  editable: boolean,
): { x0: number; y0: number; x1: number; y1: number } | null {
  if (!title && !editable) return null;
  ctx.save();
  ctx.font = FONT_SIGN;
  const text = title ?? '+ 방 이름 쓰기';
  const w = Math.min(roomW - 120, Math.max(SIGN_MIN_W, ctx.measureText(text).width + 48));
  const x0 = Math.round((roomW - w) / 2);
  const y0 = SIGN_Y;
  if (title) {
    ctx.fillStyle = SIGN_EDGE;
    ctx.fillRect(x0 - 4, y0 - 4, w + 8, SIGN_H + 8);
    ctx.fillStyle = SIGN_BG;
    ctx.fillRect(x0, y0, w, SIGN_H);
    ctx.fillStyle = SIGN_TEXT;
  } else {
    ctx.strokeStyle = SIGN_HINT;
    ctx.setLineDash([8, 6]);
    ctx.lineWidth = 3;
    ctx.strokeRect(x0, y0, w, SIGN_H);
    ctx.fillStyle = SIGN_HINT;
  }
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, roomW / 2, y0 + SIGN_H / 2 + 1, w - 24);
  ctx.restore();
  return { x0, y0, x1: x0 + w, y1: y0 + SIGN_H };
}

function drawDropTarget(ctx: CanvasRenderingContext2D, zone: HitBox): void {
  ctx.save();
  ctx.fillStyle = DROP_FILL;
  ctx.fillRect(zone.x0, zone.y0, zone.x1 - zone.x0, zone.y1 - zone.y0);
  ctx.strokeStyle = SELECT_MARK;
  ctx.lineWidth = 6;
  ctx.setLineDash([14, 8]);
  ctx.strokeRect(zone.x0, zone.y0, zone.x1 - zone.x0, zone.y1 - zone.y0);
  ctx.restore();
}

function drawCarried(
  ctx: CanvasRenderingContext2D,
  a: Agent,
  staff: StaffFrames,
  x: number,
  y: number,
  t: number,
): void {
  const frames = staff.front[a.palette % STAFF_VARIANTS];
  const img = frames[Math.floor(t / 140) % 2 ? 1 : 3];
  const w = img.width * CARRY_SCALE;
  const h = img.height * CARRY_SCALE;
  ctx.save();
  ctx.globalAlpha = 0.92;
  ctx.drawImage(img, Math.round(x - w / 2), Math.round(y - h * 0.6), w, h);
  ctx.restore();
}

function showToast(message: string, link?: { href: string; label: string }): void {
  const toast = document.getElementById('toast');
  if (!toast) return;
  delete toast.dataset.kind;
  toast.replaceChildren(message);
  if (link) {
    const a = document.createElement('a');
    a.href = link.href;
    a.target = '_blank';
    a.rel = 'opener';
    a.textContent = link.label;
    a.addEventListener('click', () => (toast.hidden = true));
    toast.append(' ', a);
  }
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '닫기';
  close.addEventListener('click', () => (toast.hidden = true));
  toast.append(' ', close);
  toast.hidden = false;
}

interface PhoneLinkInfo {
  links: Array<{
    url: string;
    kind: 'tailscale-https' | 'tailscale' | 'lan' | 'virtual';
    where: string;
  }>;
  qr: string | null;
}

const PAIR_WHERE: Record<PhoneLinkInfo['links'][number]['kind'], string> = {
  'tailscale-https': 'Tailscale 주소라 밖에서도 열려요.',
  tailscale: 'Tailscale 주소라 밖에서도 열려요.',
  lan: '같은 Wi-Fi에서만 열려요. 밖에서도 쓰려면 PC와 폰에 Tailscale을 설치하고 서버를 다시 켜세요.',
  virtual: '가상 네트워크 주소라 폰에서 안 열릴 수 있어요.',
};

/** Show the QR a phone scans once; after that the phone opens the office from its home screen. */
async function showPairing(token: string): Promise<void> {
  const modal = document.getElementById('pair-modal');
  const img = document.getElementById('pair-qr') as HTMLImageElement | null;
  const text = document.getElementById('pair-text');
  const where = document.getElementById('pair-where');
  if (!modal || !img || !text || !where) return;
  let info: PhoneLinkInfo;
  try {
    info = await fetchJson<PhoneLinkInfo>('./api/dashboard/phone-link', token);
  } catch (err) {
    showToast(`폰 연결 정보를 불러오지 못했어요: ${String(err)}`);
    return;
  }
  const first = info.links[0];
  if (first && info.qr) {
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(info.qr)}`;
    img.hidden = false;
    text.textContent =
      '폰 카메라로 찍어서 열고, 브라우저 메뉴에서 "홈 화면에 추가"를 눌러 두세요. 그다음부턴 PC가 켜져 있으면 아이콘만 누르면 돼요.';
    where.textContent = PAIR_WHERE[first.kind];
  } else {
    img.hidden = true;
    text.textContent =
      '지금은 폰 모드로 켜져 있지 않아요. 터미널에서 bitteul-desk --phone 으로 다시 켜면 여기에 QR이 떠요.';
    where.textContent = '';
  }
  modal.hidden = false;
}

function hidePairing(): void {
  const modal = document.getElementById('pair-modal');
  if (modal) modal.hidden = true;
}

function openChat(token: string, sessionId: string | null, seat?: number): void {
  if (window.matchMedia(SAME_TAB_CHAT_MEDIA).matches) {
    window.location.assign(chatUrl(token, sessionId, seat));
    return;
  }
  const result = openChatWindow(token, sessionId, seat);
  if (result === 'focused') {
    showToast('이 직원의 대화 창은 이미 열려 있어요. 그 창을 앞으로 가져왔어요.');
    return;
  }
  if (result === 'opened') return;
  showToast('브라우저가 대화 창(팝업)을 막았어요.', {
    href: chatUrl(token, sessionId, seat),
    label: '여기를 눌러 열기',
  });
}

async function start(): Promise<void> {
  document.body.style.background = SCENE_PAGE_BG;
  const [layout, loadedBoard, bg, front] = await Promise.all([
    loadJson<SceneLayout>('./scene/scene.json'),
    loadBoard(),
    loadImage('./scene/background.png'),
    loadImage('./scene/front.png'),
    document.fonts.load(FONT_BODY),
    document.fonts.load(FONT_SMALL),
    document.fonts.load(FONT_BOLD),
  ]);
  const staff = Object.fromEntries(
    await Promise.all(
      POSES.map(async (pose) => [
        pose,
        await Promise.all(
          Array.from({ length: STAFF_VARIANTS }, (_, i) =>
            Promise.all(STAFF_FRAMES.map((f) => loadImage(`./scene/staff/${pose}_${i}_${f}.png`))),
          ),
        ),
      ]),
    ),
  ) as StaffFrames;
  const [sky, clouds, beams, ...plantImgs] = await Promise.all([
    loadImage('./scene/sky.png'),
    loadImage('./scene/clouds.png'),
    loadImage('./scene/beams.png'),
    ...layout.ambient.plants.map((p) => loadImage(`./scene/${p.file}`)),
  ]);
  const ambient = new Ambient(layout.ambient, {
    sky,
    clouds,
    beams,
    plants: new Map(layout.ambient.plants.map((p, i) => [p.file, plantImgs[i]])),
  });

  const canvas = document.getElementById('scene') as HTMLCanvasElement | null;
  if (!canvas) throw new Error('[Scene] #scene canvas missing');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('[Scene] 2d context unavailable');

  let board = loadedBoard;
  const roomW = layout.width;
  const roomH = layout.height;
  const perRoom = layout.seats.length;
  const perFloor = perRoom * layout.rooms;
  let floors = 1;
  let cols = layout.rooms;
  let sceneW = roomW * cols;
  let sceneH = roomH;

  function fit(): void {
    if (!canvas) return;
    const compact = window.innerWidth < COMPACT_MAX_WIDTH_PX;
    cols = compact ? 1 : layout.rooms;
    sceneW = roomW * cols;
    sceneH = roomH * ((floors * layout.rooms) / cols);
    const scale = compact
      ? window.innerWidth / sceneW
      : Math.min(window.innerWidth / sceneW, window.innerHeight / roomH);
    const factor = Math.max(1, Math.round(scale * window.devicePixelRatio));
    canvas.width = sceneW * factor;
    canvas.height = sceneH * factor;
    canvas.style.width = `${Math.floor(sceneW * scale)}px`;
    canvas.style.height = `${Math.floor(sceneH * scale)}px`;
  }
  fit();
  window.addEventListener('resize', fit);

  transport.onMessage(handle);
  transport.send({ type: 'webviewReady' });

  let hitBoxes: HitBox[] = [];
  let seatZones: HitBox[] = [];
  /** Monitors of desks nobody sits at; the hire button appears over them. */
  let emptyDesks: HitBox[] = [];
  let signZones: HitBox[] = [];
  let plan: SeatPlan = planSeats([], new Map(), perFloor);
  const storedSeats = new Map<number, number>();
  const roomTitles = new Map<number, string>();
  const lastSeat = new Map<number, number>();
  const token = new URLSearchParams(window.location.search).get('token');
  const hire = document.getElementById('hire');

  const pollScene = async (): Promise<void> => {
    try {
      const data = await loadJson<{ seats: Record<string, number>; rooms: Record<string, string> }>(
        './api/scene/state',
      );
      storedSeats.clear();
      Object.entries(data.seats).forEach(([id, seat]) => storedSeats.set(Number(id), seat));
      roomTitles.clear();
      Object.entries(data.rooms).forEach(([room, title]) => roomTitles.set(Number(room), title));
    } catch (err) {
      console.error('[Scene] scene state poll failed', err);
    }
  };
  void pollScene();
  window.setInterval(() => void pollScene(), TITLE_POLL_MS);

  if (token) {
    let pollFailures = 0;
    const pollAgents = async (): Promise<void> => {
      try {
        const data = await fetchJson<{ canReply: boolean; agents: AgentMeta[] }>(
          './api/dashboard/agents',
          token,
        );
        metas.clear();
        data.agents.forEach((m) => metas.set(m.id, m));
        if (hire) hire.hidden = !data.canReply;
        pollFailures = 0;
        // Connection is back: take down the "can't reach the server" notice on its own.
        const toast = document.getElementById('toast');
        if (toast?.dataset.kind === 'connection') {
          toast.hidden = true;
          delete toast.dataset.kind;
        }
      } catch (err) {
        console.error('[Scene] dashboard poll failed', err);
        pollFailures += 1;
        const badToken = String(err).includes('401');
        // A single miss is usually a server restart; only a streak is worth telling about.
        if (!badToken && pollFailures < POLL_FAILURES_BEFORE_TOAST) return;
        showToast(
          badToken
            ? '대시보드 주소의 토큰이 맞지 않아요. 서버를 다시 켜면 주소가 바뀝니다. 서버가 새로 알려 준 주소로 열어 주세요.'
            : '서버에 연결하지 못했어요. 서버가 꺼졌거나 다시 켜지는 중이에요. 연결되면 이 안내는 저절로 사라져요.',
        );
        const toast = document.getElementById('toast');
        if (toast && !badToken) toast.dataset.kind = 'connection';
      }
    };
    void pollAgents();
    window.setInterval(() => void pollAgents(), TITLE_POLL_MS);
    hire?.addEventListener('click', () => openChat(token, null));
    scopeEnabled = true;
    renderScope();
    document.getElementById('scope')?.addEventListener('click', toggleScope);
    const pair = document.getElementById('pair');
    if (pair) {
      pair.hidden = window.matchMedia(SAME_TAB_CHAT_MEDIA).matches;
      pair.addEventListener('click', () => void showPairing(token));
    }
    document.getElementById('pair-close')?.addEventListener('click', hidePairing);
    document.getElementById('pair-modal')?.addEventListener('click', (ev) => {
      if (ev.target === ev.currentTarget) hidePairing();
    });
    window.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') hidePairing();
    });
  }

  // ── Wall board: click to read it large, and (with the token) edit it ──
  const wallQ = layout.wall;
  /** The board hangs in the first room, which always sits at the scene origin. */
  const wallZone: HitBox = {
    id: 0,
    x0: wallQ.x0,
    y0: Math.min(wallQ.y0, wallQ.y2),
    x1: wallQ.x1,
    y1: Math.max(wallQ.y1, wallQ.y3),
  };
  const boardModal = document.getElementById('board-modal');
  const boardForm = document.getElementById('board-form') as HTMLFormElement | null;
  const boardPreview = document.getElementById('board-preview') as HTMLCanvasElement | null;
  const boardError = document.getElementById('board-error');
  const workingNow = (): number =>
    [...agents.values()].filter((a) => moodOf(a) !== 'resting').length;
  const field = (name: string): HTMLInputElement | null =>
    boardForm?.elements.namedItem(name) as HTMLInputElement | null;

  const draftBoard = (): Board => {
    const title = field('boardTitle')?.value.trim() || DEFAULT_BOARD.title;
    const date = field('countdownDate')?.value ?? '';
    const label = field('countdownLabel')?.value.trim() || '마감까지';
    const target = Number(field('salaryTarget')?.value || 0);
    const thisMonth = Number(field('salaryThisMonth')?.value || 0);
    return {
      title,
      countdown: date ? { label, date } : null,
      salary: target > 0 ? { thisMonth, target } : null,
    };
  };

  const renderBoardPreview = (shown: Board): void => {
    if (!boardPreview) return;
    const scale = Math.max(
      2,
      Math.floor(Math.min(window.innerHeight * 0.7, 640) / BOARD_PREVIEW_H),
    );
    boardPreview.width = BOARD_PREVIEW_W;
    boardPreview.height = BOARD_PREVIEW_H;
    boardPreview.style.width = `${BOARD_PREVIEW_W * scale}px`;
    boardPreview.style.height = `${BOARD_PREVIEW_H * scale}px`;
    boardPreview
      .getContext('2d')
      ?.drawImage(drawWallContent(shown, workingNow(), BOARD_PREVIEW_W, BOARD_PREVIEW_H), 0, 0);
  };

  const openBoard = (): void => {
    if (!boardModal) return;
    const set = (name: string, value: string): void => {
      const input = field(name);
      if (input) input.value = value;
    };
    set('boardTitle', board.title === DEFAULT_BOARD.title ? '' : board.title);
    set('countdownLabel', board.countdown?.label ?? '');
    set('countdownDate', board.countdown?.date ?? '');
    set('salaryThisMonth', board.salary ? String(board.salary.thisMonth) : '');
    set('salaryTarget', board.salary ? String(board.salary.target) : '');
    if (boardError) boardError.textContent = '';
    if (boardForm) boardForm.hidden = !token;
    const readonly = document.getElementById('board-readonly');
    if (readonly) readonly.hidden = !!token;
    renderBoardPreview(board);
    boardModal.hidden = false;
  };
  const closeBoard = (): void => {
    if (boardModal) boardModal.hidden = true;
  };

  boardForm?.addEventListener('input', () => renderBoardPreview(draftBoard()));
  boardForm?.addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (!token) return;
    const text = (name: string): string | null => field(name)?.value.trim() || null;
    const amount = (name: string): number | null => {
      const raw = field(name)?.value ?? '';
      return raw === '' ? null : Number(raw);
    };
    const patch = {
      boardTitle: text('boardTitle'),
      countdownLabel: text('countdownLabel'),
      countdownDate: text('countdownDate'),
      salaryThisMonth: amount('salaryThisMonth'),
      salaryTarget: amount('salaryTarget'),
    };
    postJson<{ board: Board }>('./api/dashboard/profile/board', token, patch)
      .then((saved) => {
        board = saved.board;
        closeBoard();
        showToast('벽 게시판을 고쳤어요.');
      })
      .catch((err: unknown) => {
        if (boardError) boardError.textContent = `저장하지 못했어요: ${String(err)}`;
      });
  });
  document.getElementById('board-close')?.addEventListener('click', closeBoard);
  boardModal?.addEventListener('click', (ev) => {
    if (ev.target === ev.currentTarget) closeBoard();
  });
  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') closeBoard();
  });

  const toScene = (ev: { clientX: number; clientY: number }): [number, number] => {
    const rect = canvas.getBoundingClientRect();
    return [
      ((ev.clientX - rect.left) / rect.width) * sceneW,
      ((ev.clientY - rect.top) / rect.height) * sceneH,
    ];
  };
  const inside = (boxes: HitBox[], x: number, y: number): HitBox | undefined =>
    [...boxes].reverse().find((h) => x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1);

  const deskHire = document.getElementById('desk-hire');
  let deskHireSeat: number | null = null;
  /** Hiring needs the token and a server that can start sessions (the toolbar button shows it). */
  const canHire = (): boolean => !!token && !!hire && !hire.hidden;
  const showDeskHire = (desk: HitBox): void => {
    if (!deskHire || !canHire()) return;
    const rect = canvas.getBoundingClientRect();
    const sx = rect.width / sceneW;
    const sy = rect.height / sceneH;
    deskHire.style.left = `${window.scrollX + rect.left + ((desk.x0 + desk.x1) / 2) * sx}px`;
    deskHire.style.top = `${window.scrollY + rect.top + ((desk.y0 + desk.y1) / 2) * sy}px`;
    deskHireSeat = desk.id;
    deskHire.hidden = false;
  };
  const hideDeskHire = (): void => {
    if (deskHire) deskHire.hidden = true;
    deskHireSeat = null;
  };
  deskHire?.addEventListener('click', () => {
    if (!token || deskHireSeat === null) return;
    const seat = deskHireSeat;
    hideDeskHire();
    openChat(token, null, seat);
  });
  canvas.addEventListener('pointerleave', (ev) => {
    if (ev.relatedTarget !== deskHire) hideDeskHire();
  });
  deskHire?.addEventListener('pointerleave', (ev) => {
    if (ev.relatedTarget !== canvas) hideDeskHire();
  });

  let press: { id: number; x: number; y: number; timer: number } | null = null;
  let drag: { id: number; x: number; y: number } | null = null;

  const editSign = (zone: HitBox): void => {
    if (!token) return;
    const rect = canvas.getBoundingClientRect();
    const sx = rect.width / sceneW;
    const sy = rect.height / sceneH;
    const input = document.createElement('input');
    input.className = 'sign-input';
    input.maxLength = 40;
    input.value = roomTitles.get(zone.id) ?? '';
    input.placeholder = '방 이름';
    input.style.left = `${window.scrollX + rect.left + zone.x0 * sx}px`;
    input.style.top = `${window.scrollY + rect.top + zone.y0 * sy}px`;
    input.style.width = `${(zone.x1 - zone.x0) * sx}px`;
    input.style.height = `${(zone.y1 - zone.y0) * sy}px`;
    let done = false;
    const finish = async (save: boolean): Promise<void> => {
      if (done) return;
      done = true;
      const title = input.value.trim();
      input.remove();
      if (!save || title === (roomTitles.get(zone.id) ?? '')) return;
      if (title) roomTitles.set(zone.id, title);
      else roomTitles.delete(zone.id);
      try {
        await postJson(`./api/dashboard/rooms/${zone.id}`, token, { title });
      } catch (err) {
        console.error('[Scene] room title save failed', err);
        void pollScene();
      }
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') void finish(true);
      if (ev.key === 'Escape') void finish(false);
    });
    input.addEventListener('blur', () => void finish(true));
    document.body.append(input);
    input.focus();
    input.select();
  };

  const drop = async (id: number, x: number, y: number): Promise<void> => {
    if (!token) return;
    const zone = inside(seatZones, x, y);
    if (!zone) return;
    const moves = dropMoves(id, zone.id, plan);
    if (!moves.length) return;
    moves.forEach((m) => storedSeats.set(m.agentId, m.seat));
    try {
      await postJson('./api/dashboard/seats', token, { moves });
    } catch (err) {
      console.error('[Scene] seat move failed', err);
      void pollScene();
    }
  };

  canvas.addEventListener('pointerdown', (ev) => {
    const [x, y] = toScene(ev);
    const hit = inside(hitBoxes, x, y);
    if (!hit || !token) return;
    canvas.setPointerCapture(ev.pointerId);
    press = {
      id: hit.id,
      x: ev.clientX,
      y: ev.clientY,
      timer: window.setTimeout(() => {
        if (!press) return;
        drag = { id: press.id, x, y };
        press = null;
      }, LONG_PRESS_MS),
    };
  });
  canvas.addEventListener('pointermove', (ev) => {
    const [x, y] = toScene(ev);
    if (drag) {
      drag.x = x;
      drag.y = y;
      canvas.style.cursor = 'grabbing';
      return;
    }
    if (press && Math.hypot(ev.clientX - press.x, ev.clientY - press.y) > DRAG_SLOP_PX) {
      window.clearTimeout(press.timer);
      // A mouse drags at once, as on any desktop. A finger moving early is a scroll, so touch
      // keeps the long press.
      if (ev.pointerType === 'mouse') {
        drag = { id: press.id, x, y };
        canvas.style.cursor = 'grabbing';
      }
      press = null;
      if (drag) return;
    }
    const pointable =
      inside(hitBoxes, x, y) || (token && inside(signZones, x, y)) || inside([wallZone], x, y);
    canvas.style.cursor = pointable ? 'pointer' : 'default';
    if (ev.pointerType === 'mouse') {
      const desk = inside(emptyDesks, x, y);
      if (desk) showDeskHire(desk);
      else hideDeskHire();
    }
  });
  canvas.addEventListener('pointerup', (ev) => {
    const [x, y] = toScene(ev);
    if (drag) {
      const { id } = drag;
      drag = null;
      void drop(id, x, y);
      return;
    }
    if (press) {
      window.clearTimeout(press.timer);
      const id = press.id;
      press = null;
      const sessionId = metas.get(id)?.sessionId;
      if (!token) return;
      if (sessionId) openChat(token, sessionId);
      else showToast('이 직원 정보를 아직 불러오지 못했어요. 2초쯤 뒤에 다시 눌러 주세요.');
      return;
    }
    if (inside([wallZone], x, y)) {
      openBoard();
      return;
    }
    // Touch has no hover: a tap on an empty monitor brings up the hire button there.
    const desk = ev.pointerType !== 'mouse' ? inside(emptyDesks, x, y) : undefined;
    if (desk) {
      showDeskHire(desk);
      return;
    }
    const sign = token ? inside(signZones, x, y) : undefined;
    if (sign) editSign(sign);
  });
  // Touch: once a long press has picked someone up, the finger drags them, not the page.
  canvas.addEventListener(
    'touchmove',
    (ev) => {
      if (drag) ev.preventDefault();
    },
    { passive: false },
  );
  canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
  canvas.addEventListener('pointercancel', () => {
    if (press) window.clearTimeout(press.timer);
    press = null;
    drag = null;
  });

  function frame(t: number): void {
    if (!ctx || !canvas) return;
    ctx.imageSmoothingEnabled = false;

    const ordered = [...agents.values()].sort((a, b) => a.id - b.id);
    plan = planSeats(
      ordered.map((a) => a.id),
      storedSeats,
      perFloor,
    );
    if (plan.floors !== floors) {
      floors = plan.floors;
      fit();
    }
    const factor = canvas.width / sceneW;
    const working = ordered.filter((a) => moodOf(a) !== 'resting').length;
    const bubbles: Array<[number, number, string, boolean]> = [];
    const hits: HitBox[] = [];
    const zones: HitBox[] = [];
    const empties: HitBox[] = [];
    const signs: HitBox[] = [];
    const halfW = staff.back[0][0].width / 2;
    let offsetX = 0;
    let offsetY = 0;
    const noteHit = (id: number, cx: number, top: number, bottom: number): void => {
      hits.push({
        id,
        x0: offsetX + cx - halfW - HIT_PAD,
        y0: offsetY + top - HIT_PAD,
        x1: offsetX + cx + halfW + HIT_PAD,
        y1: offsetY + bottom + HIT_PAD,
      });
    };

    for (const [id, seat] of plan.seatOf) {
      if (lastSeat.get(id) !== seat) bodies.delete(id);
      lastSeat.set(id, seat);
    }

    for (let floor = 0; floor < floors; floor++) {
      for (let room = 0; room < layout.rooms; room++) {
        const globalRoom = floor * layout.rooms + room;
        offsetX = (globalRoom % cols) * roomW;
        offsetY = Math.floor(globalRoom / cols) * roomH;
        const roomT = t + globalRoom * ROOM_TIME_SHIFT_MS;
        ctx.setTransform(factor, 0, 0, factor, offsetX * factor, offsetY * factor);
        ctx.drawImage(bg, 0, 0);
        ambient.drawBack(ctx, roomT);
        const walkers: Array<[Agent, Body]> = [];
        layout.seats.forEach((seat, desk) => {
          const seatNo = globalRoom * perRoom + desk;
          const id = plan.agentAt.get(seatNo);
          const a = id === undefined ? undefined : agents.get(id);
          const carried = !!a && drag?.id === a.id;
          const title = a ? (metas.get(a.id)?.title ?? undefined) : undefined;
          drawScreen(ctx, seat.screen, a, t, title);
          const xs = seat.screen.map(([x]) => x);
          const ys = seat.screen.map(([, y]) => y);
          const box = {
            x0: offsetX + Math.min(...xs) - SEAT_ZONE_PAD,
            y0: offsetY + Math.min(...ys),
            x1: offsetX + Math.max(...xs) + SEAT_ZONE_PAD,
            y1: offsetY + seat.anchor_y + SEAT_ZONE_BELOW,
          };
          zones.push({ id: seatNo, ...box });
          if (!a) {
            empties.push({
              id: seatNo,
              x0: offsetX + Math.min(...xs),
              y0: offsetY + Math.min(...ys),
              x1: offsetX + Math.max(...xs),
              y1: offsetY + Math.max(...ys),
            });
          }
          if (!a || carried) return;
          hits.push({ id: a.id, ...box, y1: offsetY + Math.max(...ys) });
          const home: [number, number] = [seat.anchor_x, layout.step_off_y];
          const b = bodies.get(a.id) ?? newBody(home, t);
          bodies.set(a.id, b);
          stepBody(b, moodOf(a) === 'resting', home, layout.floor, t);
          if (!b.home) {
            // Off duty: the desk still belongs to them, so a long press on it picks them up.
            hits.push({ id: a.id, ...box });
            walkers.push([a, b]);
            return;
          }
          const lift = desk % 2 === 1 ? BUBBLE_STAGGER : 0;
          const top = drawStaff(ctx, a, staff, 'back', seat.anchor_x, seat.anchor_y, t);
          noteHit(a.id, seat.anchor_x, top, seat.anchor_y);
          bubbles.push([
            offsetX + seat.anchor_x,
            offsetY + top - lift,
            labelOf(a),
            moodOf(a) === 'alert',
          ]);
        });
        ctx.drawImage(front, 0, 0);
        walkers
          .sort(([, p], [, q]) => p.y - q.y)
          .forEach(([a, b]) => {
            const top = drawOffDuty(ctx, a, b, staff, t);
            noteHit(a.id, b.x, top, b.y);
            bubbles.push([
              offsetX + b.x,
              offsetY + top,
              ACTIVITY_LABEL[b.activity],
              moodOf(a) === 'alert',
            ]);
          });
        ambient.drawFront(ctx, roomT);
        if (globalRoom === 0) drawWall(ctx, layout, board, working);
        const sign = drawSign(ctx, roomW, roomTitles.get(globalRoom), !!token);
        if (sign) {
          signs.push({
            id: globalRoom,
            x0: offsetX + sign.x0,
            y0: offsetY + sign.y0,
            x1: offsetX + sign.x1,
            y1: offsetY + sign.y1,
          });
        }
      }
    }

    ctx.setTransform(factor, 0, 0, factor, 0, 0);
    if (drag) {
      const target = inside(zones, drag.x, drag.y);
      if (target) drawDropTarget(ctx, target);
    }
    bubbles.forEach(([cx, bottom, text, alert]) => drawBubble(ctx, cx, bottom, text, alert));
    if (drag) {
      const a = agents.get(drag.id);
      if (a) drawCarried(ctx, a, staff, drag.x, drag.y, t);
    }
    hitBoxes = hits;
    seatZones = zones;
    emptyDesks = empties;
    signZones = signs;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

start().catch((err: unknown) => {
  console.error('[Scene]', err);
});
