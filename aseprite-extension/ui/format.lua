-- Short human-readable strings for the header and the log ("Working 12s · draw_script",
-- "Done in 23s · 5 steps · $0.04"). Pure, so wording and edge cases are unit-tested.
-- "·" (U+00B7) is drawn by ui/text_render.lua, never by a native widget.

local F = {}

local SEP = " · "

function F.duration(seconds)
  seconds = math.max(0, math.floor((tonumber(seconds) or 0) + 0.5))
  if seconds < 60 then return string.format("%ds", seconds) end
  local minutes = seconds // 60
  if minutes < 60 then return string.format("%dm %02ds", minutes, seconds % 60) end
  return string.format("%dh %02dm", minutes // 60, minutes % 60)
end

function F.cost(usd)
  usd = tonumber(usd)
  -- Subscription runs report 0: showing "$0.00" would read like a bug.
  if not usd or usd <= 0 then return nil end
  if usd < 0.01 then return "<$0.01" end
  return string.format("$%.2f", usd)
end

-- stats: {durationMs?, turns?, costUsd?} as sent with chat kind "done".
function F.done(stats)
  local parts = {}
  local ms = stats and tonumber(stats.durationMs)
  parts[1] = ms and ("Done in " .. F.duration(ms / 1000)) or "Done"
  local turns = stats and tonumber(stats.turns)
  if turns and turns > 0 then
    turns = math.floor(turns)
    parts[#parts + 1] = turns == 1 and "1 step" or (turns .. " steps")
  end
  local cost = stats and F.cost(stats.costUsd)
  if cost then parts[#parts + 1] = cost end
  return table.concat(parts, SEP)
end

-- activity: current tool name, or a progress {done, total, label?}.
function F.working(elapsedSeconds, tool, progress)
  local parts = { "Working " .. F.duration(elapsedSeconds) }
  if progress and (progress.total or 0) > 0 then
    local label = (progress.label and progress.label ~= "") and (progress.label .. " ") or ""
    parts[#parts + 1] = string.format("%s%d/%d", label, math.floor(progress.done or 0), math.floor(progress.total))
  end
  if tool and tool ~= "" then parts[#parts + 1] = tool end
  return table.concat(parts, SEP)
end

-- Maps connection.status ("connected", "disconnected", "error: ...") to header text.
function F.connection(status)
  status = tostring(status or "disconnected")
  if status == "connected" then return { state = "ok", text = "Connected" } end
  if status:find("^error") then
    return { state = "error", text = "Bridge offline - start it with: npm start" }
  end
  return { state = "off", text = "Bridge offline - start it with: npm start" }
end

function F.ai(providerLabel, modelLabel, effortLabel)
  local parts = {}
  for _, p in ipairs({ providerLabel, modelLabel, effortLabel }) do
    if p and p ~= "" and p ~= "Default" then parts[#parts + 1] = p end
  end
  return table.concat(parts, SEP)
end

-- Tool results come back as free text from the bridge; keep the log line short.
function F.toolResult(label, ok, text)
  text = tostring(text or "")
  text = text:gsub("%s+", " "):gsub("^ ", ""):gsub(" $", "")
  if text == "" then text = ok and "done" or "failed" end
  return string.format("%s: %s", label, text)
end

-- Keeps at most maxChars characters (UTF-8 aware), ending in "..." when cut.
function F.truncate(text, maxChars)
  text = tostring(text or "")
  maxChars = math.max(4, maxChars)
  local len = utf8.len(text)
  if len == nil then
    -- Invalid UTF-8: fall back to bytes rather than refusing to shorten.
    if #text <= maxChars then return text end
    return text:sub(1, maxChars - 3) .. "..."
  end
  if len <= maxChars then return text end
  return text:sub(1, utf8.offset(text, maxChars - 2) - 1) .. "..."
end

F.SEPARATOR = SEP

return F
