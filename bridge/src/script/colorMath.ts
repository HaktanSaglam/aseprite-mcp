import { parseColor } from "../pixel/PixelGridCodec.js";

/**
 * Pixel-art color helpers for draw scripts. Ramps follow the classic hand-made recipe
 * instead of plain lightness steps: shadows rotate toward blue-violet, highlights toward
 * yellow, and saturation peaks in the midtones. Flat "add black / add white" ramps are
 * the main reason generated sprites look muddy.
 */

export interface RampOptions {
  /** Degrees the darkest/lightest entries rotate toward violet/yellow (0 = no hue shift). */
  hueShift?: number;
  /** 0..1: how much saturation drops at the extremes. */
  satShift?: number;
}

const SHADOW_HUE = 250;
const HIGHLIGHT_HUE = 60;
const DEFAULT_HUE_SHIFT = 20;
const DEFAULT_SAT_SHIFT = 0.35;
// Below this HSV saturation a hue is meaningless, so shading tints toward the target hue.
const GRAY_SATURATION = 0.08;
const MAX_RAMP_STEPS = 32;

type Hsv = [number, number, number];

export function toHex(r: number, g: number, b: number, a = 255): string {
  const hex = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");
  return a >= 255 ? `#${hex(r)}${hex(g)}${hex(b)}` : `#${hex(r)}${hex(g)}${hex(b)}${hex(a)}`;
}

/** WCAG relative luminance (0..1); the value check pixel artists do by desaturating. */
export function luminance(color: string): number {
  const [r, g, b] = parseColor(color);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function rgbToHsv(r: number, g: number, b: number): Hsv {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return [h, max === 0 ? 0 : d / max, max];
}

export function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const m = v - c;
  const [r, g, b] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/** Rotates `hue` toward `target` along the shorter arc, never past it. */
function rotateToward(hue: number, target: number, degrees: number): number {
  const diff = ((target - hue + 540) % 360) - 180;
  if (Math.abs(diff) <= degrees) return target;
  return (hue + Math.sign(diff) * degrees + 360) % 360;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** The core of ramp(): one HSV color moved `amount` (-1 darkest .. 1 lightest) along its ramp. */
function shadeHsv([h, s, v]: Hsv, amount: number, options: RampOptions): Hsv {
  const hueShift = options.hueShift ?? DEFAULT_HUE_SHIFT;
  const satShift = clamp01(options.satShift ?? DEFAULT_SAT_SHIFT);
  const k = Math.min(1, Math.abs(amount));
  if (k === 0) return [h, s, v];
  const dark = amount < 0;
  const target = dark ? SHADOW_HUE : HIGHLIGHT_HUE;

  let hue: number;
  let sat: number;
  if (s < GRAY_SATURATION) {
    // Neutral grays get a faint cool/warm tint, the way artists shade metal and stone.
    hue = target;
    sat = s + (hueShift / DEFAULT_HUE_SHIFT) * (dark ? 0.12 : 0.06) * k;
  } else {
    hue = rotateToward(h, target, hueShift * k);
    sat = dark
      ? s * (1 + 0.3 * Math.sin(Math.PI * k)) * (1 - satShift * k * k)
      : s * (1 - (0.25 + satShift) * k);
  }
  const value = dark ? v * (1 - 0.65 * k ** 1.4) : v + (1 - v) * 0.9 * k;
  return [hue, clamp01(sat), clamp01(value)];
}

/** Hue-shifted darken (amount < 0) or lighten (amount > 0); amount is clamped to -1..1. */
export function shade(color: string, amount: number, options: RampOptions = {}): string {
  const [r, g, b, a] = parseColor(color);
  const [h, s, v] = shadeHsv(rgbToHsv(r, g, b), Math.max(-1, Math.min(1, amount)), options);
  return toHex(...hsvToRgb(h, s, v), a);
}

/**
 * `steps` colors ordered dark → light with `base` in the middle (index floor((steps-1)/2)).
 * Very dark or very light bases move toward the matching end, otherwise the ramp would
 * repeat black or white.
 */
export function ramp(base: string, steps = 5, options: RampOptions = {}): string[] {
  const n = Math.max(1, Math.min(MAX_RAMP_STEPS, Math.round(steps)));
  const [r, g, b, a] = parseColor(base);
  const hsv = rgbToHsv(r, g, b);
  const [, s, v] = hsv;
  const last = n - 1;

  let baseIndex = Math.floor(last / 2);
  const lightRoom = 1 - v + s * 0.6;
  if (v < 0.2) baseIndex = Math.round(baseIndex * (v / 0.2));
  else if (lightRoom < 0.2) baseIndex = last - Math.round((last - baseIndex) * (lightRoom / 0.2));

  const colors: string[] = [];
  for (let i = 0; i < n; i++) {
    if (i === baseIndex) {
      colors.push(toHex(r, g, b, a));
      continue;
    }
    const amount =
      i < baseIndex
        ? -((baseIndex - i) / baseIndex) * sideSpan(baseIndex)
        : ((i - baseIndex) / (last - baseIndex)) * sideSpan(last - baseIndex);
    colors.push(toHex(...hsvToRgb(...shadeHsv(hsv, amount, options)), a));
  }
  return colors;
}

/**
 * How far a ramp reaches on a side with `steps` entries. Short ramps stay near the base
 * (a 3-color ramp's shadow is a usable shadow, not black); 3+ steps reach the extremes.
 */
function sideSpan(steps: number): number {
  return Math.min(1, 0.15 + 0.3 * steps);
}

/** Straight RGBA interpolation; t is clamped to 0..1. */
export function mix(a: string, b: string, t: number): string {
  const ca = parseColor(a);
  const cb = parseColor(b);
  const k = clamp01(t);
  const at = (i: number) => ca[i] + (cb[i] - ca[i]) * k;
  return toHex(at(0), at(1), at(2), at(3));
}
