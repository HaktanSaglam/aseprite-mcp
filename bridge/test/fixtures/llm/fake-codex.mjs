#!/usr/bin/env node
// Stand-in for `codex [-c ...] exec --json ... [resume <id>] [-i img] <prompt>`.
// Prints the JSONL events of codex exec and logs argv to $FAKE_CLI_LOG.
// Directives in the prompt: FAIL → turn.failed with a 401 message.
import { appendFileSync, existsSync } from "node:fs";

const args = process.argv.slice(2);
const prompt = args[args.length - 1];
const images = args.flatMap((arg, i) => (arg === "-i" ? [args[i + 1]] : []));
if (process.env.FAKE_CLI_LOG) {
  appendFileSync(
    process.env.FAKE_CLI_LOG,
    JSON.stringify({ cli: "codex", pid: process.pid, args, imagesExist: images.map((p) => existsSync(p)) }) + "\n",
  );
}
const out = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const resumeAt = args.indexOf("resume");
const threadId = resumeAt >= 0 ? args[resumeAt + 1] : "0199a213-81c0-7800-8aa1-bbab2a035a53";

out({ type: "thread.started", thread_id: threadId });
out({ type: "turn.started" });
if (prompt.includes("FAIL")) {
  out({ type: "error", message: "unexpected status 401 Unauthorized" });
  out({ type: "turn.failed", error: { message: "unexpected status 401 Unauthorized" } });
  process.exit(1);
}
out({ type: "item.started", item: { id: "item_0", type: "mcp_tool_call", server: "aseprite", tool: "draw_script", arguments: {}, status: "in_progress" } });
out({ type: "item.completed", item: { id: "item_0", type: "mcp_tool_call", server: "aseprite", tool: "draw_script", arguments: {}, status: "completed", result: { content: [] } } });
out({ type: "item.completed", item: { id: "item_1", type: "reasoning", text: "thinking..." } });
out({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: `Drew it (${resumeAt >= 0 ? "resumed" : "new"}).` } });
out({ type: "turn.completed", usage: { input_tokens: 1200, cached_input_tokens: 800, output_tokens: 90, reasoning_output_tokens: 10 } });
