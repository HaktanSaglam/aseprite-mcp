-- Turns the window's choices into protocol messages (docs/PROTOCOL.md): chat_send for
-- AI actions and tool_run for instant tools. Pure: it gets a settings snapshot, the
-- resolved AI choice and a context describing the active sprite, and returns either a
-- payload or a user-facing error. Every rule about "what does this button need" lives
-- here, where it is unit-tested.
--
-- ctx = { sprite = {id, width, height, frames}?, selection = {x, y, width, height}?,
--         layer = string?, layerIsGroup = boolean?, directionTags = number?,
--         reference = sprite id?, referenceGone = boolean? (the picked one was closed),
--         openSprites = {[id] = true}? }
-- ai  = providers.resolve(...) = { provider = ProviderInfo, model?, effort? }
--
-- v1.1 option fields are only sent when they ask for something: omitted means v1.0
-- behaviour (docs/PROTOCOL.md), so a request that uses none of them is byte-for-byte
-- what v1.0 sent.

return function(C)
  local R = {}

  R.MAX_BATCH = 16
  R.MIN_CUSTOM_COLORS = 2
  R.MAX_CUSTOM_COLORS = 256

  local NEED_SPRITE = "Open or create a sprite first (File > New)."
  local NEED_SELECTION = "Select an area first (Rectangular Marquee tool, M)."
  local NEED_SOURCE_SPRITE = 'Source "Current sprite" needs an open sprite. Open one or pick "Prompt".'

  local function trim(text)
    return (tostring(text or ""):gsub("^%s+", ""):gsub("%s+$", ""))
  end

  local function checkProvider(ai)
    local p = ai.provider
    if p.available then return true end
    local note = p.note and (" " .. p.note) or ""
    return nil, p.label .. " is not set up." .. note .. " Pick another AI in Settings."
  end

  local function aiOptions(ai, s)
    return {
      provider = ai.provider.id,
      model = ai.model,
      effort = ai.effort,
      autoReview = s.autoReview,
    }
  end

  local function size(s, ctx)
    local item = C.find(C.SIZES, s.genSize)
    if item and item.width then return { width = item.width, height = item.height } end
    if ctx.sprite then return { width = ctx.sprite.width, height = ctx.sprite.height } end
    return nil, 'Size "Current canvas" needs an open sprite. Pick a size instead.'
  end

  local CUSTOM = 'Palette "Custom"'

  -- "#1a1c2c, 5d275d; #FFF" (commas, semicolons, spaces or one per line, like a Lospec
  -- .hex file; "#" optional; #rgb is expanded) -> {"#1a1c2c", "#5d275d", "#ffffff"}.
  -- Repeats are dropped. Returns nil and a message for the user when the list is unusable.
  function R.parseColors(text)
    local colors, seen = {}, {}
    for token in tostring(text or ""):gmatch("[^%s,;]+") do
      local hex = token:gsub("^#", ""):lower()
      if #hex == 3 and not hex:find("[^0-9a-f]") then
        hex = hex:gsub("(.)", "%1%1")
      end
      if #hex ~= 6 or hex:find("[^0-9a-f]") then
        return nil, string.format('%s: "%s" is not a color. Write each one as #rrggbb, e.g. #1a1c2c.', CUSTOM, token)
      end
      if not seen[hex] then
        seen[hex] = true
        colors[#colors + 1] = "#" .. hex
      end
    end
    if #colors < R.MIN_CUSTOM_COLORS then
      return nil, string.format("%s needs at least %d different colors, e.g. #1a1c2c, #f4f4f4.", CUSTOM, R.MIN_CUSTOM_COLORS)
    end
    if #colors > R.MAX_CUSTOM_COLORS then
      return nil, string.format("%s takes at most %d colors (you listed %d).", CUSTOM, R.MAX_CUSTOM_COLORS, #colors)
    end
    return colors
  end

  -- The palette fields of v1.1: custom colors, a hard color limit, forcing the palette.
  local function paletteOptions(options, s)
    if s.genPalette == "custom" then
      local colors, err = R.parseColors(s.genCustomPalette)
      if not colors then return nil, err end
      options.customPalette = colors
    end
    local limit = C.find(C.COLOR_LIMITS, s.genColors)
    if limit and limit.count then options.maxColors = limit.count end
    -- "Auto" has no fixed palette to snap to (the window greys the box out for it).
    if s.genForcePalette and s.genPalette ~= "auto" then options.forcePalette = true end
    return options
  end

  -- Options shared by everything that creates art (generate, variations, batch, directions).
  local function artOptions(ai, s, ctx)
    local options = aiOptions(ai, s)
    local sz, err = size(s, ctx)
    if not sz then return nil, err end
    if s.genTarget ~= "new_sprite" and not ctx.sprite then
      return nil, string.format('Target "%s" needs an open sprite. Choose "New sprite" or open one.',
        C.labelOf(C.TARGETS, s.genTarget))
    end
    if s.genPalette == "current" and not ctx.sprite then
      return nil, 'Palette "Current" needs an open sprite. Pick a preset or "Auto".'
    end
    if ctx.referenceGone then
      return nil, 'The Reference sprite was closed. Pick another one in Reference, or "None".'
    end
    options.size = sz
    options.style = s.genStyle
    options.palette = s.genPalette
    options.target = s.genTarget
    options.view = s.genView
    options.outline = s.genOutline
    options.background = s.genTransparent and "transparent" or "solid"
    local ok, palErr = paletteOptions(options, s)
    if not ok then return nil, palErr end
    if ctx.reference then options.reference = { sprite = ctx.reference } end
    return options
  end

  -- Source "Current sprite": directions and variations start from the open sprite's
  -- frame 1, so the new sprites get its size whatever Size says (a 48x48 knight turned
  -- on a 32x32 canvas would be cut off). "Prompt" sends nothing: v1.0 behaviour.
  local function sourceOptions(options, s, ctx)
    if s.genSource ~= "current" then return options end
    if not ctx.sprite then return nil, NEED_SOURCE_SPRITE end
    options.source = "current"
    options.size = { width = ctx.sprite.width, height = ctx.sprite.height }
    return options
  end

  local function message(action, text, options, ctx, selection)
    return {
      event = "chat_send",
      action = action,
      text = text,
      options = options,
      selection = selection,
      sprite = ctx.sprite and ctx.sprite.id or nil,
    }
  end

  local function contextSelection(s, ctx)
    if s.useSelection and ctx.sprite then return ctx.selection end
    return nil
  end

  -- action is left out: the protocol defaults it to "chat", and bridges that predate
  -- the action list still accept the message.
  function R.chat(text, s, ai, ctx)
    local ok, err = checkProvider(ai)
    if not ok then return nil, err end
    text = trim(text)
    if text == "" then return nil, "Type a message first." end
    return message(nil, text, aiOptions(ai, s), ctx, contextSelection(s, ctx))
  end

  function R.editSelection(text, s, ai, ctx)
    local ok, err = checkProvider(ai)
    if not ok then return nil, err end
    if not ctx.sprite then return nil, NEED_SPRITE end
    if not ctx.selection then return nil, NEED_SELECTION end
    return message("edit_selection", trim(text), aiOptions(ai, s), ctx, ctx.selection)
  end

  function R.review(text, s, ai, ctx)
    local ok, err = checkProvider(ai)
    if not ok then return nil, err end
    if not ctx.sprite then return nil, NEED_SPRITE end
    return message("review", trim(text), aiOptions(ai, s), ctx, contextSelection(s, ctx))
  end

  -- count: 2-4. Without text the bridge varies the active sprite, so one of both is needed.
  function R.variations(text, count, s, ai, ctx)
    local ok, err = checkProvider(ai)
    if not ok then return nil, err end
    text = trim(text)
    if s.genSource == "current" and not ctx.sprite then return nil, NEED_SOURCE_SPRITE end
    if text == "" and not ctx.sprite then
      return nil, "Describe what to draw, or open a sprite to make variations of it."
    end
    local options, optErr = artOptions(ai, s, ctx)
    if not options then return nil, optErr end
    options, optErr = sourceOptions(options, s, ctx)
    if not options then return nil, optErr end
    options.count = math.max(2, math.min(4, math.floor(count)))
    return message("variations", text, options, ctx, nil)
  end

  -- Generate tab: one sprite, or variations when the Variations box is above 1.
  function R.generate(s, ai, ctx)
    local text = trim(s.genPrompt)
    local item = C.find(C.VARIATIONS, s.genVariations) or C.VARIATIONS[1]
    -- Variations of the current sprite need no description.
    if text == "" and not (item.count > 1 and s.genSource == "current") then
      -- Likely meant the batch button right below the Items box.
      if #R.parseItems(s.genBatch) > 0 then
        return nil, 'Prompt is empty. To draw the Items list, press "Generate batch".'
      end
      if s.genSource == "current" then
        return nil, 'Source "Current sprite" is for 4/8 directions and Variations 2-4. One new sprite needs a Prompt.'
      end
      return nil, "Type what to draw in Prompt first."
    end
    if item.count > 1 then return R.variations(text, item.count, s, ai, ctx) end
    local ok, err = checkProvider(ai)
    if not ok then return nil, err end
    local options, optErr = artOptions(ai, s, ctx)
    if not options then return nil, optErr end
    return message("generate", text, options, ctx, nil)
  end

  function R.directions(n, s, ai, ctx)
    local ok, err = checkProvider(ai)
    if not ok then return nil, err end
    if n ~= 4 and n ~= 8 then return nil, "Directions must be 4 or 8." end
    local text = trim(s.genPrompt)
    if s.genSource == "current" and not ctx.sprite then return nil, NEED_SOURCE_SPRITE end
    if text == "" and not ctx.sprite then
      return nil, "Describe the character in Prompt, or open a sprite of it."
    end
    local options, optErr = artOptions(ai, s, ctx)
    if not options then return nil, optErr end
    options, optErr = sourceOptions(options, s, ctx)
    if not options then return nil, optErr end
    options.directions = n
    return message("directions", text, options, ctx, nil)
  end

  -- "sword; shield" or one item per line -> {"sword", "shield"}.
  function R.parseItems(text)
    local items = {}
    for part in (tostring(text or "") .. ";"):gmatch("([^;\r\n]*)[;\r\n]") do
      local item = trim(part)
      if item ~= "" then items[#items + 1] = item end
    end
    return items
  end

  function R.batch(s, ai, ctx)
    local ok, err = checkProvider(ai)
    if not ok then return nil, err end
    local items = R.parseItems(s.genBatch)
    if #items == 0 then return nil, 'List the items to draw, e.g. "sword; shield; potion".' end
    if #items > R.MAX_BATCH then
      return nil, string.format("Up to %d items per batch (you listed %d).", R.MAX_BATCH, #items)
    end
    local options, optErr = artOptions(ai, s, ctx)
    if not options then return nil, optErr end
    options.items = items
    -- The prompt, if any, is a shared style note ("for a cozy farming game").
    return message("batch", trim(s.genPrompt), options, ctx, nil)
  end

  function R.animate(s, ai, ctx)
    local ok, err = checkProvider(ai)
    if not ok then return nil, err end
    if not ctx.sprite then return nil, "Open the sprite to animate first (its current frame is the start pose)." end
    local animation = {
      preset = s.animPreset,
      frames = s.animFrames,
      frameMs = s.animFrameMs,
      loop = s.animLoop,
    }
    -- The frame numbers must exist; whether they make sense for the art is the bridge's call.
    local count = ctx.sprite.frames
    if s.animMode == "between" then
      if s.animFrom >= s.animTo then
        return nil, 'Between frames: "From" must be a frame before "To".'
      end
      if count and s.animTo > count then
        return nil, string.format('Between frames: this sprite has %d frame%s, so "To" can be at most %d.',
          count, count == 1 and "" or "s", count)
      end
      animation.mode, animation.fromFrame, animation.toFrame = "between", s.animFrom, s.animTo
    elseif s.animMode == "continue" then
      if count and s.animKeep > count then
        return nil, string.format('Continue: this sprite has %d frame%s, so "Keep" can be at most %d.',
          count, count == 1 and "" or "s", count)
      end
      animation.mode, animation.keepFrames = "continue", s.animKeep
    end
    -- The box is greyed out without direction tags; a tick left over from another sprite
    -- must not ask the bridge for directions this one doesn't have.
    if s.animAllDirections and (ctx.directionTags or 0) > 0 then animation.allDirections = true end
    local options = aiOptions(ai, s)
    options.animation = animation
    return message("animate", trim(s.animNotes), options, ctx, nil)
  end

  -- The sprite a sent request draws into, as far as the window can know: the active
  -- sprite it was sent with, unless the action makes its own new sprites (their ids are
  -- the bridge's). "Undo AI run" is only offered for this sprite (see ui/run_undo.lua).
  local NEW_SPRITE_ACTIONS = { variations = true, batch = true, directions = true }
  local INTO_SPRITE_TARGETS = { new_layer = true, active_layer = true }

  function R.boundSprite(p)
    if not p or p.sprite == nil then return nil end
    if NEW_SPRITE_ACTIONS[p.action] then return nil end
    -- A generate without an explicit layer target makes a new sprite.
    if p.action == "generate" and not INTO_SPRITE_TARGETS[(p.options or {}).target] then return nil end
    return p.sprite
  end

  -- How a sent request appears in the log as the user's line, e.g.
  -- "Generate · 32x32 · PICO-8: a knight". Only non-default choices are listed.
  local SEP = " · "

  local function artDetails(o)
    local parts = {}
    local function add(text) parts[#parts + 1] = text end
    if o.size then add(string.format("%dx%d", o.size.width, o.size.height)) end
    if o.style and o.style ~= "auto" then add(C.labelOf(C.STYLES, o.style)) end
    if o.palette and o.palette ~= "auto" then
      add(C.labelOf(C.PALETTES, o.palette) .. (o.forcePalette and " (forced)" or ""))
    end
    if o.maxColors then add(string.format("max %d colors", o.maxColors)) end
    if o.view and o.view ~= "front" then add(C.labelOf(C.VIEWS, o.view)) end
    if o.source == "current" then add("from sprite") end
    if o.reference then add("with reference") end
    return parts
  end

  local function joinTitle(title, parts, text)
    local head = table.concat({ title, table.unpack(parts) }, SEP)
    if text and text ~= "" then return head .. ": " .. text end
    return head
  end

  function R.describe(p)
    local o = p.options or {}
    local a = p.action
    if a == nil or a == "chat" then return p.text end
    if a == "edit_selection" then return joinTitle("Redraw selection", {}, p.text) end
    if a == "review" then return joinTitle("Review & fix", {}, p.text) end
    if a == "generate" then return joinTitle("Generate", artDetails(o), p.text) end
    if a == "variations" then return joinTitle(string.format("%d variations", o.count or 0), artDetails(o), p.text) end
    if a == "directions" then return joinTitle(string.format("%d directions", o.directions or 0), artDetails(o), p.text) end
    if a == "batch" then
      local items = o.items or {}
      return joinTitle(string.format("Batch of %d", #items), artDetails(o), table.concat(items, ", "))
    end
    if a == "animate" then
      local anim = o.animation or {}
      local parts = {
        C.labelOf(C.ANIMATIONS, anim.preset),
        string.format("%d frames", anim.frames or 0),
        string.format("%d ms", anim.frameMs or 0),
      }
      if anim.loop then parts[#parts + 1] = "loop" end
      if anim.mode == "between" then
        parts[#parts + 1] = string.format("between %d-%d", anim.fromFrame or 0, anim.toFrame or 0)
      elseif anim.mode == "continue" then
        parts[#parts + 1] = string.format("keep 1-%d", anim.keepFrames or 0)
      end
      if anim.allDirections then parts[#parts + 1] = "all directions" end
      return joinTitle("Animate", parts, p.text)
    end
    return p.text or tostring(a)
  end

  -- Instant tools -------------------------------------------------------------

  R.IMPORT_LAYER = "Imported"

  local function hex(color, withHash)
    local rgb, alpha = color:sub(1, 6), color:sub(7, 8)
    local out = (alpha == "ff" or alpha == "") and rgb or (rgb .. alpha)
    return withHash and ("#" .. out) or out
  end

  -- key -> {tool, label, scoped, params(s) -> params | nil, err}. "scoped" tools get the
  -- common layer/frames/selectionOnly target; undo/redo act on the sprite.
  R.TOOLS = {
    remove_background = {
      tool = "remove_background", label = "Remove background", scoped = true,
      params = function(s) return { mode = "edges", tolerance = s.toolTolerance } end,
    },
    cleanup_pixels = {
      tool = "cleanup_pixels", label = "Clean up", scoped = true,
      params = function() return { minNeighbors = 1 } end,
    },
    drop_shadow = {
      tool = "drop_shadow", label = "Drop shadow", scoped = true,
      params = function() return { dx = 1, dy = 1 } end,
    },
    outline_auto = {
      tool = "add_outline", label = "Outline", scoped = true,
      params = function(s) return { placement = s.toolOutlinePlacement } end,
    },
    outline_color = {
      tool = "add_outline", label = "Outline", scoped = true,
      params = function(s)
        return { placement = s.toolOutlinePlacement, color = hex(s.toolOutlineColor, true) }
      end,
    },
    reduce_colors = {
      tool = "reduce_colors", label = "Reduce colors", scoped = true,
      params = function(s) return { colors = s.toolColors, dither = s.toolDither } end,
    },
    apply_palette = {
      tool = "apply_palette", label = "Apply palette", scoped = true,
      params = function(s) return { palette = s.toolPalette, dither = s.toolDither } end,
    },
    adjust_colors = {
      tool = "adjust_colors", label = "Adjust colors", scoped = true,
      params = function(s)
        local p = {}
        if s.toolHue ~= 0 then p.hue = s.toolHue end
        if s.toolSaturation ~= 0 then p.saturation = s.toolSaturation end
        if s.toolLightness ~= 0 then p.lightness = s.toolLightness end
        if next(p) == nil then return nil, "Move the Hue, Saturation or Lightness slider first." end
        return p
      end,
    },
    flip_h = {
      tool = "transform_layer", label = "Flip horizontal", scoped = true,
      params = function() return { op = "flip_h" } end,
    },
    flip_v = {
      tool = "transform_layer", label = "Flip vertical", scoped = true,
      params = function() return { op = "flip_v" } end,
    },
    rotate_90 = {
      tool = "transform_layer", label = "Rotate 90", scoped = true,
      params = function() return { op = "rotate_90" } end,
    },
    shift_left = {
      tool = "transform_layer", label = "Shift left", scoped = true,
      params = function() return { op = "shift", dx = -1, dy = 0 } end,
    },
    shift_right = {
      tool = "transform_layer", label = "Shift right", scoped = true,
      params = function() return { op = "shift", dx = 1, dy = 0 } end,
    },
    shift_up = {
      tool = "transform_layer", label = "Shift up", scoped = true,
      params = function() return { op = "shift", dx = 0, dy = -1 } end,
    },
    shift_down = {
      tool = "transform_layer", label = "Shift down", scoped = true,
      params = function() return { op = "shift", dx = 0, dy = 1 } end,
    },
    -- Unzooms upscaled art (the bridge detects the scale) and snaps each block to its
    -- dominant color; cleanup is sent either way so the tick box always means what it shows.
    normalize_pixel_art = {
      tool = "normalize_pixel_art", label = "Normalize", scoped = true,
      params = function(s)
        local p = { cleanup = s.toolNormCleanup }
        local limit = C.find(C.COLOR_LIMITS, s.toolNormColors)
        if limit and limit.count then p.maxColors = limit.count end
        return p
      end,
    },
    -- Its own layer, so an import never paints over the user's art; the bridge reads the
    -- file, which keeps big PNGs out of the WebSocket.
    import_image = {
      tool = "import_image", label = "Import PNG", scoped = false,
      params = function(s)
        local path = trim(s.toolImportPath)
        if path == "" then return nil, 'Choose a PNG file first (the button in the "PNG file" row).' end
        if not path:lower():find("%.png$") then return nil, "Only .png files can be imported." end
        return { path = path, layer = R.IMPORT_LAYER }
      end,
    },
    -- steps is spelled out because Aseprite's json.encode turns {} into [] and the
    -- bridge validates params as an object.
    undo = {
      tool = "undo", label = "Undo", scoped = false,
      params = function() return { steps = 1 } end,
    },
    redo = {
      tool = "redo", label = "Redo", scoped = false,
      params = function() return { steps = 1 } end,
    },
  }

  -- The R.TOOLS key the Tools tab's Apply button runs for the picked tool. Outline is one
  -- choice in the picker but two keys here, because the picked color changes the params.
  function R.applyKey(s)
    if s.toolChoice == "outline" then
      return s.toolOutlineMode == "color" and "outline_color" or "outline_auto"
    end
    return s.toolChoice
  end

  function R.tool(key, requestId, s, ctx)
    local def = R.TOOLS[key]
    if not def then return nil, "Unknown tool: " .. tostring(key) end
    if not ctx.sprite then return nil, NEED_SPRITE end
    local params, err = def.params(s)
    if not params then return nil, err end
    if def.scoped then
      if ctx.layerIsGroup then
        return nil, string.format('"%s" is a group. Pick an image layer in the Layers panel.', ctx.layer or "The layer")
      end
      if s.toolSelectionOnly and not ctx.selection then
        return nil, 'Nothing is selected. Select an area or untick "Selection only".'
      end
      params.layer = ctx.layer
      params.frames = s.toolAllFrames and "all" or "current"
      params.selectionOnly = s.toolSelectionOnly
    end
    return {
      event = "tool_run",
      requestId = requestId,
      tool = def.tool,
      params = params,
      sprite = ctx.sprite.id,
    }
  end

  -- "Undo AI run": the undo steps the bridge reported for the run (done.stats.undoSteps),
  -- on the sprite the run drew into, which need not be the active one by the time the
  -- bridge gets this.
  function R.undoRun(requestId, spriteId, steps)
    return {
      event = "tool_run",
      requestId = requestId,
      tool = "undo",
      params = { steps = math.floor(steps) },
      sprite = spriteId,
    }
  end

  -- Repeat last -----------------------------------------------------------------------

  R.NOTHING_TO_REPEAT = "Nothing to repeat yet. Send a request first."

  -- Plain Lua values from Aseprite's json.decode, whose userdata has float numbers:
  -- describe(), table.concat and the next json.encode all want tables and integers.
  -- Its arrays only answer [i] and ipairs (pairs yields nothing; # counts an object's
  -- keys too), its objects pairs.
  local function plain(v)
    if type(v) == "number" then return math.tointeger(v) or v end
    if type(v) ~= "userdata" and type(v) ~= "table" then return v end
    local out = {}
    if v[1] ~= nil then
      for i, item in ipairs(v) do out[i] = plain(item) end
    else
      for k, item in pairs(v) do out[k] = plain(item) end
    end
    return out
  end

  local ON_SPRITE_ACTIONS = { edit_selection = true, review = true, animate = true }

  -- The last chat_send (stored as JSON) again, aimed at what is open now: the sprite and
  -- selection are today's, not the ones it was first sent with (the user may have
  -- switched sprites, and after a restart the old ids name other sprites). A reference
  -- is kept only within the same session and while that sprite is still open.
  function R.repeatLast(stored, ctx, sameSession)
    if type(stored) ~= "string" or stored == "" then return nil, R.NOTHING_TO_REPEAT end
    local ok, decoded = pcall(json.decode, stored)
    if not ok or decoded == nil then return nil, R.NOTHING_TO_REPEAT end
    local p = plain(decoded)
    if type(p) ~= "table" or p.event ~= "chat_send" then return nil, R.NOTHING_TO_REPEAT end
    if type(p.options) ~= "table" then p.options = {} end
    local o, action = p.options, p.action
    local hasSprite = ctx.sprite ~= nil

    if ON_SPRITE_ACTIONS[action] and not hasSprite then return nil, NEED_SPRITE end
    if o.source == "current" and not hasSprite then return nil, NEED_SOURCE_SPRITE end
    if (action == "variations" or action == "directions") and trim(p.text) == "" and not hasSprite then
      return nil, NEED_SPRITE
    end
    if INTO_SPRITE_TARGETS[o.target] and action == "generate" and not hasSprite then return nil, NEED_SPRITE end
    if o.palette == "current" and not hasSprite then
      return nil, 'Palette "Current" needs an open sprite. Pick a preset or "Auto".'
    end

    p.sprite = hasSprite and ctx.sprite.id or nil
    if action == "edit_selection" then
      if not ctx.selection then return nil, NEED_SELECTION end
      p.selection = ctx.selection
    elseif p.selection ~= nil then
      -- It was sent with "Use selection": today's selection, if any.
      p.selection = ctx.selection
    end
    if o.source == "current" then o.size = { width = ctx.sprite.width, height = ctx.sprite.height } end
    if type(o.reference) == "table" then
      local id = o.reference.sprite
      if not (sameSession and ctx.openSprites and ctx.openSprites[id]) then o.reference = nil end
    end
    return p
  end

  return R
end
