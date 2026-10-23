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
  mirrorFixPrompt,
  reviewPrompt,
  variationPrompt,
  type DirectionsPlan,
  type PromptContext,
} from "../src/chat/promptBuilder.js";
import { mirrorPairs } from "../src/chat/directions.js";
import { detailForSize, STYLE_SPECS } from "../src/chat/styleSpecs.js";
import { spriteInfo } from "./chatFakes.js";

const directionsPlan = (n: 4 | 8): DirectionsPlan => ({
  directions: DIRECTION_ORDER[n],
  mirrors: mirrorPairs(DIRECTION_ORDER[n]),
  fromCurrent: false,
});

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

  it("refers to the attached image for reference variations, with the user's direction when given", () => {
    const bare = variationPrompt(fresh({}, ""), 2, 3, true);
    expect(bare).toMatch(/^Draw variation 2 of 3 of the sprite in the first attached image/);
    expect(bare).not.toMatch(/The user's direction/);
    // source "current" with text: the sprite stays the subject, the text steers it.
    const steered = variationPrompt(fresh({ source: "current" }, "in winter clothes"), 1, 3, true);
    expect(steered).toMatch(/^Draw variation 1 of 3 of the sprite in the first attached image.*\nThe user's direction for the variations: in winter clothes/);
    expect(steered).not.toMatch(/Create pixel art/);
  });

  it("keeps batch items consistent", () => {
    const prompt = batchItemPrompt(fresh({ palette: "sweetie16" }, "RPG icons"), "potion", 2, 5);
    expect(prompt).toMatch(/^Create pixel art: potion/);
    expect(prompt).toMatch(/item 2 of 5 in a matching set \(RPG icons\)/);
    expect(prompt).toContain('get_palette_preset {"id":"sweetie16"}');
  });

  it("orders directions and leaves the left-facing frames to the bridge's mirror", () => {
    expect(DIRECTION_ORDER[4]).toEqual(["down", "right", "up", "left"]);
    expect(DIRECTION_ORDER[8]).toEqual(["down", "down-right", "right", "up-right", "up", "up-left", "left", "down-left"]);
    const prompt = directionsPrompt(fresh({ view: "side" }), directionsPlan(8));
    expect(prompt).toMatch(/facing 8 directions/);
    expect(prompt).toMatch(/1 = down, 2 = down-right.*8 = down-left/);
    expect(prompt).toMatch(/Draw frame 1 \(facing down/);
    expect(prompt).toMatch(/Draw frames 2 \(down-right\), 3 \(right\), 4 \(up-right\) and 5 \(up\) from it/);
    expect(prompt).toMatch(
      /Leave frames 6 \(up-left\), 7 \(left\) and 8 \(down-left\) empty: when you finish, the bridge mirrors frame 4 \(up-right\), frame 3 \(right\) and frame 2 \(down-right\) into them/,
    );
    // The model no longer copies pixels around itself.
    expect(prompt).not.toMatch(/read_pixels, then write_pixels|"op":"flip_h"/);
    expect(prompt).not.toMatch(/View: side/); // directions define the view
  });

  it("turns the user's design in frame 1 instead of inventing one", () => {
    const ctx: PromptContext = { ...fresh({}, ""), freshSprite: false, hasContent: true };
    const prompt = directionsPrompt(ctx, { ...directionsPlan(4), fromCurrent: true });
    expect(prompt).toMatch(/^Turn the character in frame 1 into 4 directions/);
    expect(prompt).toMatch(/Frame 1 already holds the finished design facing down.*Don't redraw or change it/);
    expect(prompt).toMatch(/Draw every frame on its layer "Layer 1"/);
    expect(prompt).toMatch(/Draw frames 2 \(right\) and 3 \(up\) from it/);
    expect(prompt).toMatch(/Leave frame 4 \(left\) empty: when you finish, the bridge mirrors frame 2 \(right\) into it/);
    expect(prompt).not.toMatch(/A new empty/);
    expect(directionsPrompt({ ...ctx, text: "give him a red cape" }, { ...directionsPlan(4), fromCurrent: true })).toMatch(
      /The user's note: give him a red cape/,
    );
  });

  it("asks only for the asymmetric details after the mirror", () => {
    const prompt = mirrorFixPrompt({ ...fresh(), freshSprite: false }, directionsPlan(4), true);
    expect(prompt).toMatch(/^The bridge mirrored frame 2 \(right\) into frame 4 \(left\)\. A preview of every frame is attached/);
    expect(prompt).toMatch(/Fix only what must not be mirrored in frame 4 \(left\)/);
    expect(prompt).toMatch(/If nothing needs fixing, change nothing/);
    expect(mirrorFixPrompt(fresh(), directionsPlan(8), false)).toMatch(/Call view_sprite with frames "all"/);
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
    expect(prompt).toContain("Reply language: Turkish");
  });
});

describe("replyLanguage", () => {
  it("names the detected language", async () => {
    const { replyLanguage } = await import("../src/chat/promptBuilder.js");
    const { detectLanguage } = await import("../src/chat/language.js");
    expect(replyLanguage("iron sword")).toContain("Reply language: English");
    expect(replyLanguage("")).toMatch(/earlier, else English/);
    expect(detectLanguage("kırmızı iksir")).toBe("Turkish");
    expect(detectLanguage("bu yeşil topu sevimli bir slime yap")).toBe("Turkish");
    expect(detectLanguage("şövalye")).toBe("Turkish");
    expect(detectLanguage("add a small red wizard hat on top")).toBe("English");
    expect(detectLanguage("ein Ritter mit einem Schwert und der Schild")).toBe("German");
    expect(detectLanguage("un caballero con una espada")).toBe("Spanish");
    expect(detectLanguage("рыцарь с мечом")).toBe("Russian");
    expect(detectLanguage("剣を持った騎士")).toBe("Japanese");
  });
});

describe("outline: false (the unticked '1px outline' box)", () => {
  // The bridge's own wording that used to contradict "Outline: none".
  const OUTLINE_ASKS = [/Black or near-black outline/, /1px outlines/, /broken outlines?/, /same palette, outline/, /palette, outline and details/];

  it("never asks for an outline anywhere in a generation prompt, and says it overrides the rest", () => {
    for (const style of Object.keys(STYLE_SPECS) as (keyof typeof STYLE_SPECS)[]) {
      for (const autoReview of [true, false]) {
        const prompts = [
          generatePrompt(fresh({ style, outline: false, autoReview })),
          batchItemPrompt(fresh({ style, outline: false, autoReview }), "potion", 1, 3),
          directionsPrompt(fresh({ style, outline: false, autoReview }), directionsPlan(4)),
        ];
        for (const prompt of prompts) {
          expect(prompt).toMatch(/Outline: none\..*overrides every outline rule or step in the style, the guide/);
          for (const ask of OUTLINE_ASKS) expect({ style, ask: ask.source, found: ask.test(prompt) }).toMatchObject({ found: false });
        }
      }
    }
  });

  it("keeps the style's outline when the box is ticked or not sent", () => {
    for (const outline of [true, undefined]) {
      const prompt = generatePrompt(fresh({ style: "8bit", outline }));
      expect(prompt).toMatch(/Outline: solid 1px black \(#000000\) or near-black outline around everything\./);
      expect(prompt).toMatch(/1px outlines without jaggies/);
      expect(prompt).not.toMatch(/Outline: none/);
    }
  });

  it("keeps outline rules out of the style rules, so 'none' can switch them all off", () => {
    for (const [id, spec] of Object.entries(STYLE_SPECS)) {
      expect({ id, rules: spec.rules.filter((rule) => /outline/i.test(rule)) }).toEqual({ id, rules: [] });
    }
  });
});

describe("autoReview for chat, edit_selection and review", () => {
  const existing: PromptContext = { ...fresh({}, "make it darker"), freshSprite: false, hasContent: true };
  const selection = { x: 1, y: 1, width: 4, height: 4 };

  it("adds the one review pass when Auto-review is on", () => {
    const on = { autoReview: true };
    expect(chatPrompt({ ...existing, options: on })).toMatch(/If you changed the art: when you are done, do exactly one review pass/);
    expect(editSelectionPrompt({ ...existing, options: on, selection })).toMatch(
      /do exactly one review pass.*Keep selectionOnly: true for the fixes\./,
    );
    expect(reviewPrompt({ ...existing, options: on })).toMatch(/do exactly one review pass/);
  });

  it("leaves those prompts unchanged when Auto-review is off", () => {
    for (const options of [{ autoReview: false }, {}]) {
      expect(chatPrompt({ ...existing, options })).not.toMatch(/review pass/);
      expect(editSelectionPrompt({ ...existing, options, selection })).not.toMatch(/review pass/);
      expect(reviewPrompt({ ...existing, options })).not.toMatch(/review pass/);
    }
  });
});

describe("animatePrompt after an earlier attempt", () => {
  const animation = { preset: "walk" as const, frames: 8, frameMs: 100, loop: true };
  const ctx = { ...fresh({}, ""), freshSprite: false };

  it("says the frames already exist and may hold part of the motion", () => {
    const prompt = animatePrompt(ctx, { animation, tag: "walk", prepared: true, resumed: true });
    expect(prompt).toMatch(/Frames 1-8 already exist with their durations and the tag "walk", left from an earlier attempt/);
    expect(prompt).toMatch(/don't add or remove frames/);
  });

  it("asks to update an existing tag instead of adding a second one", () => {
    const prompt = animatePrompt(ctx, { animation, tag: "walk", prepared: false, existingTag: { from: 1, to: 3 } });
    expect(prompt).toMatch(/update the existing tag "walk" \(now frames 1-3\).*never add a second "walk" tag/);
  });
});

describe("v1.1: palette rules", () => {
  it("states a color limit up front and sizes the auto palette to it", () => {
    const prompt = generatePrompt(fresh({ maxColors: 6 }));
    expect(prompt).toMatch(/Color limit: at most 6 colors in the whole sprite \(all layers and frames together/);
    expect(prompt).toMatch(/the bridge merges the closest colors/);
    expect(prompt).toMatch(/choose a cohesive palette of at most 6 colors yourself/);
    expect(generatePrompt(fresh({}))).not.toMatch(/Color limit/);
    // Edits and chat mention it only when it is set, like every explicit option.
    const existing = { ...fresh({ maxColors: 4 }), freshSprite: false, hasContent: true };
    expect(chatPrompt(existing)).toMatch(/Color limit: at most 4 colors/);
  });

  it("lists a custom palette's colors", () => {
    const prompt = generatePrompt(fresh({ palette: "custom", customPalette: ["#1a1c2c", "#5d275d"] }));
    expect(prompt).toMatch(/Palette: only these 2 colors \(the user's own palette\): #1a1c2c #5d275d\. Don't introduce other colors\./);
    expect(prompt).not.toMatch(/apply_palette|snaps every pixel/);
  });

  it("tells the model the bridge snaps to a forced palette instead of asking for apply_palette", () => {
    const forced = generatePrompt(fresh({ palette: "endesga32", forcePalette: true }));
    expect(forced).toMatch(/get_palette_preset \{"id":"endesga32"\} and use only its colors\. When you finish, the bridge snaps every pixel you drew/);
    expect(forced).not.toMatch(/Finish with apply_palette/);
    expect(generatePrompt(fresh({ palette: "endesga32" }))).toMatch(/Finish with apply_palette/);
    expect(generatePrompt(fresh({ palette: "custom", customPalette: ["#000000", "#ffffff"], forcePalette: true }))).toMatch(
      /#000000 #ffffff\. Don't introduce other colors\. When you finish, the bridge snaps/,
    );
    expect(generatePrompt(fresh({ palette: "current", forcePalette: true }))).toMatch(/don't introduce new colors\. When you finish, the bridge snaps/);
    // A style with fixed colors gives "auto" something to snap to; plain "auto" has nothing.
    expect(generatePrompt(fresh({ style: "gameboy", forcePalette: true }))).toMatch(/only the style's colors listed above\. When you finish, the bridge snaps/);
    expect(generatePrompt(fresh({ forcePalette: true }))).not.toMatch(/snaps every pixel/);
  });
});

describe("v1.1: tile view", () => {
  it("asks for a seamless texture with the wrap-around workflow and the tiled check", () => {
    const prompt = generatePrompt({
      ...fresh({ view: "tile", background: "transparent" }, "mossy stone floor"),
      info: spriteInfo(5, { width: 16, height: 16 }),
    });
    expect(prompt).toMatch(/View: a seamless tile/);
    expect(prompt).toMatch(/Seamless tile:\n- The texture covers every pixel of the canvas: no transparency, no border/);
    expect(prompt).toContain('transform_layer {"op":"shift","dx":8,"dy":8,"wrap":true,"frames":"all"}');
    expect(prompt).toContain('{"op":"shift","dx":-8,"dy":-8,"wrap":true,"frames":"all"}');
    expect(prompt).toContain('view_sprite {"tiled":true}');
    expect(prompt).toMatch(/Background: none; the texture itself fills every pixel\./);
    expect(prompt).not.toMatch(/Background: transparent/);
    expect(prompt).toMatch(/Outline: never around the tile's edges/);
    expect(prompt).toMatch(/there is no margin/);
    expect(prompt).not.toMatch(/1-2 px margin/);
    expect(prompt).toContain('pixel-art guide, "tiles"');
  });

  it("does not apply to directions, which define their own view", () => {
    const prompt = directionsPrompt(fresh({ view: "tile" }), directionsPlan(4));
    expect(prompt).not.toMatch(/Seamless tile|no margin|texture itself/);
  });
});

describe("v1.1: style reference", () => {
  it("puts the reference facts into generation and edit prompts", () => {
    const reference = 'Style reference: "knight.aseprite" (sprite #7), frame 1, 32x32, attached as the last image.';
    expect(generatePrompt({ ...fresh(), reference })).toContain(reference);
    expect(batchItemPrompt({ ...fresh(), reference }, "sword", 1, 2)).toContain(reference);
    const existing = { ...fresh(), freshSprite: false, hasContent: true, reference };
    expect(chatPrompt(existing)).toContain(reference);
    expect(editSelectionPrompt({ ...existing, selection: { x: 0, y: 0, width: 4, height: 4 } })).toContain(reference);
  });
});
