-- Selection read/write. Shapes are computed by the bridge and arrive as rectangles.

return function(U)
  local M = {}

  local function boundsOf(selection)
    if selection.isEmpty then return nil end
    local b = selection.bounds
    return { x = b.x, y = b.y, width = b.width, height = b.height }
  end

  function M.read_selection(p)
    local sprite = U.sprite(p)
    local selection = sprite.selection
    local bounds = boundsOf(selection)
    if not bounds and p.width == nil then return { isEmpty = true } end

    local r = (p.width ~= nil) and U.rect(p, sprite) or bounds
    local rows = {}
    if bounds then
      for y = r.y, r.y + r.height - 1 do
        local row = {}
        for x = r.x, r.x + r.width - 1 do
          row[#row + 1] = selection:contains(x, y) and "1" or "0"
        end
        rows[#rows + 1] = table.concat(row)
      end
    else
      rows[1] = string.rep("0", r.width * r.height)
    end

    return {
      isEmpty = bounds == nil,
      bounds = bounds,
      x = r.x, y = r.y, width = r.width, height = r.height,
      mask = table.concat(rows),
    }
  end

  -- Adding Rectangles directly is ~100x faster than adding one Selection per rect
  -- (32k rects: 20 ms vs 2.5 s), which matters for color/magic-wand masks.
  local function fromRects(rects)
    local s = Selection()
    for _, r in ipairs(rects or {}) do
      s:add(Rectangle(math.floor(r[1]), math.floor(r[2]), math.floor(r[3]), math.floor(r[4])))
    end
    return s
  end

  -- Each op returns a fresh Selection; assigning sprite.selection inside a transaction
  -- makes the change undoable and repaints the marching ants.
  local OPS = {
    replace = function(sprite, p) return fromRects(p.rects) end,
    add = function(sprite, p)
      local s = Selection(); s:add(sprite.selection); s:add(fromRects(p.rects)); return s
    end,
    subtract = function(sprite, p)
      local s = Selection(); s:add(sprite.selection); s:subtract(fromRects(p.rects)); return s
    end,
    intersect = function(sprite, p)
      local s = Selection(); s:add(sprite.selection); s:intersect(fromRects(p.rects)); return s
    end,
    all = function(sprite) return Selection(sprite.bounds) end,
    none = function() return Selection() end,
    invert = function(sprite)
      local s = Selection(sprite.bounds)
      if not sprite.selection.isEmpty then s:subtract(sprite.selection) end
      return s
    end,
  }

  function M.set_selection(p)
    local sprite = U.sprite(p)
    local op = OPS[p.op or "replace"]
    if not op then error("Unknown selection op: " .. tostring(p.op)) end
    app.transaction("AI: select", function()
      sprite.selection = op(sprite, p)
    end)
    app.refresh()
    return { isEmpty = sprite.selection.isEmpty, bounds = boundsOf(sprite.selection) }
  end

  return M
end
