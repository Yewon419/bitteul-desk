/** Bitteul scene view: colours, fonts and timing. Colour literals are allowed only here. */

export const SCENE_PAGE_BG = '#0f1a2a';

export const SCREEN_ON_BG = '#12305a';
export const SCREEN_ON_GLOW = 'rgba(95, 227, 255, 0.55)';
export const SCREEN_CODE_COLORS = ['#5fe3ff', '#ffffff', '#ffd166', '#6fffd2', '#9fd2ff'];
export const SCREEN_ALERT_BG = '#5a3a0a';
export const SCREEN_ALERT_FG = '#ffd166';
export const SCREEN_ALERT_GLOW = 'rgba(255, 209, 102, 0.6)';
export const SCREEN_IDLE_BG = '#16283f';
export const SCREEN_IDLE_FG = '#5f86ad';

export const BUBBLE_BG = 'rgba(246, 250, 252, 0.94)';
export const BUBBLE_BORDER = '#13293d';
export const BUBBLE_TEXT = '#13293d';
export const BUBBLE_ALERT_BG = '#ffd166';

export const HOLO_FILL = 'rgba(95, 227, 255, 0.25)';
export const HOLO_EDGE = 'rgba(95, 227, 255, 0.85)';
export const HOLO_TEXT = 'rgba(255, 255, 255, 0.9)';

export const WALL_BG = '#0d1b2e';
export const WALL_TITLE = '#5fe3ff';
export const WALL_LABEL = '#9fc4e0';
export const WALL_VALUE = '#ffffff';
export const WALL_ACCENT = '#ffd166';
export const WALL_GAUGE_TRACK = '#23405f';
export const WALL_GAUGE_FILL = '#2b86c5';

export const FONT_SMALL = '10px Galmuri9';
export const FONT_BODY = '12px Galmuri11';
export const FONT_BOLD = 'bold 12px Galmuri11';
export const FONT_BIG = 'bold 24px Galmuri11';
export const FONT_BUBBLE = '24px Galmuri11';

export const BUBBLE_STAGGER = 48;
export const ROOM_TIME_SHIFT_MS = 7919;

export const TYPE_FRAME_MS = 300;
export const READ_FRAME_MS = 700;
export const CODE_SCROLL_MS = 260;
export const ALERT_BLINK_MS = 500;

export const CLOUD_SPEED_PX_PER_S = 3;
export const BLINK_EVERY_MS = 4200;
export const BLINK_MS = 140;
export const BULB_OFF = '#b9a88a';

export function bulbGlow(a: number): string {
  return `rgba(255, 214, 140, ${a})`;
}

export function lampGlow(a: number): string {
  return `rgba(255, 236, 170, ${a})`;
}

export function seaGlint(a: number): string {
  return `rgba(255, 255, 255, ${a})`;
}

export function steamColor(a: number): string {
  return `rgba(255, 255, 255, ${a})`;
}

export function dustColor(a: number): string {
  return `rgba(255, 246, 220, ${a})`;
}

export function beamAlpha(t: number): number {
  return 0.1 + 0.07 * Math.sin(t / 2600);
}

export const MUG_BODY = '#f6fafc';
export const MUG_EDGE = '#13293d';
export const MUG_COFFEE = '#6b4a2e';
export const ZZZ_COLOR = '#13293d';

export const FONT_TITLE = 'bold 18px Galmuri11';
export const TITLE_LINE_H = 21;
export const TITLE_LINES = 2;
export const TITLE_POLL_MS = 2000;
export const SCREEN_TITLE_BG = 'rgba(11, 22, 40, 0.88)';
export const SCREEN_TITLE_FG = '#ffffff';
export const SELECT_MARK = '#ffd166';

export const LONG_PRESS_MS = 350;
export const DRAG_SLOP_PX = 8;
export const CARRY_SCALE = 1.15;
export const SEAT_ZONE_PAD = 20;
export const SEAT_ZONE_BELOW = 110;
export const DROP_FILL = 'rgba(255, 209, 102, 0.22)';
export const FONT_SIGN = 'bold 30px Galmuri11';
export const SIGN_Y = 22;
export const SIGN_H = 52;
export const SIGN_MIN_W = 220;
export const SIGN_BG = '#2779b3';
export const SIGN_EDGE = '#13293d';
export const SIGN_TEXT = '#ffffff';
export const SIGN_HINT = 'rgba(191, 224, 245, 0.75)';
