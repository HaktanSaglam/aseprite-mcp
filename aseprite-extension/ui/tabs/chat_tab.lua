-- Chat tab: the message box and the quick AI choices. The conversation log itself sits
-- above the tabs (see main_window.build) because tab pages don't hide canvases.
-- ui: handlers and option sources from ui/main_window.lua.

return function(form, ui)
  -- focus = true makes Send the Enter target for the entry. It is the window's only
  -- such button: Enter keys nobody uses (e.g. pressed in the canvas) are offered to
  -- every open window, and a stray Enter must never start a paid generation. Send
  -- ignores Enter while the message box is empty or another tab is shown.
  -- The entry itself gets no focus = true: Aseprite would focus it even while another
  -- tab is shown, and keys typed there would land in a hidden box. The window focuses
  -- it whenever the Chat tab is shown instead.
  -- text: what was typed before the window was closed or rebuilt.
  form:entry{ id = "chatInput", text = ui.draft(), placeholder = "Ask the AI to draw or edit... (Enter sends)" }
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
  form:newrow()
  -- Undo AI run stays greyed out until the last run on the active sprite reported its undo
  -- steps, and again once anything else changed that sprite (see ui/run_undo.lua).
  form:button{ id = "quickRepeat", text = "Repeat last", onclick = ui.repeatLast }
  form:button{ id = "quickUndoRun", text = "Undo AI run", enabled = false, onclick = ui.undoRun }
end
