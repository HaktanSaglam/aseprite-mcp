-- The chat history as data: what was said, by whom, and how it is grouped. Rendering
-- (wrapping, colors, scrolling) lives in ui/log_view.lua; this module stays pure so the
-- grouping rules are tested headlessly.
--
-- Kinds: user, ai, tool, status, progress, error, done, result.

local L = {}
L.__index = L

local DEFAULT_MAX = 300

-- normalize(text) maps characters the UI font can't draw (see ui/text_render.lua).
function L.new(normalize, max)
  return setmetatable({
    messages = {},
    max = max or DEFAULT_MAX,
    normalize = normalize or tostring,
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

function L:add(kind, text)
  return self:push({ kind = kind, text = self.normalize(tostring(text or "")) })
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

-- Parallel jobs report progress repeatedly; update the running line in place so the
-- log shows "Variation 3/4" once instead of four lines.
function L:setProgress(done, total, label)
  done = math.floor(tonumber(done) or 0)
  total = math.floor(tonumber(total) or 0)
  local text
  if label and label ~= "" then
    text = string.format("%s %d/%d", self.normalize(tostring(label)), done, total)
  else
    text = string.format("Progress %d/%d", done, total)
  end
  local last = self:last()
  if last and last.kind == "progress" then
    last.text, last.done, last.total = text, done, total
    self:changed()
    return last
  end
  return self:push({ kind = "progress", text = text, done = done, total = total })
end

function L:clear()
  self.messages = {}
  self:changed()
end

function L:isEmpty()
  return #self.messages == 0
end

return L
