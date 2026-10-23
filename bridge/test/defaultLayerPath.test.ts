import { describe, expect, it } from "vitest";
import type { LayerInfo, SpriteInfo } from "../src/aseprite/AsepriteGateway.js";
import { defaultLayerPath } from "../src/canvas/CanvasService.js";

function layer(path: string, isGroup = false): LayerInfo {
  const name = path.split("/").at(-1) ?? path;
  return { name, path, isGroup, isVisible: true, isEditable: true, opacity: 255, blendMode: "normal", stackIndex: 1 };
}

/** Layers bottom first, as get_sprite_info lists them. */
function sprite(layers: LayerInfo[], activeLayer?: string): SpriteInfo {
  return { id: 1, width: 8, height: 8, colorMode: "rgb", activeFrame: 1, frames: [], tags: [], layers, activeLayer } as unknown as SpriteInfo;
}

describe("defaultLayerPath", () => {
  it("pins the active layer inside a group by its path", () => {
    const info = sprite([layer("Body", true), layer("Body/Arm"), layer("Top")], "Body/Arm");
    expect(defaultLayerPath(info)).toBe("Body/Arm");
  });

  it("uses the top image layer inside an active group, like the extension", () => {
    const info = sprite([layer("Body", true), layer("Body/Legs"), layer("Body/Arm"), layer("Top")], "Body");
    expect(defaultLayerPath(info)).toBe("Body/Arm");
  });

  it("leaves an empty active group to Aseprite, which explains the problem", () => {
    const info = sprite([layer("Empty", true), layer("Top")], "Empty");
    expect(defaultLayerPath(info)).toBeUndefined();
  });

  it("falls back to the sprite's top image layer when no layer is active", () => {
    const info = sprite([layer("Bottom"), layer("Group", true), layer("Group/Inner")]);
    expect(defaultLayerPath(info)).toBe("Group/Inner");
  });

  it("leaves ambiguous paths to Aseprite", () => {
    const info = sprite([layer("Art"), layer("Art")], "Art");
    expect(defaultLayerPath(info)).toBeUndefined();
  });

  it("does not guess when the active layer is unknown", () => {
    const info = sprite([layer("Art")], "Gone");
    expect(defaultLayerPath(info)).toBeUndefined();
  });
});
