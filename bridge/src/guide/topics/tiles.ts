import { BRICK_TILE } from "../examples.js";
import type { GuideTopic } from "../GuideTopic.js";

export const tiles: GuideTopic = {
  id: "tiles",
  title: "Tiles and tilesets",
  summary: "Seamless 16x16/32x32 tiles, texture recipes (grass, dirt, stone, water), variation, autotile edges.",
  body: `
# Tiles and tilesets

## Sizes
- 16x16: classic (NES/SNES/GBA feel), fast to make. 32x32: modern detail. 8x8 sub-tiles
  for autotile corners. Match the character scale: a 32px character walks on 16 or 32px tiles.

## Seamless rule
Anything that crosses an edge must continue on the opposite edge. In a script, draw such
features twice (at x and x - W or x + W), or wrap coordinates: set((x % W + W) % W, ...).
Check seams by tiling 2x2: draw the tile into a 2x canvas and copy(0, 0, 16, 16, 16, 0);
copy(0, 0, 32, 16, 0, 16); or view the tile repeated in a test sprite.

## What makes tiles look good
- Low contrast for ground and walls (they sit behind characters); the highest contrast
  belongs to characters and interactive objects.
- Same light direction as the characters (top-left): highlights on top/left edges of
  stones and bricks, shadows bottom/right.
- No feature exactly centered or on a straight grid; avoid lines parallel to the tile edge
  that make the grid visible. Spread detail evenly so no spot repeats noticeably.
- 2-4 variants of busy tiles (grass, dirt): same base, details moved (use another seed).
  Keep variants' edges identical so they mix freely.
- 3-4 colors per terrain ramp; reuse the ramps across tiles of the same set.

## Texture recipes (16x16, ramp = ramp(base, 4))
- Grass: fill base; 6-10 tufts as 1x2 or 2x3 "V" clusters in the light tone with a dark
  pixel under each; 2-3 tiny flowers optional. Positions from rand(), wrapped.
- Dirt: base fill; noise(x, y, 4) > 0.65 -> darker clusters; 2-3 pebbles (2x2 light tone with
  a dark pixel bottom-right).
- Stone bricks: mortar fill, bricks in running bond (rows offset by half a brick), each
  brick lit top edge and shaded bottom/right edge (see example). Chips: 1-2 dark pixels.
- Cobblestone: irregular rounded rects (rect with r=1..2) of varied size, gaps dark.
- Wood planks: vertical or horizontal boards 4-5 px wide, 1px dark gaps, grain = short
  darker lines along the board, knots as 2x2 dark rings.
- Water: base mid-blue; 2-3 horizontal wave dashes (2-4 px) in the light tone; animate by
  shifting the dashes 1px per frame (frameCount 3-4, frameMs 150-200, wrapped).
- Lava/fire: same as water with an orange-yellow ramp, faster (100 ms).

## Edges and autotiles
- Top-down terrain transition (grass over dirt): the upper material overhangs with an
  irregular edge plus a 1px dark lip/shadow on the lower material. Edge endpoints sit at
  fixed positions (tile midpoints or corners) so neighbours connect.
- Minimal set: 9-slice (top-left, top, top-right, left, center, right, bottom-left,
  bottom, bottom-right) + 4 inner corners = 13 tiles. Full blob set = 47 tiles. Draw the set
  on one canvas in a grid (e.g. 3x3 tiles of 16 = 48x48) so edges can be checked together.
- Side-view platform: top 3-4 px of grass/surface with a lighter top row and a few pixels
  hanging over the edge, then the earth body with a darker band under the surface.

## Workflow
1. create_sprite (tile size, or a sheet of tiles), set the palette.
2. draw_script per tile: base fill -> large features (bricks/boards) -> texture -> wrap check.
3. view_sprite the tiled check; fix seams.
4. Variants: rerun the same script with another seed into the next tile slot (x offset).

## Example: seamless 16x16 brick tile
${BRICK_TILE.code}
`.trim(),
};
