import type { GuideTopic } from "../GuideTopic.js";

export const fundamentals: GuideTopic = {
  id: "fundamentals",
  title: "Pixel art fundamentals",
  summary: "Core rules every piece needs: canvas size, silhouette, value, clusters, lines, detail budget.",
  body: `
# Pixel art fundamentals

Pixel art is deliberate: every pixel is a decision. Good pieces come from a few rules
applied every time, in this order: silhouette -> values -> color -> details -> cleanup.

## 1. Pick the canvas for the job
- Icons/items: 16x16 (classic) or 32x32 (detailed). Keep a 1px margin for the outline.
- Characters: 16x16 (tiny), 24x24, 32x32 (default), 48x48, 64x64 (detailed). The figure
  is usually canvas height - 2..4 px (room for outline and feet).
- Tiles: 16x16 or 32x32. Scenes: 160x90, 256x144, 320x180 (16:9 that scale cleanly to 1080p).
- Smaller is easier to make look good. Do not draw 128x128 when 32x32 was asked for.

## 2. Silhouette first
- Block the whole shape in ONE flat color before any shading. If it is not recognisable
  as a flat blob at 1x zoom, no amount of shading will save it.
- Exaggerate the identifying feature: big sword, big hat, long ears, oversized head.
- Prefer clear negative space (gap between arm and body, between legs).

## 3. Value (light/dark) beats hue
- Readability comes from value contrast. Character vs background: at least ~30% luminance
  difference. Adjacent ramp tones: 10-20% apart.
- Pick ONE light direction (default: top-left) and keep it for every object in the image.
- Darkest values go where forms turn away from the light and where objects touch (contact
  shadows); lightest values are small and rare (highlights).

## 4. Limited palette
- A sprite rarely needs more than 8-16 colors; 3-5 tones per material.
- Build each material as a ramp with ramp(base, n): shadows shift toward blue-violet and
  highlights toward yellow, which reads richer than adding black or white.
- Reuse colors across materials (the hair's dark tone can be the boots' mid tone).

## 5. Clusters, not pixels
- Shade in clusters of 2+ pixels. Lone single pixels ("orphans") read as noise, except
  intentional highlights, eyes and sparkles.
- Avoid pillow shading (dark rim all around, light center): shade by planes facing or
  turning from the light.
- Avoid banding: parallel color strips of equal width hugging the outline. Vary band widths
  and let clusters merge.

## 6. Clean lines
- Pixel-perfect: no L-shaped corners on 1px lines (a staircase step is 1 pixel, never 2
  meeting at a right angle). line() and curve() already do this.
- Consistent slopes: 1:1 (45 degrees), 1:2, 2:1, 1:3. Curves change segment length
  gradually (3-2-1-1-2-3), never jump (3-1-3).
- Use outlines: 1px, darker hue-shifted version of the fill, not pure black (see outlines_aa).

## 7. Detail budget
- Big shapes > medium shapes > small details. One focal point (usually the face or the
  weapon) gets the most contrast and detail.
- At 16x16 a face is 2 eyes; at 32x32 eyes + mouth; at 64x64 nose, brows, hair strands.
- Leave flat areas flat; texture everywhere = noise.

## 8. Dithering and anti-aliasing
- Dithering: only for large gradients (skies, big backgrounds) or deliberate retro styles.
  gradient(..., "checker") gives a clean 2px transition; avoid dithering small sprites.
- Anti-aliasing: manual and sparse, inside the shape, never against transparency. Skip it
  at 16x16 and in 1bit/gameboy/NES styles.

## Quick self-check before finishing
1. Silhouette readable at 1x? 2. One light direction everywhere? 3. Enough value contrast
between neighbouring materials? 4. No orphan pixels or doubled outline corners?
5. Palette small and harmonious? Fix the biggest problem first, then re-check with view_sprite.
`.trim(),
};
