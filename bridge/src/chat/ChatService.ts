import { z } from "zod";
import type { AsepriteEvent, IAsepriteEvents } from "../aseprite/AsepriteSocket.js";
import type { ILlmRunner, LlmEvent } from "../llm/LlmRunner.js";
import { buildPrompt } from "./promptBuilder.js";

// Events come from Lua, so validate instead of trusting their shape.
const ChatSendSchema = z.object({
  event: z.literal("chat_send"),
  text: z.string().default(""),
  model: z.enum(["opus", "sonnet", "haiku"]).optional(),
  action: z.enum(["redraw_selection", "review"]).optional(),
  selection: z
    .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
    .optional(),
});

/** What the Lua chat window understands; it renders each message as it arrives. */
type ChatUpdate =
  | { kind: "text"; text: string }
  | { kind: "tool"; name: string }
  | { kind: "status"; text: string }
  | { kind: "error"; text: string }
  | { kind: "busy"; busy: boolean };

/**
 * One conversation per bridge: remembers the Claude session id so follow-ups keep
 * context, runs one request at a time, and streams progress back to Aseprite.
 */
export class ChatService {
  private sessionId?: string;
  private running?: AbortController;

  constructor(
    private readonly events: IAsepriteEvents,
    private readonly runner: ILlmRunner,
  ) {}

  attach(): void {
    this.events.onEvent((event) => this.handle(event));
  }

  private handle(event: AsepriteEvent): void {
    switch (event.event) {
      case "chat_send": {
        const parsed = ChatSendSchema.safeParse(event);
        if (!parsed.success) return this.push({ kind: "error", text: "Invalid chat request" });
        void this.send(parsed.data);
        return;
      }
      case "chat_cancel":
        this.running?.abort();
        return;
      case "chat_reset":
        this.running?.abort();
        this.sessionId = undefined;
        this.push({ kind: "status", text: "New conversation." });
        return;
    }
  }

  private async send(request: z.infer<typeof ChatSendSchema>): Promise<void> {
    if (this.running) {
      return this.push({ kind: "error", text: "Still working on the previous message." });
    }
    const prompt = buildPrompt(request);
    if (!prompt.trim()) return;

    const controller = new AbortController();
    this.running = controller;
    this.push({ kind: "busy", busy: true });
    try {
      const run = this.runner.run({
        prompt,
        sessionId: this.sessionId,
        model: request.model,
        signal: controller.signal,
      });
      for await (const event of run) this.forward(event);
    } catch (error) {
      this.push({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    } finally {
      this.running = undefined;
      this.push({ kind: "busy", busy: false });
    }
  }

  private forward(event: LlmEvent): void {
    switch (event.type) {
      case "session":
        this.sessionId = event.sessionId;
        return;
      case "text":
        return this.push({ kind: "text", text: event.text });
      case "tool":
        return this.push({ kind: "tool", name: event.name });
      case "retry":
        return this.push({ kind: "status", text: `Retrying (${event.attempt})...` });
      case "done":
        if (!event.ok) this.push({ kind: "error", text: event.error ?? "Failed" });
        return;
    }
  }

  private push(update: ChatUpdate): void {
    this.events.notify({ event: "chat", ...update });
  }
}
