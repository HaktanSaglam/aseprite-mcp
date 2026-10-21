// `aseprite-mcp doctor`: checks every link of the chain (Node, build, bridge, Aseprite,
// extension, Claude CLI, config file) and says how to fix what is broken. Plain JS so it
// also runs when the TypeScript build is missing, which is one of the things it checks.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** @typedef {"ok" | "warn" | "fail"} Status */
/** @typedef {{ status: Status, title: string, fix?: string }} CheckResult */

const PROBE_TIMEOUT_MS = 4000;
const LEGACY_EXTENSION = "claude-pixel-bridge";

/**
 * Aseprite's user folder. ASEPRITE_USER_FOLDER is Aseprite's own override (portable setups).
 * @param {NodeJS.ProcessEnv} env
 */
export function asepriteExtensionsDir(env, platform = process.platform) {
  if (env.ASEPRITE_USER_FOLDER) return join(env.ASEPRITE_USER_FOLDER, "extensions");
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", "Aseprite", "extensions");
  if (platform === "win32") {
    return join(env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "Aseprite", "extensions");
  }
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "aseprite", "extensions");
}

/**
 * Streamable HTTP answers with plain JSON or with an SSE stream whose "data:" lines
 * carry the JSON-RPC messages; returns the response for request `id`.
 * @param {string} body
 * @param {string | null} contentType
 * @param {number} id
 */
export function parseJsonRpcResponse(body, contentType, id) {
  /** @type {unknown[]} */
  const messages = [];
  if (contentType?.includes("text/event-stream")) {
    for (const line of body.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      try {
        messages.push(JSON.parse(line.slice(5)));
      } catch {
        // Not every data line has to be JSON-RPC; keep looking.
      }
    }
  } else {
    try {
      const parsed = JSON.parse(body);
      messages.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {
      return undefined;
    }
  }
  return /** @type {any} */ (messages.find((m) => typeof m === "object" && m !== null && "id" in m && m.id === id));
}

/**
 * @param {string} url
 * @param {string} method
 * @param {object} params
 */
async function rpc(url, method, params) {
  const id = 1;
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  const body = await response.text();
  return { status: response.status, message: parseJsonRpcResponse(body, response.headers.get("content-type"), id) };
}

/** @param {unknown} error */
function networkErrorCode(error) {
  const e = /** @type {any} */ (error);
  if (e?.name === "TimeoutError" || e?.name === "AbortError") return "TIMEOUT";
  return e?.cause?.code ?? e?.code ?? "UNKNOWN";
}

/** @returns {CheckResult} */
function checkNode() {
  const major = Number(process.versions.node.split(".")[0]);
  return major >= 20
    ? { status: "ok", title: `Node.js ${process.versions.node}` }
    : { status: "fail", title: `Node.js ${process.versions.node} is too old`, fix: "Install Node.js 20 or newer from https://nodejs.org" };
}

/** @param {string} bridgeRoot @returns {CheckResult} */
function checkBuild(bridgeRoot) {
  return existsSync(join(bridgeRoot, "dist", "index.js"))
    ? { status: "ok", title: "Bridge is built" }
    : { status: "fail", title: "Bridge is not built (dist/index.js missing)", fix: `cd "${bridgeRoot}" && npm ci && npm run build` };
}

/**
 * @param {string} url
 * @param {number} mcpPort
 * @returns {Promise<{ running: boolean, result: CheckResult }>}
 */
async function checkBridge(url, mcpPort) {
  const portHint = `free port ${mcpPort} or start the bridge on another one (ASEPRITE_MCP_PORT=7900 and the same port in your MCP client)`;
  try {
    const { status, message } = await rpc(url, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "aseprite-mcp-doctor", version: "1.0.0" },
    });
    const server = message?.result?.serverInfo;
    if (server?.name === "aseprite-mcp") {
      const version = server.version ? ` ${server.version}` : "";
      return { running: true, result: { status: "ok", title: `Bridge${version} is running at ${url}` } };
    }
    if (server?.name) {
      return { running: false, result: { status: "fail", title: `Port ${mcpPort} is used by another MCP server ("${server.name}")`, fix: portHint } };
    }
    return { running: false, result: { status: "fail", title: `Port ${mcpPort} answers, but not like the bridge (HTTP ${status})`, fix: portHint } };
  } catch (error) {
    const code = networkErrorCode(error);
    if (code === "ECONNREFUSED") {
      return {
        running: false,
        result: {
          status: "fail",
          title: `Bridge is not running (nothing listens on ${url})`,
          fix: "Start it with `aseprite-mcp` (from a checkout: node bridge/bin/aseprite-mcp.js) and keep that terminal open, or install the background service: scripts/install.sh --service",
        },
      };
    }
    return { running: false, result: { status: "fail", title: `Could not reach ${url} (${code})`, fix: portHint } };
  }
}

/** @param {string} url @returns {Promise<CheckResult>} */
async function checkAseprite(url) {
  const notConnected = {
    status: /** @type {Status} */ ("warn"),
    title: "Aseprite is not connected to the bridge",
    fix: "Open Aseprite with the Aseprite MCP extension installed and answer its Security prompt with \"Allow to Open Connections\". Already open? Edit > FX > Aseprite MCP > Reconnect Bridge.",
  };
  try {
    const { message } = await rpc(url, "tools/call", { name: "list_sprites", arguments: {} });
    const text = (message?.result?.content ?? [])
      .filter((/** @type {any} */ block) => block?.type === "text")
      .map((/** @type {any} */ block) => String(block.text))
      .join(" ");
    const error = message?.error?.message;
    if (/not connected/i.test(text) || /not connected/i.test(error ?? "")) return notConnected;
    if (message?.result && !message.result.isError) return { status: "ok", title: "Aseprite is connected" };
    return { status: "warn", title: `Could not query Aseprite: ${(error ?? text) || "no answer"}`.slice(0, 200) };
  } catch (error) {
    const code = networkErrorCode(error);
    return code === "TIMEOUT"
      ? {
          status: "warn",
          title: "Aseprite did not answer in time",
          // Aseprite's Lua runs on the UI thread, so a modal dialog stalls every request.
          fix: "Close any open dialog in Aseprite (Save, Preferences, Security prompt, an alert) and try again.",
        }
      : { status: "warn", title: `Could not query Aseprite (${code})` };
  }
}

/** @param {NodeJS.ProcessEnv} env @returns {CheckResult} */
function checkClaude(env) {
  const command = env.CLAUDE_PATH || "claude";
  // npm installs `claude` as a .cmd shim on Windows, which only starts through a shell.
  const isWindows = process.platform === "win32";
  const quoted = isWindows && /\s/.test(command) ? `"${command}"` : command;
  const run = isWindows
    ? spawnSync(`${quoted} --version`, { shell: true, encoding: "utf8", timeout: 15000, windowsHide: true })
    : spawnSync(command, ["--version"], { encoding: "utf8", timeout: 15000 });
  const version = run.stdout?.trim().split(/\r?\n/)[0];
  if (run.status === 0 && version) return { status: "ok", title: `Claude Code CLI found (${version})` };
  return {
    status: "warn",
    title: `Claude Code CLI not found ("${command}")`,
    fix: "Only needed for the in-Aseprite chat with the default provider: install https://claude.com/claude-code and run `claude auth login` (or set CLAUDE_PATH, or choose another provider in the assistant).",
  };
}

/** @param {string} file */
function readVersion(file) {
  try {
    return String(JSON.parse(readFileSync(file, "utf8")).version ?? "");
  } catch {
    return undefined;
  }
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} bridgeVersion
 * @returns {CheckResult[]}
 */
function checkExtension(env, bridgeVersion) {
  const dir = asepriteExtensionsDir(env);
  /** @type {CheckResult[]} */
  const results = [];
  const installed = readVersion(join(dir, "aseprite-mcp", "package.json"));
  if (installed === undefined) {
    results.push({
      status: "warn",
      title: `Aseprite MCP extension not found in ${dir}`,
      fix: "Install dist/aseprite-mcp.aseprite-extension: Aseprite > Edit > Preferences > Extensions > Add Extension (scripts/install.sh builds the file). Ignore this if Aseprite uses a custom user folder.",
    });
  } else if (installed !== bridgeVersion) {
    results.push({
      status: "warn",
      title: `Extension ${installed} and bridge ${bridgeVersion} differ`,
      fix: "Reinstall the extension from this version (scripts/install.sh), then restart Aseprite.",
    });
  } else {
    results.push({ status: "ok", title: `Aseprite MCP extension ${installed} is installed` });
  }
  if (existsSync(join(dir, LEGACY_EXTENSION))) {
    results.push({
      status: "warn",
      title: "The old \"Claude Pixel Bridge\" extension is still installed",
      fix: "Uninstall it (Edit > Preferences > Extensions > Claude Pixel Bridge > Uninstall): both copies connect to the bridge and keep replacing each other.",
    });
  }
  return results;
}

/** @param {NodeJS.ProcessEnv} env @returns {CheckResult} */
function checkConfigFile(env) {
  const file = env.ASEPRITE_MCP_CONFIG || join(homedir(), ".aseprite-mcp", "config.json");
  if (!existsSync(file)) return { status: "ok", title: `No provider config file (${file}); using defaults` };
  try {
    JSON.parse(readFileSync(file, "utf8"));
    return { status: "ok", title: `Provider config ${file} is valid JSON` };
  } catch (error) {
    return {
      status: "fail",
      title: `Provider config ${file} is not valid JSON`,
      fix: `Fix or delete the file: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

const LABELS = { ok: "OK  ", warn: "WARN", fail: "FAIL" };

/**
 * Runs every check, printing each result as soon as it is known.
 * @param {{ mcpPort: number, bridgeRoot: string, bridgeVersion: string, env: NodeJS.ProcessEnv, write: (line: string) => void }} options
 * @returns {Promise<number>} process exit code: 1 when something is broken
 */
export async function runDoctor({ mcpPort, bridgeRoot, bridgeVersion, env, write }) {
  const url = `http://127.0.0.1:${mcpPort}/mcp`;
  let fails = 0;
  let warns = 0;
  /** @param {CheckResult} result */
  const report = (result) => {
    if (result.status === "fail") fails++;
    if (result.status === "warn") warns++;
    write(`  ${LABELS[result.status]}  ${result.title}`);
    if (result.fix && result.status !== "ok") write(`        -> ${result.fix}`);
  };

  write(`Aseprite MCP doctor (bridge ${bridgeVersion})`);
  write("");
  report(checkNode());
  report(checkBuild(bridgeRoot));
  const bridge = await checkBridge(url, mcpPort);
  report(bridge.result);
  if (bridge.running) report(await checkAseprite(url));
  for (const result of checkExtension(env, bridgeVersion)) report(result);
  report(checkClaude(env));
  report(checkConfigFile(env));

  write("");
  if (fails === 0 && warns === 0) write("Everything looks good.");
  else write(`${fails} problem(s), ${warns} warning(s). More help: docs/TROUBLESHOOTING.md`);
  return fails > 0 ? 1 : 0;
}
