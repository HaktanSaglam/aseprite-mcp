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
    -- The path, not the bare name: the model passes it back as `layer`, and a bare
    -- "Shade" resolves to the first "Shade" in the stack, maybe in another group.
    if isActive and app.layer then activeLayer = U.layerPath(app.layer) end

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

  local function hasPixels(sprite)
    for _, cel in ipairs(sprite.cels) do
      if not cel.image:isEmpty() then return true end
    end
    return false
  end

  -- Closes a sprite without asking to save. onlyIfEmpty (what the bridge uses after a
  -- generation was stopped or failed) never discards a single drawn pixel.
  function M.close_sprite(p)
    local sprite = U.sprite(p)
    if p.onlyIfEmpty and hasPixels(sprite) then return { closed = false } end
    sprite:close()
    return { closed = true }
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
    -- Validate everything before Sprite(): it opens a tab outside any transaction, so a
    -- later error would leave an empty orphan tab behind on every retry.
    local background = p.background ~= nil and U.hexToColor(p.background) or nil
    local sprite = Sprite(math.floor(p.width), math.floor(p.height), mode)
    -- Unsaved sprites all show "Sprite" as tab title; a name tells parallel results apart.
    if p.name and p.name ~= "" then sprite.filename = p.name end
    app.transaction("AI: new sprite", function()
      local frames = math.floor(p.frames or 1)
      for i = 2, frames do sprite:newEmptyFrame(i) end
      -- Adding frames moves the playhead to the last one; a new sprite starts at frame 1.
      if frames > 1 and app.sprite == sprite then app.frame = sprite.frames[1] end
      if background then
        local layer = sprite.layers[1]
        for i = 1, #sprite.frames do
          local img = U.blankImage(sprite, sprite.width, sprite.height)
          img:clear(background)
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

  -- Frame files of a "frames" export: hero-1.png ... hero-12.png → hero-01.png ...
  -- (zero-padded to the frame count). The bridge predicts the same names.
  function M.sequenceName(stem, ext, frame, frameCount)
    local digits = #tostring(frameCount)
    return string.format("%s-%0" .. digits .. "d%s", stem, frame, ext)
  end

  local function findTag(sprite, name)
    for _, tag in ipairs(sprite.tags) do
      if tag.name == name then return tag end
    end
    error("Tag not found: " .. tostring(name))
  end

  -- Renders one frame (visible layers) and saves it, scaled by whole pixels.
  -- SaveFileCopyAs can't do this reliably: its frame range is 0-based with 0 meaning
  -- "all frames", and a file name ending in a digit turns into a numbered sequence.
  local function saveFrame(sprite, frame, scale, path)
    local img = Image(sprite.width, sprite.height, ColorMode.RGB)
    img:drawSprite(sprite, frame)
    local factor = math.max(1, math.floor(scale))
    if factor > 1 then
      img:resize{ width = sprite.width * factor, height = sprite.height * factor, method = "nearest" }
    end
    img:saveAs(path)
  end

  -- GIFs go through a flattened copy: with one layer and no tags Aseprite saves without
  -- its modal "this format doesn't support layers/tags" questions, which would block
  -- every bridge request until someone clicks them away. saveAs (not saveCopyAs) marks
  -- the copy as saved, so closing it doesn't ask about unsaved changes either.
  local function saveAnimation(sprite, first, last, scale, path)
    local factor = math.max(1, math.floor(scale))
    local w, h = sprite.width * factor, sprite.height * factor
    local tmp = Sprite(w, h, ColorMode.RGB)
    local ok, err = pcall(function()
      for f = first, last do
        local n = f - first + 1
        if n > 1 then tmp:newEmptyFrame(n) end
        local img = Image(sprite.width, sprite.height, ColorMode.RGB)
        img:drawSprite(sprite, f)
        if factor > 1 then img:resize{ width = w, height = h, method = "nearest" } end
        tmp:newCel(tmp.layers[1], n, img, Point(0, 0))
        tmp.frames[n].duration = sprite.frames[f].duration
      end
      tmp:saveAs(path)
    end)
    tmp:close()
    if not ok then error(err, 0) end
  end

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
      elseif p.kind == "png" then
        saveFrame(sprite, U.frameNumber(sprite, p.frame), scale, path)
      elseif p.kind == "frames" then
        local first, last = 1, #sprite.frames
        if p.tag then
          local tag = findTag(sprite, p.tag)
          first, last = tag.fromFrame.frameNumber, tag.toFrame.frameNumber
        end
        local stem, ext = path:match("^(.*)(%.[^./\\]+)$")
        if not stem then error("path needs an extension") end
        for frame = first, last do
          saveFrame(sprite, frame, scale, M.sequenceName(stem, ext, frame, #sprite.frames))
        end
      else
        local first, last = 1, #sprite.frames
        if p.tag then
          local tag = findTag(sprite, p.tag)
          first, last = tag.fromFrame.frameNumber, tag.toFrame.frameNumber
        end
        saveAnimation(sprite, first, last, scale, path)
      end
    end)
    -- saveAnimation opened and closed a temporary tab; give the user theirs back.
    pcall(function() app.sprite = sprite end)
    return { ok = true, path = path }
  end

  return M
end
