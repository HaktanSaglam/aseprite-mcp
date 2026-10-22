-- Layer management: add, delete, update, move, duplicate, merge, activate.

return function(U)
  local M = {}

  local function placeAbove(layer, anchor)
    layer.parent = anchor.parent
    layer.stackIndex = anchor.stackIndex + 1
  end

  local function placeBelow(layer, anchor)
    layer.parent = anchor.parent
    layer.stackIndex = anchor.stackIndex
  end

  local function setGroup(sprite, layer, groupName)
    if groupName == "" then
      layer.parent = sprite
      return
    end
    local group = U.requireLayer(sprite, groupName)
    if not group.isGroup then error("Not a group: " .. groupName) end
    layer.parent = group
  end

  local OPS = {
    add = function(sprite, p)
      if not p.name then error("name is required") end
      local layer = p.isGroup and sprite:newGroup() or sprite:newLayer()
      layer.name = p.name
      if p.group then setGroup(sprite, layer, p.group) end
      if p.above then placeAbove(layer, U.requireLayer(sprite, p.above)) end
      return layer
    end,

    delete = function(sprite, p)
      local layer = U.requireLayer(sprite, p.name)
      local count = 0
      U.eachLayer(sprite.layers, function(l) if not l.isGroup then count = count + 1 end end)
      if not layer.isGroup and count <= 1 then error("Can't delete the sprite's only layer") end
      sprite:deleteLayer(layer)
    end,

    update = function(sprite, p)
      local layer = U.requireLayer(sprite, p.name)
      if p.newName then layer.name = p.newName end
      if p.visible ~= nil then layer.isVisible = p.visible end
      if p.editable ~= nil then layer.isEditable = p.editable end
      if p.opacity ~= nil then layer.opacity = math.max(0, math.min(255, math.floor(p.opacity))) end
      if p.blendMode then
        local mode = U.BLEND_MODES[p.blendMode]
        if not mode then error("Unknown blend mode: " .. tostring(p.blendMode)) end
        layer.blendMode = mode
      end
      return layer
    end,

    move = function(sprite, p)
      local layer = U.requireLayer(sprite, p.name)
      if p.group ~= nil then setGroup(sprite, layer, p.group) end
      if p.above then placeAbove(layer, U.requireLayer(sprite, p.above)) end
      if p.below then placeBelow(layer, U.requireLayer(sprite, p.below)) end
      return layer
    end,

    duplicate = function(sprite, p)
      local layer = U.requireLayer(sprite, p.name)
      local copy
      U.withActive(sprite, function()
        app.layer = layer
        app.command.DuplicateLayer()
        copy = app.layer
      end)
      if p.newName then copy.name = p.newName end
      return copy
    end,

    merge_down = function(sprite, p)
      local layer = U.requireLayer(sprite, p.name)
      local merged
      U.withActive(sprite, function()
        app.layer = layer
        app.command.MergeDownLayer()
        merged = app.layer
      end)
      return merged
    end,

    activate = function(sprite, p)
      local layer = U.requireLayer(sprite, p.name)
      app.sprite = sprite
      app.layer = layer
      return layer
    end,
  }

  -- Commands like DuplicateLayer create their own undo step, so only the plain
  -- property edits are wrapped in a transaction.
  local NO_TRANSACTION = { duplicate = true, merge_down = true, activate = true }

  function M.layer_op(p)
    local sprite = U.sprite(p)
    local op = OPS[p.op]
    if not op then error("Unknown layer_op: " .. tostring(p.op)) end
    local layer
    if NO_TRANSACTION[p.op] then
      layer = op(sprite, p)
    else
      app.transaction("AI: layer " .. p.op, function() layer = op(sprite, p) end)
    end
    app.refresh()
    return { ok = true, layer = layer and layer.name or nil }
  end

  return M
end
