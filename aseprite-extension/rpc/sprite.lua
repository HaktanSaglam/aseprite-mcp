-- Sprite-level methods: info, creation, canvas operations, undo, save and export.

return function(U)
  local M = {}

  local function selectionBounds(sprite)
    if sprite.selection.isEmpty then return nil end
    local b = sprite.selection.bounds
    return { x = b.x, y = b.y, width = b.width, height = b.height }
  end

  function M.spriteInfo(sprite)
    local layers = {}
    U.eachLayer(sprite.layers, function(layer, path, parentPath)
      layers[#layers + 1] = {
        name = layer.name,
        path = path,
        isGroup = layer.isGroup,
        isVisible = layer.isVisible,
        isEditable = layer.isEditable,
        opacity = layer.opacity or 255,
        blendMode = U.BLEND_MODE_NAMES[layer.blendMode] or "normal",
        stackIndex = layer.stackIndex,
        parent = parentPath,
      }
    end)

    local frames = {}
    for i, f in ipairs(sprite.frames) do
      frames[i] = { index = i, durationMs = math.floor(f.duration * 1000 + 0.5) }
    end

    local tags = {}
    for _, t in ipairs(sprite.tags) do
      tags[#tags + 1] = {
        name = t.name,
        from = t.fromFrame.frameNumber,
        to = t.toFrame.frameNumber,
        direction = U.ANI_DIR_NAMES[t.aniDir] or "forward",
        repeats = t.repeats or 0,
      }
    end

    local isActive = app.sprite == sprite
    local activeLayer = nil
    if isActive and app.layer then activeLayer = app.layer.name end

    return {
      id = sprite.id,
      filename = sprite.filename,
      width = sprite.width,
      height = sprite.height,
      colorMode = U.COLOR_MODE_NAMES[sprite.colorMode] or "unknown",
      frames = frames,
      layers = layers,
      tags = tags,
      activeFrame = U.frameNumber(sprite, nil),
      activeLayer = activeLayer,
      selection = selectionBounds(sprite),
      paletteSize = #sprite.palettes[1],
      transparentIndex = sprite.transparentColor,
    }
  end

  function M.ping()
    return { pong = true, version = tostring(app.version) }
  end

  function M.list_sprites()
    local list = {}
    for _, s in ipairs(app.sprites) do
      list[#list + 1] = {
        id = s.id,
        filename = s.filename,
        width = s.width,
        height = s.height,
        colorMode = U.COLOR_MODE_NAMES[s.colorMode] or "unknown",
        frames = #s.frames,
        isActive = app.sprite == s,
      }
    end
    return { sprites = list }
  end

  function M.activate_sprite(p)
    app.sprite = U.sprite(p)
    return { ok = true }
  end

  function M.get_sprite_info(p)
    return M.spriteInfo(U.sprite(p))
  end

  function M.create_sprite(p)
    local mode = U.COLOR_MODES[p.colorMode or "rgb"]
    if not mode then error("Unknown color mode: " .. tostring(p.colorMode)) end
    local sprite = Sprite(math.floor(p.width), math.floor(p.height), mode)
    -- Unsaved sprites all show "Sprite" as tab title; a name tells parallel results apart.
    if p.name and p.name ~= "" then sprite.filename = p.name end
    app.transaction("AI: new sprite", function()
      local frames = math.floor(p.frames or 1)
      for i = 2, frames do sprite:newEmptyFrame(i) end
      if p.background then
        local color = U.hexToColor(p.background)
        local layer = sprite.layers[1]
        for i = 1, #sprite.frames do
          local img = U.blankImage(sprite, sprite.width, sprite.height)
          img:clear(color)
          sprite:newCel(layer, i, img, Point(0, 0))
        end
      end
    end)
    app.refresh()
    return M.spriteInfo(sprite)
  end

  local FLIP = { horizontal = "horizontal", vertical = "vertical" }

  local OPS = {
    resize = function(sprite, p)
      app.command.SpriteSize{
        ui = false,
        width = math.floor(p.width),
        height = math.floor(p.height),
        lockRatio = false,
        method = p.method or "nearest",
      }
    end,
    canvas = function(sprite, p)
      app.command.CanvasSize{
        ui = false,
        left = math.floor(p.left or 0),
        top = math.floor(p.top or 0),
        right = math.floor(p.right or 0),
        bottom = math.floor(p.bottom or 0),
        trimOutside = true,
      }
    end,
    crop = function(sprite, p)
      sprite:crop(math.floor(p.x), math.floor(p.y), math.floor(p.width), math.floor(p.height))
    end,
    color_mode = function(sprite, p)
      local formats = { rgb = "rgb", grayscale = "gray", indexed = "indexed" }
      local format = formats[p.mode]
      if not format then error("Unknown color mode: " .. tostring(p.mode)) end
      app.command.ChangePixelFormat{ format = format }
    end,
    rotate = function(sprite, p)
      local angle = tostring(math.floor(p.angle or 90))
      if angle ~= "90" and angle ~= "180" and angle ~= "270" then
        error("Angle must be 90, 180 or 270")
      end
      -- Aseprite's Rotate command uses "-90" for 270 degrees clockwise.
      app.command.Rotate{ target = "canvas", angle = angle == "270" and "-90" or angle }
    end,
    flip = function(sprite, p)
      local orientation = FLIP[p.direction or "horizontal"]
      if not orientation then error("direction must be horizontal or vertical") end
      app.command.Flip{ target = "canvas", orientation = orientation }
    end,
  }

  function M.sprite_op(p)
    local sprite = U.sprite(p)
    local op = OPS[p.op]
    if not op then error("Unknown sprite_op: " .. tostring(p.op)) end
    U.withActive(sprite, function() op(sprite, p) end)
    app.refresh()
    return M.spriteInfo(sprite)
  end

  local function repeatCommand(p, command)
    local sprite = U.sprite(p)
    local steps = math.max(1, math.floor(p.steps or 1))
    U.withActive(sprite, function()
      for _ = 1, steps do command() end
    end)
    app.refresh()
    return { ok = true }
  end

  function M.undo(p)
    return repeatCommand(p, function() app.command.Undo() end)
  end

  function M.redo(p)
    return repeatCommand(p, function() app.command.Redo() end)
  end

  function M.save_sprite(p)
    local sprite = U.sprite(p)
    local path = p.path
    if not path then
      if not sprite.filename:find("[/\\]") then
        error("This sprite has never been saved; pass a path")
      end
      path = sprite.filename
    end
    if p.copy then sprite:saveCopyAs(path) else sprite:saveAs(path) end
    return { ok = true, path = path }
  end

  local SHEET_TYPES = {
    horizontal = SpriteSheetType.HORIZONTAL,
    vertical = SpriteSheetType.VERTICAL,
    rows = SpriteSheetType.ROWS,
    columns = SpriteSheetType.COLUMNS,
    packed = SpriteSheetType.PACKED,
  }

  function M.export_sprite(p)
    local sprite = U.sprite(p)
    local path = p.path
    if not path then error("path is required") end
    local scale = p.scale or 1
    U.withActive(sprite, function()
      if p.kind == "sheet" then
        local args = {
          ui = false,
          askOverwrite = false,
          type = SHEET_TYPES[p.sheetType or "horizontal"] or SpriteSheetType.HORIZONTAL,
          textureFilename = path,
          openGenerated = false,
        }
        if p.dataPath then
          args.dataFilename = p.dataPath
          args.dataFormat = SpriteSheetDataFormat.JSON_ARRAY
        end
        if p.columns then args.columns = math.floor(p.columns) end
        if p.tag then args.tag = p.tag end
        app.command.ExportSpriteSheet(args)
      else
        local args = { ui = false, filename = path, scale = scale }
        if p.tag then args.tag = p.tag end
        if p.kind == "png" then
          local frame = U.frameNumber(sprite, p.frame)
          args.fromFrame = frame
          args.toFrame = frame
        end
        app.command.SaveFileCopyAs(args)
      end
    end)
    return { ok = true, path = path }
  end

  return M
end
