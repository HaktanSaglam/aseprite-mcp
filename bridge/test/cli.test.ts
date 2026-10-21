import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// The CLI is plain JavaScript (bin/), so it is tested as users run it: as a child process.
const BRIDGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CLI = join(BRIDGE_ROOT, "bin", "aseprite-mcp.js");
const VERSION = JSON.parse(readFileSync(join(BRIDGE_ROOT, "package.json"), "utf8")).version as string;

interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

// Async on purpose: the fake bridges below live in this process and must keep answering
// while the CLI runs, which spawnSync would prevent by blocking the event loop.
function runCli(args: string[], env: Record<string, string | undefined> = {}): Promise<CliRun> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv.ASEPRITE_MCP_PORT;
  delete childEnv.ASEPRITE_WS_PORT;
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete childEnv[key];
    else childEnv[key] = value;
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: childEnv });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

describe("aseprite-mcp CLI", () => {
  it("prints the package version", async () => {
    const run = await runCli(["--version"]);
    expect(run.code).toBe(0);
    expect(run.stdout.trim()).toBe(VERSION);
  });

  it("prints usage for --help and help", async () => {
    for (const args of [["--help"], ["help"]]) {
      const run = await runCli(args);
      expect(run.code).toBe(0);
      expect(run.stdout).toContain(`aseprite-mcp ${VERSION}`);
      expect(run.stdout).toContain("print-config <client>");
      expect(run.stdout).toContain("doctor");
    }
  });

  it("rejects unknown commands and options with exit code 2", async () => {
    const command = await runCli(["draw"]);
    expect(command.code).toBe(2);
    expect(command.stderr).toContain('Unknown command "draw"');

    const option = await runCli(["--bogus"]);
    expect(option.code).toBe(2);
    expect(option.stderr).toContain("Unknown option '--bogus'.");
    expect(option.stderr).not.toContain("To specify a positional");
  });

  it("validates ports before starting anything", async () => {
    for (const args of [["start", "--port", "abc"], ["--port", "70000"], ["start", "--ws-port", "0"]]) {
      const run = await runCli(args);
      expect(run.code).toBe(2);
      expect(run.stderr).toMatch(/must be a port number between 1 and 65535/);
    }
  });
});

describe("print-config", () => {
  const url = "http://127.0.0.1:7900/mcp";
  const config = async (client: string) => {
    const run = await runCli(["print-config", client, "--port", "7900"]);
    expect(run.code, run.stderr).toBe(0);
    return run;
  };
  const jsonConfig = async (client: string) => JSON.parse((await config(client)).stdout);

  it("lists every client when no client is given", async () => {
    const run = await runCli(["print-config"]);
    expect(run.code).toBe(0);
    for (const id of ["claude-code", "claude-desktop", "codex", "cursor", "vscode", "gemini-cli", "windsurf", "zed", "generic"]) {
      expect(run.stdout).toContain(id);
    }
    expect(run.stdout).toContain("http://127.0.0.1:7800/mcp");
  });

  it("claude-code: a claude mcp add command for the user scope", async () => {
    const run = await config("claude-code");
    expect(run.stdout.trim()).toBe(`claude mcp add --transport http --scope user aseprite ${url}`);
    expect(run.stderr).toContain("claude mcp get aseprite");
  });

  it("claude-desktop: a stdio server that relays through mcp-remote", async () => {
    expect(await jsonConfig("claude-desktop")).toEqual({
      mcpServers: { aseprite: { command: "npx", args: ["-y", "mcp-remote", url] } },
    });
  });

  it("codex: a [mcp_servers.aseprite] TOML table", async () => {
    const run = await config("codex");
    expect(run.stdout).toBe(`[mcp_servers.aseprite]\nurl = "${url}"\n`);
    expect(run.stderr).toContain(`codex mcp add aseprite --url ${url}`);
  });

  it("cursor: mcpServers with a url", async () => {
    expect(await jsonConfig("cursor")).toEqual({ mcpServers: { aseprite: { url } } });
  });

  it("vscode: the servers key with type http", async () => {
    expect(await jsonConfig("vscode")).toEqual({ servers: { aseprite: { type: "http", url } } });
  });

  it("gemini-cli: httpUrl selects Streamable HTTP", async () => {
    expect(await jsonConfig("gemini-cli")).toEqual({ mcpServers: { aseprite: { httpUrl: url } } });
  });

  it("windsurf: serverUrl", async () => {
    expect(await jsonConfig("windsurf")).toEqual({ mcpServers: { aseprite: { serverUrl: url } } });
  });

  it("zed: context_servers", async () => {
    expect(await jsonConfig("zed")).toEqual({ context_servers: { aseprite: { url } } });
  });

  it("generic: type http + url", async () => {
    expect(await jsonConfig("generic")).toEqual({ mcpServers: { aseprite: { type: "http", url } } });
  });

  it("keeps hints out of stdout so the snippet can be redirected into a file", async () => {
    const run = await config("cursor");
    expect(run.stdout).not.toContain("#");
    expect(run.stderr).toMatch(/^# /m);
  });

  it("takes the port from ASEPRITE_MCP_PORT when --port is absent", async () => {
    const run = await runCli(["print-config", "cursor"], { ASEPRITE_MCP_PORT: "7955" });
    expect(JSON.parse(run.stdout).mcpServers.aseprite.url).toBe("http://127.0.0.1:7955/mcp");
  });

  it("names the valid clients when the client is unknown", async () => {
    const run = await runCli(["print-config", "notepad"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain('Unknown client "notepad"');
    expect(run.stderr).toContain("claude-desktop");
  });
});

// ---------------------------------------------------------------- doctor

type Handler = (req: IncomingMessage, res: ServerResponse, body: unknown) => Promise<void> | void;

async function listen(handler: Handler): Promise<{ port: number; server: Server }> {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    await handler(req, res, raw ? JSON.parse(raw) : undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: (server.address() as AddressInfo).port, server };
}

/** A real MCP SDK server, wired like src/mcp/httpServer.ts (stateless Streamable HTTP). */
function fakeBridge(name: string, listSprites: () => CallToolResult): Handler {
  return async (req, res, body) => {
    const mcp = new McpServer({ name, version: "9.9.9" });
    mcp.registerTool("list_sprites", { description: "test double" }, async () => listSprites());
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  };
}

describe("doctor", () => {
  let home: string;
  const servers: Server[] = [];

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), "aseprite-mcp-doctor-"));
  });
  afterAll(() => rmSync(home, { recursive: true, force: true }));
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  const serve = async (handler: Handler) => {
    const { port, server } = await listen(handler);
    servers.push(server);
    return port;
  };

  /** A port that was just free: connecting to it is refused at once. */
  const closedPort = async () => {
    const { port, server } = await listen(() => undefined);
    await new Promise((resolve) => server.close(resolve));
    return port;
  };

  /** Isolated environment: no real Aseprite folder, config file or Claude CLI is consulted. */
  const doctor = (port: number, env: Record<string, string> = {}) =>
    runCli(["doctor", "--port", String(port)], {
      ASEPRITE_USER_FOLDER: join(home, "aseprite"),
      ASEPRITE_MCP_CONFIG: join(home, "missing-config.json"),
      CLAUDE_PATH: join(home, "no-such-claude"),
      ...env,
    });

  it("fails with a start hint when nothing listens on the port", async () => {
    const run = await doctor(await closedPort());
    expect(run.code).toBe(1);
    expect(run.stdout).toMatch(/FAIL\s+Bridge is not running/);
    expect(run.stdout).toContain("scripts/install.sh --service");
  }, 20_000);

  it("recognises the bridge and reports when Aseprite is not connected", async () => {
    const port = await serve(
      fakeBridge("aseprite-mcp", () => {
        throw new Error("Aseprite is not connected. Open Aseprite with the Aseprite MCP extension installed.");
      }),
    );
    const run = await doctor(port);
    expect(run.stdout).toMatch(new RegExp(`OK\\s+Bridge 9\\.9\\.9 is running at http://127\\.0\\.0\\.1:${port}/mcp`));
    expect(run.stdout).toMatch(/WARN\s+Aseprite is not connected to the bridge/);
    expect(run.stdout).toContain("Allow to Open Connections");
  }, 20_000);

  it("reports a connected Aseprite", async () => {
    const port = await serve(fakeBridge("aseprite-mcp", () => ({ content: [{ type: "text", text: '{"sprites":[]}' }] })));
    const run = await doctor(port);
    expect(run.stdout).toMatch(/OK\s+Aseprite is connected/);
  }, 20_000);

  it("names a different MCP server that occupies the port", async () => {
    const port = await serve(fakeBridge("some-other-server", () => ({ content: [] })));
    const run = await doctor(port);
    expect(run.code).toBe(1);
    expect(run.stdout).toMatch(/FAIL\s+Port \d+ is used by another MCP server \("some-other-server"\)/);
    expect(run.stdout).not.toContain("Aseprite is connected");
  }, 20_000);

  it("detects a non-MCP program on the port", async () => {
    const port = await serve((_req, res) => {
      res.writeHead(404, { "content-type": "text/html" });
      res.end("<h1>Not found</h1>");
    });
    const run = await doctor(port);
    expect(run.code).toBe(1);
    expect(run.stdout).toMatch(/FAIL\s+Port \d+ answers, but not like the bridge \(HTTP 404\)/);
  }, 20_000);

  it("checks the installed extension version and the legacy extension", async () => {
    const port = await closedPort();
    const extensions = join(home, "user-folder", "extensions");
    mkdirSync(join(extensions, "aseprite-mcp"), { recursive: true });
    mkdirSync(join(extensions, "claude-pixel-bridge"), { recursive: true });
    const write = (version: string) =>
      writeFileSync(join(extensions, "aseprite-mcp", "package.json"), JSON.stringify({ name: "aseprite-mcp", version }));

    write(VERSION);
    let run = await doctor(port, { ASEPRITE_USER_FOLDER: join(home, "user-folder") });
    expect(run.stdout).toMatch(new RegExp(`OK\\s+Aseprite MCP extension ${VERSION.replace(/\./g, "\\.")} is installed`));
    expect(run.stdout).toMatch(/WARN\s+The old "Claude Pixel Bridge" extension is still installed/);

    write("0.0.1");
    run = await doctor(port, { ASEPRITE_USER_FOLDER: join(home, "user-folder") });
    expect(run.stdout).toMatch(new RegExp(`WARN\\s+Extension 0\\.0\\.1 and bridge ${VERSION.replace(/\./g, "\\.")} differ`));
  }, 30_000);

  it("warns when the extension folder has no Aseprite MCP extension", async () => {
    const port = await closedPort();
    const run = await doctor(port);
    expect(run.stdout).toMatch(/WARN\s+Aseprite MCP extension not found in /);
  }, 20_000);

  it("validates the provider config file", async () => {
    const port = await closedPort();
    const config = join(home, "config.json");

    writeFileSync(config, "{ not json");
    let run = await doctor(port, { ASEPRITE_MCP_CONFIG: config });
    expect(run.stdout).toMatch(/FAIL\s+Provider config .* is not valid JSON/);

    writeFileSync(config, JSON.stringify({ providers: {} }));
    run = await doctor(port, { ASEPRITE_MCP_CONFIG: config });
    expect(run.stdout).toMatch(/OK\s+Provider config .* is valid JSON/);
  }, 30_000);

  it("finds the Claude CLI through CLAUDE_PATH or explains how to install it", async () => {
    const port = await closedPort();
    let run = await doctor(port);
    expect(run.stdout).toMatch(/WARN\s+Claude Code CLI not found/);
    expect(run.stdout).toContain("claude auth login");

    // Any executable that answers --version stands in for the real CLI.
    run = await doctor(port, { CLAUDE_PATH: process.execPath });
    expect(run.stdout).toMatch(/OK\s+Claude Code CLI found \(v\d+/);
  }, 30_000);
});
