-- Settings tab: which AI does the work (provider, model, effort), run options, the
-- bridge connection and a short how-to.

return function(form, ui)
  form:combo{
    id = "settingsProvider", label = "Provider", list = ui.providerOptions,
    selected = ui.selectedProvider(), onchange = ui.providerChanged,
  }
  form:canvas{ id = "providerInfo", height = 24, vexpand = false, onpaint = ui.paintProviderInfo }
  form:combo{
    id = "settingsModel", label = "Model", list = ui.modelOptions, selected = ui.selectedModel(),
    onchange = function() ui.modelChanged("settingsModel") end,
  }
  form:combo{
    id = "settingsEffort", label = "Effort", list = ui.effortOptions, selected = ui.selectedEffort(),
    onchange = function() ui.effortChanged("settingsEffort") end,
  }
  form:check{ id = "settingsAutoReview", key = "autoReview", label = "Options", text = "Auto-review", onchange = ui.optionsChanged }
  form:check{ id = "settingsShowTools", key = "showTools", text = "Show tool calls", onchange = ui.optionsChanged }

  form:separator("Bridge")
  form:number{ id = "settingsPort", key = "port", label = "Port" }
  form:button{ id = "settingsReconnect", text = "Reconnect", onclick = ui.reconnect }

  form:separator("Help")
  form:canvas{ id = "help", height = 84, vexpand = false, onpaint = ui.paintHelp }
end
