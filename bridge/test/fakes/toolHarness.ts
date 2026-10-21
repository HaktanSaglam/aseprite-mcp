import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { PNG } from "pngjs";
import { CanvasService } from "../../src/canvas/CanvasService.js";
import type { ToolRegistrar } from "../../src/mcp/ToolContext.js";
import type { IScriptRunner } from "../../src/script/ScriptRunner.js";
import { FakeGateway } from "./FakeGateway.js";

type Content = { type: string; text?: string; data?: string; mimeType?: string };

export interface ToolCallResult {
  isError: boolean;
  content: Content[];
  /** All text blocks joined. */
  text: string;
}

export interface ListedTool {
  name: string;
  description?: string;
  inputSchema: { properties?: Record<string, { description?: string }>; required?: string[] };
}

export interface ToolHarness {
  gateway: FakeGateway;
  listTools(): Promise<ListedTool[]>;
  call(name: string, args?: Record<string, unknown>): Promise<ToolCallResult>;
  /** Parses the JSON text result; fails the test when the tool returned an error. */
  json<T = any>(name: string, args?: Record<string, unknown>): Promise<T>;
  /** Returns the error text; fails the test when the tool succeeded. */
  error(name: string, args?: Record<string, unknown>): Promise<string>;
  close(): Promise<void>;
}

const noScripts: IScriptRunner = {
  run: async () => {
    throw new Error("draw_script is not available in this test");
  },
};

/**
 * Registers tools on a real McpServer and talks to it through an in-memory client,
 * so tests cover zod validation, defaults and error wrapping exactly as a model sees them.
 */
export async function toolHarness(registrars: ToolRegistrar[], gateway = new FakeGateway()): Promise<ToolHarness> {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  const ctx = { gateway, canvas: new CanvasService(gateway), scripts: noScripts };
  for (const register of registrars) register(server, ctx);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> => {
    const result = await client.callTool({ name, arguments: args });
    const content = (result.content ?? []) as Content[];
    const text = content
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n");
    return { isError: result.isError === true, content, text };
  };

  return {
    gateway,
    listTools: async () => (await client.listTools()).tools as ListedTool[],
    call,
    async json(name, args) {
      const result = await call(name, args);
      if (result.isError) throw new Error(`${name} failed: ${result.text}`);
      return JSON.parse(result.text);
    },
    async error(name, args) {
      const result = await call(name, args);
      if (!result.isError) throw new Error(`${name} was expected to fail but returned: ${result.text}`);
      return result.text;
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

/** Size of the PNG in an image result block. */
export function pngSize(content: Content[]): { width: number; height: number } {
  const block = content.find((c) => c.type === "image");
  if (!block?.data) throw new Error("no image in result");
  const png = PNG.sync.read(Buffer.from(block.data, "base64"));
  return { width: png.width, height: png.height };
}
