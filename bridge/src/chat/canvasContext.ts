import { basename } from "node:path";
import type { IAsepriteGateway, Rect, SpriteInfo } from "../aseprite/AsepriteGateway.js";
import type { LlmImage } from "../llm/LlmRunner.js";
import { filmstrip } from "../pixel/filmstrip.js";
import { previewScale, renderPreviewPng } from "../pixel/previewPng.js";
import type { RgbaImage } from "../pixel/RgbaImage.js";

// Reading is one WebSocket round trip of ~8 bytes/pixel; beyond this the model can call view_sprite itself.
const MAX_ANALYZED_PIXELS = 512 * 512;
const MAX_LISTED_COLORS = 24;
const MAX_LISTED_LAYERS = 24;
const MAX_LISTED_TAGS = 12;
const MAX_LISTED_PALETTE = 64;
const MAX_FILMSTRIP_FRAMES = 8;

export interface ContentSummary {
  isEmpty: boolean;
  /** Bounding box of non-transparent pixels. */
  bounds?: Rect;
  /** #rrggbb, most used first, capped at MAX_LISTED_COLORS. */
  colors: string[];
  totalColors: number;
}

export interface CanvasSnapshot {
  info: SpriteInfo;
  /** Active frame, all visible layers. Undefined when the canvas was too large to read cheaply. */
  content?: ContentSummary;
  /** Sprite palette as #rrggbb(aa), only when asked for. */
  palette?: string[];
  preview?: { image: LlmImage; note: string };
}

/** "if_content": a picture of an empty canvas tells the model nothing. */
export type PreviewMode = "never" | "if_content" | "always";

export interface CaptureOptions {
  preview: PreviewMode;
  /** Preview every frame side by side (animations) instead of the active frame. */
  allFrames?: boolean;
  /** Include the sprite palette (palette option "current"). */
  palette?: boolean;
}

type SnapshotGateway = Pick<IAsepriteGateway, "getSpriteInfo" | "readImage" | "getPalette">;

const hex2 = (n: number) => n.toString(16).padStart(2, "0");

export function analyzeImage(image: RgbaImage): ContentSummary {
  const counts = new Map<number, number>();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  const { data, width, height } = image;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (data[o + 3] === 0) continue;
      const key = (data[o] << 16) | (data[o + 1] << 8) | data[o + 2];
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return { isEmpty: true, colors: [], totalColors: 0 };
  const colors = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_LISTED_COLORS)
    .map(([key]) => `#${hex2((key >> 16) & 255)}${hex2((key >> 8) & 255)}${hex2(key & 255)}`);
  return {
    isEmpty: false,
    bounds: { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 },
    colors,
    totalColors: counts.size,
  };
}

function pngImage(image: RgbaImage, target: number): { image: LlmImage; scale: number } {
  const scale = previewScale(image.width, image.height, target);
  return { image: { mediaType: "image/png", base64: renderPreviewPng(image, scale).toString("base64") }, scale };
}

/**
 * Chosen frames (visible layers) as one picture, left to right then top to bottom: the
 * key frames of an in-between, or a finished animation another one must match.
 */
export async function framesPreview(
  gateway: Pick<IAsepriteGateway, "readImage">,
  sprite: number,
  frames: readonly number[],
): Promise<LlmImage> {
  const images: RgbaImage[] = [];
  for (const frame of frames) images.push((await gateway.readImage({ sprite, frame, flattened: true })).image);
  return pngImage(images.length === 1 ? images[0] : filmstrip(images, 8), images.length === 1 ? 512 : 768).image;
}

/** A sprite the bridge has just created: nothing to read, it is empty by construction. */
export function freshSnapshot(info: SpriteInfo): CanvasSnapshot {
  return { info, content: { isEmpty: true, colors: [], totalColors: 0 } };
}

/**
 * Everything the model would otherwise fetch with its first tool calls (get_sprite_info,
 * view_sprite, get_palette), gathered by the bridge in a few fast RPCs.
 */
export async function captureCanvas(
  gateway: SnapshotGateway,
  sprite: number,
  options: CaptureOptions,
): Promise<CanvasSnapshot> {
  const info = await gateway.getSpriteInfo({ sprite });
  const snapshot: CanvasSnapshot = { info };

  if (options.palette) snapshot.palette = (await gateway.getPalette({ sprite })).colors;
  if (info.width * info.height > MAX_ANALYZED_PIXELS) return snapshot;

  const { image } = await gateway.readImage({ sprite, frame: info.activeFrame, flattened: true });
  snapshot.content = analyzeImage(image);

  const wanted = options.preview === "always" || (options.preview === "if_content" && !snapshot.content.isEmpty);
  if (!wanted) return snapshot;

  const frameCount = Math.min(info.frames.length, MAX_FILMSTRIP_FRAMES);
  if (options.allFrames && frameCount > 1) {
    const frames: RgbaImage[] = [];
    for (let frame = 1; frame <= frameCount; frame++) {
      frames.push(
        frame === info.activeFrame
          ? image
          : (await gateway.readImage({ sprite, frame, flattened: true })).image,
      );
    }
    const png = pngImage(filmstrip(frames, 4), 768);
    snapshot.preview = {
      image: png.image,
      note:
        `A preview of frames 1-${frameCount} is attached, left to right then top to bottom ` +
        `(upscaled ${png.scale}x, checkerboard = transparent).`,
    };
  } else {
    const png = pngImage(image, 512);
    snapshot.preview = {
      image: png.image,
      note: `A preview of frame ${info.activeFrame} is attached (upscaled ${png.scale}x, checkerboard = transparent).`,
    };
  }
  return snapshot;
}

function describeLayers(info: SpriteInfo): string {
  if (info.layers.length === 0) return "none";
  const names = info.layers.slice(0, MAX_LISTED_LAYERS).map((layer) => {
    const flags = [
      layer.path === info.activeLayer || layer.name === info.activeLayer ? "active" : "",
      layer.isGroup ? "group" : "",
      layer.isVisible ? "" : "hidden",
      layer.isEditable ? "" : "locked",
    ].filter(Boolean);
    return `"${layer.path}"${flags.length ? ` (${flags.join(", ")})` : ""}`;
  });
  const more = info.layers.length - names.length;
  return names.join(", ") + (more > 0 ? `, and ${more} more` : "");
}

function describeFrames(info: SpriteInfo): string {
  const durations = info.frames.map((f) => f.durationMs);
  const min = Math.min(...durations);
  const max = Math.max(...durations);
  const timing = min === max ? `${min} ms each` : `${min}-${max} ms`;
  return `${info.frames.length} (${timing}), active frame ${info.activeFrame}`;
}

function describeTags(info: SpriteInfo): string {
  if (info.tags.length === 0) return "none";
  const tags = info.tags
    .slice(0, MAX_LISTED_TAGS)
    .map((t) => `"${t.name}" ${t.from}-${t.to} ${t.direction}`);
  const more = info.tags.length - tags.length;
  return tags.join(", ") + (more > 0 ? `, and ${more} more` : "");
}

function describeContent(snapshot: CanvasSnapshot): string {
  const frame = snapshot.info.activeFrame;
  const content = snapshot.content;
  if (!content) return `frame ${frame} content: not analysed (large canvas); call view_sprite if you need to see it`;
  if (content.isEmpty || !content.bounds) return `frame ${frame} is empty (fully transparent)`;
  const b = content.bounds;
  const more = content.totalColors > content.colors.length ? " ..." : "";
  return (
    `frame ${frame} has pixels within x=${b.x}-${b.x + b.width - 1}, y=${b.y}-${b.y + b.height - 1}; ` +
    `${content.totalColors} colors, most used first: ${content.colors.join(" ")}${more}`
  );
}

const compactColor = (c: string) => (c.length === 9 && c.toLowerCase().endsWith("ff") ? c.slice(0, 7) : c);

/** Compact text the prompt carries instead of the model calling get_sprite_info. */
export function describeCanvas(snapshot: CanvasSnapshot): string {
  const { info } = snapshot;
  const lines = [
    `Current canvas: sprite #${info.id} "${basename(info.filename)}". Every tool call in this run already ` +
      "targets it, so you don't need get_sprite_info first.",
    `- size ${info.width}x${info.height} px, ${info.colorMode} color mode, palette of ${info.paletteSize} colors`,
    `- frames: ${describeFrames(info)}`,
    `- layers (bottom to top): ${describeLayers(info)}`,
    `- tags: ${describeTags(info)}`,
  ];
  if (info.selection) {
    const s = info.selection;
    lines.push(`- selection: x=${s.x} y=${s.y} ${s.width}x${s.height}`);
  }
  lines.push(`- ${describeContent(snapshot)}`);
  if (snapshot.palette) {
    const colors = snapshot.palette.slice(0, MAX_LISTED_PALETTE).map(compactColor);
    const more = snapshot.palette.length > colors.length ? " ..." : "";
    lines.push(`- sprite palette (${snapshot.palette.length}): ${colors.join(" ")}${more}`);
  }
  if (snapshot.preview) lines.push(snapshot.preview.note);
  return lines.join("\n");
}
