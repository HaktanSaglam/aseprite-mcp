import { z } from "zod";
import { EFFORTS } from "../llm/LlmRunner.js";

// docs/PROTOCOL.md "Chat contract" is the source of truth; keep these lists in sync with it.

export const CHAT_ACTIONS = [
  "chat",
  "generate",
  "edit_selection",
  "review",
  "animate",
  "variations",
  "batch",
  "directions",
] as const;
export type ChatAction = (typeof CHAT_ACTIONS)[number];

/** Actions that create their own sprites and may run several model jobs at once. */
export const PARALLEL_ACTIONS: ReadonlySet<ChatAction> = new Set(["variations", "batch", "directions"]);

export const STYLE_IDS = ["auto", "8bit", "16bit", "gameboy", "pico8", "1bit", "hd"] as const;
export type StyleId = (typeof STYLE_IDS)[number];

export const PRESET_PALETTE_IDS = [
  "pico8",
  "sweetie16",
  "endesga32",
  "endesga64",
  "db16",
  "db32",
  "aap64",
  "resurrect64",
  "gameboy",
  "nes",
  "1bit",
] as const;
export type PresetPaletteId = (typeof PRESET_PALETTE_IDS)[number];
export type PaletteId = "auto" | "current" | PresetPaletteId;

export const VIEWS = ["front", "side", "three_quarter", "top_down", "isometric"] as const;
export type View = (typeof VIEWS)[number];

export const ANIMATION_PRESETS = ["idle", "walk", "run", "jump", "attack", "hurt", "death", "custom"] as const;
export type AnimationPreset = (typeof ANIMATION_PRESETS)[number];

/** Used when the UI sends only a preset: lengths and timings a pixel artist would start from. */
export const ANIMATION_DEFAULTS: Record<AnimationPreset, { frames: number; frameMs: number; loop: boolean }> = {
  idle: { frames: 4, frameMs: 160, loop: true },
  walk: { frames: 8, frameMs: 100, loop: true },
  run: { frames: 6, frameMs: 80, loop: true },
  jump: { frames: 6, frameMs: 100, loop: false },
  attack: { frames: 5, frameMs: 80, loop: false },
  hurt: { frames: 3, frameMs: 100, loop: false },
  death: { frames: 6, frameMs: 120, loop: false },
  custom: { frames: 4, frameMs: 100, loop: true },
};

export const DEFAULT_SPRITE_SIZE = { width: 32, height: 32 } as const;
export const DEFAULT_VARIATIONS = 3;
export const MAX_BATCH_ITEMS = 16;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Aseprite's json.encode writes an empty Lua table as [] and the UI may send null or ""
 * for "not set"; normalise both so optional fields behave as omitted.
 */
function looseObject(value: unknown, dropEmptyStrings: boolean): unknown {
  if (Array.isArray(value) && value.length === 0) return {};
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== null && !(dropEmptyStrings && v === "")),
  );
}

const optionsObject = <T extends z.ZodType>(schema: T) => z.preprocess((v) => looseObject(v, true), schema);
const nullAsMissing = <T extends z.ZodType>(schema: T) => z.preprocess((v) => (v === null ? undefined : v), schema);

const RectSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().min(1),
  height: z.number().int().min(1),
});

const SizeSchema = optionsObject(
  z.object({
    width: z.number().int().min(1).max(1024),
    height: z.number().int().min(1).max(1024),
  }),
);

const AnimationSchema = optionsObject(
  z.object({
    preset: z.enum(ANIMATION_PRESETS).default("custom"),
    frames: z.number().int().min(2).max(16).optional(),
    frameMs: z.number().int().min(10).max(5000).optional(),
    loop: z.boolean().optional(),
  }),
).transform((a) => {
  const defaults = ANIMATION_DEFAULTS[a.preset];
  return {
    preset: a.preset,
    frames: a.frames ?? defaults.frames,
    frameMs: a.frameMs ?? defaults.frameMs,
    loop: a.loop ?? defaults.loop,
  };
});

export const ChatOptionsSchema = optionsObject(
  z.object({
    provider: z.string().optional(),
    model: z.string().optional(),
    effort: z.enum(EFFORTS).optional(),
    style: z.enum(STYLE_IDS).optional(),
    palette: z.enum(["auto", "current", ...PRESET_PALETTE_IDS]).optional(),
    size: SizeSchema.optional(),
    target: z.enum(["new_sprite", "new_layer", "active_layer"]).optional(),
    view: z.enum(VIEWS).optional(),
    directions: z.union([z.literal(4), z.literal(8)]).optional(),
    count: z.number().int().min(2).max(4).optional(),
    items: z.array(z.string()).max(MAX_BATCH_ITEMS).optional(),
    outline: z.boolean().optional(),
    background: z.enum(["transparent", "solid"]).optional(),
    animation: AnimationSchema.optional(),
    autoReview: z.boolean().optional(),
  }),
);

export type ChatOptions = z.output<typeof ChatOptionsSchema>;
export type AnimationOptions = NonNullable<ChatOptions["animation"]>;

/** The first chat window sent `model` at the top level and called edit_selection "redraw_selection". */
function upgradeLegacyChatSend(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  const event = { ...value };
  if (event.action === "redraw_selection") event.action = "edit_selection";
  if (typeof event.model === "string" && event.model) {
    const options = isPlainObject(event.options) ? event.options : {};
    if (options.model === undefined) event.options = { ...options, model: event.model };
  }
  return event;
}

const ChatSendSchema = z.preprocess(
  upgradeLegacyChatSend,
  z.object({
    event: z.literal("chat_send"),
    text: nullAsMissing(z.string().max(20_000).default("")),
    action: nullAsMissing(z.enum(CHAT_ACTIONS).default("chat")),
    options: nullAsMissing(ChatOptionsSchema.default({})),
    selection: nullAsMissing(RectSchema.optional()),
    sprite: nullAsMissing(z.number().int().positive().optional()),
  }),
);

export interface ChatSendRequest {
  text: string;
  action: ChatAction;
  options: ChatOptions;
  selection?: { x: number; y: number; width: number; height: number };
  sprite?: number;
}

const ToolRunSchema = z.object({
  event: z.literal("tool_run"),
  requestId: z.union([z.string(), z.number()]),
  tool: z.string().min(1),
  // Empty strings can be meaningful tool arguments, so only nulls/empty tables are dropped.
  params: z.preprocess((v) => (v == null ? {} : looseObject(v, false)), z.record(z.string(), z.unknown())),
  sprite: nullAsMissing(z.number().int().positive().optional()),
});

export type ToolRunRequest = Omit<z.output<typeof ToolRunSchema>, "event">;

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** "options.count: Too big: expected number to be <=4" — short enough for the chat panel. */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`)
    .join("; ");
}

export function parseChatSend(event: unknown): ParseResult<ChatSendRequest> {
  const parsed = ChatSendSchema.safeParse(event);
  if (!parsed.success) return { ok: false, error: `Invalid chat request (${describeIssues(parsed.error)})` };
  const { event: _event, ...request } = parsed.data;
  return { ok: true, value: request as ChatSendRequest };
}

export function parseToolRun(event: unknown): ParseResult<ToolRunRequest> {
  const parsed = ToolRunSchema.safeParse(event);
  if (!parsed.success) return { ok: false, error: `Invalid tool request (${describeIssues(parsed.error)})` };
  const { event: _event, ...request } = parsed.data;
  return { ok: true, value: request };
}

/** Batch items as the user typed them: blank lines dropped, surrounding spaces trimmed. */
export function batchItems(options: ChatOptions): string[] {
  return (options.items ?? []).map((item) => item.trim()).filter((item) => item.length > 0);
}

/**
 * Checks that need no Aseprite state, so an obviously incomplete request fails before
 * any sprite is created or model started. Returns the message for the user, if any.
 */
export function checkRequest(request: ChatSendRequest): string | undefined {
  const hasText = request.text.trim().length > 0;
  switch (request.action) {
    case "chat":
      return hasText ? undefined : "Type a message first.";
    case "generate":
    case "directions":
      return hasText ? undefined : "Describe what to draw first.";
    case "batch":
      return batchItems(request.options).length > 0
        ? undefined
        : "Add the items to draw (one per line) for a batch.";
    default:
      return undefined;
  }
}
