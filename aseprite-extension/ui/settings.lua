-- Typed view over plugin.preferences: every UI choice has a default and a validator.
-- Aseprite persists the prefs table as-is, so a hand-edited or older __pref.lua can hold
-- anything; reading through here means a bad value falls back instead of breaking the UI.
-- Keys stay flat and identifier-shaped because the prefs file is serialized Lua.

return function(C)
  local S = {}

  local TABS = {
    { id = "chat" }, { id = "generate" }, { id = "animate" }, { id = "tools" }, { id = "settings" },
  }

  local SCHEMA = {
    tab = { kind = "enum", list = TABS, default = "chat" },

    provider = { kind = "optstring" },
    model = { kind = "optstring" },
    effort = { kind = "optstring", default = "medium" },
    useSelection = { kind = "bool", default = true },
    autoReview = { kind = "bool", default = false },
    showTools = { kind = "bool", default = true },

    genPrompt = { kind = "string", default = "" },
    genSize = { kind = "enum", list = C.SIZES, default = "32" },
    genStyle = { kind = "enum", list = C.STYLES, default = "auto" },
    genPalette = { kind = "enum", list = C.PALETTES, default = "auto" },
    genView = { kind = "enum", list = C.VIEWS, default = "front" },
    genTarget = { kind = "enum", list = C.TARGETS, default = "new_sprite" },
    genOutline = { kind = "bool", default = true },
    genTransparent = { kind = "bool", default = true },
    genVariations = { kind = "enum", list = C.VARIATIONS, default = "1" },
    genBatch = { kind = "string", default = "" },

    animPreset = { kind = "enum", list = C.ANIMATIONS, default = "idle" },
    animFrames = { kind = "int", min = 2, max = 16, default = 4 },
    animFrameMs = { kind = "int", min = 10, max = 2000, default = 200 },
    animLoop = { kind = "bool", default = true },
    animNotes = { kind = "string", default = "" },

    toolSelectionOnly = { kind = "bool", default = false },
    toolAllFrames = { kind = "bool", default = false },
    toolTolerance = { kind = "int", min = 0, max = 100, default = 10 },
    toolOutlinePlacement = { kind = "enum", list = C.OUTLINE_PLACEMENTS, default = "outside" },
    toolOutlineColor = { kind = "color", default = "000000ff" },
    toolColors = { kind = "int", min = 2, max = 64, default = 16 },
    toolDither = { kind = "enum", list = C.DITHERS, default = "none" },
    toolPalette = { kind = "enum", list = C.PALETTE_PRESETS, default = "pico8" },
    toolHue = { kind = "int", min = -180, max = 180, default = 0 },
    toolSaturation = { kind = "int", min = -100, max = 100, default = 0 },
    toolLightness = { kind = "int", min = -100, max = 100, default = 0 },

    port = { kind = "int", min = 1, max = 65535, default = 7801 },
    devMode = { kind = "bool", default = false },

    ui_x = { kind = "optint" },
    ui_y = { kind = "optint" },
    ui_w = { kind = "optint" },
    ui_h = { kind = "optint" },
  }

  local MAX_TEXT = 4000

  local function normalize(spec, value)
    local kind = spec.kind
    if kind == "bool" then
      if type(value) == "boolean" then return value end
      return spec.default
    elseif kind == "string" then
      if type(value) ~= "string" then return spec.default end
      return value:sub(1, MAX_TEXT)
    elseif kind == "optstring" then
      if type(value) == "string" and value ~= "" then return value:sub(1, 200) end
      return spec.default
    elseif kind == "enum" then
      if type(value) == "string" and C.find(spec.list, value) then return value end
      return spec.default
    elseif kind == "int" or kind == "optint" then
      local n = tonumber(value)
      if n == nil or n ~= n then return spec.default end -- n ~= n catches NaN
      n = math.floor(n + 0.5)
      if spec.min and n < spec.min then n = spec.min end
      if spec.max and n > spec.max then n = spec.max end
      return n
    elseif kind == "color" then
      if type(value) ~= "string" then return spec.default end
      local hex = value:gsub("^#", ""):lower()
      if #hex == 6 then hex = hex .. "ff" end
      if #hex == 8 and not hex:find("[^0-9a-f]") then return hex end
      return spec.default
    end
    return spec.default
  end

  local function specOf(key)
    local spec = SCHEMA[key]
    if not spec then error("Unknown setting: " .. tostring(key), 3) end
    return spec
  end

  function S.get(prefs, key)
    return normalize(specOf(key), prefs and prefs[key])
  end

  -- Stores the normalized value and returns it, so callers can reflect a clamp in the UI.
  function S.set(prefs, key, value)
    local stored = normalize(specOf(key), value)
    if prefs then prefs[key] = stored end
    return stored
  end

  function S.default(key)
    return specOf(key).default
  end

  -- The value S.set would store, without storing it.
  function S.coerce(key, value)
    return normalize(specOf(key), value)
  end

  function S.snapshot(prefs)
    local out = {}
    for key, spec in pairs(SCHEMA) do out[key] = normalize(spec, prefs and prefs[key]) end
    return out
  end

  S.TAB_IDS = {}
  for i, t in ipairs(TABS) do S.TAB_IDS[i] = t.id end

  return S
end
