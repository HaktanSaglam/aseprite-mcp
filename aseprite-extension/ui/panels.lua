-- The custom-painted panels besides the chat log: the status header, the provider
-- info box and the help box. Deciding WHAT they say is pure (headerModel,
-- providerLines) and tested; painting maps it onto a GraphicsContext with colors
-- derived from the active theme.

return function(textRender, W, T, F, Header)
  local Panels = {}

  Panels.HELP = {
    "1. Start the bridge: in the bridge folder run npm start. The dot above turns green.",
    "2. Chat: describe a change and press Enter. With Use selection, edits stay inside the marquee.",
    "3. Generate and Animate: pick options, press the button. Every AI edit is one Ctrl+Z.",
    "4. Tools run instantly, without AI.",
    "Other MCP clients can connect to http://127.0.0.1:7800/mcp",
  }

  -- Header -----------------------------------------------------------------------------

  -- session: ui/session.lua; conn: connection.status; ai: "Claude Code · Opus · Fast".
  function Panels.headerModel(session, conn, ai, hasSprite, phase)
    local status = F.connection(conn)
    local model = { conn = status, ai = ai, busy = session.busy, phase = phase or 0 }
    if session.busy then
      model.working = session.awaiting and "Sending..." or F.working(session:elapsed(), session.tool, session.progress)
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

  function Panels.helpLines()
    local lines = {}
    for i, text in ipairs(Panels.HELP) do
      lines[i] = { text = text, role = i == #Panels.HELP and "dim" or "text" }
    end
    return lines
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

  -- lines: {text, role}[]; wrapped to the panel width, cut at its bottom edge.
  function Panels.paintLines(gc, lines)
    local colors = Panels.colors()
    fill(gc, colors)
    local function measure(s) return textRender.measure(gc, s) end
    local lineHeight = textRender.lineHeight(gc) + 2
    local y = 4
    for _, item in ipairs(lines) do
      gc.color = colors[item.role] or colors.text
      for _, line in ipairs(W.wrap(item.text, gc.width - 12, measure)) do
        if y + lineHeight > gc.height then return end
        textRender.draw(gc, line, 6, y)
        y = y + lineHeight
      end
    end
  end

  return Panels
end
