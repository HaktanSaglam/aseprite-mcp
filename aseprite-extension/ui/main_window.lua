-- The "Aseprite MCP" window: one non-modal dialog with Chat, Generate, Animate, Tools
-- and Settings tabs under a live status header.
--
-- This file wires things together: it builds the dialog (tab layouts in ui/tabs/),
-- turns button presses into protocol messages (ui/requests.lua), feeds bridge events
-- into the session state (ui/session.lua) and mirrors that state into widgets. It
-- listens to the bridge for the whole Aseprite session: bridge_info and chat events
-- also arrive while the window is closed, and the history survives closing it.
--
-- ctx (from main.lua): {connection, prefs, load, version, reconnect?}

return function(ctx)
  local load, connection, prefs = ctx.load, ctx.connection, ctx.prefs

  local textRender = load("ui/text_render.lua")
  local C = load("ui/catalog.lua")
  local S = load("ui/settings.lua")(C)
  local P = load("ui/providers.lua")(C)
  local R = load("ui/requests.lua")(C)
  local F = load("ui/format.lua")
  local W = load("ui/wrap.lua")
  local LL = load("ui/log_layout.lua")(W)
  local T = load("ui/theme.lua")
  local ChatLog = load("ui/chat_log.lua")
  local Session = load("ui/session.lua")(F)
  local Debug = load("ui/debug_hook.lua")
  local Form = load("ui/form.lua")(C, S)
  local LogView = load("ui/log_view.lua")(textRender, LL)
  local Header = load("ui/header_view.lua")(textRender, W)
  local Panels = load("ui/panels.lua")(T, F, Header)

  local TABS = {
    { id = "chat", text = "Chat", build = load("ui/tabs/chat_tab.lua") },
    { id = "generate", text = "Generate", build = load("ui/tabs/generate_tab.lua") },
    { id = "animate", text = "Animate", build = load("ui/tabs/animate_tab.lua") },
    { id = "tools", text = "Tools", build = load("ui/tabs/tools_tab.lua") },
    { id = "settings", text = "Settings", build = load("ui/tabs/settings_tab.lua") },
  }

  -- Spinner speed; also how often "Working 12s" is refreshed.
  local TICK_SECONDS = 0.15

  -- Default chat log height. The window must fit a 13" laptop at 200% UI scale (about
  -- 440 px tall in all): header + log + tab bar + the tallest tab page stay under 400.
  -- The log is vexpand, so making the window taller grows the log.
  local LOG_HEIGHT = 130

  -- Native labels don't wrap or clip nicely; long provider notes go to the chat log.
  local PROVIDER_INFO_CHARS = 52

  -- Buttons that start an AI run; disabled while one is running.
  local RUN_BUTTONS = {
    "chatSend", "quickRedraw", "quickReview", "quickVariations",
    "genGenerate", "genDir4", "genDir8", "genBatchRun", "animRun",
  }

  local NOT_RUNNING = "The bridge is not running. Start it with: npm start (in the bridge folder)."

  local M = {}

  local providers = P.new()
  local log = ChatLog.new(textRender.normalize)
  local logView = LogView.new(log)
  local session = Session.new(log, function() return os.time() end,
    function() return S.get(prefs, "showTools") end)
  local phase = 0
  local dlg, form = nil, nil
  local timer = nil
  local siteListener = nil
  local shownLayer, shownSprite, shownToolText = nil, nil, nil
  local lastError = nil

  local function validTab(tab)
    for _, t in ipairs(TABS) do
      if t.id == tab then return true end
    end
    return false
  end

  -- Errors inside our own UI callbacks end up here instead of Aseprite's console.
  local function reportError(message)
    message = "UI error: " .. tostring(message)
    if message == lastError then return end
    lastError = message
    log:add("error", message)
  end

  -- AI choice --------------------------------------------------------------------

  local function resolvedAI()
    return P.resolve(providers, {
      provider = S.get(prefs, "provider"),
      model = S.get(prefs, "model"),
      effort = S.get(prefs, "effort"),
    })
  end

  local function aiSummary()
    local sel = resolvedAI()
    return F.ai(
      sel.provider.label,
      sel.model and P.modelLabel(sel.provider, sel.model) or nil,
      sel.effort and C.effortLabel(sel.effort) or nil)
  end

  -- One line under the provider box: ready, not set up, or still the built-in list.
  local function providerInfo()
    local line = Panels.providerLines(resolvedAI().provider, providers.fromBridge)[1]
    return F.truncate(textRender.forWidget(line and line.text or ""), PROVIDER_INFO_CHARS)
  end

  -- Active sprite ----------------------------------------------------------------

  -- "Group/Layer" path of the active layer. Walks the tree because a top-level layer's
  -- parent is the Sprite, and reading .isGroup on a Sprite raises an error.
  local function layerPath(sprite, layer)
    local found
    local function walk(layers, prefix)
      for _, l in ipairs(layers) do
        if found then return end
        local path = prefix and (prefix .. "/" .. l.name) or l.name
        if l == layer then
          found = path
          return
        end
        if l.isGroup then walk(l.layers, path) end
      end
    end
    walk(sprite.layers, nil)
    return found or layer.name
  end

  local function spriteContext()
    local ok, result = pcall(function()
      local c = {}
      local sprite = app.sprite
      if not sprite then return c end
      c.sprite = { id = sprite.id, width = sprite.width, height = sprite.height }
      local selection = sprite.selection
      if selection and not selection.isEmpty then
        local b = selection.bounds
        c.selection = { x = b.x, y = b.y, width = b.width, height = b.height }
      end
      local layer = app.layer
      if layer then
        c.layer = layerPath(sprite, layer)
        c.layerIsGroup = layer.isGroup
      end
      return c
    end)
    return ok and result or {}
  end

  -- Shown in a native label, hence forWidget (layer names can contain anything).
  local function layerName()
    local ok, name = pcall(function()
      if not app.sprite then return "(no sprite open)" end
      local layer = app.layer
      if not layer then return "(no layer)" end
      if layer.isGroup then return layer.name .. " (group)" end
      return layer.name
    end)
    return textRender.forWidget(ok and name or "(unknown)")
  end

  -- Mirroring state into the dialog ----------------------------------------------------

  local function repaint()
    if dlg then pcall(function() dlg:repaint() end) end
  end

  local tick

  local function syncTimer()
    if not dlg then return end
    if session:needsTimer() then
      if not timer then
        local ok, t = pcall(function()
          return Timer{ interval = TICK_SECONDS, ontick = function() pcall(tick) end }
        end)
        if ok then timer = t end
      end
      if timer and not timer.isRunning then timer:start() end
    elseif timer and timer.isRunning then
      timer:stop()
    end
  end

  local function stopTimer()
    if timer and timer.isRunning then timer:stop() end
  end

  -- Copies the session state into widgets; called after anything changed it.
  local function sync()
    if form then
      for _, id in ipairs(RUN_BUTTONS) do form:enable(id, not session.busy) end
      form:enable("chatStop", session.busy)
      if session.toolText ~= shownToolText then
        shownToolText = session.toolText
        form:setText("toolStatus", F.truncate(textRender.forWidget(shownToolText or ""), 56))
      end
    end
    syncTimer()
    repaint()
  end

  tick = function()
    phase = (phase + 1) % 8
    session:tick()
    sync()
  end

  local function paintHeader(ev)
    Panels.paintHeader(ev.context, Panels.headerModel(session, connection.status, aiSummary(), app.sprite ~= nil, phase))
  end

  -- Aseprite versions that can't replace combobox options get a fresh dialog instead.
  local scheduleRebuild

  -- Refills the provider/model/effort boxes after the provider list or choice changed.
  local function refreshAI()
    if not form then return end
    local sel = resolvedAI()
    local models, efforts = P.modelOptions(sel.provider), P.effortOptions(sel.provider)
    local ok = form:setOptions("settingsProvider", P.providerOptions(providers), sel.provider.id)
    ok = form:setOptions("settingsModel", models, sel.model) and ok
    ok = form:setOptions("chatModel", models, sel.model) and ok
    ok = form:setOptions("settingsEffort", efforts, sel.effort) and ok
    ok = form:setOptions("chatEffort", efforts, sel.effort) and ok
    local hasEfforts = #sel.provider.efforts > 0
    form:enable("settingsEffort", hasEfforts)
    form:enable("chatEffort", hasEfforts)
    form:setText("providerInfo", providerInfo())
    if not ok then scheduleRebuild() end
    repaint()
  end

  -- Bridge events ----------------------------------------------------------------

  local debugView

  connection.subscribe(function(kind, payload)
    local ok, err = pcall(function()
      if kind == "status" then
        if payload ~= "connected" then session:disconnected() end
        return sync()
      end
      if kind ~= "event" or payload == nil then return end
      local event = payload.event
      if event == "chat" then
        if session:chatEvent(payload) then sync() end
      elseif event == "tool_result" then
        session:toolResult(payload)
        sync()
      elseif event == "bridge_info" then
        if P.update(providers, payload) then refreshAI() end
        repaint()
      elseif event == "ui_debug" then
        local result = Debug.handle(payload, prefs, debugView)
        if result then connection.send(result) end
      end
    end)
    if not ok then reportError(err) end
  end)

  -- Actions ----------------------------------------------------------------------

  local function fail(message)
    session:fail(message)
    logView:toBottom()
    sync()
  end

  local function focusChat(clear)
    if not dlg then return end
    form:quietly(function()
      if clear then dlg:modify{ id = "chatInput", text = "" } end
      dlg:modify{ id = "chatInput", focus = true }
    end)
  end

  -- build(settings, ai, spriteContext) -> payload | nil, error (see ui/requests.lua).
  local function startRun(build)
    if not form then return nil end
    if session.busy then
      fail("Still working. Press Stop to cancel the current run.")
      return nil
    end
    form:pull()
    local payload, err = build(S.snapshot(prefs), resolvedAI(), spriteContext())
    if not payload then
      fail(err)
      return nil
    end
    if not connection.send(payload) then
      fail(NOT_RUNNING)
      return nil
    end
    lastError = nil
    session:sent(R.describe(payload))
    logView:toBottom()
    sync()
    return payload
  end

  local handlers = {}

  handlers.paintLog = function(ev) logView:paint(ev.context, Panels.colors()) end
  handlers.wheelLog = function(ev)
    logView:wheel(ev)
    repaint()
  end
  handlers.providerInfo = providerInfo
  handlers.helpLines = function() return Panels.HELP end

  handlers.providerOptions = function() return P.providerOptions(providers) end
  handlers.modelOptions = function() return P.modelOptions(resolvedAI().provider) end
  handlers.effortOptions = function() return P.effortOptions(resolvedAI().provider) end
  handlers.selectedProvider = function() return resolvedAI().provider.id end
  handlers.selectedModel = function() return resolvedAI().model end
  handlers.selectedEffort = function() return resolvedAI().effort end
  handlers.layerName = function()
    shownLayer = layerName()
    return F.truncate(shownLayer, 40)
  end

  handlers.sendChat = function()
    local text = form:value("chatInput") or ""
    -- Send is the Enter target, and Enter also arrives from outside the window: with
    -- nothing typed there is nothing to say, so stay quiet.
    if not text:find("%S") then return focusChat(false) end
    local sent = startRun(function(s, ai, c) return R.chat(text, s, ai, c) end)
    focusChat(sent ~= nil)
  end

  handlers.quick = function(action)
    local text = form:value("chatInput") or ""
    local sent = startRun(function(s, ai, c)
      if action == "edit_selection" then return R.editSelection(text, s, ai, c) end
      if action == "review" then return R.review(text, s, ai, c) end
      return R.variations(text, 3, s, ai, c)
    end)
    focusChat(sent ~= nil)
  end

  handlers.generate = function() startRun(R.generate) end
  handlers.batch = function() startRun(R.batch) end
  handlers.animate = function() startRun(R.animate) end
  handlers.directions = function(n)
    startRun(function(s, ai, c) return R.directions(n, s, ai, c) end)
  end

  handlers.stop = function()
    if not session.busy then return end
    session:stop(connection.send({ event = "chat_cancel" }))
    sync()
  end

  handlers.newChat = function()
    session:newChat(connection.send({ event = "chat_reset" }))
    logView:toBottom()
    lastError = nil
    focusChat(false)
    sync()
  end

  handlers.tool = function(key)
    form:pull()
    local requestId = session:nextRequestId()
    local payload, err = R.tool(key, requestId, S.snapshot(prefs), spriteContext())
    if not payload then
      session:toolStatus(err, "error", false)
    elseif not connection.send(payload) then
      session:toolStatus(NOT_RUNNING, "error", false)
    else
      session:toolSent(requestId, R.TOOLS[key].label)
    end
    sync()
  end

  handlers.applyTool = function()
    form:pull()
    handlers.tool(R.applyKey(S.snapshot(prefs)))
  end

  -- Shows the settings of the picked tool (and the outline color only when it's used).
  handlers.toolChanged = function()
    form:pull()
    form:applyVisibility(S.snapshot(prefs))
    repaint()
  end

  handlers.resetAdjust = function()
    form:quietly(function()
      for _, id in ipairs({ "toolHue", "toolSaturation", "toolLightness" }) do
        dlg:modify{ id = id, value = 0 }
      end
    end)
    form:pull()
  end

  -- Picking a preset fills in the frame count, timing and looping it usually needs.
  handlers.presetChanged = function()
    local preset = C.find(C.ANIMATIONS, form:value("animPreset"))
    if not preset then return end
    form:quietly(function()
      dlg:modify{ id = "animFrames", value = preset.frames }
      dlg:modify{ id = "animFrameMs", text = tostring(preset.frameMs) }
      dlg:modify{ id = "animLoop", selected = preset.loop }
    end)
    form:pull()
  end

  handlers.providerChanged = function()
    local id = form:value("settingsProvider")
    if id then S.set(prefs, "provider", id) end
    refreshAI()
    local p = P.find(providers, id)
    if p and not p.available then
      log:add("status", p.label .. " is not set up yet. " .. (p.note or ""))
      repaint()
    end
  end

  local function otherOf(source, a, b) return source == a and b or a end

  -- The Chat tab and the Settings tab both show model and effort; keep them in step.
  handlers.modelChanged = function(source)
    local id = form:value(source)
    S.set(prefs, "model", id)
    form:select(otherOf(source, "chatModel", "settingsModel"), id)
    repaint()
  end

  handlers.effortChanged = function(source)
    local id = form:value(source)
    if id then S.set(prefs, "effort", id) end
    form:select(otherOf(source, "chatEffort", "settingsEffort"), id)
    repaint()
  end

  handlers.optionsChanged = function()
    form:pull()
    repaint()
  end

  handlers.reconnect = function()
    form:pull()
    local port = S.get(prefs, "port")
    form:quietly(function() dlg:modify{ id = "settingsPort", text = tostring(port) } end)
    if ctx.reconnect then
      ctx.reconnect()
      log:add("status", "Reconnecting to the bridge on port " .. port .. "...")
    else
      log:add("status", "Use Edit > FX > Aseprite MCP > Reconnect Bridge.")
    end
    repaint()
  end

  -- Window lifecycle ---------------------------------------------------------------

  local function refreshLayerLabel()
    if not form then return end
    local name = layerName()
    if name ~= shownLayer then
      shownLayer = name
      form:setText("toolLayer", F.truncate(name, 40))
    end
  end

  -- sitechange also fires for every frame during playback: only touch widgets when the
  -- layer or sprite actually changed.
  local function onSiteChange()
    refreshLayerLabel()
    local sprite = app.sprite
    local id = sprite and sprite.id or nil
    if id ~= shownSprite then
      shownSprite = id
      repaint()
    end
  end

  local function startListeners()
    if siteListener then return end
    local ok, code = pcall(function()
      return app.events:on("sitechange", function() pcall(onSiteChange) end)
    end)
    if ok then siteListener = code end
  end

  local function stopListeners()
    if siteListener then
      pcall(function() app.events:off(siteListener) end)
      siteListener = nil
    end
  end

  local function saveBounds(d)
    local b = d.bounds
    S.set(prefs, "ui_x", b.x)
    S.set(prefs, "ui_y", b.y)
    S.set(prefs, "ui_w", b.width)
    S.set(prefs, "ui_h", b.height)
  end

  -- The saved position is only reused while it still overlaps the main window (the
  -- user may have changed monitors), and never smaller than the dialog's content.
  local function initialBounds(d)
    local x, y, w, h = S.get(prefs, "ui_x"), S.get(prefs, "ui_y"), S.get(prefs, "ui_w"), S.get(prefs, "ui_h")
    if not (x and y and w and h) then return nil end
    local ok, rect = pcall(function()
      local hint = d.sizeHint
      w, h = math.max(w, hint.width), math.max(h, hint.height)
      local mw, mh = app.window.width, app.window.height
      if x + w < 40 or x > mw - 40 or y < 0 or y > mh - 40 then return nil end
      -- A height saved by an older, taller layout (or on a bigger screen) must not push
      -- the bottom rows off the main window: shrink it, then move up if still needed.
      h = math.min(h, math.max(hint.height, mh - y))
      if y + h > mh then y = math.max(0, mh - h) end
      return Rectangle(x, y, w, h)
    end)
    return ok and rect or nil
  end

  local function onClose(d)
    if dlg ~= d then return end
    if form then pcall(function() form:pull() end) end
    pcall(saveBounds, d)
    stopListeners()
    stopTimer()
    dlg, form = nil, nil
  end

  local function onTabChange(ev)
    local tab = tostring(ev.tab or ""):gsub("^tab_", "")
    if validTab(tab) then S.set(prefs, "tab", tab) end
    if tab == "tools" then refreshLayerLabel() end
    if tab == "chat" then focusChat(false) end
    repaint()
  end

  local function hasTabs(d)
    local ok, fn = pcall(function() return d.tab end)
    return ok and fn ~= nil
  end

  local function build(selectedTab)
    local d
    -- autofit = 0: by default any dlg:modify() that relayouts (label text, focus)
    -- shrinks the window back to its minimum size, undoing the user's resize.
    d = Dialog{
      title = "Aseprite MCP",
      resizeable = true,
      autofit = 0,
      onclose = function() onClose(d) end,
    }
    if not d then return nil end
    dlg, form = d, Form.new(d, prefs, reportError)
    shownSprite = app.sprite and app.sprite.id or nil
    shownToolText = nil

    -- Aseprite 1.3 places widgets of one row side by side and tab pages never hide
    -- canvases, so both canvases live above the tabs, each on its own row.
    form:canvas{ id = "header", height = Header.HEIGHT, hexpand = true, vexpand = false, onpaint = paintHeader }
    form:newrow()
    form:canvas{
      id = "log", width = 340, height = LOG_HEIGHT, hexpand = true, vexpand = true,
      onpaint = handlers.paintLog, onwheel = handlers.wheelLog,
    }
    form:newrow()
    local tabbed = hasTabs(d)
    for _, tab in ipairs(TABS) do
      -- Without tab support (Aseprite < 1.3) the sections are stacked instead.
      if tabbed then d:tab{ id = "tab_" .. tab.id, text = tab.text } else form:separator(tab.text) end
      tab.build(form, handlers, C)
    end
    if tabbed then
      -- The log (vexpand) takes any extra height when the user makes the window taller.
      d:endtabs{ id = "tabs", selected = "tab_" .. selectedTab, onchange = form:safe(onTabChange) }
    end
    -- Before show, so the first size already leaves out the other tools' settings.
    form:applyVisibility(S.snapshot(prefs))
    return d
  end

  function M.isOpen()
    return dlg ~= nil
  end

  function M.close()
    if dlg then dlg:close() end
  end

  function M.open(tab)
    if tab ~= nil and not validTab(tab) then tab = nil end
    if dlg then
      if tab then M.selectTab(tab) end
      return
    end
    if tab then S.set(prefs, "tab", tab) end
    -- Dialog() returns nil without a UI (aseprite -b), which ends up here.
    local d = build(S.get(prefs, "tab"))
    if not d then return end
    d:show{ wait = false, bounds = initialBounds(d) }
    startListeners()
    local hasEfforts = #resolvedAI().provider.efforts > 0
    form:enable("settingsEffort", hasEfforts)
    form:enable("chatEffort", hasEfforts)
    -- Requests may have timed out while the window was closed.
    pcall(tick)
    if S.get(prefs, "tab") == "chat" then focusChat(false) end
  end

  local function rebuild()
    if not dlg then return end
    local tab = S.get(prefs, "tab")
    dlg:close()
    M.open(tab)
  end

  -- Deferred so the dialog isn't closed from inside one of its own callbacks.
  scheduleRebuild = function()
    local ok = pcall(function()
      local t
      t = Timer{ interval = 0.05, ontick = function()
        t:stop()
        pcall(rebuild)
      end }
      t:start()
    end)
    if not ok then pcall(rebuild) end
  end

  function M.selectTab(tab)
    if not validTab(tab) then return end
    if not dlg then return M.open(tab) end
    S.set(prefs, "tab", tab)
    local ok = pcall(function()
      form:quietly(function()
        -- Dialog.data assignment rewrites every widget, so start from the current
        -- values; buttons read as "pressed" when last clicked, so reset those.
        local data = dlg.data
        for id, w in pairs(form.widgets) do
          if w.kind == "button" then data[id] = false end
        end
        data.tabs = "tab_" .. tab
        dlg.data = data
        -- Switching pages this way doesn't relayout; a modify() with text does.
        dlg:modify{ id = "toolStatus", text = data.toolStatus or "" }
      end)
    end)
    if not ok then return rebuild() end
    onTabChange({ tab = tab })
  end

  debugView = {
    open = function(tab) M.open(tab) end,
    selectTab = function(tab)
      if not validTab(tab) then error("Unknown tab: " .. tostring(tab), 0) end
      M.selectTab(tab)
    end,
    set = function(id, value)
      if not form then error("The window is not open", 0) end
      form:set(id, value)
      repaint()
    end,
    click = function(id)
      if not form then error("The window is not open", 0) end
      form:click(id)
    end,
    close = function() M.close() end,
  }

  return M
end
