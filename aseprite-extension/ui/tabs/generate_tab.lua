-- Generate tab: text -> new art, with size/style/palette/view controls, variations,
-- 4/8-direction turnarounds and batch generation.

return function(form, ui, C)
  form:entry{ id = "genPrompt", key = "genPrompt", label = "Prompt", placeholder = "e.g. a knight with a blue cape" }
  form:combo{ id = "genSize", key = "genSize", label = "Size", list = C.SIZES }
  form:combo{ id = "genStyle", key = "genStyle", label = "Style", list = C.STYLES }
  form:combo{ id = "genPalette", key = "genPalette", label = "Palette", list = C.PALETTES }
  form:combo{ id = "genView", key = "genView", label = "View", list = C.VIEWS }
  form:combo{ id = "genTarget", key = "genTarget", label = "Target", list = C.TARGETS }
  form:combo{ id = "genVariations", key = "genVariations", label = "Variations", list = C.VARIATIONS }
  form:check{ id = "genOutline", key = "genOutline", label = "Options", text = "1px outline" }
  form:check{ id = "genTransparent", key = "genTransparent", text = "Transparent background" }

  form:button{ id = "genGenerate", text = "Generate", focus = true, onclick = ui.generate }
  form:button{ id = "genDir4", text = "4 directions", onclick = function() ui.directions(4) end }
  form:button{ id = "genDir8", text = "8 directions", onclick = function() ui.directions(8) end }

  form:separator("Batch: one sprite per item")
  form:entry{ id = "genBatch", key = "genBatch", label = "Items", placeholder = "sword; shield; potion" }
  form:button{ id = "genBatchRun", text = "Generate batch", onclick = ui.batch }
end
