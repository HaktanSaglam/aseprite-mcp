-- Maps bridge methods to Aseprite operations. Each handler returns a plain table
-- (sent back as JSON) or raises an error string.

return function(pixels)
  local H = {}

  local COLOR_MODE_NAMES = {
    [ColorMode.RGB] = "rgb",
    [ColorMode.GRAY] = "grayscale",
    [ColorMode.INDEXED] = "indexed",
  }
  local COLOR_MODES = {
    rgb = ColorMode.RGB,
    grayscale = ColorMode.GRAY,
    indexed = ColorMode.INDEXED,
  }

  local function activeSprite()
    local sprite = app.sprite
    if not sprite then error("No sprite is open in Aseprite") end
    return sprite
  end

  -- sprite.layers only lists top-level layers, so walk groups to reach nested ones.
  local function eachLayer(layers, fn, prefix)
    for _, layer in ipairs(layers) do
      local path = prefix and (prefix .. "/" .. layer.name) or layer.name
      fn(layer, path)
      if layer.isGroup then eachLayer(layer.layers, fn, path) end
    end
  end

  local function findLayer(sprite, name)
    local found
    eachLayer(sprite.layers, function(layer, path)
      if not found and (layer.name == name or path == name) then found = layer end
    end)
    return found
  end

  local function resolveFrame(sprite, frame)
    local n = frame or (app.frame and app.frame.frameNumber) or 1
    if n < 1 or n > #sprite.frames then
      error(string.format("Frame %d out of range (sprite has %d frames)", n, #sprite.frames))
    end
    return n
  end

  local function resolveImageLayer(sprite, name, createIfMissing)
    local layer
    if name then
      layer = findLayer(sprite, name)
      if not layer and createIfMissing then
        layer = sprite:newLayer()
        layer.name = name
      end
      if not layer then error("Layer not found: " .. name) end
    else
      layer = app.layer
      if not layer then error("No active layer") end
    end
    if not layer.isImage then error("Layer is not an image layer: " .. layer.name) end
    return layer
  end

  local function rectFrom(p, sprite)
    return {
      x = p.x or 0,
      y = p.y or 0,
      width = p.width or sprite.width,
      height = p.height or sprite.height,
    }
  end

  local function spriteInfo(sprite)
    local layers = {}
    eachLayer(sprite.layers, function(layer, path)
      layers[#layers + 1] = {
        name = layer.name,
        path = path,
        isGroup = layer.isGroup,
        isVisible = layer.isVisible,
      }
    end)

    local frames = {}
    for i, f in ipairs(sprite.frames) do
      frames[i] = { index = i, durationMs = math.floor(f.duration * 1000 + 0.5) }
    end

    local selection = nil
    if not sprite.selection.isEmpty then
      local b = sprite.selection.bounds
      selection = { x = b.x, y = b.y, width = b.width, height = b.height }
    end

    return {
      filename = sprite.filename,
      width = sprite.width,
      height = sprite.height,
      colorMode = COLOR_MODE_NAMES[sprite.colorMode] or "unknown",
      frames = frames,
      layers = layers,
      activeFrame = app.frame and app.frame.frameNumber or 1,
      activeLayer = app.layer and app.layer.name or nil,
      selection = selection,
    }
  end

  function H.ping()
    return { pong = true, version = tostring(app.version) }
  end

  function H.get_sprite_info()
    return spriteInfo(activeSprite())
  end

  function H.create_sprite(p)
    local mode = COLOR_MODES[p.colorMode or "rgb"]
    if not mode then error("Unknown color mode: " .. tostring(p.colorMode)) end
    local sprite = Sprite(p.width, p.height, mode)
    return spriteInfo(sprite)
  end

  function H.read_region(p)
    local sprite = activeSprite()
    local frame = resolveFrame(sprite, p.frame)
    local layer = nil
    if not p.flattened then layer = resolveImageLayer(sprite, p.layer, false) end
    local rect = rectFrom(p, sprite)
    return {
      x = rect.x, y = rect.y, width = rect.width, height = rect.height,
      rgba = pixels.readRegion(sprite, frame, layer, rect),
    }
  end

  function H.write_region(p)
    local sprite = activeSprite()
    local frame = resolveFrame(sprite, p.frame)
    local rect = rectFrom(p, sprite)
    if #p.rgba ~= rect.width * rect.height * 8 then
      error("rgba length does not match width*height")
    end
    local mask = nil
    if p.selectionOnly and not sprite.selection.isEmpty then mask = sprite.selection end

    -- One transaction = one Ctrl+Z step for the whole AI edit.
    app.transaction("Claude: draw pixels", function()
      local layer = resolveImageLayer(sprite, p.layer, true)
      pixels.writeRegion(sprite, frame, layer, rect, p.rgba, {
        eraseTransparent = p.eraseTransparent == true,
        mask = mask,
      })
    end)
    app.refresh()
    return { ok = true }
  end

  function H.get_palette()
    local sprite = activeSprite()
    local palette = sprite.palettes[1]
    local colors = {}
    for i = 0, #palette - 1 do
      colors[#colors + 1] = pixels.colorToHex(palette:getColor(i))
    end
    return { colors = colors }
  end

  function H.dispatch(method, params)
    local fn = H[method]
    if not fn or method == "dispatch" then error("Unknown method: " .. tostring(method)) end
    return fn(params or {})
  end

  return H
end
