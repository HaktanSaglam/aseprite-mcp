-- Settings tab: which AI does the work (provider, model, effort), run options, the
-- bridge connection and a short how-to.
--
-- The provider status and the help are native labels, not canvases: tab pages don't
-- hide canvases (see main_window.build), and a label row is the shortest row there is.

return function(form, ui)
  form:combo{
    id = "settingsProvider", label = "Provider", list = ui.providerOptions,
    selected = ui.selectedProvider(), onchange = ui.providerChanged,
  }
  form:newrow()
  form:label{ id = "providerInfo", text = ui.providerInfo() }
  form:newrow()
  -- Effort has no label of its own so it shares the model's row; its options
  -- ("Fast", "Balanced") speak for themselves, like in the Chat tab.
  form:combo{
    id = "settingsModel", label = "Model", list = ui.modelOptions, selected = ui.selectedModel(),
    onchange = function() ui.modelChanged("settingsModel") end,
  }
  form:combo{
    id = "settingsEffort", list = ui.effortOptions, selected = ui.selectedEffort(),
    onchange = function() ui.effortChanged("settingsEffort") end,
  }
  form:newrow()
  form:check{ id = "settingsAutoReview", key = "autoReview", label = "Options", text = "Auto-review", onchange = ui.optionsChanged }
  form:check{ id = "settingsShowTools", key = "showTools", text = "Show tool calls", onchange = ui.optionsChanged }
  form:newrow()
  form:number{ id = "settingsPort", key = "port", label = "Bridge port" }
  form:newrow()
  form:button{ id = "settingsReconnect", text = "Reconnect", onclick = ui.reconnect }
  form:newrow()

  for i, text in ipairs(ui.helpLines()) do
    form:label{ id = "help" .. i, text = text }
    form:newrow()
  end
end
