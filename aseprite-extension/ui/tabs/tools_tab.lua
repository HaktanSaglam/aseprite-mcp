-- Tools tab: instant pixel tools that run in the bridge without AI (tool_run).
--
-- A "Tool" picker plus one Apply button replaces a block of buttons per tool: only the
-- picked tool's settings are shown (the window calls form:applyVisibility), and a hidden
-- row takes no room, so the page stays nine rows tall whichever tool is picked. The
-- one-click transforms below it stay visible. Every button maps to a requests.TOOLS key.
-- Import PNG is a picker entry too: a button of its own would be a tenth row.
--
-- Row rules (Aseprite): a labeled widget or a change of widget type starts a new row,
-- so widgets meant to share a row are of one type and only the first has a label.

return function(form, ui, C)
  local function tool(key) return function() ui.tool(key) end end

  -- showIf for the settings of the given picker choices.
  local function forTools(...)
    local ids = { ... }
    return function(s)
      for _, id in ipairs(ids) do
        if s.toolChoice == id then return true end
      end
      return false
    end
  end

  form:check{ id = "toolSelectionOnly", key = "toolSelectionOnly", label = "Apply to", text = "Selection only" }
  form:check{ id = "toolAllFrames", key = "toolAllFrames", text = "All frames" }
  form:newrow()
  form:label{ id = "toolLayer", label = "Layer", text = ui.layerName() }
  form:newrow()

  form:combo{ id = "toolChoice", key = "toolChoice", label = "Tool", list = C.TOOL_CHOICES, onchange = ui.toolChanged }
  form:newrow()

  -- At most two of these rows are visible at a time.
  form:slider{
    id = "toolTolerance", key = "toolTolerance", label = "Tolerance", min = 0, max = 100,
    showIf = forTools("remove_background"),
  }
  form:newrow()
  form:combo{
    id = "toolOutlinePlacement", key = "toolOutlinePlacement", label = "Outline", list = C.OUTLINE_PLACEMENTS,
    showIf = forTools("outline"),
  }
  form:combo{
    id = "toolOutlineMode", key = "toolOutlineMode", list = C.OUTLINE_COLORS, onchange = ui.toolChanged,
    showIf = forTools("outline"),
  }
  form:newrow()
  form:color{
    id = "toolOutlineColor", key = "toolOutlineColor", label = "Color",
    showIf = function(s) return s.toolChoice == "outline" and s.toolOutlineMode == "color" end,
  }
  form:newrow()
  form:slider{ id = "toolColors", key = "toolColors", label = "Colors", min = 2, max = 64, showIf = forTools("reduce_colors") }
  form:newrow()
  form:combo{ id = "toolPalette", key = "toolPalette", label = "Palette", list = C.PALETTE_PRESETS, showIf = forTools("apply_palette") }
  form:newrow()
  form:combo{ id = "toolDither", key = "toolDither", label = "Dither", list = C.DITHERS, showIf = forTools("reduce_colors", "apply_palette") }
  form:newrow()
  -- Unlabeled sliders share the row: hue, saturation, lightness.
  local adjust = forTools("adjust_colors")
  form:slider{ id = "toolHue", key = "toolHue", label = "H / S / L", min = -180, max = 180, showIf = adjust }
  form:slider{ id = "toolSaturation", key = "toolSaturation", min = -100, max = 100, showIf = adjust }
  form:slider{ id = "toolLightness", key = "toolLightness", min = -100, max = 100, showIf = adjust }
  form:newrow()
  local normalize = forTools("normalize_pixel_art")
  form:combo{ id = "toolNormColors", key = "toolNormColors", label = "Max colors", list = C.COLOR_LIMITS, showIf = normalize }
  form:newrow()
  form:check{ id = "toolNormCleanup", key = "toolNormCleanup", label = "Cleanup", text = "Remove stray pixels", showIf = normalize }
  form:newrow()
  -- Picking a file only chooses it; Apply imports it, so the same file can be imported
  -- again after an undo (the picker reports no change for an unchanged file).
  form:file{
    id = "toolImportFile", key = "toolImportPath", label = "PNG file", title = "Import PNG",
    filetypes = { "png" }, showIf = forTools("import_image"),
  }
  form:newrow()

  form:button{ id = "toolApply", text = "Apply", onclick = ui.applyTool }
  form:button{ id = "toolAdjustReset", text = "Reset", onclick = ui.resetAdjust, showIf = adjust }
  form:newrow()

  -- Arrows are ASCII: the pixel font has no glyphs from U+2000 up (see text_render.lua).
  form:button{ id = "toolFlipH", label = "Transform", text = "Flip H", onclick = tool("flip_h") }
  form:button{ id = "toolFlipV", text = "Flip V", onclick = tool("flip_v") }
  form:button{ id = "toolRotate", text = "Rotate 90", onclick = tool("rotate_90") }
  form:newrow()
  form:button{ id = "toolShiftLeft", label = "Shift 1px", text = "<", onclick = tool("shift_left") }
  form:button{ id = "toolShiftUp", text = "^", onclick = tool("shift_up") }
  form:button{ id = "toolShiftRight", text = ">", onclick = tool("shift_right") }
  form:button{ id = "toolShiftDown", text = "v", onclick = tool("shift_down") }
  form:button{ id = "toolUndo", text = "Undo", onclick = tool("undo") }
  form:button{ id = "toolRedo", text = "Redo", onclick = tool("redo") }
  form:newrow()

  form:label{ id = "toolStatus", text = "Tools run instantly, without AI." }
end
