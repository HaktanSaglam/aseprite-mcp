import { CYLINDER } from "../examples.js";
import type { GuideTopic } from "../GuideTopic.js";

export const shadingLight: GuideTopic = {
  id: "shading_light",
  title: "Shading and light",
  summary: "Light direction, hue-shifted ramps, form shading, avoiding pillow shading and banding, AO, cast shadows.",
  body: `
# Shading and light

## Set up the light
- One key light per image; default top-left (in front of the viewer, slightly above).
  Write it down in the script as a comment and shade every object for it.
- Optional rim/back light in a contrasting hue (cool blue at night, warm orange near fire)
  as a 1px line on the far edge.

## The parts of a lit form (light -> dark)
1. Highlight (specular): 1-3 px, lightest tone, only on shiny/hard materials, where the
   surface faces the light most directly.
2. Light side: the planes facing the light.
3. Midtone: the base color.
4. Core shadow: the darkest band of the form itself, just past where it turns from the light.
5. Reflected light: a 1px slightly lighter band at the shadow-side edge (bounce from the
   ground), still darker than the midtone. sphere() adds it automatically with 4+ colors.
6. Cast shadow and contact shadow: the darkest values, where objects touch or block light.

## Ramps with hue shift
- Each material = one ramp of 3-5 tones from ramp(base, n): darker steps rotate toward
  blue-violet and gain a little saturation; lighter steps rotate toward yellow and lose
  saturation. This is what makes pixel art look rich instead of muddy.
- Never shade with black or gray, never highlight with pure white (except tiny speculars).
- Skin: warm red-orange shadows. Foliage: shadows toward teal/blue, lights toward yellow-green.
  Metal: cool, high-contrast, sharp transitions. Cloth: low contrast, soft.
- shade(c, -0.4) / shade(c, 0.4) gives one hue-shifted step for one-off colors.

## Shading by planes, not by outline
- Pillow shading = dark ring along the whole outline with a light center. It looks flat and
  amateur. Instead decide which planes face the light (top and left), which turn away
  (bottom and right) and shade those, regardless of where the outline is.
- Banding = strips of equal width running parallel to the outline or each other. Break it:
  vary band widths, end bands at different points, merge into bigger clusters.
- Clusters: each tone area should be at least 2x2 where possible. Single isolated pixels
  only for highlights, eyes and sparkles.

## Shapes
- Sphere/ball/head: sphere(cx, cy, r, ramp(base, 5), "tl") or [rx, ry] for ellipsoids.
- Cylinder (arm, trunk, bottle): bands along the axis: light | base | core shadow |
  reflected light (example below). Shiny cylinders add a 1px R[3] line inside the light band.
- Box/cube: three faces: top lightest, left (lit side) mid, right darkest; edge highlight
  1px on the corner nearest the light.
- Cloth folds: a fold is a small cylinder: light top edge, dark crease below.

## Ambient occlusion and contact shadows
- Darken 1px where forms meet: under the chin, under the hair fringe, armpits, between
  legs, where the body meets the ground, inside corners of objects.
- Cast shadows on the ground: a flat ellipse in a darker ground tone (not semi-transparent
  black), offset away from the light, 1-3 px tall for characters.

## Dithering in shading
- Only for big, smooth surfaces at 48px+ or retro styles. Use 50% checker between two
  adjacent ramp tones for 1-2 px; never dither small sprites or faces.

## Checklist
- Same light direction on every object? Shadows on the far side, highlights on the near side?
- Darkest values only in contact/core shadows? Highlights small and few?
- Each tone readable as a cluster at 1x? No pillow shading, no banding?

## Example: cylinder shading
${CYLINDER.code}
`.trim(),
};
