import { getPalettePreset, PALETTE_PRESET_IDS } from "../pixel/palettes.js";
import { textWidth } from "../pixel/pixelFont.js";
import { bayer, type GradientDirection, type GradientMode, type LightDirection, type Raster } from "../pixel/Raster.js";
import { mix, ramp, shade, type RampOptions } from "./colorMath.js";
import type { NoiseFn } from "./noise.js";

/**
 * What a draw script can call. Kept next to the implementation so the two cannot drift;
 * it is embedded in the draw_script description, so every line costs tokens on every
 * request: one line per helper, defaults shown inline.
 */
export const API_DOC = `
JavaScript (ES2023, no imports/IO). Coordinates are relative to the region's top-left.
Colors: "#rgb" | "#rrggbb" | "#rrggbbaa" | "transparent". Hard edges only, no anti-aliasing.
Globals: W, H region size; F frame number (1-based), i frame index (0-based), n frame count,
  t = i/n (0..1, loops seamlessly). Single-frame runs: i=0, n=1, t=0.
Shapes:
  set(x,y,c)  get(x,y) -> "#rrggbb" ("#rrggbbaa" if translucent) | null if transparent/outside
  rect(x,y,w,h,c,r=0) filled, r rounds corners   frame(x,y,w,h,c) 1px border
  line(x0,y0,x1,y1,c,width=1)   curve(x0,y0,cx,cy,x1,y1,c,width=1) quadratic, pixel-perfect
  circle(cx,cy,r,c,filled=true)  ellipse(cx,cy,rx,ry,c,filled=true)  poly([[x,y],...],c)
  fill(x,y,c) bucket   dither(x,y,w,h,c,amount 0..1)   bayer(x,y) -> 0..1 dither threshold
  gradient(x,y,w,h,colors,dir="v"|"h"|"radial",mode="checker"|"bands"|"dither")
  sphere(cx,cy,r|[rx,ry],colors dark->light,light="tl"|"t"|"tr"|"l"|"r"|"bl"|"b"|"br"|"front")
  stamp(rows,palette,x,y) a write_pixels grid; '.' keeps what is below
  text(x,y,str,c) -> width  3x5 font: A-Z 0-9 .,!?:;'"-+=/%()<>_*#   textWidth(str)
Whole-region passes (run them after drawing):
  outline(c|null,{placement:"outside"|"inside",connectivity:4|8}) null = darker shade of the edge
  mirror(axis="x"|"y",fromStart=true) copy left/top half mirrored onto the other half
  replace(from,to,x?,y?,w?,h?) exact color swap, optionally inside a rect (shade one side)
  copy(x,y,w,h,tx,ty,flip=""|"x"|"y"|"xy") skips transparent   move(x,y,w,h,tx,ty) cut+paste
Color (return "#rrggbb"):
  ramp(base,steps=5,{hueShift=20,satShift=0.35}) -> [dark..light], base at index floor((steps-1)/2);
    shadows shift toward blue-violet, highlights toward yellow, saturation peaks mid-ramp
  shade(c,amount -1..1) hue-shifted darker(<0)/lighter(>0), ±0.4 ~ one ramp step   mix(c1,c2,t)
  pal(id) -> a preset's colors: ${PALETTE_PRESET_IDS.join(" ")}
Random: rand(n) -> int [0,n), rand() -> [0,1); restarts from the seed every frame.
  noise(x,y,scale=8,octaves=1) -> 0..1 smooth seeded value noise (same every frame).
console.log(...) is returned (max 20 lines). A top-level return ends the script.
`.trim();

/** Mutable per-frame state the host functions draw into; the runner swaps it between frames. */
export interface ScriptScope {
  raster: Raster;
  random: () => number;
  noise: NoiseFn;
}

export type HostFunction = (...args: unknown[]) => unknown;

const GRADIENT_DIRECTIONS = ["v", "h", "radial"];
const GRADIENT_MODES = ["checker", "bands", "dither"];
const LIGHTS = ["tl", "t", "tr", "l", "r", "bl", "b", "br", "front"];

function num(value: unknown, name: string): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new TypeError(`${name} must be a number, got ${JSON.stringify(value) ?? "undefined"}`);
  }
  return n;
}

function optNum(value: unknown, name: string, fallback: number): number {
  return value === undefined || value === null ? fallback : num(value, name);
}

function color(value: unknown, name = "color"): string {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string like "#1a1c2c", got ${JSON.stringify(value) ?? "undefined"}`);
  }
  return value;
}

function colorList(value: unknown, name = "colors"): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty array of colors, e.g. ramp("#3e8948", 4)`);
  }
  return value.map((c, i) => color(c, `${name}[${i}]`));
}

function oneOf<T extends string>(value: unknown, allowed: string[], name: string, fallback: T): T {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new TypeError(`${name} must be one of ${allowed.map((a) => `"${a}"`).join(", ")}, got ${JSON.stringify(value)}`);
  }
  return value as T;
}

function label(value: unknown): string {
  if (typeof value === "number") return String(value);
  if (typeof value !== "string") throw new TypeError(`str must be a string, got ${JSON.stringify(value) ?? "undefined"}`);
  return value;
}

function points(value: unknown): number[][] {
  if (!Array.isArray(value)) throw new TypeError("points must be [[x, y], ...]");
  return value.map((p, i) => {
    if (!Array.isArray(p) || p.length < 2) throw new TypeError(`point ${i} must be [x, y]`);
    return [num(p[0], `point ${i} x`), num(p[1], `point ${i} y`)];
  });
}

function rampOptions(value: unknown): RampOptions {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object") throw new TypeError("ramp options must be {hueShift?, satShift?}");
  const o = value as Record<string, unknown>;
  return {
    hueShift: o.hueShift === undefined ? undefined : num(o.hueShift, "hueShift"),
    satShift: o.satShift === undefined ? undefined : num(o.satShift, "satShift"),
  };
}

/**
 * Host functions by global name. Arguments arrive as plain JSON values from the sandbox,
 * so everything is validated here with messages that tell the model how to fix the call.
 */
export function createScriptApi(scope: ScriptScope): Record<string, HostFunction> {
  const r = () => scope.raster;
  return {
    set: (x, y, c) => r().set(num(x, "x"), num(y, "y"), color(c)),
    get: (x, y) => r().get(num(x, "x"), num(y, "y")),
    rect: (x, y, w, h, c, radius) =>
      r().rect(num(x, "x"), num(y, "y"), num(w, "w"), num(h, "h"), color(c), optNum(radius, "r", 0)),
    frame: (x, y, w, h, c) => r().frame(num(x, "x"), num(y, "y"), num(w, "w"), num(h, "h"), color(c)),
    line: (x0, y0, x1, y1, c, width) =>
      r().line(num(x0, "x0"), num(y0, "y0"), num(x1, "x1"), num(y1, "y1"), color(c), optNum(width, "width", 1)),
    curve: (x0, y0, cx, cy, x1, y1, c, width) =>
      r().curve(
        num(x0, "x0"),
        num(y0, "y0"),
        num(cx, "cx"),
        num(cy, "cy"),
        num(x1, "x1"),
        num(y1, "y1"),
        color(c),
        optNum(width, "width", 1),
      ),
    circle: (cx, cy, radius, c, filled) =>
      r().circle(num(cx, "cx"), num(cy, "cy"), num(radius, "r"), color(c), filled !== false),
    ellipse: (cx, cy, rx, ry, c, filled) =>
      r().ellipse(num(cx, "cx"), num(cy, "cy"), num(rx, "rx"), num(ry, "ry"), color(c), filled !== false),
    poly: (pts, c) => r().poly(points(pts), color(c)),
    fill: (x, y, c) => r().fill(num(x, "x"), num(y, "y"), color(c)),
    dither: (x, y, w, h, c, amount) =>
      r().dither(num(x, "x"), num(y, "y"), num(w, "w"), num(h, "h"), color(c), num(amount, "amount")),
    bayer: (x, y) => bayer(num(x, "x"), num(y, "y")),
    gradient: (x, y, w, h, colors, dir, mode) =>
      r().gradient(
        num(x, "x"),
        num(y, "y"),
        num(w, "w"),
        num(h, "h"),
        colorList(colors),
        oneOf<GradientDirection>(dir, GRADIENT_DIRECTIONS, "dir", "v"),
        oneOf<GradientMode>(mode, GRADIENT_MODES, "mode", "checker"),
      ),
    sphere: (cx, cy, radius, colors, light) => {
      const [rx, ry] = Array.isArray(radius)
        ? [num(radius[0], "rx"), num(radius[1], "ry")]
        : [num(radius, "r"), num(radius, "r")];
      r().sphere(num(cx, "cx"), num(cy, "cy"), rx, ry, colorList(colors), oneOf<LightDirection>(light, LIGHTS, "light", "tl"));
    },
    stamp: (rows, palette, x, y) => {
      if (!Array.isArray(rows) || rows.some((row) => typeof row !== "string")) {
        throw new TypeError('rows must be an array of strings, e.g. [".ab.", "abba"]');
      }
      if (!palette || typeof palette !== "object" || Array.isArray(palette)) {
        throw new TypeError('palette must be an object like {a: "#1a1c2c", b: "#f4f4f4"}');
      }
      r().stamp(rows as string[], palette as Record<string, string>, optNum(x, "x", 0), optNum(y, "y", 0));
    },
    text: (x, y, str, c) => r().text(num(x, "x"), num(y, "y"), label(str), color(c)),
    textWidth: (str) => textWidth(label(str)),
    outline: (c, options) => {
      const o = (options ?? {}) as Record<string, unknown>;
      const fixed = c === undefined || c === null || c === "auto" ? undefined : color(c);
      r().outline(fixed ?? ((edge) => shade(edge, -1)), {
        placement: oneOf(o.placement, ["outside", "inside"], "placement", "outside"),
        connectivity: o.connectivity === undefined ? 4 : num(o.connectivity, "connectivity") === 8 ? 8 : 4,
      });
    },
    mirror: (axis, fromStart) => r().mirror(oneOf(axis, ["x", "y"], "axis", "x"), fromStart !== false),
    replace: (from, to, x, y, w, h) =>
      r().replace(
        color(from, "from"),
        color(to, "to"),
        optNum(x, "x", 0),
        optNum(y, "y", 0),
        optNum(w, "w", r().width),
        optNum(h, "h", r().height),
      ),
    copy: (x, y, w, h, tx, ty, flip) =>
      r().copy(
        num(x, "x"),
        num(y, "y"),
        num(w, "w"),
        num(h, "h"),
        num(tx, "tx"),
        num(ty, "ty"),
        oneOf(flip === "" ? undefined : flip, ["x", "y", "xy"], "flip", ""),
      ),
    move: (x, y, w, h, tx, ty) =>
      r().move(num(x, "x"), num(y, "y"), num(w, "w"), num(h, "h"), num(tx, "tx"), num(ty, "ty")),
    ramp: (base, steps, options) => ramp(color(base, "base"), optNum(steps, "steps", 5), rampOptions(options)),
    shade: (c, amount) => shade(color(c), num(amount, "amount")),
    mix: (a, b, t) => mix(color(a, "c1"), color(b, "c2"), num(t, "t")),
    pal: (id) => [...getPalettePreset(oneOf(id, [...PALETTE_PRESET_IDS], "id", "pico8")).colors],
    noise: (x, y, scale, octaves) =>
      scope.noise(num(x, "x"), num(y, "y"), optNum(scale, "scale", 8), optNum(octaves, "octaves", 1)),
    rand: (n) => (n === undefined ? scope.random() : Math.floor(scope.random() * num(n, "n"))),
  };
}
