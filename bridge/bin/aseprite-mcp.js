#!/usr/bin/env node
// Command-line entry (package.json "bin"). Plain JavaScript outside src/ so that --help,
// print-config and doctor work before the TypeScript build exists.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const MIN_NODE_MAJOR = 20;
const BRIDGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(BRIDGE_ROOT, "dist", "index.js");

const USAGE = `Usage:
  aseprite-mcp [start] [--port <n>] [--ws-port <n>]   Start the bridge (default command)
  aseprite-mcp print-config <client> [--port <n>]      Print the MCP config for a client
  aseprite-mcp doctor [--port <n>]                     Check the setup and explain problems
  aseprite-mcp --version | --help

Options:
  --port <n>      MCP HTTP port (default: $ASEPRITE_MCP_PORT or 7800)
  --ws-port <n>   Port the Aseprite extension connects to (default: $ASEPRITE_WS_PORT or 7801)

Environment: ASEPRITE_MCP_PORT, ASEPRITE_WS_PORT, ASEPRITE_REQUEST_TIMEOUT_MS,
  ASEPRITE_MCP_CONFIG (provider settings, default ~/.aseprite-mcp/config.json),
  CLAUDE_PATH (Claude Code CLI used by the in-Aseprite chat).

Docs: https://github.com/HaktanSaglam/aseprite-mcp`;

/** Thrown for user mistakes: printed without a stack trace, exit code 2. */
class UsageError extends Error {}

function bridgeVersion() {
  return String(JSON.parse(readFileSync(join(BRIDGE_ROOT, "package.json"), "utf8")).version);
}

/** @param {string | undefined} value @param {string} flag */
function parsePort(value, flag) {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new UsageError(`${flag} must be a port number between 1 and 65535, got "${value}"`);
  }
  return port;
}

/** @param {number | undefined} flagPort */
function mcpPort(flagPort) {
  return flagPort ?? parsePort(process.env.ASEPRITE_MCP_PORT, "ASEPRITE_MCP_PORT") ?? 7800;
}

/** @param {{ port?: number, wsPort?: number }} options */
async function start({ port, wsPort }) {
  if (!existsSync(ENTRY)) {
    throw new UsageError(
      `The bridge is not built yet (${ENTRY} is missing).\nRun: cd "${BRIDGE_ROOT}" && npm ci && npm run build`,
    );
  }
  // The bridge reads its settings from the environment (src/config.ts).
  if (port !== undefined) process.env.ASEPRITE_MCP_PORT = String(port);
  if (wsPort !== undefined) process.env.ASEPRITE_WS_PORT = String(wsPort);
  await import(pathToFileURL(ENTRY).href);
}

/** @param {string | undefined} clientId @param {number} port */
async function printConfig(clientId, port) {
  const { CLIENTS, CLIENT_IDS } = await import("./lib/clients.js");
  const url = `http://127.0.0.1:${port}/mcp`;
  if (!clientId) {
    console.log(`Usage: aseprite-mcp print-config <client> [--port <n>]\n\nClients:`);
    for (const id of CLIENT_IDS) console.log(`  ${id.padEnd(16)}${CLIENTS[id].label}`);
    console.log(`\nMCP endpoint: ${url} (Streamable HTTP, no authentication)`);
    return;
  }
  const client = CLIENTS[clientId];
  if (!client) {
    throw new UsageError(`Unknown client "${clientId}". Choose one of: ${CLIENT_IDS.join(", ")}`);
  }
  // Only the snippet goes to stdout, so `print-config cursor > mcp.json` works.
  process.stdout.write(client.snippet(url));
  for (const line of client.hint(url)) console.error(`# ${line}`);
}

async function main() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < MIN_NODE_MAJOR) {
    throw new UsageError(`Aseprite MCP needs Node.js ${MIN_NODE_MAJOR} or newer; this is ${process.version}.`);
  }

  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
        port: { type: "string" },
        "ws-port": { type: "string" },
      },
    });
  } catch (error) {
    // Node appends a long hint about "--" positionals that does not apply here.
    const message = (error instanceof Error ? error.message : String(error)).replace(/\. To specify[\s\S]*$/, ".");
    throw new UsageError(`${message}\n\n${USAGE}`);
  }
  const { values, positionals } = parsed;
  const [command = "start", ...rest] = positionals;

  if (values.version) return console.log(bridgeVersion());
  if (values.help || command === "help") return console.log(`aseprite-mcp ${bridgeVersion()}\n\n${USAGE}`);

  const port = parsePort(values.port, "--port");
  const wsPort = parsePort(values["ws-port"], "--ws-port");

  switch (command) {
    case "start":
      return start({ port, wsPort });
    case "print-config":
      if (rest.length > 1) throw new UsageError(`print-config takes one client name, got: ${rest.join(" ")}`);
      return printConfig(rest[0], mcpPort(port));
    case "doctor": {
      const { runDoctor } = await import("./lib/doctor.js");
      process.exitCode = await runDoctor({
        mcpPort: mcpPort(port),
        bridgeRoot: BRIDGE_ROOT,
        bridgeVersion: bridgeVersion(),
        env: process.env,
        write: (line) => console.log(line),
      });
      return;
    }
    default:
      throw new UsageError(`Unknown command "${command}".\n\n${USAGE}`);
  }
}

main().catch((error) => {
  if (error instanceof UsageError) {
    console.error(`aseprite-mcp: ${error.message}`);
    process.exit(2);
  }
  console.error(error);
  process.exit(1);
});
