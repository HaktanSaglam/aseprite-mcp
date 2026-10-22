-- Animate tab: turns the active sprite into an animation from a preset.
-- Every widget here is a different type, so each needs its own row (Aseprite starts a
-- new row on a type change); the old "starts from the current frame" hint row now lives
-- in the button text instead.

return function(form, ui, C)
  form:combo{ id = "animPreset", key = "animPreset", label = "Preset", list = C.ANIMATIONS, onchange = ui.presetChanged }
  form:newrow()
  form:slider{ id = "animFrames", key = "animFrames", label = "Frames", min = 2, max = 16 }
  form:newrow()
  form:number{ id = "animFrameMs", key = "animFrameMs", label = "Frame ms" }
  form:newrow()
  form:check{ id = "animLoop", key = "animLoop", label = "Playback", text = "Loop" }
  form:newrow()
  form:entry{ id = "animNotes", key = "animNotes", label = "Notes", placeholder = "e.g. cape flutters, sword trail" }
  form:newrow()
  form:button{ id = "animRun", text = "Animate from current frame", onclick = ui.animate }
end
