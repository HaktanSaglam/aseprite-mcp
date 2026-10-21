import { chmodSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

/** 1x1 PNG, what view_sprite-like tools return. */
export const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

export const MCP_INSTRUCTIONS = "TEST SERVER INSTRUCTIONS: draw carefully.";

/** Path of a fake CLI script in this folder, made executable (git may drop the bit). */
export function fakeCli(name: "fake-claude.mjs" | "fake-codex.mjs" | "fake-gemini.mjs"): string {
  const path = fileURLToPath(new URL(`./${name}`, import.meta.url));
  chmodSync(path, 0o755);
  return path;
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
}

function close(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export interface McpTestServer {
  url: string;
  calls: { name: string; args: Record<string, unknown> }[];
  close(): Promise<void>;
}

/**
 * A real MCP server over Streamable HTTP on an ephemeral port, with a "paint" tool that
 * returns text + an image and a "explode" tool that fails, like the bridge's own server.
 */
export async function startMcpTestServer(): Promise<McpTestServer> {
  const calls: McpTestServer["calls"] = [];
  const build = () => {
    const server = new McpServer({ name: "test", version: "1.0.0" }, { instructions: MCP_INSTRUCTIONS });
    server.registerTool(
      "paint",
      {
        description: "Paint the canvas.",
        inputSchema: { color: z.string().describe("A color"), palette: z.record(z.string(), z.string()).optional() },
      },
      async (args) => {
        calls.push({ name: "paint", args });
        return {
          content: [
            { type: "text", text: `painted ${args.color}` },
            { type: "image", data: TINY_PNG, mimeType: "image/png" },
          ],
        };
      },
    );
    server.registerTool("explode", { description: "Always fails.", inputSchema: {} }, async () => {
      calls.push({ name: "explode", args: {} });
      throw new Error("kaboom");
    });
    return server;
  };

  const http = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const body = JSON.parse(await readBody(req));
    const server = build();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  const base = await listen(http);
  return { url: `${base}/mcp`, calls, close: () => close(http) };
}

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: any;
}

export type MockReply = { status?: number; json?: unknown; delayMs?: number; headers?: Record<string, string> };

export interface MockHttpServer {
  url: string;
  requests: RecordedRequest[];
  /** Replies are used in order; the last one repeats. */
  reply(...replies: (MockReply | ((req: RecordedRequest) => MockReply))[]): void;
  close(): Promise<void>;
}

/** Scripted JSON HTTP server standing in for OpenAI / Anthropic / Ollama. */
export async function startMockHttpServer(): Promise<MockHttpServer> {
  const requests: RecordedRequest[] = [];
  let queue: (MockReply | ((req: RecordedRequest) => MockReply))[] = [{ status: 500, json: { error: "no reply scripted" } }];
  let next = 0;
  const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const text = await readBody(req);
    const recorded: RecordedRequest = {
      method: req.method ?? "",
      path: req.url ?? "",
      headers: req.headers,
      body: text ? JSON.parse(text) : undefined,
    };
    requests.push(recorded);
    const entry = queue[Math.min(next++, queue.length - 1)]!;
    const reply = typeof entry === "function" ? entry(recorded) : entry;
    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
    if (res.destroyed) return;
    res.writeHead(reply.status ?? 200, { "content-type": "application/json", ...reply.headers });
    res.end(JSON.stringify(reply.json ?? {}));
  });
  const url = await listen(http);
  return {
    url,
    requests,
    reply(...replies) {
      queue = replies;
      next = 0;
    },
    close: () => close(http),
  };
}
