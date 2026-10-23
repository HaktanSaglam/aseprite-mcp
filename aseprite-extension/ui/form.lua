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

  -- spec: the builder's spec (its showIf is kept); w: what the form remembers.
  function Form:track(spec, kind, w)
    w.kind = kind
    w.showIf = spec.showIf
    -- What the dialog shows, so Form:enable can skip no-op changes.
    w.enabled = spec.enabled ~= false
    self.widgets[spec.id] = w
    self.order[#self.order + 1] = spec.id
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
  -- showIf(settingsSnapshot) -> bool, optional: see Form:applyVisibility.

  function Form:entry(spec)
    self:track(spec, "entry", { key = spec.key, onchange = spec.onchange })
    self.dlg:entry{
      id = spec.id, label = spec.label,
      text = spec.key and S.get(self.prefs, spec.key) or spec.text or "",
      placeholder = spec.placeholder, focus = spec.focus,
      onchange = spec.onchange and self:userChange(spec.onchange) or nil,
    }
  end

  function Form:number(spec)
    self:track(spec, "number", { key = spec.key, onchange = spec.onchange })
    local value = spec.key and S.get(self.prefs, spec.key) or spec.value or 0
    self.dlg:number{
      id = spec.id, label = spec.label, text = tostring(value), decimals = 0,
      onchange = spec.onchange and self:userChange(spec.onchange) or nil,
    }
  end

  function Form:check(spec)
    self:track(spec, "check", { key = spec.key, onchange = spec.onchange })
    self.dlg:check{
      id = spec.id, label = spec.label, text = spec.text,
      selected = spec.key and S.get(self.prefs, spec.key) or spec.selected or false,
      onclick = self:userChange(spec.onchange),
    }
  end

  function Form:slider(spec)
    self:track(spec, "slider", { key = spec.key, onchange = spec.onchange, min = spec.min, max = spec.max })
    self.dlg:slider{
      id = spec.id, label = spec.label, min = spec.min, max = spec.max,
      value = spec.key and S.get(self.prefs, spec.key) or spec.value or spec.min,
      onchange = spec.onchange and self:userChange(spec.onchange) or nil,
    }
  end

  -- list: static {id, label} list, or a function returning the current one (providers).
  function Form:combo(spec)
    local list = type(spec.list) == "function" and spec.list() or spec.list
    local labels = C.labels(list)
    -- labels: what the combobox shows now, so setOptions can skip identical refills.
    self:track(spec, "combo", { key = spec.key, list = spec.list, onchange = spec.onchange, labels = labels })
    local selectedId = spec.selected
    if selectedId == nil and spec.key then selectedId = S.get(self.prefs, spec.key) end
    self.dlg:combobox{
      id = spec.id, label = spec.label,
      options = labels,
      option = C.labelOf(list, selectedId),
      onchange = self:userChange(spec.onchange),
    }
  end

  function Form:color(spec)
    self:track(spec, "color", { key = spec.key, onchange = spec.onchange })
    self.dlg:color{
      id = spec.id, label = spec.label,
      color = colorOf(S.get(self.prefs, spec.key)),
      onchange = self:userChange(spec.onchange),
    }
  end

  function Form:label(spec)
    self:track(spec, "label", { text = spec.text or "" })
    self.dlg:label{ id = spec.id, label = spec.label, text = spec.text or "" }
  end

  -- A file picker button (Dialog:file): it shows the picked file's name, and its value is
  -- the full path. title is the file dialog's title; filetypes e.g. {"png"}.
  function Form:file(spec)
    self:track(spec, "file", { key = spec.key, onchange = spec.onchange })
    self.dlg:file{
      id = spec.id, label = spec.label, title = spec.title, open = true,
      filename = spec.key and S.get(self.prefs, spec.key) or spec.filename or "",
      filetypes = spec.filetypes,
      onchange = self:userChange(spec.onchange),
    }
  end

  -- Canvas sizes are logical px (Aseprite scales them by the UI scale).
  function Form:canvas(spec)
    self.dlg:canvas{
      id = spec.id, width = spec.width, height = spec.height,
      hexpand = spec.hexpand, vexpand = spec.vexpand,
      onpaint = self:safe(spec.onpaint),
      onwheel = spec.onwheel and self:safe(spec.onwheel) or nil,
      onmousedown = spec.onmousedown and self:safe(spec.onmousedown) or nil,
    }
  end

  function Form:newrow()
    self.dlg:newrow()
  end

  function Form:separator(text)
    self.dlg:separator{ text = text }
  end

  function Form:button(spec)
    self:track(spec, "button", {})
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

  local function sameLabels(a, b)
    if a == nil or #a ~= #b then return false end
    for i = 1, #b do
      if a[i] ~= b[i] then return false end
    end
    return true
  end

  -- Refills a combobox. Returns false when this Aseprite can't change options in place
  -- (the caller then rebuilds the dialog).
  -- Unchanged options are left alone: every bridge_info (one per reconnect) would
  -- otherwise relayout the dialog, and refilling the provider box from inside its own
  -- onchange would delete the items of the list the user is just closing.
  function Form:setOptions(id, list, selectedId)
    local labels = C.labels(list)
    local want = C.labelOf(list, selectedId)
    local w = self.widgets[id]
    if w and sameLabels(w.labels, labels) then
      if self.dlg.data[id] ~= want then
        self:quietly(function() self.dlg:modify{ id = id, option = want } end)
      end
      return true
    end
    self:quietly(function()
      self.dlg:modify{ id = id, options = labels, option = want }
    end)
    local ok = self.dlg.data[id] == want
    if w and ok then w.labels = labels end
    return ok
  end

  function Form:select(id, selectedId)
    local w = self.widgets[id]
    self:quietly(function()
      self.dlg:modify{ id = id, option = C.labelOf(listOf(w), selectedId) }
    end)
  end

  -- The modify{} that shows `value` (in the setting's representation) in widget w.
  local function showValue(dlg, id, w, value)
    if w.kind == "entry" then
      dlg:modify{ id = id, text = tostring(value or "") }
    elseif w.kind == "number" then
      dlg:modify{ id = id, text = tostring(math.floor(tonumber(value) or 0)) }
    elseif w.kind == "check" then
      dlg:modify{ id = id, selected = value == true }
    elseif w.kind == "slider" then
      dlg:modify{ id = id, value = math.floor(tonumber(value) or 0) }
    elseif w.kind == "combo" then
      dlg:modify{ id = id, option = C.labelOf(listOf(w), value) }
    elseif w.kind == "color" then
      dlg:modify{ id = id, color = colorOf(value) }
    elseif w.kind == "file" then
      dlg:modify{ id = id, filename = tostring(value or "") }
    end
  end

  -- Shows the current prefs in the widgets bound to `keys` (e.g. after the window loaded
  -- them from somewhere else), without running change handlers.
  function Form:reload(keys)
    local wanted = {}
    for _, key in ipairs(keys) do wanted[key] = true end
    self:quietly(function()
      for _, id in ipairs(self.order) do
        local w = self.widgets[id]
        if w.key and wanted[w.key] then showValue(self.dlg, id, w, S.get(self.prefs, w.key)) end
      end
    end)
  end

  -- Shows exactly the widgets whose showIf holds for the settings snapshot `s`. A row
  -- whose widgets are all hidden takes no room (labels hide with their widget), which
  -- is how one tab can offer many option sets without growing the window. Only changes
  -- are sent: every visibility modify() relayouts the dialog.
  function Form:applyVisibility(s)
    for _, id in ipairs(self.order) do
      local w = self.widgets[id]
      if w.showIf then
        local visible = w.showIf(s) and true or false
        if w.visible ~= visible then
          w.visible = visible
          self.dlg:modify{ id = id, visible = visible }
        end
      end
    end
  end

  -- enable and setText are called on every state change (and enable by the spinner), so
  -- they only reach the dialog when the value differs: a label's new text relayouts the
  -- whole dialog, and a bridge_info per reconnect shouldn't make it flicker.
  function Form:enable(id, enabled)
    local w = self.widgets[id]
    if not w or w.enabled == enabled then return end
    w.enabled = enabled
    self.dlg:modify{ id = id, enabled = enabled }
  end

  -- Labels only: an entry's text changes as the user types, so it can't be cached.
  function Form:setText(id, text)
    local w = self.widgets[id]
    if not w then return end
    if w.kind == "label" then
      if w.text == text then return end
      w.text = text
    end
    self.dlg:modify{ id = id, text = text }
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
        if w.kind == "label" then w.text = tostring(value or "") end
      elseif w.kind == "number" then
        dlg:modify{ id = id, text = tostring(math.floor(tonumber(value) or 0)) }
      elseif w.kind == "check" then
        dlg:modify{ id = id, selected = value == true or value == "true" }
      elseif w.kind == "slider" then
        dlg:modify{ id = id, value = math.floor(tonumber(value) or 0) }
      elseif w.kind == "combo" then
        -- JSON numbers arrive as floats: 8.0 must find the option "8" (a sprite id, a count).
        if type(value) == "number" then value = tostring(math.tointeger(value) or value) end
        local list = listOf(w)
        local item = C.find(list, value) or C.findByLabel(list, value)
        if not item then error("Option not found for " .. id .. ": " .. tostring(value), 0) end
        dlg:modify{ id = id, option = item.label }
      elseif w.kind == "color" then
        dlg:modify{ id = id, color = colorOf(S.coerce(w.key, value)) }
      elseif w.kind == "file" then
        dlg:modify{ id = id, filename = tostring(value or "") }
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
