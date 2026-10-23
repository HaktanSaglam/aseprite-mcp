import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** docs/PROTOCOL.md "tool_run": the non-AI tools the Tools tab may run directly. */
export const INSTANT_TOOLS: ReadonlySet<string> = new Set([
  "remove_background",
  "add_outline",
  "reduce_colors",
  "apply_palette",
  "adjust_colors",
  "replace_color",
  "cleanup_pixels",
  "transform_layer",
  "drop_shadow",
  "normalize_pixel_art",
  "import_image",
  "undo",
  "redo",
]);

export interface InstantToolRequest {
  tool: string;
  params: Record<string, unknown>;
  sprite?: number;
}

export interface InstantToolResult {
  ok: boolean;
  text: string;
}

/** Builds the MCP server whose tools act on `sprite` (the active sprite when undefined). */
export type ToolServerFactory = (sprite?: number) => McpServer;

/**
 * Runs a Tools-tab button through the very same MCP tool a model would call, in-process
 * over a linked in-memory transport: one implementation, identical validation and
 * error messages, no HTTP hop.
 */
export class InstantToolService {
  constructor(private readonly serverFor: ToolServerFactory) {}

  async run(request: InstantToolRequest): Promise<InstantToolResult> {
    if (!INSTANT_TOOLS.has(request.tool)) {
      return { ok: false, text: `"${request.tool}" is not an instant tool.` };
    }

    const server = this.serverFor(request.sprite);
    const client = new Client({ name: "aseprite-instant-tools", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      // A server without any tools has no tools/list handler at all, hence the catch.
      const { tools } = await client.listTools().catch(() => ({ tools: [] as { name: string }[] }));
      if (!tools.some((tool) => tool.name === request.tool)) {
        return { ok: false, text: `Tool not available in this build: ${request.tool}` };
      }

      const result = await client.callTool({ name: request.tool, arguments: request.params });
      const content = Array.isArray(result.content) ? result.content : [];
      const text = content.find((block): block is { type: "text"; text: string } => block?.type === "text")?.text;
      const ok = result.isError !== true;
      return { ok, text: text ?? (ok ? "Done." : `${request.tool} failed.`) };
    } catch (error) {
      return { ok: false, text: error instanceof Error ? error.message : String(error) };
    } finally {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    }
  }
}
