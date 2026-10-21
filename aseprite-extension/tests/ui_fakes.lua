-- Test doubles for driving ui/main_window.lua in batch mode, where Dialog() is nil.
-- FakeDialog mirrors the behaviour of Aseprite 1.3.18's Lua Dialog binding
-- (src/app/script/dialog_class.cpp) where the window depends on it:
--   * Dialog.data builds a fresh table; assigning it rewrites EVERY widget (a missing
--     check becomes unchecked, a missing slider 0) and switches tabs by id.
--   * modify{options} refills a combobox and, like ComboBox::addItem, selects the first
--     item and fires onchange; modify{option} fires onchange when the index changes.
--   * Callbacks only run while the dialog is shown; close() runs onclose.
-- Methods starting with "_" simulate the user (click, type, pick an option).

local Fakes = {}

local function copy(list)
  local out = {}
  for i, v in ipairs(list or {}) do out[i] = v end
  return out
end

-- GraphicsContext ------------------------------------------------------------------

local GC = {}
GC.__index = GC

function Fakes.gc(width, height)
  return setmetatable({ width = width or 340, height = height or 200, color = nil, runs = {}, fills = 0 }, GC)
end

function GC:measureText(s)
  return { width = (utf8.len(s) or #s) * 4, height = 7 }
end

function GC:fillText(s, x, y)
  assert(type(s) == "string", "fillText needs a string")
  assert(self.color ~= nil, "color set before drawing")
  -- The real binding reads x/y with lua_tointeger: 12.5 would silently become 0.
  assert(math.type(x) == "integer" or x == math.floor(x), "fillText x must be a whole number, got " .. tostring(x))
  assert(math.type(y) == "integer" or y == math.floor(y), "fillText y must be a whole number, got " .. tostring(y))
  self.runs[#self.runs + 1] = { x = x, y = y, text = s }
end

-- 1x1 rects are text_render's hand-drawn glyphs: a "·" sits on row 3 of its line.
function GC:fillRect(rect)
  assert(rect ~= nil, "fillRect needs a rectangle")
  self.fills = self.fills + 1
  if rect.width == 1 and rect.height == 1 then
    self.runs[#self.runs + 1] = { x = rect.x, y = rect.y - 3, text = "·" }
  end
end

function GC:beginPath() self.path = true end
function GC:roundedRect(rect, r) assert(self.path, "beginPath first") end
function GC:fill() self.path = false self.fills = self.fills + 1 end
function GC:stroke() assert(self.path, "beginPath first") self.path = false end

-- Reassembles the painted text into lines (runs sorted by y, then x).
function GC:allText()
  local byLine, ys = {}, {}
  for _, run in ipairs(self.runs) do
    if not byLine[run.y] then
      byLine[run.y] = {}
      ys[#ys + 1] = run.y
    end
    table.insert(byLine[run.y], run)
  end
  table.sort(ys)
  local lines = {}
  for _, y in ipairs(ys) do
    local runs = byLine[y]
    table.sort(runs, function(a, b) return a.x < b.x end)
    local parts = {}
    for i, run in ipairs(runs) do parts[i] = run.text end
    lines[#lines + 1] = table.concat(parts)
  end
  return table.concat(lines, "\n")
end

-- Dialog ----------------------------------------------------------------------------

local D = {}
Fakes.instances = {}

local function fire(dlg, fn, ev)
  if fn and dlg.shown then fn(ev or {}) end
end

local function add(dlg, kind, spec)
  local w = { kind = kind, spec = spec, id = spec.id, enabled = spec.enabled ~= false, visible = spec.visible ~= false }
  if kind == "entry" or kind == "label" or kind == "number" then w.text = spec.text or "" end
  if kind == "check" or kind == "button" then w.selected = spec.selected == true end
  if kind == "slider" then
    w.min, w.max = spec.min or 0, spec.max or 100
    w.value = spec.value or 100
  end
  if kind == "combobox" then
    w.options = copy(spec.options)
    w.option = nil
    for _, o in ipairs(w.options) do
      if o == spec.option then w.option = o end
    end
    if w.option == nil then w.option = w.options[1] end
  end
  if kind == "color" then w.color = spec.color or Color{ r = 0, g = 0, b = 0, a = 0 } end
  if spec.focus then w.focusMagnet = true end
  w.tab = dlg.currentTab
  dlg.widgets[#dlg.widgets + 1] = w
  if spec.id then
    assert(dlg.byId[spec.id] == nil, "duplicate widget id " .. spec.id)
    dlg.byId[spec.id] = w
  end
  return dlg
end

for _, kind in ipairs({ "entry", "number", "label", "check", "button", "slider", "combobox", "color", "canvas", "separator" }) do
  D[kind] = function(self, spec)
    if type(spec) == "string" then spec = { text = spec } end
    return add(self, kind, spec or {})
  end
end

function D:radio(spec) return add(self, "check", spec) end
function D:newrow() return self end

function D:tab(spec)
  self.tabs = self.tabs or {}
  self.tabs[#self.tabs + 1] = { id = spec.id or spec.text, text = spec.text }
  self.currentTab = spec.id or spec.text
  return self
end

function D:endtabs(spec)
  local selected = self.tabs[1].id
  for _, t in ipairs(self.tabs) do
    if t.id == spec.selected or t.text == spec.selected then selected = t.id end
  end
  self.currentTab = nil
  local w = { kind = "tabs", id = spec.id, selected = selected, tabs = self.tabs, onchange = spec.onchange }
  self.widgets[#self.widgets + 1] = w
  if spec.id then self.byId[spec.id] = w end
  return self
end

function D:show(spec)
  self.shown = true
  self.showSpec = spec or {}
  if self.showSpec.bounds then self._bounds = self.showSpec.bounds end
  return self
end

function D:close()
  if not self.shown then return self end
  self.shown = false
  self.closed = true
  if self.opts.onclose then self.opts.onclose() end
  return self
end

function D:repaint()
  for _, w in ipairs(self.widgets) do
    if w.kind == "canvas" and w.spec.onpaint and self.shown then
      local gc = Fakes.gc(w.spec.width and w.spec.width > 0 and w.spec.width or 340, w.spec.height or 100)
      w.spec.onpaint({ context = gc })
      w.lastGc = gc
    end
  end
end

local function selectOption(dlg, w, label)
  for _, o in ipairs(w.options) do
    if o == label then
      if w.option ~= label then
        w.option = label
        fire(dlg, w.spec.onchange)
      end
      return
    end
  end
end

function D:modify(spec)
  if spec.id == nil then
    if spec.title then self.title = spec.title end
    return self
  end
  local w = self.byId[spec.id]
  if not w then error('Given id="' .. spec.id .. '" in Dialog:modify{} not found in dialog', 2) end
  if spec.enabled ~= nil then w.enabled = spec.enabled end
  if spec.selected ~= nil then w.selected = spec.selected end
  if spec.visible ~= nil then w.visible = spec.visible end
  if spec.text ~= nil then w.text = tostring(spec.text) end
  if spec.focus then self.focused = spec.id end
  if spec.value ~= nil and w.kind == "slider" then w.value = math.tointeger(spec.value) or math.floor(spec.value) end
  if spec.options ~= nil and w.kind == "combobox" then
    w.options = copy(spec.options)
    w.option = nil
    if #w.options > 0 then
      w.option = w.options[1]
      fire(self, w.spec.onchange)
    end
  end
  if spec.option ~= nil and w.kind == "combobox" then selectOption(self, w, spec.option) end
  if spec.color ~= nil and w.kind == "color" then w.color = spec.color end
  self.modifyCount = (self.modifyCount or 0) + 1
  return self
end

local function getData(dlg)
  local data = {}
  for _, w in ipairs(dlg.widgets) do
    if w.id then
      local k = w.kind
      if k == "button" or k == "check" then
        data[w.id] = w.selected or dlg.lastButton == w
      elseif k == "entry" or k == "label" then
        data[w.id] = w.text
      elseif k == "number" then
        data[w.id] = math.floor(tonumber(w.text) or 0)
      elseif k == "slider" then
        data[w.id] = w.value
      elseif k == "combobox" then
        data[w.id] = w.option
      elseif k == "color" then
        data[w.id] = w.color
      elseif k == "tabs" then
        data[w.id] = w.selected
      end
    end
  end
  return data
end

local function setData(dlg, t)
  for _, w in ipairs(dlg.widgets) do
    if w.id then
      local v = t[w.id]
      local k = w.kind
      if k == "button" or k == "check" then
        w.selected = v and true or false
      elseif k == "entry" or k == "label" then
        if type(v) == "string" or type(v) == "number" then w.text = tostring(v) end
      elseif k == "number" then
        w.text = string.format("%d", math.tointeger(v) or 0)
      elseif k == "slider" then
        w.value = math.tointeger(v) or 0
      elseif k == "combobox" then
        if type(v) == "string" then
          for _, o in ipairs(w.options) do
            if o == v then w.option = o end
          end
        end
      elseif k == "color" then
        w.color = v or Color{ r = 0, g = 0, b = 0, a = 0 }
      elseif k == "tabs" then
        if type(v) == "string" then
          for _, tab in ipairs(w.tabs) do
            if tab.id == v then w.selected = v end
          end
        end
      end
    end
  end
end

local Meta = {
  __index = function(self, key)
    if key == "data" then return getData(self) end
    if key == "bounds" then return self._bounds or Rectangle(100, 80, 420, 560) end
    if key == "sizeHint" then return Size(380, 520) end
    return D[key]
  end,
  __newindex = function(self, key, value)
    if key == "data" then return setData(self, value) end
    if key == "bounds" then return rawset(self, "_bounds", value) end
    rawset(self, key, value)
  end,
}

local function newDialog(opts)
  if type(opts) == "string" then opts = { title = opts } end
  local dlg = setmetatable({ opts = opts or {}, widgets = {}, byId = {}, shown = false }, Meta)
  Fakes.instances[#Fakes.instances + 1] = dlg
  return dlg
end

-- User simulation ------------------------------------------------------------------

function D:_widget(id)
  local w = self.byId[id]
  assert(w, "no widget " .. tostring(id))
  return w
end

-- Like a real click: ignored when disabled or not visible.
function D:_click(id)
  local w = self:_widget(id)
  if not w.enabled then return false end
  if w.kind == "check" then w.selected = not w.selected end
  if w.kind == "button" then self.lastButton = w end
  fire(self, w.spec.onclick)
  return true
end

function D:_type(id, text)
  local w = self:_widget(id)
  w.text = text
  fire(self, w.spec.onchange)
end

function D:_choose(id, label)
  local w = self:_widget(id)
  assert(w.enabled, id .. " is disabled")
  local found = false
  for _, o in ipairs(w.options) do
    if o == label then found = true end
  end
  assert(found, "option " .. tostring(label) .. " not in " .. id .. ": " .. table.concat(w.options, ","))
  selectOption(self, w, label)
end

function D:_slide(id, value)
  local w = self:_widget(id)
  w.value = value
  fire(self, w.spec.onchange)
end

function D:_tab(tabId)
  local w = self:_widget("tabs")
  w.selected = tabId
  fire(self, w.onchange, { tab = tabId })
end

-- Connection / Timer / clock ---------------------------------------------------------

function Fakes.connection()
  local c = { status = "connected", sent = {}, listeners = {}, online = true }
  function c.send(tbl)
    if not c.online then return false end
    local ok, text = pcall(json.encode, tbl)
    if not ok then return false end
    c.sent[#c.sent + 1] = text
    return true
  end
  function c.subscribe(fn)
    c.listeners[#c.listeners + 1] = fn
    return function() end
  end
  -- Delivers a bridge event exactly as connection.lua would: decoded JSON userdata.
  function c.event(tbl)
    local msg = json.decode(json.encode(tbl))
    for _, fn in ipairs(c.listeners) do fn("event", msg) end
  end
  function c.setStatus(status)
    c.status = status
    c.online = status == "connected"
    for _, fn in ipairs(c.listeners) do fn("status", status) end
  end
  function c.last()
    return c.sent[#c.sent] and json.decode(c.sent[#c.sent]) or nil
  end
  function c.lastRaw()
    return c.sent[#c.sent]
  end
  return c
end

Fakes.timers = {}

local function newTimer(spec)
  local t = { interval = spec.interval, ontick = spec.ontick, isRunning = false }
  function t:start() self.isRunning = true end
  function t:stop() self.isRunning = false end
  Fakes.timers[#Fakes.timers + 1] = t
  return t
end

function Fakes.tickAll()
  for _, t in ipairs(Fakes.timers) do
    if t.isRunning then t.ontick() end
  end
end

local clock = 1000
function Fakes.advance(seconds) clock = clock + seconds end

-- Swaps the globals the window uses; returns a function that restores them.
function Fakes.install()
  local saved = { Dialog = Dialog, Timer = Timer, time = os.time }
  Dialog = newDialog
  Timer = newTimer
  os.time = function() return clock end
  return function()
    Dialog, Timer, os.time = saved.Dialog, saved.Timer, saved.time
  end
end

return Fakes
