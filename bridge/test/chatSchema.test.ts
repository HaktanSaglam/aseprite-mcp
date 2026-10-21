import { describe, expect, it } from "vitest";
import { batchItems, checkRequest, parseChatSend, parseToolRun, type ChatSendRequest } from "../src/chat/chatSchema.js";

function parse(event: Record<string, unknown>): ChatSendRequest {
  const result = parseChatSend({ event: "chat_send", ...event });
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

describe("parseChatSend", () => {
  it("fills defaults for a bare message", () => {
    expect(parse({ text: "hi" })).toEqual({ text: "hi", action: "chat", options: {} });
  });

  it("accepts the full PROTOCOL.md option set", () => {
    const request = parse({
      text: "a knight",
      action: "generate",
      sprite: 4,
      selection: { x: 1, y: 2, width: 3, height: 4 },
      options: {
        provider: "codex",
        model: "gpt-5",
        effort: "high",
        style: "16bit",
        palette: "endesga32",
        size: { width: 64, height: 48 },
        target: "new_layer",
        view: "three_quarter",
        directions: 8,
        count: 4,
        items: ["sword", "shield"],
        outline: true,
        background: "solid",
        animation: { preset: "walk", frames: 6, frameMs: 90, loop: false },
        autoReview: true,
      },
    });
    expect(request.options).toMatchObject({
      provider: "codex",
      effort: "high",
      size: { width: 64, height: 48 },
      animation: { preset: "walk", frames: 6, frameMs: 90, loop: false },
    });
    expect(request.sprite).toBe(4);
  });

  it("fills animation timings from the preset", () => {
    expect(parse({ action: "animate", options: { animation: { preset: "run" } } }).options.animation).toEqual({
      preset: "run",
      frames: 6,
      frameMs: 80,
      loop: true,
    });
    expect(parse({ action: "animate", options: { animation: { preset: "attack", frames: 3 } } }).options.animation).toEqual({
      preset: "attack",
      frames: 3,
      frameMs: 80,
      loop: false,
    });
  });

  it("treats Lua's empty tables, nulls and empty strings as omitted", () => {
    const request = parse({ text: "x", options: [], selection: null, sprite: null });
    expect(request.options).toEqual({});
    expect(request.selection).toBeUndefined();
    expect(parse({ text: "x", options: { model: "", provider: null, style: "pico8" } }).options).toEqual({ style: "pico8" });
    expect(parse({ text: "x", options: { animation: [] } }).options.animation).toEqual({
      preset: "custom",
      frames: 4,
      frameMs: 100,
      loop: true,
    });
  });

  it("upgrades the first chat window's payload", () => {
    const request = parse({ text: "x", model: "sonnet", action: "redraw_selection" });
    expect(request.action).toBe("edit_selection");
    expect(request.options.model).toBe("sonnet");
    expect(parse({ text: "x", model: "sonnet", options: { model: "opus" } }).options.model).toBe("opus");
  });

  it("explains invalid requests with the failing field", () => {
    const result = parseChatSend({ event: "chat_send", text: "x", options: { count: 9, style: "watercolor" } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/^Invalid chat request/);
    expect(result.error).toMatch(/options\.count/);
    expect(result.error).toMatch(/options\.style/);
  });

  it("rejects unknown actions and bad sizes", () => {
    expect(parseChatSend({ event: "chat_send", action: "paint" }).ok).toBe(false);
    expect(parseChatSend({ event: "chat_send", options: { size: { width: 0, height: 8 } } }).ok).toBe(false);
    expect(parseChatSend({ event: "chat_send", options: { directions: 6 } }).ok).toBe(false);
  });
});

describe("parseToolRun", () => {
  it("parses a tool request and keeps empty strings in params", () => {
    const result = parseToolRun({ event: "tool_run", requestId: 3, tool: "add_outline", params: { color: "", layer: null }, sprite: 2 });
    expect(result).toEqual({ ok: true, value: { requestId: 3, tool: "add_outline", params: { color: "" }, sprite: 2 } });
  });

  it("defaults params to an empty object (Lua sends [] or nothing)", () => {
    expect(parseToolRun({ event: "tool_run", requestId: "a", tool: "undo", params: [] })).toMatchObject({ ok: true, value: { params: {} } });
    expect(parseToolRun({ event: "tool_run", requestId: "a", tool: "undo" })).toMatchObject({ ok: true, value: { params: {} } });
  });

  it("requires requestId and tool", () => {
    expect(parseToolRun({ event: "tool_run", tool: "undo" }).ok).toBe(false);
    expect(parseToolRun({ event: "tool_run", requestId: 1 }).ok).toBe(false);
  });
});

describe("checkRequest / batchItems", () => {
  const request = (action: ChatSendRequest["action"], text = "", options = {}): ChatSendRequest => ({ text, action, options });

  it("needs text for chat, generate and directions", () => {
    expect(checkRequest(request("chat"))).toMatch(/Type a message/);
    expect(checkRequest(request("chat", "  "))).toMatch(/Type a message/);
    expect(checkRequest(request("generate"))).toMatch(/Describe what to draw/);
    expect(checkRequest(request("directions"))).toMatch(/Describe what to draw/);
    expect(checkRequest(request("generate", "a cat"))).toBeUndefined();
  });

  it("lets edits, reviews, animations and reference variations run without text", () => {
    for (const action of ["edit_selection", "review", "animate", "variations"] as const) {
      expect(checkRequest(request(action))).toBeUndefined();
    }
  });

  it("needs at least one non-blank batch item", () => {
    expect(checkRequest(request("batch", "", { items: [" ", ""] }))).toMatch(/items/);
    expect(checkRequest(request("batch", "", { items: ["sword"] }))).toBeUndefined();
    expect(batchItems({ items: [" sword ", "", "shield"] })).toEqual(["sword", "shield"]);
  });
});
