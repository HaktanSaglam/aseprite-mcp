-- Generate tab: text -> new art, with size/style/palette/view controls, variations,
-- 4/8-direction turnarounds and batch generation.
--
-- Aseprite starts a new row for every widget that has a label and whenever the widget
-- type changes, so a pair of comboboxes shares a row only when the second one has no
-- label: each pair is named once ("Size / Style"). An entry and a button can never share
-- a row, hence the batch button on its own row.

return function(form, ui, C)
  form:entry{ id = "genPrompt", key = "genPrompt", label = "Prompt", placeholder = "e.g. a knight with a blue cape" }
  form:newrow()
  form:combo{ id = "genSize", key = "genSize", label = "Size / Style", list = C.SIZES }
  form:combo{ id = "genStyle", key = "genStyle", list = C.STYLES }
  form:newrow()
  form:combo{ id = "genPalette", key = "genPalette", label = "Palette / View", list = C.PALETTES }
  form:combo{ id = "genView", key = "genView", list = C.VIEWS }
  form:newrow()
  form:combo{ id = "genTarget", key = "genTarget", label = "Target / Variations", list = C.TARGETS }
  form:combo{ id = "genVariations", key = "genVariations", list = C.VARIATIONS }
  form:newrow()
  form:check{ id = "genOutline", key = "genOutline", label = "Options", text = "1px outline" }
  form:check{ id = "genTransparent", key = "genTransparent", text = "Transparent background" }
  form:newrow()

  -- No focus = true (Enter target) here: see chat_tab.lua.
  form:button{ id = "genGenerate", text = "Generate", onclick = ui.generate }
  form:button{ id = "genDir4", text = "4 directions", onclick = function() ui.directions(4) end }
  form:button{ id = "genDir8", text = "8 directions", onclick = function() ui.directions(8) end }
  form:newrow()

  -- One sprite per item; the prompt above, if any, is the shared style note.
  form:entry{ id = "genBatch", key = "genBatch", label = "Batch", placeholder = "sword; shield; potion" }
  form:newrow()
  form:button{ id = "genBatchRun", text = "Generate batch", onclick = ui.batch }
end
