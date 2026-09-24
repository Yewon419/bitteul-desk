/**
 * Ambient life for the scene background: drifting clouds, sea glints, swaying plants,
 * breathing sunbeams, twinkling fairy lights, an occasionally flickering desk lamp,
 * mug steam and dust motes. Purely decorative; nothing here reflects agent state.
 */

import {
  beamAlpha,
  BULB_OFF,
  bulbGlow,
  CLOUD_SPEED_PX_PER_S,
  dustColor,
  lampGlow,
  seaGlint,
  steamColor,
} from './constants.js';

type Point = [number, number];

export interface PlantLayer {
  file: string;
  x: number;
  y: number;
  w: number;
  h: number;
  pivot: 'top' | 'bottom';
  amp: number;
  period: number;
}

export interface AmbientData {
  window: Point;
  plants: PlantLayer[];
  bulbs: Point[];
  sea: Point[];
  lamps: Array<[number, number, number]>;
  steam: Point[];
  beams: Point;
  dust: [number, number, number, number];
}

export interface AmbientImages {
  sky: HTMLImageElement;
  clouds: HTMLImageElement;
  beams: HTMLImageElement;
  plants: Map<string, HTMLImageElement>;
}

const DUST_COUNT = 46;
const STEAM_PUFFS = 4;
const STEAM_RISE_PX = 34;
const STEAM_CYCLE_MS = 3200;

function hash(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

export class Ambient {
  private readonly data: AmbientData;
  private readonly img: AmbientImages;
  private readonly skyCanvas: HTMLCanvasElement;
  private readonly skyCtx: CanvasRenderingContext2D;

  constructor(data: AmbientData, img: AmbientImages) {
    this.data = data;
    this.img = img;
    this.skyCanvas = document.createElement('canvas');
    this.skyCanvas.width = img.sky.width;
    this.skyCanvas.height = img.sky.height;
    const ctx = this.skyCanvas.getContext('2d');
    if (!ctx) throw new Error('[Scene] 2d context unavailable');
    this.skyCtx = ctx;
  }

  /** Layers that sit on the wall and window, behind desks and staff. */
  drawBack(ctx: CanvasRenderingContext2D, t: number): void {
    this.drawSky(ctx, t);
    this.drawSea(ctx, t);
    this.drawPlants(ctx, t);
    this.drawBulbs(ctx, t);
    this.drawLamp(ctx, t);
  }

  /** Layers that float in the room, in front of desks but behind speech bubbles. */
  drawFront(ctx: CanvasRenderingContext2D, t: number): void {
    this.drawBeams(ctx, t);
    this.drawSteam(ctx, t);
    this.drawDust(ctx, t);
  }

  private drawSky(ctx: CanvasRenderingContext2D, t: number): void {
    const s = this.skyCtx;
    const w = this.skyCanvas.width;
    const loop = this.img.clouds.width;
    const offset = Math.floor(((t / 1000) * CLOUD_SPEED_PX_PER_S) % loop);
    s.globalCompositeOperation = 'source-over';
    s.clearRect(0, 0, w, this.skyCanvas.height);
    s.drawImage(this.img.sky, 0, 0);
    s.drawImage(this.img.clouds, offset, 0);
    s.drawImage(this.img.clouds, offset - loop, 0);
    s.globalCompositeOperation = 'destination-in';
    s.drawImage(this.img.sky, 0, 0);
    s.globalCompositeOperation = 'source-over';
    ctx.drawImage(this.skyCanvas, this.data.window[0], this.data.window[1]);
  }

  private drawSea(ctx: CanvasRenderingContext2D, t: number): void {
    this.data.sea.forEach(([x, y], i) => {
      const speed = 0.6 + hash(i) * 1.4;
      const wave = Math.sin((t / 1000) * speed + hash(i + 99) * Math.PI * 2);
      const a = Math.pow(Math.max(0, wave), 12);
      if (a < 0.05) return;
      ctx.fillStyle = seaGlint(a);
      ctx.fillRect(x, y, 2, 2);
    });
  }

  private drawPlants(ctx: CanvasRenderingContext2D, t: number): void {
    this.data.plants.forEach((p, i) => {
      const img = this.img.plants.get(p.file);
      if (!img) return;
      const swing = Math.sin((t / 1000 / p.period) * Math.PI * 2 + i * 1.7);
      for (let row = 0; row < p.h; row++) {
        const reach = p.pivot === 'top' ? row / p.h : (p.h - row) / p.h;
        const dx = Math.round(p.amp * swing * Math.pow(reach, 1.5));
        ctx.drawImage(img, 0, row, p.w, 1, p.x + dx, p.y + row, p.w, 1);
      }
    });
  }

  private drawBulbs(ctx: CanvasRenderingContext2D, t: number): void {
    const tick = Math.floor(t / 180);
    this.data.bulbs.forEach(([x, y], i) => {
      const off = hash(tick * 0.37 + i * 7.13) > 0.985;
      const twinkle = 0.55 + 0.45 * Math.sin(t / 900 + hash(i) * 6.28);
      const a = off ? 0 : 0.22 + 0.2 * twinkle;
      const g = ctx.createRadialGradient(x, y, 0, x, y, 9);
      g.addColorStop(0, bulbGlow(a));
      g.addColorStop(1, bulbGlow(0));
      ctx.fillStyle = g;
      ctx.fillRect(x - 9, y - 9, 18, 18);
      if (off) {
        ctx.fillStyle = BULB_OFF;
        ctx.fillRect(x - 2, y - 2, 4, 4);
      }
    });
  }

  private drawLamp(ctx: CanvasRenderingContext2D, t: number): void {
    this.data.lamps.forEach(([x, y, r], i) => {
      const cycle = (t + i * 3100) % 9000;
      const flicker = cycle > 8400 && Math.floor(cycle / 70) % 2 === 0;
      const a = flicker ? 0.04 : 0.2 + 0.03 * Math.sin(t / 1300);
      const g = ctx.createRadialGradient(x, y, 0, x, y + r * 0.6, r * 1.6);
      g.addColorStop(0, lampGlow(a));
      g.addColorStop(1, lampGlow(0));
      ctx.fillStyle = g;
      ctx.fillRect(x - r * 2, y - r, r * 4, r * 3);
    });
  }

  private drawBeams(ctx: CanvasRenderingContext2D, t: number): void {
    ctx.save();
    ctx.globalAlpha = beamAlpha(t);
    ctx.drawImage(this.img.beams, this.data.beams[0], this.data.beams[1]);
    ctx.restore();
  }

  private drawSteam(ctx: CanvasRenderingContext2D, t: number): void {
    this.data.steam.forEach(([x, y], m) => {
      for (let k = 0; k < STEAM_PUFFS; k++) {
        const phase =
          ((t + (k * STEAM_CYCLE_MS) / STEAM_PUFFS + m * 900) % STEAM_CYCLE_MS) / STEAM_CYCLE_MS;
        const px = x + Math.sin(phase * 6 + k) * 3;
        const py = y - phase * STEAM_RISE_PX;
        const a = Math.sin(phase * Math.PI) * 0.45;
        ctx.fillStyle = steamColor(a);
        ctx.fillRect(Math.round(px), Math.round(py), 3, 3);
      }
    });
  }

  private drawDust(ctx: CanvasRenderingContext2D, t: number): void {
    const [x0, y0, x1, y1] = this.data.dust;
    const w = x1 - x0;
    const h = y1 - y0;
    for (let i = 0; i < DUST_COUNT; i++) {
      const vx = (hash(i) - 0.5) * 6;
      const vy = 4 + hash(i + 50) * 8;
      const x = x0 + ((((hash(i + 100) * w + (t / 1000) * vx) % w) + w) % w);
      const y = y1 - ((hash(i + 200) * h + (t / 1000) * vy) % h);
      const a = 0.25 + 0.35 * Math.max(0, Math.sin(t / 700 + i));
      ctx.fillStyle = dustColor(a);
      ctx.fillRect(Math.round(x), Math.round(y), 2, 2);
    }
  }
}
