-- Lays chat messages out as wrapped text blocks with y positions. Pure (text width comes
-- from an injected measure function); ui/log_view.lua paints the result.
--
-- Wrapped lines are cached on each message and reused while its text and the available
-- width stay the same, because the header timer repaints every canvas several times a
-- second and measuring every word each time would make the dialog sluggish.

return function(W)
  local LL = {}

  LL.PREFIX = { user = "You: ", ai = "AI: ", error = "! ", tool = "> " }
  -- Inner padding of the user's "bubble".
  LL.BUBBLE_X = 4
  LL.BUBBLE_Y = 2
  local GAP_AFTER = { tool = 3, status = 3, progress = 3, result = 3 }
  local DEFAULT_GAP = 6

  -- The cache key is compared field by field: building prefix .. text for every message
  -- on every paint would copy the whole history several times a second.
  local function linesFor(m, prefix, width, measure)
    if m._wrapWidth == width and m._wrapText == m.text and m._wrapPrefix == prefix then return m._lines end
    local lines = W.wrap(prefix .. m.text, width, measure)
    m._wrapWidth, m._wrapText, m._wrapPrefix, m._lines = width, m.text, prefix, lines
    return lines
  end

  -- Returns blocks {message, prefix, lines, y, h} (y from the top of the content) and
  -- the total content height.
  function LL.layout(messages, width, measure, lineHeight)
    local blocks = {}
    local y = 0
    local lastGap = 0
    for _, m in ipairs(messages) do
      local prefix = LL.PREFIX[m.kind] or ""
      local bubble = m.kind == "user"
      local inner = bubble and (width - LL.BUBBLE_X * 2) or width
      local lines = linesFor(m, prefix, math.max(1, inner), measure)
      local h = #lines * lineHeight + (bubble and LL.BUBBLE_Y * 2 or 0)
      blocks[#blocks + 1] = { message = m, prefix = prefix, lines = lines, y = y, h = h, bubble = bubble }
      lastGap = GAP_AFTER[m.kind] or DEFAULT_GAP
      y = y + h + lastGap
    end
    return blocks, math.max(0, y - lastGap)
  end

  -- Splits a first line into the colored speaker prefix and the rest of the text.
  function LL.splitPrefix(line, prefix)
    if prefix == "" then return nil, line end
    if line:sub(1, #prefix) == prefix then return prefix, line:sub(#prefix + 1) end
    local bare = prefix:gsub("%s+$", "")
    if line == bare then return bare, "" end
    return nil, line
  end

  -- scroll = pixels scrolled up from the bottom (0 = newest message visible).
  function LL.clampScroll(scroll, total, visible)
    return math.max(0, math.min(scroll, math.max(0, total - visible)))
  end

  -- While the user reads older messages, new content must not move what they see:
  -- grow the distance from the bottom by however much content was added.
  function LL.keepAnchor(scroll, oldTotal, newTotal)
    if scroll <= 0 or oldTotal == nil then return 0 end
    return scroll + (newTotal - oldTotal)
  end

  return LL
end
