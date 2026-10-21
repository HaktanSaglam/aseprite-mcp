-- Dev/testing hook: lets automation drive the window, because synthetic mouse and
-- keyboard input can't reach Aseprite's custom-drawn UI on macOS. With it, a script can
-- open the window, switch tabs, fill widgets and press buttons, then take screenshots of
-- every tab.
--
-- The bridge (or any WebSocket peer it relays for) sends:
--   {event = "ui_debug", action = "open" | "tab" | "set" | "click" | "close",
--    tab? = "chat" | "generate" | "animate" | "tools" | "settings",
--    id? = widget id, value? = new value (combobox: option id or label)}
-- and gets back {event = "ui_debug_result", action, ok, error?}.
--
-- Completely inert unless the user sets devMode = true in the extension preferences
-- (the __pref.lua file in the extension folder); nothing in the UI turns it on.

local D = {}

D.ACTIONS = { open = true, tab = true, set = true, click = true, close = true }

-- view: {open(tab?), selectTab(tab), set(id, value), click(id), close()}; each raises
-- an error string for a bad request. Returns nil when inert, else a result message.
function D.handle(event, prefs, view)
  if type(prefs) ~= "table" and type(prefs) ~= "userdata" then return nil end
  if prefs.devMode ~= true then return nil end

  local action = event.action
  local ok, err = pcall(function()
    if not D.ACTIONS[action] then error("Unknown ui_debug action: " .. tostring(action), 0) end
    if action == "open" then
      view.open(event.tab)
    elseif action == "tab" then
      if event.tab == nil then error("ui_debug tab needs a tab", 0) end
      view.selectTab(event.tab)
    elseif action == "set" then
      if event.id == nil then error("ui_debug set needs an id", 0) end
      view.set(event.id, event.value)
    elseif action == "click" then
      if event.id == nil then error("ui_debug click needs an id", 0) end
      view.click(event.id)
    elseif action == "close" then
      view.close()
    end
  end)
  return { event = "ui_debug_result", action = tostring(action), ok = ok, error = (not ok) and tostring(err) or nil }
end

return D
