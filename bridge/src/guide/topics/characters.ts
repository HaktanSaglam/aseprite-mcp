import { HERO_32 } from "../examples.js";
import type { GuideTopic } from "../GuideTopic.js";

export const characters: GuideTopic = {
  id: "characters",
  title: "Characters",
  summary: "Proportions per size (16-64px), readable faces, front/side/3-4 views, directions, a 32x32 example.",
  body: `
# Characters

## Proportions by canvas (figure height ~ canvas - 2..4 px)
| canvas | heads tall | head (w x h) | eyes | notes |
|---|---|---|---|---|
| 16x16 | 2 | 8x7 | 1x1 or 1x2, 2-3 px apart | body 5-6 px, legs 2 px; 3-4 colors + outline; no mouth |
| 24x24 | 2-2.5 | 10x9 | 1x2 | hands = 2px blobs; mouth optional 1px |
| 32x32 | 2.5-3 | 12-14 x 11 | 2x2 with 1px catch-light | mouth 1-2 px; belt/collar details |
| 48x48 | 3-3.5 | 14x14 | 2x3 (pupil + white + catch-light) | hair clusters, cloth folds, fingers hinted |
| 64x64 | 4-5 (chibi 3) | 16x16 | 3x3+, brows | nose shadow, 5-6 tone ramps, sel-out outlines |
Chibi/cute = big head, eyes low on the face (lower half), short limbs. Heroic = smaller head,
longer legs (legs ~ half the height). Keep both feet on the same ground row.

## Faces that read
- Eyes carry the face: put them on the head's horizontal midline or a bit lower; gap
  between eyes = 1-2 eye widths. Catch-lights (1px white) on the SAME side of both eyes,
  toward the light.
- Skin shadows are warm (red-orange), never gray: ramp("#f2b38a", 4) does this.
- Mouth: 1-2 px of the skin shadow color, not black. Nose: one shadow pixel at >= 32px.
- Hair is a big shape first (helmet-like mass over the skull, 1-2 px above it), then 2-3
  clusters of highlight following the strand direction. Fringe casts a 1px shadow on the forehead.

## Views
- Front: symmetric. Draw the left half, mirror("x"), THEN shade with one light direction
  and add asymmetric details (catch-lights, buckle, weapon). Shading before mirroring makes
  it look lit from the front.
- Side (profile): one eye at the front third of the head; nose as a 1px bump in the
  silhouette; far arm/leg one ramp step darker than the near ones; body slightly narrower.
- Three-quarter: the face shifts toward the facing direction: near eye full size, far eye
  1px narrower and closer to the silhouette edge, nose on or near the far cheek's outline,
  near shoulder wider.
- Top-down RPG (3/4 top-down): head big, body short, feet barely visible; the top of the
  head shows more hair.

## Directions and sets
- 4 directions: down (front), up (back), left (side), right = left mirrored (flip_h via
  transform_layer, or copy(...,"x") in a script). Back view: hair covers the head, no face.
- 8 directions add the four 3/4 diagonals. Keep the same pixel height, ground line and palette
  across all directions; draw them side by side on one canvas or in separate frames.

## Color and contrast
- 3-4 tones per material, 4-6 materials max (skin, hair, top, bottom, boots, accent).
- Neighbouring materials need value contrast (dark hair vs light skin, light shirt vs dark
  pants). Give the accent color (scarf, gem, weapon) the highest saturation.
- Outline with a dark hue-shifted color; interior separation lines use the darker tone of
  the material, not the outline color.

## Recipe
1. Canvas + layer: create_sprite 32x32, draw on a layer named after the character.
2. draw_script: flat silhouette blocks (head, torso, arms, legs) in base colors, mirrored.
3. Same or next script: shading with replace(from, to, x, y, w, h) per side, contact shadows
   (under the chin, between legs, under arms), highlights on hair/shoulders.
4. Face and small details with stamp() or write_pixels.
5. outline(null) or add_outline; view_sprite; fix the worst issue; cleanup_pixels.

## Example: 32x32 hero (front view)
${HERO_32.code}
`.trim(),
};
