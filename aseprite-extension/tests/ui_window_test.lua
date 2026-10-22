-- Drives ui/main_window.lua end to end with a fake Dialog, connection and clock (see
-- tests/ui_fakes.lua): open the window, click through every tab and check the exact
-- protocol messages it sends and how it reacts to bridge events. Run with:
--   aseprite -b --script-param root=<path to aseprite-extension> --script tests/ui_window_test.lua

local root = app.params.root or "."
local function load(file) return dofile(app.fs.joinPath(root, file)) end

local Fakes = load("tests/ui_fakes.lua")
local restore = Fakes.install()

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

local function closeAllSprites()
  while app.sprite do app.sprite:close() end
end

local function newSprite(w, h)
  local s = Sprite(w or 40, h or 30)
  return s
end

-- A fresh window module with its own prefs and fake connection.
local function setup(prefs)
  local conn = Fakes.connection()
  local reconnects = 0
  prefs = prefs or {}
  prefs.port = prefs.port or 7801
  local window = load("ui/main_window.lua")({
    connection = conn,
    prefs = prefs,
    load = load,
    version = "test",
    reconnect = function() reconnects = reconnects + 1 end,
  })
  local env = { conn = conn, prefs = prefs, window = window }
  function env.open(tab)
    window.open(tab)
    env.dlg = Fakes.instances[#Fakes.instances]
    return env.dlg
  end
  function env.reconnects() return reconnects end
  function env.logText()
    env.dlg:repaint()
    return env.dlg:_widget("log").lastGc:allText()
  end
  function env.headerText()
    env.dlg:repaint()
    return env.dlg:_widget("header").lastGc:allText()
  end
  return env
end

local BRIDGE_INFO = {
  event = "bridge_info",
  version = "1.1.0",
  defaultProvider = "claude-code",
  providers = {
    {
      id = "claude-code", label = "Claude Code",
      models = { { id = "opus", label = "Opus" }, { id = "sonnet", label = "Sonnet" } },
      efforts = { "low", "medium", "high", "xhigh", "max" }, available = true, supportsImages = true,
    },
    { id = "gemini-cli", label = "Gemini CLI", models = {}, efforts = {}, available = true, supportsImages = false },
    {
      id = "codex", label = "Codex CLI", models = { { id = "gpt-5", label = "GPT-5" } },
      efforts = { "low", "high" }, available = false, note = "Install the Codex CLI.", supportsImages = true,
    },
  },
}

-- Opening -----------------------------------------------------------------------------

test("opens one non-modal window with five tabs and paints every canvas", function()
  closeAllSprites()
  local env = setup()
  local dlg = env.open()
  eq(dlg.opts.title, "Aseprite MCP")
  eq(dlg.opts.resizeable, true)
  eq(dlg.opts.autofit, 0)
  eq(dlg.showSpec.wait, false)
  eq(#dlg.tabs, 5)
  eq(dlg.data.tabs, "tab_chat")
  dlg:repaint()
  truthy(dlg:_widget("header").lastGc:allText():find("Connected"), "header shows status")
  truthy(dlg:_widget("log").lastGc:allText():find("Ask the AI"), "empty log shows tips")
  truthy(dlg:_widget("help1").text:find("npm start"), "help text")
  eq(dlg:_widget("providerInfo").text, "Built-in list. The bridge updates it once connected.")
  -- Opening again keeps the same dialog.
  env.window.open()
  eq(env.dlg, Fakes.instances[#Fakes.instances])
  eq(env.dlg:_widget("chatStop").enabled, false, "Stop disabled while idle")
end)

test("header tells how to start the bridge when offline", function()
  local env = setup()
  env.conn.setStatus("error: connection refused")
  env.open()
  local text = env.headerText()
  truthy(text:find("npm start"), text)
end)

test("built-in Claude models before bridge_info, bridge list after", function()
  local env = setup()
  local dlg = env.open()
  eq(table.concat(dlg:_widget("chatModel").options, ","), "Fable,Opus,Sonnet,Haiku")
  eq(dlg:_widget("chatModel").option, "Opus", "not the newest, slowest model")
  eq(dlg:_widget("settingsModel").option, "Opus")
  eq(dlg:_widget("chatEffort").option, "Balanced")
  truthy(env.headerText():find("Opus · Balanced", 1, true), env.headerText())
  env.conn.event(BRIDGE_INFO)
  eq(dlg:_widget("providerInfo").text, "Ready")
  eq(table.concat(dlg:_widget("chatModel").options, ","), "Opus,Sonnet")
  eq(table.concat(dlg:_widget("settingsModel").options, ","), "Opus,Sonnet")
  local providers = table.concat(dlg:_widget("settingsProvider").options, ",")
  eq(providers, "Claude Code,Gemini CLI,Codex CLI (not set up)")
  eq(table.concat(dlg:_widget("chatEffort").options, ","), "Fast,Balanced,Smart,Smart+,Max")
end)

test("the bridge's defaultModel is selected unless the user picked a model", function()
  local info = {
    event = "bridge_info", version = "2", defaultProvider = "claude-code",
    providers = { {
      id = "claude-code", label = "Claude Code", defaultModel = "opus",
      models = { { id = "fable", label = "Fable (newest)" }, { id = "opus", label = "Opus" }, { id = "haiku", label = "Haiku" } },
      efforts = { "low", "medium", "high" }, available = true, supportsImages = true,
    } },
  }
  local env = setup()
  local dlg = env.open()
  env.conn.event(info)
  eq(dlg:_widget("chatModel").option, "Opus")
  eq(dlg:_widget("settingsModel").option, "Opus")
  eq(dlg:_widget("chatEffort").option, "Balanced")
  eq(env.prefs.model, nil, "a default is not saved as the user's choice")

  local picked = setup({ model = "haiku" })
  picked.conn.event(info)
  eq(picked.open():_widget("chatModel").option, "Haiku", "saved choice kept")
end)

test("bridge_info received while closed is used when the window opens", function()
  local env = setup()
  env.conn.event(BRIDGE_INFO)
  local dlg = env.open()
  eq(table.concat(dlg:_widget("chatModel").options, ","), "Opus,Sonnet")
end)

-- Chat ------------------------------------------------------------------------------------

test("send chat: payload, echo, busy state and Enter target", function()
  closeAllSprites()
  local sprite = newSprite(40, 30)
  local env = setup()
  local dlg = env.open()
  env.conn.event(BRIDGE_INFO)
  dlg:_choose("chatModel", "Sonnet")
  dlg:_choose("chatEffort", "Smart")
  eq(dlg:_widget("settingsModel").option, "Sonnet", "settings follow the chat box")
  eq(dlg:_widget("settingsEffort").option, "Smart")
  dlg:_type("chatInput", "make the sword glow")
  truthy(dlg:_widget("chatSend").focusMagnet, "Send catches Enter")
  dlg:_click("chatSend")
  local p = env.conn.last()
  eq(p.event, "chat_send")
  eq(p.action, nil, "chat is the protocol default")
  eq(p.text, "make the sword glow")
  eq(p.options.provider, "claude-code")
  eq(p.options.model, "sonnet")
  eq(p.options.effort, "high")
  eq(p.sprite, sprite.id)
  eq(p.selection, nil, "nothing selected")
  eq(dlg:_widget("chatInput").text, "", "input cleared")
  eq(dlg.focused, "chatInput", "focus back in the input")
  eq(dlg:_widget("chatSend").enabled, false, "Send disabled while busy")
  eq(dlg:_widget("chatStop").enabled, true)
  eq(dlg:_widget("genGenerate").enabled, false)
  truthy(env.logText():find("You: make the sword glow"), "echo in the log")
  truthy(env.headerText():find("Sending"), "header shows sending")
  eq(env.prefs.model, "sonnet", "choice persisted")
  eq(env.prefs.effort, "high")
end)

test("chat events: tools collapse, progress, text, done, idle", function()
  closeAllSprites()
  newSprite()
  local env = setup()
  local dlg = env.open()
  dlg:_type("chatInput", "draw a cat")
  dlg:_click("chatSend")
  local timer = Fakes.timers[#Fakes.timers]
  truthy(timer and timer.isRunning, "timer runs while busy")
  env.conn.event({ event = "chat", kind = "busy", busy = true })
  env.conn.event({ event = "chat", kind = "tool", name = "draw_script" })
  env.conn.event({ event = "chat", kind = "tool", name = "draw_script" })
  env.conn.event({ event = "chat", kind = "tool", name = "view_sprite" })
  Fakes.advance(12)
  local header = env.headerText()
  truthy(header:find("Working 12s · view_sprite"), header)
  env.conn.event({ event = "chat", kind = "progress", done = 1, total = 4, label = "Variation" })
  env.conn.event({ event = "chat", kind = "progress", done = 2, total = 4, label = "Variation" })
  env.conn.event({ event = "chat", kind = "text", text = "Here is your cat — enjoy!" })
  env.conn.event({ event = "chat", kind = "done", stats = { durationMs = 23000, turns = 5, costUsd = 0.04 } })
  env.conn.event({ event = "chat", kind = "busy", busy = false })
  local text = env.logText()
  truthy(text:find("draw_script x2, view_sprite", 1, true), text)
  truthy(text:find("Variation 2/4"), "progress line")
  truthy(not text:find("Variation 1/4"), "progress updated in place")
  truthy(text:find("Here is your cat %- enjoy!"), "dash normalized")
  truthy(text:find("Done in 23s · 5 steps · $0.04", 1, true), "done line")
  eq(dlg:_widget("chatSend").enabled, true, "idle again")
  eq(timer.isRunning, false, "timer stops when idle")
  truthy(env.headerText():find("Done in 23s"), "header keeps the result")
end)

test("Show tool calls off hides tool lines but the header still names the tool", function()
  closeAllSprites()
  newSprite()
  local env = setup()
  local dlg = env.open()
  dlg:_click("settingsShowTools")
  eq(env.prefs.showTools, false)
  dlg:_type("chatInput", "x")
  dlg:_click("chatSend")
  env.conn.event({ event = "chat", kind = "busy", busy = true })
  env.conn.event({ event = "chat", kind = "tool", name = "write_pixels" })
  truthy(not env.logText():find("write_pixels"), "no tool line")
  truthy(env.headerText():find("write_pixels"), "header shows it")
end)

test("errors: empty message, offline bridge, rejected request", function()
  closeAllSprites()
  newSprite()
  local env = setup()
  local dlg = env.open()
  dlg:_type("chatInput", "   ")
  dlg:_click("chatSend")
  eq(#env.conn.sent, 0, "empty message not sent")
  -- Send is the Enter target and stray Enter keys reach it too: no error for those.
  truthy(not env.logText():find("You:"), "nothing echoed")
  truthy(env.logText():find("Ask the AI"), "log still empty")
  eq(dlg.focused, "chatInput")
  truthy(not dlg:_widget("genGenerate").focusMagnet, "Generate never catches Enter")
  truthy(not dlg:_widget("animRun").focusMagnet, "Animate never catches Enter")

  env.conn.setStatus("disconnected")
  dlg:_type("chatInput", "hello")
  dlg:_click("chatSend")
  eq(#env.conn.sent, 0)
  truthy(env.logText():find("not running"), "offline message")
  eq(dlg:_widget("chatInput").text, "hello", "text kept to retry")
  eq(dlg:_widget("chatSend").enabled, true, "not stuck busy")

  env.conn.setStatus("connected")
  dlg:_click("chatSend")
  eq(dlg:_widget("chatSend").enabled, false)
  env.conn.event({ event = "chat", kind = "error", text = "Invalid chat request" })
  eq(dlg:_widget("chatSend").enabled, true, "rejected before busy -> idle")
end)

test("no answer from the bridge times out instead of spinning forever", function()
  closeAllSprites()
  newSprite()
  local env = setup()
  local dlg = env.open()
  dlg:_type("chatInput", "hello")
  dlg:_click("chatSend")
  Fakes.advance(25)
  Fakes.tickAll()
  eq(dlg:_widget("chatSend").enabled, true)
  truthy(env.logText():find("No answer from the bridge"), "explains the timeout")
end)

test("Stop cancels, New chat resets, disconnect ends the run", function()
  closeAllSprites()
  newSprite()
  local env = setup()
  local dlg = env.open()
  dlg:_type("chatInput", "go")
  dlg:_click("chatSend")
  env.conn.event({ event = "chat", kind = "busy", busy = true })
  dlg:_click("chatStop")
  eq(env.conn.last().event, "chat_cancel")
  env.conn.event({ event = "chat", kind = "busy", busy = false })
  truthy(env.headerText():find("Stopped after"), "header says stopped")

  dlg:_click("chatNew")
  eq(env.conn.last().event, "chat_reset")
  env.conn.event({ event = "chat", kind = "status", text = "New conversation." })
  local text = env.logText()
  truthy(not text:find("You: go"), "history cleared")
  truthy(text:find("New conversation"), text)

  dlg:_type("chatInput", "again")
  dlg:_click("chatSend")
  env.conn.event({ event = "chat", kind = "busy", busy = true })
  env.conn.setStatus("disconnected")
  eq(dlg:_widget("chatSend").enabled, true, "not busy after disconnect")
  truthy(env.logText():find("Lost the connection"), "explains")
end)

test("quick actions: redraw selection, review and variations", function()
  closeAllSprites()
  local sprite = newSprite(16, 16)
  local env = setup()
  local dlg = env.open()
  dlg:_click("quickRedraw")
  eq(#env.conn.sent, 0, "no selection -> not sent")
  truthy(env.logText():find("Select an area"), "explains")

  sprite.selection = Selection(Rectangle(2, 3, 4, 5))
  dlg:_type("chatInput", "add moss")
  dlg:_click("quickRedraw")
  local p = env.conn.last()
  eq(p.action, "edit_selection")
  eq(p.selection.x, 2)
  eq(p.selection.height, 5)
  eq(p.text, "add moss")
  env.conn.event({ event = "chat", kind = "busy", busy = false })

  dlg:_click("quickReview")
  eq(env.conn.last().action, "review")
  eq(env.conn.last().selection.width, 4, "Use selection is on by default")
  env.conn.event({ event = "chat", kind = "busy", busy = false })

  dlg:_click("quickVariations")
  local v = env.conn.last()
  eq(v.action, "variations")
  eq(v.options.count, 3)
  eq(v.options.size.width, 32, "uses the Generate size")
end)

test("long history scrolls with fractional trackpad deltas and sticks to new messages", function()
  local env = setup()
  local dlg = env.open()
  for i = 1, 60 do
    env.conn.event({ event = "chat", kind = "text", text = "message number " .. i .. " with some words to wrap around" })
  end
  local text = env.logText()
  truthy(text:find("message number 60"), "newest visible")
  truthy(not text:find("message number 1 "), "oldest scrolled off")
  local log = dlg:_widget("log")
  for _ = 1, 7 do log.spec.onwheel({ deltaY = -0.37 }) end
  text = env.logText()
  truthy(text:find("more below"), "hint while reading older messages")
  -- New messages must not move what the user is reading.
  local before = text
  env.conn.event({ event = "chat", kind = "status", text = "late status" })
  eq(env.logText(), before, "view stays anchored")
  for _ = 1, 50 do log.spec.onwheel({ deltaY = 3 }) end
  text = env.logText()
  truthy(not text:find("more below"), "back at the bottom")
  truthy(text:find("late status"), "newest visible again")
end)

-- Generate / Animate ---------------------------------------------------------------------

test("generate tab sends every option and remembers them", function()
  closeAllSprites()
  local env = setup()
  local dlg = env.open("generate")
  eq(dlg.data.tabs, "tab_generate")
  dlg:_type("genPrompt", "a knight with a blue cape")
  dlg:_choose("genSize", "64x64")
  dlg:_choose("genStyle", "16-bit SNES")
  dlg:_choose("genPalette", "Endesga 32")
  dlg:_choose("genView", "3/4")
  dlg:_choose("genTarget", "New sprite")
  dlg:_click("genOutline")
  dlg:_click("genGenerate")
  local p = env.conn.last()
  eq(p.action, "generate")
  eq(p.text, "a knight with a blue cape")
  eq(p.options.size.width, 64)
  eq(p.options.style, "16bit")
  eq(p.options.palette, "endesga32")
  eq(p.options.view, "three_quarter")
  eq(p.options.target, "new_sprite")
  eq(p.options.outline, false, "toggled off")
  eq(p.options.background, "transparent")
  eq(p.sprite, nil, "no sprite open")
  eq(env.prefs.genPrompt, "a knight with a blue cape", "persisted")
  eq(env.prefs.genSize, "64")
  truthy(env.logText():find("Generate · 64x64 · 16-bit SNES · Endesga 32 · 3/4", 1, true), "echo")
  env.conn.event({ event = "chat", kind = "busy", busy = false })

  dlg:_choose("genVariations", "4")
  dlg:_click("genGenerate")
  eq(env.conn.last().action, "variations")
  eq(env.conn.last().options.count, 4)
  env.conn.event({ event = "chat", kind = "busy", busy = false })

  dlg:_click("genDir8")
  eq(env.conn.last().action, "directions")
  eq(env.conn.last().options.directions, 8)
  env.conn.event({ event = "chat", kind = "busy", busy = false })

  dlg:_type("genBatch", "sword; shield\npotion")
  dlg:_click("genBatchRun")
  local b = env.conn.last()
  eq(b.action, "batch")
  eq(#b.options.items, 3)
  eq(b.options.items[2], "shield")
end)

test("generate with Current canvas needs a sprite", function()
  closeAllSprites()
  local env = setup()
  local dlg = env.open("generate")
  dlg:_type("genPrompt", "tree")
  dlg:_choose("genSize", "Current canvas")
  dlg:_click("genGenerate")
  eq(#env.conn.sent, 0)
  truthy(env.logText():find("Current canvas"), "explains")
  newSprite(20, 10)
  dlg:_click("genGenerate")
  eq(env.conn.last().options.size.width, 20)
end)

test("animate tab: presets fill frames, timing and loop", function()
  closeAllSprites()
  local env = setup()
  local dlg = env.open("animate")
  dlg:_click("animRun")
  eq(#env.conn.sent, 0, "needs a sprite")
  local sprite = newSprite()
  dlg:_choose("animPreset", "Attack")
  eq(dlg:_widget("animFrames").value, 5)
  eq(dlg:_widget("animFrameMs").text, "90")
  eq(dlg:_widget("animLoop").selected, false)
  dlg:_slide("animFrames", 7)
  dlg:_type("animNotes", "sword trail")
  dlg:_click("animRun")
  local p = env.conn.last()
  eq(p.action, "animate")
  eq(p.text, "sword trail")
  eq(p.options.animation.preset, "attack")
  eq(p.options.animation.frames, 7)
  eq(p.options.animation.frameMs, 90)
  eq(p.options.animation.loop, false)
  eq(p.sprite, sprite.id)
end)

-- Tools --------------------------------------------------------------------------------------

test("tools send tool_run and show the result", function()
  closeAllSprites()
  local sprite = newSprite()
  local env = setup()
  local dlg = env.open("tools")
  eq(dlg:_widget("toolLayer").text, "Layer 1")
  eq(dlg:_widget("toolChoice").option, "Remove background", "default tool")
  dlg:_slide("toolTolerance", 30)
  dlg:_click("toolAllFrames")
  dlg:_click("toolApply")
  local p = env.conn.last()
  eq(p.event, "tool_run")
  eq(p.tool, "remove_background")
  eq(p.params.tolerance, 30)
  eq(p.params.frames, "all")
  eq(p.params.layer, "Layer 1")
  eq(p.params.selectionOnly, false)
  eq(p.sprite, sprite.id)
  truthy(dlg:_widget("toolStatus").text:find("Remove background"), "pending status")
  env.conn.event({ event = "tool_result", requestId = p.requestId, ok = true, text = "Removed 120 pixels" })
  eq(dlg:_widget("toolStatus").text, "Remove background: Removed 120 pixels")
  truthy(env.logText():find("Remove background: Removed 120 pixels"), "logged")

  dlg:_click("toolUndo")
  local u = env.conn.last()
  eq(u.tool, "undo")
  truthy(env.conn.lastRaw():find('"params": {'), "params encoded as an object")
  env.conn.event({ event = "tool_result", requestId = u.requestId, ok = false, text = "Nothing to undo" })
  truthy(env.logText():find("Undo: Nothing to undo"), "error logged")
end)

test("tools validate scope and nested layer paths", function()
  closeAllSprites()
  local sprite = newSprite()
  local group = sprite:newGroup()
  group.name = "Body"
  local inner = sprite:newLayer()
  inner.name = "Arm"
  inner.parent = group
  app.layer = inner
  local env = setup()
  local dlg = env.open("tools")
  dlg:_click("toolSelectionOnly")
  dlg:_click("toolFlipH")
  eq(#env.conn.sent, 0, "selection only without selection")
  truthy(dlg:_widget("toolStatus").text:find("Nothing is selected"), dlg:_widget("toolStatus").text)
  sprite.selection = Selection(Rectangle(0, 0, 4, 4))
  dlg:_click("toolFlipH")
  local p = env.conn.last()
  eq(p.params.layer, "Body/Arm", "group path")
  eq(p.params.selectionOnly, true)
  dlg:_choose("toolChoice", "Adjust colors")
  dlg:_click("toolApply")
  truthy(dlg:_widget("toolStatus").text:find("slider"), "adjust needs a slider")
  dlg:_slide("toolHue", 40)
  dlg:_click("toolApply")
  eq(env.conn.last().tool, "adjust_colors")
  eq(env.conn.last().params.hue, 40)
  dlg:_click("toolAdjustReset")
  eq(dlg:_widget("toolHue").value, 0)
  eq(env.prefs.toolHue, 0)
  local sent = #env.conn.sent
  app.layer = group
  dlg:_click("toolFlipH")
  eq(#env.conn.sent, sent, "group layer rejected before sending")
  truthy(dlg:_widget("toolStatus").text:find("is a group"), dlg:_widget("toolStatus").text)
end)

test("outline sends the picked color only for Pick color", function()
  closeAllSprites()
  newSprite()
  local env = setup()
  local dlg = env.open("tools")
  dlg:_choose("toolChoice", "Outline")
  eq(dlg:_widget("toolOutlineColor").visible, false, "no color to pick for Auto shade")
  dlg:_choose("toolOutlinePlacement", "Inside")
  dlg:_click("toolApply")
  eq(env.conn.last().tool, "add_outline")
  eq(env.conn.last().params.color, nil)
  eq(env.conn.last().params.placement, "inside")
  dlg:_choose("toolOutlineMode", "Pick color")
  eq(dlg:_widget("toolOutlineColor").visible, true, "color shown once it is used")
  dlg:_widget("toolOutlineColor").color = Color{ r = 255, g = 0, b = 128 }
  dlg:_click("toolApply")
  eq(env.conn.last().params.color, "#ff0080")
  eq(env.prefs.toolOutlineMode, "color", "remembered")
end)

-- Every setting the Tools tab can show; each tool shows its own, the rest are hidden.
local TOOL_PARAMS = {
  "toolTolerance", "toolOutlinePlacement", "toolOutlineMode", "toolOutlineColor", "toolColors",
  "toolPalette", "toolDither", "toolHue", "toolSaturation", "toolLightness", "toolAdjustReset",
}
local TOOL_PICKS = {
  { label = "Remove background", tool = "remove_background", shows = { "toolTolerance" } },
  { label = "Outline", tool = "add_outline", shows = { "toolOutlinePlacement", "toolOutlineMode" } },
  { label = "Reduce colors", tool = "reduce_colors", shows = { "toolColors", "toolDither" } },
  { label = "Apply palette", tool = "apply_palette", shows = { "toolPalette", "toolDither" } },
  { label = "Adjust colors", tool = nil, shows = { "toolHue", "toolSaturation", "toolLightness", "toolAdjustReset" } },
  { label = "Clean up stray pixels", tool = "cleanup_pixels", shows = {} },
  { label = "Drop shadow", tool = "drop_shadow", shows = {} },
}

test("the Tool picker shows only the picked tool's settings and Apply runs it", function()
  closeAllSprites()
  newSprite()
  local env = setup()
  local dlg = env.open("tools")
  eq(#dlg:_widget("toolChoice").options, #TOOL_PICKS, "every tool is in the picker")
  for _, pick in ipairs(TOOL_PICKS) do
    dlg:_choose("toolChoice", pick.label)
    local shown = {}
    for _, id in ipairs(pick.shows) do shown[id] = true end
    for _, id in ipairs(TOOL_PARAMS) do
      eq(dlg:_widget(id).visible, shown[id] == true, pick.label .. ": " .. id .. " visible")
    end
    -- The one-click buttons never hide.
    for _, id in ipairs({ "toolApply", "toolFlipH", "toolRotate", "toolShiftDown", "toolUndo", "toolRedo", "toolStatus" }) do
      eq(dlg:_widget(id).visible, true, pick.label .. ": " .. id)
    end
    local sent = #env.conn.sent
    dlg:_click("toolApply")
    if pick.tool then
      eq(env.conn.last().tool, pick.tool, pick.label .. " sends its tool")
    else
      eq(#env.conn.sent, sent, pick.label .. " needs a slider first")
    end
  end
  -- The choice survives closing the window.
  dlg:_choose("toolChoice", "Reduce colors")
  env.window.close()
  local again = env.open()
  eq(again:_widget("toolChoice").option, "Reduce colors")
  eq(again:_widget("toolColors").visible, true)
  eq(again:_widget("toolTolerance").visible, false, "hidden before the first show")
end)

test("unanswered tool calls time out", function()
  closeAllSprites()
  newSprite()
  local env = setup()
  local dlg = env.open("tools")
  dlg:_click("toolFlipV")
  Fakes.advance(60)
  Fakes.tickAll()
  truthy(dlg:_widget("toolStatus").text:find("no answer"), dlg:_widget("toolStatus").text)
end)

-- Layout -----------------------------------------------------------------------------------------

-- The window must fit a 13" laptop at 200% UI scale (about 440 px tall): the tallest tab
-- page gets about nine short rows. Rows follow Aseprite's rules (see tests/ui_fakes.lua).
test("compact layout: pairs share rows and no tab page is taller than nine rows", function()
  local env = setup()
  local dlg = env.open()
  local function sameRow(a, b) eq(dlg:_widget(a).row, dlg:_widget(b).row, a .. " and " .. b .. " share a row") end
  sameRow("genSize", "genStyle")
  sameRow("genPalette", "genView")
  sameRow("genTarget", "genVariations")
  sameRow("genOutline", "genTransparent")
  sameRow("genGenerate", "genDir8")
  sameRow("toolSelectionOnly", "toolAllFrames")
  sameRow("toolOutlinePlacement", "toolOutlineMode")
  sameRow("toolHue", "toolLightness")
  sameRow("toolApply", "toolAdjustReset")
  sameRow("toolFlipH", "toolRotate")
  sameRow("toolShiftLeft", "toolRedo")
  sameRow("settingsModel", "settingsEffort")
  sameRow("settingsAutoReview", "settingsShowTools")
  truthy(dlg:_widget("genPrompt").row < dlg:_widget("genSize").row, "prompt comes first")

  eq(#dlg:_rows("tab_chat"), 6, "chat rows")
  eq(#dlg:_rows("tab_generate"), 8, "generate rows")
  eq(#dlg:_rows("tab_animate"), 6, "animate rows")
  eq(#dlg:_rows("tab_settings"), 9, "settings rows (four are one-line labels)")
  for _, pick in ipairs(TOOL_PICKS) do
    dlg:_choose("toolChoice", pick.label)
    truthy(#dlg:_rows("tab_tools") <= 9, pick.label .. ": " .. #dlg:_rows("tab_tools") .. " rows")
  end
  dlg:_choose("toolChoice", "Outline")
  dlg:_choose("toolOutlineMode", "Pick color")
  eq(#dlg:_rows("tab_tools"), 9, "outline with a color: the tallest tools page")

  -- Tab pages don't hide canvases, so every canvas sits above the tabs.
  for _, w in ipairs(dlg.widgets) do
    if w.kind == "canvas" then eq(w.tab, nil, "canvas " .. tostring(w.id) .. " outside the tab pages") end
  end
  eq(dlg:_widget("header").spec.height, 30)
  eq(dlg:_widget("log").spec.height, 130)
  eq(dlg:_widget("log").spec.vexpand, true, "a taller window grows the log")
end)

-- Settings ---------------------------------------------------------------------------------------

test("provider change refills models and disables effort when unsupported", function()
  local env = setup()
  env.conn.event(BRIDGE_INFO)
  local dlg = env.open("settings")
  dlg:_choose("settingsProvider", "Gemini CLI")
  eq(env.prefs.provider, "gemini-cli")
  eq(table.concat(dlg:_widget("settingsModel").options, ","), "Default")
  eq(dlg:_widget("settingsEffort").enabled, false)
  eq(dlg:_widget("chatEffort").enabled, false)
  dlg:_choose("settingsProvider", "Codex CLI (not set up)")
  eq(dlg:_widget("chatModel").option, "GPT-5")
  eq(dlg:_widget("providerInfo").text, "Not set up: Install the Codex CLI.")
  truthy(env.logText():find("not set up"), "explains")
  dlg:_choose("settingsProvider", "Claude Code")
  eq(dlg:_widget("settingsEffort").enabled, true)
  eq(dlg:_widget("chatModel").option, "Opus")
end)

test("unavailable provider blocks AI actions with its note", function()
  closeAllSprites()
  newSprite()
  local env = setup({ provider = "codex" })
  env.conn.event(BRIDGE_INFO)
  local dlg = env.open()
  dlg:_type("chatInput", "hi")
  dlg:_click("chatSend")
  eq(#env.conn.sent, 0)
  truthy(env.logText():find("Install the Codex CLI"), "shows the note")
end)

test("reconnect stores a valid port and calls main.lua", function()
  local env = setup()
  local dlg = env.open("settings")
  dlg:_type("settingsPort", "7911")
  dlg:_click("settingsReconnect")
  eq(env.prefs.port, 7911)
  eq(env.reconnects(), 1)
  dlg:_type("settingsPort", "99999")
  dlg:_click("settingsReconnect")
  eq(env.prefs.port, 65535, "clamped")
  eq(dlg:_widget("settingsPort").text, "65535", "shown clamped")
end)

-- Lifecycle -----------------------------------------------------------------------------------------

test("closing saves bounds and choices; reopening restores tab and history", function()
  closeAllSprites()
  newSprite()
  local env = setup()
  local dlg = env.open()
  dlg:_type("chatInput", "remember me")
  dlg:_click("chatSend")
  env.conn.event({ event = "chat", kind = "busy", busy = false })
  dlg:_tab("tab_tools")
  eq(env.prefs.tab, "tools")
  dlg._bounds = Rectangle(30, 40, 500, 600)
  env.window.close()
  eq(env.window.isOpen(), false)
  eq(env.prefs.ui_x, 30)
  eq(env.prefs.ui_h, 600)
  local again = env.open()
  truthy(again ~= dlg, "new dialog")
  eq(again.data.tabs, "tab_tools", "reopens on the last tab")
  truthy(env.logText():find("remember me"), "history kept")
end)

test("events while closed don't fail and show up later", function()
  local env = setup()
  env.conn.event({ event = "chat", kind = "text", text = "background hello" })
  env.conn.event({ event = "tool_result", requestId = "x", ok = true, text = "ok" })
  env.conn.setStatus("disconnected")
  env.open()
  truthy(env.logText():find("background hello"), "kept")
end)

test("menu commands open on a tab and switch tabs of an open window", function()
  local env = setup()
  local dlg = env.open("generate")
  dlg:_click("genOutline") -- unsaved widget state must survive the switch
  env.window.open("tools")
  eq(dlg.data.tabs, "tab_tools")
  eq(dlg:_widget("genOutline").selected, false, "data round trip kept the check")
  eq(dlg:_widget("chatSend").selected, false, "buttons not left pressed")
  eq(env.prefs.tab, "tools")
end)

-- Dev hook ----------------------------------------------------------------------------------------------

test("ui_debug is ignored unless devMode is on", function()
  local env = setup()
  local before = #Fakes.instances
  env.conn.event({ event = "ui_debug", action = "open", tab = "tools" })
  eq(#Fakes.instances, before, "no window opened")
  eq(#env.conn.sent, 0, "no reply")
end)

test("ui_debug drives the window in devMode", function()
  closeAllSprites()
  newSprite()
  local env = setup({ devMode = true })
  env.conn.event({ event = "ui_debug", action = "open", tab = "generate" })
  local dlg = Fakes.instances[#Fakes.instances]
  eq(env.conn.last().event, "ui_debug_result")
  eq(env.conn.last().ok, true)
  eq(dlg.data.tabs, "tab_generate")
  env.conn.event({ event = "ui_debug", action = "set", id = "genPrompt", value = "a slime" })
  env.conn.event({ event = "ui_debug", action = "set", id = "genPalette", value = "pico8" })
  env.conn.event({ event = "ui_debug", action = "set", id = "genSize", value = "16x16" })
  env.conn.event({ event = "ui_debug", action = "click", id = "genGenerate" })
  local p
  for i = #env.conn.sent, 1, -1 do
    local m = json.decode(env.conn.sent[i])
    if m.event == "chat_send" then
      p = m
      break
    end
  end
  truthy(p, "chat_send sent")
  eq(p.text, "a slime")
  eq(p.options.palette, "pico8")
  eq(p.options.size.width, 16)
  env.conn.event({ event = "ui_debug", action = "tab", tab = "tools" })
  env.conn.event({ event = "ui_debug", action = "set", id = "toolChoice", value = "drop_shadow" })
  eq(env.conn.last().ok, true)
  eq(dlg:_widget("toolTolerance").visible, false, "set runs the picker's change handler")
  env.conn.event({ event = "ui_debug", action = "click", id = "toolApply" })
  local shadow
  for i = #env.conn.sent, 1, -1 do
    local m = json.decode(env.conn.sent[i])
    if m.event == "tool_run" then
      shadow = m
      break
    end
  end
  truthy(shadow, "tool_run sent")
  eq(shadow.tool, "drop_shadow")
  env.conn.event({ event = "ui_debug", action = "tab", tab = "settings" })
  eq(dlg.data.tabs, "tab_settings")
  env.conn.event({ event = "ui_debug", action = "set", id = "settingsProvider", value = "claude-code" })
  eq(env.conn.last().ok, true)
  env.conn.event({ event = "ui_debug", action = "click", id = "nope" })
  eq(env.conn.last().ok, false)
  truthy(env.conn.last().error:find("No button"), env.conn.last().error)
  env.conn.event({ event = "ui_debug", action = "close" })
  eq(env.window.isOpen(), false)
end)

test("rebuilds the dialog when combobox options can't be replaced", function()
  local env = setup()
  local dlg = env.open()
  -- Simulate an Aseprite whose modify{} ignores "options".
  local original = dlg.modify
  rawset(dlg, "modify", function(self, spec)
    local s = {}
    for k, v in pairs(spec) do
      if k ~= "options" then s[k] = v end
    end
    return original(self, s)
  end)
  local before = #Fakes.instances
  -- Labels the built-in list doesn't have, so the stale options can't match by chance.
  env.conn.event({
    event = "bridge_info", version = "2", defaultProvider = "claude-code",
    providers = { {
      id = "claude-code", label = "Claude Code", models = { { id = "opus", label = "Opus 5" } },
      efforts = { "low", "high" }, available = true, supportsImages = true,
    } },
  })
  Fakes.tickAll() -- runs the deferred rebuild
  truthy(#Fakes.instances > before, "a new dialog was built")
  local fresh = Fakes.instances[#Fakes.instances]
  eq(table.concat(fresh:_widget("chatModel").options, ","), "Opus 5")
  eq(dlg.closed, true, "old dialog closed")
end)

restore()
closeAllSprites()
print(string.format("%d passed, %d failed", passed, failed))
-- os.exit is disabled in Aseprite's Lua; an error makes the run fail instead.
if failed > 0 then error(failed .. " window test(s) failed", 0) end
