-- Draws text with Aseprite's pixel UI font, which has no glyphs for ş/Ş or typographic
-- punctuation. For those Aseprite falls back to a 14px Arial glyph that is taller than
-- the line and shifts it down, so lines overlap. We avoid fallback glyphs entirely:
-- punctuation is mapped to ASCII and a few glyphs are hand-drawn, like the font's own ç/Ç
-- (the cedilla for ş/Ş, and the "·" separator the header and log use).

local M = {}

local REPLACEMENTS = {
  ["—"] = "-", ["–"] = "-", ["…"] = "...",
  ["“"] = '"', ["”"] = '"', ["„"] = '"', ["‘"] = "'", ["’"] = "'",
  ["→"] = "->", ["←"] = "<-", ["•"] = "*", ["\t"] = " ",
  ["✓"] = "ok", ["✔"] = "ok", ["✗"] = "x", ["✘"] = "x", ["×"] = "x",
}

-- Glyph cells are 7px tall: rows 0-5 hold the letter, row 6 is the first row below the
-- baseline. dx is the column under the base letter, the spots the font uses for ç and Ç.
local CEDILLA = {
  ["ş"] = { base = "s", dx = 1 },
  ["Ş"] = { base = "S", dx = 2 },
}
local CEDILLA_ROW = 6
-- Middle of the lowercase x-height.
local MIDDOT = "·"
local MIDDOT_ROW = 3

-- Everything from U+2000 up (punctuation, arrows, emoji) is missing from the font.
local FIRST_UNSUPPORTED = 0x2000

function M.normalize(text)
  text = tostring(text)
  local ok, result = pcall(function()
    local out = {}
    for _, cp in utf8.codes(text) do
      local ch = utf8.char(cp)
      local replacement = REPLACEMENTS[ch]
      if replacement then
        out[#out + 1] = replacement
      elseif cp == 0x0D then
        -- Drop CR so Windows line endings don't render as a stray glyph.
      elseif cp < 0x20 and cp ~= 0x0A then
        out[#out + 1] = " "
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

-- For native widgets (labels), which can't use the hand-drawn glyphs below: same as
-- normalize, plus the letters the font lacks fall back to their base letter.
function M.forWidget(text)
  return (M.normalize(text):gsub("ş", "s"):gsub("Ş", "S"):gsub("·", "-"))
end

-- Hand-drawn glyphs are measured as the ASCII glyph that has the same advance.
local function withBaseLetters(text)
  return (text:gsub("ş", "s"):gsub("Ş", "S"):gsub(MIDDOT, "."))
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

  -- Text that skipped normalize() may be invalid UTF-8, which utf8.codes rejects.
  if utf8.len(text) == nil then text = text:gsub("[\128-\255]", "?") end

  for _, cp in utf8.codes(text) do
    local ch = utf8.char(cp)
    local cedilla = CEDILLA[ch]
    if cedilla then
      flush()
      gc:fillText(cedilla.base, cx, y)
      gc:fillRect(Rectangle(cx + cedilla.dx, y + CEDILLA_ROW, 1, 1))
      cx = cx + gc:measureText(cedilla.base).width
    elseif ch == MIDDOT then
      flush()
      gc:fillRect(Rectangle(cx, y + MIDDOT_ROW, 1, 1))
      cx = cx + gc:measureText(".").width
    else
      run[#run + 1] = ch
    end
  end
  flush()
  return cx
end

return M
