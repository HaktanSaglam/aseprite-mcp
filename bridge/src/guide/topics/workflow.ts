import type { GuideTopic } from "../GuideTopic.js";

export const workflow: GuideTopic = {
  id: "workflow",
  title: "Workflow with these tools",
  summary: "The fastest high-quality path through this toolset: which tool when, script structure, speed rules.",
  body: `
# Workflow with this toolset

## The pipeline
1. Understand: get_sprite_info (size, frames, layers, selection). New piece: create_sprite
   at the right size (fundamentals topic). Editing: get_palette and view_sprite first.
2. Palette: decide ramps once. A preset (set_palette preset / get_palette_preset) or
   ramp() per material. Write them as constants at the top of the script.
3. Block in: draw_script with flat base colors, big shapes back to front, on a named layer
   (manage_layers to add/arrange; draw_script and write_pixels create missing layers).
   Symmetric fronts: draw the left half, mirror("x").
4. Shade: same script or a second one with base "current": replace(from, to, rect) per
   plane, sphere() for round forms, contact shadows, highlights.
5. Details: eyes, buckles, sparkles, text with set()/stamp() in the script, or write_pixels
   for a small hand-made grid.
6. Look: the draw_script preview (or view_sprite). Judge silhouette, values, light
   direction, clusters. Fix the single biggest problem, then look again.
7. Clean up: outline(null) in the script or add_outline; cleanup_pixels removes orphans;
   analyze_sprite reports colors and problems; reduce_colors / apply_palette to enforce a limit.
8. Animate (if asked): draw_script with frameCount/frames + frameMs, manage_tags to name the
   loop, check the filmstrip. Export with export_sprite when the user wants files.

## Which tool when
- draw_script: anything with structure or more than a few dozen pixels: silhouettes,
  shading passes, scenes, tiles, gradients, all frames of an animation. Fastest by far.
- write_pixels: small exact grids (icons up to ~24x24, faces, touch-ups). Same format as
  read_pixels; '.' is transparent.
- read_pixels: only for small regions you must match exactly; view_sprite for the overall look.
- Effects (instant, no drawing code): add_outline, remove_background, cleanup_pixels,
  drop_shadow, transform_layer (flip/rotate/shift), replace_color, adjust_colors.
- Structure: manage_layers, manage_frames, manage_tags; get_selection / set_selection and
  selectionOnly to limit edits to the user's selection.
- undo / redo instead of manually erasing a bad pass.

## Structure of a good draw_script
  // 1. palette: ramps per material
  const skin = ramp("#f2b38a", 4), cloth = ramp("#3d7bd0", 4);
  // 2. layout constants (plan coordinates once, derive the rest)
  const cx = 16, ground = 29;
  // 3. shapes back to front, flat colors
  // 4. shading passes (planes, contact shadows, highlights)
  // 5. details, then outline(null)
  console.log(...) anything you want to verify (positions, colors); it comes back in the result.

## Speed rules
- Few big calls: one script per stage (block, shade, details), not one call per shape.
- Plan coordinates in comments before drawing; derive positions from constants.
- preview: false for intermediate passes you do not need to see; look once at the end of a stage.
- Do not read back what you just wrote: the preview already shows it.
- Fix errors from the message: it names the line and the helper; rerun only the fixed script.
- Use layers to keep big pieces separable (background, character, effects) instead of redrawing.

## Quality gate before you say "done"
1. Silhouette readable at 1x? 2. One light direction? 3. Hue-shifted ramps, no gray/black
   shading? 4. No orphan pixels, no doubled outline corners? 5. Palette small? 6. Matches the
   requested size/style/palette and the user's existing art?
`.trim(),
};
