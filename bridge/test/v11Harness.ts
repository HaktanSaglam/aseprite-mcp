// Shared setup for the v1.1 chat flow tests (not a test file itself): the real services
// on the tool-test FakeGateway (layers, tags, undo) behind the real tracking decorator,
// and "models" whose scripts draw through a scoped gateway like a real run's tools do.
import { ScopedAsepriteGateway } from "../src/aseprite/ScopedAsepriteGateway.js";
import { SpriteActivity } from "../src/aseprite/SpriteActivity.js";
import { TrackingAsepriteGateway } from "../src/aseprite/TrackingAsepriteGateway.js";
import type { ChatSendRequest } from "../src/chat/chatSchema.js";
import type { ChatUpdate, RequestRun } from "../src/chat/chatUpdates.js";
import { GenerationService } from "../src/chat/GenerationService.js";
import { SessionStore } from "../src/chat/SessionStore.js";
import { SingleRunService } from "../src/chat/SingleRunService.js";
import type { LlmEvent, LlmRunRequest } from "../src/llm/LlmRunner.js";
import { mcpUrls } from "../src/mcp/httpServer.js";
import { createRgbaImage, type RgbaImage } from "../src/pixel/RgbaImage.js";
import { CLAUDE_INFO, FakeRunner, type Script } from "./chatFakes.js";
import { FakeGateway } from "./fakes/FakeGateway.js";

export const URLS = mcpUrls("127.0.0.1", 7800);

/** The sprite a run's scoped MCP endpoint is bound to. */
export const spriteOf = (request: LlmRunRequest) => Number(request.mcpUrl.split("/").pop());

export function solid(width: number, height: number, rgba: [number, number, number, number]): RgbaImage {
  const image = createRgbaImage(width, height);
  for (let i = 0; i < width * height; i++) image.data.set(rgba, i * 4);
  return image;
}

export function v11Harness(maxParallelRuns = 2) {
  const fake = new FakeGateway();
  const activity = new SpriteActivity();
  const gateway = new TrackingAsepriteGateway(fake, activity);
  const sessions = new SessionStore();
  const single = new SingleRunService({ gateway, mcpUrls: URLS, sessions, activity });
  const generation = new GenerationService({ gateway, mcpUrlFor: URLS.forSprite, sessions, maxParallelRuns, activity });
  const runner = new FakeRunner();
  const updates: ChatUpdate[] = [];
  const controller = new AbortController();
  const claimed: number[] = [];

  const run = (supportsImages = true): RequestRun => ({
    provider: { info: { ...CLAUDE_INFO, supportsImages }, runner, model: "opus", effort: "medium" },
    sink: (update) => updates.push(update),
    signal: controller.signal,
    claimSprite: (sprite) => claimed.push(sprite),
  });
  const request = (fields: Partial<ChatSendRequest>): ChatSendRequest => ({ text: "", action: "chat", options: {}, ...fields });
  /** What a run's tools see: the tracked gateway bound to the run's sprite. */
  const toolsOf = (r: LlmRunRequest) => new ScopedAsepriteGateway(gateway, spriteOf(r));

  /** A model that does `draw` with its tools, then finishes (ok unless told otherwise). */
  const drawing = (draw: (r: LlmRunRequest, n: number) => Promise<void> | void, ok: (n: number) => boolean = () => true): Script => {
    let n = 0;
    return async function* (r): AsyncIterable<LlmEvent> {
      const index = n++;
      yield { type: "session", sessionId: `s-${index + 1}` };
      await draw(r, index);
      yield ok(index)
        ? { type: "done", ok: true, stats: { durationMs: 1, turns: 1, costUsd: 0.01 } }
        : { type: "done", ok: false, error: "model failed" };
    };
  };

  return { fake, activity, gateway, sessions, single, generation, runner, updates, controller, claimed, run, request, toolsOf, drawing };
}

export const statuses = (updates: ChatUpdate[]) =>
  updates.filter((u): u is Extract<ChatUpdate, { kind: "status" }> => u.kind === "status").map((u) => u.text);

export const errors = (updates: ChatUpdate[]) =>
  updates.filter((u): u is Extract<ChatUpdate, { kind: "error" }> => u.kind === "error").map((u) => u.text);
