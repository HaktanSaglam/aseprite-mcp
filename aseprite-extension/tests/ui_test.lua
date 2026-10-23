-- Headless tests for the window's pure modules (no Dialog: it is nil in batch mode).
-- Run with:
--   aseprite -b --script-param root=<path to aseprite-extension> --script tests/ui_test.lua
-- Bridge messages go through json.decode like real WebSocket traffic, because its
-- userdata results (float numbers, table-like arrays) behave differently from tables.

local root = app.params.root or "."
local function load(file) return dofile(app.fs.joinPath(root, file)) end

local C = load("ui/catalog.lua")
local S = load("ui/settings.lua")(C)
local P = load("ui/providers.lua")(C)
local R = load("ui/requests.lua")(C)
local F = load("ui/format.lua")
local W = load("ui/wrap.lua")
local LL = load("ui/log_layout.lua")(W)
local T = load("ui/theme.lua")
local ChatLog = load("ui/chat_log.lua")
local Debug = load("ui/debug_hook.lua")
local textRender = load("ui/text_render.lua")
local RunUndo = load("ui/run_undo.lua")
local SpriteSettings = load("ui/sprite_settings.lua")(S)

local passed, failed = 0, 0

local function test(name, fn)
  local ok, err = pcall(fn)
  if ok then
    passed = passed + 1
  else
    failed = failed + 1
    print("FAIL " .. name .. ": " .. tostring(err))
  end
end

local function eq(actual, expected, what)
  if actual ~= expected then
    error(string.format("%s: expected %s, got %s", what or "value", tostring(expected), tostring(actual)), 2)
  end
end

local function truthy(value, what)
  if not value then error((what or "value") .. " should be truthy", 2) end
end

local function wire(t) return json.decode(json.encode(t)) end

-- One character = 4px, like a narrow pixel font.
local function measure(s) return (utf8.len(s) or #s) * 4 end

local function settings(overrides)
  local prefs = {}
  for k, v in pairs(overrides or {}) do prefs[k] = v end
  return S.snapshot(prefs)
end

local function claude()
  return P.resolve(P.new(), {})
end

local SPRITE = { sprite = { id = 7, width = 40, height = 30 }, layer = "Layer 1" }
local SELECTED = {
  sprite = { id = 7, width = 40, height = 30 },
  selection = { x = 1, y = 2, width = 3, height = 4 },
  layer = "Layer 1",
}

-- catalog ---------------------------------------------------------------------------

test("catalog lookups map labels and ids both ways", function()
  eq(C.labelOf(C.SIZES, "32"), "32x32")
  eq(C.idOf(C.PALETTES, "Endesga 32"), "endesga32")
  eq(C.idOf(C.VIEWS, "3/4"), "three_quarter")
  eq(C.labelOf(C.STYLES, "missing"), "Auto", "unknown id falls back to the first option")
  eq(C.effortLabel("low"), "Fast")
  eq(C.effortLabel("max"), "Max")
  eq(C.effortLabel("turbo"), "turbo", "unknown effort shows its id")
  eq(#C.labels(C.ANIMATIONS), 8)
end)

test("catalog labels stay ASCII so native widgets never need fallback glyphs", function()
  local lists = { C.SIZES, C.STYLES, C.PALETTES, C.VIEWS, C.TARGETS, C.VARIATIONS,
    C.ANIMATIONS, C.EFFORTS, C.DITHERS, C.OUTLINE_PLACEMENTS, C.OUTLINE_COLORS, C.TOOL_CHOICES,
    C.COLOR_LIMITS, C.SOURCES, C.ANIMATION_MODES, { C.NO_REFERENCE } }
  for _, list in ipairs(lists) do
    for _, item in ipairs(list) do
      truthy(not item.label:find("[\128-\255]"), "ASCII label " .. item.label)
    end
  end
end)

test("palette ids match the protocol's PaletteId", function()
  local expected = { "auto", "current", "custom", "pico8", "sweetie16", "endesga32", "endesga64", "db16",
    "db32", "aap64", "resurrect64", "gameboy", "nes", "1bit" }
  for i, id in ipairs(expected) do eq(C.PALETTES[i].id, id, "palette " .. i) end
  eq(#C.PALETTES, #expected)
  -- The Apply palette tool takes presets only.
  eq(C.find(C.PALETTE_PRESETS, "custom"), nil)
  eq(C.find(C.PALETTE_PRESETS, "current"), nil)
end)

test("v1.1 ids match the protocol: views, sources, modes, color limits", function()
  eq(C.labelOf(C.VIEWS, "tile"), "Seamless tile")
  eq(table.concat({ C.SOURCES[1].id, C.SOURCES[2].id }, ","), "prompt,current")
  local modes = {}
  for i, m in ipairs(C.ANIMATION_MODES) do modes[i] = m.id end
  eq(table.concat(modes, ","), "new,between,continue")
  local limits = {}
  for i, l in ipairs(C.COLOR_LIMITS) do limits[i] = l.count or l.id end
  eq(table.concat(limits, ","), "auto,4,8,12,16,24,32")
  truthy(C.isDirectionTag("down"), "down")
  truthy(C.isDirectionTag("Up-Left"), "case-insensitive")
  truthy(not C.isDirectionTag("walk"), "walk")
  truthy(not C.isDirectionTag(nil), "nil")
end)

-- settings ----------------------------------------------------------------------------

test("settings fall back to defaults for missing or invalid values", function()
  local prefs = { genSize = "999", animFrames = 40, toolTolerance = "abc", useSelection = "yes" }
  eq(S.get(prefs, "genSize"), "32")
  eq(S.get(prefs, "animFrames"), 16, "clamped to max")
  eq(S.get(prefs, "toolTolerance"), 10)
  eq(S.get(prefs, "useSelection"), true)
  eq(S.get(prefs, "tab"), "chat")
  eq(S.get(nil, "genStyle"), "auto")
end)

test("settings set stores normalized values", function()
  local prefs = {}
  eq(S.set(prefs, "toolOutlineColor", "#FF8800"), "ff8800ff")
  eq(prefs.toolOutlineColor, "ff8800ff")
  eq(S.set(prefs, "animFrameMs", 3.6), 10, "rounded, then clamped to min")
  eq(S.set(prefs, "port", 7802.4), 7802)
  eq(S.set(prefs, "provider", ""), nil, "empty optional string becomes nil")
  eq(S.set(prefs, "toolOutlineColor", "zzzzzz"), "000000ff")
end)

test("settings reject unknown keys loudly", function()
  local ok = pcall(S.get, {}, "nope")
  eq(ok, false)
end)

test("settings snapshot covers every key", function()
  local s = S.snapshot({})
  eq(s.genVariations, "1")
  eq(s.toolPalette, "pico8")
  eq(s.port, 7801)
  eq(s.ui_x, nil)
  eq(s.toolChoice, "remove_background")
  eq(s.toolOutlineMode, "auto")
  eq(s.effort, "medium", "Balanced until the user picks another effort")
end)

-- providers -----------------------------------------------------------------------------

local BRIDGE_INFO = wire({
  event = "bridge_info",
  version = "1.1.0",
  defaultProvider = "claude-code",
  providers = {
    {
      id = "claude-code", label = "Claude Code",
      models = { { id = "opus", label = "Opus" }, { id = "sonnet", label = "Sonnet" } },
      efforts = { "low", "medium", "high", "xhigh", "max" }, available = true, supportsImages = true,
    },
    {
      id = "codex", label = "Codex CLI",
      models = { { id = "gpt-5", label = "GPT-5" } },
      efforts = { "low", "high" }, available = false, note = "Install: npm i -g @openai/codex",
      supportsImages = true,
    },
    { id = "gemini-cli", label = "Gemini", models = {}, efforts = {}, available = true, supportsImages = false },
  },
})

test("providers fall back to the built-in Claude list", function()
  local state = P.new()
  eq(state.fromBridge, false)
  local sel = P.resolve(state, {})
  eq(sel.provider.id, "claude-code")
  eq(sel.model, "opus", "the built-in default, not the newest (and slowest) model")
  eq(sel.effort, "medium")
  local labels = C.labels(P.modelOptions(sel.provider))
  eq(table.concat(labels, ","), "Fable,Opus,Sonnet,Haiku")
  eq(P.resolve(state, { model = "fable" }).model, "fable", "a saved choice wins")
end)

test("providers pick the bridge's defaultModel unless the user saved a choice", function()
  local state = P.new()
  P.update(state, wire({
    event = "bridge_info", version = "2", defaultProvider = "claude-code",
    providers = {
      {
        id = "claude-code", label = "Claude Code", defaultModel = "opus",
        models = { { id = "fable", label = "Fable (newest)" }, { id = "opus", label = "Opus" }, { id = "haiku", label = "Haiku" } },
        efforts = { "low", "medium", "high" }, available = true, supportsImages = true,
      },
      { id = "codex", label = "Codex", models = { { id = "gpt-5", label = "GPT-5" } }, efforts = {}, available = true },
      {
        id = "ollama", label = "Ollama", defaultModel = "gone",
        models = { { id = "qwen3", label = "qwen3" }, { id = "llama", label = "llama" } }, efforts = {}, available = true,
      },
    },
  }))
  eq(P.resolve(state, {}).model, "opus", "no saved choice -> defaultModel")
  eq(P.resolve(state, { model = "haiku" }).model, "haiku", "saved choice still offered -> kept")
  eq(P.resolve(state, { model = "sonnet" }).model, "opus", "saved choice gone -> defaultModel")
  eq(P.resolve(state, { provider = "codex" }).model, "gpt-5", "no defaultModel -> first model")
  eq(P.resolve(state, { provider = "ollama" }).model, "qwen3", "defaultModel not in the list -> first model")
  eq(P.resolve(state, { provider = "ollama", model = "llama" }).model, "llama")
end)

test("providers update from bridge_info userdata", function()
  local state = P.new()
  eq(P.update(state, BRIDGE_INFO), true)
  eq(state.fromBridge, true)
  eq(state.bridgeVersion, "1.1.0")
  eq(#state.list, 3)
  local options = P.providerOptions(state)
  eq(options[2].label, "Codex CLI (not set up)")
  eq(options[1].label, "Claude Code")
  local codex = P.find(state, "codex")
  eq(codex.note, "Install: npm i -g @openai/codex")
  eq(codex.models[1].id, "gpt-5")
end)

test("providers keep the old list when bridge_info is malformed", function()
  local state = P.new()
  eq(P.update(state, wire({ event = "bridge_info", providers = { { label = "no id" } } })), false)
  eq(P.update(state, wire({ event = "bridge_info" })), false)
  eq(state.list[1].id, "claude-code")
end)

test("providers resolve invalid choices to sensible ones", function()
  local state = P.new()
  P.update(state, BRIDGE_INFO)
  local sel = P.resolve(state, { provider = "codex", model = "opus", effort = "medium" })
  eq(sel.provider.id, "codex")
  eq(sel.model, "gpt-5", "model of another provider is replaced")
  truthy(sel.effort == "low" or sel.effort == "high", "effort from the provider's list")
  local gem = P.resolve(state, { provider = "gemini-cli", model = "x", effort = "high" })
  eq(gem.model, nil, "no models")
  eq(gem.effort, nil, "no efforts")
  eq(P.modelOptions(gem.provider)[1].label, "Default")
  eq(P.effortOptions(gem.provider)[1].label, "Default")
  local unknown = P.resolve(state, { provider = "gone" })
  eq(unknown.provider.id, "claude-code", "unknown provider -> default")
end)

-- requests --------------------------------------------------------------------------------

test("chat payload carries AI options, selection and sprite", function()
  local p = R.chat("  make it blue  ", settings({ effort = "high", model = "opus" }), P.resolve(P.new(), { model = "opus", effort = "high" }), SELECTED)
  eq(p.event, "chat_send")
  eq(p.action, nil, "plain chat relies on the protocol default")
  eq(p.text, "make it blue")
  eq(p.options.provider, "claude-code")
  eq(p.options.model, "opus")
  eq(p.options.effort, "high")
  eq(p.options.autoReview, false)
  eq(p.options.style, nil, "chat doesn't send generation options")
  eq(p.selection.width, 3)
  eq(p.sprite, 7)
  -- Must survive the wire format.
  local back = wire(p)
  eq(back.options.model, "opus")
end)

test("chat leaves out the selection when Use selection is off", function()
  local p = R.chat("hi", settings({ useSelection = false }), claude(), SELECTED)
  eq(p.selection, nil)
end)

test("chat refuses empty text and unavailable providers", function()
  local p, err = R.chat("   ", settings(), claude(), SPRITE)
  eq(p, nil)
  eq(err, "Type a message first.")
  local state = P.new()
  P.update(state, BRIDGE_INFO)
  local _, err2 = R.chat("hi", settings(), P.resolve(state, { provider = "codex" }), SPRITE)
  truthy(err2:find("not set up"), "explains the provider")
  truthy(err2:find("npm i %-g @openai/codex"), "includes the note")
end)

test("edit selection needs a sprite and a selection", function()
  local _, e1 = R.editSelection("", settings(), claude(), {})
  truthy(e1:find("Open or create a sprite"), e1)
  local _, e2 = R.editSelection("", settings(), claude(), SPRITE)
  truthy(e2:find("Select an area"), e2)
  local p = R.editSelection("add moss", settings({ useSelection = false }), claude(), SELECTED)
  eq(p.action, "edit_selection")
  eq(p.selection.x, 1, "always sends the selection")
  eq(p.text, "add moss")
end)

test("generate sends art options and switches to variations", function()
  local s = settings({ genPrompt = "a knight", genSize = "64", genStyle = "16bit", genPalette = "endesga32",
    genView = "side", genTarget = "new_sprite", genOutline = false, genTransparent = false })
  local p = R.generate(s, claude(), {})
  eq(p.action, "generate")
  eq(p.text, "a knight")
  eq(p.options.size.width, 64)
  eq(p.options.style, "16bit")
  eq(p.options.palette, "endesga32")
  eq(p.options.view, "side")
  eq(p.options.target, "new_sprite")
  eq(p.options.outline, false)
  eq(p.options.background, "solid")
  eq(p.options.count, nil)
  eq(p.sprite, nil, "no sprite open")

  local v = R.generate(settings({ genPrompt = "a knight", genVariations = "3" }), claude(), SPRITE)
  eq(v.action, "variations")
  eq(v.options.count, 3)
  eq(v.sprite, 7)
end)

test("generate validates prompt, current canvas and targets", function()
  local _, e1 = R.generate(settings(), claude(), SPRITE)
  eq(e1, "Type what to draw in Prompt first.")
  local _, e1b = R.generate(settings({ genBatch = "a; b" }), claude(), SPRITE)
  truthy(e1b:find("Generate batch"), e1b)
  local _, e2 = R.generate(settings({ genPrompt = "x", genSize = "canvas" }), claude(), {})
  truthy(e2:find("Current canvas"), e2)
  local ok = R.generate(settings({ genPrompt = "x", genSize = "canvas" }), claude(), SPRITE)
  eq(ok.options.size.width, 40, "current canvas size")
  eq(ok.options.size.height, 30)
  local _, e3 = R.generate(settings({ genPrompt = "x", genTarget = "active_layer" }), claude(), {})
  truthy(e3:find("Active layer"), e3)
  local _, e4 = R.generate(settings({ genPrompt = "x", genPalette = "current" }), claude(), {})
  truthy(e4:find("Current"), e4)
end)

test("directions, variations and batch", function()
  local d = R.directions(8, settings({ genPrompt = "a fox" }), claude(), {})
  eq(d.action, "directions")
  eq(d.options.directions, 8)
  local d2 = R.directions(4, settings(), claude(), SPRITE)
  eq(d2.text, "", "uses the open sprite without a prompt")
  local _, e = R.directions(4, settings(), claude(), {})
  truthy(e:find("Describe the character"), e)

  local v = R.variations("", 3, settings(), claude(), SPRITE)
  eq(v.options.count, 3)
  eq(R.variations("x", 9, settings(), claude(), SPRITE).options.count, 4, "count clamped")

  local b = R.batch(settings({ genBatch = "sword; shield\npotion;; ", genPrompt = "cozy" }), claude(), {})
  eq(b.action, "batch")
  eq(#b.options.items, 3)
  eq(b.options.items[3], "potion")
  eq(b.text, "cozy")
  local _, eb = R.batch(settings({ genBatch = " ; " }), claude(), {})
  truthy(eb:find("List the items"), eb)
  local many = {}
  for i = 1, R.MAX_BATCH + 1 do many[i] = "item" .. i end
  local _, eMany = R.batch(settings({ genBatch = table.concat(many, ";") }), claude(), {})
  truthy(eMany:find("Up to"), eMany)
end)

test("parseItems splits on semicolons and newlines", function()
  local items = R.parseItems("a;b\r\nc\n\n ; d ")
  eq(table.concat(items, "|"), "a|b|c|d")
  eq(#R.parseItems(""), 0)
  eq(#R.parseItems(nil), 0)
end)

test("animate needs a sprite and sends the animation block", function()
  local _, e = R.animate(settings(), claude(), {})
  truthy(e:find("sprite"), e)
  local p = R.animate(settings({ animPreset = "walk", animFrames = 6, animFrameMs = 120, animLoop = true, animNotes = " cape " }), claude(), SPRITE)
  eq(p.action, "animate")
  eq(p.text, "cape")
  eq(p.options.animation.preset, "walk")
  eq(p.options.animation.frames, 6)
  eq(p.options.animation.frameMs, 120)
  eq(p.options.animation.loop, true)
  eq(wire(p).options.animation.preset, "walk")
end)

test("describe gives a readable log line per action", function()
  eq(R.describe(R.chat("hello", settings(), claude(), SPRITE)), "hello")
  local g = R.generate(settings({ genPrompt = "a knight", genPalette = "pico8" }), claude(), {})
  eq(R.describe(g), "Generate · 32x32 · PICO-8: a knight")
  local b = R.batch(settings({ genBatch = "a;b" }), claude(), {})
  eq(R.describe(b), "Batch of 2 · 32x32: a, b")
  local a = R.animate(settings({ animPreset = "run", animFrames = 6, animFrameMs = 90 }), claude(), SPRITE)
  eq(R.describe(a), "Animate · Run · 6 frames · 90 ms · loop")
  eq(R.describe(R.review("", settings(), claude(), SPRITE)), "Review & fix")
end)

test("tool payloads carry the common target", function()
  local s = settings({ toolTolerance = 25, toolAllFrames = true })
  local p = R.tool("remove_background", "ui-1", s, SELECTED)
  eq(p.event, "tool_run")
  eq(p.requestId, "ui-1")
  eq(p.tool, "remove_background")
  eq(p.params.mode, "edges")
  eq(p.params.tolerance, 25)
  eq(p.params.frames, "all")
  eq(p.params.selectionOnly, false)
  eq(p.params.layer, "Layer 1")
  eq(p.sprite, 7)
end)

test("tool payloads for outline, palette, adjust and transforms", function()
  local s = settings({ toolOutlineColor = "112233ff", toolOutlinePlacement = "inside", toolDither = "floyd",
    toolPalette = "db32", toolColors = 8, toolHue = 30, toolLightness = -10 })
  eq(R.tool("outline_auto", "1", s, SPRITE).params.color, nil, "auto shade sends no color")
  local o = R.tool("outline_color", "1", s, SPRITE)
  eq(o.tool, "add_outline")
  eq(o.params.color, "#112233")
  eq(o.params.placement, "inside")
  local semi = R.tool("outline_color", "1", settings({ toolOutlineColor = "11223380" }), SPRITE)
  eq(semi.params.color, "#11223380", "alpha kept when not opaque")
  local r = R.tool("reduce_colors", "1", s, SPRITE)
  eq(r.params.colors, 8)
  eq(r.params.dither, "floyd")
  eq(R.tool("apply_palette", "1", s, SPRITE).params.palette, "db32")
  local a = R.tool("adjust_colors", "1", s, SPRITE)
  eq(a.params.hue, 30)
  eq(a.params.lightness, -10)
  eq(a.params.saturation, nil, "zero sliders are left out")
  eq(R.tool("shift_up", "1", s, SPRITE).params.dy, -1)
  eq(R.tool("rotate_90", "1", s, SPRITE).params.op, "rotate_90")
end)

test("undo and redo send a non-empty object without the target", function()
  local u = R.tool("undo", "9", settings({ toolSelectionOnly = true }), SPRITE)
  eq(u.tool, "undo")
  eq(u.params.layer, nil)
  eq(u.params.selectionOnly, nil)
  -- json.encode turns {} into [], which the bridge would reject.
  truthy(json.encode(u.params):find("^{"), "params encode as an object")
end)

test("tool validation errors", function()
  local _, e1 = R.tool("flip_h", "1", settings(), {})
  truthy(e1:find("sprite"), e1)
  local _, e2 = R.tool("flip_h", "1", settings({ toolSelectionOnly = true }), SPRITE)
  truthy(e2:find("Nothing is selected"), e2)
  local _, e3 = R.tool("adjust_colors", "1", settings(), SPRITE)
  truthy(e3:find("slider"), e3)
  local _, e4 = R.tool("nope", "1", settings(), SPRITE)
  truthy(e4:find("Unknown tool"), e4)
  local ok = R.tool("flip_h", "1", settings({ toolSelectionOnly = true }), SELECTED)
  eq(ok.params.selectionOnly, true)
  local group = { sprite = SPRITE.sprite, layer = "Body", layerIsGroup = true }
  local _, e5 = R.tool("flip_h", "1", settings(), group)
  truthy(e5:find('"Body" is a group'), e5)
  truthy(R.tool("undo", "1", settings(), group), "undo works on any layer")
end)

test("the Tools tab's Apply runs the picked tool", function()
  eq(R.applyKey(settings()), "remove_background", "default choice")
  eq(R.applyKey(settings({ toolChoice = "outline" })), "outline_auto")
  eq(R.applyKey(settings({ toolChoice = "outline", toolOutlineMode = "color" })), "outline_color")
  -- Every picker entry must reach a real tool, whatever the outline mode.
  for _, choice in ipairs(C.TOOL_CHOICES) do
    for _, mode in ipairs(C.OUTLINE_COLORS) do
      local key = R.applyKey(settings({ toolChoice = choice.id, toolOutlineMode = mode.id }))
      truthy(R.TOOLS[key], choice.id .. "/" .. mode.id .. " -> " .. tostring(key))
    end
  end
end)

test("every tool key builds a payload that encodes as an object", function()
  local s = settings({ toolHue = 5, toolImportPath = "/art/hero.png" })
  for key in pairs(R.TOOLS) do
    local p, err = R.tool(key, "x", s, SELECTED)
    truthy(p, key .. ": " .. tostring(err))
    truthy(json.encode(p.params):find("^{"), key .. " params object")
  end
end)

-- v1.1: palettes, source, reference ------------------------------------------------------

test("parseColors reads pasted hex lists and explains bad ones", function()
  local c = R.parseColors("#1A1C2C, 5d275d;#b13e53\n#fff  #1a1c2c")
  eq(table.concat(c, ","), "#1a1c2c,#5d275d,#b13e53,#ffffff", "normalized, #rgb expanded, repeat dropped")
  local _, e1 = R.parseColors("#1a1c2c, #12345")
  truthy(e1:find('"#12345" is not a color'), e1)
  truthy(e1:find("#rrggbb"), "says the format")
  local _, e2 = R.parseColors("#1a1c2c, #1A1C2C")
  truthy(e2:find("at least 2"), e2)
  local _, e3 = R.parseColors("")
  truthy(e3:find("at least 2"), e3)
  local many = {}
  for i = 1, 257 do many[i] = string.format("#%06x", i) end
  local _, e4 = R.parseColors(table.concat(many, ","))
  truthy(e4:find("at most 256"), e4)
  eq(#R.parseColors(table.concat(many, ",", 1, 256)), 256)
end)

test("v1.0 requests stay exactly as they were when no v1.1 option is used", function()
  local g = R.generate(settings({ genPrompt = "a knight" }), claude(), SPRITE)
  for _, field in ipairs({ "source", "maxColors", "forcePalette", "customPalette", "reference" }) do
    eq(g.options[field], nil, "generate " .. field)
  end
  local d = R.directions(4, settings({ genPrompt = "a fox" }), claude(), SPRITE)
  eq(d.options.source, nil, 'Source "Prompt" is the v1.0 behaviour: not sent')
  eq(d.options.size.width, 32)
  local a = R.animate(settings(), claude(), SPRITE)
  for _, field in ipairs({ "mode", "fromFrame", "toFrame", "keepFrames", "allDirections" }) do
    eq(a.options.animation[field], nil, "animation " .. field)
  end
end)

test("generate sends custom palettes, color limits, forced palettes and references", function()
  local s = settings({ genPrompt = "a slime", genPalette = "custom", genCustomPalette = "#000000, #ffffff, #ff0044",
    genColors = "12", genForcePalette = true })
  local ctx = { sprite = SPRITE.sprite, reference = 3, openSprites = { [3] = true, [7] = true } }
  local p = R.generate(s, claude(), ctx)
  eq(p.options.palette, "custom")
  eq(table.concat(p.options.customPalette, ","), "#000000,#ffffff,#ff0044")
  eq(p.options.maxColors, 12)
  eq(p.options.forcePalette, true)
  eq(p.options.reference.sprite, 3)
  eq(p.options.reference.frame, nil, "the contract's frame is optional; the window sends the sprite only")
  local back = wire(p)
  eq(back.options.customPalette[3], "#ff0044", "a JSON array")
  eq(R.describe(p), "Generate · 32x32 · Custom (forced) · max 12 colors · with reference: a slime")

  local _, bad = R.generate(settings({ genPrompt = "x", genPalette = "custom", genCustomPalette = "red, blue" }), claude(), SPRITE)
  truthy(bad:find('"red" is not a color'), bad)
  local auto = R.generate(settings({ genPrompt = "x", genForcePalette = true }), claude(), SPRITE)
  eq(auto.options.forcePalette, nil, "Auto has no palette to force")
  local current = R.generate(settings({ genPrompt = "x", genPalette = "current", genForcePalette = true }), claude(), SPRITE)
  eq(current.options.forcePalette, true)
  eq(current.options.customPalette, nil, "only for Custom")
  local _, gone = R.generate(settings({ genPrompt = "x" }), claude(), { sprite = SPRITE.sprite, referenceGone = true })
  truthy(gone:find("Reference sprite was closed"), gone)
  local tile = R.generate(settings({ genPrompt = "grass", genView = "tile" }), claude(), {})
  eq(tile.options.view, "tile")
  truthy(R.describe(tile):find("Seamless tile", 1, true), R.describe(tile))
end)

test("Source Current sprite: directions and variations start from the open sprite", function()
  local s = settings({ genSource = "current", genSize = "16" })
  local d = R.directions(8, s, claude(), SPRITE)
  eq(d.options.source, "current")
  eq(d.options.size.width, 40, "the sprite's size, not Size")
  eq(d.options.size.height, 30)
  eq(d.text, "", "no description needed")
  eq(d.sprite, 7)
  truthy(R.describe(d):find("from sprite", 1, true), R.describe(d))
  local _, e = R.directions(4, s, claude(), {})
  truthy(e:find('Source "Current sprite" needs an open sprite'), e)
  local _, eWithText = R.directions(4, settings({ genSource = "current", genPrompt = "a fox" }), claude(), {})
  truthy(eWithText:find("Current sprite"), "even with a prompt")

  local v = R.generate(settings({ genSource = "current", genVariations = "3" }), claude(), SPRITE)
  eq(v.action, "variations", "an empty prompt is fine for variations of the sprite")
  eq(v.options.source, "current")
  eq(v.options.count, 3)
  local _, e2 = R.generate(settings({ genSource = "current" }), claude(), SPRITE)
  truthy(e2:find("One new sprite needs a Prompt", 1, true), "a single generate still needs a prompt: " .. e2)
  local single = R.generate(settings({ genSource = "current", genPrompt = "a sword" }), claude(), SPRITE)
  eq(single.action, "generate")
  eq(single.options.source, nil, "Source is for directions and variations only")
  local _, e5 = R.variations("", 3, settings({ genSource = "current" }), claude(), {})
  truthy(e5:find('Source "Current sprite" needs an open sprite', 1, true), e5)
  local quick = R.variations("", 3, settings({ genSource = "current" }), claude(), SPRITE)
  eq(quick.options.source, "current", "Chat's Variations x3 uses the Generate choices too")
end)

test("animate modes: in-betweens and continuing keep the frames they name", function()
  local ctx = { sprite = { id = 7, width = 40, height = 30, frames = 4 }, directionTags = 0 }
  local b = R.animate(settings({ animMode = "between", animFrom = 2, animTo = 3, animFrames = 3 }), claude(), ctx)
  eq(b.options.animation.mode, "between")
  eq(b.options.animation.fromFrame, 2)
  eq(b.options.animation.toFrame, 3)
  eq(b.options.animation.frames, 3)
  eq(b.options.animation.keepFrames, nil)
  truthy(R.describe(b):find("between 2-3", 1, true), R.describe(b))
  local _, e1 = R.animate(settings({ animMode = "between", animFrom = 3, animTo = 3 }), claude(), ctx)
  truthy(e1:find('set "To" to 4', 1, true), e1)
  local _, e2 = R.animate(settings({ animMode = "between", animFrom = 1, animTo = 6 }), claude(), ctx)
  truthy(e2:find("has 4 frames"), e2)

  local c = R.animate(settings({ animMode = "continue", animKeep = 2 }), claude(), ctx)
  eq(c.options.animation.mode, "continue")
  eq(c.options.animation.keepFrames, 2)
  eq(c.options.animation.fromFrame, nil)
  truthy(R.describe(c):find("keep 1-2", 1, true), R.describe(c))
  local _, e3 = R.animate(settings({ animMode = "continue", animKeep = 5 }), claude(), ctx)
  truthy(e3:find("at most 4"), e3)
  local one = { sprite = { id = 7, width = 4, height = 4, frames = 1 } }
  local _, e4 = R.animate(settings({ animMode = "continue", animKeep = 2 }), claude(), one)
  truthy(e4:find("has 1 frame,"), e4)

  local none = R.animate(settings({ animAllDirections = true }), claude(), ctx)
  eq(none.options.animation.allDirections, nil, "no direction tags, nothing to animate")
  local tagged = { sprite = ctx.sprite, directionTags = 4 }
  local all = R.animate(settings({ animAllDirections = true }), claude(), tagged)
  eq(all.options.animation.allDirections, true)
  truthy(R.describe(all):find("all directions", 1, true), R.describe(all))
end)

-- The bridge (keyframeSetup.prepareInbetweens) only draws between neighbouring key frames,
-- or from the last frame back to frame 1 for a loop: frames between the keys would end up
-- in the middle of the in-betweens.
test("in-betweens need neighbouring key frames or the loop wrap, like the bridge", function()
  local four = { sprite = { id = 7, width = 8, height = 8, frames = 4 }, directionTags = 0 }
  local function between(from, to, ctx)
    return R.animate(settings({ animMode = "between", animFrom = from, animTo = to }), claude(), ctx or four)
  end
  for _, pair in ipairs({ { 1, 2 }, { 3, 4 }, { 4, 1 } }) do
    local p, err = between(pair[1], pair[2])
    truthy(p, pair[1] .. "-" .. pair[2] .. ": " .. tostring(err))
  end
  local wrap = between(4, 1)
  eq(wrap.options.animation.fromFrame, 4)
  eq(wrap.options.animation.toFrame, 1)

  local _, gap = between(1, 4)
  truthy(gap:find('neighbouring frames: set "To" to 2 ("From" + 1), or From 4 (the last frame) and To 1 for a loop', 1, true), gap)
  local _, back = between(3, 2)
  truthy(back:find('set "To" to 4', 1, true), back)
  local _, early = between(3, 1)
  truthy(early:find("From 4 (the last frame) and To 1", 1, true), "a loop starts at the last frame: " .. early)
  local _, last = between(4, 2)
  eq(last, 'Between frames: 4 is the last frame, so "To" must be 1 (the loop back to the start).')
  local _, from = between(5, 6)
  eq(from, 'Between frames: this sprite has 4 frames, so "From" can be at most 4.')
  local _, to = between(4, 5)
  eq(to, 'Between frames: this sprite has 4 frames, so "To" can be at most 4.')
  local _, single = between(1, 2, { sprite = { id = 7, width = 8, height = 8, frames = 1 } })
  truthy(single:find("needs two key frames, and this sprite has 1 frame.", 1, true), single)
  local _, same = between(1, 1, { sprite = { id = 7, width = 8, height = 8, frames = 1 } })
  truthy(same:find("has 1 frame.", 1, true), same)
end)

test("All directions only goes with Mode New, like the bridge", function()
  local tagged = { sprite = { id = 7, width = 8, height = 8, frames = 4 }, directionTags = 4 }
  local _, b = R.animate(settings({ animAllDirections = true, animMode = "between", animFrom = 1, animTo = 2 }), claude(), tagged)
  truthy(b and b:find('Mode must be "New"', 1, true), tostring(b))
  local _, c = R.animate(settings({ animAllDirections = true, animMode = "continue", animKeep = 2 }), claude(), tagged)
  truthy(c and c:find("Untick All directions", 1, true), tostring(c))
  local untagged = { sprite = tagged.sprite, directionTags = 0 }
  local ok = R.animate(settings({ animAllDirections = true, animMode = "between", animFrom = 1, animTo = 2 }), claude(), untagged)
  eq(ok.options.animation.allDirections, nil, "a greyed-out tick is ignored")
  eq(ok.options.animation.mode, "between")
end)

test("normalize and import tool payloads", function()
  local n = R.tool("normalize_pixel_art", "1", settings({ toolNormColors = "16", toolNormCleanup = false, toolAllFrames = true }), SPRITE)
  eq(n.tool, "normalize_pixel_art")
  eq(n.params.maxColors, 16)
  eq(n.params.cleanup, false, "sent either way")
  eq(n.params.frames, "all", "takes the common target")
  eq(n.params.layer, "Layer 1")
  local plain = R.tool("normalize_pixel_art", "1", settings(), SPRITE)
  eq(plain.params.maxColors, nil, "All colors: no limit")
  eq(plain.params.cleanup, true)
  eq(plain.params.scale, nil, "the bridge detects the scale")

  local i = R.tool("import_image", "2", settings({ toolImportPath = " /art/Hero.PNG ", toolSelectionOnly = true }), SPRITE)
  eq(i.tool, "import_image")
  eq(i.params.path, "/art/Hero.PNG")
  -- A fixed name would paint a second import (or the user's own "Imported" layer) over;
  -- without one the bridge makes a fresh layer named after the file every time.
  eq(i.params.layer, nil, "no layer: a new one per import")
  truthy(not json.encode(i.params):find("layer", 1, true), json.encode(i.params))
  eq(i.params.selectionOnly, nil, "import_image takes no common target")
  eq(i.params.frames, nil)
  eq(i.sprite, 7)
  local _, e1 = R.tool("import_image", "3", settings(), SPRITE)
  truthy(e1:find("Choose a PNG file"), e1)
  local _, e2 = R.tool("import_image", "3", settings({ toolImportPath = "/art/hero.jpg" }), SPRITE)
  truthy(e2:find("%.png"), e2)
  local _, e3 = R.tool("import_image", "3", settings({ toolImportPath = "/art/hero.png" }), {})
  truthy(e3:find("sprite"), "needs a sprite to import into")
end)

test("undo run payload and the sprite a request draws into", function()
  local u = R.undoRun("ui-9", 7, 4.0)
  eq(u.event, "tool_run")
  eq(u.tool, "undo")
  eq(u.params.steps, 4)
  eq(math.type(u.params.steps), "integer")
  eq(u.sprite, 7)
  truthy(json.encode(u.params):find('^{"steps": 4}'), json.encode(u.params))

  eq(R.boundSprite(R.chat("hi", settings(), claude(), SPRITE)), 7)
  eq(R.boundSprite(R.review("", settings(), claude(), SPRITE)), 7)
  eq(R.boundSprite(R.animate(settings(), claude(), SPRITE)), 7)
  eq(R.boundSprite(R.generate(settings({ genPrompt = "x", genTarget = "new_layer" }), claude(), SPRITE)), 7)
  eq(R.boundSprite(R.generate(settings({ genPrompt = "x" }), claude(), SPRITE)), nil, "new sprite")
  eq(R.boundSprite(R.directions(4, settings({ genSource = "current" }), claude(), SPRITE)), nil, "new sprites")
  eq(R.boundSprite(R.variations("x", 2, settings(), claude(), SPRITE)), nil)
  eq(R.boundSprite(R.chat("hi", settings(), claude(), {})), nil, "no sprite")
  eq(R.boundSprite({ event = "chat_send", action = "generate", sprite = 7, options = {} }), nil, "no target: new sprite")
end)

-- Repeat last ---------------------------------------------------------------------------------

local function stored(p) return json.encode(p) end

test("repeat last: nothing stored, garbage, or not a chat_send", function()
  for _, value in ipairs({ "", "{not json", json.encode({ event = "tool_run" }) }) do
    local p, err = R.repeatLast(value, SPRITE, true)
    eq(p, nil)
    eq(err, R.NOTHING_TO_REPEAT)
  end
end)

test("repeat last resends the request on the sprite and selection open now", function()
  local first = R.chat("make it blue", settings(), claude(), SELECTED)
  local now = { sprite = { id = 9, width = 8, height = 8 }, selection = { x = 0, y = 0, width = 2, height = 2 } }
  local p = R.repeatLast(stored(first), now, true)
  eq(p.event, "chat_send")
  eq(p.text, "make it blue")
  eq(p.options.model, "opus")
  eq(p.sprite, 9, "the active sprite, not the one it was first sent with")
  eq(p.selection.width, 2, "today's selection")
  eq(math.type(p.sprite), "integer", "plain integers again")
  local noSel = R.repeatLast(stored(first), { sprite = now.sprite }, true)
  eq(noSel.selection, nil, "no selection now, none sent")
  local noSprite = R.repeatLast(stored(first), {}, true)
  eq(noSprite.sprite, nil, "chat works without a sprite")
  eq(R.describe(noSprite), "make it blue")

  local batch = R.batch(settings({ genBatch = "sword; shield" }), claude(), {})
  local again = R.repeatLast(stored(batch), {}, true)
  eq(R.describe(again), "Batch of 2 · 32x32: sword, shield", "arrays come back as Lua tables")
  truthy(json.encode(again):find('"items": %["sword", "shield"%]'), json.encode(again))
end)

test("repeat last checks what the action needs and drops stale references", function()
  local redraw = R.editSelection("moss", settings(), claude(), SELECTED)
  local _, e1 = R.repeatLast(stored(redraw), SPRITE, true)
  truthy(e1:find("Select an area"), e1)
  local _, e2 = R.repeatLast(stored(R.review("", settings(), claude(), SPRITE)), {}, true)
  truthy(e2:find("Open or create a sprite"), e2)
  local dirs = R.directions(4, settings({ genSource = "current" }), claude(), SPRITE)
  local _, e3 = R.repeatLast(stored(dirs), {}, true)
  truthy(e3:find("Current sprite"), e3)
  local resized = R.repeatLast(stored(dirs), { sprite = { id = 2, width = 64, height = 48 } }, true)
  eq(resized.options.size.width, 64, "source size follows the sprite it now starts from")

  local withRef = R.generate(settings({ genPrompt = "x" }), claude(), { reference = 3, openSprites = { [3] = true } })
  local kept = R.repeatLast(stored(withRef), { openSprites = { [3] = true } }, true)
  eq(kept.options.reference.sprite, 3, "same session, still open")
  local closed = R.repeatLast(stored(withRef), { openSprites = {} }, true)
  eq(closed.options.reference, nil, "closed since")
  local restarted = R.repeatLast(stored(withRef), { openSprites = { [3] = true } }, false)
  eq(restarted.options.reference, nil, "id 3 is another sprite after a restart")
end)

-- Repeat last goes to the sprite open now, which may have fewer frames or no direction
-- tags: it gets the Animate tab's checks instead of a run the bridge refuses.
test("repeat last checks an animation against the sprite open now", function()
  local tagged = { sprite = { id = 7, width = 8, height = 8, frames = 4 }, directionTags = 4 }
  local plainSprite = { sprite = { id = 9, width = 8, height = 8, frames = 2 }, directionTags = 0 }

  local all = R.animate(settings({ animAllDirections = true }), claude(), tagged)
  eq(R.repeatLast(stored(all), tagged, true).options.animation.allDirections, true)
  local p, e1 = R.repeatLast(stored(all), plainSprite, true)
  eq(p, nil, "not silently sent as a one-direction animation")
  truthy(e1:find("All directions needs a sprite with direction tags", 1, true), e1)

  local between = R.animate(settings({ animMode = "between", animFrom = 3, animTo = 4 }), claude(), tagged)
  eq(R.repeatLast(stored(between), tagged, true).options.animation.toFrame, 4)
  local _, e2 = R.repeatLast(stored(between), plainSprite, true)
  eq(e2, 'Between frames: this sprite has 2 frames, so "From" can be at most 2.')
  local wrap = R.animate(settings({ animMode = "between", animFrom = 4, animTo = 1 }), claude(), tagged)
  local grown = { sprite = { id = 7, width = 8, height = 8, frames = 7 }, directionTags = 4 }
  local _, e3 = R.repeatLast(stored(wrap), grown, true)
  truthy(e3:find("From 7 (the last frame) and To 1", 1, true), "frame 4 is no longer the last one: " .. e3)

  local keep = R.animate(settings({ animMode = "continue", animKeep = 3 }), claude(), tagged)
  local _, e4 = R.repeatLast(stored(keep), plainSprite, true)
  eq(e4, 'Continue: this sprite has 2 frames, so "Keep" can be at most 2.')

  -- Stored by a window that let both through: the bridge would refuse it.
  local both = R.animate(settings({ animAllDirections = true }), claude(), tagged)
  both.options.animation.mode, both.options.animation.fromFrame, both.options.animation.toFrame = "between", 1, 2
  local _, e5 = R.repeatLast(stored(both), tagged, true)
  truthy(e5:find('Mode must be "New"', 1, true), e5)
end)

-- Run undo ---------------------------------------------------------------------------------

-- run_undo counts on this: one "change" per undo step added to the sprite (empty and
-- background-tab ones included) and one per step undone or redone, none for things
-- that leave the history alone. If an Aseprite update changes it, this fails first.
test("Aseprite fires one sprite change event per undo step (what run undo counts)", function()
  local a = Sprite(8, 8)
  local n, fromUndo = 0, 0
  local code = a.events:on("change", function(ev)
    n = n + 1
    if ev.fromUndo then fromUndo = fromUndo + 1 end
  end)
  local function count(fn)
    n, fromUndo = 0, 0
    fn()
    return n, fromUndo
  end
  eq(count(function()
    app.transaction("t", function()
      a:newLayer()
      a:newFrame()
      a.layers[1]:cel(1).image:drawPixel(0, 0, Color{ r = 255, g = 0, b = 0 })
    end)
  end), 1, "a transaction is one step")
  eq(count(function() app.transaction("empty", function() end) end), 1, "an empty transaction is a step too")
  eq(count(function() a:newLayer(); a:newFrame() end), 2, "each call outside a transaction")
  local undos, undoFlag = count(function() for _ = 1, 3 do app.command.Undo() end end)
  eq(undos, 3, "one per step undone")
  eq(undoFlag, 3, "flagged fromUndo")
  eq(count(function() app.command.Redo() end), 1, "one per step redone")
  eq(count(function() a.properties("aseprite-mcp").probe = 1 end), 0, "properties are no step")
  eq(count(function()
    pcall(app.transaction, "fails", function()
      a:newLayer()
      error("boom")
    end)
  end), 0, "a rolled-back transaction is no step")

  -- app.transaction groups the ACTIVE sprite's changes only: on a background tab every
  -- call is its own step (and the active tab gets an empty one).
  local b = Sprite(8, 8)
  eq(count(function() app.transaction("bg", function() a:newLayer(); a:newFrame() end) end), 2, "background tab")
  eq(count(function() app.sprite = a; app.sprite = b end), 0, "switching tabs is no step")
  a.events:off(code)
  b:close()
  a:close()
end)

-- A fake sprite.events: watch(id, fn) like the window's, change(id, n) fires n changes.
local function watcher()
  local w = { listeners = {}, stops = 0, fail = false }
  function w.watch(id, onChange)
    if w.fail then return nil end
    local entry = { id = id, fn = onChange }
    w.listeners[entry] = true
    return function()
      w.stops = w.stops + 1
      w.listeners[entry] = nil
    end
  end
  function w.change(id, n)
    for _ = 1, n or 1 do
      for entry in pairs(w.listeners) do
        if entry.id == id then entry.fn() end
      end
    end
  end
  function w.count()
    local n = 0
    for _ in pairs(w.listeners) do n = n + 1 end
    return n
  end
  return w
end

test("run undo offers a run's steps for its sprite until the sprite changes", function()
  local w = watcher()
  local u = RunUndo.new(w.watch)
  eq(u:steps(7), nil)
  u:started(7)
  w.change(7, 3) -- the run's three steps
  eq(u:done(wire({ durationMs = 10, undoSteps = 3, sprite = 7 })), true)
  u:ended()
  eq(u:steps(7), 3)
  eq(math.type(u:steps(7)), "integer")
  eq(u:steps(8), nil, "other sprites have nothing to undo")
  eq(w.count(), 1, "only the offer listens now")
  w.change(7) -- the user drew on it
  eq(u:steps(7), nil, "the history no longer ends with the run")
  eq(w.count(), 0, "listener removed")

  u:started(7)
  w.change(7, 2)
  u:done({ undoSteps = 2 })
  eq(u:take(7), 2, "a bridge that doesn't name the sprite: the request's")
  eq(u:steps(7), nil, "handed out once")
  eq(w.count(), 0)
end)

test("run undo counts from the start of the run: the user's edits meanwhile mean no offer", function()
  local w = watcher()
  local u = RunUndo.new(w.watch)
  u:started(7)
  w.change(7, 2) -- AI steps
  w.change(7) -- the user draws while the AI works
  w.change(7) -- AI step
  eq(u:done(wire({ undoSteps = 3, sprite = 7 })), false, "undo 3 would take the user's stroke")
  eq(u:steps(7), nil)
  eq(w.count(), 0, "the run's listener is gone")

  u:started(7)
  w.change(7, 3)
  w.change(7) -- a Ctrl+Z during the run also counts
  eq(u:done({ undoSteps = 3, sprite = 7 }), false)

  u:started(7)
  w.change(7, 2)
  eq(u:done({ undoSteps = 3, sprite = 7 }), false, "fewer steps than reported: not exact either")
end)

test("run undo links the steps to the sprite the bridge names", function()
  local w = watcher()
  local u = RunUndo.new(w.watch)
  u:started(7)
  w.change(7, 2)
  eq(u:done(wire({ undoSteps = 2, sprite = 8 })), false, "steps on a sprite not watched since the start")
  eq(u:steps(7), nil, "not offered for the request's sprite either")
  eq(u:steps(8), nil)

  u:started(nil) -- sent without a sprite: the bridge picked one when it started
  eq(u:done(wire({ undoSteps = 1, sprite = 8 })), false)
  eq(u:steps(8), nil)

  u:started(7)
  w.change(7, 2)
  eq(u:done(wire({ undoSteps = 2, sprite = 7 })), true, "7.0 on the wire is sprite 7")
  eq(u:steps(7), 2)
end)

test("run undo ignores runs it can't attribute or that changed nothing", function()
  local w = watcher()
  local u = RunUndo.new(w.watch)
  u:started(nil) -- generate into a new sprite
  eq(u:done({ undoSteps = 5 }), false)
  u:started(7)
  w.change(7, 4)
  u:done({ undoSteps = 4 })
  u:ended()
  u:started(7)
  eq(u:done({ durationMs = 5 }), false, "a run that only answered")
  eq(u:steps(7), 4, "the drawing run before it can still be undone")
  u:ended()
  eq(u:done({ undoSteps = 9 }), false, "a late done after the run ended")
  eq(u:steps(7), 4)
  u:started(7)
  w.change(7)
  eq(u:steps(7), nil, "a step of the next run withdraws the earlier offer at once")
  eq(u:done({}), false, "a bridge that withheld undoSteps")
  w.fail = true
  u:started(8)
  eq(u:done({ undoSteps = 2 }), false, "unwatchable sprite: no offer")
  eq(u:steps(8), nil)
  w.fail = false

  u:started(7)
  u:started(9) -- a new run before the last one reported: only the new one is counted
  eq(w.count(), 1)
  u:ended()
  eq(w.count(), 0, "nothing keeps listening once the run ended")
end)

-- Per-sprite Generate settings ------------------------------------------------------------------

test("sprite settings round-trip through sprite.properties without an undo step", function()
  local sprite = Sprite(8, 8)
  eq(SpriteSettings.load(sprite), nil, "nothing stored yet")
  local s = settings({ genPrompt = "a knight", genSize = "64", genPalette = "custom",
    genCustomPalette = "#000000, #ffffff", genColors = "8", genForcePalette = true, genSource = "current" })
  eq(SpriteSettings.save(sprite, s), true)
  eq(sprite.isModified, false, "no undo step, no unsaved mark")
  local loaded = SpriteSettings.load(sprite)
  eq(loaded.genPrompt, "a knight")
  eq(loaded.genSize, "64")
  eq(loaded.genCustomPalette, "#000000, #ffffff")
  eq(loaded.genForcePalette, true)
  eq(loaded.genSource, "current")
  eq(loaded.genOutline, true)
  eq(loaded.tab, nil, "only Generate settings")

  sprite.properties(SpriteSettings.EXTENSION_KEY).generate = { genSize = "999", genStyle = "8bit", stray = 1 }
  local odd = SpriteSettings.load(sprite)
  eq(odd.genSize, "32", "invalid values fall back like prefs")
  eq(odd.genStyle, "8bit")
  eq(odd.stray, nil)
  sprite.properties(SpriteSettings.EXTENSION_KEY).generate = "not a table"
  eq(SpriteSettings.load(sprite), nil)
  sprite:close()

  local prefs = { genPrompt = "old", genStyle = "8bit" }
  local changed = SpriteSettings.apply(prefs, { genPrompt = "new", genStyle = "8bit" })
  eq(table.concat(changed, ","), "genPrompt", "only real changes")
  eq(prefs.genPrompt, "new")
  eq(SpriteSettings.save(nil, s), false)
  eq(SpriteSettings.load(nil), nil)
end)

test("settings for v1.1 have safe defaults", function()
  local s = S.snapshot({})
  eq(s.genSource, "prompt")
  eq(s.genColors, "auto")
  eq(s.genForcePalette, false)
  eq(s.animMode, "new")
  eq(s.animFrom, 1)
  eq(s.animTo, 2)
  eq(s.toolNormCleanup, true)
  eq(s.lastRequest, "")
  local long = string.rep("x", 50000)
  eq(#S.coerce("lastRequest", long), 50000, "a whole request fits")
  eq(#S.coerce("genPrompt", long), 4000, "other text stays capped")
  eq(S.coerce("animFrom", 0), 1)
end)

-- wrap / format / theme -------------------------------------------------------------------

test("wrap breaks on words and keeps paragraphs", function()
  local lines = W.wrap("one two three\n\nfour", 40, measure) -- 10 chars per line
  eq(table.concat(lines, "|"), "one two|three||four")
end)

test("wrap hard-splits long words per UTF-8 character", function()
  local lines = W.wrap("şşşşşşşşşşşş", 20, measure) -- 5 chars per line
  eq(#lines, 3)
  eq(lines[1], "şşşşş")
  eq(lines[3], "şş")
  local tiny = W.wrap("abc", 1, measure)
  eq(#tiny, 3, "always advances even when nothing fits")
end)

test("fit truncates with an ellipsis", function()
  eq(W.fit("hello", 100, measure), "hello")
  eq(W.fit("hello world", 32, measure), "hello...")
  eq(W.fit("hello", 8, measure), "", "not even the ellipsis fits")
end)

test("format durations, costs and done lines", function()
  eq(F.duration(0), "0s")
  eq(F.duration(59.4), "59s")
  eq(F.duration(65), "1m 05s")
  eq(F.duration(3700), "1h 01m")
  eq(F.cost(0), nil)
  eq(F.cost(0.004), "<$0.01")
  eq(F.cost(0.0412), "$0.04")
  eq(F.done(wire({ durationMs = 23400, turns = 5, costUsd = 0.04 })), "Done in 23s · 5 steps · $0.04")
  eq(F.done({ durationMs = 1000, turns = 1 }), "Done in 1s · 1 step")
  eq(F.done(nil), "Done")
  eq(F.done({ durationMs = 2000, costUsd = 0 }), "Done in 2s")
end)

test("format working line, connection and ai summary", function()
  eq(F.working(12, "draw_script"), "Working 12s · draw_script")
  -- The label names the job that finished last ("Variation 3"): not header material.
  eq(F.working(3, nil, { done = 2, total = 4, label = "Variation 3" }), "Working 3s · 2/4 done")
  eq(F.working(3, "x", { done = 0, total = 0 }), "Working 3s · x")
  eq(F.connection("connected").state, "ok")
  eq(F.connection("disconnected").state, "off")
  eq(F.connection("error: refused").state, "error")
  truthy(F.connection(nil).text:find("npm start"), "tells how to start the bridge")
  eq(F.ai("Claude Code", "Opus", "Balanced"), "Claude Code · Opus · Balanced")
  eq(F.ai("Gemini", "Default", nil), "Gemini")
end)

test("format tool results and truncation", function()
  eq(F.toolResult("Outline", true, "  Added\n outline "), "Outline: Added outline")
  eq(F.toolResult("Outline", false, ""), "Outline: failed")
  eq(F.truncate("abcdef", 10), "abcdef")
  eq(F.truncate("abcdefghijk", 6), "abc...")
  eq(F.truncate("ğüşiöçğüşiöç", 6), "ğüş...")
  eq(F.truncate("\255\255\255\255\255\255\255", 5), "\255\255...")
end)

test("theme palette adapts to dark and light backgrounds", function()
  local dark = T.palette(T.rgb(30, 30, 30), T.rgb(230, 230, 230))
  local light = T.palette(T.rgb(250, 250, 250), T.rgb(20, 20, 20))
  eq(dark.dark, true)
  eq(light.dark, false)
  truthy(T.luminance(dark.error) > T.luminance(light.error), "brighter accents on dark")
  local mid = T.mix(T.rgb(0, 0, 0), T.rgb(255, 255, 255), 0.5)
  eq(mid.r, 128)
  eq(T.rgb(300, -5, 10.4).r, 255)
end)

-- chat log ------------------------------------------------------------------------------------

test("chat log collapses tool calls and counts repeats", function()
  local log = ChatLog.new(textRender.normalize)
  log:add("user", "draw")
  log:addTool("draw_script")
  log:addTool("draw_script")
  log:addTool("view_sprite")
  eq(#log.messages, 2)
  eq(log:last().text, "draw_script x2, view_sprite")
  log:add("ai", "Done.")
  log:addTool("view_sprite")
  eq(#log.messages, 4, "a new tool line after text")
end)

test("chat log updates progress in place", function()
  local log = ChatLog.new()
  log:setProgress(1, 4, "Variation 1")
  log:setProgress(2, 4, "Variation 3")
  eq(#log.messages, 1)
  eq(log:last().text, "2/4 done · Variation 3", "label = the job that just finished")
  log:setProgress(wire({ n = 3 }).n, 4)
  eq(log:last().text, "3/4 done", "float from json, no label")
end)

-- What a batch of three looks like on the wire: progress, then each job's reply, then
-- its progress (see bridge GenerationService.runParallel).
test("chat log keeps one progress line per run, always the newest", function()
  local log = ChatLog.new(textRender.normalize)
  log:add("user", "Batch of 3")
  log:setProgress(0, 3)
  log:add("ai", "sword: Done.")
  log:setProgress(1, 3, "sword")
  log:add("ai", "shield: Done.")
  log:setProgress(2, 3, "shield")
  log:add("error", "potion failed: timeout")
  log:setProgress(3, 3, "potion")
  local texts = {}
  for i, m in ipairs(log.messages) do texts[i] = m.text end
  eq(table.concat(texts, "|"), "Batch of 3|sword: Done.|shield: Done.|potion failed: timeout|3/3 done · potion")
  -- The next run gets its own line; the finished one stays where it is.
  log:endProgress()
  log:add("user", "again")
  log:setProgress(0, 2)
  eq(#log.messages, 7)
  eq(log.messages[5].text, "3/3 done · potion")
  eq(log:last().text, "0/2 done")
end)

test("chat log cuts huge messages and doesn't repeat status or error lines", function()
  local log = ChatLog.new(textRender.normalize)
  -- "ş" is 2 bytes and "a" shifts them by one: the byte limit falls inside an "ş".
  log:add("error", "a" .. string.rep("ş", ChatLog.MAX_TEXT))
  local text = log:last().text
  truthy(#text < ChatLog.MAX_TEXT + 20, "cut: " .. #text)
  truthy(utf8.len(text) ~= nil, "cut on a character boundary")
  truthy(text:find("%(cut%)$"), "says it was cut")
  log:clear()
  log:add("status", "New conversation.")
  log:add("status", "New conversation.")
  log:add("error", "Still working.")
  log:add("error", "Still working.")
  eq(#log.messages, 2, "repeats collapse")
  log:add("ai", "ok")
  log:add("ai", "ok")
  eq(#log.messages, 4, "the AI may say the same thing twice")
end)

test("chat log caps its size, normalizes text and bumps its version", function()
  local log = ChatLog.new(textRender.normalize, 3)
  local v = log.version
  for i = 1, 5 do log:add("status", "m" .. i) end
  eq(#log.messages, 3)
  eq(log.messages[1].text, "m3")
  truthy(log.version > v, "version bumped")
  log:add("ai", "Bitti — harika “iş” …")
  eq(log:last().text, 'Bitti - harika "iş" ...')
  log:clear()
  eq(log:isEmpty(), true)
end)

test("text normalize keeps Turkish letters and the middle dot", function()
  eq(textRender.normalize("ğüşıöç ĞÜŞİÖÇ · x"), "ğüşıöç ĞÜŞİÖÇ · x")
  eq(textRender.normalize("a\tb\r\nc"), "a b\nc")
  eq(textRender.normalize("emoji 🎨"), "emoji ?")
  eq(textRender.normalize("bad \255 byte"), "bad ? byte")
  eq(textRender.forWidget("Şapka · iş — 🎨"), "Sapka - is - ?", "native labels get base letters")
end)

-- log layout -----------------------------------------------------------------------------------

test("log layout stacks blocks with bubbles and caches wrapping", function()
  local log = ChatLog.new()
  log:add("user", "hello there")
  log:add("ai", "hi")
  local calls = 0
  local function counting(s)
    calls = calls + 1
    return measure(s)
  end
  local blocks, total = LL.layout(log.messages, 100, counting, 10)
  eq(#blocks, 2)
  eq(blocks[1].bubble, true)
  eq(blocks[1].h, 10 + LL.BUBBLE_Y * 2)
  eq(blocks[2].y, blocks[1].h + 6)
  eq(total, blocks[2].y + 10)
  local before = calls
  LL.layout(log.messages, 100, counting, 10)
  eq(calls, before, "second layout reuses cached lines")
  LL.layout(log.messages, 60, counting, 10)
  truthy(calls > before, "width change re-wraps")
end)

test("log layout splits the speaker prefix", function()
  eq(select(2, LL.splitPrefix("You: hi", "You: ")), "hi")
  eq(LL.splitPrefix("You:", "You: "), "You:")
  eq(LL.splitPrefix("plain", ""), nil)
  eq(select(2, LL.splitPrefix("other", "AI: ")), "other")
end)

test("log scroll stays anchored while reading old messages", function()
  eq(LL.clampScroll(500, 300, 100), 200)
  eq(LL.clampScroll(-5, 300, 100), 0)
  eq(LL.clampScroll(50, 80, 100), 0, "content shorter than the view")
  eq(LL.keepAnchor(0, 300, 340), 0, "at the bottom: stick")
  eq(LL.keepAnchor(20, 300, 340), 60, "reading: keep position")
end)

-- session -------------------------------------------------------------------------------------------

local Session = load("ui/session.lua")(F)

local function newSession(showTools)
  local clock = { t = 100 }
  local s = Session.new(ChatLog.new(textRender.normalize), function() return clock.t end,
    function() return showTools ~= false end)
  return s, clock
end

local function kinds(log)
  local out = {}
  for i, m in ipairs(log.messages) do out[i] = m.kind end
  return table.concat(out, ",")
end

test("session: a full run from send to done", function()
  local s, clock = newSession()
  s:sent("draw a cat")
  eq(s.busy, true, "busy right away")
  eq(s.awaiting, 100)
  s:chatEvent(wire({ kind = "busy", busy = true }))
  eq(s.awaiting, nil, "confirmed")
  s:chatEvent(wire({ kind = "tool", name = "draw_script" }))
  eq(s.tool, "draw_script")
  s:chatEvent(wire({ kind = "progress", done = 1, total = 2, label = "Variation" }))
  eq(s.progress.total, 2)
  clock.t = 112
  eq(s:elapsed(), 12)
  s:chatEvent(wire({ kind = "text", text = "Here you go." }))
  s:chatEvent(wire({ kind = "done", stats = { durationMs = 12000, turns = 3 } }))
  s:chatEvent(wire({ kind = "busy", busy = false }))
  eq(s.busy, false)
  eq(s.note.text, "Done in 12s · 3 steps")
  eq(s.note.kind, "ok")
  eq(s.tool, nil, "cleared after the run")
  eq(kinds(s.log), "user,tool,progress,ai,done")
  eq(s:chatEvent(wire({ kind = "mystery" })), false, "unknown kinds ignored")
end)

test("session: runs without a done event still report how they ended", function()
  local s, clock = newSession()
  s:sent("x")
  s:chatEvent({ kind = "busy", busy = true })
  clock.t = 107
  s:chatEvent({ kind = "busy", busy = false })
  eq(s.note.text, "Finished in 7s")
  s:sent("y")
  s:chatEvent({ kind = "busy", busy = true })
  eq(s:stop(true), false, "bridge will confirm")
  clock.t = 110
  s:chatEvent({ kind = "busy", busy = false })
  eq(s.note.text, "Stopped after 3s")
end)

test("session: errors before confirmation end the run", function()
  local s = newSession()
  s:sent("x")
  s:chatEvent(wire({ kind = "error", text = "Invalid chat request" }))
  eq(s.busy, false)
  eq(s.note.kind, "error")
  -- An error during a confirmed run waits for busy = false.
  s:sent("y")
  s:chatEvent({ kind = "busy", busy = true })
  s:chatEvent({ kind = "error", text = "tool failed" })
  eq(s.busy, true)
end)

test("session: Stop before the bridge confirmed waits for it instead of flickering", function()
  local s, clock = newSession()
  s:sent("x")
  eq(s:stop(true), false, "the bridge answers the chat_send, then the cancel")
  eq(s.busy, true)
  eq(s.stopping, true)
  -- What the bridge sends for chat_send followed by chat_cancel.
  s:chatEvent(wire({ kind = "busy", busy = true }))
  eq(s.busy, true)
  eq(s.stopping, true, "still stopping after the late busy = true")
  s:chatEvent(wire({ kind = "status", text = "Stopped." }))
  clock.t = 102
  s:chatEvent(wire({ kind = "busy", busy = false }))
  eq(s.busy, false)
  eq(s.note.text, "Stopped after 2s")
  eq(s:stop(true), false, "idle: nothing to stop")
end)

test("session: Stop ends locally when the cancel can't be sent, is pressed twice or never confirmed", function()
  local s, clock = newSession()
  s:sent("y")
  s:chatEvent({ kind = "busy", busy = true })
  eq(s:stop(false), true, "cancel couldn't be sent")
  eq(s.busy, false)
  eq(s.note.text, "Stopped after 0s")

  s:sent("z")
  s:chatEvent({ kind = "busy", busy = true })
  eq(s:stop(true), false)
  eq(s:stop(true), true, "second Stop doesn't wait any longer")
  eq(s.busy, false)

  s:sent("w")
  s:chatEvent({ kind = "busy", busy = true })
  s:stop(true)
  clock.t = clock.t + Session.STOP_TIMEOUT - 1
  s:tick()
  eq(s.busy, true, "still waiting")
  clock.t = clock.t + 1
  s:tick()
  eq(s.busy, false, "gave up waiting")
  truthy(s.log:last().text:find("did not confirm"), s.log:last().text)
  eq(s:needsTimer(), false)
  -- The bridge's late answer changes nothing.
  s:chatEvent({ kind = "busy", busy = false })
  eq(s.busy, false)
end)

test("session: New chat during a run stops it and says so", function()
  local s, clock = newSession()
  s:sent("x")
  s:chatEvent({ kind = "busy", busy = true })
  s:newChat(true)
  eq(s.busy, true, "until the bridge confirms")
  eq(s.stopping, true)
  s:chatEvent({ kind = "status", text = "New conversation." })
  s:chatEvent({ kind = "status", text = "Stopped." })
  clock.t = 104
  s:chatEvent({ kind = "busy", busy = false })
  eq(s.note.text, "Stopped after 4s", "not 'Finished'")
  eq(kinds(s.log), "status,status")

  s:sent("y")
  s:chatEvent({ kind = "busy", busy = true })
  s:newChat(false)
  eq(s.busy, false, "reset never left: nothing will confirm")
  eq(s.log:last().text, "New conversation.")
end)

test("session: a lost or unanswered run leaves a note for the header", function()
  local s, clock = newSession()
  s:sent("x")
  s:chatEvent({ kind = "busy", busy = true })
  s:disconnected()
  eq(s.note.text, "Lost the connection to the bridge.")
  eq(s.note.kind, "error")
  s:sent("y")
  clock.t = clock.t + Session.SEND_TIMEOUT
  s:tick()
  eq(s.busy, false)
  truthy(s.note.text:find("No answer"), s.note.text)
end)

test("session: a parallel run's progress clears with the run", function()
  local s = newSession()
  s:sent("batch")
  s:chatEvent(wire({ kind = "busy", busy = true }))
  s:chatEvent(wire({ kind = "progress", done = 0, total = 2 }))
  s:chatEvent(wire({ kind = "progress", done = 1, total = 2, label = "sword" }))
  eq(s.progress.done, 1)
  eq(math.type(s.progress.done), "integer", "JSON floats become integers")
  s:chatEvent(wire({ kind = "busy", busy = false }))
  eq(s.progress, nil)
  s:sent("next")
  s:chatEvent(wire({ kind = "busy", busy = true }))
  s:chatEvent(wire({ kind = "progress", done = 0, total = 3 }))
  eq(kinds(s.log), "user,progress,user,progress", "the next run starts its own line")
end)

test("session: timeouts for unconfirmed runs and unanswered tools", function()
  local s, clock = newSession()
  s:sent("x")
  s:toolSent("ui-1", "Outline")
  eq(s:needsTimer(), true)
  clock.t = 100 + Session.SEND_TIMEOUT
  s:tick()
  eq(s.busy, false)
  eq(s.outcome, "timeout")
  eq(s:hasPendingTools(), true, "tool still has time")
  clock.t = 100 + Session.TOOL_TIMEOUT
  s:tick()
  eq(s:hasPendingTools(), false)
  truthy(s.toolText:find("Outline: no answer"), s.toolText)
  eq(s:needsTimer(), false)
end)

test("session: tool results match their request", function()
  local s = newSession()
  local id = s:nextRequestId()
  eq(id, "ui-1")
  eq(s:nextRequestId(), "ui-2")
  s:toolSent(id, "Reduce colors")
  eq(s.toolText, "Reduce colors...")
  s:toolResult(wire({ requestId = id, ok = true, text = "16 colors" }))
  eq(s.toolText, "Reduce colors: 16 colors")
  eq(s.log:last().kind, "result")
  s:toolResult(wire({ requestId = "stranger", ok = false, text = "boom" }))
  eq(s.toolText, "Tool: boom")
  eq(s.log:last().kind, "error")
end)

test("session: disconnect ends the run and fails pending tools", function()
  local s = newSession()
  s:sent("x")
  s:chatEvent({ kind = "busy", busy = true })
  s:toolSent("ui-9", "Flip horizontal")
  s:disconnected()
  eq(s.busy, false)
  eq(s.outcome, "lost")
  eq(s:hasPendingTools(), false)
  truthy(s.toolText:find("disconnected"), s.toolText)
end)

test("session: tool calls are hidden from the log when Show tool calls is off", function()
  local s = newSession(false)
  s:sent("x")
  s:chatEvent({ kind = "tool", name = "draw_script" })
  eq(s.tool, "draw_script", "still tracked for the header")
  eq(kinds(s.log), "user")
end)

test("session: new chat clears history", function()
  local s = newSession()
  s:sent("x")
  s:newChat(true)
  eq(#s.log.messages, 0, "bridge will confirm")
  s:newChat(false)
  eq(s.log:last().text, "New conversation.")
end)

-- panels ----------------------------------------------------------------------------------------------

local Header = load("ui/header_view.lua")(textRender, W)
local Panels = load("ui/panels.lua")(T, F, Header)

test("header model: working, offline, result, hints", function()
  local s, clock = newSession()
  local idle = Panels.headerModel(s, "connected", "Claude Code · Opus", true, 0)
  eq(idle.note.text, "Ready. Every AI edit is one Ctrl+Z.")
  eq(Panels.headerModel(s, "connected", "", false, 0).note.text, "No sprite open. Generate can create one.")
  local off = Panels.headerModel(s, "disconnected", "", true, 0)
  eq(off.conn.state, "off")
  truthy(off.note.text:find("reconnects"), off.note.text)
  s:sent("x")
  eq(Panels.headerModel(s, "connected", "", true, 0).working, "Sending...")
  s:chatEvent({ kind = "busy", busy = true })
  s:chatEvent({ kind = "tool", name = "view_sprite" })
  clock.t = 105
  local busy = Panels.headerModel(s, "connected", "", true, 3)
  eq(busy.busy, true)
  eq(busy.working, "Working 5s · view_sprite")
  eq(busy.phase, 3)
  s:chatEvent({ kind = "progress", done = 1, total = 3, label = "sword" })
  eq(Panels.headerModel(s, "connected", "", true, 0).working, "Working 5s · 1/3 done · view_sprite")
  eq(Panels.headerModel(s, "connected", "", true, 0).progress.total, 3, "drives the bar")
  s:stop(true)
  eq(Panels.headerModel(s, "connected", "", true, 0).working, "Stopping...")
  s:chatEvent({ kind = "done", stats = { durationMs = 5000 } })
  s:chatEvent({ kind = "busy", busy = false })
  eq(Panels.headerModel(s, "connected", "", true, 0).note.text, "Done in 5s")
end)

-- bounds ------------------------------------------------------------------------------------------

local Bounds = load("ui/bounds.lua")

test("bounds: a saved place that still fits is kept", function()
  local r = Bounds.fit({ x = 100, y = 50, width = 420, height = 400 }, { width = 380, height = 360 }, { width = 1440, height = 900 })
  eq(r.x, 100)
  eq(r.y, 50)
  eq(r.width, 420)
  eq(r.height, 400)
  eq(Bounds.fit({ x = 1, y = 2 }, { width = 1, height = 1 }, { width = 9, height = 9 }), nil, "nothing saved yet")
end)

test("bounds: never smaller than the content, never bigger than the screen", function()
  local r = Bounds.fit({ x = 0, y = 0, width = 100, height = 100 }, { width = 380, height = 360 }, { width = 1440, height = 900 })
  eq(r.width, 380)
  eq(r.height, 360)
  -- Saved on a 4K monitor, reopened on a laptop.
  local big = Bounds.fit({ x = 200, y = 100, width = 2400, height = 1800 }, { width = 380, height = 360 }, { width = 1280, height = 720 })
  eq(big.width, 1280)
  eq(big.height, 720)
  eq(big.x, 0)
  eq(big.y, 0)
end)

test("bounds: a window partly off-screen is pulled back, a lost one is placed anew", function()
  local hint, screen = { width = 380, height = 360 }, { width = 1280, height = 720 }
  local r = Bounds.fit({ x = 1100, y = 600, width = 400, height = 400 }, hint, screen)
  eq(r.x, 880, "right edge on screen")
  eq(r.y, 320, "bottom rows on screen")
  local up = Bounds.fit({ x = -100, y = -30, width = 400, height = 400 }, hint, screen)
  eq(up.x, 0)
  eq(up.y, 0, "title bar reachable")
  eq(Bounds.fit({ x = 3000, y = 100, width = 400, height = 400 }, hint, screen), nil, "monitor gone")
  eq(Bounds.fit({ x = 100, y = 700, width = 400, height = 400 }, hint, screen) ~= nil, false, "less than 40 px showing")
end)

-- log view ----------------------------------------------------------------------------------------

local Fakes = load("tests/ui_fakes.lua")
local LogView = load("ui/log_view.lua")(textRender, LL)

local function viewColors()
  local names = { "bg", "text", "dim", "faint", "userBubble", "userName", "aiName", "tool", "error", "ok", "warn", "accent", "track" }
  local out = {}
  for _, n in ipairs(names) do out[n] = Color{ r = 1, g = 2, b = 3 } end
  return out
end

test("log view reuses its layout until the log changes", function()
  local log = ChatLog.new(textRender.normalize)
  for i = 1, 300 do log:add("ai", "message " .. i .. " with a few words to wrap") end
  local view = LogView.new(log)
  local measured = 0
  local gc = Fakes.gc(340, 130)
  local realMeasure = gc.measureText
  gc.measureText = function(self, s)
    measured = measured + 1
    return realMeasure(self, s)
  end
  view:paint(gc, viewColors())
  local first = measured
  view:paint(gc, viewColors())
  -- Only the visible lines are drawn again (text_render measures each run it draws).
  truthy(measured - first < first / 10, "second paint: " .. (measured - first) .. " vs " .. first)
  local layout = view.layout
  view:paint(gc, viewColors())
  eq(view.layout, layout, "cached")
  log:add("status", "new")
  view:paint(gc, viewColors())
  truthy(view.layout ~= layout, "a new message lays out again")
end)

test("log view wraps a very long URL inside the canvas", function()
  local log = ChatLog.new(textRender.normalize)
  log:add("ai", "See https://example.com/" .. string.rep("abcdefghij", 40) .. " for details")
  local view = LogView.new(log)
  local gc = Fakes.gc(340, 400)
  view:paint(gc, viewColors())
  for _, run in ipairs(gc.runs) do
    truthy(run.x + (utf8.len(run.text) or #run.text) * 4 <= 340, "inside the canvas: " .. run.text)
  end
  truthy(gc:allText():find("for details"), "the words after it still show")
end)

test("log view: a click on 'more below' jumps to the newest message", function()
  local log = ChatLog.new(textRender.normalize)
  for i = 1, 40 do log:add("ai", "line " .. i) end
  local view = LogView.new(log)
  local gc = Fakes.gc(340, 130)
  view:paint(gc, viewColors())
  eq(view:click({ x = 300, y = 120 }), false, "no hint at the bottom")
  view:wheel({ deltaY = -4 })
  view:paint(Fakes.gc(340, 130), viewColors())
  truthy(view.moreRect, "hint shown")
  eq(view:click({ x = 10, y = 10 }), false, "elsewhere: nothing")
  local r = view.moreRect
  eq(view:click({ x = r.x + 2, y = r.y + 2 }), true)
  eq(view.scroll, 0)
end)

test("provider lines explain availability", function()
  eq(Panels.providerLines({ available = false, note = "Set OPENAI_API_KEY." }, true)[1].text, "Not set up: Set OPENAI_API_KEY.")
  eq(Panels.providerLines({ available = true, supportsImages = true }, false)[1].role, "dim")
  eq(Panels.providerLines({ available = true, supportsImages = true }, true)[1].text, "Ready")
  truthy(Panels.providerLines({ available = true, supportsImages = false }, true)[1].text:find("can't see"), "image note")
end)

test("help fits in three short native label lines", function()
  truthy(#Panels.HELP >= 2 and #Panels.HELP <= 3, "2-3 lines")
  for _, line in ipairs(Panels.HELP) do
    -- Native labels don't wrap, and the pixel font has no glyphs from U+2000 up.
    truthy(#line <= 45, "short enough: " .. line)
    truthy(not line:find("[\128-\255]"), "ASCII: " .. line)
  end
  truthy(Panels.HELP[1]:find("npm start"), "says how to start the bridge")
end)

-- debug hook --------------------------------------------------------------------------------------

local function fakeView()
  local calls = {}
  return calls, {
    open = function(tab) calls[#calls + 1] = "open:" .. tostring(tab) end,
    selectTab = function(tab) calls[#calls + 1] = "tab:" .. tab end,
    set = function(id, value) calls[#calls + 1] = "set:" .. id .. "=" .. tostring(value) end,
    click = function(id) calls[#calls + 1] = "click:" .. id end,
    close = function() calls[#calls + 1] = "close" end,
  }
end

test("debug hook is inert unless devMode is on", function()
  local calls, view = fakeView()
  eq(Debug.handle(wire({ event = "ui_debug", action = "open" }), {}, view), nil)
  eq(Debug.handle(wire({ event = "ui_debug", action = "open" }), { devMode = "true" }, view), nil)
  eq(#calls, 0)
end)

test("debug hook dispatches actions and reports errors", function()
  local calls, view = fakeView()
  local prefs = { devMode = true }
  eq(Debug.handle(wire({ action = "open", tab = "tools" }), prefs, view).ok, true)
  Debug.handle(wire({ action = "tab", tab = "chat" }), prefs, view)
  Debug.handle(wire({ action = "set", id = "genPrompt", value = "cat" }), prefs, view)
  Debug.handle(wire({ action = "click", id = "genGenerate" }), prefs, view)
  Debug.handle(wire({ action = "close" }), prefs, view)
  eq(table.concat(calls, ","), "open:tools,tab:chat,set:genPrompt=cat,click:genGenerate,close")
  local bad = Debug.handle(wire({ action = "explode" }), prefs, view)
  eq(bad.ok, false)
  truthy(bad.error:find("Unknown"), bad.error)
  local missing = Debug.handle(wire({ action = "click" }), prefs, view)
  eq(missing.ok, false)
  eq(missing.event, "ui_debug_result")
  view.click = function() error("No button with id x", 0) end
  eq(Debug.handle(wire({ action = "click", id = "x" }), prefs, view).error, "No button with id x")
end)

print(string.format("%d passed, %d failed", passed, failed))
-- os.exit is disabled in Aseprite's Lua; an error makes the run fail instead.
if failed > 0 then error(failed .. " UI test(s) failed", 0) end
