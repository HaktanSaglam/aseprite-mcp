import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { AsepriteSocket } from "../src/aseprite/AsepriteSocket.js";

// Real sockets on an ephemeral-ish port: the behaviour under test is connection handling.
const PORT = 17_000 + Math.floor(Math.random() * 1000);
let bridge: AsepriteSocket | undefined;
const clients: WebSocket[] = [];

async function connectClient(onCall?: (msg: { id: number; method: string }) => unknown): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  clients.push(ws);
  ws.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.id !== undefined && onCall) ws.send(JSON.stringify({ id: msg.id, result: onCall(msg) }));
  });
  await new Promise((resolve) => ws.once("open", resolve));
  await new Promise((resolve) => setTimeout(resolve, 20));
  return ws;
}

afterEach(() => {
  for (const ws of clients.splice(0)) ws.close();
  bridge?.stop();
  bridge = undefined;
});

describe("AsepriteSocket", () => {
  it("keeps an older connection open when a newer one arrives and talks to the newest", async () => {
    bridge = new AsepriteSocket({ host: "127.0.0.1", port: PORT, requestTimeoutMs: 2000 });
    await bridge.start();
    const changes: boolean[] = [];
    bridge.onConnectionChange((c) => changes.push(c));

    const old = await connectClient(() => "old");
    const newer = await connectClient(() => "new");
    expect(old.readyState).toBe(WebSocket.OPEN);
    expect(await bridge.call("ping", {})).toBe("new");

    newer.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bridge.isConnected()).toBe(true);
    expect(await bridge.call("ping", {})).toBe("old");
    expect(changes).toEqual([true]);

    old.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(bridge.isConnected()).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it("fails only the calls sent on a connection that closes", async () => {
    bridge = new AsepriteSocket({ host: "127.0.0.1", port: PORT + 1, requestTimeoutMs: 2000 });
    await bridge.start();
    const ws = new WebSocket(`ws://127.0.0.1:${PORT + 1}`);
    clients.push(ws);
    await new Promise((resolve) => ws.once("open", resolve));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const pending = bridge.call("slow", {});
    ws.close();
    await expect(pending).rejects.toThrow(/disconnected/);
  });
});
