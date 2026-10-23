import type { IPaletteGateway, IPixelGateway, ISpriteGateway, SpriteInfo, WriteImageRequest } from "../aseprite/AsepriteGateway.js";
import type { DrawnCel } from "../aseprite/SpriteActivity.js";
import { defaultLayerPath } from "../canvas/CanvasService.js";
import { formatHex, isOpaque, packRgb, parseHex } from "../pixel/color.js";
import { getPalettePreset } from "../pixel/palettes.js";
import { extractPalette, mapToPalette } from "../pixel/quantize.js";
import type { RgbaImage } from "../pixel/RgbaImage.js";
import type { ChatOptions } from "./chatSchema.js";
import { PALETTE_LABELS, STYLE_SPECS } from "./styleSpecs.js";

/**
 * What forcePalette snaps to: known colors, or the run sprite's own palette (read at the
 * end). `label` names it in "the <label> palette".
 */
export type ForcedPalette = { label: string; colors: readonly string[] } | { label: string; current: true };

/**
 * The palette forcePalette snaps to, or undefined when there is nothing to snap to
 * ("auto" with a style that doesn't fix its colors). The prompt and the enforcement
 * both ask this, so the model is never promised a snap that doesn't happen.
 */
export function forcedPalette(options: ChatOptions): ForcedPalette | undefined {
  if (!options.forcePalette) return undefined;
  const { palette } = options;
  if (palette === "custom") return options.customPalette ? { label: "custom", colors: options.customPalette } : undefined;
  if (palette === "current") return { label: "sprite", current: true };
  const preset = palette === undefined || palette === "auto" ? STYLE_SPECS[options.style ?? "auto"].fixedPalette : palette;
  return preset ? { label: PALETTE_LABELS[preset], colors: getPalettePreset(preset).colors } : undefined;
}

export interface ColorRules {
  /** Snap every opaque pixel to these colors. */
  palette?: readonly string[];
  /** Then merge down to at most this many colors over all images together. */
  maxColors?: number;
}

export interface LimitedImages {
  images: RgbaImage[];
  colorsBefore: number;
  colorsAfter: number;
}

/** Distinct opaque colors over all images (what a color limit counts). */
export function countColors(images: readonly RgbaImage[]): number {
  const colors = new Set<number>();
  for (const { data } of images) {
    for (let o = 0; o < data.length; o += 4) if (isOpaque(data[o + 3])) colors.add(packRgb(data[o], data[o + 1], data[o + 2]));
  }
  return colors.size;
}

/**
 * Applies the rules to images that are judged together (every cel a run drew), so a
 * color limit holds for the sprite, not per layer. Images that already follow the
 * rules come back unchanged (same object), which callers use to skip their write.
 */
export function limitColors(images: readonly RgbaImage[], rules: ColorRules): LimitedImages {
  const colorsBefore = countColors(images);
  let out = [...images];
  if (rules.palette && rules.palette.length > 0) {
    const palette = rules.palette;
    out = out.map((image) => mapToPalette(image, palette));
  }
  if (rules.maxColors !== undefined && countColors(out) > rules.maxColors) {
    // extractPalette keeps existing colors (cluster centres snap to real pixels), so a
    // palette snap above survives and hand-picked accents are not averaged away.
    const palette = extractPalette(out, rules.maxColors);
    out = out.map((image) => mapToPalette(image, palette));
  }
  return { images: out.map((image, i) => (sameImage(image, images[i]) ? images[i] : image)), colorsBefore, colorsAfter: countColors(out) };
}

// Fully transparent pixels are equal whatever their RGB: mapping clears it to 0, which
// is no visible change and must not cost an undo step.
function samePixel(a: Uint8Array, b: Uint8Array, o: number): boolean {
  if (a[o + 3] === 0 && b[o + 3] === 0) return true;
  return a[o] === b[o] && a[o + 1] === b[o + 1] && a[o + 2] === b[o + 2] && a[o + 3] === b[o + 3];
}

function changedPixels(a: RgbaImage, b: RgbaImage): number {
  let n = 0;
  for (let o = 0; o < a.data.length; o += 4) if (!samePixel(a.data, b.data, o)) n++;
  return n;
}

function sameImage(a: RgbaImage, b: RgbaImage): boolean {
  return a.width === b.width && a.height === b.height && changedPixels(a, b) === 0;
}

type EnforcerGateway = Pick<ISpriteGateway, "getSpriteInfo"> & IPixelGateway & Pick<IPaletteGateway, "getPalette">;

interface Cel {
  layer: string;
  frame: number;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * maxColors / forcePalette after a successful run: the bridge, not the model, has the
 * last word on the colors, on exactly the cels the run drew and as ONE undo step (one
 * write for every cel), so "Undo" never leaves half a palette snap behind.
 */
export class PaletteEnforcer {
  constructor(private readonly gateway: EnforcerGateway) {}

  /** Returns the status line for the chat, or undefined when no rule applies. */
  async enforce(sprite: number, drawn: readonly DrawnCel[], options: ChatOptions): Promise<string | undefined> {
    const forced = forcedPalette(options);
    const maxColors = options.maxColors;
    if (!forced && maxColors === undefined) return undefined;

    const ref = { sprite };
    const info = await this.gateway.getSpriteInfo(ref);
    // Indexed and grayscale sprites can only hold their own palette's colors anyway, and
    // writing new colors would just snap back to it.
    if (info.colorMode !== "rgb") {
      return `Palette rules not applied: the sprite is in ${info.colorMode} mode, which already limits it to its own palette.`;
    }
    const cels = resolveCels(drawn, info);
    if (cels.length === 0) return undefined;

    const palette = forced ? await this.paletteColors(forced, sprite) : undefined;
    const images: RgbaImage[] = [];
    for (const cel of cels) images.push((await this.gateway.readImage({ ...cel, ...ref })).image);
    const result = limitColors(images, { palette, maxColors });

    const writes: WriteImageRequest[] = [];
    let changed = 0;
    result.images.forEach((image, i) => {
      if (image === images[i]) return;
      changed += changedPixels(images[i], image);
      writes.push({ x: 0, y: 0, image, ...cels[i] });
    });
    if (writes.length > 0) await this.gateway.writeImages(writes, ref);
    return describe(forced, maxColors, result, changed);
  }

  private async paletteColors(forced: ForcedPalette, sprite: number): Promise<string[]> {
    if ("colors" in forced) return [...forced.colors];
    const { colors } = await this.gateway.getPalette({ sprite });
    // An indexed palette's transparent slot is not a color anyone paints with.
    return colors.filter((c) => parseHex(c)[3] > 0).map((c) => formatHex(...parseHex(c)));
  }
}

/**
 * A layer name as written (path, path suffix or bare name) to the path get_sprite_info
 * lists, resolved in the order the extension does (U.findLayer).
 */
function layerPathOf(info: SpriteInfo, name: string): string | undefined {
  const layers = info.layers;
  return (
    layers.find((l) => l.path === name)?.path ??
    (name.includes("/") ? layers.find((l) => l.path.endsWith(`/${name}`))?.path : undefined) ??
    layers.find((l) => l.name === name)?.path
  );
}

/** The run's drawn cels as concrete, writable layer/frame pairs of the sprite as it is now. */
function resolveCels(drawn: readonly DrawnCel[], info: SpriteInfo): Cel[] {
  // Layers deleted, locked or turned into groups since they were drawn are left alone.
  const writable = new Set(info.layers.filter((l) => !l.isGroup && l.isEditable).map((l) => l.path));
  const frameCount = info.frames.length;
  const cels = new Map<string, Cel>();
  const add = (path: string | undefined, frame: number) => {
    if (path === undefined || !writable.has(path) || frame < 1 || frame > frameCount) return;
    cels.set(`${path}\u0000${frame}`, { layer: path, frame });
  };
  for (const cel of drawn) {
    if ("everyLayer" in cel) {
      for (const layer of writable) add(layer, cel.frame);
    } else {
      add(cel.layer === undefined ? defaultLayerPath(info) : layerPathOf(info, cel.layer), cel.frame ?? info.activeFrame);
    }
  }
  return [...cels.values()];
}

function describe(forced: ForcedPalette | undefined, maxColors: number | undefined, result: LimitedImages, changed: number): string {
  const rules = [forced && `${forced.label} palette`, maxColors !== undefined && `limit of ${maxColors} colors`]
    .filter(Boolean)
    .join(" and the ");
  if (changed === 0) return `Colors already follow the ${rules} (${plural(result.colorsAfter, "color")}).`;
  const merged = result.colorsAfter < result.colorsBefore ? ` (${result.colorsBefore} → ${plural(result.colorsAfter, "color")})` : "";
  return `Applied the ${rules}: ${plural(changed, "pixel")} recolored${merged}, as one undo step.`;
}
