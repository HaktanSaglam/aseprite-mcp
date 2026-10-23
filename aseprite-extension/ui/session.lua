-- What the window knows about the conversation with the bridge: is a run in progress,
-- what is it doing, how did the last one end, which instant tools still await a result.
-- Bridge events and user actions go in, the chat log and a few state fields come out.
-- Pure (the clock is injected), so the timeouts and edge cases are unit-tested; the
-- window only mirrors this state into widgets.

return function(F)
  local Session = {}
  Session.__index = Session

  -- Seconds without an answer before a request is given up on, so a stopped or outdated
  -- bridge can't leave the window stuck in "Working".
  Session.SEND_TIMEOUT = 20
  Session.TOOL_TIMEOUT = 45
  -- After Stop, how long to wait for the bridge to confirm before ending the run here.
  -- Stopping a CLI takes a moment; a bridge that never confirms must not trap the user.
  Session.STOP_TIMEOUT = 8

  local function str(v)
    if v == nil then return nil end
    return tostring(v)
  end

  -- log: ui/chat_log.lua instance; clock(): seconds; showTools(): log tool calls?
  function Session.new(log, clock, showTools)
    return setmetatable({
      log = log,
      clock = clock or os.time,
      showTools = showTools or function() return true end,
      busy = false,
      awaiting = nil, -- clock() when a request was sent and not yet confirmed
      since = nil, -- clock() when the current run started
      tool = nil, -- last tool the AI called in this run
      progress = nil, -- {done, total, label?} of parallel jobs
      outcome = nil, -- "done" | "error" | "timeout" | "lost" once the run reported its end
      stopping = false,
      stopDeadline = nil, -- clock() by which the bridge should have confirmed a Stop
      note = nil, -- {text, kind}: the latest result, for the header while idle
      toolText = nil, -- latest instant-tool status line
      pending = {}, -- requestId -> {label, sentAt}
      requests = 0,
    }, Session)
  end

  function Session:setNote(text, kind)
    self.note = { text = text, kind = kind }
  end

  function Session:fail(message)
    self.log:add("error", message)
    self:setNote(message, "error")
  end

  function Session:setBusy(busy)
    local now = self.clock()
    if busy and not self.busy then
      self.since, self.tool, self.progress, self.outcome = now, nil, nil, nil
      self.stopping, self.stopDeadline = false, nil
    end
    if not busy and self.busy then
      -- Older bridges send no "done": still say how the run ended.
      if not self.outcome and self.since then
        local verb = self.stopping and "Stopped after " or "Finished in "
        self:setNote(verb .. F.duration(now - self.since), "dim")
      end
      self.tool, self.progress = nil, nil
      self.log:endProgress()
    end
    if not busy then self.awaiting, self.stopDeadline = nil, nil end
    self.busy = busy
  end

  -- A chat_send went out: busy right away, confirmed later by the bridge's busy event.
  function Session:sent(echo)
    self.log:endProgress()
    self.log:add("user", echo)
    self.note = nil
    self.awaiting = self.clock()
    self:setBusy(true)
  end

  function Session:elapsed()
    return self.clock() - (self.since or self.clock())
  end

  -- {event = "chat", kind, ...} from the bridge (json userdata or a table).
  function Session:chatEvent(p)
    local kind = p.kind
    if kind == "text" then
      self.log:add("ai", str(p.text) or "")
    elseif kind == "tool" then
      self.tool = str(p.name)
      if self.showTools() then self.log:addTool(self.tool) end
    elseif kind == "status" then
      self.log:add("status", str(p.text) or "")
    elseif kind == "progress" then
      -- JSON numbers arrive as floats; "%d" formatting needs whole numbers.
      local done = math.floor(tonumber(p.done) or 0)
      local total = math.floor(tonumber(p.total) or 0)
      self.progress = { done = done, total = total, label = str(p.label) }
      self.log:setProgress(done, total, str(p.label))
    elseif kind == "error" then
      self:fail(str(p.text) or "Something went wrong.")
      self.outcome = "error"
      -- An error before "busy" means the request was rejected outright.
      if self.awaiting then self:setBusy(false) end
    elseif kind == "busy" then
      if p.busy == true then
        self.awaiting = nil
        self:setBusy(true)
      else
        self:setBusy(false)
      end
    elseif kind == "done" then
      local text = F.done(p.stats)
      self.log:add("done", text)
      self:setNote(text, "ok")
      self.outcome = "done"
    else
      return false
    end
    if self.awaiting and kind ~= "error" then self.awaiting = nil end
    return true
  end

  -- The bridge was asked to cancel the run (Stop, or New chat during a run): wait for
  -- its "busy = false", but only until STOP_TIMEOUT.
  function Session:awaitStop()
    self.stopping = true
    self.stopDeadline = self.clock() + Session.STOP_TIMEOUT
  end

  -- Returns true when the run ended here rather than by the bridge's confirmation:
  -- the cancel couldn't be sent, or Stop was pressed again while already stopping.
  -- An unconfirmed run (still "Sending...") waits too: the bridge answers a chat_send
  -- with busy = true even when a chat_cancel follows it, and ending it here first made
  -- the buttons flicker back to busy.
  function Session:stop(cancelSent)
    if not self.busy then return false end
    if not cancelSent or self.stopDeadline then
      self.stopping = true
      self.log:add("status", "Stopped.")
      self:setBusy(false)
      return true
    end
    self:awaitStop()
    self.log:add("status", "Stopping...")
    return false
  end

  -- chat_reset also cancels a run in progress; resetSent = false means it never left.
  function Session:newChat(resetSent)
    self.log:clear()
    self.note = nil
    if self.busy then
      if resetSent then
        self:awaitStop()
      else
        self.stopping = true
        self:setBusy(false)
      end
    end
    -- The bridge confirms with its own "New conversation." status line.
    if not resetSent then self.log:add("status", "New conversation.") end
  end

  -- Instant tools --------------------------------------------------------------------

  function Session:nextRequestId()
    self.requests = self.requests + 1
    return "ui-" .. self.requests
  end

  -- kind: "dim" | "ok" | "error"; toLog: also add it to the chat log.
  function Session:toolStatus(text, kind, toLog)
    if toLog then self.log:add(kind == "error" and "error" or "result", text) end
    self.toolText = text
    self:setNote(text, kind)
  end

  function Session:toolSent(requestId, label)
    self.pending[requestId] = { label = label, sentAt = self.clock() }
    self:toolStatus(label .. "...", "dim", false)
  end

  function Session:toolResult(p)
    local id = str(p.requestId)
    local pending = id and self.pending[id]
    if id then self.pending[id] = nil end
    local ok = p.ok == true
    self:toolStatus(F.toolResult(pending and pending.label or "Tool", ok, str(p.text)), ok and "ok" or "error", true)
  end

  function Session:hasPendingTools()
    return next(self.pending) ~= nil
  end

  -- Connection -------------------------------------------------------------------------

  function Session:disconnected()
    if self.busy then
      self.outcome = "lost"
      self:fail("Lost the connection to the bridge.")
      self:setBusy(false)
    end
    for id, p in pairs(self.pending) do
      self.pending[id] = nil
      self:toolStatus(p.label .. ": the bridge disconnected.", "error", true)
    end
  end

  -- Called periodically: expires requests the bridge never answered.
  function Session:tick()
    local now = self.clock()
    if self.busy and self.stopDeadline and now >= self.stopDeadline then
      self.log:add("status", "Stopped. The bridge did not confirm; it may still be finishing.")
      self:setBusy(false)
    elseif self.awaiting and now - self.awaiting >= Session.SEND_TIMEOUT then
      self.outcome = "timeout"
      self:fail("No answer from the bridge. Is it running and up to date? (npm start)")
      self:setBusy(false)
    end
    for id, p in pairs(self.pending) do
      if now - p.sentAt >= Session.TOOL_TIMEOUT then
        self.pending[id] = nil
        self:toolStatus(p.label .. ": no answer from the bridge. Update and restart it.", "error", true)
      end
    end
  end

  function Session:needsTimer()
    return self.busy or self:hasPendingTools()
  end

  return Session
end
