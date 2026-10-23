import { DUSK_SCENE } from "../examples.js";
import type { GuideTopic } from "../GuideTopic.js";

export const environments: GuideTopic = {
  id: "environments",
  title: "Environments and backgrounds",
  summary: "Scenes, parallax layers, atmospheric perspective, skies (bands/dither), clouds, time-of-day palettes.",
  body: `
# Environments and backgrounds

## Canvas and composition
- Common scene sizes: 320x180, 256x144, 160x90, 480x270 (16:9). Game backgrounds are often
  wider than the screen for scrolling.
- Horizon at 1/3 or 2/3 of the height, never centered. One focal point (sun, castle,
  glowing tree) with the most contrast; everything else supports it.
- Draw back to front in one or a few draw_script calls; put each parallax plane on its own
  layer (layer: "sky", "far", "mid", "near") when the user may want to scroll them.

## Atmospheric perspective (the key to depth)
- Farther = lower contrast, lighter (or closer to the sky color), less saturated, less detail,
  smaller features. Nearer = darker, more saturated, more detail, bigger shapes.
- Each parallax layer uses its own 1-2 colors, stepping from the sky color toward the
  foreground color. mix(sky, groundDark, 0.3 / 0.6 / 0.9) gives evenly spaced layers.
- Ridgelines: noise(x, 0, scale, 2-3). Far ranges: large scale (broad, smooth), placed
  higher on screen, palest. Near ranges: small scale (bumpy), lower on screen, darkest.

## Skies
- 3-6 horizontal bands from zenith to horizon. gradient(..., "v", "checker") gives clean bands
  with a 2px checker transition; "dither" for a retro look; "bands" for flat stylised skies.
- Day: deep blue -> light blue -> pale near the horizon. Dusk: indigo -> violet -> pink ->
  orange -> pale yellow at the horizon. Night: navy -> dark blue-violet, stars, moon glow.
- Sun/moon: a flat disc plus 1-2 radial bands of glow (gradient(..., "radial", "bands")).
- Clouds: flat-bottomed clumps of overlapping circles; lit side (toward the sun) in the
  lightest tone, 1-2 px underside shadow; far clouds smaller, flatter, lower contrast.
- Stars: sparse single pixels in 2 brightnesses; a few 3px plus-shaped bright stars.

## Ground, foliage, water
- Ground plane: horizontal bands that get taller toward the viewer.
- Trees: trunk + canopy of overlapping circles; canopy lit from the light side, dark
  underside cluster; distant trees are simple blobs in the layer color.
- Foliage texture: noise threshold clusters (noise(x, y, 4) > 0.6 -> light tone), not random dots.
- Water: reflect the sky colors, slightly darker; horizontal highlight dashes; reflections of
  objects broken into horizontal strips.

## Interiors and top-down maps
- Top-down RPG: walls show their front face (3-6 px tall) and a darker top cap; floors are
  tiled (see tiles); objects cast a 1-2 px shadow down-right.
- Light sources (torches, windows): a radial glow with 2-3 bands of warmer, lighter color
  (gradient radial "bands" or concentric circles), plus a darker vignette at the corners.

## Time-of-day palettes (sky top -> horizon, then land far -> near)
- Day: #3b6fd4 #5f9fe8 #a6d4f2 #e8f4f8 | land #8fb8a8 #5a8a6a #2f5a3f
- Dusk: #2b2a5c #4a3f7d #8a5a9c #e0868a #f6c28b | land #9a6a98 #5c4378 #2a2340
- Night: #0b0e2a #1a1f4a #2e3570 | land #252a52 #171a38 #0b0d20, moon #f2f0d8
- Overcast/fog: #8a96a6 #a8b2be #c8ced6 | land #7a8494 #5a6474 #3a4252

## Example: dusk landscape with parallax ridges
${DUSK_SCENE.code}
`.trim(),
};
