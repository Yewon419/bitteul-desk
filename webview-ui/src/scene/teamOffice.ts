/**
 * The team office: one big room per team, drawn in code instead of a painted background.
 * The MD sits in a glass office at the top, members work at desks in two wings with their
 * names on the desk, and the user's desk at the bottom collects what the team is waiting on.
 */

import type { TeamStatus } from './api.js';
import {
  ALERT_BLINK_MS,
  BLINK_EVERY_MS,
  BLINK_MS,
  CODE_SCROLL_MS,
  FONT_BIG,
  FONT_BOARD_LABEL,
  FONT_BOARD_TITLE,
  FONT_BOARD_VALUE,
  FONT_PLATE,
  SCREEN_ALERT_BG,
  SCREEN_ALERT_FG,
  SCREEN_CODE_COLORS,
  SCREEN_IDLE_BG,
  SCREEN_IDLE_FG,
  SCREEN_ON_BG,
  TEAM_ROOM as C,
  TYPE_FRAME_MS,
  WALL_ACCENT,
  WALL_BG,
  WALL_GAUGE_FILL,
  WALL_GAUGE_TRACK,
  WALL_LABEL,
  WALL_TITLE,
  WALL_VALUE,
} from './constants.js';

export type DeskMood = 'working' | 'alert' | 'resting' | 'done' | 'failed';

export interface TeamSeat {
  label: string;
  mood: DeskMood;
  /** Bubble over the head; null keeps a quiet desk quiet. */
  says: string | null;
  palette: number;
  /** The chat a click opens; null when the person has no transcript yet. */
  sessionId: string | null;
}

export interface TeamOfficeView {
  team: TeamStatus;
  lead: TeamSeat;
  members: TeamSeat[];
  /** Approvals and questions the team is waiting on, piled on the user's desk. */
  pending: number;
}

export interface TeamTarget {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  sessionId: string | null;
}

export interface TeamBubble {
  cx: number;
  bottom: number;
  text: string;
  alert: boolean;
  /** Whose words these are, so the office can mark a chat that is already open. */
  sessionId: string | null;
}

/** Inner room, inside the frame; the sign hangs on the frame above it. */
const ROOM = { x0: 24, y0: 96, x1: 744, y1: 1320 };
const WALL_BOTTOM = 300;
const BOARD = { x0: 48, y0: 120, x1: 208, y1: 284 };
const WINDOW = { x0: 576, y0: 124, x1: 720, y1: 260 };
const GLASS = { x0: 232, y0: 110, x1: 536, y1: 420 };
const LEAD_DESK = { x0: 262, x1: 506, top: 300 };
/** Member desks: left wing, right wing; rows go down the room. */
const WING_X = [
  { x0: 44, x1: 304 },
  { x0: 464, x1: 724 },
];
const ROW_TOPS = [500, 695, 890, 1085];
const BOSS_DESK = { x0: 264, x1: 504, top: 1196 };
const RUG = { x0: 330, y0: 470, x1: 438, y1: 1170 };
const DESK_TOP_H = 22;
const DESK_FRONT_H = 54;
/** How far the character's feet sit below the desk top, hidden by the desk. */
const SIT_DEPTH = 30;
const MONITOR_W = 60;
const MONITOR_H = 44;
const FRAME_A = 0;
const FRAME_BOUNCE = 1;
const FRAME_BLINK = 2;
const FRAME_CHEER = 4;
const FRAME_SLEEPY = 5;

function box(
  ctx: CanvasRenderingContext2D,
  color: string,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

function outline(
  ctx: CanvasRenderingContext2D,
  color: string,
  x: number,
  y: number,
  w: number,
  h: number,
  t: number,
): void {
  box(ctx, color, x, y, w, t);
  box(ctx, color, x, y + h - t, w, t);
  box(ctx, color, x, y, t, h);
  box(ctx, color, x + w - t, y, t, h);
}

function drawShell(ctx: CanvasRenderingContext2D, roomW: number, roomH: number): void {
  box(ctx, C.frame, 0, 0, roomW, roomH);
  const w = ROOM.x1 - ROOM.x0;
  box(ctx, C.wall, ROOM.x0, ROOM.y0, w, WALL_BOTTOM - ROOM.y0);
  box(ctx, C.wallShade, ROOM.x0, WALL_BOTTOM - 14, w, 14);
  box(ctx, C.floor, ROOM.x0, WALL_BOTTOM, w, ROOM.y1 - WALL_BOTTOM);
  // Planks: a seam every row, joints staggered so the floor reads as boards.
  for (let y = WALL_BOTTOM + 6, row = 0; y < ROOM.y1; y += 32, row++) {
    box(ctx, C.floorSeam, ROOM.x0, y + 30, w, 2);
    box(ctx, C.floorLight, ROOM.x0, y, w, 2);
    for (let x = ROOM.x0 + ((row * 97) % 160); x < ROOM.x1; x += 160)
      box(ctx, C.floorSeam, x, y, 2, 30);
  }
  box(ctx, C.trim, ROOM.x0, WALL_BOTTOM, w, 6);
  outline(ctx, C.frameEdge, ROOM.x0 - 4, ROOM.y0 - 4, w + 8, ROOM.y1 - ROOM.y0 + 8, 4);
}

function drawWindow(ctx: CanvasRenderingContext2D, t: number): void {
  const { x0, y0, x1, y1 } = WINDOW;
  const w = x1 - x0;
  const h = y1 - y0;
  box(ctx, C.sky, x0, y0, w, h);
  box(ctx, C.skyLight, x0, y0 + h * 0.6, w, h * 0.4);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x0, y0, w, h);
  ctx.clip();
  const drift = Math.floor(t / 400) % (w + 80);
  for (const [dx, dy, s] of [
    [10, 30, 1],
    [90, 70, 0.7],
  ] as const) {
    const cx = x0 + ((dx + drift) % (w + 80)) - 40;
    const cy = y0 + dy;
    box(ctx, C.cloud, cx, cy, 48 * s, 12 * s);
    box(ctx, C.cloud, cx + 10 * s, cy - 10 * s, 24 * s, 10 * s);
  }
  ctx.restore();
  outline(ctx, C.windowFrame, x0 - 6, y0 - 6, w + 12, h + 12, 8);
  box(ctx, C.windowFrame, x0 + w / 2 - 3, y0, 6, h);
  box(ctx, C.windowFrame, x0, y0 + h / 2 - 3, w, 6);
}

function drawPlant(ctx: CanvasRenderingContext2D, cx: number, bottom: number): void {
  box(ctx, C.leafDark, cx - 26, bottom - 96, 20, 40);
  box(ctx, C.leaf, cx - 8, bottom - 112, 18, 56);
  box(ctx, C.leafDark, cx + 8, bottom - 92, 22, 36);
  box(ctx, C.leaf, cx - 20, bottom - 72, 40, 24);
  box(ctx, C.potEdge, cx - 26, bottom - 52, 52, 52);
  box(ctx, C.pot, cx - 22, bottom - 48, 44, 44);
}

function drawRug(ctx: CanvasRenderingContext2D): void {
  const { x0, y0, x1, y1 } = RUG;
  box(ctx, C.rugEdge, x0, y0, x1 - x0, y1 - y0);
  box(ctx, C.rug, x0 + 6, y0 + 6, x1 - x0 - 12, y1 - y0 - 12);
  const mid = (x0 + x1) / 2;
  for (let y = y0 + 30; y < y1 - 30; y += 44) {
    [4, 12, 20, 12, 4].forEach((w, i) => box(ctx, C.rugPattern, mid - w / 2, y - 10 + i * 4, w, 4));
  }
}

function boardState(team: TeamStatus): { text: string; warn: boolean } {
  if (team.ended) return { text: '끝남', warn: false };
  if (team.budgetStopped) return { text: '예산 소진', warn: true };
  if (team.plan === 'waiting') return { text: '계획 승인 대기', warn: true };
  if (team.plan === 'approved') return { text: '진행 중', warn: false };
  return { text: '계획 짜는 중', warn: false };
}

function drawBoard(ctx: CanvasRenderingContext2D, view: TeamOfficeView): void {
  const { x0, y0, x1, y1 } = BOARD;
  const w = x1 - x0;
  const team = view.team;
  box(ctx, C.frameEdge, x0 - 4, y0 - 4, w + 8, y1 - y0 + 8);
  box(ctx, WALL_BG, x0, y0, w, y1 - y0);
  const mid = x0 + w / 2;
  const maxW = w - 16;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = WALL_TITLE;
  ctx.font = FONT_BOARD_TITLE;
  ctx.fillText(team.name, mid, y0 + 10, maxW);
  const state = boardState(team);
  ctx.fillStyle = state.warn ? WALL_ACCENT : WALL_VALUE;
  ctx.font = FONT_BOARD_VALUE;
  ctx.fillText(state.text, mid, y0 + 38, maxW);
  ctx.fillStyle = WALL_LABEL;
  ctx.font = FONT_BOARD_LABEL;
  ctx.fillText('예산', mid, y0 + 70, maxW);
  ctx.fillStyle = WALL_VALUE;
  ctx.font = FONT_BOARD_VALUE;
  const budget = team.budgetUsd;
  ctx.fillText(
    budget ? `$${team.costUsd.toFixed(2)} / $${budget}` : `$${team.costUsd.toFixed(2)}`,
    mid,
    y0 + 88,
    maxW,
  );
  if (budget) {
    const ratio = Math.min(1, team.costUsd / budget);
    box(ctx, WALL_GAUGE_TRACK, x0 + 8, y0 + 112, maxW, 8);
    box(
      ctx,
      team.budgetStopped ? C.screenFailed : ratio >= 0.8 ? WALL_ACCENT : WALL_GAUGE_FILL,
      x0 + 8,
      y0 + 112,
      Math.round(maxW * ratio),
      8,
    );
  }
  const busy = [view.lead, ...view.members].filter((s) => s.mood === 'working').length;
  ctx.fillStyle = WALL_LABEL;
  ctx.font = FONT_BOARD_LABEL;
  ctx.fillText(`일하는 중 ${busy}/${view.members.length + 1}명`, mid, y0 + 134, maxW);
}

function drawMonitor(
  ctx: CanvasRenderingContext2D,
  x: number,
  deskTop: number,
  mood: DeskMood,
  t: number,
  seed: number,
): void {
  const y = deskTop - MONITOR_H - 10;
  box(ctx, C.monitorStand, x + MONITOR_W / 2 - 5, y + MONITOR_H, 10, 12);
  box(ctx, C.monitorStand, x + MONITOR_W / 2 - 14, deskTop - 2, 28, 4);
  box(ctx, C.monitor, x, y, MONITOR_W, MONITOR_H);
  const sx = x + 4;
  const sy = y + 4;
  const sw = MONITOR_W - 8;
  const sh = MONITOR_H - 8;
  const fill: Record<DeskMood, string> = {
    working: SCREEN_ON_BG,
    alert: SCREEN_ALERT_BG,
    resting: SCREEN_IDLE_BG,
    done: C.screenDone,
    failed: C.screenFailed,
  };
  box(ctx, fill[mood], sx, sy, sw, sh);
  if (mood === 'working') {
    const step = Math.floor(t / CODE_SCROLL_MS) + seed * 7;
    for (let i = 0; i * 6 + 4 < sh; i++) {
      const s = (step + i) * 2654435761;
      const indent = ((s >>> 3) % 3) * 4;
      const len = 10 + ((s >>> 7) % (sw - 18));
      box(
        ctx,
        SCREEN_CODE_COLORS[(s >>> 11) % SCREEN_CODE_COLORS.length],
        sx + 3 + indent,
        sy + 3 + i * 6,
        len,
        2,
      );
    }
  } else if (mood === 'alert') {
    if (Math.floor(t / ALERT_BLINK_MS) % 2 === 0) {
      ctx.fillStyle = SCREEN_ALERT_FG;
      ctx.font = FONT_BIG;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('!', sx + sw / 2, sy + sh / 2 + 1);
    }
  } else if (mood === 'resting') {
    box(ctx, SCREEN_IDLE_FG, sx + sw / 2 - 6, sy + sh / 2 - 1, 12, 3);
  } else if (mood === 'done') {
    const cx = sx + sw / 2;
    const cy = sy + sh / 2;
    for (let i = 0; i < 3; i++) box(ctx, C.screenMark, cx - 10 + i * 3, cy + i * 3 - 2, 4, 4);
    for (let i = 0; i < 5; i++) box(ctx, C.screenMark, cx - 1 + i * 3, cy + 4 - i * 4, 4, 4);
  } else {
    const cx = sx + sw / 2;
    const cy = sy + sh / 2;
    for (let i = -3; i <= 3; i++) {
      box(ctx, C.screenMark, cx + i * 3 - 2, cy + i * 3 - 2, 4, 4);
      box(ctx, C.screenMark, cx + i * 3 - 2, cy - i * 3 - 2, 4, 4);
    }
  }
}

function drawDesk(ctx: CanvasRenderingContext2D, x0: number, x1: number, top: number): void {
  const w = x1 - x0;
  box(ctx, C.deskEdge, x0 - 3, top - 3, w + 6, DESK_TOP_H + DESK_FRONT_H + 6);
  box(ctx, C.deskTop, x0, top, w, DESK_TOP_H);
  box(ctx, C.deskFront, x0, top + DESK_TOP_H, w, DESK_FRONT_H);
  box(ctx, C.deskEdge, x0, top + DESK_TOP_H, w, 3);
}

function drawPlate(
  ctx: CanvasRenderingContext2D,
  cx: number,
  y: number,
  text: string,
  maxW: number,
  bg: string,
  fg: string,
): void {
  ctx.font = FONT_PLATE;
  const w = Math.min(maxW, Math.ceil(ctx.measureText(text).width) + 24);
  const x = Math.round(cx - w / 2);
  box(ctx, C.plateEdge, x - 3, y - 3, w + 6, 34);
  box(ctx, bg, x, y, w, 28);
  ctx.fillStyle = fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, cx, y + 15, w - 12);
}

function drawChairBack(ctx: CanvasRenderingContext2D, cx: number, top: number, h: number): void {
  box(ctx, C.chairEdge, cx - 48, top, 96, h);
  box(ctx, C.chair, cx - 44, top + 4, 88, h - 8);
}

function frameFor(seat: TeamSeat, t: number, seed: number): number {
  if (seat.mood === 'resting') return FRAME_SLEEPY;
  if (seat.mood === 'done') return FRAME_CHEER;
  if ((t + seed * 1337) % BLINK_EVERY_MS < BLINK_MS) return FRAME_BLINK;
  if (seat.mood === 'working') return Math.floor(t / TYPE_FRAME_MS) % 2 ? FRAME_BOUNCE : FRAME_A;
  return FRAME_A;
}

/** One person at a desk: chair, character, desk, monitor and name. Returns the sprite's top. */
function drawWorkstation(
  ctx: CanvasRenderingContext2D,
  seat: TeamSeat,
  faces: HTMLImageElement[][],
  desk: { x0: number; x1: number; top: number },
  cx: number,
  monitorX: number,
  plate: { bg: string; fg: string },
  t: number,
  seed: number,
): number {
  const img = faces[seat.palette % faces.length][frameFor(seat, t, seed)];
  const spriteTop = desk.top + SIT_DEPTH - img.height;
  ctx.drawImage(img, Math.round(cx - img.width / 2), spriteTop);
  drawDesk(ctx, desk.x0, desk.x1, desk.top);
  drawMonitor(ctx, monitorX, desk.top, seat.mood, t, seed);
  drawPlate(
    ctx,
    cx,
    desk.top + DESK_TOP_H + 12,
    seat.label,
    desk.x1 - desk.x0 - 16,
    plate.bg,
    plate.fg,
  );
  return spriteTop;
}

function drawGlassOffice(
  ctx: CanvasRenderingContext2D,
  view: TeamOfficeView,
  faces: HTMLImageElement[][],
  t: number,
): number {
  const { x0, y0, x1, y1 } = GLASS;
  box(ctx, C.leadFloor, x0, WALL_BOTTOM, x1 - x0, y1 - WALL_BOTTOM);
  const top = drawWorkstation(
    ctx,
    view.lead,
    faces,
    { x0: LEAD_DESK.x0, x1: LEAD_DESK.x1, top: LEAD_DESK.top },
    360,
    436,
    { bg: C.leadPlateBg, fg: C.leadPlateText },
    t,
    0,
  );
  // Glass: side panes full height, a low front pane so the MD stays in view.
  box(ctx, C.glass, x0, y0, 12, y1 - y0);
  box(ctx, C.glass, x1 - 12, y0, 12, y1 - y0);
  box(ctx, C.glass, x0 + 12, y1 - 44, x1 - x0 - 24, 44);
  for (let i = 0; i < 3; i++) box(ctx, C.glassShine, x0 + 40 + i * 110, y1 - 40, 18, 4);
  box(ctx, C.glassFrame, x0, y0, x1 - x0, 6);
  box(ctx, C.glassFrame, x0, y1 - 4, x1 - x0, 4);
  box(ctx, C.glassFrame, x0, y0, 4, y1 - y0);
  box(ctx, C.glassFrame, x1 - 4, y0, 4, y1 - y0);
  box(ctx, C.glassFrame, x0 + 8, y1 - 46, x1 - x0 - 16, 3);
  return top;
}

function drawBossDesk(ctx: CanvasRenderingContext2D, pending: number, t: number): void {
  const { x0, x1, top } = BOSS_DESK;
  drawDesk(ctx, x0, x1, top);
  // The in-tray: one sheet per thing waiting, up to a small pile.
  const sheets = Math.min(pending, 5);
  for (let i = 0; i < sheets; i++) {
    box(ctx, C.paperLine, x0 + 22, top - 6 - i * 6, 54, 6);
    box(ctx, C.paper, x0 + 24, top - 6 - i * 6, 50, 4);
  }
  drawMonitor(ctx, x1 - 84, top, pending > 0 ? 'alert' : 'resting', t, 99);
  drawPlate(
    ctx,
    (x0 + x1) / 2,
    top + DESK_TOP_H + 12,
    '대표님',
    x1 - x0 - 16,
    C.bossPlateBg,
    C.plateText,
  );
  drawChairBack(ctx, (x0 + x1) / 2, top + DESK_TOP_H + DESK_FRONT_H + 8, 40);
}

/**
 * Draw one team's office in room coordinates (`roomW` x `roomH`). Returns the click targets and
 * the speech bubbles, which the caller draws over everything else.
 */
export function drawTeamOffice(
  ctx: CanvasRenderingContext2D,
  roomW: number,
  roomH: number,
  view: TeamOfficeView,
  faces: HTMLImageElement[][],
  t: number,
): { targets: TeamTarget[]; bubbles: TeamBubble[] } {
  ctx.save();
  drawShell(ctx, roomW, roomH);
  drawWindow(ctx, t);
  drawRug(ctx);
  drawPlant(ctx, 70, ROOM.y1 - 12);
  drawPlant(ctx, 698, ROOM.y1 - 12);
  drawBoard(ctx, view);
  const leadId = view.lead.sessionId;
  const targets: TeamTarget[] = [
    { ...BOARD, sessionId: leadId },
    { x0: GLASS.x0, y0: GLASS.y0, x1: GLASS.x1, y1: GLASS.y1, sessionId: leadId },
  ];
  const bubbles: TeamBubble[] = [];
  const say = (seat: TeamSeat, cx: number, top: number): void => {
    if (seat.says) {
      bubbles.push({
        cx,
        bottom: top,
        text: seat.says,
        alert: seat.mood === 'alert',
        sessionId: seat.sessionId,
      });
    }
  };
  say(view.lead, 360, drawGlassOffice(ctx, view, faces, t));
  view.members.slice(0, WING_X.length * ROW_TOPS.length).forEach((seat, i) => {
    const side = i % 2;
    const wing = WING_X[side];
    const top = ROW_TOPS[Math.floor(i / 2)];
    // Characters sit toward the aisle's far side; monitors face the aisle.
    const cx = side === 0 ? wing.x0 + 96 : wing.x1 - 96;
    const monitorX = side === 0 ? wing.x1 - MONITOR_W - 14 : wing.x0 + 14;
    const spriteTop = drawWorkstation(
      ctx,
      seat,
      faces,
      { ...wing, top },
      cx,
      monitorX,
      { bg: C.plateBg, fg: C.plateText },
      t,
      i + 1,
    );
    targets.push({
      x0: wing.x0,
      y0: spriteTop - 20,
      x1: wing.x1,
      y1: top + DESK_TOP_H + DESK_FRONT_H,
      sessionId: seat.sessionId ?? leadId,
    });
    say(seat, cx, spriteTop);
  });
  drawBossDesk(ctx, view.pending, t);
  targets.push({
    x0: BOSS_DESK.x0,
    y0: BOSS_DESK.top - 60,
    x1: BOSS_DESK.x1,
    y1: BOSS_DESK.top + DESK_TOP_H + DESK_FRONT_H,
    sessionId: leadId,
  });
  if (view.pending > 0) {
    bubbles.push({
      cx: (BOSS_DESK.x0 + BOSS_DESK.x1) / 2,
      bottom: BOSS_DESK.top - 40,
      text: `확인할 것 ${view.pending}건`,
      alert: true,
      sessionId: null,
    });
  }
  ctx.restore();
  return { targets, bubbles };
}
