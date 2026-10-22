-- Shared helpers for the RPC modules: sprite/layer/frame lookup, name<->enum maps
-- and the hex codec for raw image bytes.

local U = {}

U.COLOR_MODE_NAMES = {
  [ColorMode.RGB] = "rgb",
  [ColorMode.GRAY] = "grayscale",
  [ColorMode.INDEXED] = "indexed",
}
U.COLOR_MODES = { rgb = ColorMode.RGB, grayscale = ColorMode.GRAY, indexed = ColorMode.INDEXED }
U.FORMATS = { [ColorMode.RGB] = "rgba", [ColorMode.GRAY] = "gray", [ColorMode.INDEXED] = "indexed" }

-- Built from what this Aseprite version actually defines, so an older build that lacks
-- one blend mode doesn't break the whole extension at load time.
local function enumMap(enum, pairsList)
  local byName, byValue = {}, {}
  for _, pair in ipairs(pairsList) do
    local value = enum[pair[2]]
    if value ~= nil then
      byName[pair[1]] = value
      byValue[value] = pair[1]
    end
  end
  return byName, byValue
end

U.BLEND_MODES, U.BLEND_MODE_NAMES = enumMap(BlendMode, {
  { "normal", "NORMAL" }, { "multiply", "MULTIPLY" }, { "screen", "SCREEN" },
  { "overlay", "OVERLAY" }, { "darken", "DARKEN" }, { "lighten", "LIGHTEN" },
  { "color_dodge", "COLOR_DODGE" }, { "color_burn", "COLOR_BURN" },
  { "hard_light", "HARD_LIGHT" }, { "soft_light", "SOFT_LIGHT" },
  { "difference", "DIFFERENCE" }, { "exclusion", "EXCLUSION" },
  { "hue", "HSL_HUE" }, { "saturation", "HSL_SATURATION" }, { "color", "HSL_COLOR" },
  { "luminosity", "HSL_LUMINOSITY" }, { "addition", "ADDITION" },
  { "subtract", "SUBTRACT" }, { "divide", "DIVIDE" },
})

U.ANI_DIRS, U.ANI_DIR_NAMES = enumMap(AniDir, {
  { "forward", "FORWARD" }, { "reverse", "REVERSE" },
  { "pingpong", "PING_PONG" }, { "pingpong_reverse", "PING_PONG_REVERSE" },
})

-- gsub with a lookup table runs the whole loop in C: ~4 ms for a 256x256 RGBA image,
-- versus hundreds of ms for per-pixel getPixel + string.format.
local HEX, UNHEX = {}, {}
for i = 0, 255 do
  local h = string.format("%02x", i)
  local c = string.char(i)
  HEX[c] = h
  UNHEX[h] = c
end

function U.toHex(bytes)
  return (bytes:gsub(".", HEX))
end

function U.fromHex(hex)
  if #hex % 2 ~= 0 then error("Pixel data has an odd number of hex digits") end
  return (hex:gsub("..", UNHEX))
end

function U.colorToHex(c)
  return string.format("%02x%02x%02x%02x", c.red, c.green, c.blue, c.alpha)
end

function U.hexToColor(hex)
  hex = tostring(hex):gsub("^#", "")
  if #hex ~= 6 and #hex ~= 8 then error("Invalid color: " .. hex) end
  return Color{
    r = tonumber(hex:sub(1, 2), 16),
    g = tonumber(hex:sub(3, 4), 16),
    b = tonumber(hex:sub(5, 6), 16),
    a = #hex == 8 and tonumber(hex:sub(7, 8), 16) or 255,
  }
end

-- Sprites ------------------------------------------------------------------

function U.sprite(p)
  if p and p.sprite ~= nil then
    for _, s in ipairs(app.sprites) do
      if s.id == p.sprite then return s end
    end
    error("Sprite " .. tostring(p.sprite) .. " is not open anymore")
  end
  local sprite = app.sprite
  if not sprite then error("No sprite is open in Aseprite") end
  return sprite
end

-- Commands (resize, undo, export, ...) act on the active sprite. Background jobs may
-- target another tab, so switch to it for the call and give the user their tab back.
function U.withActive(sprite, fn)
  local previous = app.sprite
  if previous ~= sprite then app.sprite = sprite end
  local ok, result = pcall(fn)
  if previous and previous ~= sprite then
    pcall(function() app.sprite = previous end)
  end
  if not ok then error(result, 0) end
  return result
end

function U.rect(p, sprite)
  return {
    x = math.floor(p.x or 0),
    y = math.floor(p.y or 0),
    width = math.floor(p.width or sprite.width),
    height = math.floor(p.height or sprite.height),
  }
end

-- Frames -------------------------------------------------------------------

function U.frameNumber(sprite, n)
  if n == nil then
    if app.sprite == sprite and app.frame then return app.frame.frameNumber end
    return 1
  end
  n = math.floor(n)
  if n < 1 or n > #sprite.frames then
    error(string.format("Frame %d out of range (sprite has %d frames)", n, #sprite.frames))
  end
  return n
end

-- Layers -------------------------------------------------------------------

-- sprite.layers only lists top-level layers, so walk groups to reach nested ones.
function U.eachLayer(layers, fn, prefix)
  for _, layer in ipairs(layers) do
    local path = prefix and (prefix .. "/" .. layer.name) or layer.name
    fn(layer, path, prefix)
    if layer.isGroup then U.eachLayer(layer.layers, fn, path) end
  end
end

function U.findLayer(sprite, name)
  local found
  U.eachLayer(sprite.layers, function(layer, path)
    if not found and (path == name) then found = layer end
  end)
  if found then return found end
  U.eachLayer(sprite.layers, function(layer)
    if not found and layer.name == name then found = layer end
  end)
  return found
end

function U.requireLayer(sprite, name)
  local layer = U.findLayer(sprite, name)
  if not layer then error("Layer not found: " .. tostring(name)) end
  return layer
end

-- The active layer only counts if it belongs to this sprite; otherwise use the top
-- image layer so jobs on a background tab still have a sensible default.
function U.defaultLayer(sprite)
  if app.sprite == sprite and app.layer and app.layer.isImage then return app.layer end
  local top
  U.eachLayer(sprite.layers, function(layer)
    if layer.isImage then top = layer end
  end)
  return top
end

function U.checkWritable(layer)
  if layer.isGroup then error("Layer is a group: " .. layer.name) end
  if layer.isTilemap then error("Tilemap layers are not supported: " .. layer.name) end
  if not layer.isEditable then error("Layer is locked: " .. layer.name) end
  -- Locking a group locks everything inside it in the UI, so honour it here too.
  local parent = layer.parent
  while parent ~= nil and parent ~= layer.sprite do
    if not parent.isEditable then error("Layer " .. layer.name .. " is inside the locked group " .. parent.name) end
    parent = parent.parent
  end
  return layer
end

-- Named layers are created on demand so the AI can keep its work on its own layer.
function U.writableLayer(sprite, name)
  if name == nil then
    local layer = U.defaultLayer(sprite)
    if not layer then error("Sprite has no image layer") end
    return U.checkWritable(layer)
  end
  local layer = U.findLayer(sprite, name)
  if not layer then
    layer = sprite:newLayer()
    layer.name = name
  end
  return U.checkWritable(layer)
end

-- Images -------------------------------------------------------------------

-- A blank image in the sprite's color mode, cleared to its transparent color
-- (index 0 is not always transparent in indexed sprites).
function U.blankImage(sprite, width, height)
  local spec = sprite.spec
  spec.width = width
  spec.height = height
  local img = Image(spec)
  img:clear()
  return img
end

function U.paletteHex(sprite)
  local palette = sprite.palettes[1]
  local colors = {}
  for i = 0, #palette - 1 do
    colors[#colors + 1] = U.colorToHex(palette:getColor(i))
  end
  return colors
end

return U
