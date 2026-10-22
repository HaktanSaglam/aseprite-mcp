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
    C.ANIMATIONS, C.EFFORTS, C.DITHERS, C.OUTLINE_PLACEMENTS, C.OUTLINE_COLORS, C.TOOL_CHOICES }
  for _, list in ipairs(lists) do
    for _, item in ipairs(list) do
      truthy(not item.label:find("[\128-\255]"), "ASCII label " .. item.label)
    end
  end
end)

test("palette ids match the protocol's PaletteId", function()
  local expected = { "auto", "current", "pico8", "sweetie16", "endesga32", "endesga64", "db16",
    "db32", "aap64", "resurrect64", "gameboy", "nes", "1bit" }
  for i, id in ipairs(expected) do eq(C.PALETTES[i].id, id, "palette " .. i) end
  eq(#C.PALETTES, #expected)
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
  local s = settings({ toolHue = 5 })
  for key in pairs(R.TOOLS) do
    local p, err = R.tool(key, "x", s, SELECTED)
    truthy(p, key .. ": " .. tostring(err))
    truthy(json.encode(p.params):find("^{"), key .. " params object")
  end
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
