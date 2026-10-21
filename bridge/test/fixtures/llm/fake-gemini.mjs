#!/usr/bin/env node
// Stand-in for `gemini --prompt=... --output-format stream-json ...`. Logs argv, the
// per-run settings file it was pointed at, and prints stream-json events.
// Directives in the prompt: AUTHFAIL → error result about missing auth.
import { appendFileSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
const prompt = (args.find((a) => a.startsWith("--prompt=")) ?? "").slice("--prompt=".length);
const settingsPath = process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH;
if (process.env.FAKE_CLI_LOG) {
  appendFileSync(
    process.env.FAKE_CLI_LOG,
    JSON.stringify({
      cli: "gemini",
      pid: process.pid,
      args,
      trust: process.env.GEMINI_CLI_TRUST_WORKSPACE,
      settings: settingsPath ? JSON.parse(readFileSync(settingsPath, "utf8")) : null,
    }) + "\n",
  );
}
const out = (msg) => process.stdout.write(JSON.stringify({ timestamp: new Date().toISOString(), ...msg }) + "\n");
const resumeAt = args.indexOf("--resume");
const sessionId = resumeAt >= 0 ? args[resumeAt + 1] : "a1b2c3d4-0000-4000-8000-000000000001";

out({ type: "init", session_id: sessionId, model: "gemini-3-pro" });
out({ type: "message", role: "user", content: prompt });
if (prompt.includes("AUTHFAIL")) {
  out({ type: "result", status: "error", error: { type: "auth", message: "Please set an Auth method in your settings.json" } });
  process.exit(1);
}
out({ type: "message", role: "assistant", content: "Let me ", delta: true });
out({ type: "message", role: "assistant", content: "draw that.", delta: true });
out({ type: "tool_use", tool_name: "mcp_aseprite_draw_script", tool_id: "t1", parameters: { code: "x" } });
out({ type: "tool_result", tool_id: "t1", status: "success", output: "ok" });
out({ type: "message", role: "assistant", content: resumeAt >= 0 ? "Done again." : "Done.", delta: true });
out({
  type: "result",
  status: "success",
  stats: { total_tokens: 330, input_tokens: 300, output_tokens: 30, cached: 100, input: 200, duration_ms: 4321, tool_calls: 1, models: {} },
});
