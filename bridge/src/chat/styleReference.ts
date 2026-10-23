import { basename } from "node:path";
import type { IPixelGateway, ISpriteGateway, SpriteInfo } from "../aseprite/AsepriteGateway.js";
import type { LlmImage } from "../llm/LlmRunner.js";
import { isOpaque } from "../pixel/color.js";
import { previewScale, renderPreviewPng } from "../pixel/previewPng.js";
import type { RgbaImage } from "../pixel/RgbaImage.js";
import { analyzeImage } from "./canvasContext.js";
import type { StyleReference } from "./chatSchema.js";
import { UserFacingError } from "./chatUpdates.js";

/** The share of edge pixels one color needs before it counts as "the" outline color. */
const OUTLINE_SHARE = 0.5;
/** Edges this much darker (0-255 luma) than the fill read as a selective outline. */
const SELECTIVE_DARKER_BY = 20;

export interface OutlineFacts {
  kind: "solid" | "selective" | "none";
  /** solid: the color, #rrggbb. */
  color?: string;
  /** solid: share of the edge pixels in that color, 0-1. */
  share?: number;
}

export interface LoadedReference {
  /** For models that see images; attached after the run's own images. */
  image?: LlmImage;
  /** The prompt section (PromptContext.reference). */
  text: string;
}

const hex2 = (n: number) => n.toString(16).padStart(2, "0");
const luma = (d: Uint8Array, o: number) => 0.299 * d[o] + 0.587 * d[o + 1] + 0.114 * d[o + 2];

/**
 * How the art meets transparency: one dominant edge color is a solid outline, edges
 * clearly darker than the fill a selective one (sel-out), anything else no outline.
 */
export function outlineOf(image: RgbaImage): OutlineFacts {
  const { width, height, data } = image;
  const opaque = (x: number, y: number) => x >= 0 && y >= 0 && x < width && y < height && isOpaque(data[(y * width + x) * 4 + 3]);
  const edgeColors = new Map<number, number>();
  let edges = 0;
  let edgeLuma = 0;
  let fills = 0;
  let fillLuma = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!opaque(x, y)) continue;
      const o = (y * width + x) * 4;
      if (opaque(x - 1, y) && opaque(x + 1, y) && opaque(x, y - 1) && opaque(x, y + 1)) {
        fills++;
        fillLuma += luma(data, o);
        continue;
      }
      edges++;
      edgeLuma += luma(data, o);
      const key = (data[o] << 16) | (data[o + 1] << 8) | data[o + 2];
      edgeColors.set(key, (edgeColors.get(key) ?? 0) + 1);
    }
  }
  if (edges === 0) return { kind: "none" };
  const [key, count] = [...edgeColors.entries()].sort((a, b) => b[1] - a[1])[0];
  if (count / edges >= OUTLINE_SHARE) {
    return { kind: "solid", color: `#${hex2((key >> 16) & 255)}${hex2((key >> 8) & 255)}${hex2(key & 255)}`, share: count / edges };
  }
  if (fills > 0 && edgeLuma / edges < fillLuma / fills - SELECTIVE_DARKER_BY) return { kind: "selective" };
  return { kind: "none" };
}

function outlineText(outline: OutlineFacts): string {
  switch (outline.kind) {
    case "solid":
      return `a solid 1px outline in ${outline.color} (${Math.round((outline.share ?? 0) * 100)}% of the edge pixels)`;
    case "selective":
      return "a selective outline: edges are darker shades of each fill, no single outline color";
    case "none":
      return "no outline: shapes end in their own fill colors";
  }
}

/** The facts the prompt states: a model matches numbers and hex codes better than a look. */
export function describeReference(info: SpriteInfo, frame: number, image: RgbaImage, attached: boolean): string {
  const content = analyzeImage(image);
  const name = basename(info.filename) || `sprite #${info.id}`;
  const b = content.bounds;
  const more = content.totalColors > content.colors.length ? ` (${content.totalColors} in total)` : "";
  return [
    `Style reference: "${name}" (sprite #${info.id}), frame ${frame}, ${info.width}x${info.height}` +
      `${attached ? ", attached as the last image" : ""}. Match its style closely: palette, outline, proportions, ` +
      "level of detail and shading. Draw what the request asks for in that style; don't copy the reference itself.",
    `- Colors, most used first: ${content.colors.join(" ")}${more}. Reuse them; add a color only for a hue the reference lacks.`,
    `- Outline: ${outlineText(outlineOf(image))}.`,
    b ? `- Proportions: its subject is ${b.width}x${b.height} px on the ${info.width}x${info.height} canvas.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

type ReferenceGateway = Pick<ISpriteGateway, "getSpriteInfo"> & Pick<IPixelGateway, "readImage">;

/**
 * Reads options.reference (another open sprite) for a run: a preview the model can look
 * at plus the facts it can't measure from a picture.
 */
export async function loadStyleReference(
  gateway: ReferenceGateway,
  reference: StyleReference,
  withImage: boolean,
): Promise<LoadedReference> {
  const ref = { sprite: reference.sprite };
  const info = await gateway.getSpriteInfo(ref).catch((error: unknown) => {
    if (error instanceof Error && /not open/.test(error.message)) {
      throw new UserFacingError("The style reference sprite is not open anymore: open it again or clear the reference.");
    }
    throw error;
  });
  const frame = reference.frame ?? 1;
  if (frame > info.frames.length) {
    throw new UserFacingError(`The style reference has ${info.frames.length} frame(s), so frame ${frame} doesn't exist.`);
  }
  const { image } = await gateway.readImage({ ...ref, frame, flattened: true });
  if (!image.data.some((v, i) => i % 4 === 3 && v > 0)) {
    throw new UserFacingError(`Frame ${frame} of the style reference is empty: pick a frame with art.`);
  }
  const png = withImage
    ? { mediaType: "image/png" as const, base64: renderPreviewPng(image, previewScale(image.width, image.height, 512)).toString("base64") }
    : undefined;
  return { image: png, text: describeReference(info, frame, image, png !== undefined) };
}
