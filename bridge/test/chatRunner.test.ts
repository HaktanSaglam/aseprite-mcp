import { describe, expect, it } from "vitest";
import type { ChatUpdate } from "../src/chat/chatUpdates.js";
import { mapLimit } from "../src/chat/concurrency.js";
import { resolveEffort, resolveProvider, type ResolvedProvider } from "../src/chat/providerResolver.js";
import { executeRun } from "../src/chat/RunExecutor.js";
import { SessionStore } from "../src/chat/SessionStore.js";
import type { LlmEvent } from "../src/llm/LlmRunner.js";
import { CLAUDE_INFO, defaultScript, FakeRegistry, FakeRunner, hangingScript } from "./chatFakes.js";

describe("resolveEffort", () => {
  it("defaults to medium", () => {
    expect(resolveEffort(undefined, ["low", "medium", "high"])).toBe("medium");
  });

  it("keeps a supported effort and picks the closest otherwise", () => {
    expect(resolveEffort("high", ["low", "medium", "high"])).toBe("high");
    expect(resolveEffort("max", ["low", "medium", "high"])).toBe("high");
    expect(resolveEffort("xhigh", ["low", "max"])).toBe("max");
    expect(resolveEffort("medium", ["low", "high"])).toBe("low"); // tie → the cheaper one
  });

  it("is undefined for providers without effort control", () => {
    expect(resolveEffort("high", [])).toBeUndefined();
  });
});

describe("resolveProvider", () => {
  it("uses the default provider, its first model and medium effort", async () => {
    const registry = new FakeRegistry();
    const resolved = await resolveProvider(registry, {});
    expect(resolved.info.id).toBe("claude-code");
    expect(resolved.model).toBe("opus");
    expect(resolved.effort).toBe("medium");
    expect(resolved.runner).toBe(registry.runners["claude-code"]);
  });

  it("passes explicit model and effort through", async () => {
    const resolved = await resolveProvider(new FakeRegistry(), { model: "sonnet", effort: "low" });
    expect([resolved.model, resolved.effort]).toEqual(["sonnet", "low"]);
  });

  it("explains unknown and unavailable providers", async () => {
    const registry = new FakeRegistry([
      CLAUDE_INFO,
      { ...CLAUDE_INFO, id: "codex", label: "Codex CLI", available: false, note: "Install it with npm i -g @openai/codex" },
    ]);
    await expect(resolveProvider(registry, { provider: "gemini" })).rejects.toThrow(
      'Unknown AI provider "gemini". Available: claude-code, codex.',
    );
    await expect(resolveProvider(registry, { provider: "codex" })).rejects.toThrow(
      "Codex CLI is not available: Install it with npm i -g @openai/codex",
    );
  });
});

describe("SessionStore", () => {
  it("remembers a conversation per sprite", () => {
    const sessions = new SessionStore();
    sessions.set("claude-code", 1, "a");
    sessions.set("claude-code", 2, "b");
    sessions.set("claude-code", undefined, "none");
    expect(sessions.get("claude-code", 1)).toBe("a");
    expect(sessions.get("claude-code", 2)).toBe("b");
    expect(sessions.get("claude-code")).toBe("none");
  });

  it("starts fresh when the provider changes", () => {
    const sessions = new SessionStore();
    sessions.set("claude-code", 1, "a");
    expect(sessions.get("codex", 1)).toBeUndefined();
    sessions.set("codex", 1, "c");
    expect(sessions.get("claude-code", 1)).toBeUndefined();
  });

  it("clears everything", () => {
    const sessions = new SessionStore();
    sessions.set("claude-code", 1, "a");
    sessions.clear();
    expect(sessions.get("claude-code", 1)).toBeUndefined();
  });
});

describe("mapLimit", () => {
  it("never runs more than the limit at once and keeps the order", async () => {
    let running = 0;
    let peak = 0;
    const results = await mapLimit([5, 1, 4, 2, 3], 2, async (ms, i) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, ms));
      running--;
      return i * 10;
    });
    expect(results).toEqual([0, 10, 20, 30, 40]);
    expect(peak).toBe(2);
  });

  it("handles an empty list", async () => {
    expect(await mapLimit([], 3, async () => 1)).toEqual([]);
  });
});

describe("executeRun", () => {
  const provider = (runner: FakeRunner, supportsImages = true): ResolvedProvider => ({
    info: { ...CLAUDE_INFO, supportsImages },
    runner,
    model: "opus",
    effort: "medium",
  });
  const job = { prompt: "p", systemPrompt: "s", mcpUrl: "http://x/mcp/sprite/1" };

  it("streams events, returns session and stats, and passes the request through", async () => {
    const runner = new FakeRunner(defaultScript("sess", "Hi"));
    const updates: ChatUpdate[] = [];
    const image = { mediaType: "image/png" as const, base64: "AA" };
    const outcome = await executeRun(provider(runner), { ...job, images: [image], sessionId: "old" }, (u) => updates.push(u), new AbortController().signal);

    expect(outcome).toMatchObject({ ok: true, aborted: false, sessionId: "sess", turns: 3, costUsd: 0.01 });
    expect(updates).toEqual([{ kind: "tool", name: "draw_script" }, { kind: "text", text: "Hi" }]);
    expect(runner.requests[0]).toMatchObject({
      prompt: "p",
      systemPrompt: "s",
      mcpUrl: "http://x/mcp/sprite/1",
      images: [image],
      sessionId: "old",
      model: "opus",
      effort: "medium",
    });
  });

  it("labels text, hides tool calls and reports retries for parallel jobs", async () => {
    const runner = new FakeRunner(async function* (): AsyncIterable<LlmEvent> {
      yield { type: "retry", attempt: 2, reason: "overloaded" };
      yield { type: "tool", name: "write_pixels" };
      yield { type: "text", text: "Drew it." };
      yield { type: "done", ok: true };
    });
    const updates: ChatUpdate[] = [];
    await executeRun(provider(runner), job, (u) => updates.push(u), new AbortController().signal, { label: "Variation 2", quietTools: true });
    expect(updates).toEqual([
      { kind: "status", text: "Variation 2: Model is busy, retrying (attempt 2)..." },
      { kind: "text", text: "Variation 2: Drew it." },
    ]);
  });

  it("shows only the closing reply, not the narration or the self-check before it", async () => {
    const runner = new FakeRunner(async function* (): AsyncIterable<LlmEvent> {
      yield { type: "text", text: "Drawing the base first." };
      yield { type: "tool", name: "draw_script" };
      yield { type: "text", text: "Frame 3 is good; check frame 2." };
      yield { type: "tool", name: "view_sprite" };
      yield { type: "text", text: "Reads well: plume, tabard, boots." };
      yield { type: "text", text: "Yürüyen bir şövalye çizdim." };
      yield { type: "done", ok: true };
    });
    const updates: ChatUpdate[] = [];
    await executeRun(provider(runner), job, (u) => updates.push(u), new AbortController().signal);
    expect(updates).toEqual([
      { kind: "tool", name: "draw_script" },
      { kind: "tool", name: "view_sprite" },
      { kind: "text", text: "Yürüyen bir şövalye çizdim." },
    ]);
  });

  it("drops images for providers that can't see them", async () => {
    const runner = new FakeRunner();
    await executeRun(provider(runner, false), { ...job, images: [{ mediaType: "image/png", base64: "AA" }] }, () => {}, new AbortController().signal);
    expect(runner.requests[0].images).toBeUndefined();
  });

  it("returns failures instead of throwing", async () => {
    const failing = new FakeRunner(async function* (): AsyncIterable<LlmEvent> {
      yield { type: "done", ok: false, error: "login expired" };
    });
    expect(await executeRun(provider(failing), job, () => {}, new AbortController().signal)).toMatchObject({ ok: false, error: "login expired" });

    const throwing = new FakeRunner(async function* (): AsyncIterable<LlmEvent> {
      throw new Error("spawn failed");
    });
    expect(await executeRun(provider(throwing), job, () => {}, new AbortController().signal)).toMatchObject({ ok: false, error: "spawn failed" });

    const silent = new FakeRunner(async function* (): AsyncIterable<LlmEvent> {});
    expect(await executeRun(provider(silent), job, () => {}, new AbortController().signal)).toMatchObject({
      ok: false,
      error: "The model run ended without a result.",
    });
  });

  it("reports a stopped run as aborted, without an error", async () => {
    const controller = new AbortController();
    const runner = new FakeRunner(hangingScript(() => controller.abort()));
    const outcome = await executeRun(provider(runner), job, () => {}, controller.signal);
    expect(outcome).toMatchObject({ ok: false, aborted: true, error: undefined, sessionId: "s-hang" });
  });

  it("does not start when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const runner = new FakeRunner();
    expect(await executeRun(provider(runner), job, () => {}, controller.signal)).toMatchObject({ aborted: true });
    expect(runner.requests).toHaveLength(0);
  });
});
