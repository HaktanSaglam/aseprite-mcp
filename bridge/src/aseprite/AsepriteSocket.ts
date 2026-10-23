import { WebSocket, WebSocketServer } from "ws";

/** Bridge → Aseprite request/response (used by the MCP tools). */
export interface IAsepriteRpc {
  isConnected(): boolean;
  call<T>(method: string, params: object): Promise<T>;
}

/** Messages Aseprite sends on its own initiative (chat UI) and pushes back to it. */
export interface AsepriteEvent {
  event: string;
  [key: string]: unknown;
}

export interface IAsepriteEvents {
  onEvent(handler: (event: AsepriteEvent) => void): void;
  /** Called with false when Aseprite goes away (a reconnect replacing the socket is not a disconnect). */
  onConnectionChange(handler: (connected: boolean) => void): void;
  /** Fire-and-forget; silently dropped while Aseprite is disconnected. */
  notify(event: AsepriteEvent): void;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
  /** The connection the request went out on: only its own close fails the call. */
  socket: WebSocket;
}

interface Options {
  host: string;
  port: number;
  requestTimeoutMs: number;
}

/** Timestamped, so reconnects and slow calls can be lined up with what the user saw. */
function log(message: string): void {
  // Local time: the user compares it with their clock, not with UTC.
  console.error(`[bridge ${new Date().toTimeString().slice(0, 8)}] ${message}`);
}

/**
 * Browsers always send an http(s):// Origin; Aseprite's ixwebsocket sends ws://<host>:<port>
 * (or nothing). Rejecting http(s) origins stops any web page from posing as Aseprite.
 */
function isNonBrowserOrigin(origin: string | undefined): boolean {
  return !origin || origin.startsWith("ws://") || origin.startsWith("wss://");
}

/**
 * Aseprite connects to us (its Lua API only has a WebSocket *client*), so the bridge
 * is the server. Messages with an `id` are replies to our calls; messages with an
 * `event` are Aseprite talking first.
 *
 * Aseprite's WebSocket (ixwebsocket) sometimes opens a new connection before the old
 * one is gone, typically while reconnecting after a bridge restart. Closing the older
 * one makes its auto-reconnect open yet another, and the two keep replacing each other
 * (and killing running jobs). So every open connection is kept: requests go out on the
 * newest, events are accepted from all, and Aseprite only counts as disconnected when
 * none is left.
 */
export class AsepriteSocket implements IAsepriteRpc, IAsepriteEvents {
  private server?: WebSocketServer;
  /** Open connections, oldest first. */
  private sockets: WebSocket[] = [];
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private readonly eventHandlers: ((event: AsepriteEvent) => void)[] = [];
  private readonly connectionHandlers: ((connected: boolean) => void)[] = [];

  constructor(private readonly options: Options) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = new WebSocketServer({
        host: this.options.host,
        port: this.options.port,
        verifyClient: ({ origin }: { origin?: string }) => isNonBrowserOrigin(origin),
        // A 1024x1024 RGBA read is 8 MB of hex; leave room for big canvases and frame batches.
        maxPayload: 512 * 1024 * 1024,
      });
      server.once("listening", () => resolve());
      server.once("error", reject);
      server.on("error", (error) => log(`WebSocket server error: ${error.message}`));
      server.on("connection", (socket) => this.attach(socket));
      this.server = server;
    });
  }

  stop(): void {
    for (const socket of this.sockets) socket.close();
    this.server?.close();
  }

  isConnected(): boolean {
    return this.current() !== undefined;
  }

  onEvent(handler: (event: AsepriteEvent) => void): void {
    this.eventHandlers.push(handler);
  }

  onConnectionChange(handler: (connected: boolean) => void): void {
    this.connectionHandlers.push(handler);
  }

  notify(event: AsepriteEvent): void {
    this.current()?.send(JSON.stringify(event));
  }

  call<T>(method: string, params: object): Promise<T> {
    const socket = this.current();
    if (!socket) {
      return Promise.reject(
        new Error("Aseprite is not connected. Open Aseprite with the Aseprite MCP extension installed."),
      );
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Aseprite did not answer "${method}" within ${this.options.requestTimeoutMs} ms`));
      }, this.options.requestTimeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, socket });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /** The newest connection that is still open. */
  private current(): WebSocket | undefined {
    for (let i = this.sockets.length - 1; i >= 0; i--) {
      if (this.sockets[i].readyState === WebSocket.OPEN) return this.sockets[i];
    }
    return undefined;
  }

  private attach(socket: WebSocket): void {
    const wasConnected = this.isConnected();
    this.sockets.push(socket);
    log(wasConnected ? `Aseprite connected again (${this.sockets.length} connections open)` : "Aseprite connected");
    if (!wasConnected) this.emitConnection(true);

    // Without a listener, a socket error (e.g. a frame over maxPayload) would crash the bridge.
    socket.on("error", (error) => log(`Aseprite connection error: ${error.message}`));
    socket.on("message", (raw) => this.onMessage(raw.toString()));
    socket.on("close", (code, reason) => {
      this.sockets = this.sockets.filter((s) => s !== socket);
      this.rejectPending(socket, new Error("Aseprite disconnected"));
      if (this.isConnected()) return;
      log(`Aseprite disconnected (code ${code}${reason.length ? `: ${reason.toString()}` : ""})`);
      this.emitConnection(false);
    });
  }

  // A throwing handler must not stop the others or break message processing.
  private emitConnection(connected: boolean): void {
    for (const handler of this.connectionHandlers) {
      try {
        handler(connected);
      } catch (error) {
        console.error("[bridge] connection handler failed:", error);
      }
    }
  }

  private onMessage(text: string): void {
    let msg: { id?: number; result?: unknown; error?: string; event?: string };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }

    if (typeof msg.event === "string") {
      if (msg.event === "hello") log(`Aseprite hello: ${text}`);
      for (const handler of this.eventHandlers) {
        try {
          handler(msg as AsepriteEvent);
        } catch (error) {
          console.error(`[bridge] "${msg.event}" handler failed:`, error);
        }
      }
      return;
    }
    if (msg.id === undefined) return;

    const call = this.pending.get(msg.id);
    if (!call) return;
    this.pending.delete(msg.id);
    clearTimeout(call.timer);
    if (msg.error !== undefined) call.reject(new Error(msg.error));
    else call.resolve(msg.result);
  }

  private rejectPending(socket: WebSocket, error: Error): void {
    for (const [id, call] of this.pending) {
      if (call.socket !== socket) continue;
      clearTimeout(call.timer);
      call.reject(error);
      this.pending.delete(id);
    }
  }
}
