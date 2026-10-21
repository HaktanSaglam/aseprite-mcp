-- Word wrapping and truncation for canvas text. The text width comes from an injected
-- measure(text) function, so this runs (and is tested) without a GraphicsContext.

local W = {}

local function hardSplit(word, maxWidth, measure, lines)
  -- Words wider than the box are cut per UTF-8 character (keeps ğ, ş, ü intact).
  while measure(word) > maxWidth do
    local cut = ""
    for ch in word:gmatch(utf8.charpattern) do
      if measure(cut .. ch) > maxWidth then break end
      cut = cut .. ch
    end
    -- Even one character doesn't fit: take it anyway so the loop always advances.
    if cut == "" then cut = word:match(utf8.charpattern) or word end
    -- The last piece is returned rather than emitted: the next word may still join it.
    if cut == word then break end
    lines[#lines + 1] = cut
    word = word:sub(#cut + 1)
  end
  return word
end

-- Returns an array of lines; explicit newlines start a new paragraph and empty
-- paragraphs are kept as empty lines.
function W.wrap(text, maxWidth, measure)
  local lines = {}
  maxWidth = math.max(1, maxWidth)
  for paragraph in (tostring(text) .. "\n"):gmatch("(.-)\n") do
    local line = ""
    for word in paragraph:gmatch("%S+") do
      local candidate = (line == "") and word or (line .. " " .. word)
      if measure(candidate) <= maxWidth then
        line = candidate
      else
        if line ~= "" then lines[#lines + 1] = line end
        line = hardSplit(word, maxWidth, measure, lines)
      end
    end
    lines[#lines + 1] = line
  end
  return lines
end

-- Cuts text to fit maxWidth, ending in "..." when something was removed.
function W.fit(text, maxWidth, measure)
  text = tostring(text)
  if measure(text) <= maxWidth then return text end
  local ellipsis = "..."
  local out = ""
  for ch in text:gmatch(utf8.charpattern) do
    if measure(out .. ch .. ellipsis) > maxWidth then break end
    out = out .. ch
  end
  if out == "" then return measure(ellipsis) <= maxWidth and ellipsis or "" end
  return out .. ellipsis
end

return W
