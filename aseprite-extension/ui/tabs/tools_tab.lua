-- Tools tab: instant pixel tools that run in the bridge without AI (tool_run).
-- Each button maps to a key of requests.TOOLS.

return function(form, ui, C)
  local function tool(key) return function() ui.tool(key) end end

  form:check{ id = "toolSelectionOnly", key = "toolSelectionOnly", label = "Apply to", text = "Selection only" }
  form:check{ id = "toolAllFrames", key = "toolAllFrames", text = "All frames" }
  form:label{ id = "toolLayer", label = "Layer", text = ui.layerName() }

  form:separator("Clean up")
  form:slider{ id = "toolTolerance", key = "toolTolerance", label = "BG tolerance", min = 0, max = 100 }
  form:button{ id = "toolRemoveBg", text = "Remove BG", onclick = tool("remove_background") }
  form:button{ id = "toolCleanup", text = "Clean up", onclick = tool("cleanup_pixels") }
  form:button{ id = "toolShadow", text = "Drop shadow", onclick = tool("drop_shadow") }

  form:separator("Outline")
  form:combo{ id = "toolOutlinePlacement", key = "toolOutlinePlacement", label = "Placement", list = C.OUTLINE_PLACEMENTS }
  form:color{ id = "toolOutlineColor", key = "toolOutlineColor", label = "Color" }
  form:button{ id = "toolOutlineAuto", label = "Add outline", text = "Auto shade", onclick = tool("outline_auto") }
  form:button{ id = "toolOutlineColorRun", text = "Use color", onclick = tool("outline_color") }

  form:separator("Colors")
  form:slider{ id = "toolColors", key = "toolColors", label = "Colors", min = 2, max = 64 }
  form:combo{ id = "toolDither", key = "toolDither", label = "Dither", list = C.DITHERS }
  form:combo{ id = "toolPalette", key = "toolPalette", label = "Palette", list = C.PALETTE_PRESETS }
  form:button{ id = "toolReduce", text = "Reduce colors", onclick = tool("reduce_colors") }
  form:button{ id = "toolApplyPalette", text = "Apply palette", onclick = tool("apply_palette") }
  -- Unlabeled sliders share one row: hue, saturation, lightness.
  form:slider{ id = "toolHue", key = "toolHue", label = "Hue/Sat/Light", min = -180, max = 180 }
  form:slider{ id = "toolSaturation", key = "toolSaturation", min = -100, max = 100 }
  form:slider{ id = "toolLightness", key = "toolLightness", min = -100, max = 100 }
  form:button{ id = "toolAdjust", text = "Adjust colors", onclick = tool("adjust_colors") }
  form:button{ id = "toolAdjustReset", text = "Reset", onclick = ui.resetAdjust }

  form:separator("Transform")
  form:button{ id = "toolFlipH", text = "Flip H", onclick = tool("flip_h") }
  form:button{ id = "toolFlipV", text = "Flip V", onclick = tool("flip_v") }
  form:button{ id = "toolRotate", text = "Rotate 90", onclick = tool("rotate_90") }
  form:button{ id = "toolUndo", text = "Undo", onclick = tool("undo") }
  form:button{ id = "toolRedo", text = "Redo", onclick = tool("redo") }
  form:button{ id = "toolShiftLeft", label = "Shift 1px", text = "Left", onclick = tool("shift_left") }
  form:button{ id = "toolShiftUp", text = "Up", onclick = tool("shift_up") }
  form:button{ id = "toolShiftDown", text = "Down", onclick = tool("shift_down") }
  form:button{ id = "toolShiftRight", text = "Right", onclick = tool("shift_right") }

  form:label{ id = "toolStatus", text = "Tools run instantly, without AI." }
end
