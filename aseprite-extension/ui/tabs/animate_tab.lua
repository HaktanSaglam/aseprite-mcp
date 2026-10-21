-- Animate tab: turns the active sprite into an animation from a preset.

return function(form, ui, C)
  form:label{ id = "animHint", text = "Starts from the active sprite's current frame." }
  form:combo{ id = "animPreset", key = "animPreset", label = "Preset", list = C.ANIMATIONS, onchange = ui.presetChanged }
  form:slider{ id = "animFrames", key = "animFrames", label = "Frames", min = 2, max = 16 }
  form:number{ id = "animFrameMs", key = "animFrameMs", label = "Frame ms" }
  form:check{ id = "animLoop", key = "animLoop", label = "Playback", text = "Loop" }
  form:entry{ id = "animNotes", key = "animNotes", label = "Notes", placeholder = "e.g. cape flutters, sword trail" }
  form:button{ id = "animRun", text = "Animate", onclick = ui.animate }
end
