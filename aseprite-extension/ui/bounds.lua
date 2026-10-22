-- Where the window reopens: the saved rectangle, moved and shrunk so it fits inside
-- Aseprite's main window. Pure (plain numbers in, a plain table out) so the rules are
-- tested headlessly; ui/main_window.lua turns the result into a Rectangle.
--
-- The saved place can be stale: another monitor, a smaller screen, a bigger UI scale,
-- or an older and taller layout. A window that would open half off-screen hides its
-- title bar or its buttons, and there is no other way to reach them.

local B = {}

-- Less of the window than this on screen (on either axis) counts as lost: open it in
-- Aseprite's default place instead of dragging it back from a corner.
B.MIN_VISIBLE = 40

local function clamp(v, lo, hi)
  return math.max(lo, math.min(v, hi))
end

-- saved = {x, y, width, height} (any may be nil), hint = {width, height} (the dialog's
-- smallest size), screen = {width, height} (the main window). Returns {x, y, width,
-- height}, or nil for "let Aseprite place it".
function B.fit(saved, hint, screen)
  local x, y, w, h = saved.x, saved.y, saved.width, saved.height
  if not (x and y and w and h and screen and screen.width and screen.height) then return nil end
  local sw, sh = screen.width, screen.height
  local minW, minH = (hint and hint.width) or 0, (hint and hint.height) or 0

  -- Never smaller than the content, never bigger than the screen (unless the content
  -- itself is: then it gets its minimum and Aseprite shows what fits).
  w = clamp(w, minW, math.max(minW, sw))
  h = clamp(h, minH, math.max(minH, sh))

  local visibleW = math.min(x + w, sw) - math.max(x, 0)
  local visibleH = math.min(y + h, sh) - math.max(y, 0)
  if visibleW < B.MIN_VISIBLE or visibleH < B.MIN_VISIBLE then return nil end

  x = clamp(x, 0, math.max(0, sw - w))
  y = clamp(y, 0, math.max(0, sh - h))
  return { x = x, y = y, width = w, height = h }
end

return B
