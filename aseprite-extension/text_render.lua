-- Draws text with Aseprite's pixel UI font, which has no glyphs for ş/Ş or typographic
-- punctuation. For those Aseprite falls back to a 14px Arial glyph that is taller than
-- the line and shifts it down, so lines overlap. We avoid fallback glyphs entirely:
-- punctuation is mapped to ASCII and the cedilla is hand-drawn, like the font's own ç/Ç.

local M = {}

local REPLACEMENTS = {
  ["—"] = "-", ["–"] = "-", ["…"] = "...",
  ["“"] = '"', ["”"] = '"', ["„"] = '"', ["‘"] = "'", ["’"] = "'",
  ["→"] = "->", ["←"] = "<-", ["•"] = "*", ["\t"] = " ",
}

-- dx: cedilla column under the base letter; same spots the font uses for ç (1) and Ç (2).
local CEDILLA = {
  ["ş"] = { base = "s", dx = 1 },
  ["Ş"] = { base = "S", dx = 2 },
}
local CEDILLA_ROW = 6 -- first row below the baseline in the font's 7px-tall glyph cells

-- Everything from U+2000 up (punctuation, arrows, emoji) is missing from the font.
local FIRST_UNSUPPORTED = 0x2000

function M.normalize(text)
  local ok, result = pcall(function()
    local out = {}
    for _, cp in utf8.codes(text) do
      local ch = utf8.char(cp)
      local replacement = REPLACEMENTS[ch]
      if replacement then
        out[#out + 1] = replacement
      elseif cp < FIRST_UNSUPPORTED then
        out[#out + 1] = ch
      else
        out[#out + 1] = "?"
      end
    end
    return table.concat(out)
  end)
  -- Invalid UTF-8 makes utf8.codes raise; show bytes as "?" rather than nothing.
  if ok then return result end
  return (text:gsub("[\128-\255]", "?"))
end

local function withBaseLetters(text)
  return (text:gsub("ş", "s"):gsub("Ş", "S"))
end

function M.measure(gc, text)
  return gc:measureText(withBaseLetters(text)).width
end

function M.lineHeight(gc)
  return gc:measureText("Ag").height
end

function M.draw(gc, text, x, y)
  local cx = x
  local run = {}

  local function flush()
    if #run == 0 then return end
    local s = table.concat(run)
    gc:fillText(s, cx, y)
    cx = cx + gc:measureText(s).width
    run = {}
  end

  for _, cp in utf8.codes(text) do
    local ch = utf8.char(cp)
    local cedilla = CEDILLA[ch]
    if cedilla then
      flush()
      gc:fillText(cedilla.base, cx, y)
      gc:fillRect(Rectangle(cx + cedilla.dx, y + CEDILLA_ROW, 1, 1))
      cx = cx + gc:measureText(cedilla.base).width
    else
      run[#run + 1] = ch
    end
  end
  flush()
end

return M
