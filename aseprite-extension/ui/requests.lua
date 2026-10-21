-- Turns the window's choices into protocol messages (docs/PROTOCOL.md): chat_send for
-- AI actions and tool_run for instant tools. Pure: it gets a settings snapshot, the
-- resolved AI choice and a context describing the active sprite, and returns either a
-- payload or a user-facing error. Every rule about "what does this button need" lives
-- here, where it is unit-tested.
--
-- ctx = { sprite = {id, width, height}?, selection = {x, y, width, height}?, layer = string?,
--         layerIsGroup = boolean? }
-- ai  = providers.resolve(...) = { provider = ProviderInfo, model?, effort? }

return function(C)
  local R = {}

  R.MAX_BATCH = 16

  local NEED_SPRITE = "Open or create a sprite first (File > New)."
  local NEED_SELECTION = "Select an area first (Rectangular Marquee tool, M)."

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
    options.size = sz
    options.style = s.genStyle
    options.palette = s.genPalette
    options.target = s.genTarget
    options.view = s.genView
    options.outline = s.genOutline
    options.background = s.genTransparent and "transparent" or "solid"
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
    if text == "" and not ctx.sprite then
      return nil, "Describe what to draw, or open a sprite to make variations of it."
    end
    local options, optErr = artOptions(ai, s, ctx)
    if not options then return nil, optErr end
    options.count = math.max(2, math.min(4, math.floor(count)))
    return message("variations", text, options, ctx, nil)
  end

  -- Generate tab: one sprite, or variations when the Variations box is above 1.
  function R.generate(s, ai, ctx)
    local text = trim(s.genPrompt)
    if text == "" then
      -- Likely meant the batch button right below the Items box.
      if #R.parseItems(s.genBatch) > 0 then
        return nil, 'Prompt is empty. To draw the Items list, press "Generate batch".'
      end
      return nil, "Type what to draw in Prompt first."
    end
    local item = C.find(C.VARIATIONS, s.genVariations) or C.VARIATIONS[1]
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
    if text == "" and not ctx.sprite then
      return nil, "Describe the character in Prompt, or open a sprite of it."
    end
    local options, optErr = artOptions(ai, s, ctx)
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
    local options = aiOptions(ai, s)
    options.animation = {
      preset = s.animPreset,
      frames = s.animFrames,
      frameMs = s.animFrameMs,
      loop = s.animLoop,
    }
    return message("animate", trim(s.animNotes), options, ctx, nil)
  end

  -- How a sent request appears in the log as the user's line, e.g.
  -- "Generate · 32x32 · PICO-8: a knight". Only non-default choices are listed.
  local SEP = " · "

  local function artDetails(o)
    local parts = {}
    if o.size then parts[#parts + 1] = string.format("%dx%d", o.size.width, o.size.height) end
    if o.style and o.style ~= "auto" then parts[#parts + 1] = C.labelOf(C.STYLES, o.style) end
    if o.palette and o.palette ~= "auto" then parts[#parts + 1] = C.labelOf(C.PALETTES, o.palette) end
    if o.view and o.view ~= "front" then parts[#parts + 1] = C.labelOf(C.VIEWS, o.view) end
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
      return joinTitle("Animate", parts, p.text)
    end
    return p.text or tostring(a)
  end

  -- Instant tools -------------------------------------------------------------

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

  return R
end
