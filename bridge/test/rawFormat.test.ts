import { describe, expect, it } from "vitest";
import { decodeRaw, encodeRaw } from "../src/pixel/rawFormat.js";
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
