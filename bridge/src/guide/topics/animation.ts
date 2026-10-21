import { BREATHING_IDLE, SLIME_IDLE } from "../examples.js";
import type { GuideTopic } from "../GuideTopic.js";

export const animation: GuideTopic = {
  id: "animation",
  title: "Animation",
  summary: "Frame counts and timings for idle/walk/run/jump/attack/hurt/death, key poses, and draw_script frames.",
  body: `
# Animation

## Frame counts and timings (per frame)
| action | frames | ms/frame | key poses |
|---|---|---|---|
| idle | 2-4 | 150-250 | rest, breathe in (body/head 1px down), hold; hair/cape follow 1 frame later |
| walk | 4 (or 6-8) | 100-150 (8f: 80-120) | contact, down (lowest), passing, up (highest), then mirrored legs |
| run | 6-8 | 70-100 | lean forward 1-2 px, airborne frame (both feet off), 1-2 px bob, arms opposite legs |
| jump | 5-7 | 60-120, apex 150 | anticipation crouch (squash) -> takeoff (stretch) -> rise -> apex hold -> fall -> land (squash) -> recover |
| attack | 5-8 | wind-up 100-150, strike 40-70, recovery 100 | anticipation (pull back) -> smear/strike -> impact hold -> follow-through -> recovery |
| hurt | 2-3 | 60-100 | flash (1 frame of white/red silhouette), knock back 1-2 px, recover |
| death | 4-8 | 100-150, last held | stagger -> fall -> hit ground (squash) -> lie still / dissolve |
| cast/charge | 4-6 loop | 80-120 | glow pulses using a ramp, particles orbit |
| fx (fire, sparkle) | 3-6 loop | 60-100 | shapes rise and shrink; colors step down the ramp each frame |

## Principles that matter at low resolution
- Squash and stretch keep volume: 2 px wider means about 2 px shorter.
- Anticipation before every big motion (crouch before a jump, pull back before a swing).
- Timing beats frame count: hold key poses longer (frameMs per frame via manage_frames)
  instead of adding in-betweens. Fast actions: fewer frames, shorter durations.
- Follow-through and overlap: hair, capes, tails, ears settle 1 frame after the body.
- Arcs: limbs and weapons travel on arcs; a 1-frame smear (stretched streak in the weapon's
  light color) sells fast swings.
- Keep the ground contact fixed: feet do not slide during idle; the lowest row stays planted.
- Move less: a 1px bob reads clearly at 32x32. Sub-pixel motion: shift a highlight or swap
  a few shading pixels instead of moving the whole outline.
- Loops: the last frame must flow into the first (t = i/n never reaches 1, so
  Math.sin(2 * Math.PI * t) loops seamlessly).

## Walk cycle in 4 frames (side view, 32px figure)
1. contact: legs apart (front heel down, back toe), arms opposite, body at normal height.
2. passing: legs together under the body, body 1px UP.
3. contact mirrored: other leg forward.
4. passing mirrored, body 1px up.
For 8 frames insert "down" (body 1px down, front knee bent) after each contact and "up"
(back leg pushing off) after each passing.

## Animating with draw_script
- One call draws the whole animation in one undo step: frameCount (+ startFrame) or frames,
  frameMs for durations; missing frames are created. The script runs once per frame with
  F (frame number), i (0-based index), n (count), t = i/n.
- Put per-frame values in a table indexed by i: const bob = [0, 0, 1, 1][i];
- New art: base "empty" (default) and draw every frame from scratch with pose parameters.
- Animate a finished sprite: base: 1 starts every frame from frame 1's pixels; then move()
  or copy() parts (head, arm) by a pixel or two, recolor with replace(), add effects.
- rand() restarts every frame (random scenery stays still); use noise(x, y + F) or the
  frame index for things that should change.
- After drawing: manage_tags to name the loop ("idle", "walk"), then check the filmstrip
  in the result. export_sprite with kind "gif" or "sheet" when asked.

## Example: slime idle, 4 frames (squash and stretch)
${SLIME_IDLE.code}

## Example: breathing idle on existing art
${BREATHING_IDLE.code}
`.trim(),
};
