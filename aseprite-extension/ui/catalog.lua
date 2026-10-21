-- Every choice the window offers, as {id, label} lists: ids go over the wire and into
-- prefs (stable), labels are what the user sees (free to reword). Pure data + lookups,
-- no Aseprite API, so headless tests can cover it.
--
-- Labels stay ASCII on purpose: native widgets (combobox, button) use Aseprite's pixel
-- font, which has no glyphs above U+2000, and a fallback glyph breaks the row height.

local C = {}

C.SIZES = {
  { id = "16", label = "16x16", width = 16, height = 16 },
  { id = "24", label = "24x24", width = 24, height = 24 },
  { id = "32", label = "32x32", width = 32, height = 32 },
  { id = "48", label = "48x48", width = 48, height = 48 },
  { id = "64", label = "64x64", width = 64, height = 64 },
  { id = "96", label = "96x96", width = 96, height = 96 },
  { id = "128", label = "128x128", width = 128, height = 128 },
  { id = "256", label = "256x256", width = 256, height = 256 },
  { id = "canvas", label = "Current canvas" },
}

C.STYLES = {
  { id = "auto", label = "Auto" },
  { id = "8bit", label = "8-bit NES" },
  { id = "16bit", label = "16-bit SNES" },
  { id = "gameboy", label = "Game Boy" },
  { id = "pico8", label = "PICO-8" },
  { id = "1bit", label = "1-bit" },
  { id = "hd", label = "HD pixel art" },
}

-- Shared by the Generate tab (all of them) and the Apply palette tool (presets only).
local PALETTE_PRESETS = {
  { id = "pico8", label = "PICO-8" },
  { id = "sweetie16", label = "Sweetie 16" },
  { id = "endesga32", label = "Endesga 32" },
  { id = "endesga64", label = "Endesga 64" },
  { id = "db16", label = "DB16" },
  { id = "db32", label = "DB32" },
  { id = "aap64", label = "AAP-64" },
  { id = "resurrect64", label = "Resurrect 64" },
  { id = "gameboy", label = "Game Boy" },
  { id = "nes", label = "NES" },
  { id = "1bit", label = "1-bit" },
}

C.PALETTES = { { id = "auto", label = "Auto" }, { id = "current", label = "Current" } }
for _, p in ipairs(PALETTE_PRESETS) do C.PALETTES[#C.PALETTES + 1] = p end
C.PALETTE_PRESETS = PALETTE_PRESETS

C.VIEWS = {
  { id = "front", label = "Front" },
  { id = "side", label = "Side" },
  { id = "three_quarter", label = "3/4" },
  { id = "top_down", label = "Top-down" },
  { id = "isometric", label = "Isometric" },
}

C.TARGETS = {
  { id = "new_sprite", label = "New sprite" },
  { id = "new_layer", label = "New layer" },
  { id = "active_layer", label = "Active layer" },
}

C.VARIATIONS = {
  { id = "1", label = "1", count = 1 },
  { id = "2", label = "2", count = 2 },
  { id = "3", label = "3", count = 3 },
  { id = "4", label = "4", count = 4 },
}

-- frames/frameMs/loop are what a preset suggests when the user picks it.
C.ANIMATIONS = {
  { id = "idle", label = "Idle", frames = 4, frameMs = 200, loop = true },
  { id = "walk", label = "Walk", frames = 6, frameMs = 120, loop = true },
  { id = "run", label = "Run", frames = 6, frameMs = 90, loop = true },
  { id = "jump", label = "Jump", frames = 6, frameMs = 100, loop = false },
  { id = "attack", label = "Attack", frames = 5, frameMs = 90, loop = false },
  { id = "hurt", label = "Hurt", frames = 3, frameMs = 100, loop = false },
  { id = "death", label = "Death", frames = 6, frameMs = 120, loop = false },
  { id = "custom", label = "Custom", frames = 4, frameMs = 150, loop = true },
}

-- Friendly names for the provider's reasoning effort, ordered fast -> thorough.
C.EFFORTS = {
  { id = "low", label = "Fast" },
  { id = "medium", label = "Balanced" },
  { id = "high", label = "Smart" },
  { id = "xhigh", label = "Smart+" },
  { id = "max", label = "Max" },
}

C.DITHERS = {
  { id = "none", label = "None" },
  { id = "ordered", label = "Ordered" },
  { id = "floyd", label = "Floyd-Steinberg" },
}

C.OUTLINE_PLACEMENTS = {
  { id = "outside", label = "Outside" },
  { id = "inside", label = "Inside" },
}

-- Used until the bridge sends bridge_info (or forever with an older bridge).
C.FALLBACK_PROVIDERS = {
  {
    id = "claude-code",
    label = "Claude Code",
    models = {
      { id = "fable", label = "Fable" },
      { id = "opus", label = "Opus" },
      { id = "sonnet", label = "Sonnet" },
      { id = "haiku", label = "Haiku" },
    },
    efforts = { "low", "medium", "high", "xhigh", "max" },
    available = true,
    supportsImages = true,
  },
}

-- Shown in place of an empty model/effort list so the combobox is never blank.
C.DEFAULT_LABEL = "Default"

function C.find(list, id)
  if id == nil then return nil end
  for _, item in ipairs(list) do
    if item.id == id then return item end
  end
  return nil
end

function C.findByLabel(list, label)
  if label == nil then return nil end
  for _, item in ipairs(list) do
    if item.label == label then return item end
  end
  return nil
end

function C.labels(list)
  local out = {}
  for i, item in ipairs(list) do out[i] = item.label end
  return out
end

function C.labelOf(list, id)
  local item = C.find(list, id) or list[1]
  return item and item.label or nil
end

function C.idOf(list, label)
  local item = C.findByLabel(list, label) or list[1]
  return item and item.id or nil
end

function C.effortLabel(id)
  local item = C.find(C.EFFORTS, id)
  return item and item.label or tostring(id)
end

return C
