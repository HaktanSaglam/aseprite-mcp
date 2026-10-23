-- What "Undo AI run" may take back: per sprite, how many undo steps the last AI run added
-- (the bridge's done.stats.undoSteps). Undoing a fixed number of steps is only right while
-- the sprite's history still ends with that run, so an offer is dropped as soon as the
-- sprite changes in any other way (the user draws, presses Ctrl+Z, runs a tool). Sending
-- "undo 5" after the user drew twice would silently eat their own strokes.
--
-- Pure: the window injects watch(spriteId, onChange) -> stop() | nil, which wraps
-- sprite.events "change". When a sprite can't be watched there is no offer at all.

local U = {}
U.__index = U

function U.new(watch)
  return setmetatable({
    watch = watch,
    -- Sprite the run in flight draws into: an id, or nil when unknown (it makes new sprites).
    running = nil,
    offers = {}, -- spriteId -> {steps, stop}
  }, U)
end

function U:forget(spriteId)
  local offer = spriteId ~= nil and self.offers[spriteId]
  if not offer then return end
  self.offers[spriteId] = nil
  if offer.stop then pcall(offer.stop) end
end

-- A run was sent; spriteId comes from requests.boundSprite.
function U:started(spriteId)
  self.running = spriteId
end

-- The run reported success. Its sprite's earlier offer, if still standing, is replaced
-- only when this run changed something: a run that only answered leaves the history (and
-- the offer for the run before it) as it was.
function U:done(stats)
  local id = self.running
  local steps = stats and math.floor(tonumber(stats.undoSteps) or 0) or 0
  if id == nil or steps <= 0 then return false end
  self:forget(id)
  local offer = { steps = steps }
  local ok, stop = pcall(self.watch, id, function() self:forget(id) end)
  if not ok or not stop then return false end
  offer.stop = stop
  self.offers[id] = offer
  return true
end

-- The run ended (busy = false, a lost connection): a late "done" can't be matched anymore.
function U:ended()
  self.running = nil
end

function U:steps(spriteId)
  local offer = spriteId ~= nil and self.offers[spriteId]
  return offer and offer.steps or nil
end

-- Hands out the steps once; the undo the window sends changes the sprite anyway.
function U:take(spriteId)
  local steps = self:steps(spriteId)
  self:forget(spriteId)
  return steps
end

return U
