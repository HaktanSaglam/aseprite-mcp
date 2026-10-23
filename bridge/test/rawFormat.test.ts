import { describe, expect, it } from "vitest";
import { mapToPalette } from "../src/pixel/quantize.js";
import { decodeRaw, encodeRaw, storedColor, storedPixels } from "../src/pixel/rawFormat.js";
import { createRgbaImage } from "../src/pixel/RgbaImage.js";

describe("rawFormat", () => {
  it("round-trips rgba", () => {
    const hex = "ff000080" + "00ff00ff";
    const image = decodeRaw(hex, 2, 1, { format: "rgba" });
    expect([...image.data]).toEqual([255, 0, 0, 128, 0, 255, 0, 255]);
    expect(encodeRaw(image, { format: "rgba" })).toBe(hex);
  });

  it("decodes indexed pixels through the palette, transparent index → alpha 0", () => {
    const image = decodeRaw("0102", 2, 1, {
      format: "indexed",
      palette: ["00000000", "ff0000ff", "00ff00"],
      transparentIndex: 0,
    });
    expect([...image.data]).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);
    const back = decodeRaw("00", 1, 1, { format: "indexed", palette: ["123456ff"], transparentIndex: 0 });
    expect(back.data[3]).toBe(0);
  });

  it("encodes indexed by nearest palette color, skipping the transparent index", () => {
    const image = createRgbaImage(3, 1);
    image.data.set([250, 10, 10, 255, 0, 0, 0, 0, 1, 1, 1, 255]);
    const hex = encodeRaw(image, {
      format: "indexed",
      palette: ["000000ff", "ff0000ff", "000001ff"],
      transparentIndex: 0,
    });
    expect(hex).toBe("01" + "00" + "02");
  });

  it("converts gray both ways", () => {
    const image = decodeRaw("80ff", 1, 1, { format: "gray" });
    expect([...image.data]).toEqual([128, 128, 128, 255]);
    expect(encodeRaw(image, { format: "gray" })).toBe("80ff");
  });

  it("rejects payloads of the wrong size", () => {
    expect(() => decodeRaw("ff", 1, 1, { format: "rgba" })).toThrow(/expected 4/);
  });
});

describe("rawFormat: indexed round trips", () => {
  // 0 transparent, 1 black, 2 translucent red, 3 black again (a palette-swap duplicate)
  const target = { format: "indexed" as const, palette: ["00000000", "000000ff", "ff000040", "000000ff"], transparentIndex: 0 };

  it("writes unchanged pixels back with the index they were read with", () => {
    // 3 duplicates 1, 2 is translucent, 9 is past the end of the palette
    const raw = "01030209";
    const image = decodeRaw(raw, 4, 1, target);
    expect([...image.source!.indexes!]).toEqual([1, 3, 2, 9]);
    expect(encodeRaw(image, target)).toBe(raw);
    // Changing one pixel re-encodes only that one.
    image.data.set([0, 0, 0, 255], 8);
    expect(encodeRaw(image, target)).toBe("01030109");
  });

  it("keeps an index only while its color still shows, also under a new palette", () => {
    const image = decodeRaw("0301", 2, 1, target);
    const swapped = { ...target, palette: ["00000000", "000000ff", "ff000040", "ffffffff"] };
    // Index 3 is white now, so the black pixel moves to the remaining black (1).
    expect(encodeRaw(image, swapped)).toBe("0101");
  });

  it("never paints opaque pixels with the transparent index or a translucent entry", () => {
    const red = createRgbaImage(1, 1);
    red.data.set([255, 0, 0, 255]);
    const hex = encodeRaw(red, { format: "indexed", palette: ["ff0000ff", "ff000040", "800000ff"], transparentIndex: 0 });
    expect(hex).toBe("02");
  });

  it("picks the nearest color perceptually (OKLab), like every other color tool", () => {
    // Golden yellow: squared RGB distance prefers the mid gray, OKLab the (colorful) green,
    // which is also what apply_palette's mapToPalette picks.
    const gold = createRgbaImage(1, 1);
    gold.data.set([255, 200, 0, 255]);
    const palette = ["00000000", "808080ff", "00ff00ff"];
    expect(encodeRaw(gold, { format: "indexed", palette, transparentIndex: 0 })).toBe("02");
    expect([...mapToPalette(gold, ["#808080", "#00ff00"]).data.subarray(0, 3)]).toEqual([0, 255, 0]);
  });

  it("reports the color a sprite really stores", () => {
    const stored = storedColor([0, 255, 0, 255], { format: "indexed", palette: ["00000000", "000000ff", "ffffffff"], transparentIndex: 0 });
    expect(stored).toEqual([255, 255, 255, 255]);
    expect(storedColor([255, 0, 0, 255], { format: "gray" })).toEqual([76, 76, 76, 255]);
    expect(storedColor([1, 2, 3, 4], { format: "rgba" })).toEqual([1, 2, 3, 4]);
  });

  it("snaps a whole image to what the sprite will hold", () => {
    const image = decodeRaw("0103", 2, 1, target);
    image.data.set([250, 250, 250, 255], 0);
    const stored = storedPixels(image, target);
    expect([...stored.data]).toEqual([0, 0, 0, 255, 0, 0, 0, 255]);
    expect([...stored.source!.indexes!]).toEqual([1, 3]);
  });
});

describe("rawFormat: indexed Background layers", () => {
  // Aseprite only makes the transparent index see-through on transparent layers.
  const background = { format: "indexed" as const, palette: ["000000ff", "ffffffff"], transparentIndex: 0, isBackground: true };

  it("reads the transparent index as its opaque palette color", () => {
    expect([...decodeRaw("0001", 2, 1, background).data]).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
    expect(decodeRaw("00", 1, 1, { ...background, palette: ["12345600"] }).data[3]).toBe(255);
  });

  it("paints with the transparent index like any other color", () => {
    const black = createRgbaImage(1, 1);
    black.data.set([0, 0, 0, 255]);
    expect(encodeRaw(black, background)).toBe("00");
    expect(encodeRaw(black, { ...background, isBackground: false, palette: ["000000ff", "ffffffff", "101010ff"] })).toBe("02");
  });

  it("writes pixels read from a Background back as Background pixels", () => {
    const image = decodeRaw("0100", 2, 1, background);
    image.data.set([0, 0, 0, 255], 0); // white → black
    // The writer only knows the palette, not the layer kind; the read image does.
    expect(encodeRaw(image, { format: "indexed", palette: ["000000ff", "ffffffff"], transparentIndex: 0 })).toBe("0000");
  });
});
