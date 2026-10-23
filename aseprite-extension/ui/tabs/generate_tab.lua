-- Generate tab: text -> new art, with size/style/palette/view controls, variations,
-- 4/8-direction turnarounds and batch generation.
--
-- Aseprite starts a new row for every widget that has a label and whenever the widget
-- type changes, so a run of comboboxes shares a row only when the later ones have no
-- label: each row is named once ("Size / Style"). The palette row holds three (palette,
-- color limit, view); the limit's options say what they are ("Max 16"). The page is eight
-- rows, nine while the Custom palette row is shown: the window must fit a 13" laptop at
-- 200% UI scale. Inputs come first and every action button shares the last row, which is
-- why the batch list sits above its button.

return function(form, ui, C)
  form:entry{ id = "genPrompt", key = "genPrompt", label = "Prompt", placeholder = "e.g. a knight with a blue cape" }
  form:newrow()
  form:combo{ id = "genSize", key = "genSize", label = "Size / Style", list = C.SIZES }
  form:combo{ id = "genStyle", key = "genStyle", list = C.STYLES }
  form:newrow()
  form:combo{ id = "genPalette", key = "genPalette", label = "Palette / View", list = C.PALETTES, onchange = ui.paletteChanged }
  form:combo{ id = "genColors", key = "genColors", list = C.COLOR_LIMITS }
  form:combo{ id = "genView", key = "genView", list = C.VIEWS }
  form:newrow()
  form:entry{
    id = "genCustomPalette", key = "genCustomPalette", label = "Custom", placeholder = "#rrggbb, #rrggbb, ...",
    showIf = function(s) return s.genPalette == "custom" end,
  }
  form:newrow()
  -- Source is what 4/8 directions and variations start from. Reference lists the open
  -- sprites (refreshed whenever this tab opens) and isn't saved: ids change every session.
  form:combo{ id = "genSource", key = "genSource", label = "Source / Reference", list = C.SOURCES }
  form:combo{
    id = "genReference", list = ui.referenceOptions, selected = ui.selectedReference(),
    onchange = ui.referenceChanged,
  }
  form:newrow()
  form:combo{ id = "genTarget", key = "genTarget", label = "Target / Variations", list = C.TARGETS }
  form:combo{ id = "genVariations", key = "genVariations", list = C.VARIATIONS }
  form:newrow()
  -- Force palette is greyed out for palette "Auto", which has nothing to snap to.
  form:check{ id = "genOutline", key = "genOutline", label = "Options", text = "1px outline" }
  form:check{ id = "genTransparent", key = "genTransparent", text = "Transparent" }
  form:check{ id = "genForcePalette", key = "genForcePalette", text = "Force palette" }
  form:newrow()
  -- One sprite per item; the prompt above, if any, is the shared style note.
  form:entry{ id = "genBatch", key = "genBatch", label = "Batch", placeholder = "sword; shield; potion" }
  form:newrow()

  -- No focus = true (Enter target) here: see chat_tab.lua.
  form:button{ id = "genGenerate", text = "Generate", onclick = ui.generate }
  form:button{ id = "genDir4", text = "4 directions", onclick = function() ui.directions(4) end }
  form:button{ id = "genDir8", text = "8 directions", onclick = function() ui.directions(8) end }
  form:button{ id = "genBatchRun", text = "Generate batch", onclick = ui.batch }
end
