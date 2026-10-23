-- What the status panels say: the painted header above the tabs, plus the provider
-- status and help lines the Settings tab shows in native labels. Deciding WHAT they say
-- is pure (headerModel, providerLines) and tested; painting maps the header onto a
-- GraphicsContext with colors derived from the active theme.

return function(T, F, Header)
  local Panels = {}

  -- One native label per line, and labels don't wrap: each line must fit the narrowest
  -- window on its own (about 45 characters of the pixel font).
  Panels.HELP = {
    "Start the bridge: npm start (bridge folder).",
    "Use selection: AI edits stay in the marquee.",
    "MCP clients: http://127.0.0.1:7800/mcp",
  }

  -- Header -----------------------------------------------------------------------------

  -- session: ui/session.lua; conn: connection.status; ai: "Claude Code · Opus · Fast".
  function Panels.headerModel(session, conn, ai, hasSprite, phase)
    local status = F.connection(conn)
    local model = { conn = status, ai = ai, busy = session.busy, phase = phase or 0 }
    if session.busy then
      if session.stopping then
        model.working = "Stopping..."
      elseif session.awaiting then
        model.working = "Sending..."
      else
        model.working = F.working(session:elapsed(), session.tool, session.progress)
      end
      model.progress = session.progress
    elseif status.state ~= "ok" then
      model.note = { text = "It reconnects by itself once the bridge is running.", kind = "dim" }
    elseif session.note then
      model.note = session.note
    elseif not hasSprite then
      model.note = { text = "No sprite open. Generate can create one.", kind = "dim" }
    else
      model.note = { text = "Ready. Every AI edit is one Ctrl+Z.", kind = "dim" }
    end
    return model
  end

  -- provider: ProviderInfo; fromBridge: whether the list came from bridge_info.
  function Panels.providerLines(provider, fromBridge)
    if not provider.available then
      return { { text = "Not set up: " .. (provider.note or "see the README."), role = "warn" } }
    end
    if not fromBridge then
      return { { text = "Built-in list. The bridge updates it once connected.", role = "dim" } }
    end
    local text = "Ready" .. (provider.supportsImages and "" or " (this AI can't see the canvas)")
    return { { text = text, role = "ok" } }
  end

  -- Painting -----------------------------------------------------------------------------

  local cache = { key = nil, colors = nil }

  -- Color objects for every role, recomputed only when the theme changes.
  function Panels.colors()
    local theme = app.theme.color
    local bg, fg = theme.textbox_face, theme.textbox_text
    local key = string.format("%d,%d,%d/%d,%d,%d", bg.red, bg.green, bg.blue, fg.red, fg.green, fg.blue)
    if cache.key ~= key then
      local palette = T.palette(T.rgb(bg.red, bg.green, bg.blue), T.rgb(fg.red, fg.green, fg.blue))
      local out = {}
      for name, c in pairs(palette) do
        if type(c) == "table" then out[name] = Color{ r = c.r, g = c.g, b = c.b } end
      end
      cache.key, cache.colors = key, out
    end
    return cache.colors
  end

  local function fill(gc, colors)
    gc.color = colors.bg
    gc:beginPath()
    gc:roundedRect(Rectangle(0, 0, gc.width, gc.height), 4)
    gc:fill()
  end

  function Panels.paintHeader(gc, model)
    local colors = Panels.colors()
    fill(gc, colors)
    Header.paint(gc, colors, model)
  end

  return Panels
end
