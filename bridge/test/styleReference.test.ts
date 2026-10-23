import { describe, expect, it } from "vitest";
import { UserFacingError } from "../src/chat/chatUpdates.js";
import { loadStyleReference, outlineOf } from "../src/chat/styleReference.js";
import { createRgbaImage, type RgbaImage } from "../src/pixel/RgbaImage.js";
import { FakeGateway } from "./fakes/FakeGateway.js";

/** `rows` of single-character colors; "." = transparent. */
function art(rows: string[], colors: Record<string, [number, number, number]>): RgbaImage {
  const image = createRgbaImage(rows[0].length, rows.length);
  rows.forEach((line, y) =>
    [...line].forEach((ch, x) => {
      if (ch !== ".") image.data.set([...colors[ch], 255], (y * image.width + x) * 4);
    }),
  );
  return image;
}

const COLORS: Record<string, [number, number, number]> = {
  k: [0x1a, 0x1c, 0x2c], // outline
  r: [0xb1, 0x3e, 0x53], // fill
  d: [0x5d, 0x27, 0x5d], // darker fill shade
  l: [0xff, 0xcd, 0x75], // light fill
};

describe("outlineOf", () => {
  it("finds a solid outline color", () => {
    const facts = outlineOf(art([".kkkk.", "krrrrk", "krrrrk", ".kkkk."], COLORS));
    expect(facts).toEqual({ kind: "solid", color: "#1a1c2c", share: 1 });
  });

  it("tells a selective outline (darker edges, no single color) from none", () => {
    // Edges in three darker shades (none on half of the edge) around a light fill.
    const shades: Record<string, [number, number, number]> = { a: [0x60, 0x20, 0x20], b: [0x20, 0x40, 0x60], c: [0x30, 0x50, 0x20] };
    const selective = outlineOf(art(["abca", "bllc", "clla", "acbc"], { ...COLORS, ...shades }));
    expect(selective).toEqual({ kind: "selective" });
    // Light edges in three colors around a dark middle: shapes end in their fills.
    const none = outlineOf(art(["lrml", "mddr", "rddm", "lmrl"], { ...COLORS, m: [0x90, 0xe0, 0x90] }));
    expect(none).toEqual({ kind: "none" });
    expect(outlineOf(createRgbaImage(4, 4))).toEqual({ kind: "none" });
  });
});

describe("loadStyleReference", () => {
  function setup() {
    const gateway = new FakeGateway();
    const sprite = gateway.addSprite({ width: 8, height: 8, frames: 2, filename: "/art/knight.aseprite" });
    gateway.fillRect({ sprite, frame: 1, x: 2, y: 1, width: 4, height: 6, color: "#1a1c2c" });
    gateway.fillRect({ sprite, frame: 1, x: 3, y: 2, width: 2, height: 4, color: "#b13e53" });
    return { gateway, sprite };
  }

  it("attaches the frame as an image and states its palette, outline and proportions", async () => {
    const { gateway, sprite } = setup();
    const loaded = await loadStyleReference(gateway, { sprite }, true);
    expect(loaded.image?.mediaType).toBe("image/png");
    expect(loaded.text).toMatch(/^Style reference: "knight\.aseprite" \(sprite #\d+\), frame 1, 8x8, attached as the last image\. Match its style closely/);
    expect(loaded.text).toMatch(/- Colors, most used first: #1a1c2c #b13e53\./);
    expect(loaded.text).toMatch(/- Outline: a solid 1px outline in #1a1c2c \(100% of the edge pixels\)\./);
    expect(loaded.text).toMatch(/- Proportions: its subject is 4x6 px on the 8x8 canvas\./);
  });

  it("states the facts without an image for models that can't see", async () => {
    const { gateway, sprite } = setup();
    const loaded = await loadStyleReference(gateway, { sprite }, false);
    expect(loaded.image).toBeUndefined();
    expect(loaded.text).not.toMatch(/attached/);
  });

  it("explains a closed sprite, a missing frame and an empty frame", async () => {
    const { gateway, sprite } = setup();
    await expect(loadStyleReference(gateway, { sprite: 99 }, true)).rejects.toThrow(/reference sprite is not open anymore/);
    await expect(loadStyleReference(gateway, { sprite, frame: 3 }, true)).rejects.toThrow(/has 2 frame\(s\), so frame 3/);
    const empty = loadStyleReference(gateway, { sprite, frame: 2 }, true);
    await expect(empty).rejects.toThrow(/Frame 2 of the style reference is empty/);
    await expect(empty).rejects.toBeInstanceOf(UserFacingError);
  });
});
