import { describe, expect, it } from "vitest";
import type { LlmEvent } from "../src/llm/LlmRunner.js";
import { hangingScript } from "./chatFakes.js";
import { errors, solid, spriteOf, statuses, v11Harness } from "./v11Harness.js";

const WHITE: [number, number, number, number] = [255, 255, 255, 255];

/** A 6x4 two-layer sprite whose frame 1 holds an asymmetric "design". */
function userDesign() {
  const h = v11Harness();
  const user = h.fake.addSprite({ width: 6, height: 4, filename: "/art/knight.aseprite", layers: ["Cape"] });
  h.fake.fillRect({ sprite: user, layer: "Layer 1", x: 1, y: 0, width: 2, height: 4, color: "#3a4466" });
  h.fake.fillRect({ sprite: user, layer: "Cape", x: 3, y: 1, width: 1, height: 2, color: "#b13e53" });
  return { h, user };
}

describe("GenerationService: directions from the current sprite", () => {
  it("copies frame 1 of the user's sprite 1:1, has the rest drawn, mirrors left and asks for a fix-up", async () => {
    const { h, user } = userDesign();
    h.runner.script = h.drawing(async (r, n) => {
      // The first run draws "right" (frame 2): a white pixel on its left edge.
      if (n === 0) await h.toolsOf(r).writeImages([{ x: 0, y: 0, image: solid(1, 1, WHITE), frame: 2, layer: "Layer 1" }]);
    });
    const outcome = await h.generation.execute(
      h.request({ action: "directions", sprite: user, options: { source: "current", size: { width: 32, height: 32 } } }),
      h.run(),
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.undo).toBeUndefined(); // a sprite the bridge created is closed, not undone

    const created = h.claimed[0];
    expect(h.fake.callsOf("createSprite")[0][0]).toEqual({ width: 6, height: 4, colorMode: "rgb", frames: 4, name: "knight (4 directions)" });
    // Frame 1 is the user's frame 1, flattened, pixel for pixel.
    const userFrame = (await h.fake.readImage({ sprite: user, frame: 1, flattened: true })).image;
    const copied = (await h.fake.readImage({ sprite: created, frame: 1, flattened: true })).image;
    expect([...copied.data]).toEqual([...userFrame.data]);
    // Left (frame 4) is the drawn right frame mirrored: the white pixel at x0 lands on x5.
    expect(h.fake.pixel("Layer 1", 5, 0, 4, created)).toEqual(WHITE);

    const [first, fix] = h.runner.requests;
    expect(h.runner.requests).toHaveLength(2);
    expect(first.prompt).toMatch(/^Turn the character in frame 1 into 4 directions/);
    expect(first.prompt).toMatch(/Leave frame 4 \(left\) empty/);
    expect(first.images).toHaveLength(1); // the copied design
    expect(fix.prompt).toMatch(/^The bridge mirrored frame 2 \(right\) into frame 4 \(left\)/);
    expect(fix.sessionId).toBe("s-1");
    expect(h.fake.callsOf("frameOp").map(([op]) => op)).toEqual([{ op: "copy_cel", from: 2, to: 4, flip: "horizontal" }]);
    expect(statuses(h.updates)[0]).toBe("Turning knight.aseprite into 4 directions in Sprite-0002, one frame per direction.");
  });

  it("needs a drawn frame 1 and creates nothing without one", async () => {
    const h = v11Harness();
    const empty = h.fake.addSprite();
    await expect(h.generation.execute(h.request({ action: "directions", sprite: empty, options: { source: "current" } }), h.run())).rejects.toThrow(
      /Frame 1 of the sprite is empty/,
    );
    expect(h.fake.callsOf("createSprite")).toEqual([]);
  });

  it("keeps the mirrored result when only the fix-up fails", async () => {
    const { h, user } = userDesign();
    h.runner.script = h.drawing(() => {}, (n) => n === 0);
    const outcome = await h.generation.execute(h.request({ action: "directions", sprite: user, options: { source: "current" } }), h.run());
    expect(outcome.ok).toBe(true);
    expect(errors(h.updates)).toEqual(["Fixing the mirrored frames failed: model failed"]);
    expect(h.fake.isOpen(h.claimed[0])).toBe(true);
  });
});

describe("GenerationService: closing sprites that came to nothing", () => {
  it("closes a directions sprite whose run failed before drawing", async () => {
    const h = v11Harness();
    h.runner.script = h.drawing(() => {}, () => false);
    expect((await h.generation.execute(h.request({ action: "directions", text: "a cat" }), h.run())).ok).toBe(false);
    expect(h.fake.isOpen(h.claimed[0])).toBe(false);
    expect(h.runner.requests).toHaveLength(1); // no mirror, no fix-up after a failed first run
  });

  it("closes a directions sprite made from the user's design when the model added nothing", async () => {
    const { h, user } = userDesign();
    h.runner.script = h.drawing(() => {}, () => false);
    const request = h.request({ action: "directions", sprite: user, options: { source: "current" } });
    expect((await h.generation.execute(request, h.run())).ok).toBe(false);
    // Frame 1 holds the bridge's copy of the user's frame, yet the tab goes.
    expect(h.fake.isOpen(h.claimed[0])).toBe(false);
  });

  it("closes only the variations whose job failed or never ran", async () => {
    const h = v11Harness(1);
    let started = 0;
    h.runner.script = async function* (r): AsyncIterable<LlmEvent> {
      started++;
      if (started === 1) {
        await h.toolsOf(r).writeImages([{ x: 0, y: 0, image: solid(1, 1, WHITE) }]);
        yield { type: "done", ok: true };
      } else if (started === 2) {
        yield { type: "done", ok: false, error: "rate limited" };
      } else {
        yield* hangingScript(() => h.controller.abort())(r);
      }
    };
    await h.generation.execute(h.request({ action: "variations", text: "a gem", options: { count: 4 } }), h.run());
    const [drawn, failed, stopped, queued] = h.claimed;
    expect(h.fake.isOpen(drawn)).toBe(true);
    expect([failed, stopped, queued].map((s) => h.fake.isOpen(s))).toEqual([false, false, false]);
    expect(h.runner.requests).toHaveLength(3);
  });

  it("closes the sprites already created when Stop comes during creation", async () => {
    const h = v11Harness();
    const create = h.fake.createSprite.bind(h.fake);
    h.fake.createSprite = async (options) => {
      const info = await create(options);
      if (h.claimed.length === 1) h.controller.abort();
      return info;
    };
    expect((await h.generation.execute(h.request({ action: "batch", options: { items: ["a", "b", "c"] } }), h.run())).ok).toBe(false);
    expect(h.claimed).toHaveLength(2);
    expect(h.claimed.map((s) => h.fake.isOpen(s))).toEqual([false, false]);
  });
});

describe("GenerationService: variations of the current sprite, references and color rules", () => {
  it("varies the user's sprite with the text as a direction (source current)", async () => {
    const { h, user } = userDesign();
    h.runner.script = h.drawing(() => {});
    await h.generation.execute(
      h.request({ action: "variations", text: "in winter clothes", sprite: user, options: { source: "current", count: 2 } }),
      h.run(),
    );
    const prompt = h.runner.requests[0].prompt;
    expect(prompt).toMatch(/^Draw variation 1 of 2 of the sprite in the first attached image.*\nThe user's direction for the variations: in winter clothes/);
    expect(h.runner.requests.every((r) => r.images?.length === 1)).toBe(true);
    expect(statuses(h.updates)[0]).toBe("Drawing 2 variations in parallel, each in its own tab.");
  });

  it("gives every batch item the style reference", async () => {
    const { h, user } = userDesign();
    h.runner.script = h.drawing(() => {});
    await h.generation.execute(h.request({ action: "batch", options: { items: ["sword", "shield"], reference: { sprite: user } } }), h.run());
    expect(h.runner.requests.every((r) => r.images?.length === 1 && /Style reference: "knight\.aseprite"/.test(r.prompt))).toBe(true);
    expect(statuses(h.updates)[0]).toBe("Drawing 2 items in parallel, each in its own tab.");
  });

  it("applies maxColors to each finished job's sprite and labels the report", async () => {
    const h = v11Harness();
    h.runner.script = h.drawing(async (r) => {
      const tools = h.toolsOf(r);
      const shade = spriteOf(r) % 2 === 0 ? 10 : 20;
      await tools.writeImages([
        { x: 0, y: 0, image: solid(1, 1, [255, 0, 0, 255]), frame: 1 },
        { x: 1, y: 0, image: solid(1, 1, [255 - shade, 0, 0, 255]), frame: 1 },
        { x: 2, y: 0, image: solid(1, 1, [0, 0, 255, 255]), frame: 1 },
      ]);
    });
    await h.generation.execute(h.request({ action: "batch", options: { items: ["a", "b"], maxColors: 2 } }), h.run());
    const reports = statuses(h.updates).filter((s) => s.includes("limit of 2 colors"));
    expect(reports.sort()).toEqual([
      "a: Applied the limit of 2 colors: 1 pixel recolored (3 → 2 colors), as one undo step.",
      "b: Applied the limit of 2 colors: 1 pixel recolored (3 → 2 colors), as one undo step.",
    ]);
  });
});
