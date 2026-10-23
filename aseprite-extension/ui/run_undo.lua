-- What "Undo AI run" may take back: per sprite, how many undo steps the last AI run added
-- (the bridge's done.stats.undoSteps). Undoing a fixed number of steps is only right while
-- exactly those steps sit on top of the sprite's history. Sending "undo 5" after the user
-- drew twice would silently eat their own strokes, so:
--
--  * During the run the sprite is watched from the moment the request is sent, and every
--    sprite.events "change" is counted. Aseprite 1.3.18 fires exactly one per undo step
--    added to the sprite (a transaction, an empty one too, or an API call made outside
--    one) and one per step undone or redone; writing sprite.properties, a rolled-back
--    transaction or switching tabs fire none (measured headless; tests/ui_test.lua keeps
--    checking it). So the count equals undoSteps only when nothing but the run's own steps
--    reached the sprite: a stroke the user drew meanwhile, a Ctrl+Z or a tool makes it
--    larger, and then there is no offer. A run that undid or redid steps itself is not
--    offered either (its undos are counted, the bridge's net steps are not); that is rare
--    and only costs the button.
--  * After the run, the offer is dropped as soon as the sprite changes in any way (the
--    user draws, presses Ctrl+Z, runs a tool).
--
-- The bridge says which sprite the steps belong to (stats.sprite); they are offered only
-- when that is the sprite watched since the start. A run sent without a sprite (the bridge
-- picks the active one when it starts) can't be watched from its first step, so it is never
-- offered.
--
-- Pure: the window injects watch(spriteId, onChange) -> stop() | nil, which wraps
-- sprite.events "change". When a sprite can't be watched there is no offer at all.

local U = {}
U.__index = U

function U.new(watch)
  return setmetatable({
    watch = watch,
    -- The run in flight: {sprite, changes, stop}, or nil when it has no sprite of its own
    -- (it makes new sprites) or its sprite can't be watched.
    run = nil,
    offers = {}, -- spriteId -> {steps, stop}
  }, U)
end

-- JSON numbers arrive as floats (7.0); ids and step counts are whole numbers.
local function whole(v)
  local n = tonumber(v)
  if n == nil then return nil end
  return math.tointeger(n) or math.floor(n)
end

local function field(stats, key)
  local ok, value = pcall(function() return stats[key] end)
  return ok and value or nil
end

function U:forget(spriteId)
  local offer = spriteId ~= nil and self.offers[spriteId]
  if not offer then return end
  self.offers[spriteId] = nil
  if offer.stop then pcall(offer.stop) end
end

function U:stopRun()
  local run = self.run
  self.run = nil
  if run and run.stop then pcall(run.stop) end
end

-- A run was sent; spriteId comes from requests.boundSprite. Counting starts now, before
-- the bridge draws anything, so every step that lands on the sprite during the run is seen.
function U:started(spriteId)
  self:stopRun()
  if spriteId == nil then return end
  local run = { sprite = spriteId, changes = 0 }
  local ok, stop = pcall(self.watch, spriteId, function() run.changes = run.changes + 1 end)
  if not ok or not stop then return end
  run.stop = stop
  self.run = run
end

-- The run reported success. Its sprite's earlier offer, if still standing, is replaced
-- only when this run changed something: a run that only answered leaves the history (and
-- the offer for the run before it) as it was. Any step this run added already withdrew
-- that earlier offer through its own listener.
function U:done(stats)
  local run = self.run
  self:stopRun()
  if run == nil or stats == nil then return false end
  local steps = whole(field(stats, "undoSteps")) or 0
  if steps <= 0 then return false end
  local sprite = whole(field(stats, "sprite")) or run.sprite
  if sprite ~= run.sprite or run.changes ~= steps then return false end
  self:forget(sprite)
  local offer = { steps = steps }
  local ok, stop = pcall(self.watch, sprite, function() self:forget(sprite) end)
  if not ok or not stop then return false end
  offer.stop = stop
  self.offers[sprite] = offer
  return true
end

-- The run ended (busy = false, a lost connection): a late "done" can't be matched anymore.
function U:ended()
  self:stopRun()
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
