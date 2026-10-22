import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { firstTurnPrompt } from "../src/llm/cli/firstTurnPrompt.js";
import { which } from "../src/llm/cli/which.js";
import { codexArgs, codexErrorMessage, parseCodexLine } from "../src/llm/codexEvents.js";
import { CodexCliRunner } from "../src/llm/CodexCliRunner.js";
import { GeminiCliRunner } from "../src/llm/GeminiCliRunner.js";
import { geminiArgs, geminiErrorMessage, geminiSettings, GeminiStreamParser } from "../src/llm/geminiEvents.js";
import type { LlmEvent, LlmRunRequest } from "../src/llm/LlmRunner.js";
import { fakeCli, TINY_PNG } from "./fixtures/llm/testServers.js";

const MCP_URL = "http://127.0.0.1:65530/mcp";

async function collect(events: AsyncIterable<LlmEvent>): Promise<LlmEvent[]> {
  const out: LlmEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

function last(events: LlmEvent[]) {
  return events[events.length - 1]!;
}

let logPath: string;
let workDir: string;
const logEntries = (): any[] =>
  readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "llm-cli-test-"));
  logPath = join(dir, "log.jsonl");
  writeFileSync(logPath, "");
  workDir = join(dir, "work");
  process.env.FAKE_CLI_LOG = logPath;
});

const request = (overrides: Partial<LlmRunRequest> = {}): LlmRunRequest => ({
  prompt: "draw a sword",
  mcpUrl: MCP_URL,
  systemPrompt: "SYSTEM PROMPT",
  ...overrides,
});
const instructions = async () => "SERVER INSTRUCTIONS";

describe("which", () => {
  it("finds commands on PATH and checks explicit paths", () => {
    expect(which("node")).toMatch(/node(\.exe)?$/i);
    expect(which(process.execPath)).toBe(process.execPath);
    expect(which("definitely-not-a-real-command-xyz")).toBeUndefined();
    expect(which("/nonexistent/bin/tool")).toBeUndefined();
  });
});

describe("firstTurnPrompt", () => {
  it("puts server and bridge instructions before the user's message", () => {
    expect(firstTurnPrompt("SYS", "SERVER", "hi")).toBe("<instructions>\nSERVER\n\nSYS\n</instructions>\n\nhi");
    expect(firstTurnPrompt("", undefined, "hi")).toBe("hi");
  });
});

describe("codex events", () => {
  it("maps thread, tool, message and turn events", () => {
    expect(parseCodexLine({ type: "thread.started", thread_id: "t1" })).toEqual({
      kind: "events",
      events: [{ type: "session", sessionId: "t1" }],
    });
    expect(parseCodexLine({ type: "item.started", item: { type: "mcp_tool_call", server: "aseprite", tool: "view_sprite" } })).toEqual({
      kind: "events",
      events: [{ type: "tool", name: "view_sprite" }],
    });
    expect(parseCodexLine({ type: "item.completed", item: { type: "agent_message", text: " Done. " } })).toEqual({
      kind: "events",
      events: [{ type: "text", text: "Done." }],
    });
    expect(parseCodexLine({ type: "turn.completed", usage: { input_tokens: 5, output_tokens: 2 } })).toEqual({
      kind: "turn_completed",
      inputTokens: 5,
      outputTokens: 2,
    });
  });

  it("understands the pre-0.44 item_type field", () => {
    expect(parseCodexLine({ type: "item.completed", item: { item_type: "assistant_message", text: "hi" } })).toEqual({
      kind: "events",
      events: [{ type: "text", text: "hi" }],
    });
  });

  it("maps failures, reconnects and errors", () => {
    expect(parseCodexLine({ type: "turn.failed", error: { message: "401 Unauthorized" } })).toEqual({
      kind: "turn_failed",
      error: expect.stringContaining("codex login"),
    });
    expect(parseCodexLine({ type: "error", message: "Reconnecting... 2/5" })).toEqual({
      kind: "events",
      events: [{ type: "retry", attempt: 2, reason: "Reconnecting... 2/5" }],
    });
    expect(parseCodexLine({ type: "error", message: "boom" })).toEqual({ kind: "error", message: "boom" });
  });

  it("ignores reasoning, unknown items and unknown events", () => {
    expect(parseCodexLine({ type: "item.completed", item: { type: "reasoning", text: "hmm" } })).toBeUndefined();
    expect(parseCodexLine({ type: "turn.started" })).toBeUndefined();
    expect(parseCodexLine({ type: "something.new" })).toBeUndefined();
  });

  it("explains usage limits", () => {
    expect(codexErrorMessage("You've hit your usage limit.")).toMatch(/^Codex usage limit reached/);
  });

  it("builds exec args with MCP config, effort, resume and images", () => {
    const args = codexArgs({
      prompt: "-make it red",
      mcpUrl: MCP_URL,
      model: "gpt-6.1-sol",
      effort: "max",
      resumeId: "thread-1",
      imagePaths: ["/tmp/a.png"],
    });
    expect(args.slice(0, 2)).toEqual(["-c", `mcp_servers.aseprite.url="${MCP_URL}"`]);
    expect(args).toContain(`model_reasoning_effort="xhigh"`);
    const exec = args.indexOf("exec");
    expect(args.slice(exec, exec + 6)).toEqual(["exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "-m"]);
    expect(args.slice(args.indexOf("resume"))).toEqual(["resume", "thread-1", "-i", "/tmp/a.png", " -make it red"]);
  });
});

describe("CodexCliRunner (fake CLI)", () => {
  const runner = (codexPath = fakeCli("fake-codex.mjs")) => new CodexCliRunner({ codexPath, workDir, instructions });

  it("streams a turn and resumes the thread for follow-ups", async () => {
    const r = runner();
    const first = await collect(r.run(request({ model: "gpt-6.1-sol", images: [{ mediaType: "image/png", base64: TINY_PNG }] })));
    expect(first.map((e) => e.type)).toEqual(["session", "tool", "text", "done"]);
    expect(first[2]).toEqual({ type: "text", text: "Drew it (new)." });
    expect(last(first)).toMatchObject({ ok: true, stats: { turns: 1, inputTokens: 1200, outputTokens: 90 } });

    const [log] = logEntries();
    const prompt: string = log.args[log.args.length - 1];
    expect(prompt).toContain("SERVER INSTRUCTIONS");
    expect(prompt).toContain("SYSTEM PROMPT");
    expect(prompt.endsWith("draw a sword")).toBe(true);
    expect(log.imagesExist).toEqual([true]);
    // Attached images are temporary.
    expect(readdirSync(join(workDir, "images"))).toEqual([]);

    const sessionId = (first[0] as { sessionId: string }).sessionId;
    const second = await collect(r.run(request({ sessionId, prompt: "darker" })));
    expect(second[2]).toEqual({ type: "text", text: "Drew it (resumed)." });
    const resumed = logEntries()[1];
    expect(resumed.args.slice(resumed.args.indexOf("resume"))).toEqual(["resume", sessionId, "darker"]);
  });

  it("reports failed turns with a login hint", async () => {
    const events = await collect(runner().run(request({ prompt: "FAIL" })));
    expect(last(events)).toMatchObject({ ok: false, error: expect.stringContaining("codex login") });
  });

  it("tells how to install a missing CLI", async () => {
    const events = await collect(runner(join(workDir, "nope-codex")).run(request()));
    expect(last(events)).toMatchObject({ ok: false, error: expect.stringContaining("npm install -g @openai/codex") });
  });
});

describe("gemini events", () => {
  it("joins text deltas into one message and strips the MCP tool prefix", () => {
    const parser = new GeminiStreamParser();
    expect(parser.push({ type: "init", session_id: "s1", model: "gemini-3-pro" })).toEqual([
      { kind: "events", events: [{ type: "session", sessionId: "s1" }] },
    ]);
    expect(parser.push({ type: "message", role: "user", content: "hi" })).toEqual([]);
    expect(parser.push({ type: "message", role: "assistant", content: "Let me ", delta: true })).toEqual([]);
    expect(parser.push({ type: "message", role: "assistant", content: "draw.", delta: true })).toEqual([]);
    expect(parser.push({ type: "tool_use", tool_name: "mcp_aseprite_view_sprite", tool_id: "1", parameters: {} })).toEqual([
      { kind: "events", events: [{ type: "text", text: "Let me draw." }] },
      { kind: "events", events: [{ type: "tool", name: "view_sprite" }] },
    ]);
  });

  it("maps the result line to stats, flushing pending text first", () => {
    const parser = new GeminiStreamParser();
    parser.push({ type: "message", role: "assistant", content: "Done.", delta: true });
    expect(
      parser.push({ type: "result", status: "success", stats: { input_tokens: 10, output_tokens: 2, duration_ms: 99, tool_calls: 1 } }),
    ).toEqual([
      { kind: "events", events: [{ type: "text", text: "Done." }] },
      { kind: "result", ok: true, error: undefined, stats: { durationMs: 99, inputTokens: 10, outputTokens: 2 } },
    ]);
  });

  it("maps errors and ignores warnings and unknown events", () => {
    const parser = new GeminiStreamParser();
    expect(parser.push({ type: "error", severity: "warning", message: "slow" })).toEqual([]);
    expect(parser.push({ type: "error", severity: "error", message: "bad" })).toEqual([{ kind: "error", message: "bad" }]);
    expect(parser.push({ type: "tool_result", tool_id: "1", status: "success" })).toEqual([]);
    expect(parser.push({ type: "brand_new_event" })).toEqual([]);
    expect(geminiErrorMessage("Please set an Auth method")).toContain("Login with Google");
    expect(geminiErrorMessage("Quota exceeded")).toMatch(/^Gemini usage limit reached/);
  });

  it("builds args and per-run settings limited to the bridge's MCP server", () => {
    expect(geminiArgs({ prompt: "-x", model: "pro", resumeId: "s1" })).toEqual([
      "--prompt=-x",
      "--output-format", "stream-json",
      "--approval-mode", "yolo",
      "--allowed-mcp-server-names", "aseprite",
      "--model", "pro",
      "--resume", "s1",
    ]);
    const settings = geminiSettings(MCP_URL);
    expect(settings.mcpServers.aseprite).toEqual({ httpUrl: MCP_URL, trust: true, timeout: 600_000 });
    expect(settings.mcp.allowed).toEqual(["aseprite"]);
    expect(settings.tools.exclude).toContain("run_shell_command");
  });
});

describe("GeminiCliRunner (fake CLI)", () => {
  const runner = (geminiPath = fakeCli("fake-gemini.mjs")) => new GeminiCliRunner({ geminiPath, workDir, instructions });

  it("streams a run with per-run settings and resumes follow-ups", async () => {
    const r = runner();
    const first = await collect(r.run(request({ model: "flash" })));
    expect(first).toEqual([
      { type: "session", sessionId: "a1b2c3d4-0000-4000-8000-000000000001" },
      { type: "text", text: "Let me draw that." },
      { type: "tool", name: "draw_script" },
      { type: "text", text: "Done." },
      { type: "done", ok: true, stats: { durationMs: 4321, inputTokens: 300, outputTokens: 30 } },
    ]);
    const [log] = logEntries();
    expect(log.trust).toBe("true");
    expect(log.settings.mcpServers.aseprite.httpUrl).toBe(MCP_URL);
    // One line on Windows (cmd.exe ends the command line at a newline), as sent elsewhere.
    expect(log.args[0]).toMatch(/^--prompt=<instructions>\s+SERVER INSTRUCTIONS/);
    expect(log.args).toEqual(expect.arrayContaining(["--model", "flash"]));
    // The per-run settings file is removed afterwards.
    expect(readdirSync(join(workDir, ".runs"))).toEqual([]);

    const second = await collect(r.run(request({ sessionId: "a1b2c3d4-0000-4000-8000-000000000001", prompt: "again" })));
    expect(second.find((e) => e.type === "text" && e.text === "Done again.")).toBeTruthy();
    expect(logEntries()[1].args).toEqual(expect.arrayContaining(["--prompt=again", "--resume", "a1b2c3d4-0000-4000-8000-000000000001"]));
  });

  it("explains a missing login", async () => {
    const events = await collect(runner().run(request({ prompt: "AUTHFAIL" })));
    expect(last(events)).toMatchObject({ ok: false, error: expect.stringContaining("Login with Google") });
  });

  it("tells how to install a missing CLI", async () => {
    const events = await collect(runner(join(workDir, "nope-gemini")).run(request()));
    expect(last(events)).toMatchObject({ ok: false, error: expect.stringContaining("npm install -g @google/gemini-cli") });
    expect(existsSync(join(workDir, ".runs"))).toBe(true);
  });
});

describe("singleLineOnWindows", () => {
  it("joins lines only on Windows", async () => {
    const { singleLineOnWindows } = await import("../src/llm/cli/argv.js");
    expect(singleLineOnWindows("a\n\n  b\r\nc", "win32")).toBe("a b c");
    expect(singleLineOnWindows("a\nb", "darwin")).toBe("a\nb");
  });
});
