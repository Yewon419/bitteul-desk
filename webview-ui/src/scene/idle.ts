/**
 * Off-duty behaviour: when an agent's turn is done it hops off its chair and wanders the
 * room floor, stopping now and then to stretch, nap, sip coffee or dance. When work comes
 * back it walks to its desk and sits down again. Positions are in room-local scene pixels.
 */

import { FONT_BOLD, MUG_BODY, MUG_COFFEE, MUG_EDGE, steamColor, ZZZ_COLOR } from './constants.js';

export type Activity = 'walk' | 'stretch' | 'nap' | 'coffee' | 'dance' | 'return';

export interface Body {
  x: number;
  y: number;
  tx: number;
  ty: number;
  activity: Activity;
  until: number;
  home: boolean;
  last: number;
}

export type Floor = [number, number, number, number];

const WALK_SPEED_PX_PER_S = 48;
const MAX_STEP_MS = 1000;
const ARRIVE_PX = 2;
const PASTIMES: Activity[] = ['stretch', 'nap', 'coffee', 'dance'];
const PASTIME_MS: Record<Activity, [number, number]> = {
  walk: [0, 0],
  return: [0, 0],
  stretch: [3000, 5000],
  nap: [7000, 12000],
  coffee: [5000, 8000],
  dance: [3000, 5000],
};

export const ACTIVITY_LABEL: Record<Activity, string> = {
  walk: '산책 중',
  stretch: '기지개 켜는 중',
  nap: '낮잠 자는 중',
  coffee: '커피 타임',
  dance: '신나는 중',
  return: '자리로 복귀 중',
};

/** Frame indices into the a-f sprite list (see art/clawd.py). */
const REST = 0;
const WALK_A = 1;
const BLINK = 2;
const WALK_B = 3;
const STRETCH = 4;
const ASLEEP = 5;

function between(lo: number, hi: number): number {
  return lo + Math.random() * (hi - lo);
}

export function newBody(home: [number, number], t: number): Body {
  return {
    x: home[0],
    y: home[1],
    tx: home[0],
    ty: home[1],
    activity: 'walk',
    until: 0,
    home: true,
    last: t,
  };
}

function moveToward(b: Body, dt: number): boolean {
  const dx = b.tx - b.x;
  const dy = b.ty - b.y;
  const dist = Math.hypot(dx, dy);
  const step = (WALK_SPEED_PX_PER_S * dt) / 1000;
  if (dist <= Math.max(step, ARRIVE_PX)) {
    b.x = b.tx;
    b.y = b.ty;
    return true;
  }
  b.x += (dx / dist) * step;
  b.y += (dy / dist) * step;
  return false;
}

function wander(b: Body, floor: Floor): void {
  b.activity = 'walk';
  b.tx = between(floor[0], floor[2]);
  b.ty = between(floor[1], floor[3]);
}

/** Advance one body for one frame. `offDuty` is true while the agent's turn is finished. */
export function stepBody(
  b: Body,
  offDuty: boolean,
  home: [number, number],
  floor: Floor,
  t: number,
): void {
  const dt = Math.min(MAX_STEP_MS, Math.max(0, t - b.last));
  b.last = t;
  if (!offDuty) {
    if (b.home) return;
    b.activity = 'return';
    b.tx = home[0];
    b.ty = home[1];
    if (moveToward(b, dt)) b.home = true;
    return;
  }
  if (b.home) {
    b.home = false;
    b.x = home[0];
    b.y = home[1];
    wander(b, floor);
    return;
  }
  if (b.activity === 'return') {
    wander(b, floor);
    return;
  }
  if (b.activity === 'walk') {
    if (moveToward(b, dt)) {
      b.activity = PASTIMES[Math.floor(Math.random() * PASTIMES.length)];
      const [lo, hi] = PASTIME_MS[b.activity];
      b.until = t + between(lo, hi);
    }
    return;
  }
  if (t >= b.until) wander(b, floor);
}

export function frameFor(b: Body, t: number, id: number): { frame: number; lift: number } {
  switch (b.activity) {
    case 'walk':
    case 'return': {
      const step = Math.floor(t / 180) % 2;
      return { frame: step ? WALK_B : WALK_A, lift: step ? 0 : 2 };
    }
    case 'dance': {
      const beat = Math.floor(t / 160) % 2;
      return { frame: beat ? WALK_B : WALK_A, lift: beat ? 0 : 8 };
    }
    case 'stretch':
      return { frame: Math.floor(t / 700) % 2 ? STRETCH : REST, lift: 0 };
    case 'nap':
      return { frame: ASLEEP, lift: Math.floor(t / 1200) % 2 };
    case 'coffee':
      return { frame: (t + id * 911) % 3800 < 150 ? BLINK : REST, lift: 0 };
  }
}

/** Props drawn on top of the sprite, given its top-left corner and size. */
export function drawProps(
  ctx: CanvasRenderingContext2D,
  b: Body,
  x: number,
  y: number,
  w: number,
  t: number,
): void {
  if (b.activity === 'nap') {
    ctx.save();
    ctx.fillStyle = ZZZ_COLOR;
    ctx.font = FONT_BOLD;
    for (let i = 0; i < 3; i++) {
      const phase = (((t / 1600 + i / 3) % 1) + 1) % 1;
      ctx.globalAlpha = Math.sin(phase * Math.PI);
      ctx.fillText('z', x + w - 10 + phase * 18, y + 8 - phase * 40);
    }
    ctx.restore();
    return;
  }
  if (b.activity === 'coffee') {
    const sip = Math.floor(t / 2500) % 3 === 0;
    const mx = Math.round(x + w - 30);
    const my = Math.round(y + (sip ? 18 : 36));
    ctx.fillStyle = MUG_EDGE;
    ctx.fillRect(mx - 2, my - 2, 20, 22);
    ctx.fillRect(mx + 16, my + 3, 8, 10);
    ctx.fillStyle = MUG_BODY;
    ctx.fillRect(mx, my, 16, 18);
    ctx.fillRect(mx + 16, my + 5, 4, 6);
    ctx.fillStyle = MUG_COFFEE;
    ctx.fillRect(mx + 2, my + 2, 12, 3);
    for (let k = 0; k < 3; k++) {
      const phase = (((t / 1400 + k / 3) % 1) + 1) % 1;
      ctx.fillStyle = steamColor(Math.sin(phase * Math.PI) * 0.6);
      ctx.fillRect(
        Math.round(mx + 4 + k * 4 + Math.sin(phase * 6) * 2),
        Math.round(my - 6 - phase * 16),
        3,
        3,
      );
    }
  }
}
