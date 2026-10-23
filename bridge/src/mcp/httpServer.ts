import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

interface Options {
  host: string;
  /** 0 picks a free port (tests); the allowed Host headers follow the bound port. */
  port: number;
}

/** Which sprite a request's tools are bound to; `sprite` undefined = the active sprite. */
export interface McpScope {
  sprite?: number;
}

export type McpServerFactory = (scope: McpScope) => McpServer;

const UNSCOPED_PATH = "/mcp";
const SPRITE_PATH = /^\/mcp\/sprite\/([1-9]\d{0,9})\/?$/;
const MAX_BODY_BYTES = 10 * 1024 * 1024;

/** URLs of the bridge's MCP endpoints; the only place that knows the route format. */
export function mcpUrls(host: string, port: number) {
  const base = `http://${host}:${port}`;
  return {
    /** For external clients (Claude Code, Codex, Cursor): tools act on the active sprite. */
    unscoped: `${base}${UNSCOPED_PATH}`,
    /** For the bridge's own runs: every tool is bound to this sprite. */
    forSprite: (sprite: number) => `${base}${UNSCOPED_PATH}/sprite/${sprite}`,
  };
}

/** Maps a request path to its scope, or undefined for unknown paths. */
export function routeScope(url: string | undefined): McpScope | undefined {
  const path = new URL(url ?? "/", "http://localhost").pathname;
  if (path === UNSCOPED_PATH || path === `${UNSCOPED_PATH}/`) return {};
  const match = SPRITE_PATH.exec(path);
  return match ? { sprite: Number(match[1]) } : undefined;
}

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
 * Stateless Streamable HTTP: every POST gets a fresh McpServer + transport. Several
 * model runs (chat, parallel variations, external clients) then share one bridge
 * without session bookkeeping, since all real state lives in Aseprite.
 *
 *   POST /mcp                 tools act on the active sprite
 *   POST /mcp/sprite/<id>     tools are bound to sprite <id>
 */
export function startMcpHttpServer(options: Options, buildServer: McpServerFactory): Promise<Server> {
  // A web page could otherwise reach us via DNS rebinding (evil.com resolving to 127.0.0.1).
  let allowedHosts = new Set<string>();

  const http = createServer(async (req, res) => {
    if (!allowedHosts.has(req.headers.host ?? "")) return sendJsonRpcError(res, 403, "Host not allowed");
    const scope = routeScope(req.url);
    if (!scope) return sendJsonRpcError(res, 404, "Not found");
    if (req.method !== "POST") return sendJsonRpcError(res, 405, "Method not allowed");

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      return sendJsonRpcError(res, 400, `Invalid request body: ${error instanceof Error ? error.message : error}`);
    }

    try {
      const server = buildServer(scope);
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
    http.listen(options.port, options.host, () => {
      const { port } = http.address() as AddressInfo;
      allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
      resolve(http);
    });
  });
}
