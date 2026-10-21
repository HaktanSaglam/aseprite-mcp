/**
 * Worked draw_script examples quoted by the guide topics. Each one was tuned by rendering
 * it, and test/guide.test.ts runs them all, so the model never copies a broken script.
 */

export interface GuideExample {
  /** draw_script region size the code expects. */
  width: number;
  height: number;
  /** Frames to run (animation examples); 1 for stills. */
  frames: number;
  code: string;
}

const example = (width: number, height: number, frames: number, code: string): GuideExample => ({
  width,
  height,
  frames,
  code: code.trim(),
});

export const POTION_16 = example(
  16,
  16,
  1,
  `
// 16x16 potion: silhouette -> ramps -> liquid -> glints -> outline
const glass = ramp("#8fc8d8", 4), red = ramp("#d43a4f", 5), cork = ramp("#9c6a3c", 3);
circle(7.5, 9.5, 5, glass[1]);               // flask body: x 3-12, y 5-14
rect(6, 3, 4, 2, glass[1]);                  // neck
sphere(7.5, 9.5, 4, red.slice(1), "tl");     // liquid shaded like a ball (4 tones)
for (let y = 5; y <= 7; y++)                 // empty glass above the waterline
  for (let x = 3; x <= 12; x++) if (get(x, y)) set(x, y, glass[1]);
line(4, 8, 11, 8, red[4]);                   // bright liquid surface
rect(5, 1, 6, 2, cork[1]); line(5, 1, 10, 1, cork[2]);   // cork with a lit top
set(4, 10, glass[3]); set(4, 11, glass[3]); set(5, 6, glass[3]); // glass glints
outline(null);                               // hue-shifted dark outline
`,
);

export const SWORD_16 = example(
  16,
  16,
  1,
  `
// 16x16 sword on the 45-degree diagonal (the cleanest pixel line), 1px margin for the outline
const steel = ramp("#a8b8c8", 4), gold = ramp("#e8b04a", 3), grip = ramp("#7a4a2c", 3);
line(6, 9, 13, 2, steel[1]);                 // blade body
line(5, 9, 12, 2, steel[3]);                 // lit edge faces the top-left light
set(13, 1, steel[3]);                        // tip
line(3, 8, 7, 12, gold[1]);                  // crossguard, perpendicular to the blade
set(3, 8, gold[2]); set(4, 9, gold[2]); set(7, 12, gold[0]);
line(2, 13, 4, 11, grip[1]); set(3, 12, grip[2]);   // grip
set(1, 14, gold[2]);                         // pommel
outline(null);
`,
);

export const HERO_32 = example(
  32,
  32,
  1,
  `
// 32x32 hero, front view, ~2.5 heads tall. Light from the top-left.
const skin = ramp("#f2b38a", 4), hair = ramp("#8c4a2f", 4), coat = ramp("#3d7bd0", 4),
      leather = ramp("#7a4e2d", 3), pants = ramp("#4b4266", 3), ink = "#1a1c2c";
// 1. Flat blocks for the LEFT half only (x <= 15); mirror() builds the right half.
rect(9, 5, 7, 11, skin[1]);                  // face x9-15 y5-15
rect(8, 2, 8, 6, hair[1], 2);                // hair cap y2-7
rect(8, 7, 2, 6, hair[1]);                   // side lock
rect(10, 16, 6, 8, coat[1]);                 // torso y16-23
rect(7, 17, 3, 6, coat[1], 1);               // sleeve
rect(7, 23, 3, 2, skin[1]);                  // hand
rect(10, 21, 6, 1, leather[1]);              // belt
rect(11, 24, 4, 4, pants[1]);                // leg y24-27
rect(10, 28, 5, 2, leather[0]);              // boot y28-29
rect(12, 10, 2, 2, ink);                     // eye 2x2
mirror("x");
// 2. Shade AFTER mirroring, following the form (mirrored shading = lit from the front).
replace(skin[1], skin[0], 10, 8, 12, 1);     // fringe casts a shadow on the forehead
replace(skin[1], skin[0], 20, 8, 3, 8);      // right side of the face
replace(hair[1], hair[2], 9, 3, 6, 2);       // hair highlight band
replace(hair[1], hair[0], 20, 2, 5, 11);     // hair turning away from the light
replace(coat[1], coat[0], 19, 16, 6, 8);     // right side of torso + sleeve
replace(coat[1], coat[2], 10, 17, 3, 4);     // lit chest
replace(pants[1], pants[0], 17, 24, 4, 4);
line(10, 16, 21, 16, coat[0]);               // shadow under the chin
// 3. Asymmetric details last.
set(12, 10, "#ffffff"); set(18, 10, "#ffffff");  // catch-lights on the same side
set(15, 14, skin[0]); set(16, 14, skin[0]);  // mouth
set(20, 21, leather[2]);                     // buckle glint
outline(null);                               // darker hue-shifted outline
`,
);

export const SLIME_IDLE = example(
  24,
  24,
  4,
  `
// 4-frame slime idle (24x24): draw_script({frameCount: 4, frameMs: 150, code})
// Poses: rest, squash (wider + lower), rest, stretch (narrower + taller). The base never moves.
const body = ramp("#5ac85a", 5), ink = "#1a1c2c", ground = 20;
const [dw, dh] = [[0, 0], [2, -2], [0, 0], [-1, 1]][i];    // pose for this frame
const rx = 8 + dw, ry = 7 + dh;
sphere(11.5, ground - ry + 3, [rx, ry], body.slice(1), "tl");
rect(0, ground + 1, W, H, "transparent");                  // flat bottom on the ground line
const eyeY = ground - 2 * ry + 7;                          // eyes ride the squash
rect(8, eyeY, 2, 3, ink); rect(14, eyeY, 2, 3, ink);
set(8, eyeY, "#ffffff"); set(14, eyeY, "#ffffff");         // catch-lights
outline(body[0]);
`,
);

export const BRICK_TILE = example(
  16,
  16,
  1,
  `
// 16x16 seamless brick tile: 7x3 bricks, running bond. Mortar sits only on each brick's
// top/left and bricks crossing the edge are drawn twice (x and x-16 / x+16), so tiles join.
const B = ramp("#a85d48", 4), mortar = "#3d2b35";
rect(0, 0, W, H, mortar);
function brick(x, y) {
  for (const bx of [x, x - W, x + W]) {
    rect(bx, y, 7, 3, B[1]);
    line(bx, y, bx + 6, y, B[2]);                // lit top edge
    line(bx + 1, y + 2, bx + 6, y + 2, B[0]);    // shaded bottom edge
    set(bx + 6, y + 1, B[0]);                    // shaded right end
  }
}
for (let row = 0; row < 4; row++) {
  const off = row % 2 ? 4 : 0;                   // half-brick offset on odd rows
  brick(1 + off, 1 + row * 4); brick(9 + off, 1 + row * 4);
}
for (let k = 0; k < 5; k++) {                     // a few chips break the repetition
  const x = rand(W), y = rand(H);
  if (get(x, y) === B[1]) { set(x, y, B[0]); if (get(x + 1, y) === B[1]) set(x + 1, y, B[0]); }
}
`,
);

export const DUSK_SCENE = example(
  96,
  54,
  1,
  `
// 96x54 dusk landscape: sky bands -> sun -> 3 parallax ridges (far = paler, closer to the sky)
gradient(0, 0, W, 40, ["#2b2a5c", "#4a3f7d", "#8a5a9c", "#e0868a", "#f6c28b"], "v", "checker");
circle(68, 31, 7, "#ffe8a8");                              // sun, half behind the far ridge
const ridges = [                                           // far -> near: lower, darker, bumpier
  { base: 40, amp: 14, scale: 18, color: "#9a6a98" },
  { base: 47, amp: 11, scale: 11, color: "#5c4378" },
  { base: 53, amp: 7, scale: 6, color: "#2a2340" },
];
ridges.forEach((r, k) => {
  for (let x = 0; x < W; x++) {
    const top = Math.round(r.base - noise(x + k * 97, 0, r.scale, 3) * r.amp);
    rect(x, top, 1, H - top, r.color);
  }
});
for (let s = 0; s < 14; s++) set(rand(W), rand(16), rand(3) ? "#c9b8e8" : "#ffffff"); // stars
`,
);

/** Animating finished art: every frame starts from frame 1 (base: 1), so only motion is coded. */
export const BREATHING_IDLE = example(
  32,
  32,
  4,
  `
// draw_script({frameCount: 4, base: 1, frameMs: 200, code}) on an existing 32x32 character
const bob = [0, 0, 1, 1][i];                 // frames 3-4: upper body 1px lower (exhale)
if (bob) move(0, 0, W, 20, 0, bob);          // rows 0-19 move down, legs (rows 20+) stay planted
`,
);

export const SELOUT_PASS = example(
  24,
  24,
  1,
  `
sphere(11.5, 11.5, 9, ramp("#4f9a4a", 5).slice(1), "tl");   // any finished shape
// selective outline (sel-out): dark outline, then the lit (top/left) side takes a shade of its fill
const OL = "#1a1c2c";
outline(OL);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  if (get(x, y) !== OL) continue;
  const fill = [get(x + 1, y), get(x, y + 1)].find((c) => c && c !== OL);  // fill right/below = lit side
  if (fill) set(x, y, shade(fill, -0.8));
}
`,
);

export const CYLINDER = example(
  16,
  24,
  1,
  `
// vertical cylinder (trunk, arm, bottle) lit from the left: light | base | core shadow | reflected
const R = ramp("#8a5432", 4), x0 = 4, y0 = 2, w = 8, h = 20;   // R = [shadow, base, light, highlight]
for (let x = 0; x < w; x++) {
  const u = (x + 0.5) / w;
  const c = u < 0.3 ? R[2] : u < 0.65 ? R[1] : u < 0.9 ? R[0] : mix(R[0], R[1], 0.5);
  rect(x0 + x, y0, 1, h, c);
}
`,
);

export const GUIDE_EXAMPLES = {
  POTION_16,
  SWORD_16,
  HERO_32,
  SLIME_IDLE,
  BRICK_TILE,
  DUSK_SCENE,
  BREATHING_IDLE,
  SELOUT_PASS,
  CYLINDER,
};
