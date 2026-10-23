-- Paints the two-line header above the tabs:
--   line 1: connection dot + status, and the active AI (provider · model · effort)
--   line 2: spinner + "Working 12s · draw_script" (+ progress bar) while busy, otherwise
--           the last result ("Done in 23s · 5 steps") or a hint.
-- It is a canvas rather than labels because the pixel font has no "●" glyph and a
-- label can't color part of its text.

return function(textRender, W)
  local H = {}

  local PAD = 6
  local DOT = 6
  local BAR_W = 56

  H.HEIGHT = 30

  -- Filled when connected, a ring otherwise (like "●" / "○").
  local function drawDot(gc, color, x, y, filled)
    gc.color = color
    gc:beginPath()
    gc:roundedRect(Rectangle(x, y, DOT, DOT), DOT / 2)
    if filled then
      gc:fill()
    else
      gc.strokeWidth = 1
      gc:stroke()
    end
  end

  -- Eight pixels around a circle; the bright one walks clockwise with `phase`.
  local function drawSpinner(gc, colors, cx, cy, phase)
    for i = 0, 7 do
      local a = i * math.pi / 4
      local px = math.floor(cx + math.cos(a) * 3 + 0.5)
      local py = math.floor(cy + math.sin(a) * 3 + 0.5)
      local age = (phase - i) % 8
      gc.color = age == 0 and colors.accent or (age <= 2 and colors.dim or colors.faint)
      gc:fillRect(Rectangle(px, py, 1, 1))
    end
  end

  local function drawBar(gc, colors, x, y, w, h, fraction)
    gc.color = colors.track
    gc:fillRect(Rectangle(x, y, w, h))
    gc.color = colors.accent
    gc:fillRect(Rectangle(x, y, math.floor(w * math.max(0, math.min(1, fraction)) + 0.5), h))
  end

  local STATE_COLOR = { ok = "ok", error = "error", off = "dim", busy = "warn" }
  local NOTE_COLOR = { ok = "ok", error = "error", warn = "warn", dim = "dim" }

  -- model: {conn = {state, text}, ai = string, busy = bool, working = string,
  --         progress = {done, total}?, phase = int, note = {text, kind}?}
  function H.paint(gc, colors, model)
    local function measure(s) return textRender.measure(gc, s) end
    local width = gc.width
    local lineHeight = textRender.lineHeight(gc)
    local y1 = 4
    local y2 = y1 + lineHeight + 5
    local textX = PAD + DOT + 5

    drawDot(gc, colors[STATE_COLOR[model.conn.state] or "dim"], PAD, y1 + math.floor((lineHeight - DOT) / 2),
      model.conn.state == "ok")
    gc.color = colors.text
    local statusEnd = textRender.draw(gc, W.fit(model.conn.text, width - textX - PAD, measure), textX, y1)

    -- The AI summary only goes on line 1 when it fits next to the status.
    local aiRoom = width - PAD - (statusEnd + 12)
    if model.ai and model.ai ~= "" and aiRoom > 40 then
      local ai = W.fit(model.ai, aiRoom, measure)
      gc.color = colors.dim
      textRender.draw(gc, ai, width - PAD - measure(ai), y1)
    end

    if model.busy then
      drawSpinner(gc, colors, PAD + DOT / 2, y2 + math.floor(lineHeight / 2), model.phase or 0)
      local right = width - PAD
      local p = model.progress
      if p and (p.total or 0) > 0 then
        right = right - BAR_W - 6
        drawBar(gc, colors, width - PAD - BAR_W, y2 + math.floor(lineHeight / 2) - 2, BAR_W, 4, p.done / p.total)
      end
      gc.color = colors.accent
      textRender.draw(gc, W.fit(model.working or "Working", right - textX, measure), textX, y2)
    elseif model.note and model.note.text ~= "" then
      gc.color = colors[NOTE_COLOR[model.note.kind] or "dim"]
      textRender.draw(gc, W.fit(model.note.text, width - textX - PAD, measure), textX, y2)
    end
  end

  return H
end
