-- Thin layer over Dialog that remembers, for every widget, which setting it shows and
-- how to convert its value (combobox label <-> option id, Color <-> hex). That lets the
-- window read the whole dialog into prefs in one pass (pull), rebuild itself from prefs,
-- and lets the dev hook set any widget by id. Tab modules only describe widgets.
--
-- Handlers are wrapped in pcall: an error inside a Dialog callback would otherwise pop
-- up Aseprite's script console in the middle of the user's work.

return function(C, S)
  local Form = {}
  Form.__index = Form

  -- report(message) is told about handler errors (the window logs them in the chat).
  function Form.new(dlg, prefs, report)
    return setmetatable({
      dlg = dlg,
      prefs = prefs,
      report = report or function() end,
      widgets = {},
      order = {},
      buttons = {},
      -- True while the window changes widgets itself, so onchange handlers can tell
      -- programmatic changes (e.g. refilling a combobox) from the user's.
      updating = false,
    }, Form)
  end

  function Form:safe(fn)
    if not fn then return nil end
    return function(...)
      local ok, err = pcall(fn, ...)
      if not ok then self.report(tostring(err)) end
    end
  end

  -- Wraps a user-change handler: skipped while the window itself is updating widgets.
  function Form:userChange(fn)
    return self:safe(function(...)
      if self.updating then return end
      if fn then fn(...) end
    end)
  end

  function Form:track(id, kind, spec)
    spec.kind = kind
    self.widgets[id] = spec
    self.order[#self.order + 1] = id
  end

  local function hexOf(color)
    return string.format("%02x%02x%02x%02x", color.red, color.green, color.blue, color.alpha)
  end

  local function colorOf(hex)
    return Color{
      r = tonumber(hex:sub(1, 2), 16), g = tonumber(hex:sub(3, 4), 16),
      b = tonumber(hex:sub(5, 6), 16), a = tonumber(hex:sub(7, 8), 16) or 255,
    }
  end

  -- Widget builders ------------------------------------------------------------
  -- spec fields: id (required), key (setting name, optional), label, plus the
  -- Dialog fields of that widget. onchange/onclick are wrapped automatically.

  function Form:entry(spec)
    self:track(spec.id, "entry", { key = spec.key, onchange = spec.onchange })
    self.dlg:entry{
      id = spec.id, label = spec.label,
      text = spec.key and S.get(self.prefs, spec.key) or spec.text or "",
      placeholder = spec.placeholder, focus = spec.focus,
      onchange = spec.onchange and self:userChange(spec.onchange) or nil,
    }
  end

  function Form:number(spec)
    self:track(spec.id, "number", { key = spec.key, onchange = spec.onchange })
    local value = spec.key and S.get(self.prefs, spec.key) or spec.value or 0
    self.dlg:number{
      id = spec.id, label = spec.label, text = tostring(value), decimals = 0,
      onchange = spec.onchange and self:userChange(spec.onchange) or nil,
    }
  end

  function Form:check(spec)
    self:track(spec.id, "check", { key = spec.key, onchange = spec.onchange })
    self.dlg:check{
      id = spec.id, label = spec.label, text = spec.text,
      selected = spec.key and S.get(self.prefs, spec.key) or spec.selected or false,
      onclick = self:userChange(spec.onchange),
    }
  end

  function Form:slider(spec)
    self:track(spec.id, "slider", { key = spec.key, onchange = spec.onchange, min = spec.min, max = spec.max })
    self.dlg:slider{
      id = spec.id, label = spec.label, min = spec.min, max = spec.max,
      value = spec.key and S.get(self.prefs, spec.key) or spec.value or spec.min,
      onchange = spec.onchange and self:userChange(spec.onchange) or nil,
    }
  end

  -- list: static {id, label} list, or a function returning the current one (providers).
  function Form:combo(spec)
    self:track(spec.id, "combo", { key = spec.key, list = spec.list, onchange = spec.onchange })
    local list = type(spec.list) == "function" and spec.list() or spec.list
    local selectedId = spec.selected
    if selectedId == nil and spec.key then selectedId = S.get(self.prefs, spec.key) end
    self.dlg:combobox{
      id = spec.id, label = spec.label,
      options = C.labels(list),
      option = C.labelOf(list, selectedId),
      onchange = self:userChange(spec.onchange),
    }
  end

  function Form:color(spec)
    self:track(spec.id, "color", { key = spec.key, onchange = spec.onchange })
    self.dlg:color{
      id = spec.id, label = spec.label,
      color = colorOf(S.get(self.prefs, spec.key)),
      onchange = self:userChange(spec.onchange),
    }
  end

  function Form:label(spec)
    self:track(spec.id, "label", {})
    self.dlg:label{ id = spec.id, label = spec.label, text = spec.text or "" }
  end

  -- Canvas sizes are logical px (Aseprite scales them by the UI scale).
  function Form:canvas(spec)
    self.dlg:canvas{
      id = spec.id, width = spec.width, height = spec.height,
      hexpand = spec.hexpand, vexpand = spec.vexpand,
      onpaint = self:safe(spec.onpaint),
      onwheel = spec.onwheel and self:safe(spec.onwheel) or nil,
    }
  end

  function Form:separator(text)
    self.dlg:separator{ text = text }
  end

  function Form:button(spec)
    self:track(spec.id, "button", {})
    local handler = self:safe(spec.onclick)
    self.buttons[spec.id] = handler
    self.dlg:button{
      id = spec.id, label = spec.label, text = spec.text, focus = spec.focus,
      enabled = spec.enabled, onclick = handler,
    }
  end

  -- Reading -----------------------------------------------------------------------

  local function listOf(w)
    return type(w.list) == "function" and w.list() or w.list
  end

  -- Converts a raw Dialog.data value into the setting's representation.
  function Form:convert(id, raw)
    local w = self.widgets[id]
    if not w then return nil end
    if w.kind == "combo" then return C.idOf(listOf(w), raw) end
    if w.kind == "color" then return raw and hexOf(raw) or nil end
    return raw
  end

  -- Copies every bound widget into prefs (through settings validation).
  function Form:pull()
    local data = self.dlg.data
    for _, id in ipairs(self.order) do
      local w = self.widgets[id]
      if w.key then
        local value = self:convert(id, data[id])
        if value ~= nil or w.kind == "combo" then S.set(self.prefs, w.key, value) end
      end
    end
    return data
  end

  function Form:value(id)
    return self:convert(id, self.dlg.data[id])
  end

  -- Writing -----------------------------------------------------------------------

  -- Programmatic change that must not trigger the user-change handlers.
  function Form:quietly(fn)
    local was = self.updating
    self.updating = true
    local ok, err = pcall(fn)
    self.updating = was
    if not ok then error(err, 0) end
  end

  -- Refills a combobox. Returns false when this Aseprite can't change options in place
  -- (the caller then rebuilds the dialog).
  function Form:setOptions(id, list, selectedId)
    local labels = C.labels(list)
    local want = C.labelOf(list, selectedId)
    self:quietly(function()
      self.dlg:modify{ id = id, options = labels, option = want }
    end)
    return self.dlg.data[id] == want
  end

  function Form:select(id, selectedId)
    local w = self.widgets[id]
    self:quietly(function()
      self.dlg:modify{ id = id, option = C.labelOf(listOf(w), selectedId) }
    end)
  end

  function Form:enable(id, enabled)
    if self.widgets[id] then self.dlg:modify{ id = id, enabled = enabled } end
  end

  function Form:setText(id, text)
    if self.widgets[id] then self.dlg:modify{ id = id, text = text } end
  end

  -- Sets a widget from an outside value (dev hook): combobox values may be an option id
  -- or its label, colors are hex. Runs the widget's change handler like a user edit.
  function Form:set(id, value)
    local w = self.widgets[id]
    if not w then error("No widget with id " .. tostring(id), 0) end
    local dlg = self.dlg
    self:quietly(function()
      if w.kind == "entry" or w.kind == "label" then
        dlg:modify{ id = id, text = tostring(value or "") }
      elseif w.kind == "number" then
        dlg:modify{ id = id, text = tostring(math.floor(tonumber(value) or 0)) }
      elseif w.kind == "check" then
        dlg:modify{ id = id, selected = value == true or value == "true" }
      elseif w.kind == "slider" then
        dlg:modify{ id = id, value = math.floor(tonumber(value) or 0) }
      elseif w.kind == "combo" then
        local list = listOf(w)
        local item = C.find(list, value) or C.findByLabel(list, value)
        if not item then error("Option not found for " .. id .. ": " .. tostring(value), 0) end
        dlg:modify{ id = id, option = item.label }
      elseif w.kind == "color" then
        dlg:modify{ id = id, color = colorOf(S.coerce(w.key, value)) }
      else
        error("Widget " .. id .. " can't be set", 0)
      end
    end)
    self:pull()
    if w.onchange then self:safe(w.onchange)() end
  end

  function Form:click(id)
    local handler = self.buttons[id]
    if not handler then error("No button with id " .. tostring(id), 0) end
    handler()
  end

  return Form
end
