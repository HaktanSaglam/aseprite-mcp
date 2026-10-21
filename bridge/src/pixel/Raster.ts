import { decodeGrid, parseColor } from "./PixelGridCodec.js";
import { layoutText, textWidth } from "./pixelFont.js";
import { createRgbaImage, type RgbaImage } from "./RgbaImage.js";

type Rgba = [number, number, number, number];

export type GradientDirection = "v" | "h" | "radial";
export type GradientMode = "dither" | "bands" | "checker";
export type LightDirection = "tl" | "t" | "tr" | "l" | "r" | "bl" | "b" | "br" | "front";
/** A fixed color, or one derived from the edge pixel being outlined ("#rrggbbaa" in, color out). */
export type OutlineColor = string | ((edge: string) => string);

export interface OutlineOptions {
  placement?: "outside" | "inside";
  connectivity?: 4 | 8;
}

// 4x4 Bayer matrix: the classic ordered-dither pattern pixel artists use for gradients.
const BAYER_4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

const NEIGHBOURS_4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const NEIGHBOURS_8 = [...NEIGHBOURS_4, [1, 1], [1, -1], [-1, 1], [-1, -1]];

// z > 0 points at the viewer; a raking light (z ~ 1) gives the readable 1/3-lit spheres
// pixel artists draw, instead of a flat disc lit head-on.
const LIGHTS: Record<LightDirection, [number, number, number]> = {
  tl: [-1, -1, 1.2],
  t: [0, -1, 1.2],
  tr: [1, -1, 1.2],
  l: [-1, 0, 1.2],
  r: [1, 0, 1.2],
  bl: [-1, 1, 1.2],
  b: [0, 1, 1.2],
  br: [1, 1, 1.2],
  front: [0, 0, 1],
};

/**
 * Cumulative area share below each band boundary of a shaded sphere: a small highlight
 * (~8%), midtones widest, a shadow side of roughly a third, like hand-shaded spheres.
 */
function sphereBandShares(n: number): number[] {
  if (n <= 1) return [];
  if (n === 2) return [0.45];
  const highlight = 0.07 + 0.12 / n;
  const raw = Array.from({ length: n - 1 }, (_, k) => 1 + 0.35 * Math.sin((Math.PI * (k + 0.5)) / (n - 1)));
  // The core shadow must stay wide enough to survive the bounce-light rim.
  raw[0] *= 1.25;
  const total = raw.reduce((a, b) => a + b, 0);
  const shares: number[] = [];
  let acc = 0;
  for (let k = 0; k < n - 1; k++) {
    acc += (raw[k] / total) * (1 - highlight);
    shares.push(acc);
  }
  return shares;
}

/** 0..1 ordered-dither threshold of a pixel; `amount > bayer(x, y)` paints `amount` of an area. */
export function bayer(x: number, y: number): number {
  const mod4 = (n: number) => ((Math.round(n) % 4) + 4) % 4;
  return (BAYER_4[mod4(y)][mod4(x)] + 0.5) / 16;
}

/**
 * Pixel-exact drawing primitives for scripts. No anti-aliasing anywhere: every shape
 * produces hard edges, which is what pixel art needs.
 */
export class Raster {
  readonly image: RgbaImage;
  private readonly colorCache = new Map<string, Rgba>();
  private readonly brushCache = new Map<number, number[][]>();

  constructor(width: number, height: number, base?: RgbaImage) {
    if (base && (base.width !== width || base.height !== height)) {
      throw new Error(`Raster: base is ${base.width}x${base.height}, expected ${width}x${height}`);
    }
    this.image = base ? { width, height, data: new Uint8Array(base.data) } : createRgbaImage(width, height);
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

  private inside(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  private put(x: number, y: number, rgba: Rgba | Uint8Array): void {
    if (!this.inside(x, y)) return;
    this.image.data.set(rgba, (y * this.width + x) * 4);
  }

  private alphaAt(x: number, y: number, data = this.image.data): number {
    return this.inside(x, y) ? data[(y * this.width + x) * 4 + 3] : 0;
  }

  private hexAt(x: number, y: number, data = this.image.data): string {
    const o = (y * this.width + x) * 4;
    const hex = (n: number) => n.toString(16).padStart(2, "0");
    return `#${hex(data[o])}${hex(data[o + 1])}${hex(data[o + 2])}${hex(data[o + 3])}`;
  }

  /** Clips a rectangle to the raster; returns [x0, y0, x1, y1) or undefined when empty. */
  private clip(x: number, y: number, w: number, h: number): [number, number, number, number] | undefined {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, Math.round(x + w));
    const y1 = Math.min(this.height, Math.round(y + h));
    return x0 < x1 && y0 < y1 ? [x0, y0, x1, y1] : undefined;
  }

  set(x: number, y: number, color: string): void {
    this.put(Math.round(x), Math.round(y), this.color(color));
  }

  /**
   * "#rrggbb" ("#rrggbbaa" when translucent), or null when the pixel is transparent or
   * outside the raster. Same format as ramp()/shade(), so scripts can compare with ===.
   */
  get(x: number, y: number): string | null {
    x = Math.round(x);
    y = Math.round(y);
    const alpha = this.alphaAt(x, y);
    if (alpha === 0) return null;
    const hex = this.hexAt(x, y);
    return alpha === 255 ? hex.slice(0, 7) : hex;
  }

  /** Filled rectangle; `radius` cuts pixel-art rounded corners. */
  rect(x: number, y: number, w: number, h: number, color: string, radius = 0): void {
    const box = this.clip(x, y, w, h);
    if (!box) return;
    const rgba = this.color(color);
    const left = Math.round(x);
    const top = Math.round(y);
    const right = Math.round(x + w) - 1;
    const bottom = Math.round(y + h) - 1;
    const r = Math.max(0, Math.min(Math.round(radius), Math.floor((right - left + 1) / 2), Math.floor((bottom - top + 1) / 2)));
    const [x0, y0, x1, y1] = box;
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        if (r > 0) {
          // Pixel centre vs. the corner circle; the -0.5 makes r=1 cut exactly the corner pixel.
          const dx = px < left + r ? left + r - px - 0.5 : px > right - r ? px - (right - r) - 0.5 : 0;
          const dy = py < top + r ? top + r - py - 0.5 : py > bottom - r ? py - (bottom - r) - 0.5 : 0;
          if (dx > 0 && dy > 0 && dx * dx + dy * dy > (r - 0.5) ** 2) continue;
        }
        this.put(px, py, rgba);
      }
    }
  }

  /** 1px outline of a rectangle. */
  frame(x: number, y: number, w: number, h: number, color: string): void {
    this.line(x, y, x + w - 1, y, color);
    this.line(x, y + h - 1, x + w - 1, y + h - 1, color);
    this.line(x, y, x, y + h - 1, color);
    this.line(x + w - 1, y, x + w - 1, y + h - 1, color);
  }

  /** Round brush offsets: 2 → 2x2, 3 → plus, 4+ → disc. Keeps thick lines even on diagonals. */
  private brush(width: number): number[][] {
    const w = Math.max(1, Math.min(32, Math.round(width)));
    let offsets = this.brushCache.get(w);
    if (!offsets) {
      offsets = [];
      const c = (w - 1) / 2;
      const limit = (w / 2) ** 2 * 0.8;
      for (let by = 0; by < w; by++) {
        for (let bx = 0; bx < w; bx++) {
          if (w <= 2 || (bx - c) ** 2 + (by - c) ** 2 <= limit) {
            offsets.push([bx - Math.floor(c), by - Math.floor(c)]);
          }
        }
      }
      this.brushCache.set(w, offsets);
    }
    return offsets;
  }

  private plot(points: number[][], rgba: Rgba, width: number): void {
    const brush = this.brush(width);
    for (const [x, y] of points) {
      for (const [dx, dy] of brush) this.put(x + dx, y + dy, rgba);
    }
  }

  /** Bresenham points: exactly one pixel per step, no gaps or doubled corners. */
  private linePoints(x0: number, y0: number, x1: number, y1: number): number[][] {
    x0 = Math.round(x0);
    y0 = Math.round(y0);
    x1 = Math.round(x1);
    y1 = Math.round(y1);
    const points: number[][] = [];
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      points.push([x0, y0]);
      if (x0 === x1 && y0 === y1) return points;
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

  line(x0: number, y0: number, x1: number, y1: number, color: string, width = 1): void {
    this.plot(this.linePoints(x0, y0, x1, y1), this.color(color), width);
  }

  /**
   * Quadratic Bézier from (x0, y0) to (x1, y1) bent toward (cx, cy), rasterised as one
   * connected "pixel-perfect" stroke: L-shaped corners are removed, as artists do by hand.
   */
  curve(x0: number, y0: number, cx: number, cy: number, x1: number, y1: number, color: string, width = 1): void {
    const length = Math.hypot(cx - x0, cy - y0) + Math.hypot(x1 - cx, y1 - cy);
    const steps = Math.max(2, Math.ceil(length * 3));
    const path: number[][] = [];
    const push = (p: number[]) => {
      const last = path[path.length - 1];
      if (last && last[0] === p[0] && last[1] === p[1]) return;
      path.push(p);
      if (path.length >= 3) {
        const [a, b, c] = path.slice(-3);
        const diagonal = Math.abs(a[0] - c[0]) === 1 && Math.abs(a[1] - c[1]) === 1;
        if (diagonal && (b[0] === a[0] || b[1] === a[1])) path.splice(path.length - 2, 1);
      }
    };
    let previous: number[] | undefined;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const u = 1 - t;
      const p = [
        Math.round(u * u * x0 + 2 * u * t * cx + t * t * x1),
        Math.round(u * u * y0 + 2 * u * t * cy + t * t * y1),
      ];
      // Dense sampling rarely skips a pixel, but bridge any gap so the stroke stays connected.
      if (previous && Math.max(Math.abs(p[0] - previous[0]), Math.abs(p[1] - previous[1])) > 1) {
        for (const q of this.linePoints(previous[0], previous[1], p[0], p[1]).slice(1)) push(q);
      } else {
        push(p);
      }
      previous = p;
    }
    this.plot(path, this.color(color), width);
  }

  private ellipseTest(cx: number, cy: number, rx: number, ry: number): (px: number, py: number) => boolean {
    // Shrinking the boundary by half a pixel² removes the lone "nub" pixels that exact ties
    // put on the widest row/column, and turns r=1 into the plus shape artists use.
    const limit = 1 - 0.5 / ((rx + 0.5) * (ry + 0.5));
    return (px, py) => {
      const nx = (px - cx) / (rx + 0.5);
      const ny = (py - cy) / (ry + 0.5);
      return nx * nx + ny * ny <= limit;
    };
  }

  ellipse(cx: number, cy: number, rx: number, ry: number, color: string, filled = true): void {
    const rgba = this.color(color);
    if (rx <= 0 || ry <= 0) return this.put(Math.round(cx), Math.round(cy), rgba);
    const inside = this.ellipseTest(cx, cy, rx, ry);
    for (let py = Math.floor(cy - ry); py <= Math.ceil(cy + ry); py++) {
      for (let px = Math.floor(cx - rx); px <= Math.ceil(cx + rx); px++) {
        if (!inside(px, py)) continue;
        // Outline = inside pixels with at least one 4-neighbour outside.
        if (filled || !inside(px + 1, py) || !inside(px - 1, py) || !inside(px, py + 1) || !inside(px, py - 1)) {
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
    if (!this.inside(x, y)) return;
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
      if (!this.inside(px, py)) continue;
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
    const box = this.clip(x, y, w, h);
    if (!box) return;
    const rgba = this.color(color);
    const [x0, y0, x1, y1] = box;
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        if (bayer(px, py) < amount) this.put(px, py, rgba);
      }
    }
  }

  /**
   * Multi-color gradient. "bands" = flat steps, "checker" = flat steps joined by a 2px 50%
   * checkerboard (the cleanest hand-made look), "dither" = smooth ordered dither.
   */
  gradient(
    x: number,
    y: number,
    w: number,
    h: number,
    colors: string[],
    direction: GradientDirection = "v",
    mode: GradientMode = "checker",
  ): void {
    if (colors.length === 0) return;
    const box = this.clip(x, y, w, h);
    if (!box) return;
    const rgbas = colors.map((c) => this.color(c));
    const n = rgbas.length;
    const left = Math.round(x);
    const top = Math.round(y);
    const width = Math.max(1, Math.round(w));
    const height = Math.max(1, Math.round(h));
    // Axis length in pixels and each pixel's position along it.
    const axis = direction === "h" ? width : direction === "v" ? height : Math.min(width, height) / 2;
    const along = (px: number, py: number): number => {
      if (direction === "h") return px - left + 0.5;
      if (direction === "v") return py - top + 0.5;
      const nx = (px + 0.5 - (left + width / 2)) / (width / 2);
      const ny = (py + 0.5 - (top + height / 2)) / (height / 2);
      return Math.min(1, Math.hypot(nx, ny)) * axis;
    };

    const [x0, y0, x1, y1] = box;
    const bandLength = axis / n;
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const a = along(px, py);
        let k: number;
        if (mode === "dither") {
          const s = Math.min(1, a / axis) * (n - 1);
          k = Math.floor(s);
          if (k < n - 1 && bayer(px, py) < s - k) k++;
        } else {
          k = Math.min(n - 1, Math.floor(a / bandLength));
          if (mode === "checker") {
            const j = Math.round(a / bandLength);
            if (j >= 1 && j <= n - 1 && Math.abs(a - j * bandLength) < 1) k = (px + py) % 2 === 0 ? j : j - 1;
          }
        }
        this.put(px, py, rgbas[k]);
      }
    }
  }

  /**
   * Ball/ellipsoid shaded in flat bands from a dark → light ramp, lit from `light`.
   * With 4+ colors the rim opposite the light gets one step of bounce light.
   */
  sphere(cx: number, cy: number, rx: number, ry: number, colors: string[], light: LightDirection = "tl"): void {
    if (colors.length === 0) return;
    const rgbas = colors.map((c) => this.color(c));
    const n = rgbas.length;
    if (rx <= 0 || ry <= 0) return this.put(Math.round(cx), Math.round(cy), rgbas[n - 1]);
    const [lx, ly, lz] = LIGHTS[light] ?? LIGHTS.tl;
    const len = Math.hypot(lx, ly, lz);
    const inside = this.ellipseTest(cx, cy, rx, ry);
    const pixels: { x: number; y: number; dot: number; rim: boolean }[] = [];
    for (let py = Math.floor(cy - ry); py <= Math.ceil(cy + ry); py++) {
      for (let px = Math.floor(cx - rx); px <= Math.ceil(cx + rx); px++) {
        if (!inside(px, py)) continue;
        const nx = (px - cx) / (rx + 0.5);
        const ny = (py - cy) / (ry + 0.5);
        const d2 = nx * nx + ny * ny;
        const nz = Math.sqrt(Math.max(0, 1 - d2));
        pixels.push({ x: px, y: py, dot: (nx * lx + ny * ly + nz * lz) / len, rim: d2 > 0.8 });
      }
    }
    // Bands follow lighting iso-lines, but their sizes come from target area shares
    // (quantiles): physically even bands give a huge highlight and a sliver of shadow.
    const sorted = pixels.map((p) => p.dot).sort((a, b) => a - b);
    const thresholds = sphereBandShares(n).map((share) => sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))]);
    for (const p of pixels) {
      let k = 0;
      while (k < n - 1 && p.dot >= thresholds[k]) k++;
      if (n >= 4 && k === 0 && p.rim) k = 1;
      this.put(p.x, p.y, rgbas[k]);
    }
  }

  /** Draws a write_pixels-style grid; '.' (transparent) leaves existing pixels alone. */
  stamp(rows: string[], palette: Record<string, string>, x: number, y: number): void {
    const image = decodeGrid({ palette, rows });
    const ox = Math.round(x);
    const oy = Math.round(y);
    for (let gy = 0; gy < image.height; gy++) {
      for (let gx = 0; gx < image.width; gx++) {
        const o = (gy * image.width + gx) * 4;
        if (image.data[o + 3] > 0) this.put(ox + gx, oy + gy, image.data.subarray(o, o + 4));
      }
    }
  }

  /** 3x5 pixel font; returns the text width in pixels. */
  text(x: number, y: number, text: string, color: string): number {
    const rgba = this.color(color);
    layoutText(text, Math.round(x), Math.round(y), (px, py) => this.put(px, py, rgba));
    return textWidth(text);
  }

  /**
   * Outlines every shape in the raster. "outside" paints transparent pixels touching art,
   * "inside" recolors the art's own edge pixels. 4-connectivity gives the clean 1px line
   * without doubled corners; 8 also fills diagonal gaps.
   */
  outline(color: OutlineColor, options: OutlineOptions = {}): void {
    const placement = options.placement ?? "outside";
    const neighbours = options.connectivity === 8 ? NEIGHBOURS_8 : NEIGHBOURS_4;
    const before = new Uint8Array(this.image.data);
    const fixed = typeof color === "string" ? this.color(color) : undefined;
    const lum = (o: number) => 0.299 * before[o] + 0.587 * before[o + 1] + 0.114 * before[o + 2];

    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const opaque = this.alphaAt(x, y, before) > 0;
        let edgeOffset = -1;
        if (placement === "outside" && !opaque) {
          // The darkest touching pixel decides an automatic outline color.
          for (const [dx, dy] of neighbours) {
            if (this.alphaAt(x + dx, y + dy, before) === 0) continue;
            const o = ((y + dy) * this.width + x + dx) * 4;
            if (edgeOffset < 0 || lum(o) < lum(edgeOffset)) edgeOffset = o;
          }
        } else if (placement === "inside" && opaque) {
          if (neighbours.some(([dx, dy]) => this.alphaAt(x + dx, y + dy, before) === 0)) {
            edgeOffset = (y * this.width + x) * 4;
          }
        }
        if (edgeOffset < 0) continue;
        if (fixed) {
          this.put(x, y, fixed);
        } else {
          const p = edgeOffset / 4;
          const edge = this.hexAt(p % this.width, Math.floor(p / this.width), before);
          this.put(x, y, this.color((color as (edge: string) => string)(edge)));
        }
      }
    }
  }

  /** Copies one half onto the other, mirrored around the raster's centre. */
  mirror(axis: "x" | "y" = "x", fromStart = true): void {
    const d = this.image.data;
    const { width, height } = this;
    if (axis === "x") {
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < Math.floor(width / 2); x++) {
          const src = fromStart ? x : width - 1 - x;
          const dst = width - 1 - src;
          d.copyWithin((y * width + dst) * 4, (y * width + src) * 4, (y * width + src) * 4 + 4);
        }
      }
    } else {
      for (let y = 0; y < Math.floor(height / 2); y++) {
        const src = fromStart ? y : height - 1 - y;
        const dst = height - 1 - src;
        d.copyWithin(dst * width * 4, src * width * 4, (src + 1) * width * 4);
      }
    }
  }

  /**
   * Recolors every pixel exactly equal to `from` (any fully transparent pixel for
   * "transparent"), optionally only inside a rectangle, e.g. one side of a mirrored sprite.
   */
  replace(from: string, to: string, x = 0, y = 0, w = this.width, h = this.height): void {
    const box = this.clip(x, y, w, h);
    if (!box) return;
    const a = this.color(from);
    const b = this.color(to);
    const d = this.image.data;
    const [x0, y0, x1, y1] = box;
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        const o = (py * this.width + px) * 4;
        const match =
          a[3] === 0 ? d[o + 3] === 0 : d[o] === a[0] && d[o + 1] === a[1] && d[o + 2] === a[2] && d[o + 3] === a[3];
        if (match) d.set(b, o);
      }
    }
  }

  private grab(x: number, y: number, w: number, h: number): RgbaImage {
    const out = createRgbaImage(Math.max(0, Math.round(w)), Math.max(0, Math.round(h)));
    const ox = Math.round(x);
    const oy = Math.round(y);
    for (let gy = 0; gy < out.height; gy++) {
      for (let gx = 0; gx < out.width; gx++) {
        if (!this.inside(ox + gx, oy + gy)) continue;
        const src = ((oy + gy) * this.width + ox + gx) * 4;
        out.data.set(this.image.data.subarray(src, src + 4), (gy * out.width + gx) * 4);
      }
    }
    return out;
  }

  private paste(image: RgbaImage, x: number, y: number, flip: string): void {
    const fx = flip.includes("x");
    const fy = flip.includes("y");
    for (let gy = 0; gy < image.height; gy++) {
      for (let gx = 0; gx < image.width; gx++) {
        const sx = fx ? image.width - 1 - gx : gx;
        const sy = fy ? image.height - 1 - gy : gy;
        const o = (sy * image.width + sx) * 4;
        if (image.data[o + 3] > 0) this.put(Math.round(x) + gx, Math.round(y) + gy, image.data.subarray(o, o + 4));
      }
    }
  }

  /** Duplicates a region so its top-left lands at (tx, ty); transparent pixels are skipped. */
  copy(x: number, y: number, w: number, h: number, tx: number, ty: number, flip = ""): void {
    this.paste(this.grab(x, y, w, h), tx, ty, flip);
  }

  /** Cut and paste: like copy, but the source area is cleared first. */
  move(x: number, y: number, w: number, h: number, tx: number, ty: number): void {
    const image = this.grab(x, y, w, h);
    this.rect(x, y, w, h, "transparent");
    this.paste(image, tx, ty, "");
  }
}
