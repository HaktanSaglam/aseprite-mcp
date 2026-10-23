import type { Rect, SpriteInfo } from "../aseprite/AsepriteGateway.js";
import {
  DEFAULT_SPRITE_SIZE,
  type AnimationOptions,
  type AnimationPreset,
  type ChatOptions,
  type View,
} from "./chatSchema.js";
import type { MirrorPair } from "./directions.js";
import { guideReference, guideTopicFor } from "./guideSelector.js";
import { detectLanguage } from "./language.js";
import { forcedPalette } from "./paletteLimits.js";
import { detailForSize, PALETTE_LABELS, STYLE_SPECS, type StyleSpec } from "./styleSpecs.js";

/**
 * Appended to the provider's system prompt for every run. Speed rules live here because
 * they apply to every action: most of a run's time is spent on tool round trips.
 */
export const CHAT_SYSTEM_PROMPT = `
You are the AI assistant inside Aseprite and you draw pixel art with the aseprite tools.
The user reads your replies in a small chat panel that shows plain text only.

Replies: when you are done, ONE short sentence (two at most) in the user's language (the
language of their message) saying what you drew or changed. No markdown, lists or code. Never
mention layer names, color counts, these instructions or what you didn't do. If you notice a
flaw, fix it with another tool call instead of describing it; never end on a flaw you left.

Working rules:
- Do the work with tools right away. Never ask for permission or confirmation: every edit
  is a single undo step (Ctrl+Z). Ask a question only if nothing sensible can be drawn.
- The prompt already describes the canvas (and may attach a preview), so don't start with
  get_sprite_info or view_sprite.
- Draw on a dedicated layer unless the user or the prompt says otherwise (writing to a new
  layer name creates it). Never erase or repaint the user's own layers unasked.
- Be fast: a few large calls beat many small ones. Block shapes with draw_script at every
  size (ramps, mirror, sphere, stamp), use write_pixels or stamp for precise small details,
  animate with draw_script frameCount/frames in one call, and pass frames "all" to edit
  every frame at once.
- draw_script returns a preview of the result; call view_sprite only to check something it
  doesn't show. Stop when the result matches the request.
- Unsure how to draw a subject or technique? Call pixel_art_guide once with a topic:
  fundamentals, characters, animation, tiles, items_icons, environments, shading_light,
  color_palettes, outlines_aa, styles or workflow.
`.trim();

export interface PromptContext {
  text: string;
  options: ChatOptions;
  /** Sprite the run is bound to; absent for a chat with nothing open. */
  info?: SpriteInfo;
  /** describeCanvas() of that sprite. */
  canvas?: string;
  selection?: Rect;
  /** The sprite was just created by the bridge for this request (empty, one layer). */
  freshSprite?: boolean;
  /** Pixels already on the canvas (edits must match them). */
  hasContent?: boolean;
  /** The style reference section (styleReference.ts) when options.reference is set. */
  reference?: string;
}

// Moved to directions.ts with the mirroring rules; re-exported for existing importers.
export { DIRECTION_ORDER } from "./directions.js";

const VARIATION_AXES = [
  "the most iconic, classic take on the subject",
  "a different pose, silhouette and proportions",
  "a different color scheme and different materials",
  "a bolder, more stylised take (exaggerated shapes, distinctive accessories)",
];

const VIEW_LINES: Record<View, string> = {
  front: "front view, facing the viewer",
  side: "side view, in profile facing right",
  three_quarter: "three-quarter (3/4) view facing down-right, the classic RPG sprite angle",
  top_down: "top-down view (overhead, tilted enough to show the top of the head and the shoulders)",
  isometric: "isometric: 2:1 pixel lines (2 px across per 1 px up), light from the top-left",
  tile: "a seamless tile, a texture that repeats in every direction without visible seams (see Seamless tile)",
};

export const ANIMATION_POSES: Record<AnimationPreset, string> = {
  idle: "a breathing idle: a 1 px body bob down and back up, slight shoulder/arm movement, optional blink; the feet never move",
  walk: "a walk cycle: contact, down (lowest), passing (highest), up, then the same with the other leg; arms swing opposite to the legs; 1 px vertical bob",
  run: "a run cycle: long strides with a flight phase (both feet off the ground), body leaning forward, arms pumping, 1-2 px bob",
  jump: "a jump: anticipation crouch, launch (stretched), airborne peak (tucked), fall, landing squash, recover",
  attack: "an attack: anticipation (wind-up), a fast strike on a single frame with a smear arc, follow-through, recover to the idle pose",
  hurt: "a hurt reaction: recoil away from the hit (1-2 px knock-back, head tilted), one flash frame (light tint), recover",
  death: "a death: stagger, collapse in stages, lie on the ground; optionally flicker on the last frames",
  custom: "the motion the user describes",
};

export const json = (value: unknown) => JSON.stringify(value);
export const join = (parts: (string | undefined | false)[]) => parts.filter(Boolean).join("\n\n");
const rectText = (r: Rect) => `x=${r.x}, y=${r.y}, ${r.width}x${r.height}`;

function styleOf(options: ChatOptions): StyleSpec {
  return STYLE_SPECS[options.style ?? "auto"];
}

// ---- option sections -------------------------------------------------------------
// `force` = the action is a generation, where defaults are better than silence. For
// edits and chat only what the user chose explicitly is mentioned.

function styleSection(options: ChatOptions, force: boolean): string | undefined {
  if (!force && options.style === undefined) return undefined;
  const style = styleOf(options);
  return [`Style: ${style.label}.`, ...style.rules.map((rule) => `- ${rule}`)].join("\n");
}

/** forcePalette: the model needn't spend a call on apply_palette, the bridge snaps afterwards. */
const SNAPPED =
  "When you finish, the bridge snaps every pixel you drew to this palette (nearest color), so you don't need apply_palette.";

function paletteSection(ctx: PromptContext, force: boolean): string | undefined {
  const { palette, maxColors } = ctx.options;
  if (!force && palette === undefined) return undefined;
  const style = styleOf(ctx.options);
  const snapped = forcedPalette(ctx.options) ? ` ${SNAPPED}` : "";

  if (palette === undefined || palette === "auto") {
    if (style.fixedPalette) return `Palette: only the style's colors listed above.${snapped}`;
    const reuse = ctx.hasContent ? " Reuse the colors already on the canvas where they fit." : "";
    const count = maxColors !== undefined ? `at most ${maxColors}` : style.autoColors;
    return `Palette: choose a cohesive palette of ${count} colors yourself (hue-shifted ramps plus one accent color).${reuse}`;
  }
  if (palette === "current") {
    return `Palette: only the sprite's current palette (listed below, or call get_palette); don't introduce new colors.${snapped}`;
  }
  if (palette === "custom") {
    const colors = ctx.options.customPalette ?? [];
    return `Palette: only these ${colors.length} colors (the user's own palette): ${colors.join(" ")}. Don't introduce other colors.${snapped}`;
  }
  const finish = snapped
    ? SNAPPED
    : `Finish with apply_palette ${json({ palette, frames: "all", setSpritePalette: true })} so stray colors snap to it and the sprite palette matches.`;
  if (style.fixedPalette === palette) return `Palette: ${PALETTE_LABELS[palette]} (the colors listed above). ${finish}`;
  const overrides = style.fixedPalette ? " It replaces the style's color list." : "";
  return (
    `Palette: ${PALETTE_LABELS[palette]}.${overrides} Before drawing call get_palette_preset ${json({ id: palette })} ` +
    `and use only its colors. ${finish}`
  );
}

/** The hard limit is stated up front: merging colors afterwards is a repair, not a plan. */
function colorLimitSection(options: ChatOptions): string | undefined {
  if (options.maxColors === undefined) return undefined;
  return (
    `Color limit: at most ${options.maxColors} colors in the whole sprite (all layers and frames together, outline and ` +
    "highlights included). Plan ramps that fit the limit; when you finish, the bridge merges the closest colors of what " +
    "you drew if there are more."
  );
}

function tileSection(ctx: PromptContext): string | undefined {
  if (ctx.options.view !== "tile") return undefined;
  const size = ctx.info ?? ctx.options.size ?? DEFAULT_SPRITE_SIZE;
  const dx = Math.max(1, Math.floor(size.width / 2));
  const dy = Math.max(1, Math.floor(size.height / 2));
  return [
    "Seamless tile:",
    "- The texture covers every pixel of the canvas: no transparency, no border or frame, no outline around the tile, no single object floating on empty ground.",
    "- Opposite edges continue into each other: the right edge flows into the left one and the bottom into the top, as if the canvas were repeated.",
    `- To fix seams, transform_layer ${json({ op: "shift", dx, dy, wrap: true, frames: "all" })} brings the edges to the middle; repaint the seams there, then shift back with ${json({ op: "shift", dx: -dx, dy: -dy, wrap: true, frames: "all" })}.`,
    "- Spread detail evenly: lines along an edge or one-off landmarks make the repetition obvious.",
    `- Check the result with view_sprite ${json({ tiled: true })} (the tile repeated 3x3): no visible seams.`,
  ].join("\n");
}

/** The unticked "1px outline" box: it must win over every other outline hint the model reads. */
const NO_OUTLINE =
  "Outline: none. Draw no outline around the subject or its parts; separate shapes by color and value contrast only. " +
  "This overrides every outline rule or step in the style, the guide and the tool instructions.";

export const noOutline = (options: ChatOptions) => options.outline === false;

// The only place that states the outline, so "none" can never contradict a style rule.
function lookSection(options: ChatOptions, force: boolean, includeView = true): string | undefined {
  const lines: string[] = [];
  if (includeView && options.view) lines.push(`View: ${VIEW_LINES[options.view]}.`);

  // Directions (includeView false) define their own view, so "tile" doesn't apply there.
  const tile = includeView && options.view === "tile";
  if (noOutline(options)) lines.push(NO_OUTLINE);
  else if (tile) lines.push("Outline: never around the tile's edges; outline small objects inside the texture only if the style calls for it.");
  else if (options.outline === true || force || options.style !== undefined) lines.push(`Outline: ${styleOf(options).outline}.`);

  if (tile) {
    // A transparent tile would show holes when repeated, whatever the checkbox says.
    lines.push("Background: none; the texture itself fills every pixel.");
  } else if (options.background === "transparent") {
    lines.push("Background: transparent. Draw only the subject and leave every other pixel empty.");
  } else if (options.background === "solid") {
    lines.push('Background: fill the canvas behind the subject with a simple backdrop that complements it, on its own "Background" layer below the subject.');
  } else if (force) {
    lines.push("Background: transparent for characters, items and icons; filled for scenes, tiles and backgrounds.");
  }
  return lines.length ? lines.join("\n") : undefined;
}

function layerSection(ctx: PromptContext): string | undefined {
  if (ctx.freshSprite) {
    const layer = ctx.info?.layers[0]?.name ?? "Layer 1";
    return `A new empty ${ctx.info?.width}x${ctx.info?.height} sprite was created for this request and is already open. Draw the subject on its layer "${layer}"; put a background, if any, on its own "Background" layer below.`;
  }
  switch (ctx.options.target) {
    case "new_layer":
      return "Draw on a new layer named after the subject (writing to a new layer name creates it). Leave the existing layers untouched.";
    case "active_layer":
      return `Draw on the active layer${ctx.info?.activeLayer ? ` "${ctx.info.activeLayer}"` : ""}.`;
    default:
      return undefined;
  }
}

export function explicitOptions(ctx: PromptContext): string | undefined {
  return (
    join([
      layerSection(ctx),
      styleSection(ctx.options, false),
      paletteSection(ctx, false),
      colorLimitSection(ctx.options),
      lookSection(ctx.options, false),
      tileSection(ctx),
      ctx.reference,
    ]) || undefined
  );
}

function reviewPass(options: ChatOptions): string {
  const flaws = noOutline(options) ? "stray pixels, jaggies and unreadable shapes" : "stray pixels, jaggies, broken outlines and unreadable shapes";
  return `do exactly one review pass: view_sprite (every frame for animations), fix ${flaws}, then stop.`;
}

export function finishSection(options: ChatOptions): string {
  if (options.autoReview) return `When everything is drawn, ${reviewPass(options)}`;
  const flaws = noOutline(options) ? "stray pixels, jaggies, unclear shape" : "stray pixels, broken outline, unclear shape";
  return `Check the preview your last drawing call returned against every part of the request (open/closed, facing, held items, counts, named colors) and for ${flaws}; fix anything missing or off with one or two more calls, then stop.`;
}

/**
 * The user's Auto-review setting for actions that may not draw at all (a chat question)
 * or that already end with their own check: only added when it is switched on.
 */
function autoReviewSection(options: ChatOptions, scope = ""): string | undefined {
  return options.autoReview ? `If you changed the art: when you are done, ${reviewPass(options)}${scope}` : undefined;
}

function craftSteps(options: ChatOptions, tile: boolean): string {
  const lines = noOutline(options)
    ? "4. Clean edges and details: crisp shapes without jaggies or doubled pixels (no outline), then the small details that sell the subject (eyes, highlights, trims)."
    : "4. Clean lines and details: 1px outlines without jaggies or doubled corners, then the small details that sell the subject (eyes, highlights, trims).";
  return [
    "How to make it look good (few, big calls):",
    "1. Plan first: silhouette and proportions, light from the top-left, and a ramp of 3-5 hue-shifted shades per material (shadows cooler, highlights warmer).",
    "2. Block in the silhouette and flat base colors in one draw_script (one write_pixels for 32x32 and smaller).",
    "3. Shade in clusters: shadow side and cast shadows, then highlights. No pillow shading, no noise, no banding.",
    lines,
    "5. Compare the returned preview with every part of the request (open/closed, facing, held items, counts, named colors) and fix what is missing or reads badly. Then reply.",
    tile
      ? "The texture covers the whole canvas edge to edge; there is no margin."
      : "The subject should fill most of the canvas, with a 1-2 px margin.",
  ].join("\n");
}

const GUIDE_HINT =
  'If you are unsure how to draw this subject, call pixel_art_guide once before drawing (e.g. {"topic":"characters"}, "items_icons", "environments" or "tiles").';

/** Models answer in whatever language dominates the prompt, which is ours, not the user's. */
export function replyLanguage(text: string): string {
  const language = detectLanguage(text);
  return language
    ? `Reply language: ${language} (the language of the user's request).`
    : "Reply language: the language the user wrote in earlier, else English.";
}

/** Everything a generation prompt shares after its first line. */
function generationBody(ctx: PromptContext, includeView = true, topicText = ctx.text): (string | undefined)[] {
  const size = ctx.info ?? ctx.options.size ?? DEFAULT_SPRITE_SIZE;
  const tile = includeView && ctx.options.view === "tile";
  const guide = guideReference(tile ? "tiles" : guideTopicFor("generate", topicText));
  return [
    layerSection(ctx),
    styleSection(ctx.options, true),
    paletteSection(ctx, true),
    colorLimitSection(ctx.options),
    lookSection(ctx.options, true, includeView),
    tile ? tileSection(ctx) : undefined,
    ctx.reference,
    `Detail: ${detailForSize(size.width, size.height)}`,
    craftSteps(ctx.options, tile),
    guide ?? GUIDE_HINT,
    finishSection(ctx.options),
    ctx.canvas,
    replyLanguage(ctx.text),
  ];
}

// ---- one prompt per action ------------------------------------------------------

export function chatPrompt(ctx: PromptContext): string {
  const size = ctx.options.size ?? DEFAULT_SPRITE_SIZE;
  return join([
    ctx.text.trim(),
    ctx.selection &&
      `The user selected ${rectText(ctx.selection)}. Treat it as the area to change: pass selectionOnly: true so nothing outside it changes.`,
    explicitOptions(ctx),
    ctx.canvas ??
      `No sprite is open in Aseprite. If the request needs drawing, first create one with create_sprite (${size.width}x${size.height} unless the request implies another size).`,
    autoReviewSection(ctx.options, ctx.selection ? " Keep selectionOnly: true for the fixes." : ""),
    replyLanguage(ctx.text),
  ]);
}

export function generatePrompt(ctx: PromptContext): string {
  return join([`Create pixel art: ${ctx.text.trim()}`, ...generationBody(ctx)]);
}

export function editSelectionPrompt(ctx: PromptContext & { selection: Rect }): string {
  const text = ctx.text.trim();
  const s = ctx.selection;
  return join([
    `Redraw the selected area (${rectText(s)})${text ? `: ${text}` : " so it looks better while keeping its idea"}.`,
    [
      "- Only pixels inside the selection may change: pass selectionOnly: true to every drawing call.",
      `- Usually one draw_script with ${json({ x: s.x, y: s.y, width: s.width, height: s.height, base: "current", selectionOnly: true })} does it; check its preview once.`,
      "- Blend into the surrounding art: continue its lines, outline, light direction and colors (the colors in use are listed below).",
      "- Draw on the layer that holds the art there (usually the active layer) unless the user asked for a new layer.",
    ].join("\n"),
    autoReviewSection(ctx.options, " Keep selectionOnly: true for the fixes."),
    explicitOptions(ctx),
    ctx.canvas,
    replyLanguage(ctx.text),
  ]);
}

export function reviewPrompt(ctx: PromptContext): string {
  const text = ctx.text.trim();
  const animated = (ctx.info?.frames.length ?? 1) > 1;
  return join([
    `Review this sprite like a senior pixel artist and fix what is wrong without changing its design, subject or size.${text ? ` The user's note: ${text}` : ""}`,
    [
      "Check in this order and fix only real problems:",
      "1. Readability: does the silhouette read at 1x? Add contrast against the background or outline if not.",
      "2. Stray and orphan pixels, noise (cleanup_pixels removes isolated ones).",
      "3. Lines: jaggies, doubled pixels on outlines and curves, broken or inconsistent outline.",
      "4. Shading: one consistent light direction, no pillow shading, no banding, no muddy near-duplicate colors.",
      "5. Color: merge near-identical colors; add a highlight or shadow where flat areas look unfinished.",
      animated ? "6. Animation: same size and proportions in every frame, no jitter, smooth spacing." : "",
    ]
      .filter(Boolean)
      .join("\n"),
    "Fix on the layers that hold the art, in few calls (draw_script with base:\"current\" for repaints, write_pixels for touch-ups). Then say what you fixed in 1-2 sentences.",
    autoReviewSection(ctx.options),
    explicitOptions(ctx),
    ctx.canvas,
    replyLanguage(ctx.text),
  ]);
}

export interface AnimationPlan {
  animation: AnimationOptions;
  tag: string;
  /** The bridge already added the frames, durations and tag. */
  prepared: boolean;
  /** They were already there (an earlier attempt that failed or was stopped), so they may hold part of the motion. */
  resumed?: boolean;
  /** A tag with the plan's name that the bridge could not reuse (other range or frame count). */
  existingTag?: { from: number; to: number };
}

function animationSetup(ctx: PromptContext, plan: AnimationPlan): string {
  const { animation, tag } = plan;
  const last = animation.frames;
  if (plan.resumed) {
    return `Frames 1-${last} already exist with their durations and the tag "${tag}", left from an earlier attempt (the frames below show what they hold now). Turn them into the motion by editing frames 2-${last} (and frame 1 if the cycle needs it); don't add or remove frames.`;
  }
  if (plan.prepared) {
    return `Frames 1-${last} are already set up as copies of the original frame, with their durations and a tag "${tag}". Turn them into the motion by editing frames 2-${last} (and frame 1 if the cycle needs it); don't add or remove frames.`;
  }
  const tagStep = plan.existingTag
    ? `update the existing tag "${tag}" (now frames ${plan.existingTag.from}-${plan.existingTag.to}) to that range with manage_tags action 'update'; never add a second "${tag}" tag`
    : `tag the range "${tag}" with manage_tags`;
  return `The sprite has ${ctx.info?.frames.length ?? 1} frames already. Add the frames you need with manage_frames (copies of the base frame), set their duration to ${animation.frameMs} ms and ${tagStep}.`;
}

export function animatePrompt(ctx: PromptContext, plan: AnimationPlan): string {
  const { animation } = plan;
  const text = ctx.text.trim();
  const setup = animationSetup(ctx, plan);
  return join([
    `Animate this sprite: ${ANIMATION_POSES[animation.preset]}.${text ? ` ${text}` : ""}`,
    `Animation: ${animation.frames} frames, ${animation.frameMs} ms per frame, ${animation.loop ? "looping (the last frame must flow into the first)" : "plays once"}.`,
    setup,
    [
      "- Keep the size, proportions, palette and outline identical in every frame: no jitter, no redesign.",
      `- Move parts instead of repainting everything: transform_layer ${json({ op: "shift", dx: 0, dy: 1, frames: [2] })} for whole-body bobs; draw_script with base:"current" and frame:k to redraw limbs.`,
      "- Secondary motion (hair, cloth, tails) follows one frame behind the main motion.",
      "- Timing comes from spacing: bigger changes between frames read as faster motion.",
    ].join("\n"),
    finishSection(ctx.options),
    explicitOptions(ctx),
    guideReference(guideTopicFor("animate", text)),
    ctx.canvas,
    replyLanguage(ctx.text),
  ]);
}

/**
 * `reference`: the subject is the user's sprite, attached as an image (no description,
 * or source "current"); the text, if any, says how to vary it.
 */
export function variationPrompt(ctx: PromptContext, index: number, total: number, reference = false): string {
  const axis = VARIATION_AXES[(index - 1) % VARIATION_AXES.length];
  const note = ctx.text.trim();
  // The user's sprite is attached first; a style reference, if any, comes after it.
  const header = reference
    ? `Draw variation ${index} of ${total} of the sprite in the first attached image: the same subject, but ${axis}.` +
      (note ? `\nThe user's direction for the variations: ${note}` : "")
    : `Create pixel art: ${note}\nThis is variation ${index} of ${total}; the others are drawn in parallel into separate sprites. Make it clearly different from them: ${axis}.`;
  return join([header, ...generationBody(ctx)]);
}

export function batchItemPrompt(ctx: PromptContext, item: string, index: number, total: number): string {
  const theme = ctx.text.trim();
  return join([
    `Create pixel art: ${item}`,
    `This is item ${index} of ${total} in a matching set${theme ? ` (${theme})` : ""}. The other items are drawn in parallel from the same rules, so follow them exactly (same palette, ${noOutline(ctx.options) ? "" : "outline, "}light from the top-left, proportions and level of detail) and the set will look consistent.`,
    ...generationBody(ctx, true, `${item} ${theme}`),
  ]);
}

export interface DirectionsPlan {
  /** Frame order: frame k shows directions[k - 1]. */
  directions: readonly string[];
  /** Frames the bridge mirrors after this run instead of the model drawing them. */
  mirrors: readonly MirrorPair[];
  /** Frame 1 already holds the user's design (source "current"). */
  fromCurrent: boolean;
}

/** "a, b and c" */
function list(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function frameLabel(directions: readonly string[], direction: string): string {
  return `${directions.indexOf(direction) + 1} (${direction})`;
}

/** First run of a directions request: the model draws every frame the bridge doesn't mirror. */
export function directionsPrompt(ctx: PromptContext, plan: DirectionsPlan): string {
  const { directions, mirrors } = plan;
  const frames = directions.map((d, i) => `${i + 1} = ${d}`).join(", ");
  const mirrored = new Set<string>(mirrors.map((m) => m.to));
  const toDraw = directions.filter((d, i) => i > 0 && !mirrored.has(d)).map((d) => frameLabel(directions, d));
  const note = ctx.text.trim();
  const layer = ctx.info?.layers.find((l) => !l.isGroup)?.path ?? "Layer 1";

  const header = plan.fromCurrent
    ? `Turn the character in frame 1 into ${directions.length} directions, one direction per frame.${note ? ` The user's note: ${note}` : ""}`
    : `Draw ${note} as a character facing ${directions.length} directions, one direction per frame.`;
  const first = plan.fromCurrent
    ? `1. Frame 1 already holds the finished design facing down (toward the viewer), copied from the user's sprite. Don't redraw or change it: it defines the design, palette, proportions and size. Draw every frame on its layer "${layer}" and use its colors; add a color only for something frame 1 doesn't show. Where the rules below differ from frame 1 (outline, palette, shading), follow frame 1.`
    : "1. Draw frame 1 (facing down, toward the viewer) completely first: it defines the design.";
  const mirrorStep =
    mirrors.length > 0 &&
    `3. Leave frame${mirrors.length > 1 ? "s" : ""} ${list(mirrors.map((m) => frameLabel(directions, m.to)))} empty: when you finish, ` +
      `the bridge mirrors ${list(mirrors.map((m) => `frame ${frameLabel(directions, m.from)}`))} into ${mirrors.length > 1 ? "them" : "it"} ` +
      "and then asks you to fix the details that must not be mirrored.";

  return join([
    header,
    `Frames (already created, each tagged with its direction): ${frames}.`,
    [
      "Workflow:",
      first,
      `2. Draw frame${toDraw.length > 1 ? "s" : ""} ${list(toDraw)} from it: same height, proportions, palette${noOutline(ctx.options) ? "" : ", outline"} and details, feet on the same baseline. Turn the character, don't redesign it.`,
      mirrorStep,
    ]
      .filter(Boolean)
      .join("\n"),
    ...generationBody(ctx, false, "character"),
  ]);
}

/** Second run of a directions request, after the bridge mirrored the left-facing frames. */
export function mirrorFixPrompt(ctx: PromptContext, plan: DirectionsPlan, previewAttached: boolean): string {
  const { directions, mirrors } = plan;
  const targets = mirrors.map((m) => frameLabel(directions, m.to));
  const copies = list(mirrors.map((m) => `frame ${frameLabel(directions, m.from)} into frame ${frameLabel(directions, m.to)}`));
  return join([
    `The bridge mirrored ${copies}. ` +
      (previewAttached
        ? "A preview of every frame is attached, left to right."
        : 'Call view_sprite with frames "all" to see every frame.'),
    `Fix only what must not be mirrored in frame${targets.length > 1 ? "s" : ""} ${list(targets)}: details that belong to one side of the body ` +
      "(the hand holding a weapon or shield, a side parting, an eye patch, a badge, lettering), checked against frame 1 (down). " +
      'Edit only those frames (draw_script with base:"current" and frame k, or write_pixels with frame k) and leave every other ' +
      "pixel as it is. If nothing needs fixing, change nothing.",
    ctx.canvas,
    replyLanguage(ctx.text),
  ]);
}
