import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

interface Options {
  host: string;
  port: number;
}

const MAX_BODY_BYTES = 10 * 1024 * 1024;

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJsonRpcError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

/**
 * Stateless Streamable HTTP: every POST gets a fresh McpServer + transport.
 * Several Claude sessions (chat + headless popup jobs) can then share one bridge
 * without session bookkeeping, since all real state lives in Aseprite.
 */
export function startMcpHttpServer(options: Options, buildServer: () => McpServer): Promise<Server> {
  // A web page could otherwise reach us via DNS rebinding (evil.com resolving to 127.0.0.1).
  const allowedHosts = new Set([`127.0.0.1:${options.port}`, `localhost:${options.port}`]);

  const http = createServer(async (req, res) => {
    if (!req.url?.startsWith("/mcp")) return sendJsonRpcError(res, 404, "Not found");
    if (!allowedHosts.has(req.headers.host ?? "")) return sendJsonRpcError(res, 403, "Host not allowed");
    if (req.method !== "POST") return sendJsonRpcError(res, 405, "Method not allowed");

    try {
      const body = await readJsonBody(req);
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (error) {
      console.error("[bridge] MCP request failed:", error);
      if (!res.headersSent) sendJsonRpcError(res, 500, "Internal server error");
    }
  });

  return new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(options.port, options.host, () => resolve(http));
  });
}
