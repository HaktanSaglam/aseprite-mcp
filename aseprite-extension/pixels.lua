-- Converts between Aseprite pixel values and a flat "rrggbbaa" hex string.
-- The bridge only ever sees RGBA, so color-mode differences stay inside Aseprite.

local M = {}

local pc = app.pixelColor

local function toRgba(sprite, palette, value)
  local mode = sprite.colorMode
  if mode == ColorMode.RGB then
    return pc.rgbaR(value), pc.rgbaG(value), pc.rgbaB(value), pc.rgbaA(value)
  elseif mode == ColorMode.GRAY then
    local v = pc.grayaV(value)
    return v, v, v, pc.grayaA(value)
  else -- INDEXED
    if value == sprite.transparentColor or value >= #palette then
      return 0, 0, 0, 0
    end
    local c = palette:getColor(value)
    return c.red, c.green, c.blue, c.alpha
  end
end

local function transparentValue(sprite)
  if sprite.colorMode == ColorMode.INDEXED then
    return sprite.transparentColor
  end
  return 0
end

-- Indexed sprites can't hold arbitrary colors, so we snap to the closest palette entry.
local function nearestIndex(sprite, palette, r, g, b)
  local best, bestDist = 0, math.huge
  for i = 0, #palette - 1 do
    if i ~= sprite.transparentColor then
      local c = palette:getColor(i)
      local dr, dg, db = c.red - r, c.green - g, c.blue - b
      local d = dr * dr + dg * dg + db * db
      if d < bestDist then
        best, bestDist = i, d
        if d == 0 then break end
      end
    end
  end
  return best
end

local function fromRgba(sprite, palette, cache, r, g, b, a)
  local mode = sprite.colorMode
  if mode == ColorMode.RGB then
    return pc.rgba(r, g, b, a)
  elseif mode == ColorMode.GRAY then
    return pc.graya(math.floor(0.299 * r + 0.587 * g + 0.114 * b + 0.5), a)
  else
    local key = r * 65536 + g * 256 + b
    local idx = cache[key]
    if not idx then
      idx = nearestIndex(sprite, palette, r, g, b)
      cache[key] = idx
    end
    return idx
  end
end

-- Full-canvas image of either one layer's cel or the flattened sprite.
-- Working in canvas space avoids cel-offset math everywhere else.
local function canvasImage(sprite, frame, layer)
  local img = Image(sprite.spec)
  if layer then
    local cel = layer:cel(frame)
    if cel then img:drawImage(cel.image, cel.position) end
  else
    img:drawSprite(sprite, frame)
  end
  return img
end

function M.readRegion(sprite, frame, layer, rect)
  local palette = sprite.palettes[1]
  local img = canvasImage(sprite, frame, layer)
  local parts = {}
  for y = rect.y, rect.y + rect.height - 1 do
    for x = rect.x, rect.x + rect.width - 1 do
      local r, g, b, a = 0, 0, 0, 0
      if x >= 0 and y >= 0 and x < img.width and y < img.height then
        r, g, b, a = toRgba(sprite, palette, img:getPixel(x, y))
      end
      parts[#parts + 1] = string.format("%02x%02x%02x%02x", r, g, b, a)
    end
  end
  return table.concat(parts)
end

-- opts.eraseTransparent: alpha-0 pixels erase instead of being skipped.
-- opts.mask (Selection|nil): pixels outside it are left untouched.
function M.writeRegion(sprite, frame, layer, rect, hex, opts)
  local palette = sprite.palettes[1]
  local cache = {}
  local clear = transparentValue(sprite)
  local img = canvasImage(sprite, frame, layer)
  local i = 0
  for y = rect.y, rect.y + rect.height - 1 do
    for x = rect.x, rect.x + rect.width - 1 do
      local o = i * 8 + 1
      i = i + 1
      local inCanvas = x >= 0 and y >= 0 and x < img.width and y < img.height
      local inMask = (opts.mask == nil) or opts.mask:contains(x, y)
      if inCanvas and inMask then
        local r = tonumber(hex:sub(o, o + 1), 16)
        local g = tonumber(hex:sub(o + 2, o + 3), 16)
        local b = tonumber(hex:sub(o + 4, o + 5), 16)
        local a = tonumber(hex:sub(o + 6, o + 7), 16)
        if a > 0 then
          img:drawPixel(x, y, fromRgba(sprite, palette, cache, r, g, b, a))
        elseif opts.eraseTransparent then
          img:drawPixel(x, y, clear)
        end
      end
    end
  end
  sprite:newCel(layer, frame, img, Point(0, 0))
end

function M.colorToHex(c)
  return string.format("%02x%02x%02x%02x", c.red, c.green, c.blue, c.alpha)
end

return M
