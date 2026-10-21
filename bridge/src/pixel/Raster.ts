import { parseColor } from "./PixelGridCodec.js";
import { createRgbaImage, type RgbaImage } from "./RgbaImage.js";

type Rgba = [number, number, number, number];

// 4x4 Bayer matrix: the classic ordered-dither pattern pixel artists use for gradients.
const BAYER_4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

/**
 * Pixel-exact drawing primitives for scripts. No anti-aliasing anywhere: every shape
 * produces hard edges, which is what pixel art needs.
 */
export class Raster {
  readonly image: RgbaImage;
  private readonly colorCache = new Map<string, Rgba>();

  constructor(width: number, height: number, base?: RgbaImage) {
    this.image = base
      ? { width, height, data: new Uint8Array(base.data) }
      : createRgbaImage(width, height);
  }

  get width(): number {
    return this.image.width;
  }

  get height(): number {
    return this.image.height;
  }

  private color(value: string): Rgba {
    let rgba = this.colorCache.get(value);
    if (!rgba) {
      rgba = parseColor(value);
      this.colorCache.set(value, rgba);
    }
    return rgba;
  }

  private put(x: number, y: number, rgba: Rgba): void {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.image.data.set(rgba, (y * this.width + x) * 4);
  }

  set(x: number, y: number, color: string): void {
    this.put(Math.round(x), Math.round(y), this.color(color));
  }

  /** "#rrggbbaa" or null outside the canvas. Lets scripts do outline/shading passes. */
  get(x: number, y: number): string | null {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return null;
    const o = (y * this.width + x) * 4;
    const hex = (n: number) => n.toString(16).padStart(2, "0");
    const d = this.image.data;
    return `#${hex(d[o])}${hex(d[o + 1])}${hex(d[o + 2])}${hex(d[o + 3])}`;
  }

  rect(x: number, y: number, w: number, h: number, color: string): void {
    const rgba = this.color(color);
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, Math.round(x + w));
    const y1 = Math.min(this.height, Math.round(y + h));
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) this.put(px, py, rgba);
    }
  }

  /** 1px outline of a rectangle. */
  frame(x: number, y: number, w: number, h: number, color: string): void {
    this.line(x, y, x + w - 1, y, color);
    this.line(x, y + h - 1, x + w - 1, y + h - 1, color);
    this.line(x, y, x, y + h - 1, color);
    this.line(x + w - 1, y, x + w - 1, y + h - 1, color);
  }

  /** Bresenham: exactly one pixel per step, no gaps or doubled corners. */
  line(x0: number, y0: number, x1: number, y1: number, color: string): void {
    const rgba = this.color(color);
    x0 = Math.round(x0);
    y0 = Math.round(y0);
    x1 = Math.round(x1);
    y1 = Math.round(y1);
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      this.put(x0, y0, rgba);
      if (x0 === x1 && y0 === y1) return;
      const e2 = 2 * err;
      if (e2 >= dy) {
        err += dy;
        x0 += sx;
      }
      if (e2 <= dx) {
        err += dx;
        y0 += sy;
      }
    }
  }

  ellipse(cx: number, cy: number, rx: number, ry: number, color: string, filled = true): void {
    const rgba = this.color(color);
    if (rx <= 0 || ry <= 0) return this.put(Math.round(cx), Math.round(cy), rgba);
    const inside = (px: number, py: number) => {
      const nx = (px - cx) / (rx + 0.5);
      const ny = (py - cy) / (ry + 0.5);
      return nx * nx + ny * ny <= 1;
    };
    for (let py = Math.floor(cy - ry); py <= Math.ceil(cy + ry); py++) {
      for (let px = Math.floor(cx - rx); px <= Math.ceil(cx + rx); px++) {
        if (!inside(px, py)) continue;
        // Outline = inside pixels with at least one 4-neighbour outside.
        if (
          filled ||
          !inside(px + 1, py) ||
          !inside(px - 1, py) ||
          !inside(px, py + 1) ||
          !inside(px, py - 1)
        ) {
          this.put(px, py, rgba);
        }
      }
    }
  }

  circle(cx: number, cy: number, r: number, color: string, filled = true): void {
    this.ellipse(cx, cy, r, r, color, filled);
  }

  /** Filled polygon (even-odd rule), sampled at pixel centres. */
  poly(points: number[][], color: string): void {
    if (points.length < 3) return;
    const rgba = this.color(color);
    const ys = points.map((p) => p[1]);
    const minY = Math.max(0, Math.floor(Math.min(...ys)));
    const maxY = Math.min(this.height - 1, Math.ceil(Math.max(...ys)));
    for (let py = minY; py <= maxY; py++) {
      const sy = py + 0.5;
      const xs: number[] = [];
      for (let i = 0; i < points.length; i++) {
        const [ax, ay] = points[i];
        const [bx, by] = points[(i + 1) % points.length];
        if ((ay <= sy && by > sy) || (by <= sy && ay > sy)) {
          xs.push(ax + ((sy - ay) / (by - ay)) * (bx - ax));
        }
      }
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        for (let px = Math.ceil(xs[i] - 0.5); px < Math.ceil(xs[i + 1] - 0.5); px++) {
          this.put(px, py, rgba);
        }
      }
    }
  }

  /** Paint-bucket: replaces the 4-connected area that has the same colour as (x, y). */
  fill(x: number, y: number, color: string): void {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const rgba = this.color(color);
    const d = this.image.data;
    const start = (y * this.width + x) * 4;
    const target = [d[start], d[start + 1], d[start + 2], d[start + 3]];
    if (target.every((v, i) => v === rgba[i])) return;

    const same = (i: number) =>
      d[i] === target[0] && d[i + 1] === target[1] && d[i + 2] === target[2] && d[i + 3] === target[3];
    const stack = [x, y];
    while (stack.length) {
      const py = stack.pop()!;
      const px = stack.pop()!;
      if (px < 0 || py < 0 || px >= this.width || py >= this.height) continue;
      const i = (py * this.width + px) * 4;
      if (!same(i)) continue;
      d.set(rgba, i);
      stack.push(px + 1, py, px - 1, py, px, py + 1, px, py - 1);
    }
  }

  /**
   * Ordered dither inside a rectangle: `amount` 0..1 is the share of pixels painted with
   * `color`, so stepping amount across bands gives a pixel-art gradient.
   */
  dither(x: number, y: number, w: number, h: number, color: string, amount: number): void {
    const rgba = this.color(color);
    const threshold = Math.max(0, Math.min(1, amount)) * 16;
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, Math.round(x + w));
    const y1 = Math.min(this.height, Math.round(y + h));
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        if (BAYER_4[py % 4][px % 4] < threshold) this.put(px, py, rgba);
      }
    }
  }
}
