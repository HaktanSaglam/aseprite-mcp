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

-- Every open sprite, not just the active one: after closing a sprite in the background
-- app.sprite can be nil while others are still open.
local function closeAllSprites()
  while #app.sprites > 0 do app.sprites[1]:close() end
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
  -- Parallel jobs: the label is the job that just finished.
  env.conn.event({ event = "chat", kind = "progress", done = 1, total = 4, label = "Variation 2" })
  env.conn.event({ event = "chat", kind = "text", text = "Variation 2: a ginger cat." })
  env.conn.event({ event = "chat", kind = "progress", done = 2, total = 4, label = "Variation 1" })
  truthy(env.headerText():find("Working 12s · 2/4 done", 1, true), env.headerText())
  env.conn.event({ event = "chat", kind = "text", text = "Here is your cat — enjoy!" })
  env.conn.event({ event = "chat", kind = "done", stats = { durationMs = 23000, turns = 5, costUsd = 0.04 } })
  env.conn.event({ event = "chat", kind = "busy", busy = false })
  local text = env.logText()
  truthy(text:find("draw_script x2, view_sprite", 1, true), text)
  truthy(text:find("2/4 done · Variation 1", 1, true), "progress line: " .. text)
  truthy(not text:find("1/4 done"), "one progress line, updated")
  truthy(text:find("a ginger cat.\n2/4 done", 1, true), "progress stays below the replies: " .. text)
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
  local offline = env.logText()
  truthy(offline:find("Can't reach the bridge on port 7801"), "offline message names the port: " .. offline)
  truthy(offline:find("npm start"), "and how to start it")
  truthy(offline:find("doctor"), "and what to run if that's not it")
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

-- Run state machine ------------------------------------------------------------------------

local function chatSends(conn)
  local n = 0
  for _, raw in ipairs(conn.sent) do
    if json.decode(raw).event == "chat_send" then n = n + 1 end
  end
  return n
end

test("Enter (the Send button) does nothing outside the Chat tab", function()
  closeAllSprites()
  newSprite()
  local env = setup()
  local dlg = env.open()
  dlg:_type("chatInput", "left over")
  dlg:_tab("tab_generate")
  dlg.focused = nil
  -- Enter in Generate's Prompt reaches the dialog's Enter target: chatSend.
  dlg:_click("chatSend")
  eq(chatSends(env.conn), 0, "the hidden message is not sent")
  eq(dlg.focused, nil, "focus stays in the Generate tab")
  dlg:_tab("tab_chat")
  eq(dlg.focused, "chatInput", "back on Chat the box gets focus")
  dlg:_click("chatSend")
  eq(chatSends(env.conn), 1)
end)

test("opening on another tab doesn't focus the hidden message box", function()
  local env = setup()
  local dlg = env.open("generate")
  eq(dlg.focused, nil)
end)

test("a socket that is still retrying counts as offline", function()
  closeAllSprites()
  newSprite()
  local env = setup()
  local dlg = env.open()
  env.conn.setStatus("disconnected")
  env.conn.online = true -- like connection.lua: the WebSocket object exists while it retries
  dlg:_type("chatInput", "hello")
  dlg:_click("chatSend")
  eq(#env.conn.sent, 0, "not sent into a closed socket")
  eq(dlg:_widget("chatSend").enabled, true, "no 'Sending...' until the timeout")
  truthy(env.logText():find("Can't reach the bridge"), "says so right away")
  dlg:_tab("tab_tools")
  dlg:_click("toolFlipH")
  eq(#env.conn.sent, 0)
  truthy(dlg:_widget("toolStatus").text:find("offline"), dlg:_widget("toolStatus").text)
end)

test("Stop before the bridge confirmed: no flicker, ends with the bridge", function()
  closeAllSprites()
  newSprite()
  local env = setup()
  local dlg = env.open()
  dlg:_type("chatInput", "draw")
  dlg:_click("chatSend")
  dlg:_click("chatStop")
  eq(env.conn.last().event, "chat_cancel")
  eq(dlg:_widget("chatSend").enabled, false, "still busy until the bridge answers")
  truthy(env.headerText():find("Stopping"), env.headerText())
  env.conn.event({ event = "chat", kind = "busy", busy = true })
  eq(dlg:_widget("chatSend").enabled, false)
  env.conn.event({ event = "chat", kind = "status", text = "Stopped." })
  env.conn.event({ event = "chat", kind = "busy", busy = false })
  eq(dlg:_widget("chatSend").enabled, true)
  eq(dlg:_widget("chatStop").enabled, false)
  truthy(env.headerText():find("Stopped after"), env.headerText())
  eq(dlg.focused, "chatInput")
end)

test("Stop that the bridge never confirms ends after a while, or at once when pressed again", function()
  closeAllSprites()
  newSprite()
  local env = setup()
  local dlg = env.open()
  local timer = nil
  dlg:_type("chatInput", "one")
  dlg:_click("chatSend")
  env.conn.event({ event = "chat", kind = "busy", busy = true })
  dlg:_click("chatStop")
  timer = Fakes.timers[#Fakes.timers]
  Fakes.advance(9)
  Fakes.tickAll()
  eq(dlg:_widget("chatSend").enabled, true, "gave up waiting")
  eq(timer.isRunning, false, "spinner stopped")
  truthy(env.logText():find("did not confirm"), env.logText())

  dlg:_type("chatInput", "two")
  dlg:_click("chatSend")
  env.conn.event({ event = "chat", kind = "busy", busy = true })
  dlg:_click("chatStop")
  dlg:_click("chatStop")
  eq(dlg:_widget("chatSend").enabled, true, "second Stop ends it here")
end)

test("New chat during a run cancels it and reports it as stopped", function()
  closeAllSprites()
  newSprite()
  local env = setup()
  local dlg = env.open()
  dlg:_type("chatInput", "draw")
  dlg:_click("chatSend")
  env.conn.event({ event = "chat", kind = "busy", busy = true })
  env.conn.event({ event = "chat", kind = "tool", name = "draw_script" })
  dlg:_click("chatNew")
  dlg:_click("chatNew") -- double click
  eq(env.conn.last().event, "chat_reset")
  eq(dlg:_widget("chatStop").enabled, true, "the run is still winding down")
  env.conn.event({ event = "chat", kind = "status", text = "New conversation." })
  env.conn.event({ event = "chat", kind = "status", text = "New conversation." })
  env.conn.event({ event = "chat", kind = "status", text = "Stopped." })
  env.conn.event({ event = "chat", kind = "busy", busy = false })
  local text = env.logText()
  truthy(not text:find("draw_script"), "history cleared")
  local _, count = text:gsub("New conversation", "")
  eq(count, 1, "said once: " .. text)
  truthy(env.headerText():find("Stopped after"), env.headerText())
  eq(dlg:_widget("chatSend").enabled, true)
end)

test("bridge restart mid-run: busy clears, buttons and spinner follow, info refreshes quietly", function()
  closeAllSprites()
  newSprite()
  local env = setup()
  local dlg = env.open()
  env.conn.event(BRIDGE_INFO)
  dlg:_type("chatInput", "draw")
  dlg:_click("chatSend")
  env.conn.event({ event = "chat", kind = "busy", busy = true })
  local timer = Fakes.timers[#Fakes.timers]
  env.conn.setStatus("error: connection refused")
  eq(dlg:_widget("chatSend").enabled, true)
  eq(dlg:_widget("chatStop").enabled, false)
  eq(timer.isRunning, false)
  truthy(env.logText():find("Lost the connection"), "explains")
  env.conn.setStatus("connected")
  local before = dlg.modifyCount
  env.conn.event(BRIDGE_INFO) -- every reconnect sends it again
  eq(dlg.modifyCount, before, "nothing changed, nothing is refilled or relaid out")
  eq(dlg:_widget("chatModel").option, "Opus")
  truthy(env.headerText():find("Lost the connection"), "the header keeps the outcome")
end)

test("tool_run during an AI run: the bridge's refusal shows, the AI run carries on", function()
  closeAllSprites()
  newSprite()
  local env = setup()
  local dlg = env.open()
  dlg:_type("chatInput", "draw")
  dlg:_click("chatSend")
  env.conn.event({ event = "chat", kind = "busy", busy = true })
  dlg:_tab("tab_tools")
  dlg:_click("toolFlipH")
  local p = env.conn.last()
  eq(p.event, "tool_run", "the bridge decides")
  env.conn.event({ event = "tool_result", requestId = p.requestId, ok = false,
    text = "The AI is still working on this sprite. Wait for it or press Stop." })
  truthy(dlg:_widget("toolStatus").text:find("Flip horizontal: The AI is still working"), dlg:_widget("toolStatus").text)
  truthy(env.logText():find("Wait for it"), "full text in the log")
  eq(dlg:_widget("chatSend").enabled, false, "the AI run is still going")
  truthy(env.headerText():find("Working"), env.headerText())
  env.conn.event({ event = "chat", kind = "done", stats = { durationMs = 4000 } })
  env.conn.event({ event = "chat", kind = "busy", busy = false })
  truthy(env.headerText():find("Done in 4s"), "the run's own outcome")
end)

test("closing and reopening mid-run restores the run state", function()
  closeAllSprites()
  newSprite()
  local env = setup()
  local dlg = env.open()
  dlg:_type("chatInput", "draw")
  dlg:_click("chatSend")
  env.conn.event({ event = "chat", kind = "busy", busy = true })
  env.conn.event({ event = "chat", kind = "progress", done = 1, total = 3, label = "sword" })
  local timer = Fakes.timers[#Fakes.timers]
  env.window.close()
  eq(timer.isRunning, false, "no ticking for a closed window")
  env.conn.event({ event = "chat", kind = "progress", done = 2, total = 3, label = "shield" })
  local again = env.open()
  eq(again:_widget("chatSend").enabled, false, "Send disabled")
  eq(again:_widget("quickReview").enabled, false)
  eq(again:_widget("chatStop").enabled, true, "Stop available")
  eq(timer.isRunning, true, "spinner runs again")
  truthy(env.headerText():find("2/3 done"), env.headerText())
  again:_click("chatStop")
  eq(env.conn.last().event, "chat_cancel")
end)

test("the spinner doesn't rewrite the buttons on every tick", function()
  closeAllSprites()
  newSprite()
  local env = setup()
  local dlg = env.open()
  dlg:_type("chatInput", "draw")
  dlg:_click("chatSend")
  env.conn.event({ event = "chat", kind = "busy", busy = true })
  local before = dlg.modifyCount
  for _ = 1, 5 do Fakes.tickAll() end
  eq(dlg.modifyCount, before, "ticks only repaint")
end)

test("a close that fails halfway still lets the window open again", function()
  closeAllSprites()
  newSprite()
  local env = setup()
  local dlg = env.open()
  dlg:_type("chatInput", "x")
  dlg:_click("chatSend")
  local timer = Fakes.timers[#Fakes.timers]
  timer.stop = function() error("timer already gone") end
  env.window.close()
  eq(env.window.isOpen(), false)
  local again = env.open()
  truthy(again ~= dlg, "a fresh window")
  eq(again.shown, true)
end)

test("a message being typed survives closing the window", function()
  local env = setup()
  local dlg = env.open()
  dlg:_type("chatInput", "half a thought")
  env.window.close()
  local again = env.open()
  eq(again:_widget("chatInput").text, "half a thought")
end)

test("stale or unknown prefs fall back to the defaults", function()
  closeAllSprites()
  newSprite()
  local env = setup({
    provider = "removed-provider", model = "claude-2", effort = "turbo", tab = "history",
    genSize = "999", genStyle = "vaporwave", toolChoice = "laser", ui_x = "left",
  })
  local dlg = env.open()
  eq(dlg.data.tabs, "tab_chat")
  eq(dlg:_widget("chatModel").option, "Opus")
  eq(dlg:_widget("chatEffort").option, "Balanced")
  eq(dlg:_widget("settingsProvider").option, "Claude Code")
  eq(dlg:_widget("genSize").option, "32x32")
  eq(dlg:_widget("genStyle").option, "Auto")
  eq(dlg:_widget("toolChoice").option, "Remove background")
  dlg:_type("chatInput", "hi")
  dlg:_click("chatSend")
  local p = env.conn.last()
  eq(p.options.provider, "claude-code")
  eq(p.options.model, "opus")
  eq(p.options.effort, "medium")
end)

test("a provider without models greys out the model boxes", function()
  local env = setup({ provider = "gemini-cli" })
  env.conn.event(BRIDGE_INFO)
  local dlg = env.open("settings")
  eq(dlg:_widget("chatModel").enabled, false)
  eq(dlg:_widget("settingsModel").enabled, false)
  dlg:_choose("settingsProvider", "Claude Code")
  eq(dlg:_widget("chatModel").enabled, true)
end)

test("Enter pressed again while working says so once", function()
  closeAllSprites()
  newSprite()
  local env = setup()
  local dlg = env.open()
  dlg:_type("chatInput", "first")
  dlg:_click("chatSend")
  dlg:_type("chatInput", "second")
  -- A disabled Send can still be the Enter target: call its handler directly.
  dlg:_widget("chatSend").spec.onclick()
  dlg:_widget("chatSend").spec.onclick()
  local _, count = env.logText():gsub("Still working", "")
  eq(count, 1)
  eq(dlg:_widget("chatInput").text, "second", "kept for later")
end)

test("hundreds of messages: capped, newest visible", function()
  local env = setup()
  env.open()
  for i = 1, 450 do
    env.conn.event({ event = "chat", kind = "text", text = "reply " .. i })
  end
  local text = env.logText()
  truthy(text:find("reply 450"), "newest visible")
  env.conn.event({ event = "chat", kind = "status", text = "x" })
  truthy(env.logText():find("x"), "still painting")
end)

test("clicking 'more below' in the log jumps to the newest message", function()
  local env = setup()
  local dlg = env.open()
  for i = 1, 40 do env.conn.event({ event = "chat", kind = "text", text = "line " .. i }) end
  local log = dlg:_widget("log")
  log.spec.onwheel({ deltaY = -5 })
  truthy(env.logText():find("more below"), "scrolled up")
  log.spec.onmousedown({ x = 300, y = 118 })
  local text = env.logText()
  truthy(not text:find("more below"), text)
  truthy(text:find("line 40"), "newest visible")
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
  "toolNormColors", "toolNormCleanup", "toolImportFile",
}
-- tool = nil: Apply needs input first (a slider moved, a file picked).
local TOOL_PICKS = {
  { label = "Remove background", tool = "remove_background", shows = { "toolTolerance" } },
  { label = "Outline", tool = "add_outline", shows = { "toolOutlinePlacement", "toolOutlineMode" } },
  { label = "Reduce colors", tool = "reduce_colors", shows = { "toolColors", "toolDither" } },
  { label = "Apply palette", tool = "apply_palette", shows = { "toolPalette", "toolDither" } },
  { label = "Adjust colors", tool = nil, shows = { "toolHue", "toolSaturation", "toolLightness", "toolAdjustReset" } },
  { label = "Clean up stray pixels", tool = "cleanup_pixels", shows = {} },
  { label = "Drop shadow", tool = "drop_shadow", shows = {} },
  { label = "Normalize (unzoom)", tool = "normalize_pixel_art", shows = { "toolNormColors", "toolNormCleanup" } },
  { label = "Import PNG...", tool = nil, shows = { "toolImportFile" } },
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
      eq(#env.conn.sent, sent, pick.label .. " needs input first")
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

-- v1.1 ---------------------------------------------------------------------------------------

-- The newest message of one kind ("chat_send", "tool_run", ...) the window sent.
local function lastSent(env, event)
  for i = #env.conn.sent, 1, -1 do
    local m = json.decode(env.conn.sent[i])
    if m.event == event then return m end
  end
  return nil
end

local function finishRun(env, stats)
  env.conn.event({ event = "chat", kind = "busy", busy = true })
  if stats then env.conn.event({ event = "chat", kind = "done", stats = stats }) end
  env.conn.event({ event = "chat", kind = "busy", busy = false })
end

test("generate: Custom palette row, color limit, Force palette and Seamless tile", function()
  closeAllSprites()
  newSprite()
  local env = setup()
  local dlg = env.open("generate")
  eq(dlg:_widget("genCustomPalette").visible, false, "no Custom row until Custom is picked")
  eq(dlg:_widget("genForcePalette").enabled, false, "nothing to force with palette Auto")
  dlg:_type("genPrompt", "a slime")
  dlg:_choose("genPalette", "Custom")
  eq(dlg:_widget("genCustomPalette").visible, true)
  eq(dlg:_widget("genForcePalette").enabled, true)
  eq(dlg:_widget("genCustomPalette").spec.placeholder, "#rrggbb, #rrggbb, ...")
  dlg:_type("genCustomPalette", "#000000, slime green")
  dlg:_click("genGenerate")
  eq(lastSent(env, "chat_send"), nil, "not sent with a bad color")
  truthy(env.logText():find('"slime" is not a color'), env.logText())
  eq(dlg:_widget("genGenerate").enabled, true, "not stuck busy")

  dlg:_type("genCustomPalette", "#000000, #ffffff, #ff0044")
  dlg:_choose("genColors", "Max 8")
  dlg:_click("genForcePalette")
  dlg:_choose("genView", "Seamless tile")
  dlg:_click("genGenerate")
  local p = lastSent(env, "chat_send")
  eq(p.options.palette, "custom")
  eq(p.options.customPalette[2], "#ffffff")
  eq(p.options.maxColors, 8)
  eq(p.options.forcePalette, true)
  eq(p.options.view, "tile")
  truthy(env.logText():find("Custom (forced) · max 8 colors · Seamless tile", 1, true), env.logText())
  eq(env.prefs.genCustomPalette, "#000000, #ffffff, #ff0044", "remembered")
  finishRun(env)

  dlg:_choose("genPalette", "Auto")
  eq(dlg:_widget("genCustomPalette").visible, false)
  eq(dlg:_widget("genForcePalette").enabled, false)
  dlg:_click("genGenerate")
  eq(lastSent(env, "chat_send").options.forcePalette, nil, "a greyed-out tick isn't sent")
end)

test("generate: Reference lists the open sprites, follows them and sends the sprite id", function()
  closeAllSprites()
  local knight = newSprite(16, 16)
  knight.filename = "knight.aseprite"
  local other = newSprite(16, 16)
  other.filename = "other.aseprite"
  local env = setup()
  local dlg = env.open("generate")
  eq(table.concat(dlg:_widget("genReference").options, ","), "None,knight.aseprite,other.aseprite")
  eq(dlg:_widget("genReference").option, "None")
  dlg:_type("genPrompt", "a matching shield")
  dlg:_click("genGenerate")
  eq(lastSent(env, "chat_send").options.reference, nil, "None: nothing sent")
  finishRun(env)

  dlg:_choose("genReference", "knight.aseprite")
  dlg:_click("genGenerate")
  local p = lastSent(env, "chat_send")
  eq(p.options.reference.sprite, knight.id)
  truthy(env.logText():find("with reference", 1, true), env.logText())
  eq(env.prefs.genReference, nil, "not a saved setting")
  finishRun(env)

  -- A sprite opened later shows up when the tab opens again.
  local third = newSprite(8, 8)
  third.filename = "other.aseprite"
  dlg:_tab("tab_chat")
  dlg:_tab("tab_generate")
  local options = dlg:_widget("genReference").options
  eq(#options, 4)
  eq(options[3], "other.aseprite")
  eq(options[4], "other.aseprite #" .. third.id, "repeated names stay apart")
  eq(dlg:_widget("genReference").option, "knight.aseprite", "the choice survives a refresh")

  -- Closing the picked sprite (a site change) leaves None picked, never a stale id.
  knight:close()
  app.sprite = other
  dlg:_tab("tab_chat")
  dlg:_tab("tab_generate")
  eq(dlg:_widget("genReference").option, "None")
  eq(table.concat(dlg:_widget("genReference").options, ","), "None,other.aseprite,other.aseprite #" .. third.id)
  dlg:_click("genGenerate")
  eq(lastSent(env, "chat_send").options.reference, nil)
end)

test("generate: Source Current sprite turns the open sprite into 4/8 directions", function()
  closeAllSprites()
  local sprite = newSprite(48, 40)
  local env = setup()
  local dlg = env.open("generate")
  eq(dlg:_widget("genSource").option, "Prompt")
  dlg:_choose("genSource", "Current sprite")
  dlg:_click("genDir4")
  local p = lastSent(env, "chat_send")
  eq(p.action, "directions")
  eq(p.options.source, "current")
  eq(p.options.size.width, 48)
  eq(p.options.size.height, 40)
  eq(p.sprite, sprite.id)
  eq(p.text, "", "no prompt needed")
  finishRun(env)
  dlg:_choose("genVariations", "2")
  dlg:_click("genGenerate")
  eq(lastSent(env, "chat_send").action, "variations")
  eq(lastSent(env, "chat_send").options.source, "current")
end)

test("generate settings are remembered per sprite and come back when its Generate tab opens", function()
  closeAllSprites()
  local a = newSprite(16, 16)
  a.filename = "knight.aseprite"
  local env = setup()
  local dlg = env.open("generate")
  dlg:_type("genPrompt", "a knight")
  dlg:_choose("genStyle", "PICO-8")
  dlg:_click("genGenerate")
  finishRun(env)
  eq(a.properties("aseprite-mcp").generate.genPrompt, "a knight", "stored in the sprite")
  eq(a.isModified, false, "storing them is no edit")

  local b = newSprite(16, 16)
  dlg:_tab("tab_chat")
  dlg:_tab("tab_generate")
  eq(dlg:_widget("genPrompt").text, "a knight", "a sprite without settings keeps the current ones")
  dlg:_type("genPrompt", "a tree")
  dlg:_choose("genStyle", "1-bit")
  dlg:_click("genGenerate")
  finishRun(env)

  app.sprite = a
  dlg:_tab("tab_chat")
  dlg:_tab("tab_generate")
  eq(dlg:_widget("genPrompt").text, "a knight", "restored")
  eq(dlg:_widget("genStyle").option, "PICO-8")
  eq(env.prefs.genStyle, "pico8")
  truthy(env.logText():find("loaded the settings last used with knight.aseprite", 1, true), env.logText())

  -- Coming back to the same sprite keeps what the user typed since.
  dlg:_type("genPrompt", "a knight with a sword")
  dlg:_tab("tab_chat")
  dlg:_tab("tab_generate")
  eq(dlg:_widget("genPrompt").text, "a knight with a sword")

  -- Opening the window on Generate counts as opening the tab.
  app.sprite = b
  env.window.close()
  local again = env.open("generate")
  eq(again:_widget("genPrompt").text, "a tree")
  eq(again:_widget("genStyle").option, "1-bit")
end)

test("animate: All directions needs direction tags; each mode shows its frame numbers", function()
  closeAllSprites()
  local sprite = newSprite(16, 16)
  sprite:newFrame()
  sprite:newFrame()
  local env = setup()
  local dlg = env.open("animate")
  eq(dlg:_widget("animAllDirections").enabled, false, "no direction tags")
  local tag = sprite:newTag(1, 1)
  tag.name = "down"
  local right = sprite:newTag(2, 2)
  right.name = "right"
  dlg:_tab("tab_chat")
  dlg:_tab("tab_animate")
  eq(dlg:_widget("animAllDirections").enabled, true)
  dlg:_click("animAllDirections")
  eq(dlg:_widget("animMode").enabled, false, "Mode stays New while All directions applies")
  dlg:_click("animRun")
  local p = lastSent(env, "chat_send")
  eq(p.options.animation.allDirections, true)
  eq(p.options.animation.mode, nil, "New is the v1.0 behaviour")
  finishRun(env)
  dlg:_click("animAllDirections")
  eq(dlg:_widget("animMode").enabled, true, "free again once unticked")

  eq(dlg:_widget("animFrom").visible, false)
  eq(dlg:_widget("animKeep").visible, false)
  dlg:_choose("animMode", "Between frames")
  eq(dlg:_widget("animFrom").visible, true)
  eq(dlg:_widget("animTo").visible, true)
  eq(dlg:_widget("animKeep").visible, false)
  dlg:_type("animFrom", "2")
  dlg:_type("animTo", "3")
  dlg:_slide("animFrames", 4)
  dlg:_click("animRun")
  local b = lastSent(env, "chat_send")
  eq(b.options.animation.mode, "between")
  eq(b.options.animation.fromFrame, 2)
  eq(b.options.animation.toFrame, 3)
  eq(b.options.animation.frames, 4)
  finishRun(env)

  dlg:_type("animTo", "9")
  dlg:_click("animRun")
  truthy(env.logText():find("has 3 frames"), env.logText())
  -- Key frames with frames between them: those would end up amid the in-betweens.
  local sent = #env.conn.sent
  dlg:_type("animFrom", "1")
  dlg:_type("animTo", "3")
  dlg:_click("animRun")
  eq(#env.conn.sent, sent, "refused before the bridge has to")
  -- The log wraps long lines; compare the message as one line.
  local flat = env.logText():gsub("\n", " ")
  truthy(flat:find('set "To" to 2 ("From" + 1), or From 3 (the last frame) and To 1 for a loop', 1, true), flat)
  dlg:_type("animFrom", "3")
  dlg:_type("animTo", "1")
  dlg:_click("animRun")
  local loop = lastSent(env, "chat_send")
  eq(loop.options.animation.fromFrame, 3, "the loop wrap: last frame to frame 1")
  eq(loop.options.animation.toFrame, 1)
  finishRun(env)

  dlg:_choose("animMode", "Continue")
  eq(dlg:_widget("animFrom").visible, false)
  eq(dlg:_widget("animKeep").visible, true)
  dlg:_type("animKeep", "2")
  dlg:_click("animRun")
  local c = lastSent(env, "chat_send")
  eq(c.options.animation.mode, "continue")
  eq(c.options.animation.keepFrames, 2)
  eq(env.prefs.animMode, "continue", "remembered")
  finishRun(env)

  -- Another sprite without tags greys it out again and nothing is sent for it.
  dlg:_choose("animMode", "New")
  dlg:_click("animAllDirections")
  newSprite(8, 8)
  dlg:_tab("tab_chat")
  dlg:_tab("tab_animate")
  eq(dlg:_widget("animAllDirections").enabled, false)
  eq(dlg:_widget("animAllDirections").selected, true, "the tick is left over")
  eq(dlg:_widget("animMode").enabled, true, "but it doesn't apply here")
  dlg:_click("animRun")
  eq(lastSent(env, "chat_send").options.animation.allDirections, nil)
end)

-- The bridge refuses All directions with in-betweens or continuing; the window doesn't
-- let the two be combined in the first place.
test("All directions and Between/Continue exclude each other: the last choice wins", function()
  closeAllSprites()
  local sprite = newSprite(16, 16)
  sprite:newFrame()
  local tag = sprite:newTag(1, 1)
  tag.name = "down"
  local env = setup()
  local dlg = env.open("animate")
  dlg:_choose("animMode", "Between frames")
  eq(dlg:_widget("animFrom").visible, true)
  dlg:_click("animAllDirections")
  eq(dlg:_widget("animMode").option, "New", "ticking All directions sets Mode back to New")
  eq(env.prefs.animMode, "new")
  eq(dlg:_widget("animFrom").visible, false, "no From / To for New")
  eq(dlg:_widget("animMode").enabled, false, "greyed out while All directions applies")
  dlg:_click("animRun")
  local p = lastSent(env, "chat_send")
  eq(p.options.animation.allDirections, true)
  eq(p.options.animation.mode, nil)
  finishRun(env)

  -- On a sprite without direction tags Mode is free; picking another mode there clears
  -- the leftover tick, so coming back can't combine the two.
  local other = newSprite(8, 8)
  dlg:_tab("tab_chat")
  dlg:_tab("tab_animate")
  eq(dlg:_widget("animMode").enabled, true)
  dlg:_choose("animMode", "Continue")
  eq(dlg:_widget("animAllDirections").selected, false, "picking Continue cleared the tick")
  eq(env.prefs.animAllDirections, false)
  app.sprite = sprite
  dlg:_tab("tab_chat")
  dlg:_tab("tab_animate")
  eq(dlg:_widget("animMode").enabled, true)
  dlg:_type("animKeep", "1")
  dlg:_click("animRun")
  local c = lastSent(env, "chat_send")
  eq(c.options.animation.mode, "continue")
  eq(c.options.animation.allDirections, nil)
  finishRun(env)
  other:close()
end)

-- What the bridge's RPC calls do to a sprite while a run draws: one transaction each.
local function aiSteps(sprite, n)
  for _ = 1, n do app.transaction("AI: draw", function() sprite:newLayer() end) end
end

-- A run that adds `steps` undo steps to `sprite` and reports them like the bridge does.
-- during(), if given, runs while the AI draws (e.g. the user's own edit).
local function drawingRun(env, sprite, steps, reported, during)
  env.conn.event({ event = "chat", kind = "busy", busy = true })
  aiSteps(sprite, steps)
  if during then during() end
  env.conn.event({
    event = "chat", kind = "done",
    stats = { durationMs = 1000, undoSteps = reported and reported.undoSteps or steps, sprite = reported and reported.sprite or sprite.id },
  })
  env.conn.event({ event = "chat", kind = "busy", busy = false })
end

test("Undo AI run takes back exactly the last run, only while its sprite is untouched", function()
  closeAllSprites()
  local a = newSprite(16, 16)
  local env = setup()
  local dlg = env.open()
  eq(dlg:_widget("quickUndoRun").enabled, false, "nothing to undo yet")
  dlg:_type("chatInput", "draw a cat")
  dlg:_click("chatSend")
  env.conn.event({ event = "chat", kind = "busy", busy = true })
  aiSteps(a, 3)
  eq(dlg:_widget("quickUndoRun").enabled, false, "not during a run")
  env.conn.event({ event = "chat", kind = "done", stats = { durationMs = 1000, undoSteps = 3, sprite = a.id } })
  env.conn.event({ event = "chat", kind = "busy", busy = false })
  eq(dlg:_widget("quickUndoRun").enabled, true, "the run reported its steps")

  -- Only for the sprite the run drew into.
  local b = newSprite(8, 8)
  dlg:_tab("tab_tools")
  dlg:_tab("tab_chat")
  eq(dlg:_widget("quickUndoRun").enabled, false, "another sprite is active")
  app.sprite = a
  dlg:_tab("tab_tools")
  dlg:_tab("tab_chat")
  eq(dlg:_widget("quickUndoRun").enabled, true)

  dlg:_click("quickUndoRun")
  local u = lastSent(env, "tool_run")
  eq(u.tool, "undo")
  eq(u.params.steps, 3)
  eq(u.sprite, a.id)
  truthy(env.conn.lastRaw():find('"params": {"steps": 3}', 1, true), env.conn.lastRaw())
  eq(dlg:_widget("quickUndoRun").enabled, false, "once")
  env.conn.event({ event = "tool_result", requestId = u.requestId, ok = true, text = "Undid 3 steps" })
  truthy(env.logText():find("Undo AI run: Undid 3 steps", 1, true), env.logText())

  -- Any other change to the sprite withdraws the offer: undoing 2 steps now would undo
  -- the user's own work.
  dlg:_type("chatInput", "add a hat")
  dlg:_click("chatSend")
  drawingRun(env, a, 2)
  eq(dlg:_widget("quickUndoRun").enabled, true)
  app.transaction(function() a:newLayer() end)
  eq(dlg:_widget("quickUndoRun").enabled, false, "the user changed the sprite")
  local before = #env.conn.sent
  dlg:_widget("quickUndoRun").spec.onclick() -- e.g. through the dev hook
  eq(#env.conn.sent, before, "nothing sent")
  truthy(env.logText():find("nothing to undo"), env.logText())

  -- A run that made a new sprite isn't offered: its steps aren't on this sprite.
  dlg:_tab("tab_generate")
  dlg:_type("genPrompt", "a tree")
  dlg:_click("genGenerate")
  finishRun(env, { durationMs = 1000, undoSteps = 5 })
  dlg:_tab("tab_chat")
  eq(dlg:_widget("quickUndoRun").enabled, false, "new sprite")
  b:close()
end)

-- The run's sprite is watched from the moment the request is sent: a stroke the user
-- made while the AI worked would otherwise be inside "the last N steps".
test("Undo AI run is not offered when the sprite also changed another way during the run", function()
  closeAllSprites()
  local a = newSprite(16, 16)
  local env = setup()
  local dlg = env.open()
  local function send(text)
    dlg:_type("chatInput", text)
    dlg:_click("chatSend")
  end
  local function offered()
    dlg:_tab("tab_tools")
    dlg:_tab("tab_chat")
    return dlg:_widget("quickUndoRun").enabled
  end

  send("draw a cat")
  drawingRun(env, a, 3, nil, function() app.transaction(function() a:newLayer() end) end)
  eq(offered(), false, "undo 3 would take the user's new layer")

  send("add a hat")
  drawingRun(env, a, 2, nil, function() app.command.Undo() end)
  eq(offered(), false, "a Ctrl+Z during the run")

  -- The bridge names the sprite its steps belong to; another one than the request's is
  -- not offered on either (that one wasn't watched while the run drew).
  local b = newSprite(8, 8)
  app.sprite = a
  send("and a scarf")
  drawingRun(env, a, 1, { undoSteps = 1, sprite = b.id })
  eq(offered(), false, "not on the request's sprite")
  app.sprite = b
  eq(offered(), false, "nor on the one named")

  app.sprite = a
  send("and boots")
  drawingRun(env, a, 2)
  eq(offered(), true, "untouched: offered")
  dlg:_click("quickUndoRun")
  eq(lastSent(env, "tool_run").params.steps, 2)
  b:close()
end)

test("Repeat last resends the last request, never while a run is going", function()
  closeAllSprites()
  local sprite = newSprite(16, 16)
  local env = setup()
  local dlg = env.open()
  dlg:_click("quickRepeat")
  eq(lastSent(env, "chat_send"), nil)
  truthy(env.logText():find("Nothing to repeat yet"), env.logText())

  dlg:_type("chatInput", "make it blue")
  dlg:_click("chatSend")
  eq(dlg:_widget("quickRepeat").enabled, false, "disabled while working")
  dlg:_widget("quickRepeat").spec.onclick()
  truthy(env.logText():find("Still working"), "refused while busy")
  eq(chatSends(env.conn), 1)
  finishRun(env)

  dlg:_click("quickRepeat")
  eq(chatSends(env.conn), 2)
  local p = lastSent(env, "chat_send")
  eq(p.text, "make it blue")
  eq(p.sprite, sprite.id)
  truthy(env.logText():find("You: Repeat: make it blue", 1, true), env.logText())
  truthy(env.prefs.lastRequest:find("make it blue", 1, true), "stored in the prefs")
  finishRun(env)

  -- A reference is only repeated within the session that picked it.
  dlg:_tab("tab_generate")
  dlg:_type("genPrompt", "a shield")
  dlg:_choose("genReference", dlg:_widget("genReference").options[2])
  dlg:_click("genGenerate")
  eq(lastSent(env, "chat_send").options.reference.sprite, sprite.id)
  finishRun(env)
  dlg:_tab("tab_chat")
  dlg:_click("quickRepeat")
  eq(lastSent(env, "chat_send").options.reference.sprite, sprite.id, "same session: kept")
  finishRun(env)
  env.window.close()

  -- Aseprite restarted: a new window module (its own session) reads the same prefs.
  env.prefs.lastRequestSession = "an-earlier-session"
  local restarted = setup(env.prefs)
  local dlg2 = restarted.open()
  dlg2:_click("quickRepeat")
  local again = lastSent(restarted, "chat_send")
  eq(again.text, "a shield", "survives a restart through the prefs")
  eq(again.options.reference, nil, "but not the sprite id of the old session")
end)

test("Repeat last checks an animation like the Animate tab, against the sprite open now", function()
  closeAllSprites()
  local knight = newSprite(16, 16)
  knight:newFrame()
  knight:newFrame()
  local down = knight:newTag(1, 1)
  down.name = "down"
  local env = setup()
  local dlg = env.open("animate")
  dlg:_click("animAllDirections")
  dlg:_click("animRun")
  eq(lastSent(env, "chat_send").options.animation.allDirections, true)
  finishRun(env)

  local plain = newSprite(8, 8)
  dlg:_tab("tab_chat")
  local sent = chatSends(env.conn)
  dlg:_click("quickRepeat")
  eq(chatSends(env.conn), sent, "not sent as a one-direction animation")
  truthy(env.logText():find("All directions needs a sprite with direction tags", 1, true), env.logText())

  app.sprite = knight
  dlg:_tab("tab_animate")
  dlg:_click("animAllDirections")
  dlg:_choose("animMode", "Between frames")
  dlg:_type("animFrom", "2")
  dlg:_type("animTo", "3")
  dlg:_click("animRun")
  eq(lastSent(env, "chat_send").options.animation.toFrame, 3)
  finishRun(env)
  app.sprite = plain
  dlg:_tab("tab_chat")
  sent = chatSends(env.conn)
  dlg:_click("quickRepeat")
  eq(chatSends(env.conn), sent, "frame 3 doesn't exist on a one-frame sprite")
  truthy(env.logText():find("Between frames needs two key frames, and this sprite has 1 frame.", 1, true), env.logText())
  app.sprite = knight
  dlg:_click("quickRepeat")
  eq(chatSends(env.conn), sent + 1, "fine on the sprite it fits")
  eq(lastSent(env, "chat_send").sprite, knight.id)
  finishRun(env)
  plain:close()
end)

test("tools: Normalize (unzoom) and Import PNG", function()
  closeAllSprites()
  local sprite = newSprite(16, 16)
  local env = setup()
  local dlg = env.open("tools")
  dlg:_choose("toolChoice", "Normalize (unzoom)")
  eq(dlg:_widget("toolNormCleanup").selected, true, "cleanup on by default")
  dlg:_choose("toolNormColors", "Max 16")
  dlg:_click("toolApply")
  local n = lastSent(env, "tool_run")
  eq(n.tool, "normalize_pixel_art")
  eq(n.params.maxColors, 16)
  eq(n.params.cleanup, true)
  eq(n.params.layer, "Layer 1")
  eq(n.params.frames, "current")

  dlg:_choose("toolChoice", "Import PNG...")
  eq(dlg:_widget("toolImportFile").visible, true)
  eq(dlg:_widget("toolImportFile").spec.filetypes[1], "png")
  eq(dlg:_widget("toolImportFile").spec.open, true)
  local sent = #env.conn.sent
  dlg:_click("toolApply")
  eq(#env.conn.sent, sent, "no file yet")
  truthy(dlg:_widget("toolStatus").text:find("Choose a PNG file"), dlg:_widget("toolStatus").text)
  dlg:_pickFile("toolImportFile", "/art/hero.png")
  eq(#env.conn.sent, sent, "picking only chooses the file")
  dlg:_click("toolApply")
  local i = lastSent(env, "tool_run")
  eq(i.tool, "import_image")
  eq(i.params.path, "/art/hero.png")
  eq(i.params.layer, nil, "the bridge makes a fresh layer per import")
  eq(i.params.frames, nil)
  eq(i.sprite, sprite.id)
  eq(env.prefs.toolImportPath, "/art/hero.png", "remembered")
  dlg:_click("toolApply")
  eq(#env.conn.sent, sent + 2, "the same file can be imported again")
  env.window.close()
  local again = env.open("tools")
  eq(again:_widget("toolImportFile").filename, "/art/hero.png")
end)

test("ui_debug reaches every v1.1 widget", function()
  closeAllSprites()
  local sprite = newSprite(16, 16)
  local env = setup({ devMode = true })
  local function debug(msg)
    msg.event = "ui_debug"
    env.conn.event(msg)
    local r = env.conn.last()
    eq(r.event, "ui_debug_result", msg.action)
    eq(r.ok, true, tostring(msg.widget) .. ": " .. tostring(r.error))
  end
  debug({ action = "open", tab = "generate" })
  env.dlg = Fakes.instances[#Fakes.instances]
  debug({ action = "set", widget = "genPrompt", value = "a gem" })
  debug({ action = "set", widget = "genPalette", value = "custom" })
  debug({ action = "set", widget = "genCustomPalette", value = "#000000, #ffffff" })
  debug({ action = "set", widget = "genColors", value = 16 })
  debug({ action = "set", widget = "genForcePalette", value = true })
  debug({ action = "set", widget = "genSource", value = "current" })
  debug({ action = "set", widget = "genReference", value = sprite.id })
  debug({ action = "set", widget = "genView", value = "tile" })
  debug({ action = "click", widget = "genGenerate" })
  local g = lastSent(env, "chat_send")
  eq(g.options.maxColors, 16)
  eq(g.options.forcePalette, true)
  eq(g.options.customPalette[1], "#000000")
  eq(g.options.reference.sprite, sprite.id)
  eq(g.options.view, "tile")
  finishRun(env)

  debug({ action = "tab", tab = "animate" })
  debug({ action = "set", widget = "animAllDirections", value = true })
  debug({ action = "set", widget = "animMode", value = "between" })
  eq(env.prefs.animAllDirections, false, "set runs the same exclusion as a click")
  debug({ action = "set", widget = "animFrom", value = 1 })
  debug({ action = "set", widget = "animTo", value = 1 })
  debug({ action = "click", widget = "animRun" })
  truthy(env.logText():find("needs two key frames"), "validated like a click")

  debug({ action = "tab", tab = "tools" })
  debug({ action = "set", widget = "toolChoice", value = "import_image" })
  debug({ action = "set", widget = "toolImportFile", value = "/art/a.png" })
  debug({ action = "click", widget = "toolApply" })
  eq(lastSent(env, "tool_run").params.path, "/art/a.png")
  debug({ action = "set", widget = "toolChoice", value = "normalize_pixel_art" })
  debug({ action = "set", widget = "toolNormColors", value = "8" })
  debug({ action = "set", widget = "toolNormCleanup", value = false })
  debug({ action = "click", widget = "toolApply" })
  eq(lastSent(env, "tool_run").params.maxColors, 8)
  eq(lastSent(env, "tool_run").params.cleanup, false)

  debug({ action = "tab", tab = "chat" })
  debug({ action = "click", widget = "quickRepeat" })
  eq(lastSent(env, "chat_send").text, "a gem")
  finishRun(env)
  debug({ action = "click", widget = "quickUndoRun" })
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
  sameRow("genPalette", "genColors")
  sameRow("genPalette", "genView")
  sameRow("genSource", "genReference")
  sameRow("genTarget", "genVariations")
  sameRow("genOutline", "genTransparent")
  sameRow("genOutline", "genForcePalette")
  sameRow("genGenerate", "genDir8")
  sameRow("genGenerate", "genBatchRun")
  sameRow("animPreset", "animMode")
  sameRow("animFrom", "animTo")
  sameRow("animLoop", "animAllDirections")
  sameRow("quickRepeat", "quickUndoRun")
  sameRow("toolSelectionOnly", "toolAllFrames")
  sameRow("toolOutlinePlacement", "toolOutlineMode")
  sameRow("toolHue", "toolLightness")
  sameRow("toolApply", "toolAdjustReset")
  sameRow("toolFlipH", "toolRotate")
  sameRow("toolShiftLeft", "toolRedo")
  sameRow("settingsModel", "settingsEffort")
  sameRow("settingsAutoReview", "settingsShowTools")
  truthy(dlg:_widget("genPrompt").row < dlg:_widget("genSize").row, "prompt comes first")
  truthy(dlg:_widget("genCustomPalette").row == dlg:_widget("genPalette").row + 1, "custom colors right under the palette")
  truthy(dlg:_widget("genBatch").row < dlg:_widget("genBatchRun").row, "batch list above its button")
  truthy(dlg:_widget("quickRepeat").row > dlg:_widget("quickVariations").row, "repeat/undo below the quick actions")

  eq(#dlg:_rows("tab_chat"), 7, "chat rows")
  eq(#dlg:_rows("tab_generate"), 8, "generate rows")
  dlg:_choose("genPalette", "Custom")
  eq(#dlg:_rows("tab_generate"), 9, "generate with the Custom palette row: the tallest page")
  dlg:_choose("genPalette", "Auto")
  eq(#dlg:_rows("tab_animate"), 6, "animate rows")
  dlg:_choose("animMode", "Between frames")
  eq(#dlg:_rows("tab_animate"), 7, "animate with From / To")
  dlg:_choose("animMode", "Continue")
  eq(#dlg:_rows("tab_animate"), 7, "animate with Keep frames")
  eq(#dlg:_rows("tab_settings"), 9, "settings rows (four are one-line labels)")
  for _, pick in ipairs(TOOL_PICKS) do
    dlg:_choose("toolChoice", pick.label)
    truthy(#dlg:_rows("tab_tools") <= 9, pick.label .. ": " .. #dlg:_rows("tab_tools") .. " rows")
  end
  dlg:_choose("toolChoice", "Normalize (unzoom)")
  eq(#dlg:_rows("tab_tools"), 9, "normalize: two settings rows")
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

test("ui_debug names widgets with 'widget' and can send a chat message", function()
  closeAllSprites()
  newSprite()
  local env = setup({ devMode = true })
  env.conn.event({ event = "ui_debug", action = "open", tab = "chat" })
  env.conn.event({ event = "ui_debug", action = "set", widget = "chatInput", value = "hello from a script" })
  eq(env.conn.last().ok, true)
  env.conn.event({ event = "ui_debug", action = "click", widget = "chatSend" })
  local p
  for i = #env.conn.sent, 1, -1 do
    local m = json.decode(env.conn.sent[i])
    if m.event == "chat_send" then
      p = m
      break
    end
  end
  truthy(p, "chat_send sent")
  eq(p.text, "hello from a script")
  eq(env.conn.last().event, "ui_debug_result")
  eq(env.conn.last().ok, true)
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
  dlg:_type("chatInput", "typed before the rebuild")
  local before = #Fakes.instances
  -- Labels the built-in list doesn't have, so the stale options can't match by chance.
  local info = {
    event = "bridge_info", version = "2", defaultProvider = "claude-code",
    providers = { {
      id = "claude-code", label = "Claude Code", models = { { id = "opus", label = "Opus 5" } },
      efforts = { "low", "high" }, available = true, supportsImages = true,
    } },
  }
  env.conn.event(info)
  env.conn.event(info) -- e.g. availability changed right after the hello
  Fakes.tickAll() -- runs the deferred rebuild
  eq(#Fakes.instances, before + 1, "rebuilt once")
  local fresh = Fakes.instances[#Fakes.instances]
  eq(table.concat(fresh:_widget("chatModel").options, ","), "Opus 5")
  eq(dlg.closed, true, "old dialog closed")
  eq(fresh:_widget("chatInput").text, "typed before the rebuild", "the draft survives")
end)

restore()
closeAllSprites()
print(string.format("%d passed, %d failed", passed, failed))
-- os.exit is disabled in Aseprite's Lua; an error makes the run fail instead.
if failed > 0 then error(failed .. " window test(s) failed", 0) end
