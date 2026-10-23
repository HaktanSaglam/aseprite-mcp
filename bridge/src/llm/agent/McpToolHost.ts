import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { LlmImage } from "../LlmRunner.js";
import type { IToolHost, JsonSchema, ToolOutcome, ToolSpec } from "./types.js";

// Big scenes drawn with draw_script can take a while; the SDK default (60 s) is too short.
const TOOL_TIMEOUT_MS = 10 * 60_000;
// A whole-canvas read_pixels is ~20k characters; anything far beyond that is noise.
const MAX_TEXT_CHARS = 60_000;

/**
 * Removes JSON Schema keywords that some OpenAI-compatible servers reject (Gemini,
 * older vLLM builds) and that add nothing for the model.
 */
export function sanitizeSchema(schema: unknown): JsonSchema {
  const clean = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(clean);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === "$schema" || key === "propertyNames" || key === "$id") continue;
      out[key] = clean(value);
    }
    return out;
  };
  const result = (clean(schema) ?? {}) as JsonSchema;
  if (result.type !== "object") return { type: "object", properties: {} };
  if (!result.properties) result.properties = {};
  return result;
}

/** MCP content blocks → text for the model plus the images it should see. */
export function toToolOutcome(result: Record<string, unknown>): ToolOutcome {
  const texts: string[] = [];
  const images: LlmImage[] = [];
  for (const block of Array.isArray(result.content) ? result.content : []) {
    if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
    else if (block?.type === "image" && typeof block.data === "string") {
      if (block.mimeType === "image/png") images.push({ mediaType: "image/png", base64: block.data });
      else texts.push(`[image of type ${block.mimeType} omitted]`);
    } else if (block?.type === "resource" && typeof block.resource?.text === "string") {
      texts.push(block.resource.text);
    }
  }
  let text = texts.join("\n");
  if (text.length > MAX_TEXT_CHARS) {
    text = `${text.slice(0, MAX_TEXT_CHARS)}\n[output truncated: ${text.length} characters in total]`;
  }
  return { text, images, isError: result.isError === true };
}

/** Connects to the bridge's MCP endpoint (or a scoped one) for the duration of one run. */
export async function connectMcpToolHost(mcpUrl: string): Promise<IToolHost> {
  const client = new Client({ name: "aseprite-mcp-agent", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));
  } catch (error) {
    throw new Error(
      `Cannot reach the Aseprite tools at ${mcpUrl}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const tools: ToolSpec[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    for (const tool of page.tools) {
      tools.push({ name: tool.name, description: tool.description ?? "", inputSchema: sanitizeSchema(tool.inputSchema) });
    }
    cursor = page.nextCursor;
  } while (cursor);

  return {
    instructions: client.getInstructions(),
    tools,
    async call(name, input, signal) {
      try {
        const result = await client.callTool({ name, arguments: input }, undefined, {
          signal,
          timeout: TOOL_TIMEOUT_MS,
          resetTimeoutOnProgress: true,
        });
        return toToolOutcome(result);
      } catch (error) {
        if (signal?.aborted) throw error;
        return { text: `Error: ${error instanceof Error ? error.message : String(error)}`, images: [], isError: true };
      }
    },
    close: () => client.close(),
  };
}
