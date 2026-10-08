import { WebSocketServer, type WebSocket } from "ws";

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
  /** Fire-and-forget; silently dropped while Aseprite is disconnected. */
  notify(event: AsepriteEvent): void;
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

interface Options {
  host: string;
  port: number;
  requestTimeoutMs: number;
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
 */
export class AsepriteSocket implements IAsepriteRpc, IAsepriteEvents {
  private server?: WebSocketServer;
  private client: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();
  private readonly eventHandlers: ((event: AsepriteEvent) => void)[] = [];

  constructor(private readonly options: Options) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = new WebSocketServer({
        host: this.options.host,
        port: this.options.port,
        verifyClient: ({ origin }: { origin?: string }) => isNonBrowserOrigin(origin),
      });
      server.once("listening", () => resolve());
      server.once("error", reject);
      server.on("connection", (socket) => this.attach(socket));
      this.server = server;
    });
  }

  stop(): void {
    this.client?.close();
    this.server?.close();
  }

  isConnected(): boolean {
    return this.client !== null;
  }

  onEvent(handler: (event: AsepriteEvent) => void): void {
    this.eventHandlers.push(handler);
  }

  notify(event: AsepriteEvent): void {
    this.client?.send(JSON.stringify(event));
  }

  call<T>(method: string, params: object): Promise<T> {
    const client = this.client;
    if (!client) {
      return Promise.reject(
        new Error(
          "Aseprite is not connected. Open Aseprite with the Claude Pixel Bridge extension installed.",
        ),
      );
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Aseprite did not answer "${method}" within ${this.options.requestTimeoutMs} ms`));
      }, this.options.requestTimeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      client.send(JSON.stringify({ id, method, params }));
    });
  }

  private attach(socket: WebSocket): void {
    // Only one Aseprite instance at a time; a reconnect replaces the old socket.
    if (this.client && this.client !== socket) this.client.close();
    this.client = socket;
    console.error("[bridge] Aseprite connected");

    socket.on("message", (raw) => this.onMessage(raw.toString()));
    socket.on("close", () => {
      if (this.client !== socket) return;
      this.client = null;
      console.error("[bridge] Aseprite disconnected");
      this.rejectAll(new Error("Aseprite disconnected"));
    });
  }

  private onMessage(text: string): void {
    let msg: { id?: number; result?: unknown; error?: string; event?: string };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }

    if (typeof msg.event === "string") {
      if (msg.event === "hello") console.error(`[bridge] Aseprite hello: ${text}`);
      for (const handler of this.eventHandlers) handler(msg as AsepriteEvent);
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

  private rejectAll(error: Error): void {
    for (const call of this.pending.values()) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    this.pending.clear();
  }
}
