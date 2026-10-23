import type {
  IPaletteGateway,
  IPixelGateway,
  ISpriteGateway,
  LayerInfo,
  SpriteInfo,
  WriteImageRequest,
} from "../aseprite/AsepriteGateway.js";
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

/**
 * The colors forcePalette makes the sprite palette: only a palette the user picked by
 * name (a preset) or listed (custom). "current" already is the sprite palette, and a
 * style's own colors under "auto" never set it, forced or not.
 */
function chosenPaletteColors(options: ChatOptions): readonly string[] | undefined {
  const { palette } = options;
  if (palette === undefined || palette === "auto" || palette === "current") return undefined;
  const forced = forcedPalette(options);
  return forced && "colors" in forced ? forced.colors : undefined;
}

// Palettes come back as #rrggbbaa, presets are #rrggbb: compared as colors, not strings.
const sameColors = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((c, i) => formatHex(...parseHex(c)) === formatHex(...parseHex(b[i])));

type EnforcerGateway = Pick<ISpriteGateway, "getSpriteInfo"> & IPixelGateway & Pick<IPaletteGateway, "getPalette" | "setPalette">;

interface Cel {
  layer: string;
  frame: number;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * maxColors / forcePalette after a successful run: the bridge, not the model, has the
 * last word on the colors, on every cel of the layers the run drew and as ONE undo step
 * (one write for every cel), so "Undo" never leaves half a palette snap behind.
 */
export class PaletteEnforcer {
  constructor(private readonly gateway: EnforcerGateway) {}

  /**
   * Before the run: forcePalette with a preset or custom palette also makes it the
   * sprite palette, as the apply_palette setSpritePalette step of an unforced preset
   * does. Set up front rather than with the snap: a palette change and pixel writes are
   * separate Aseprite transactions, and the snap must stay ONE undo step. RGB only: an
   * indexed sprite's palette decides what its pixels show, so swapping it would recolor them.
   */
  async presetSpritePalette(sprite: number, options: ChatOptions): Promise<void> {
    const colors = chosenPaletteColors(options);
    if (!colors) return;
    const ref = { sprite };
    if ((await this.gateway.getSpriteInfo(ref)).colorMode !== "rgb") return;
    // An unchanged palette must not cost an undo step.
    if (sameColors((await this.gateway.getPalette(ref)).colors, colors)) return;
    await this.gateway.setPalette([...colors], ref);
  }

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
    const cels = celsOf(drawnLayers(drawn, info), info);
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

/** An image layer the extension lets the bridge write: unlocked, and no locked group above it. */
function isWritable(info: SpriteInfo, layer: LayerInfo): boolean {
  if (layer.isGroup || !layer.isEditable) return false;
  const byPath = new Map(info.layers.map((l) => [l.path, l]));
  for (let parent = layer.parent; parent !== undefined; parent = byPath.get(parent)?.parent) {
    if (byPath.get(parent)?.isEditable === false) return false;
  }
  return true;
}

/**
 * The layers the run drew, as writable paths of the sprite as it is now. Their frame
 * numbers are dropped on purpose: a run that inserts or deletes frames leaves them
 * pointing at other frames, and the rules hold for the layers the run drew.
 */
function drawnLayers(drawn: readonly DrawnCel[], info: SpriteInfo): string[] {
  // Layers deleted, locked or turned into groups since they were drawn are left alone.
  const writable = new Set(info.layers.filter((l) => isWritable(info, l)).map((l) => l.path));
  const layers = new Set<string>();
  for (const cel of drawn) {
    if ("everyLayer" in cel) {
      for (const layer of writable) layers.add(layer);
      continue;
    }
    const path = cel.layer === undefined ? defaultLayerPath(info) : layerPathOf(info, cel.layer);
    if (path !== undefined && writable.has(path)) layers.add(path);
  }
  return [...layers];
}

/** Every frame of those layers; empty cels read as transparent and are never written. */
function celsOf(layers: readonly string[], info: SpriteInfo): Cel[] {
  return layers.flatMap((layer) => info.frames.map((f) => ({ layer, frame: f.index })));
}

function describe(forced: ForcedPalette | undefined, maxColors: number | undefined, result: LimitedImages, changed: number): string {
  const rules = [forced && `${forced.label} palette`, maxColors !== undefined && `limit of ${maxColors} colors`]
    .filter(Boolean)
    .join(" and the ");
  if (changed === 0) return `Colors already follow the ${rules} (${plural(result.colorsAfter, "color")}).`;
  const merged = result.colorsAfter < result.colorsBefore ? ` (${result.colorsBefore} → ${plural(result.colorsAfter, "color")})` : "";
  return `Applied the ${rules}: ${plural(changed, "pixel")} recolored${merged}, as one undo step.`;
}
