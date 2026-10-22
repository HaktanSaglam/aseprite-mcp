-- Raw pixel transfer. The bridge does all pixel math; this module only copies bytes
-- between Aseprite images and hex strings (see docs/PROTOCOL.md).

return function(U)
  local M = {}

  local function readLayer(sprite, frame, layer, rect)
    local img = U.blankImage(sprite, rect.width, rect.height)
    local cel = layer and layer:cel(frame)
    if cel then
      local pos = Point(cel.position.x - rect.x, cel.position.y - rect.y)
      img:drawImage(cel.image, pos, 255, BlendMode.SRC)
    end
    return img
  end

  function M.read_image(p)
    local sprite = U.sprite(p)
    local frame = U.frameNumber(sprite, p.frame)
    local rect = U.rect(p, sprite)
    if rect.width < 1 or rect.height < 1 then error("Region is empty") end

    local result = { x = rect.x, y = rect.y, width = rect.width, height = rect.height }

    if p.flattened then
      local img = Image(rect.width, rect.height, ColorMode.RGB)
      img:drawSprite(sprite, frame, Point(-rect.x, -rect.y))
      result.format = "rgba"
      result.data = U.toHex(img.bytes)
      return result
    end

    local layer
    if p.layer ~= nil then
      layer = U.findLayer(sprite, p.layer)
      if not layer and not p.missingOk then error("Layer not found: " .. tostring(p.layer)) end
    else
      layer = U.defaultLayer(sprite)
    end
    if layer and layer.isGroup then error("Layer is a group: " .. layer.name) end
    if layer and layer.isTilemap then error("Tilemap layers are not supported: " .. layer.name) end

    local img = readLayer(sprite, frame, layer, rect)
    result.format = U.FORMATS[sprite.colorMode]
    result.data = U.toHex(img.bytes)
    if sprite.colorMode == ColorMode.INDEXED then
      result.palette = U.paletteHex(sprite)
      result.transparentIndex = sprite.transparentColor
    end
    return result
  end

  local function decodeSource(sprite, w)
    local expected = U.FORMATS[sprite.colorMode]
    if w.format ~= expected then
      error(string.format("Pixel format %s does not match the sprite (%s)", tostring(w.format), expected))
    end
    local src = U.blankImage(sprite, math.floor(w.width), math.floor(w.height))
    local bytes = U.fromHex(w.data)
    if #bytes ~= #src.bytes then
      error(string.format("Pixel data has %d bytes, expected %d", #bytes, #src.bytes))
    end
    src.bytes = bytes
    return src
  end

  -- The area the new cel is built in, in sprite coordinates. Aseprite keeps cel pixels
  -- outside the canvas (art moved partly off-screen, a canvas shrunk without trimming);
  -- covering them too means a write never deletes art the user can't currently see.
  -- Background cels always cover exactly the canvas.
  local function workArea(sprite, layer, cel)
    local canvas = Rectangle(0, 0, sprite.width, sprite.height)
    if cel and not layer.isBackground then return canvas:union(cel.bounds) end
    return canvas
  end

  -- Incoming pixels outside the canvas are ignored (PROTOCOL.md), so only the part of
  -- the source that overlaps the canvas is drawn.
  local function drawClipped(sprite, work, area, src, x, y, blend)
    local canvas = Rectangle(0, 0, sprite.width, sprite.height)
    local clip = canvas:intersect(Rectangle(x, y, src.width, src.height))
    if clip.isEmpty then return end
    local part = src
    if clip.width ~= src.width or clip.height ~= src.height then
      part = Image(src, Rectangle(clip.x - x, clip.y - y, clip.width, clip.height))
    end
    work:drawImage(part, Point(clip.x - area.x, clip.y - area.y), 255, blend)
  end

  -- Replaces the rectangle on the layer's cel, then trims the cel back to its content.
  -- The frame always gets a cel of its own: when its cel was linked to other frames,
  -- this frame is unlinked and the other frames keep the shared image unchanged.
  local function applyWrite(sprite, w)
    local frame = U.frameNumber(sprite, w.frame)
    local layer = U.writableLayer(sprite, w.layer)
    local src = decodeSource(sprite, w)

    local cel = layer:cel(frame)
    local opacity = cel and cel.opacity or 255
    local area = workArea(sprite, layer, cel)
    local work = U.blankImage(sprite, area.width, area.height)
    if cel then
      work:drawImage(cel.image, Point(cel.position.x - area.x, cel.position.y - area.y), 255, BlendMode.SRC)
    end
    -- A Background layer has no transparency: Aseprite would show "erased" pixels as
    -- black, so transparent pixels keep what is there instead of replacing it.
    local blend = layer.isBackground and BlendMode.NORMAL or BlendMode.SRC
    drawClipped(sprite, work, area, src, math.floor(w.x), math.floor(w.y), blend)

    if layer.isBackground then
      sprite:newCel(layer, frame, work, Point(area.x, area.y))
      return U.layerPath(layer)
    end

    local bounds = work:shrinkBounds()
    if bounds.isEmpty then
      if cel then sprite:deleteCel(cel) end
    else
      local position = Point(area.x + bounds.x, area.y + bounds.y)
      local newCel = sprite:newCel(layer, frame, Image(work, bounds), position)
      newCel.opacity = opacity
    end
    return U.layerPath(layer)
  end

  function M.write_image(p)
    local sprite = U.sprite(p)
    local layerName
    -- One transaction = one Ctrl+Z step for the whole AI edit.
    app.transaction("AI: draw", function()
      layerName = applyWrite(sprite, p)
    end)
    app.refresh()
    return { ok = true, layer = layerName }
  end

  function M.write_images(p)
    local sprite = U.sprite(p)
    local count = 0
    app.transaction("AI: draw", function()
      for _, w in ipairs(p.writes) do
        applyWrite(sprite, w)
        count = count + 1
      end
    end)
    app.refresh()
    return { ok = true, count = count }
  end

  return M
end
