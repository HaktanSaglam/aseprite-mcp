import { describe, expect, it } from "vitest";
import type { ChatSendRequest } from "../src/chat/chatSchema.js";
import type { ChatUpdate, RequestRun } from "../src/chat/chatUpdates.js";
import { GenerationService } from "../src/chat/GenerationService.js";
import { SessionStore } from "../src/chat/SessionStore.js";
import type { LlmEvent, LlmRunRequest } from "../src/llm/LlmRunner.js";
import { mcpUrls } from "../src/mcp/httpServer.js";
import { CLAUDE_INFO, FakeGateway, FakeRunner, hangingScript, until } from "./chatFakes.js";

const URLS = mcpUrls("127.0.0.1", 7800);

function setup(maxParallelRuns = 2) {
  const gateway = new FakeGateway();
  const sessions = new SessionStore();
  const service = new GenerationService({ gateway, mcpUrlFor: URLS.forSprite, sessions, maxParallelRuns });
  const runner = new FakeRunner();
  const updates: ChatUpdate[] = [];
  const controller = new AbortController();
  const run = (supportsImages = true): RequestRun => ({
    provider: { info: { ...CLAUDE_INFO, supportsImages }, runner, model: "opus", effort: "medium" },
    sink: (update) => updates.push(update),
    signal: controller.signal,
  });
  const request = (fields: Partial<ChatSendRequest>): ChatSendRequest => ({ text: "", action: "variations", options: {}, ...fields });
  return { gateway, sessions, service, runner, updates, controller, run, request };
}

/** Each run takes `ms`, records how many runs overlap, and reports a session named after its sprite. */
function timedScript(ms: number, stats: { running: number; peak: number }) {
  return async function* (request: LlmRunRequest): AsyncIterable<LlmEvent> {
    stats.running++;
    stats.peak = Math.max(stats.peak, stats.running);
    yield { type: "session", sessionId: `session-${request.mcpUrl.split("/").pop()}` };
    yield { type: "tool", name: "draw_script" };
    await new Promise((resolve) => setTimeout(resolve, ms));
    stats.running--;
    yield { type: "text", text: "Done." };
    yield { type: "done", ok: true, stats: { durationMs: ms, turns: 2, costUsd: 0.5 } };
  };
}

describe("GenerationService: variations", () => {
  it("creates one sprite per variation and runs bounded-parallel jobs bound to them", async () => {
    const { gateway, sessions, service, runner, updates, run, request } = setup(2);
    const stats = { running: 0, peak: 0 };
    runner.script = timedScript(15, stats);

    const outcome = await service.execute(request({ text: "a slime", options: { count: 4, size: { width: 16, height: 16 } } }), run());

    expect(gateway.callsOf("createSprite").map((c) => c.args[0])).toEqual(
      Array(4).fill({ width: 16, height: 16, colorMode: "rgb" }),
    );
    expect(runner.requests.map((r) => r.mcpUrl)).toEqual([1, 2, 3, 4].map(URLS.forSprite));
    expect(runner.requests.map((r) => r.prompt.match(/variation (\d) of 4/)?.[1])).toEqual(["1", "2", "3", "4"]);
    expect(stats.peak).toBe(2);
    expect(outcome).toEqual({ ok: true, turns: 8, costUsd: 2 });
    for (const id of [1, 2, 3, 4]) expect(sessions.get("claude-code", id)).toBe(`session-${id}`);

    expect(updates[0]).toEqual({
      kind: "status",
      text: "Drawing 4 variations in parallel: Variation 1 in Sprite-0001, Variation 2 in Sprite-0002, Variation 3 in Sprite-0003, Variation 4 in Sprite-0004.",
    });
    const progress = updates.filter((u) => u.kind === "progress");
    expect(progress.map((p) => (p.kind === "progress" ? [p.done, p.total] : []))).toEqual([[0, 4], [1, 4], [2, 4], [3, 4], [4, 4]]);
    // Parallel jobs label their replies and hide tool calls.
    expect(updates.filter((u) => u.kind === "tool")).toHaveLength(0);
    expect(updates.filter((u) => u.kind === "text").map((u) => (u.kind === "text" ? u.text : ""))).toContain("Variation 3: Done.");
  });

  it("defaults to 3 variations of 32x32", async () => {
    const { gateway, service, run, request } = setup();
    await service.execute(request({ text: "a tree" }), run());
    expect(gateway.callsOf("createSprite").map((c) => c.args[0])).toEqual(Array(3).fill({ width: 32, height: 32, colorMode: "rgb" }));
  });

  it("varies the open sprite, shown as an image, when there is no description", async () => {
    const { gateway, service, runner, run, request } = setup();
    gateway.addSprite({ id: 9, width: 24, height: 20 }, true);
    await service.execute(request({ sprite: 9, options: { count: 2 } }), run());
    expect(gateway.callsOf("createSprite").map((c) => c.args[0])).toEqual(Array(2).fill({ width: 24, height: 20, colorMode: "rgb" }));
    expect(runner.requests.every((r) => r.images?.length === 1)).toBe(true);
    expect(runner.requests[0].prompt).toMatch(/^Draw variation 1 of 2 of the sprite in the attached image/);
  });

  it("needs a description or a non-empty sprite the model can see", async () => {
    const { gateway, service, run, request } = setup();
    await expect(service.execute(request({}), run())).rejects.toThrow(/Describe what to draw/);
    gateway.addSprite({ id: 1 });
    await expect(service.execute(request({ sprite: 1 }), run())).rejects.toThrow(/Describe what to draw/);
    gateway.addSprite({ id: 2 }, true);
    await expect(service.execute(request({ sprite: 2 }), run(false))).rejects.toThrow(/can't see images/);
    expect(gateway.callsOf("createSprite")).toHaveLength(0);
  });

  it("reports failed jobs and succeeds when at least one job did", async () => {
    const { service, runner, updates, run, request } = setup();
    runner.script = async function* (req) {
      if (req.prompt.includes("variation 2 of 3")) {
        yield { type: "done", ok: false, error: "rate limited" };
        return;
      }
      yield { type: "done", ok: true, stats: { durationMs: 1, turns: 1 } };
    };
    const outcome = await service.execute(request({ text: "x" }), run());
    expect(outcome).toEqual({ ok: true, turns: 2, costUsd: undefined });
    expect(updates).toContainEqual({ kind: "error", text: "Variation 2 failed: rate limited" });
    expect(updates.at(-1)).toEqual({ kind: "status", text: "2 of 3 finished." });
  });

  it("fails when every job failed", async () => {
    const { service, runner, run, request } = setup();
    runner.script = async function* () {
      yield { type: "done", ok: false, error: "nope" } satisfies LlmEvent;
    };
    expect((await service.execute(request({ text: "x", options: { count: 2 } }), run())).ok).toBe(false);
  });

  it("cancels running jobs and never starts queued ones", async () => {
    const { service, runner, updates, controller, run, request } = setup(2);
    let started = 0;
    runner.script = hangingScript(() => started++);
    const pending = service.execute(request({ text: "x", options: { count: 4 } }), run());
    await until(() => started === 2);
    controller.abort();
    const outcome = await pending;
    expect(outcome.ok).toBe(false);
    expect(runner.requests).toHaveLength(2);
    expect(updates.filter((u) => u.kind === "error")).toHaveLength(0);
    expect(updates.filter((u) => u.kind === "progress")).toHaveLength(1); // only the initial 0/4
  });
});

describe("GenerationService: batch", () => {
  it("draws one sprite per item with a shared palette and item labels", async () => {
    const { gateway, service, runner, updates, run, request } = setup(4);
    await service.execute(
      request({ action: "batch", text: "fantasy RPG icons", options: { items: [" sword ", "", "shield", "potion"], style: "pico8" } }),
      run(),
    );
    expect(gateway.callsOf("createSprite")).toHaveLength(3);
    expect(runner.requests.map((r) => r.prompt.split("\n")[0])).toEqual([
      "Create pixel art: sword",
      "Create pixel art: shield",
      "Create pixel art: potion",
    ]);
    expect(runner.requests[1].prompt).toMatch(/item 2 of 3 in a matching set \(fantasy RPG icons\)/);
    // "auto" palette becomes the style's preset so every item matches.
    expect(runner.requests.every((r) => r.prompt.includes('apply_palette {"palette":"pico8"'))).toBe(true);
    expect(updates.filter((u) => u.kind === "progress").map((u) => (u.kind === "progress" ? u.label : undefined)).slice(1).sort()).toEqual([
      "potion",
      "shield",
      "sword",
    ]);
  });

  it("keeps an explicit palette", async () => {
    const { service, runner, run, request } = setup();
    await service.execute(request({ action: "batch", options: { items: ["a"], palette: "db16" } }), run());
    expect(runner.requests[0].prompt).toContain('get_palette_preset {"id":"db16"}');
  });

  it("uses the auto style's shared palette when nothing is chosen", async () => {
    const { service, runner, run, request } = setup();
    await service.execute(request({ action: "batch", options: { items: ["a"] } }), run());
    expect(runner.requests[0].prompt).toContain('get_palette_preset {"id":"endesga32"}');
  });

  it("rejects an empty item list", async () => {
    const { service, run, request } = setup();
    await expect(service.execute(request({ action: "batch", options: { items: [] } }), run())).rejects.toThrow(/Add the items/);
  });
});

describe("GenerationService: directions", () => {
  it("runs one job on one sprite with a frame and a tag per direction", async () => {
    const { gateway, sessions, service, runner, updates, run, request } = setup();
    await service.execute(request({ action: "directions", text: "a knight", options: { directions: 8, size: { width: 24, height: 32 } } }), run());

    expect(gateway.callsOf("createSprite")[0].args[0]).toEqual({ width: 24, height: 32, colorMode: "rgb", frames: 8 });
    expect(gateway.callsOf("tagOp").map((c) => c.args[0])).toEqual(
      ["down", "down-right", "right", "up-right", "up", "up-left", "left", "down-left"].map((name, i) => ({
        op: "add",
        name,
        from: i + 1,
        to: i + 1,
      })),
    );
    expect(runner.requests).toHaveLength(1);
    expect(runner.requests[0].mcpUrl).toBe(URLS.forSprite(1));
    expect(runner.requests[0].prompt).toMatch(/1 = down, 2 = down-right/);
    expect(runner.requests[0].prompt).toMatch(/tags: "down" 1-1 forward/); // canvas reflects the prepared tags
    expect(updates.some((u) => u.kind === "tool")).toBe(true); // a single job shows its tool calls
    expect(sessions.get("claude-code", 1)).toBe("s-1");
  });

  it("defaults to 4 directions", async () => {
    const { gateway, service, run, request } = setup();
    await service.execute(request({ action: "directions", text: "a cat" }), run());
    expect(gateway.callsOf("tagOp").map((c) => (c.args[0] as { name: string }).name)).toEqual(["down", "right", "up", "left"]);
  });
});
