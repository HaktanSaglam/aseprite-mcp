import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mcpUrls, routeScope, startMcpHttpServer, type McpScope } from "../src/mcp/httpServer.js";

describe("routeScope", () => {
  it("maps /mcp to the unscoped server", () => {
    expect(routeScope("/mcp")).toEqual({});
    expect(routeScope("/mcp/")).toEqual({});
    expect(routeScope("/mcp?x=1")).toEqual({});
  });

  it("maps /mcp/sprite/<id> to a scope", () => {
    expect(routeScope("/mcp/sprite/12")).toEqual({ sprite: 12 });
    expect(routeScope("/mcp/sprite/12/")).toEqual({ sprite: 12 });
  });

  it("rejects everything else", () => {
    for (const path of ["/", "/mcpx", "/mcp/sprite", "/mcp/sprite/abc", "/mcp/sprite/0", "/mcp/sprite/-1", "/mcp/sprite/1/x", "/other"]) {
      expect(routeScope(path), path).toBeUndefined();
    }
  });
});

describe("mcpUrls", () => {
  it("builds the URLs routeScope understands", () => {
    const urls = mcpUrls("127.0.0.1", 7800);
    expect(urls.unscoped).toBe("http://127.0.0.1:7800/mcp");
    expect(urls.forSprite(5)).toBe("http://127.0.0.1:7800/mcp/sprite/5");
    expect(routeScope(new URL(urls.forSprite(5)).pathname)).toEqual({ sprite: 5 });
  });
});

describe("startMcpHttpServer", () => {
  let http: Server;
  let port: number;
  const scopes: McpScope[] = [];

  beforeAll(async () => {
    http = await startMcpHttpServer({ host: "127.0.0.1", port: 0 }, (scope) => {
      scopes.push(scope);
      const server = new McpServer({ name: "test", version: "1.0.0" });
      server.registerTool("whoami", { description: "Which sprite am I bound to?" }, async () => ({
        content: [{ type: "text", text: scope.sprite === undefined ? "active" : `sprite ${scope.sprite}` }],
      }));
      return server;
    });
    port = (http.address() as AddressInfo).port;
  });

  afterAll(() => {
    http.close();
  });

  async function callWhoami(path: string): Promise<string> {
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}${path}`)));
    try {
      const result = await client.callTool({ name: "whoami", arguments: {} });
      return (result.content as { type: string; text: string }[])[0].text;
    } finally {
      await client.close();
    }
  }

  function raw(path: string, options: { method?: string; host?: string; body?: string } = {}) {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path,
          method: options.method ?? "POST",
          agent: false,
          headers: {
            host: options.host ?? `127.0.0.1:${port}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
          },
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on("error", reject);
      req.end(options.body ?? "{}");
    });
  }

  it("serves unscoped tools on /mcp", async () => {
    expect(await callWhoami("/mcp")).toBe("active");
  });

  it("serves tools bound to a sprite on /mcp/sprite/<id>", async () => {
    expect(await callWhoami("/mcp/sprite/42")).toBe("sprite 42");
    expect(scopes).toContainEqual({ sprite: 42 });
  });

  it("allows localhost as the Host header", async () => {
    const res = await raw("/mcp", { host: `localhost:${port}`, method: "GET" });
    expect(res.status).toBe(405);
  });

  it("rejects foreign Host headers (DNS rebinding) before routing", async () => {
    expect((await raw("/mcp", { host: "evil.example:80" })).status).toBe(403);
    expect((await raw("/nope", { host: "evil.example:80" })).status).toBe(403);
  });

  it("answers 404 for unknown paths and 405 for non-POST", async () => {
    expect((await raw("/other")).status).toBe(404);
    expect((await raw("/mcp/sprite/abc")).status).toBe(404);
    expect((await raw("/mcp", { method: "GET" })).status).toBe(405);
  });

  it("answers 400 for a malformed body", async () => {
    const res = await raw("/mcp", { body: "{not json" });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error.message).toMatch(/Invalid request body/);
  });
});
