import { describe, expect, it, onTestFinished } from "vitest";
import { ChatService } from "../src/chat/ChatService.js";
import { CLAUDE_INFO, FakeEvents, FakeRegistry, hangingScript, until } from "./chatFakes.js";
import { errors, solid, statuses, v11Harness } from "./v11Harness.js";

const RED: [number, number, number, number] = [255, 0, 0, 255];
const DARK_RED: [number, number, number, number] = [250, 4, 4, 255];
const BLUE: [number, number, number, number] = [0, 0, 255, 255];
const GREEN: [number, number, number, number] = [0, 255, 0, 255];

describe("SingleRunService: undo steps of a run", () => {
  it("reports the run's net undo steps for the sprite it changed", async () => {
    const h = v11Harness();
    const sprite = h.fake.addSprite({ width: 4, height: 4 });
    h.runner.script = h.drawing(async (r) => {
      const tools = h.toolsOf(r);
      await tools.writeImages([{ x: 0, y: 0, image: solid(1, 1, RED), layer: "AI" }]);
      await tools.writeImages([{ x: 1, y: 0, image: solid(1, 1, BLUE), layer: "AI" }]);
      await tools.writeImages([{ x: 2, y: 0, image: solid(1, 1, GREEN), layer: "AI" }]);
      await tools.undo(1);
    });
    const outcome = await h.single.execute(h.request({ text: "add dots", sprite }), h.run());
    expect(outcome).toMatchObject({ ok: true, undo: { sprite, steps: 2 } });
    // Undoing that many steps really takes the sprite back to before the run.
    await h.gateway.undo(2, { sprite });
    expect(h.fake.state(sprite).layers.map((l) => l.name)).toEqual(["Layer 1"]);
  });

  it("counts the bridge's own setup steps (animation frames, durations, tag)", async () => {
    const h = v11Harness();
    const sprite = h.fake.addSprite({ width: 4, height: 4 });
    h.runner.script = h.drawing(() => {});
    const animation = { preset: "idle" as const, frames: 4, frameMs: 160, loop: true };
    const outcome = await h.single.execute(h.request({ action: "animate", sprite, options: { animation } }), h.run());
    expect(outcome.undo).toEqual({ sprite, steps: 3 });
  });

  it("sends no undo for a sprite the run created", async () => {
    const h = v11Harness();
    h.runner.script = h.drawing(async (r) => {
      await h.toolsOf(r).writeImages([{ x: 0, y: 0, image: solid(1, 1, RED) }]);
    });
    const outcome = await h.single.execute(h.request({ action: "generate", text: "a gem" }), h.run());
    expect(outcome.ok).toBe(true);
    expect(outcome.undo).toBeUndefined();
  });
});

describe("ChatService: done.stats.undoSteps", () => {
  function chat() {
    const h = v11Harness();
    const events = new FakeEvents();
    const service = new ChatService({
      events,
      registry: new FakeRegistry([CLAUDE_INFO], { "claude-code": h.runner }),
      singleRun: h.single,
      generation: h.generation,
      instantTools: { run: async () => ({ ok: true, text: "" }) },
      sessions: h.sessions,
      version: "1.1.0",
    });
    service.attach();
    onTestFinished(() => service.detach());
    const send = async (fields: Record<string, unknown>) => {
      const before = events.chat("busy").filter((e) => e.busy === false).length;
      events.emit({ event: "chat_send", ...fields });
      await until(() => events.chat("busy").filter((e) => e.busy === false).length > before);
      return events.chat("done").at(-1)?.stats as Record<string, unknown> | undefined;
    };
    return { h, send };
  }

  it("sends the run's undo steps and their sprite for the user's sprite", async () => {
    const { h, send } = chat();
    const sprite = h.fake.addSprite({ width: 4, height: 4 });
    h.runner.script = h.drawing(async (r) => {
      await h.toolsOf(r).writeImages([{ x: 0, y: 0, image: solid(1, 1, RED), layer: "AI" }]);
    });
    expect(await send({ text: "a dot", sprite })).toMatchObject({ undoSteps: 1, sprite });
  });

  it("leaves them out when the run made its own sprite", async () => {
    const { h, send } = chat();
    h.runner.script = h.drawing(() => {});
    const stats = await send({ action: "generate", text: "a gem" });
    expect(stats).toBeDefined();
    expect(stats).not.toHaveProperty("undoSteps");
    expect(stats).not.toHaveProperty("sprite");
  });
});

describe("SingleRunService: closing a generated sprite that came to nothing", () => {
  it("closes it when the run fails without drawing, keeps it when something was drawn", async () => {
    const h = v11Harness();
    h.runner.script = h.drawing(() => {}, () => false);
    expect((await h.single.execute(h.request({ action: "generate", text: "a gem" }), h.run())).ok).toBe(false);
    const created = h.claimed[0];
    expect(h.fake.isOpen(created)).toBe(false);
    expect(h.fake.callsOf("closeSprite")).toEqual([[created, { onlyIfEmpty: true }]]);

    h.runner.script = h.drawing(async (r) => {
      await h.toolsOf(r).writeImages([{ x: 0, y: 0, image: solid(1, 1, RED) }]);
    }, () => false);
    await h.single.execute(h.request({ action: "generate", text: "a gem" }), h.run());
    expect(h.fake.isOpen(h.claimed[1])).toBe(true);
  });

  it("closes it when the user stops the run", async () => {
    const h = v11Harness();
    h.runner.script = hangingScript(() => h.controller.abort());
    expect((await h.single.execute(h.request({ action: "generate", text: "a gem" }), h.run())).ok).toBe(false);
    expect(h.fake.isOpen(h.claimed[0])).toBe(false);
  });

  it("never closes the user's own sprite", async () => {
    const h = v11Harness();
    const sprite = h.fake.addSprite();
    h.runner.script = h.drawing(() => {}, () => false);
    await h.single.execute(h.request({ text: "hi", sprite }), h.run());
    expect(h.fake.callsOf("closeSprite")).toEqual([]);
    expect(h.fake.isOpen(sprite)).toBe(true);
  });
});

describe("SingleRunService: color rules after the run", () => {
  it("merges the drawn colors down to maxColors as one extra undo step and says so", async () => {
    const h = v11Harness();
    const sprite = h.fake.addSprite({ width: 4, height: 1 });
    h.fake.fillRect({ sprite, layer: "Layer 1", x: 3, y: 0, width: 1, height: 1, color: "#123456" });
    h.runner.script = h.drawing(async (r) => {
      const tools = h.toolsOf(r);
      await tools.writeImages([{ x: 0, y: 0, image: solid(1, 1, RED), layer: "AI", frame: 1 }]);
      await tools.writeImages([{ x: 1, y: 0, image: solid(1, 1, DARK_RED), layer: "AI", frame: 1 }]);
      await tools.writeImages([{ x: 2, y: 0, image: solid(1, 1, BLUE), layer: "AI", frame: 1 }]);
    });
    const outcome = await h.single.execute(h.request({ text: "dots", sprite, options: { maxColors: 2 } }), h.run());
    expect(outcome.undo).toEqual({ sprite, steps: 4 });
    expect(statuses(h.updates)).toContain("Applied the limit of 2 colors: 1 pixel recolored (3 → 2 colors), as one undo step.");
    expect(h.fake.pixel("AI", 1, 0)).toEqual(h.fake.pixel("AI", 0, 0));
    expect(h.fake.pixel("Layer 1", 3, 0)).toEqual([0x12, 0x34, 0x56, 255]); // not drawn by the run
  });

  it("does not touch the colors after a failed or stopped run", async () => {
    const h = v11Harness();
    const sprite = h.fake.addSprite({ width: 2, height: 1 });
    h.runner.script = h.drawing(async (r) => {
      await h.toolsOf(r).writeImages([{ x: 0, y: 0, image: solid(2, 1, RED), layer: "AI" }]);
    }, () => false);
    await h.single.execute(h.request({ text: "x", sprite, options: { palette: "pico8", forcePalette: true } }), h.run());
    expect(h.fake.callsOf("writeImages")).toHaveLength(1);
  });

  it("reports a failed enforcement without failing the run", async () => {
    const h = v11Harness();
    const sprite = h.fake.addSprite({ width: 2, height: 1 });
    h.runner.script = h.drawing(async (r) => {
      await h.toolsOf(r).writeImages([{ x: 0, y: 0, image: solid(2, 1, RED), layer: "AI" }]);
      h.fake.connected = false; // Aseprite went away right after the drawing
    });
    const outcome = await h.single.execute(h.request({ text: "x", sprite, options: { maxColors: 2 } }), h.run());
    expect(outcome.ok).toBe(true);
    expect(errors(h.updates)[0]).toMatch(/^Could not apply the color rules: Aseprite is not connected/);
  });
});

describe("SingleRunService: style reference", () => {
  it("attaches the reference frame last and adds its facts to the prompt", async () => {
    const h = v11Harness();
    const reference = h.fake.addSprite({ width: 8, height: 8, filename: "/art/hero.aseprite" });
    h.fake.fillRect({ sprite: reference, x: 1, y: 1, width: 6, height: 6, color: "#1a1c2c" });
    const sprite = h.fake.addSprite({ width: 8, height: 8 });
    h.fake.fillRect({ sprite, x: 0, y: 0, width: 2, height: 2, color: "#ff0000" });
    h.runner.script = h.drawing(() => {});
    await h.single.execute(h.request({ text: "add a hat", sprite, options: { reference: { sprite: reference } } }), h.run());
    const sent = h.runner.requests[0];
    expect(sent.images).toHaveLength(2); // the canvas preview, then the reference
    expect(sent.prompt).toMatch(/Style reference: "hero\.aseprite" \(sprite #\d+\), frame 1, 8x8, attached as the last image/);
    expect(h.claimed).toEqual([sprite]); // the reference is only read
  });

  it("fails before creating anything when the reference is gone", async () => {
    const h = v11Harness();
    await expect(
      h.single.execute(h.request({ action: "generate", text: "a gem", options: { reference: { sprite: 42 } } }), h.run()),
    ).rejects.toThrow(/reference sprite is not open anymore/);
    expect(h.fake.callsOf("createSprite")).toEqual([]);
  });
});

describe("SingleRunService: animating every direction", () => {
  const walk = { preset: "walk" as const, frames: 2, frameMs: 90, loop: true, allDirections: true };

  /** A 4-direction sprite like "directions" makes: one tagged pose per frame, a marker pixel each. */
  function directionsSprite() {
    const h = v11Harness();
    const sprite = h.fake.addSprite({ width: 4, height: 1, frames: 4 });
    const markers = ["#ff0000", "#00ff00", "#0000ff", "#ffff00"];
    for (const [i, name] of ["down", "right", "up", "left"].entries()) {
      h.fake.fillRect({ sprite, layer: "Layer 1", frame: i + 1, x: i, y: 0, width: 1, height: 1, color: markers[i] });
      h.fake.state(sprite).tags.push({ name, from: i + 1, to: i + 1, direction: "forward", repeats: 0 });
    }
    return { h, sprite };
  }

  it("animates down first, matches the others to it and mirrors left from right", async () => {
    const { h, sprite } = directionsSprite();
    h.runner.script = h.drawing(async (r, n) => {
      // The "right" run marks its first frame, so the mirror shows where it went.
      if (n === 1) await h.toolsOf(r).writeImages([{ x: 0, y: 0, image: solid(1, 1, [255, 255, 255, 255]), layer: "Layer 1", frame: 7 }]);
    });
    const outcome = await h.single.execute(h.request({ action: "animate", sprite, options: { animation: walk } }), h.run());

    expect(outcome.ok).toBe(true);
    const tags = h.fake.state(sprite).tags.map((t) => `${t.name} ${t.from}-${t.to}`);
    expect(tags).toEqual(["down 1-1", "right 2-2", "up 3-3", "left 4-4", "walk_down 5-6", "walk_right 7-8", "walk_up 9-10", "walk_left 11-12"]);
    expect(h.fake.state(sprite).frames.slice(4).every((f) => f.durationMs === 90)).toBe(true);
    // Each direction starts as copies of its pose...
    expect(h.fake.pixel("Layer 1", 0, 0, 5)).toEqual([255, 0, 0, 255]);
    expect(h.fake.pixel("Layer 1", 2, 0, 10)).toEqual([0, 0, 255, 255]);
    // ...and left is right's animation mirrored: the pose marker x1 → x2, the model's mark x0 → x3.
    expect(h.fake.pixel("Layer 1", 2, 0, 11)).toEqual([0, 255, 0, 255]);
    expect(h.fake.pixel("Layer 1", 3, 0, 11)).toEqual([255, 255, 255, 255]);
    expect(h.fake.pixel("Layer 1", 3, 0, 12)).toEqual([0, 0, 0, 0]);

    const sent = h.runner.requests;
    expect(sent).toHaveLength(4); // down, right, up, then one fix-up for the mirrored left
    expect(sent[0].prompt).toMatch(/^Animate this character facing down: a walk cycle/);
    expect(sent[0].prompt).toMatch(/one after another \(down, right, up, left; left is mirrored from right by the bridge\)/);
    expect(sent[0].prompt).toMatch(/Frames 5-6 \(tag "walk_down"\) are already set up as copies of the "down" pose \(frame 1\)/);
    expect(sent[1].prompt).toMatch(/^Animate the same motion facing right: a walk cycle/);
    expect(sent[1].prompt).toContain('draw_script {"startFrame":7,"frameCount":2,"base":2}');
    expect(sent[1].prompt).toMatch(/Match "walk_down" \(frames 5-6\): the same 2 frames and timing/);
    expect(sent[3].prompt).toMatch(/^The bridge mirrored "walk_right" into "walk_left" \(frames 11-12\)/);
    expect(sent.map((r) => r.images?.length)).toEqual([1, 2, 2, 1]);
    expect(sent.map((r) => r.sessionId)).toEqual([undefined, "s-1", "s-2", "s-3"]);
    expect(h.sessions.get("claude-code", sprite)).toBe("s-4");

    const progress = h.updates.filter((u) => u.kind === "progress").map((u) => (u.kind === "progress" ? `${u.done}/${u.total} ${u.label ?? ""}` : ""));
    expect(progress).toEqual(["0/4 ", "1/4 down", "2/4 right", "3/4 up", "4/4 left"]);
    // Per direction: frames, putting back the tag they stretched, two copies, the tag; plus the model's mark.
    expect(outcome.undo).toEqual({ sprite, steps: 4 * 5 + 1 });
  });

  it("stops between directions and continues where it stopped", async () => {
    const { h, sprite } = directionsSprite();
    let stopOnce = true;
    h.runner.script = async function* (r) {
      // The first attempt is stopped while "right" is drawn.
      if (r.prompt.includes("facing right") && stopOnce) {
        stopOnce = false;
        h.controller.abort();
        yield { type: "done", ok: false, error: "Stopped." };
        return;
      }
      yield { type: "session", sessionId: "s" };
      yield { type: "done", ok: true };
    };
    const animate = h.request({ action: "animate", sprite, options: { animation: walk } });
    await h.single.execute(animate, h.run());
    expect(h.runner.requests.map((r) => /facing (\w+)/.exec(r.prompt)?.[1])).toEqual(["down", "right"]);
    expect(h.fake.state(sprite).tags.map((t) => t.name)).toContain("walk_right");

    h.runner.requests.length = 0;
    await h.single.execute(animate, { ...h.run(), signal: new AbortController().signal });
    const prompts = h.runner.requests.map((r) => r.prompt);
    expect(prompts).toHaveLength(3); // right (resumed), up, the mirror fix-up; down was finished
    expect(prompts[0]).toMatch(/Frames 7-8 \(tag "walk_right"\) already exist with their durations, left from an earlier attempt/);
    expect(h.fake.state(sprite).frames).toHaveLength(12); // nothing was added twice
  });

  it("says so instead of animating again when every direction is done", async () => {
    const { h, sprite } = directionsSprite();
    h.runner.script = h.drawing(() => {});
    const animate = h.request({ action: "animate", sprite, options: { animation: walk } });
    await h.single.execute(animate, h.run());
    const runs = h.runner.requests.length;
    const again = await h.single.execute(animate, h.run());
    expect(h.runner.requests).toHaveLength(runs);
    expect(again.undo).toBeUndefined(); // nothing changed, nothing to undo
    expect(statuses(h.updates).at(-1)).toBe(
      "Every direction is already animated (walk_down, walk_right, walk_up, walk_left). Delete a tag to animate it again.",
    );
  });

  it("explains a sprite without direction tags and a tag of another length", async () => {
    const plain = v11Harness();
    const sprite = plain.fake.addSprite({ frames: 2 });
    await expect(plain.single.execute(plain.request({ action: "animate", sprite, options: { animation: walk } }), plain.run())).rejects.toThrow(
      /no direction tags/,
    );

    const { h, sprite: directed } = directionsSprite();
    await h.gateway.frameOp({ op: "add", count: 3 }, { sprite: directed });
    await h.gateway.tagOp({ op: "add", name: "walk_down", from: 5, to: 7 }, { sprite: directed });
    await expect(h.single.execute(h.request({ action: "animate", sprite: directed, options: { animation: walk } }), h.run())).rejects.toThrow(
      /The tag "walk_down" already has 3 frames/,
    );
  });
});

describe("SingleRunService: in-betweens and continuing", () => {
  const walk = { preset: "walk" as const, frames: 2, frameMs: 90, loop: true };

  function animated(frames: number) {
    const h = v11Harness();
    const sprite = h.fake.addSprite({ width: 2, height: 1, frames });
    for (let f = 1; f <= frames; f++) {
      h.fake.fillRect({ sprite, layer: "Layer 1", frame: f, x: 0, y: 0, width: 1, height: 1, color: `#0000${(f * 40).toString(16).padStart(2, "0")}` });
    }
    h.runner.script = h.drawing(() => {});
    return { h, sprite };
  }

  it("between: inserts copies of the first key after it and keeps both keys", async () => {
    const { h, sprite } = animated(3);
    await h.gateway.tagOp({ op: "add", name: "walk", from: 1, to: 3 }, { sprite });
    const animation = { ...walk, mode: "between" as const, fromFrame: 1, toFrame: 2 };
    const outcome = await h.single.execute(h.request({ action: "animate", sprite, options: { animation } }), h.run());
    expect(outcome.ok).toBe(true);
    const state = h.fake.state(sprite);
    expect(state.frames.map((f) => f.durationMs)).toEqual([100, 90, 90, 100, 100]);
    expect(h.fake.pixel("Layer 1", 0, 0, 2)).toEqual(h.fake.pixel("Layer 1", 0, 0, 1)); // copies of key A
    expect(h.fake.pixel("Layer 1", 0, 0, 4)).toEqual([0, 0, 80, 255]); // key B, moved to frame 4
    expect(state.tags[0]).toMatchObject({ name: "walk", from: 1, to: 5 });
    const prompt = h.runner.requests[0].prompt;
    expect(prompt).toMatch(/^Draw 2 in-between frames for this animation: frames 2-3 go from key frame 1 to key frame 4\./);
    expect(prompt).toMatch(/Key frame 1 \(left\) and key frame 4 \(right\) are attached/);
    expect(h.runner.requests[0].images).toHaveLength(1);
    // One step: the inserted frames (the tag above was added before the run).
    expect(outcome.undo).toEqual({ sprite, steps: 1 });
  });

  it("between: closes a loop after the last frame", async () => {
    const { h, sprite } = animated(3);
    await h.gateway.tagOp({ op: "add", name: "walk", from: 1, to: 3 }, { sprite });
    const animation = { ...walk, mode: "between" as const, fromFrame: 3, toFrame: 1 };
    await h.single.execute(h.request({ action: "animate", sprite, options: { animation } }), h.run());
    expect(h.fake.state(sprite).tags[0]).toMatchObject({ from: 1, to: 5 }); // the loop tag covers the new frames
    expect(h.runner.requests[0].prompt).toMatch(/frames 4-5 go from key frame 3 to key frame 1 \(the loop starts over there\)/);
  });

  it("between: refuses keys that aren't neighbours or don't exist", async () => {
    const { h, sprite } = animated(3);
    const between = (fromFrame: number, toFrame: number) =>
      h.single.execute(h.request({ action: "animate", sprite, options: { animation: { ...walk, mode: "between", fromFrame, toFrame } } }), h.run());
    await expect(between(1, 3)).rejects.toThrow(/neighbouring frames/);
    await expect(between(3, 4)).rejects.toThrow(/Key frame 4 doesn't exist: the sprite has 3 frame/);
    expect(h.fake.state(sprite).frames).toHaveLength(3);
  });

  it("continue: keeps frames 1..k and appends copies up to the animation length", async () => {
    const { h, sprite } = animated(3);
    const animation = { ...walk, frames: 6, mode: "continue" as const, keepFrames: 2 };
    await h.single.execute(h.request({ action: "animate", sprite, options: { animation } }), h.run());
    expect(h.fake.state(sprite).frames).toHaveLength(6);
    expect(h.fake.pixel("Layer 1", 0, 0, 6)).toEqual(h.fake.pixel("Layer 1", 0, 0, 3));
    const prompt = h.runner.requests[0].prompt;
    expect(prompt).toMatch(/- Frames 1-2 are finished: never change them\./);
    expect(prompt).toMatch(/Draw frames 3-6 so the motion carries on from frame 2 and flows back into frame 1\. Frame 3 already existed: redraw it\. Frames 4-6 are copies of frame 3\./);
    expect(prompt).toMatch(/The finished frames are attached, left to right then top to bottom, ending with frame 2/);
  });

  it("continue: explains impossible choices", async () => {
    const { h, sprite } = animated(3);
    const go = (keepFrames: number, frames = 6) =>
      h.single.execute(h.request({ action: "animate", sprite, options: { animation: { ...walk, frames, mode: "continue", keepFrames } } }), h.run());
    await expect(go(4)).rejects.toThrow(/Keep frames 1-4: the sprite has only 3 frame/);
    await expect(go(3, 2)).rejects.toThrow(/Nothing left to draw: all 3 frames would be kept/);
  });
});
