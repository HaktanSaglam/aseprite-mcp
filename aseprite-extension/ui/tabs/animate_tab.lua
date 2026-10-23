-- Animate tab: turns the active sprite into an animation from a preset.
-- Aseprite starts a new row on a label or a widget type change, so Preset and Mode (two
-- comboboxes) share one, as do From and To (two number boxes) and the two tick boxes; the
-- old "starts from the current frame" hint row now lives in the button text instead.
-- From/To show only for "Between frames" and Keep only for "Continue" (the window calls
-- form:applyVisibility), so the page is six or seven rows.

return function(form, ui, C)
  form:combo{ id = "animPreset", key = "animPreset", label = "Preset / Mode", list = C.ANIMATIONS, onchange = ui.presetChanged }
  form:combo{ id = "animMode", key = "animMode", list = C.ANIMATION_MODES, onchange = ui.animModeChanged }
  form:newrow()
  form:slider{ id = "animFrames", key = "animFrames", label = "Frames", min = 2, max = 16 }
  form:newrow()
  form:number{ id = "animFrameMs", key = "animFrameMs", label = "Frame ms" }
  form:newrow()
  local between = function(s) return s.animMode == "between" end
  form:number{ id = "animFrom", key = "animFrom", label = "From / To", showIf = between }
  form:number{ id = "animTo", key = "animTo", showIf = between }
  form:newrow()
  form:number{
    id = "animKeep", key = "animKeep", label = "Keep frames",
    showIf = function(s) return s.animMode == "continue" end,
  }
  form:newrow()
  -- All directions is greyed out unless the active sprite has direction tags ("down",
  -- "right", ...), e.g. from Generate's 4/8 directions.
  form:check{ id = "animLoop", key = "animLoop", label = "Options", text = "Loop" }
  form:check{ id = "animAllDirections", key = "animAllDirections", text = "All directions" }
  form:newrow()
  form:entry{ id = "animNotes", key = "animNotes", label = "Notes", placeholder = "e.g. cape flutters, sword trail" }
  form:newrow()
  form:button{ id = "animRun", text = "Animate from current frame", onclick = ui.animate }
end
