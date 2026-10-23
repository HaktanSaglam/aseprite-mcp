import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { claudeErrorMessage, claudeUserMessage, parseClaudeLine } from "../src/llm/claudeStream.js";
import { ClaudeCliRunner } from "../src/llm/ClaudeCliRunner.js";
import type { LlmEvent, LlmRunRequest } from "../src/llm/LlmRunner.js";
import { fakeCli, TINY_PNG } from "./fixtures/llm/testServers.js";

const MCP_URL = "http://127.0.0.1:65530/mcp";

async function collect(events: AsyncIterable<LlmEvent>): Promise<LlmEvent[]> {
  const out: LlmEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function done(events: LlmEvent[]) {
  const last = events[events.length - 1];
  if (last?.type !== "done") throw new Error(`last event is ${JSON.stringify(last)}`);
  return last;
}

function sessionOf(events: LlmEvent[]): string {
  const event = events.find((e) => e.type === "session");
  if (event?.type !== "session") throw new Error("no session event");
  return event.sessionId;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("parseClaudeLine", () => {
  it("reports the session from init lines", () => {
    expect(parseClaudeLine({ type: "system", subtype: "init", session_id: "s1" })).toEqual({ kind: "session", sessionId: "s1" });
  });

  it("strips the MCP prefix from tool names and ignores synthetic messages", () => {
    const line = parseClaudeLine({
      type: "assistant",
      message: { content: [{ type: "text", text: "hi" }, { type: "tool_use", name: "mcp__aseprite__view_sprite" }] },
    });
    expect(line).toEqual({ kind: "events", events: [{ type: "text", text: "hi" }, { type: "tool", name: "view_sprite" }] });
    expect(parseClaudeLine({ type: "assistant", message: { model: "<synthetic>", content: [{ type: "text", text: "x" }] } })).toBeUndefined();
  });

  it("maps api retries", () => {
    expect(parseClaudeLine({ type: "system", subtype: "api_retry", attempt: 2, error: "overloaded" })).toEqual({
      kind: "events",
      events: [{ type: "retry", attempt: 2, reason: "overloaded" }],
    });
  });

  it("turns result usage into stats, counting cached prompt tokens", () => {
    const line = parseClaudeLine({
      type: "result",
      is_error: false,
      session_id: "s1",
      duration_ms: 900,
      num_turns: 3,
      total_cost_usd: 0.12,
      usage: { input_tokens: 2, cache_read_input_tokens: 3000, cache_creation_input_tokens: 40, output_tokens: 7 },
    });
    expect(line).toEqual({
      kind: "result",
      sessionId: "s1",
      result: { ok: true, totalCostUsd: 0.12, stats: { durationMs: 900, turns: 3, inputTokens: 3042, outputTokens: 7 } },
    });
  });

  it("treats error subtypes as failures", () => {
    const line = parseClaudeLine({ type: "result", subtype: "error_max_turns", is_error: false, usage: {} });
    expect(line).toMatchObject({ kind: "result", result: { ok: false, error: expect.stringContaining("turn limit") } });
  });

  it("ignores unknown lines", () => {
    expect(parseClaudeLine({ type: "rate_limit_event" })).toBeUndefined();
    expect(parseClaudeLine(null)).toBeUndefined();
  });
});

describe("claudeErrorMessage", () => {
  it("explains expired logins", () => {
    expect(claudeErrorMessage({ api_error_status: 401, result: "Invalid API key" })).toMatch(/claude auth login/);
    expect(claudeErrorMessage({}, "Error: Please run /login")).toMatch(/claude auth login/);
  });

  it("explains usage limits", () => {
    expect(claudeErrorMessage({ api_error_status: 429, result: "limit · resets 5pm" })).toMatch(/usage limit reached: limit · resets 5pm/);
  });

  it("passes other errors through", () => {
    expect(claudeErrorMessage({ result: "Something odd" })).toBe("Something odd");
  });
});

describe("claudeUserMessage", () => {
  it("puts images before the text in one user message", () => {
    const message = claudeUserMessage("draw", [{ mediaType: "image/png", base64: "AAA" }]);
    expect(message).toEqual({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
          { type: "text", text: "draw" },
        ],
      },
    });
  });
});

describe("ClaudeCliRunner (fake CLI)", () => {
  let logPath: string;
  let workDir: string;
  let claudePath: string;
  const runners: ClaudeCliRunner[] = [];

  const logEntries = (): any[] =>
    readFileSync(logPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));

  const runner = (options: Partial<ConstructorParameters<typeof ClaudeCliRunner>[0]> = {}) => {
    const r = new ClaudeCliRunner({ claudePath, workDir, ...options });
    runners.push(r);
    return r;
  };

  const request = (overrides: Partial<LlmRunRequest> = {}): LlmRunRequest => ({
    prompt: "draw a cat",
    mcpUrl: MCP_URL,
    systemPrompt: "SYSTEM",
    ...overrides,
  });

  beforeAll(() => {
    claudePath = fakeCli("fake-claude.mjs");
  });

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "llm-claude-test-"));
    logPath = join(dir, "log.jsonl");
    writeFileSync(logPath, "");
    workDir = join(dir, "work");
    process.env.FAKE_CLI_LOG = logPath;
  });

  afterEach(() => {
    for (const r of runners.splice(0)) r.dispose();
  });

  it("sends prompt and images as one stream-json message and reports stats", async () => {
    const events = await collect(
      runner().run(request({ model: "opus", effort: "high", images: [{ mediaType: "image/png", base64: TINY_PNG }] })),
    );
    expect(events.map((e) => e.type)).toEqual(["session", "text", "tool", "text", "done"]);
    expect(events[2]).toEqual({ type: "tool", name: "draw_script" });
    expect(events[1]).toMatchObject({ type: "text", text: expect.stringContaining("images=1") });
    expect(done(events)).toEqual({
      type: "done",
      ok: true,
      stats: { durationMs: 1234, turns: 2, inputTokens: 115, outputTokens: 20, costUsd: 0.01 },
    });

    const [start, input] = logEntries();
    expect(start.args).toEqual(expect.arrayContaining(["-p", "--input-format", "stream-json", "--output-format", "stream-json"]));
    expect(start.args[start.args.indexOf("--model") + 1]).toBe("opus");
    expect(start.args[start.args.indexOf("--effort") + 1]).toBe("high");
    // Passed as files: cmd.exe (Windows .cmd shims) can't carry newlines or JSON quoting.
    expect(readFileSync(start.args[start.args.indexOf("--append-system-prompt-file") + 1], "utf8")).toBe("SYSTEM");
    expect(JSON.parse(readFileSync(start.args[start.args.indexOf("--mcp-config") + 1], "utf8"))).toEqual({
      mcpServers: { aseprite: { type: "http", url: MCP_URL } },
    });
    expect(start.args).not.toContain("--resume");
    expect(input.input.message.content.map((b: any) => b.type)).toEqual(["image", "text"]);
  });

  it("keeps the process warm and reuses it for follow-ups", async () => {
    const r = runner();
    const first = await collect(r.run(request()));
    const sessionId = sessionOf(first);
    const second = await collect(r.run(request({ sessionId, prompt: "make it darker" })));

    const firstPid = /pid (\d+)/.exec((first[1] as { text: string }).text)![1];
    expect((second[1] as { text: string }).text).toBe(`turn 2 on pid ${firstPid} images=0`);
    expect(sessionOf(second)).toBe(sessionId);
    // total_cost_usd is cumulative; each turn reports only its own share.
    expect(done(second)).toMatchObject({ ok: true, stats: { costUsd: expect.closeTo(0.01, 6) } });
    expect(logEntries().filter((e) => e.event === "start")).toHaveLength(1);
  });

  it("starts a new process with --resume when model or effort change", async () => {
    const r = runner();
    const sessionId = sessionOf(await collect(r.run(request({ effort: "low" }))));
    const second = await collect(r.run(request({ sessionId, effort: "max" })));
    expect(done(second).ok).toBe(true);
    const starts = logEntries().filter((e) => e.event === "start");
    expect(starts).toHaveLength(2);
    expect(starts[1].args.slice(starts[1].args.indexOf("--resume"), starts[1].args.indexOf("--resume") + 2)).toEqual([
      "--resume",
      sessionId,
    ]);
    // The fake starts resumed sessions at 0.5; the delta against the known 0.01 is 0.5.
    expect(done(second).stats?.costUsd).toBeCloseTo(0.5, 6);
    await waitFor(() => !isAlive(starts[0].pid));
  });

  it("does not resume session ids it never created", async () => {
    const events = await collect(runner().run(request({ sessionId: "foreign-session" })));
    expect(done(events).ok).toBe(true);
    expect(logEntries()[0].args).not.toContain("--resume");
    expect(sessionOf(events)).not.toBe("foreign-session");
  });

  it("aborts by killing the process and resumes next time", async () => {
    const r = runner();
    const sessionId = sessionOf(await collect(r.run(request())));
    const pid = logEntries()[0].pid as number;

    const controller = new AbortController();
    const pending = collect(r.run(request({ sessionId, prompt: "HANG", signal: controller.signal })));
    await waitFor(() => logEntries().some((e) => e.event === "input" && e.input.message.content[0].text === "HANG"));
    controller.abort();
    expect(done(await pending)).toEqual({ type: "done", ok: false, error: "Stopped." });
    await waitFor(() => !isAlive(pid));

    const after = await collect(r.run(request({ sessionId })));
    expect(done(after).ok).toBe(true);
    const starts = logEntries().filter((e) => e.event === "start");
    expect(starts).toHaveLength(2);
    expect(starts[1].args).toContain("--resume");
  });

  it("closes stdin for one-shot runs so the process exits", async () => {
    const events = await collect(runner().run(request({ keepAlive: false })));
    expect(done(events).ok).toBe(true);
    const pid = logEntries()[0].pid as number;
    await waitFor(() => !isAlive(pid));
    expect(logEntries().some((e) => e.event === "stdin_closed")).toBe(true);
  });

  it("stops idle processes after the timeout", async () => {
    await collect(runner({ idleTimeoutMs: 50 }).run(request()));
    const pid = logEntries()[0].pid as number;
    await waitFor(() => !isAlive(pid));
  });

  it("keeps only the most recent warm processes", async () => {
    const r = runner({ maxWarmProcesses: 1 });
    await collect(r.run(request()));
    await collect(r.run(request()));
    const [first, second] = logEntries().filter((e) => e.event === "start");
    await waitFor(() => !isAlive(first.pid));
    expect(isAlive(second.pid)).toBe(true);
  });

  it("explains an expired login", async () => {
    const events = await collect(runner().run(request({ prompt: "ERROR401" })));
    expect(done(events)).toMatchObject({ ok: false, error: expect.stringContaining("claude auth login") });
    expect(events.filter((e) => e.type === "text")).toHaveLength(0);
  });

  it("explains usage limits", async () => {
    const events = await collect(runner().run(request({ prompt: "RATELIMIT" })));
    expect(done(events)).toMatchObject({ ok: false, error: expect.stringMatching(/usage limit reached.*resets 5pm/) });
  });

  it("reports crashes with stderr", async () => {
    const events = await collect(runner().run(request({ prompt: "CRASH" })));
    expect(done(events)).toMatchObject({ ok: false, error: expect.stringMatching(/code 3: fatal: something broke/) });
  });

  it("tells how to install a missing CLI", async () => {
    const events = await collect(runner({ claudePath: join(workDir, "no-such-claude") }).run(request()));
    expect(done(events)).toMatchObject({ ok: false, error: expect.stringMatching(/not found.*npm install -g @anthropic-ai\/claude-code/) });
  });
});
