import { SELOUT_PASS } from "../examples.js";
import type { GuideTopic } from "../GuideTopic.js";

export const outlinesAa: GuideTopic = {
  id: "outlines_aa",
  title: "Outlines, lines and anti-aliasing",
  summary: "Outline styles (black, hue-shifted, selective sel-out, none), clean line rules, jaggies, manual anti-aliasing.",
  body: `
# Outlines, lines and anti-aliasing

## Outline styles
- Black (#000 or near-black like #1a1c2c): retro NES/PICO-8 look, maximum readability on any
  background, heavy at larger sizes.
- Dark hue-shifted (default): each outline pixel is a much darker version of the color it
  surrounds. outline(null) in draw_script does exactly this; add_outline for finished layers.
- Selective outline (sel-out): the outline takes the color of the adjacent fill, darker on
  the shadow side, lighter (or absent) on the lit side. Most polished look for 32px+.
- No outline: HD/painterly styles and backgrounds; separate shapes by value instead.
- Interior lines (between arm and body, folds, hair strands) use the darker tone of that
  material, never the outer outline color, and may break where light hits.

## outline() in scripts
- outline(null) or outline("#1a1c2c"); placement "outside" (default: grows the sprite by
  1px, draw with a 1px margin) or "inside" (recolors the edge pixels, keeps the size).
- connectivity 4 (default) gives a clean 1px line without doubled corners; 8 also fills
  diagonal gaps (thicker, blockier).
- Run it after all shapes, before tiny details that should sit on top of the outline.
- Sel-out in a script (see the example at the end).

## Clean lines
- Pixel-perfect: a 1px line never contains an L-shaped corner (two pixels meeting at a
  right angle inside a diagonal run). line() and curve() avoid them; check hand-drawn grids.
- Use slopes made of equal segments: 1:1 (45 degrees), 2:1, 1:2, 3:1, 1:3. Uneven
  segments (2-1-3-1) look jagged.
- Curves: segment lengths change gradually and symmetrically: 4-3-2-1-1-2-3-4. A jump like
  3-1-3 is a kink. curve(x0, y0, cx, cy, x1, y1, c) draws smooth quadratic arcs; for a
  circle use circle(), not hand lines.
- Jaggies: stray pixels sticking out of a line or curve. Remove them; consistency matters
  more than exact geometry.
- Line weight: 1px everywhere on small sprites; thicker lines only for deliberate style
  (line(..., width) gives round 2-4px strokes).

## Anti-aliasing (manual)
- Purpose: soften a stair-step where a line meets a contrasting fill. Place 1 intermediate
  pixel (mix(lineColor, fillColor, 0.5)) at the inner corner of each step, on the longer
  segments' ends; fewer pixels on short steps.
- Only inside the sprite (between the outline and the fill). Never anti-alias against
  transparency: the sprite will be placed on unknown backgrounds and get a halo.
- Skip AA at 16x16, in 1bit/gameboy/NES/PICO-8 styles, and on small details.
- Too much AA = blurry art. If a curve needs lots of AA, its line is probably uneven: fix the
  segment lengths first.

## Common problems -> fixes
- Doubled outline corners: use connectivity 4, or remove the inner corner pixel.
- Outline too heavy at 16px: switch black to outline(null).
- Outline disappears on dark backgrounds: use sel-out with lighter lit edges, or add a
  1px light rim inside the outline on the lit side.

## Example: selective outline pass
${SELOUT_PASS.code}
`.trim(),
};
