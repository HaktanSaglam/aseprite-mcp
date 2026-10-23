-- The Generate tab's settings remembered per sprite: what was last generated from a sprite
-- is stored in it (sprite.properties("aseprite-mcp").generate), travels with the
-- .aseprite file when the user saves it, and comes back when that sprite is active and the
-- Generate tab opens.
--
-- Aseprite 1.3 writes properties directly: no undo step and no "modified" mark, so saving
-- them never gets between the user and Ctrl+Z (or "Undo AI run"). Everything is wrapped
-- in pcall because older versions have no sprite.properties, and a stored value is read
-- through the settings validators like any pref, since a file can hold anything.

return function(S)
  local M = {}

  M.EXTENSION_KEY = "aseprite-mcp"
  M.FIELD = "generate"

  -- Not the Reference box: sprite ids mean nothing in the next session.
  M.KEYS = {
    "genPrompt", "genSize", "genStyle", "genPalette", "genCustomPalette", "genColors",
    "genForcePalette", "genView", "genSource", "genTarget", "genVariations",
    "genOutline", "genTransparent", "genBatch",
  }

  -- The settings to store, from a settings snapshot.
  function M.capture(s)
    local out = {}
    for _, key in ipairs(M.KEYS) do out[key] = s[key] end
    return out
  end

  local function properties(sprite)
    return sprite.properties(M.EXTENSION_KEY)
  end

  -- Returns true when stored.
  function M.save(sprite, s)
    if not sprite then return false end
    local ok = pcall(function() properties(sprite)[M.FIELD] = M.capture(s) end)
    return ok
  end

  -- The stored settings as {key = value} (validated), or nil when the sprite has none.
  function M.load(sprite)
    if not sprite then return nil end
    local ok, stored = pcall(function() return properties(sprite)[M.FIELD] end)
    if not ok or type(stored) ~= "table" then return nil end
    local out, any = {}, false
    for _, key in ipairs(M.KEYS) do
      local raw = stored[key]
      if raw ~= nil then
        out[key] = S.coerce(key, raw)
        any = true
      end
    end
    return any and out or nil
  end

  -- Copies loaded settings into prefs; returns the keys whose value changed.
  function M.apply(prefs, loaded)
    local changed = {}
    for _, key in ipairs(M.KEYS) do
      local value = loaded[key]
      if value ~= nil and S.get(prefs, key) ~= value then
        S.set(prefs, key, value)
        changed[#changed + 1] = key
      end
    end
    return changed
  end

  return M
end
