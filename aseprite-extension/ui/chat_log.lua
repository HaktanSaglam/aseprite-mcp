-- The chat history as data: what was said, by whom, and how it is grouped. Rendering
-- (wrapping, colors, scrolling) lives in ui/log_view.lua; this module stays pure so the
-- grouping rules are tested headlessly.
--
-- Kinds: user, ai, tool, status, progress, error, done, result.

local L = {}
L.__index = L

local DEFAULT_MAX = 300

-- A single message longer than this is cut: the log is a few hundred pixels tall, and a
-- pasted HTML error page or stack trace would bury everything else (and wrapping
-- thousands of characters on the first paint stalls the dialog).
L.MAX_TEXT = 2000

-- Lines that say the same thing again add nothing: a double-clicked New chat, Enter
-- pressed twice while still working.
local NO_REPEAT = { status = true, error = true }

-- normalize(text) maps characters the UI font can't draw (see ui/text_render.lua).
function L.new(normalize, max)
  return setmetatable({
    messages = {},
    max = max or DEFAULT_MAX,
    normalize = normalize or tostring,
    -- The progress line of the run in progress (see setProgress).
    progress = nil,
    -- Bumped on every change so views know when cached layout is stale.
    version = 0,
  }, L)
end

function L:changed()
  self.version = self.version + 1
end

function L:push(message)
  self.messages[#self.messages + 1] = message
  while #self.messages > self.max do table.remove(self.messages, 1) end
  self:changed()
  return message
end

local function cut(text)
  if #text <= L.MAX_TEXT then return text end
  -- Back up to a character boundary so a cut never splits ğ or ş.
  local stop = L.MAX_TEXT
  while stop > 0 and text:byte(stop + 1) and text:byte(stop + 1) >= 0x80 and text:byte(stop + 1) < 0xC0 do
    stop = stop - 1
  end
  return text:sub(1, stop) .. " ... (cut)"
end

function L:add(kind, text)
  -- Cut first: normalize walks every character.
  text = self.normalize(cut(tostring(text or "")))
  local last = self:last()
  if NO_REPEAT[kind] and last and last.kind == kind and last.text == text then return last end
  return self:push({ kind = kind, text = text })
end

function L:last()
  return self.messages[#self.messages]
end

-- Consecutive tool calls collapse into one "draw_script, view_sprite" line instead of
-- flooding the log; a repeated call is counted ("draw_script x3") rather than listed.
function L:addTool(name)
  name = self.normalize(tostring(name or "tool"))
  local last = self:last()
  if last and last.kind == "tool" then
    local tools = last.tools
    local tail = tools[#tools]
    if tail.name == name then
      tail.count = tail.count + 1
    else
      tools[#tools + 1] = { name = name, count = 1 }
    end
    last.text = L.toolText(tools)
    self:changed()
    return last
  end
  local tools = { { name = name, count = 1 } }
  return self:push({ kind = "tool", tools = tools, text = L.toolText(tools) })
end

function L.toolText(tools)
  local parts = {}
  for i, t in ipairs(tools) do
    parts[i] = t.count > 1 and string.format("%s x%d", t.name, t.count) or t.name
  end
  return table.concat(parts, ", ")
end

-- The bridge reports parallel jobs as {done, total, label}, where label names the job
-- that just finished ("iron sword"), not the kind of job: "2/6 done · iron sword".
function L.progressText(done, total, label)
  local text = string.format("%d/%d done", done, total)
  if label and label ~= "" then text = text .. " · " .. label end
  return text
end

-- One progress line per run, kept as the newest line: every report moves it to the
-- bottom instead of adding a line, so a batch of six shows each job's reply once and a
-- single "6/6 done" under them rather than a ladder of counters.
function L:setProgress(done, total, label)
  done = math.floor(tonumber(done) or 0)
  total = math.floor(tonumber(total) or 0)
  label = label and self.normalize(tostring(label)) or nil
  local m = self.progress
  if m then
    for i = #self.messages, 1, -1 do
      if self.messages[i] == m then
        table.remove(self.messages, i)
        break
      end
    end
  else
    m = { kind = "progress" }
    self.progress = m
  end
  m.text, m.done, m.total = L.progressText(done, total, label), done, total
  return self:push(m)
end

-- The run ended: its progress line stays where it is, the next run starts a new one.
function L:endProgress()
  self.progress = nil
end

function L:clear()
  self.messages = {}
  self.progress = nil
  self:changed()
end

function L:isEmpty()
  return #self.messages == 0
end

return L
