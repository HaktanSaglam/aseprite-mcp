import { describe, expect, it } from "vitest";
import type { ChatOptions } from "../src/chat/chatSchema.js";
import {
  animatePrompt,
  batchItemPrompt,
  chatPrompt,
  CHAT_SYSTEM_PROMPT,
  DIRECTION_ORDER,
  directionsPrompt,
  editSelectionPrompt,
  generatePrompt,
  reviewPrompt,
  variationPrompt,
  type PromptContext,
} from "../src/chat/promptBuilder.js";
import { detailForSize, STYLE_SPECS } from "../src/chat/styleSpecs.js";
import { spriteInfo } from "./chatFakes.js";

const fresh = (options: ChatOptions = {}, text = "a knight"): PromptContext => ({
  text,
  options,
  info: spriteInfo(5, { width: 32, height: 32 }),
  canvas: "Current canvas: sprite #5",
  freshSprite: true,
  hasContent: false,
});

describe("CHAT_SYSTEM_PROMPT", () => {
  it("sets the reply format and the working rules", () => {
    expect(CHAT_SYSTEM_PROMPT).toMatch(/ONE short sentence \(two at most\) in the user's language/);
    expect(CHAT_SYSTEM_PROMPT).toMatch(/plain text/);
    expect(CHAT_SYSTEM_PROMPT).toMatch(/Never ask for permission/);
    expect(CHAT_SYSTEM_PROMPT).toMatch(/single undo step/);
    expect(CHAT_SYSTEM_PROMPT).toMatch(/dedicated layer/);
    expect(CHAT_SYSTEM_PROMPT).toMatch(/few large calls/);
    expect(CHAT_SYSTEM_PROMPT).toMatch(/pixel_art_guide/);
    for (const topic of ["fundamentals", "characters", "animation", "tiles", "items_icons", "environments", "shading_light", "color_palettes", "outlines_aa", "styles", "workflow"]) {
      expect(CHAT_SYSTEM_PROMPT).toContain(topic);
    }
  });
});

describe("generatePrompt", () => {
  it("states the subject, the fresh sprite, craft steps and the canvas", () => {
    const prompt = generatePrompt(fresh());
    expect(prompt).toMatch(/^Create pixel art: a knight/);
    expect(prompt).toMatch(/new empty 32x32 sprite was created/);
    expect(prompt).toMatch(/layer "Layer 1"/);
    expect(prompt).toMatch(/hue-shifted/);
    expect(prompt).toMatch(/Detail: Small sprite/);
    expect(prompt).toContain("Current canvas: sprite #5");
    expect(prompt).toMatch(/Check the preview your last drawing call returned/);
  });

  it("uses style defaults when nothing was chosen", () => {
    const prompt = generatePrompt(fresh());
    expect(prompt).toContain(`Style: ${STYLE_SPECS.auto.label}.`);
    expect(prompt).toMatch(/Palette: choose a cohesive palette of 8-24 colors/);
    expect(prompt).toMatch(/Outline: 1px dark outline/);
    expect(prompt).toMatch(/Background: transparent for characters/);
  });

  it.each([
    ["gameboy", /Exactly 4 colors, all greens: #0f380f/],
    ["pico8", /Only the 16 PICO-8 colors: #000000 #1d2b53/],
    ["1bit", /Exactly 2 colors: #000000 and #ffffff/],
    ["8bit", /At most 3 visible colors per sprite part plus transparency/],
    ["16bit", /16-32 colors/],
    ["hd", /32-64 colors/],
  ] as const)("spells out the %s style as concrete constraints", (style, rule) => {
    expect(generatePrompt(fresh({ style }))).toMatch(rule);
  });

  it("does not ask a fixed-color style to invent a palette", () => {
    const prompt = generatePrompt(fresh({ style: "gameboy" }));
    expect(prompt).toMatch(/Palette: only the style's colors listed above/);
    expect(prompt).not.toMatch(/choose a cohesive palette/);
  });

  it("tells the model to fetch and finally apply a palette preset", () => {
    const prompt = generatePrompt(fresh({ palette: "endesga32" }));
    expect(prompt).toContain('get_palette_preset {"id":"endesga32"}');
    expect(prompt).toContain('apply_palette {"palette":"endesga32","frames":"all","setSpritePalette":true}');
  });

  it("skips the lookup when the style already lists the preset's colors", () => {
    const prompt = generatePrompt(fresh({ style: "pico8", palette: "pico8" }));
    expect(prompt).not.toContain("get_palette_preset");
    expect(prompt).toContain('apply_palette {"palette":"pico8"');
  });

  it("lets an explicit palette override a fixed-color style", () => {
    expect(generatePrompt(fresh({ style: "gameboy", palette: "db16" }))).toMatch(/It replaces the style's color list/);
  });

  it("uses the sprite palette for 'current'", () => {
    expect(generatePrompt(fresh({ palette: "current" }))).toMatch(/only the sprite's current palette/);
  });

  it("renders view, outline, background and auto review choices", () => {
    const prompt = generatePrompt(fresh({ view: "isometric", outline: false, background: "solid", autoReview: true }));
    expect(prompt).toMatch(/View: isometric: 2:1 pixel lines/);
    expect(prompt).toMatch(/Outline: none/);
    expect(prompt).toMatch(/"Background" layer below the subject/);
    expect(prompt).toMatch(/do exactly one review pass/);
  });

  it("targets a new or the active layer on an existing sprite", () => {
    const existing = { ...fresh(), freshSprite: false };
    expect(generatePrompt({ ...existing, options: { target: "new_layer" } })).toMatch(/new layer named after the subject/);
    expect(generatePrompt({ ...existing, options: { target: "active_layer" } })).toMatch(/active layer "Layer 1"/);
  });
});

describe("detailForSize", () => {
  it("scales the detail advice with the canvas", () => {
    expect(detailForSize(16, 16)).toMatch(/Tiny/);
    expect(detailForSize(32, 24)).toMatch(/Small/);
    expect(detailForSize(64, 64)).toMatch(/Medium/);
    expect(detailForSize(100, 50)).toMatch(/Large/);
    expect(detailForSize(256, 144)).toMatch(/scene/);
  });
});

describe("chatPrompt", () => {
  const existing: PromptContext = { ...fresh({}, "make it darker"), freshSprite: false, hasContent: true };

  it("passes the message through with the canvas and nothing the user didn't choose", () => {
    const prompt = chatPrompt(existing);
    expect(prompt.startsWith("make it darker")).toBe(true);
    expect(prompt).toContain("Current canvas: sprite #5");
    expect(prompt).not.toMatch(/Style:|Palette:|Outline:/);
  });

  it("mentions explicit choices and the selection", () => {
    const prompt = chatPrompt({ ...existing, options: { style: "pico8" }, selection: { x: 1, y: 2, width: 3, height: 4 } });
    expect(prompt).toMatch(/Style: PICO-8/);
    expect(prompt).toMatch(/selected x=1, y=2, 3x4.*selectionOnly: true/);
  });

  it("tells the model to create a sprite when nothing is open", () => {
    expect(chatPrompt({ text: "draw a tree", options: { size: { width: 48, height: 64 } } })).toMatch(
      /No sprite is open.*create_sprite \(48x64/,
    );
  });
});

describe("editSelectionPrompt", () => {
  const selection = { x: 4, y: 6, width: 10, height: 8 };

  it("restricts changes to the selection and blends with the surroundings", () => {
    const prompt = editSelectionPrompt({ ...fresh({}, "add a hat"), freshSprite: false, selection });
    expect(prompt).toMatch(/^Redraw the selected area \(x=4, y=6, 10x8\): add a hat/);
    expect(prompt).toMatch(/selectionOnly: true/);
    expect(prompt).toContain('{"x":4,"y":6,"width":10,"height":8,"base":"current","selectionOnly":true}');
    expect(prompt).toMatch(/Blend into the surrounding art/);
  });

  it("has a sensible default when no text is given", () => {
    expect(editSelectionPrompt({ ...fresh({}, ""), selection })).toMatch(/so it looks better while keeping its idea/);
  });
});

describe("reviewPrompt", () => {
  it("lists the checks and adds animation checks for multi-frame sprites", () => {
    const one = reviewPrompt({ ...fresh({}, ""), freshSprite: false });
    expect(one).toMatch(/senior pixel artist/);
    expect(one).toMatch(/Stray and orphan pixels/);
    expect(one).not.toMatch(/Animation:/);
    const info = spriteInfo(5, { frames: [{ index: 1, durationMs: 100 }, { index: 2, durationMs: 100 }] });
    const animated = reviewPrompt({ ...fresh({}, "the sword"), info, freshSprite: false });
    expect(animated).toMatch(/Animation: same size/);
    expect(animated).toMatch(/The user's note: the sword/);
  });
});

describe("animatePrompt", () => {
  const animation = { preset: "walk" as const, frames: 8, frameMs: 100, loop: true };

  it("describes key poses and says the frames are prepared", () => {
    const prompt = animatePrompt({ ...fresh({}, ""), freshSprite: false }, { animation, tag: "walk", prepared: true });
    expect(prompt).toMatch(/walk cycle: contact, down/);
    expect(prompt).toMatch(/8 frames, 100 ms per frame, looping/);
    expect(prompt).toMatch(/Frames 1-8 are already set up.*tag "walk"/);
    expect(prompt).toMatch(/no jitter/);
    expect(prompt).toContain('pixel-art guide, "animation" (already loaded');
  });

  it("asks the model to add frames when the sprite already had several", () => {
    const prompt = animatePrompt(
      { ...fresh({}, "wave the flag"), freshSprite: false },
      { animation: { ...animation, preset: "custom", loop: false }, tag: "animation", prepared: false },
    );
    expect(prompt).toMatch(/plays once/);
    expect(prompt).toMatch(/Add the frames you need with manage_frames/);
    expect(prompt).toMatch(/wave the flag/);
  });
});

describe("parallel prompts", () => {
  it("makes each variation different on purpose", () => {
    const prompts = [1, 2, 3, 4].map((i) => variationPrompt(fresh(), i, 4));
    expect(prompts[0]).toMatch(/variation 1 of 4/);
    expect(prompts[1]).toMatch(/different pose, silhouette/);
    expect(prompts[2]).toMatch(/different color scheme/);
    expect(new Set(prompts).size).toBe(4);
  });

  it("refers to the attached image for reference variations", () => {
    expect(variationPrompt(fresh({}, ""), 2, 3, true)).toMatch(/^Draw variation 2 of 3 of the sprite in the attached image/);
  });

  it("keeps batch items consistent", () => {
    const prompt = batchItemPrompt(fresh({ palette: "sweetie16" }, "RPG icons"), "potion", 2, 5);
    expect(prompt).toMatch(/^Create pixel art: potion/);
    expect(prompt).toMatch(/item 2 of 5 in a matching set \(RPG icons\)/);
    expect(prompt).toContain('get_palette_preset {"id":"sweetie16"}');
  });

  it("orders directions and explains the mirroring shortcut", () => {
    expect(DIRECTION_ORDER[4]).toEqual(["down", "right", "up", "left"]);
    expect(DIRECTION_ORDER[8]).toEqual(["down", "down-right", "right", "up-right", "up", "up-left", "left", "down-left"]);
    const prompt = directionsPrompt(fresh({ view: "side" }), DIRECTION_ORDER[8]);
    expect(prompt).toMatch(/facing 8 directions/);
    expect(prompt).toMatch(/1 = down, 2 = down-right.*8 = down-left/);
    expect(prompt).toMatch(/Draw frame 1 \(facing down/);
    expect(prompt).toContain('transform_layer {"op":"flip_h","frames":[7]}');
    expect(prompt).not.toMatch(/View: side/); // directions define the view
  });
});

describe("guide inlining and reply language", () => {
  it("picks a guide topic from English and Turkish subjects", async () => {
    const { guideTopicFor } = await import("../src/chat/guideSelector.js");
    expect(guideTopicFor("generate", "a knight with a sword")).toBe("characters");
    expect(guideTopicFor("generate", "kırmızı bir iksir")).toBe("items_icons");
    expect(guideTopicFor("generate", "forest at dusk with a cabin")).toBe("environments");
    expect(guideTopicFor("generate", "grass tileset")).toBe("tiles");
    expect(guideTopicFor("animate", "")).toBe("animation");
    expect(guideTopicFor("chat", "a knight")).toBeUndefined();
  });

  it("inlines the topic in generation prompts and names the reply language", () => {
    const prompt = generatePrompt({ text: "şövalye", options: {}, info: undefined });
    expect(prompt).toContain('pixel-art guide, "characters"');
    expect(prompt).toContain('Reply language: the language of the user\'s request ("şövalye")');
  });
});
