#!/usr/bin/env node
// Stand-in for `claude -p --input-format stream-json --output-format stream-json`.
// Reads user messages from stdin, answers each with realistic stream-json lines and
// logs its argv and inputs to $FAKE_CLI_LOG. Directives inside the prompt text:
//   ERROR401  → login-expired error result      RATELIMIT → usage-limit error result
//   HANG      → never answers (abort tests)     CRASH     → stderr + exit code 3
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const log = (entry) => {
  if (process.env.FAKE_CLI_LOG) appendFileSync(process.env.FAKE_CLI_LOG, JSON.stringify({ cli: "claude", pid: process.pid, ...entry }) + "\n");
};
const out = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

log({ event: "start", args });
const resumed = flag("--resume");
const sessionId = resumed ?? `session-${process.pid}`;
// Like the real CLI: total_cost_usd is cumulative for the session, even across --resume.
let totalCost = resumed ? 0.5 : 0;
let turn = 0;

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const input = JSON.parse(line);
  log({ event: "input", input });
  const content = input.message?.content ?? [];
  const text = content.filter((b) => b.type === "text").map((b) => b.text).join(" ");
  const images = content.filter((b) => b.type === "image").length;
  turn++;
  out({ type: "system", subtype: "init", session_id: sessionId, model: flag("--model") ?? "default" });

  if (text.includes("HANG")) continue;
  if (text.includes("CRASH")) {
    process.stderr.write("fatal: something broke\n");
    process.exit(3);
  }
  if (text.includes("ERROR401")) {
    out({ type: "assistant", session_id: sessionId, message: { model: "<synthetic>", content: [{ type: "text", text: "API Error: 401" }] } });
    out({ type: "result", subtype: "success", is_error: true, api_error_status: 401, result: "Invalid API key · Please run /login", session_id: sessionId, duration_ms: 5, num_turns: 1, total_cost_usd: totalCost, usage: {} });
    continue;
  }
  if (text.includes("RATELIMIT")) {
    out({ type: "result", subtype: "success", is_error: true, api_error_status: 429, result: "You've hit your usage limit · resets 5pm", session_id: sessionId, duration_ms: 5, num_turns: 1, total_cost_usd: totalCost, usage: {} });
    continue;
  }

  out({ type: "rate_limit_event", session_id: sessionId });
  out({
    type: "assistant",
    session_id: sessionId,
    message: {
      model: "claude-opus-5-5",
      content: [
        { type: "text", text: `turn ${turn} on pid ${process.pid} images=${images}` },
        { type: "tool_use", id: "toolu_1", name: "mcp__aseprite__draw_script", input: { code: "fill()" } },
      ],
    },
  });
  out({ type: "user", session_id: sessionId, message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] } });
  out({ type: "assistant", session_id: sessionId, message: { model: "claude-opus-5-5", content: [{ type: "text", text: "done" }] } });
  totalCost += 0.01;
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: sessionId,
    duration_ms: 1234,
    num_turns: 2,
    total_cost_usd: totalCost,
    usage: { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 5, output_tokens: 20 },
    result: "done",
  });
}
log({ event: "stdin_closed" });
