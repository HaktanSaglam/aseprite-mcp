-- Frames and animation tags.

return function(U)
  local M = {}

  -- See U.transaction: one undo step, also on a background tab.
  local transaction = U.transaction

  -- sprite:newFrame() has surprising numbering in scripts, so insert empty frames and
  -- copy cels explicitly.
  local function copyCels(sprite, from, to)
    U.eachLayer(sprite.layers, function(layer)
      if layer.isImage then
        local cel = layer:cel(from)
        if cel then
          local copy = sprite:newCel(layer, to, cel.image:clone(), cel.position)
          copy.opacity = cel.opacity
        end
      end
    end)
  end

  local FLIPS = { horizontal = FlipType.HORIZONTAL, vertical = FlipType.VERTICAL }

  -- copy_cel without a layer copies every layer it may write: locked layers (or layers
  -- in a locked group) and tilemaps are skipped instead of failing the whole copy.
  -- includeLocked also copies locked layers, never flipped, the way a new frame copies
  -- every layer: a locked ground or shadow stays put while the character turns.
  -- Returns the layers and, per layer, whether it is only carried over (locked).
  local function copyTargets(sprite, name, includeLocked)
    if name ~= nil then return { U.checkWritable(U.requireLayer(sprite, name)) }, {} end
    local layers, carried = {}, {}
    U.eachLayer(sprite.layers, function(layer)
      if not layer.isImage or layer.isTilemap then return end
      local writable = pcall(U.checkWritable, layer)
      if writable or includeLocked then
        layers[#layers + 1] = layer
        carried[layer] = not writable
      end
    end)
    return layers, carried
  end

  -- The cel's image (a copy) and where it goes, mirrored across the whole canvas so a
  -- character standing in the middle stays in the middle.
  local function placedImage(sprite, cel, flip)
    local image = cel.image:clone()
    local pos = cel.position
    if flip == "horizontal" then
      image:flip(FLIPS.horizontal)
      pos = Point(sprite.width - pos.x - image.width, pos.y)
    elseif flip == "vertical" then
      image:flip(FLIPS.vertical)
      pos = Point(pos.x, sprite.height - pos.y - image.height)
    end
    return image, pos
  end

  local FRAME_OPS = {
    add = function(sprite, p)
      local after = p.after and U.frameNumber(sprite, p.after) or #sprite.frames
      local count = math.max(1, math.floor(p.count or 1))
      local duration = p.durationMs and (p.durationMs / 1000) or sprite.frames[after].duration
      for i = 1, count do
        local n = after + i
        local frame = sprite:newEmptyFrame(n)
        frame.duration = duration
        if p.copy then copyCels(sprite, after, n) end
      end
    end,

    delete = function(sprite, p)
      local from = U.frameNumber(sprite, p.from)
      local to = U.frameNumber(sprite, p.to or p.from)
      if to - from + 1 >= #sprite.frames then error("Cannot delete every frame") end
      for n = to, from, -1 do sprite:deleteFrame(n) end
    end,

    duration = function(sprite, p)
      if not p.durationMs then error("durationMs is required") end
      local seconds = math.max(1, p.durationMs) / 1000
      if p.frames then
        for _, n in ipairs(p.frames) do sprite.frames[U.frameNumber(sprite, n)].duration = seconds end
      else
        for _, frame in ipairs(sprite.frames) do frame.duration = seconds end
      end
    end,

    -- The target frame ends up exactly like the source frame on those layers: a source
    -- frame without a cel there clears the target's cel.
    copy_cel = function(sprite, p)
      if p.from == nil or p.to == nil then error("copy_cel needs from and to") end
      local from = U.frameNumber(sprite, p.from)
      local to = U.frameNumber(sprite, p.to)
      if p.flip ~= nil and not FLIPS[p.flip] then
        error("Unknown flip: " .. tostring(p.flip) .. " (horizontal or vertical)")
      end
      local layers, carried = copyTargets(sprite, p.layer, p.includeLocked == true)
      for _, layer in ipairs(layers) do
        local source = layer:cel(from)
        if source then
          -- Read before newCel: with from == to it replaces (deletes) the source cel.
          local image, pos = placedImage(sprite, source, (not carried[layer]) and p.flip or nil)
          local opacity = source.opacity
          local copy = sprite:newCel(layer, to, image, pos)
          copy.opacity = opacity
        elseif layer:cel(to) then
          sprite:deleteCel(layer:cel(to))
        end
      end
    end,

    activate = function(sprite, p)
      app.sprite = sprite
      app.frame = sprite.frames[U.frameNumber(sprite, p.frame)]
    end,
  }

  function M.frame_op(p)
    local sprite = U.sprite(p)
    local op = FRAME_OPS[p.op]
    if not op then error("Unknown frame_op: " .. tostring(p.op)) end
    if p.op == "activate" then
      op(sprite, p)
    else
      transaction(sprite, "AI: frames " .. p.op, function() op(sprite, p) end)
    end
    app.refresh()
    return { ok = true, frames = #sprite.frames }
  end

  local function findTag(sprite, name)
    for _, tag in ipairs(sprite.tags) do
      if tag.name == name then return tag end
    end
    error("Tag not found: " .. tostring(name))
  end

  local function applyTagProps(sprite, tag, p)
    if p.newName then tag.name = p.newName end
    if p.from then tag.fromFrame = sprite.frames[U.frameNumber(sprite, p.from)] end
    if p.to then tag.toFrame = sprite.frames[U.frameNumber(sprite, p.to)] end
    if p.direction then
      local dir = U.ANI_DIRS[p.direction]
      if not dir then error("Unknown direction: " .. tostring(p.direction)) end
      tag.aniDir = dir
    end
    if p.repeats ~= nil then tag.repeats = math.floor(p.repeats) end
    if p.color then tag.color = U.hexToColor(p.color) end
  end

  local TAG_OPS = {
    add = function(sprite, p)
      if not p.name then error("name is required") end
      local tag = sprite:newTag(U.frameNumber(sprite, p.from or 1), U.frameNumber(sprite, p.to or #sprite.frames))
      tag.name = p.name
      applyTagProps(sprite, tag, { direction = p.direction, repeats = p.repeats, color = p.color })
    end,
    update = function(sprite, p)
      applyTagProps(sprite, findTag(sprite, p.name), p)
    end,
    delete = function(sprite, p)
      sprite:deleteTag(findTag(sprite, p.name))
    end,
  }

  function M.tag_op(p)
    local sprite = U.sprite(p)
    local op = TAG_OPS[p.op]
    if not op then error("Unknown tag_op: " .. tostring(p.op)) end
    transaction(sprite, "AI: tag " .. p.op, function() op(sprite, p) end)
    app.refresh()
    return { ok = true }
  end

  return M
end
