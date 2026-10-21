-- Canvas colors derived from the active Aseprite theme, so the custom-painted parts
-- (header, chat log) match both the dark and the light theme. Pure RGB math on plain
-- {r, g, b} tables; the view turns them into Color objects.

local T = {}

local function clamp(v)
  return math.max(0, math.min(255, math.floor(v + 0.5)))
end

function T.rgb(r, g, b)
  return { r = clamp(r), g = clamp(g), b = clamp(b) }
end

-- Relative luminance in 0..1 (sRGB weights; precise enough to pick dark vs light).
function T.luminance(c)
  return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255
end

function T.mix(a, b, t)
  return T.rgb(a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t)
end

-- bg/fg: the theme's text box colors. Accents get a dark-theme and a light-theme
-- variant because one fixed color can't read well on both.
function T.palette(bg, fg)
  local dark = T.luminance(bg) < 0.5
  local function pick(onDark, onLight) return dark and onDark or onLight end
  return {
    dark = dark,
    bg = bg,
    text = fg,
    dim = T.mix(fg, bg, 0.45),
    faint = T.mix(fg, bg, 0.8),
    userBubble = pick(T.mix(bg, T.rgb(90, 140, 230), 0.32), T.mix(bg, T.rgb(70, 120, 220), 0.16)),
    userName = pick(T.rgb(140, 185, 255), T.rgb(35, 90, 190)),
    aiName = pick(T.rgb(200, 160, 255), T.rgb(120, 60, 180)),
    tool = T.mix(fg, bg, 0.4),
    error = pick(T.rgb(255, 120, 110), T.rgb(190, 40, 40)),
    ok = pick(T.rgb(110, 215, 140), T.rgb(30, 135, 65)),
    warn = pick(T.rgb(240, 190, 90), T.rgb(170, 110, 0)),
    accent = pick(T.rgb(110, 170, 255), T.rgb(40, 110, 210)),
    track = T.mix(fg, bg, 0.85),
  }
end

return T
