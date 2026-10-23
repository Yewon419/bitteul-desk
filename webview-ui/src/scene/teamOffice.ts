/**
 * The team office: one big room per team, painted in `team_office.png`. The MD works in the glass
 * office at the top, members sit at the desks in two wings with their names on the desk, and the
 * user's desk at the bottom collects what the team is waiting on. Code draws only what changes:
 * the people, their names, the state on their monitors, and the board.
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

/** The painted room, what of it stands in front of people, and the staff sprites. */
export interface TeamOfficeArt {
  room: HTMLImageElement;
  /** `team_office_front.png`: the MD's chair, the members' monitors and desks, cut out. */
  overlay: HTMLImageElement;
  front: HTMLImageElement[][];
  back: HTMLImageElement[][];
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Everything below is measured on team_office.png, in room pixels.
/** The cork board; the team's numbers are pinned on it as a card. */
const BOARD = { x0: 96, y0: 300, x1: 220, y1: 422 };
const GLASS = { x0: 242, y0: 182, x1: 522, y1: 460 };
/** The MD sits in the glass office chair, back to the room, facing its monitor. */
const LEAD = {
  cx: 345,
  bottom: 382,
  screen: { x: 413, y: 311, w: 58, h: 35 },
  plateCx: 384,
  plateY: 428,
};
/** Member desks, two per row. `surface` is the desk top the monitors stand on. */
const DESK_ROWS = [
  { screenY: 480, surface: 513, bottom: 592, plateY: 556 },
  { screenY: 635, surface: 668, bottom: 745, plateY: 710 },
  { screenY: 796, surface: 829, bottom: 907, plateY: 872 },
  { screenY: 966, surface: 999, bottom: 1081, plateY: 1045 },
];
/**
 * Members sit in the chair behind the outer monitor and look over it; that monitor shows how
 * their work is going.
 */
const WINGS = [
  { x0: 62, x1: 310, seatX: 134, screenX: 97, plateCx: 139 },
  { x0: 456, x1: 706, seatX: 635, screenX: 598, plateCx: 629 },
];
const SCREEN_W = 73;
const SCREEN_H = 38;
const BOSS = {
  x0: 208,
  x1: 557,
  top: 1078,
  bottom: 1250,
  papersCx: 295,
  plateCx: 500,
  plateY: 1150,
};
/** Staff sprites are painted for the one-person rooms; the team office is drawn smaller. */
const MEMBER_SCALE = 2 / 3;
/** The MD is drawn to fit its chair. */
const LEAD_SCALE = 1 / 2;
/** How far a member sits down behind the monitor: their eyes stay just above it. */
const SIT_BELOW_SURFACE = -4;
const PLATE_W = 120;
/** Wider than the painted nameplate, so a short name still covers it. */
const PLATE_MIN_W = 80;
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
  box(ctx, WALL_BG, x0, y0, w, y1 - y0);
  const mid = x0 + w / 2;
  const maxW = w - 12;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = WALL_TITLE;
  ctx.font = FONT_BOARD_TITLE;
  ctx.fillText(team.name, mid, y0 + 8, maxW);
  const state = boardState(team);
  ctx.fillStyle = state.warn ? WALL_ACCENT : WALL_VALUE;
  ctx.font = FONT_BOARD_VALUE;
  ctx.fillText(state.text, mid, y0 + 32, maxW);
  ctx.fillStyle = WALL_LABEL;
  ctx.font = FONT_BOARD_LABEL;
  ctx.fillText('예산', mid, y0 + 56, maxW);
  ctx.fillStyle = WALL_VALUE;
  ctx.font = FONT_BOARD_VALUE;
  const budget = team.budgetUsd;
  ctx.fillText(
    budget ? `$${team.costUsd.toFixed(2)} / $${budget}` : `$${team.costUsd.toFixed(2)}`,
    mid,
    y0 + 72,
    maxW,
  );
  if (budget) {
    const ratio = Math.min(1, team.costUsd / budget);
    box(ctx, WALL_GAUGE_TRACK, x0 + 6, y0 + 92, maxW, 6);
    box(
      ctx,
      team.budgetStopped ? C.screenFailed : ratio >= 0.8 ? WALL_ACCENT : WALL_GAUGE_FILL,
      x0 + 6,
      y0 + 92,
      Math.round(maxW * ratio),
      6,
    );
  }
  const busy = [view.lead, ...view.members].filter((s) => s.mood === 'working').length;
  ctx.fillStyle = WALL_LABEL;
  ctx.font = FONT_BOARD_LABEL;
  ctx.fillText(`일하는 중 ${busy}/${view.members.length + 1}명`, mid, y0 + 104, maxW);
}

/** A painted monitor's screen, lit up with how the work is going. */
function drawScreen(
  ctx: CanvasRenderingContext2D,
  { x: sx, y: sy, w: sw, h: sh }: Rect,
  mood: DeskMood,
  t: number,
  seed: number,
): void {
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

function drawPlate(
  ctx: CanvasRenderingContext2D,
  cx: number,
  y: number,
  text: string,
  bg: string,
  fg: string,
): void {
  ctx.font = FONT_PLATE;
  const w = Math.max(PLATE_MIN_W, Math.min(PLATE_W, Math.ceil(ctx.measureText(text).width) + 24));
  const x = Math.round(cx - w / 2);
  box(ctx, C.plateEdge, x - 3, y - 3, w + 6, 34);
  box(ctx, bg, x, y, w, 28);
  ctx.fillStyle = fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, cx, y + 15, w - 12);
}

function frameFor(seat: TeamSeat, t: number, seed: number): number {
  if (seat.mood === 'resting') return FRAME_SLEEPY;
  if (seat.mood === 'done') return FRAME_CHEER;
  if ((t + seed * 1337) % BLINK_EVERY_MS < BLINK_MS) return FRAME_BLINK;
  if (seat.mood === 'working') return Math.floor(t / TYPE_FRAME_MS) % 2 ? FRAME_BOUNCE : FRAME_A;
  return FRAME_A;
}

/** One sprite at `scale`, standing on `bottom`. Returns its top. */
function drawSprite(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  cx: number,
  bottom: number,
  scale: number,
): number {
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  ctx.drawImage(img, Math.round(cx - w / 2), bottom - h, w, h);
  return bottom - h;
}

/**
 * Draw one team's office in room coordinates. Returns the click targets and the speech bubbles,
 * which the caller draws over everything else.
 */
export function drawTeamOffice(
  ctx: CanvasRenderingContext2D,
  art: TeamOfficeArt,
  view: TeamOfficeView,
  t: number,
): { targets: TeamTarget[]; bubbles: TeamBubble[] } {
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(art.room, 0, 0);
  drawBoard(ctx, view);
  const leadId = view.lead.sessionId;
  const targets: TeamTarget[] = [
    { ...BOARD, sessionId: leadId },
    { ...GLASS, sessionId: leadId },
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

  const lead = view.lead;
  const leadImg = art.back[lead.palette % art.back.length][frameFor(lead, t, 0)];
  const leadTop = drawSprite(ctx, leadImg, LEAD.cx, LEAD.bottom, LEAD_SCALE);
  say(lead, LEAD.cx, leadTop);

  const members = view.members.slice(0, WINGS.length * DESK_ROWS.length);
  const seatOf = (i: number) => ({ wing: WINGS[i % 2], row: DESK_ROWS[Math.floor(i / 2)] });
  members.forEach((seat, i) => {
    const { wing, row } = seatOf(i);
    const img = art.front[seat.palette % art.front.length][frameFor(seat, t, i + 1)];
    const top = drawSprite(ctx, img, wing.seatX, row.surface + SIT_BELOW_SURFACE, MEMBER_SCALE);
    targets.push({
      x0: wing.x0,
      y0: top - 10,
      x1: wing.x1,
      y1: row.bottom,
      sessionId: seat.sessionId ?? leadId,
    });
    say(seat, wing.seatX, top);
  });

  // Desks, monitors and the lead's chair back, in front of everyone.
  ctx.drawImage(art.overlay, 0, 0);
  drawScreen(ctx, LEAD.screen, lead.mood, t, 0);
  drawPlate(ctx, LEAD.plateCx, LEAD.plateY, lead.label, C.leadPlateBg, C.leadPlateText);
  members.forEach((seat, i) => {
    const { wing, row } = seatOf(i);
    const screen = { x: wing.screenX, y: row.screenY, w: SCREEN_W, h: SCREEN_H };
    drawScreen(ctx, screen, seat.mood, t, i + 1);
    drawPlate(ctx, wing.plateCx, row.plateY - 5, seat.label, C.plateBg, C.plateText);
  });

  drawPlate(ctx, BOSS.plateCx, BOSS.plateY, '대표님', C.bossPlateBg, C.plateText);
  targets.push({ x0: BOSS.x0, y0: BOSS.top - 40, x1: BOSS.x1, y1: BOSS.bottom, sessionId: leadId });
  if (view.pending > 0) {
    bubbles.push({
      cx: BOSS.papersCx,
      bottom: BOSS.top,
      text: `확인할 것 ${view.pending}건`,
      alert: true,
      sessionId: null,
    });
  }
  ctx.restore();
  return { targets, bubbles };
}
