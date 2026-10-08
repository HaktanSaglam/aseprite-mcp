import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}
