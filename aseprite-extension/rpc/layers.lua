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

  -- Aseprite's MergeDownLayer silently does nothing unless both layers hold plain
  -- pixels, so check first and the caller gets a reason instead of a fake "ok".
  local function mergeableKind(layer)
    if layer.isGroup then return "a group" end
    if layer.isTilemap then return "a tilemap layer" end
    local okRef, isReference = pcall(function() return layer.isReference end)
    if okRef and isReference then return "a reference layer" end
    return nil
  end

  local function layerBelow(layer)
    local index = layer.stackIndex
    if index <= 1 then return nil end
    return layer.parent.layers[index - 1]
  end

  local function checkMergeDown(layer)
    local kind = mergeableKind(layer)
    if kind then error('Cannot merge down "' .. U.layerPath(layer) .. '": it is ' .. kind) end
    local below = layerBelow(layer)
    if not below then
      error('Cannot merge down "' .. U.layerPath(layer) .. '": there is no layer below it in its group')
    end
    kind = mergeableKind(below)
    if kind then
      error('Cannot merge "' .. U.layerPath(layer) .. '" into "' .. U.layerPath(below) .. '": that is ' .. kind)
    end
    return below
  end

  local OPS = {
    add = function(sprite, p)
      if not p.name then error("name is required") end
      -- "group" + "name" and a "Group/Name" path both mean "inside that group".
      local path = p.name
      if p.group and p.group ~= "" then path = p.group .. "/" .. p.name end
      local layer = U.createLayer(sprite, path, p.isGroup)
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
      if p.newName then layer.name = U.plainName(p.newName) end
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

    -- Runs with the sprite active (see COMMAND_OPS), so the command and the rename
    -- land in the same transaction.
    duplicate = function(sprite, p)
      app.layer = U.requireLayer(sprite, p.name)
      app.command.DuplicateLayer()
      local copy = app.layer
      if p.newName then copy.name = U.plainName(p.newName) end
      return copy
    end,

    merge_down = function(sprite, p)
      local layer = U.requireLayer(sprite, p.name)
      local below = checkMergeDown(layer)
      local parent, count = layer.parent, #layer.parent.layers
      app.layer = layer
      app.command.MergeDownLayer()
      -- Belt and braces for refusals the checks above don't know about (e.g. a
      -- future layer kind): the source layer must be gone.
      if #parent.layers ~= count - 1 then
        error('Aseprite refused to merge "' .. U.layerPath(layer) .. '" down')
      end
      return below
    end,

    activate = function(sprite, p)
      local layer = U.requireLayer(sprite, p.name)
      app.sprite = sprite
      app.layer = layer
      return layer
    end,
  }

  -- Commands act on the active sprite and app.transaction only groups changes of the
  -- active sprite: U.transaction makes it active for the call, so commands join the open
  -- transaction too (duplicate + rename is ONE undo step), on any tab.
  local function inTransaction(sprite, p, op)
    local layer
    U.transaction(sprite, "AI: layer " .. p.op, function() layer = op(sprite, p) end)
    return layer
  end

  function M.layer_op(p)
    local sprite = U.sprite(p)
    local op = OPS[p.op]
    if not op then error("Unknown layer_op: " .. tostring(p.op)) end
    local layer
    -- Activating changes no document data, so there is nothing to undo.
    if p.op == "activate" then
      layer = op(sprite, p)
    else
      layer = inTransaction(sprite, p, op)
    end
    app.refresh()
    -- A path, so passing it back addresses this layer even when names repeat.
    return { ok = true, layer = layer and U.layerPath(layer) or nil }
  end

  return M
end
