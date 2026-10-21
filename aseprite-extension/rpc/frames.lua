-- Frames and animation tags.

return function(U)
  local M = {}

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
      app.transaction("AI: frames " .. p.op, function() op(sprite, p) end)
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
    app.transaction("AI: tag " .. p.op, function() op(sprite, p) end)
    app.refresh()
    return { ok = true }
  end

  return M
end
