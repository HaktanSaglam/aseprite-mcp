import { POTION_16, SWORD_16 } from "../examples.js";
import type { GuideTopic } from "../GuideTopic.js";

export const itemsIcons: GuideTopic = {
  id: "items_icons",
  title: "Items and icons",
  summary: "16x16/32x32 icon recipe: silhouette, 3-4 tone ramps, rim light, outline, material cheat-sheet, examples.",
  body: `
# Items and icons

## Recipe (16x16 or 32x32)
1. Silhouette: fill the canvas well but keep a 1px margin on every side for the outline.
   Long items (swords, staffs, wands, arrows) go on the 45-degree diagonal, bottom-left to
   top-right: it is the cleanest line and the longest one that fits.
2. Base colors: one flat fill per material.
3. Shading with 3-4 tone ramps per material (ramp(base, 4)): light from the top-left, so
   top/left edges get the light tone, bottom/right edges the shadow tone.
4. Highlights: 1-3 px of the lightest tone (or near-white) on shiny materials only, placed
   where the surface faces the light. Rim/reflected light: 1px of a mid tone on the shadow
   edge separates the object from its outline.
5. Outline: outline(null) (dark, hue-shifted per edge) or one dark color. At 32x32 try a
   selective outline: lighter on the lit side (see outlines_aa).
6. Readability check at 1x: can you name the item from the silhouette alone? Is the key
   feature (blade shine, gem, potion color) the most contrasted spot?

## Sizes
- 16x16: 3 tones per material, 1-2 highlight pixels, full dark outline, no anti-aliasing.
  Every pixel counts: prefer stamp() / write_pixels for hand placement once blocked.
- 32x32: 4-5 tones, sel-out outline, small details (rivets, stitching, facets, engraving).
- Icon sets: same canvas, same light, same outline style, same palette, similar visual weight.
  Center mass optically (a bit above geometric center).

## Material cheat-sheet
- Steel/iron: cool gray-blue ramp, high contrast; sharp white highlight line along an edge;
  dark band reflection in the middle of flat blades.
- Gold/brass: ramp("#e8b04a", 4) -> brown shadows, yellow mids, pale-yellow/white highlight;
  never plain yellow + black.
- Wood: brown ramp; grain = 1px darker lines along the length; end grain shows rings.
- Leather/cloth: low contrast, soft shading, stitch dots in the light tone.
- Gems/crystal: faceted: top-left facet lightest, bottom-right darkest, 1-2 white sparkle
  pixels (plus a 1px cross-sparkle for magic); a saturated mid tone inside.
- Glass: pale tinted fill, the background or liquid shows through, 2-3 white glints, light
  outline on the lit side.
- Organic (fruit, meat, mushrooms): sphere()/ellipse shading + a contrasting detail (leaf, stalk, spots).
- Magic/glow: a light core (near white) -> saturated mid -> darker outer ring, plus 2-4
  sparkle pixels outside the silhouette.

## Common fixes
- Muddy icon: too many similar colors -> fewer, more separated tones.
- Flat icon: no value range -> add a real shadow side and a tiny highlight.
- Noisy icon: single scattered pixels -> merge into clusters.
- Black outlines making it heavy -> outline(null) or a dark hue-shifted color.

## Example: 16x16 potion
${POTION_16.code}

## Example: 16x16 sword
${SWORD_16.code}
`.trim(),
};
