#!/usr/bin/env node
// Dev helper: call one MCP tool on the running bridge and print the result.
//   node scripts/mcp-call.mjs <tool> '<json args>' [--png out.png]
//   node scripts/mcp-call.mjs --list
import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env.ASEPRITE_MCP_URL ?? "http://127.0.0.1:7800/mcp";
const [, , tool, rawArgs = "{}", ...rest] = process.argv;
const pngIndex = rest.indexOf("--png");
const pngPath = pngIndex >= 0 ? rest[pngIndex + 1] : undefined;

const client = new Client({ name: "mcp-call", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));
try {
  if (tool === "--list") {
    const { tools } = await client.listTools();
    for (const t of tools) console.log(`${t.name}: ${(t.description ?? "").split("\n")[0].slice(0, 100)}`);
  } else {
    const started = Date.now();
    const result = await client.callTool({ name: tool, arguments: JSON.parse(rawArgs) });
    const ms = Date.now() - started;
    for (const block of result.content ?? []) {
      if (block.type === "text") console.log(block.text.length > 4000 ? block.text.slice(0, 4000) + "…" : block.text);
      if (block.type === "image") {
        if (pngPath) writeFileSync(pngPath, Buffer.from(block.data, "base64"));
        console.log(`[image ${block.mimeType}, ${block.data.length} b64 chars${pngPath ? ` → ${pngPath}` : ""}]`);
      }
    }
    if (result.isError) process.exitCode = 1;
    console.error(`(${ms} ms)`);
  }
} finally {
  await client.close();
}
