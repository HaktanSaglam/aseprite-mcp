import { describe, expect, it } from "vitest";
import type { FrameOp } from "../src/aseprite/protocol.js";
import { AnimationSetup } from "../src/chat/AnimationSetup.js";
import { ANIMATION_DEFAULTS, type AnimationOptions } from "../src/chat/chatSchema.js";
import { FakeGateway } from "./chatFakes.js";

const WALK: AnimationOptions = { preset: "walk", ...ANIMATION_DEFAULTS.walk }; // 8 frames, 100 ms, loop

/** Stop arrives while the given step is in flight, like a user pressing Stop mid-setup. */
class StopDuring extends FakeGateway {
  constructor(
    private readonly step: FrameOp["op"],
    private readonly stop: () => void,
  ) {
    super();
  }

  override async frameOp(op: FrameOp, ref?: { sprite?: number }) {
    const result = await super.frameOp(op, ref);
    if (op.op === this.step) this.stop();
    return result;
  }
}

const ops = (gateway: FakeGateway) => gateway.calls.filter((c) => c.method === "frameOp" || c.method === "tagOp").map((c) => c.args[0]);

describe("AnimationSetup", () => {
  it("adds frames, durations and the tag to a one-frame sprite", async () => {
    const gateway = new FakeGateway();
    const info = gateway.addSprite({ id: 1 });
    const plan = await new AnimationSetup(gateway).prepare(info, WALK, "walk", new AbortController().signal);
    expect(plan).toEqual({ animation: WALK, tag: "walk", prepared: true, resumed: false });
    expect(ops(gateway)).toEqual([
      { op: "add", after: 1, count: 7, copy: true },
      { op: "duration", durationMs: 100 },
      { op: "add", name: "walk", from: 1, to: 8, direction: "forward", repeats: 0 },
    ]);
  });

  it("stops between steps and finishes the setup on the retry without adding frames twice", async () => {
    const stop = new AbortController();
    const gateway = new StopDuring("add", () => stop.abort());
    const info = gateway.addSprite({ id: 1 });
    const setup = new AnimationSetup(gateway);

    expect(await setup.prepare(info, WALK, "walk", stop.signal)).toBeUndefined();
    expect(ops(gateway)).toEqual([{ op: "add", after: 1, count: 7, copy: true }]);

    const retry = await setup.prepare(await gateway.getSpriteInfo({ sprite: 1 }), WALK, "walk", new AbortController().signal);
    expect(retry).toMatchObject({ prepared: true, resumed: true });
    expect(ops(gateway).slice(1)).toEqual([
      { op: "duration", durationMs: 100 },
      { op: "add", name: "walk", from: 1, to: 8, direction: "forward", repeats: 0 },
    ]);
    expect((await gateway.getSpriteInfo({ sprite: 1 })).frames).toHaveLength(8);
  });

  it("does nothing after Stop when Stop came first", async () => {
    const gateway = new FakeGateway();
    const info = gateway.addSprite({ id: 1 });
    const stop = new AbortController();
    stop.abort();
    expect(await new AnimationSetup(gateway).prepare(info, WALK, "walk", stop.signal)).toBeUndefined();
    expect(ops(gateway)).toEqual([]);
  });

  it("reuses a finished setup of a failed attempt (even from another bridge session)", async () => {
    const gateway = new FakeGateway();
    const frames = Array.from({ length: 8 }, (_, i) => ({ index: i + 1, durationMs: 100 }));
    const info = gateway.addSprite({
      id: 1,
      frames,
      tags: [{ name: "walk", from: 1, to: 8, direction: "forward", repeats: 0 }],
    });
    const plan = await new AnimationSetup(gateway).prepare(info, WALK, "walk", new AbortController().signal);
    expect(plan).toMatchObject({ prepared: true, resumed: true });
    expect(ops(gateway)).toEqual([]);
  });

  it("stretches a tag of that name over the new frames instead of adding a second one", async () => {
    const gateway = new FakeGateway();
    const info = gateway.addSprite({ id: 1, tags: [{ name: "walk", from: 1, to: 1, direction: "forward", repeats: 0 }] });
    await new AnimationSetup(gateway).prepare(info, WALK, "walk", new AbortController().signal);
    expect(ops(gateway).at(-1)).toEqual({ op: "update", name: "walk", from: 1, to: 8, direction: "forward", repeats: 0 });
  });

  it("leaves an animated sprite to the model and names a tag it must update", async () => {
    const gateway = new FakeGateway();
    const frames = Array.from({ length: 3 }, (_, i) => ({ index: i + 1, durationMs: 100 }));
    const info = gateway.addSprite({ id: 1, frames, tags: [{ name: "walk", from: 1, to: 3, direction: "forward", repeats: 0 }] });
    const plan = await new AnimationSetup(gateway).prepare(info, WALK, "walk", new AbortController().signal);
    expect(plan).toEqual({ animation: WALK, tag: "walk", prepared: false, existingTag: { from: 1, to: 3 } });
    expect(ops(gateway)).toEqual([]);
  });
});
