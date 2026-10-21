-- Non-modal chat window. Sends {event="chat_send"} to the bridge and renders the
-- {event="chat"} updates it streams back. Drawing itself happens through the MCP
-- tools, so this file is UI only.

return function(connection, prefs, textRender)
  local M = {}

  local MAX_MESSAGES = 200
  local MODEL_IDS = { Opus = "opus", Sonnet = "sonnet", Haiku = "haiku" }
  local ACTION_LABELS = {
    redraw_selection = "[Redraw selection]",
    review = "[Review & fix]",
  }

  local dlg = nil
  local unsubscribe = nil
  -- Kept at module level so closing and reopening the window keeps the history.
  local messages = {}
  local busy = false
  local scroll = 0 -- pixels scrolled up from the bottom

  local STYLES = {
    user = { prefix = "You: ", color = function() return app.theme.color.textbox_text end },
    claude = { prefix = "Claude: ", color = function() return app.theme.color.link_text end },
    tool = { prefix = "  > ", color = function() return app.theme.color.disabled end },
    status = { prefix = "", color = function() return app.theme.color.disabled end },
    error = { prefix = "! ", color = function() return Color{ r = 220, g = 80, b = 80 } end },
  }

  local function repaint()
    if dlg then dlg:repaint() end
  end

  local function add(kind, text)
    messages[#messages + 1] = { kind = kind, text = textRender.normalize(tostring(text)) }
    if #messages > MAX_MESSAGES then table.remove(messages, 1) end
    scroll = 0
    repaint()
  end

  -- Consecutive tool calls collapse into one line instead of flooding the log.
  local function addTool(name)
    local last = messages[#messages]
    if last and last.kind == "tool" then
      last.text = last.text .. ", " .. name
      repaint()
    else
      add("tool", name)
    end
  end

  local function wrap(gc, text, maxWidth)
    local function width(s) return textRender.measure(gc, s) end
    local lines = {}
    for paragraph in (text .. "\n"):gmatch("(.-)\n") do
      local line = ""
      for word in paragraph:gmatch("%S+") do
        local candidate = (line == "") and word or (line .. " " .. word)
        if width(candidate) <= maxWidth then
          line = candidate
        else
          if line ~= "" then lines[#lines + 1] = line end
          -- Hard-split words wider than the box, char by char (UTF-8 safe for ş, ğ, ...).
          while width(word) > maxWidth do
            local cut = ""
            for ch in word:gmatch(utf8.charpattern) do
              if width(cut .. ch) > maxWidth then break end
              cut = cut .. ch
            end
            if cut == "" then break end
            lines[#lines + 1] = cut
            word = word:sub(#cut + 1)
          end
          line = word
        end
      end
      lines[#lines + 1] = line
    end
    return lines
  end

  local function paint(ev)
    local gc = ev.context
    local pad = 6
    local width, height = gc.width, gc.height
    local lineHeight = textRender.lineHeight(gc) + 3
    local gap = 6

    gc.color = app.theme.color.textbox_face
    gc:fillRect(Rectangle(0, 0, width, height))

    local rows = {}
    for _, m in ipairs(messages) do
      local style = STYLES[m.kind] or STYLES.status
      for _, text in ipairs(wrap(gc, style.prefix .. m.text, width - pad * 2)) do
        rows[#rows + 1] = { text = text, color = style.color(), h = lineHeight }
      end
      rows[#rows + 1] = { h = gap }
    end
    if busy then
      rows[#rows + 1] = { text = "Claude is working...", color = app.theme.color.disabled, h = lineHeight }
    end
    if #rows == 0 then
      rows[1] = {
        text = "Ask Claude to draw or edit something.",
        color = app.theme.color.disabled,
        h = lineHeight,
      }
    end

    local total = 0
    for _, r in ipairs(rows) do total = total + r.h end
    local visible = height - pad * 2
    scroll = math.max(0, math.min(scroll, total - visible))

    -- Short history starts at the top; long history is bottom-aligned like a chat so
    -- the newest message stays visible, and older rows scroll off the top.
    local y = pad
    if total > visible then y = height - pad - total + scroll end
    for _, r in ipairs(rows) do
      if r.text and y + r.h > 0 and y < height then
        gc.color = r.color
        textRender.draw(gc, r.text, pad, y)
      end
      y = y + r.h
    end
  end

  local function statusText()
    if connection.status == "connected" then return "Bridge: connected" end
    return "Bridge: " .. connection.status
  end

  local function setBusy(value)
    busy = value
    if not dlg then return end
    dlg:modify{ id = "send", enabled = not busy }
    dlg:modify{ id = "redraw", enabled = not busy }
    dlg:modify{ id = "review", enabled = not busy }
    dlg:modify{ id = "stop", enabled = busy }
    repaint()
  end

  local function selectionBounds()
    local sprite = app.sprite
    if not sprite or sprite.selection.isEmpty then return nil end
    local b = sprite.selection.bounds
    return { x = b.x, y = b.y, width = b.width, height = b.height }
  end

  local function send(action)
    if busy or not dlg then return end
    local text = dlg.data.input or ""
    if text == "" and action == nil then return end

    local selection = dlg.data.useSelection and selectionBounds() or nil
    if action == "redraw_selection" then
      selection = selectionBounds()
      if not selection then
        add("error", "Select an area first (Rectangular Marquee tool, M).")
        return
      end
    end

    local model = dlg.data.model
    prefs.model = model

    local ok = connection.send({
      event = "chat_send",
      text = text,
      model = MODEL_IDS[model],
      action = action,
      selection = selection,
    })
    if not ok then
      add("error", "Bridge is not connected. Start it with: npm start")
      return
    end

    local label = ACTION_LABELS[action]
    if label then
      add("user", text ~= "" and (label .. " " .. text) or label)
    else
      add("user", text)
    end
    -- Pressing Enter moves focus to the Send button; give it back for the next message.
    dlg:modify{ id = "input", text = "", focus = true }
  end

  local function onBridge(kind, payload)
    if not dlg then return end
    if kind == "status" then
      dlg:modify{ id = "status", text = statusText() }
      -- A dropped connection ends any run in progress on the bridge side too.
      if payload ~= "connected" and busy then setBusy(false) end
      return
    end
    if payload.event ~= "chat" then return end

    local k = payload.kind
    if k == "text" then
      add("claude", payload.text)
    elseif k == "tool" then
      addTool(payload.name)
    elseif k == "status" then
      add("status", payload.text)
    elseif k == "error" then
      add("error", payload.text)
    elseif k == "busy" then
      setBusy(payload.busy == true)
    end
  end

  function M.open()
    if dlg then return end

    dlg = Dialog{
      title = "Claude Chat",
      onclose = function()
        if unsubscribe then unsubscribe() end
        unsubscribe = nil
        dlg = nil
      end,
    }

    dlg:canvas{
      id = "log",
      -- Logical px; Aseprite multiplies by the UI scale (2x on most Macs).
      width = 320,
      height = 220,
      onpaint = paint,
      onwheel = function(ev)
        scroll = math.max(0, scroll - ev.deltaY * 24)
        repaint()
      end,
    }
    dlg:newrow()
    dlg:check{ id = "useSelection", text = "Use selection as context", selected = true }
    dlg:newrow()
    dlg:combobox{
      id = "model",
      label = "Model",
      option = prefs.model or "Opus",
      options = { "Opus", "Sonnet", "Haiku" },
    }
    dlg:entry{ id = "input", label = "Message", focus = true }
    dlg:newrow()
    -- focus = true makes this the "magnet" button that catches Enter from the entry.
    dlg:button{ id = "send", text = "Send", focus = true, onclick = function() send(nil) end }
    dlg:button{ id = "stop", text = "Stop", enabled = false, onclick = function()
      connection.send({ event = "chat_cancel" })
    end }
    dlg:button{ id = "reset", text = "New chat", onclick = function()
      messages = {}
      scroll = 0
      repaint()
      connection.send({ event = "chat_reset" })
    end }
    dlg:separator{ text = "Quick actions" }
    dlg:button{ id = "redraw", text = "Redraw selection", onclick = function() send("redraw_selection") end }
    dlg:button{ id = "review", text = "Review & fix", onclick = function() send("review") end }
    dlg:newrow()
    dlg:label{ id = "status", text = statusText() }

    unsubscribe = connection.subscribe(onBridge)
    dlg:show{ wait = false }
    setBusy(busy)
  end

  return M
end
