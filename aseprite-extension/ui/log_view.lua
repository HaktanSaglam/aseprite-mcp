-- Paints the chat log canvas: wrapped messages, the user's bubbles, a thin scrollbar
-- and a "more below" hint, and handles mouse-wheel scrolling. Layout math lives in
-- ui/log_layout.lua; this file only draws.

return function(textRender, LL)
  local V = {}
  V.__index = V

  local PAD = 6
  local SCROLLBAR = 3
  local LINE_GAP = 2
  local WHEEL_STEP = 24

  -- The tips shown in an empty log double as a short manual.
  local EMPTY_HINT = {
    "Ask the AI to draw or edit something.",
    "",
    "Try: \"a 32x32 slime with a shiny highlight\"",
    "or select an area and press Redraw selection.",
    "Generate, Animate and Tools have more options.",
  }

  function V.new(log)
    return setmetatable({ log = log, scroll = 0, lastTotal = nil, layout = nil, moreRect = nil }, V)
  end

  function V:toBottom()
    self.scroll = 0
    self.lastTotal = nil
  end

  -- The spinner repaints the dialog several times a second while the log rarely
  -- changes, so the layout is kept until the log, the width or the font changes.
  function V:blocks(messages, width, measure, lineHeight)
    local c = self.layout
    if not (c and c.version == self.log.version and c.width == width and c.lineHeight == lineHeight) then
      local blocks, total = LL.layout(messages, width, measure, lineHeight)
      c = { version = self.log.version, width = width, lineHeight = lineHeight, blocks = blocks, total = total }
      self.layout = c
    end
    return c.blocks, c.total
  end

  -- A click on the "more below" hint jumps to the newest message. Returns true when the
  -- click hit it (the caller repaints).
  function V:click(ev)
    local r = self.moreRect
    local x, y = tonumber(ev and ev.x), tonumber(ev and ev.y)
    if not (r and x and y) then return false end
    if x < r.x or x > r.x + r.w or y < r.y or y > r.y + r.h then return false end
    self:toBottom()
    return true
  end

  -- Trackpads report fractional deltas, but drawing needs whole pixels: GraphicsContext
  -- reads coordinates with lua_tointeger, which turns 12.5 into 0.
  function V:wheel(ev)
    local delta = tonumber(ev.deltaY) or 0
    self.scroll = math.max(0, math.floor(self.scroll - delta * WHEEL_STEP + 0.5))
  end

  local function nameColor(colors, kind)
    if kind == "user" then return colors.userName end
    if kind == "ai" then return colors.aiName end
    return nil
  end

  local function bodyColor(colors, kind)
    if kind == "user" or kind == "ai" then return colors.text end
    if kind == "tool" then return colors.tool end
    if kind == "error" then return colors.error end
    if kind == "done" then return colors.ok end
    if kind == "progress" then return colors.warn end
    if kind == "result" then return colors.accent end
    return colors.dim
  end

  local function drawEmpty(gc, colors, lineHeight)
    local y = PAD + 4
    for i, line in ipairs(EMPTY_HINT) do
      gc.color = i == 1 and colors.text or colors.dim
      textRender.draw(gc, line, PAD + 2, y)
      y = y + lineHeight
    end
  end

  local function drawScrollbar(gc, colors, total, visible, scroll)
    if total <= visible then return end
    local trackH = gc.height - PAD * 2
    local thumbH = math.max(12, math.floor(trackH * visible / total))
    -- scroll counts from the bottom, the thumb position from the top.
    local fromTop = (total - visible - scroll) / (total - visible)
    local y = PAD + math.floor((trackH - thumbH) * fromTop)
    local x = gc.width - SCROLLBAR - 1
    gc.color = colors.track
    gc:fillRect(Rectangle(x, PAD, SCROLLBAR, trackH))
    gc.color = colors.dim
    gc:fillRect(Rectangle(x, y, SCROLLBAR, thumbH))
  end

  -- Returns the hint's rectangle so a click on it can be recognized.
  local function drawMoreBelow(gc, colors, lineHeight)
    local text = "v more below"
    local w = textRender.measure(gc, text) + 8
    local x = gc.width - SCROLLBAR - 4 - w
    local y = gc.height - lineHeight - 6
    gc.color = colors.accent
    gc:beginPath()
    gc:roundedRect(Rectangle(x, y, w, lineHeight + 2), 3)
    gc:fill()
    gc.color = colors.bg
    textRender.draw(gc, text, x + 4, y + 1)
    return { x = x, y = y, w = w, h = lineHeight + 2 }
  end

  -- colors: Color objects keyed like ui/theme.lua's palette.
  function V:paint(gc, colors)
    local width, height = gc.width, gc.height
    gc.color = colors.bg
    gc:beginPath()
    gc:roundedRect(Rectangle(0, 0, width, height), 4)
    gc:fill()

    local lineHeight = textRender.lineHeight(gc) + LINE_GAP
    local messages = self.log.messages
    self.moreRect = nil
    if #messages == 0 then
      self.scroll, self.lastTotal = 0, nil
      return drawEmpty(gc, colors, lineHeight)
    end

    local function measure(s) return textRender.measure(gc, s) end
    local contentWidth = width - PAD * 2 - SCROLLBAR - 2
    local blocks, total = self:blocks(messages, contentWidth, measure, lineHeight)
    local visible = height - PAD * 2

    if self.lastTotal ~= nil and total ~= self.lastTotal then
      self.scroll = LL.keepAnchor(self.scroll, self.lastTotal, total)
    end
    self.lastTotal = total
    self.scroll = LL.clampScroll(self.scroll, total, visible)

    -- Short history starts at the top; long history is bottom-aligned like a chat so the
    -- newest message stays visible and older rows scroll off the top.
    local top = PAD
    if total > visible then top = PAD + visible - total + self.scroll end

    for _, block in ipairs(blocks) do
      local by = top + block.y
      if by + block.h >= 0 and by <= height then
        local kind = block.message.kind
        local x = PAD
        local y = by
        if block.bubble then
          gc.color = colors.userBubble
          gc:beginPath()
          gc:roundedRect(Rectangle(PAD, by, contentWidth, block.h), 3)
          gc:fill()
          x = x + LL.BUBBLE_X
          y = y + LL.BUBBLE_Y
        end
        local body = bodyColor(colors, kind)
        for i, line in ipairs(block.lines) do
          local ly = y + (i - 1) * lineHeight
          if ly + lineHeight >= 0 and ly <= height then
            local lx = x
            if i == 1 then
              local prefix, rest = LL.splitPrefix(line, block.prefix)
              if prefix then
                gc.color = nameColor(colors, kind) or body
                lx = textRender.draw(gc, prefix, lx, ly)
                line = rest
              end
            end
            gc.color = body
            textRender.draw(gc, line, lx, ly)
          end
        end
      end
    end

    drawScrollbar(gc, colors, total, visible, self.scroll)
    if self.scroll > 0 then self.moreRect = drawMoreBelow(gc, colors, lineHeight) end
  end

  return V
end
