import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AsepriteEvent } from "../aseprite/AsepriteSocket.js";
import type { TappedEvents } from "./TappedEvents.js";

interface Options {
  host: string;
  port: number;
}

// A whole generation (several parallel runs) can take minutes.
const CHAT_TIMEOUT_MS = 15 * 60_000;

function readJson(req: IncomingMessage): Promise<AsepriteEvent> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) req.destroy(new Error("Request body too large"));
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

/** Waits for the busy:false that ends the request and returns every update on the way. */
function runChat(events: TappedEvents, payload: AsepriteEvent): Promise<AsepriteEvent[]> {
  return new Promise((resolve) => {
    const updates: AsepriteEvent[] = [];
    let started = false;
    const finish = () => {
      clearTimeout(timer);
      stop();
      resolve(updates);
    };
    const timer = setTimeout(finish, CHAT_TIMEOUT_MS);
    const stop = events.watch((event) => {
      if (event.event !== "chat") return;
      updates.push(event);
      if (event.kind === "busy") {
        if (event.busy) started = true;
        else if (started) finish();
      }
      // Rejected before it started (validation error, still busy): no busy pair follows.
      if (event.kind === "error" && !started) finish();
    });
    events.inject({ ...payload, event: "chat_send" });
  });
}

/**
 * Development-only HTTP endpoint (ASEPRITE_MCP_DEV=1), loopback only:
 *   POST /chat   chat_send payload → all chat updates until the request finishes
 *   POST /event  inject any Aseprite → bridge event (tool_run, chat_cancel, ...)
 *   POST /ui     forward {action, ...} to the window as a ui_debug event (needs devMode in the extension)
 *   POST /recent bridge → window events since the last call (e.g. tool_result after a click)
 * Synthetic mouse/keyboard input can't drive Aseprite's UI, so this is how the chat
 * flow and the window are exercised end to end.
 */
/** Forwards a ui_debug event and waits briefly for the window's ui_debug_result. */
function runUiDebug(events: TappedEvents, body: AsepriteEvent): Promise<AsepriteEvent> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (result: AsepriteEvent) => {
      if (done) return;
      done = true;
      stop();
      resolve(result);
    };
    const stop = events.watchIncoming((event) => {
      if (event.event === "ui_debug_result") finish(event);
    });
    events.notify({ ...body, event: "ui_debug" });
    setTimeout(() => finish({ event: "ui_debug_result", ok: false, error: "No answer (is devMode on in the extension?)" }), 3000);
  });
}

const RECENT_LIMIT = 50;

export function startDevServer(options: Options, events: TappedEvents): Promise<Server> {
  const allowedHosts = new Set([`127.0.0.1:${options.port}`, `localhost:${options.port}`]);
  // What the bridge recently told the window (tool_result, chat, ...), for test scripts
  // that drive the UI and need to read the outcome.
  const recent: AsepriteEvent[] = [];
  events.watch((event) => {
    recent.push(event);
    if (recent.length > RECENT_LIMIT) recent.shift();
  });
  const http = createServer(async (req, res) => {
    if (!allowedHosts.has(req.headers.host ?? "")) return send(res, 403, { error: "Host not allowed" });
    if (req.method !== "POST") return send(res, 405, { error: "POST only" });
    // Web pages may send "simple" cross-origin POSTs without a preflight; browsers always
    // add an Origin header to them, and command-line tools don't.
    if (req.headers.origin !== undefined) return send(res, 403, { error: "Browser requests are not allowed" });
    try {
      const body = await readJson(req);
      switch (req.url) {
        case "/chat":
          return send(res, 200, { updates: await runChat(events, body) });
        case "/event":
          events.inject(body);
          return send(res, 200, { ok: true });
        case "/ui":
          return send(res, 200, await runUiDebug(events, body));
        case "/recent":
          return send(res, 200, { events: recent.splice(0) });
        default:
          return send(res, 404, { error: "Not found" });
      }
    } catch (error) {
      return send(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  return new Promise((resolve, reject) => {
    http.once("error", reject);
    http.listen(options.port, options.host, () => resolve(http));
  });
}
