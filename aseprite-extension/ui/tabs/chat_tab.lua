-- Chat tab: the conversation log, the message box and the quick AI choices.
-- ui: handlers and option sources from ui/main_window.lua.

return function(form, ui)
  form:canvas{
    id = "log", width = 340, height = 210,
    onpaint = ui.paintLog, onwheel = ui.wheelLog,
  }

  -- focus = true makes Send the Enter target for the entry. Only visible buttons catch
  -- Enter, so every tab can have its own default button.
  form:entry{ id = "chatInput", placeholder = "Ask the AI to draw or edit... (Enter sends)", focus = true }
  form:button{ id = "chatSend", text = "Send", focus = true, onclick = ui.sendChat }
  form:button{ id = "chatStop", text = "Stop", enabled = false, onclick = ui.stop }
  form:button{ id = "chatNew", text = "New chat", onclick = ui.newChat }

  form:check{ id = "chatUseSelection", key = "useSelection", text = "Use selection as context" }

  -- No row label: an unlabeled grid keeps the log flush with the dialog edge, and the
  -- option names ("Opus", "Balanced") speak for themselves.
  form:combo{
    id = "chatModel", list = ui.modelOptions, selected = ui.selectedModel(),
    onchange = function() ui.modelChanged("chatModel") end,
  }
  form:combo{
    id = "chatEffort", list = ui.effortOptions, selected = ui.selectedEffort(),
    onchange = function() ui.effortChanged("chatEffort") end,
  }

  form:separator("Quick actions")
  form:button{ id = "quickRedraw", text = "Redraw selection", onclick = function() ui.quick("edit_selection") end }
  form:button{ id = "quickReview", text = "Review & fix", onclick = function() ui.quick("review") end }
  form:button{ id = "quickVariations", text = "Variations x3", onclick = function() ui.quick("variations") end }
end
