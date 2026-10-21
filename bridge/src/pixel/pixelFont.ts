/**
 * A tiny 3x5 pixel font (variable width for punctuation) for labels, UI mockups and
 * signs. Hand-placed glyphs read better at this size than any downscaled vector font.
 * '#' = ink, '.' = empty.
 */

export const GLYPH_HEIGHT = 5;
export const LETTER_SPACING = 1;
export const LINE_HEIGHT = GLYPH_HEIGHT + 1;
const SPACE_WIDTH = 2;

const GLYPHS: Record<string, string[]> = {
  A: [".#.", "#.#", "###", "#.#", "#.#"],
  B: ["##.", "#.#", "##.", "#.#", "##."],
  C: [".##", "#..", "#..", "#..", ".##"],
  D: ["##.", "#.#", "#.#", "#.#", "##."],
  E: ["###", "#..", "##.", "#..", "###"],
  F: ["###", "#..", "##.", "#..", "#.."],
  G: [".##", "#..", "#.#", "#.#", ".##"],
  H: ["#.#", "#.#", "###", "#.#", "#.#"],
  I: ["###", ".#.", ".#.", ".#.", "###"],
  J: ["..#", "..#", "..#", "#.#", ".#."],
  K: ["#.#", "#.#", "##.", "#.#", "#.#"],
  L: ["#..", "#..", "#..", "#..", "###"],
  M: ["#.#", "###", "###", "#.#", "#.#"],
  N: ["##.", "#.#", "#.#", "#.#", "#.#"],
  O: [".#.", "#.#", "#.#", "#.#", ".#."],
  P: ["##.", "#.#", "##.", "#..", "#.."],
  Q: [".#.", "#.#", "#.#", "##.", ".##"],
  R: ["##.", "#.#", "##.", "#.#", "#.#"],
  S: [".##", "#..", ".#.", "..#", "##."],
  T: ["###", ".#.", ".#.", ".#.", ".#."],
  U: ["#.#", "#.#", "#.#", "#.#", "###"],
  V: ["#.#", "#.#", "#.#", "#.#", ".#."],
  W: ["#.#", "#.#", "###", "###", "#.#"],
  X: ["#.#", "#.#", ".#.", "#.#", "#.#"],
  Y: ["#.#", "#.#", ".#.", ".#.", ".#."],
  Z: ["###", "..#", ".#.", "#..", "###"],
  "0": ["###", "#.#", "#.#", "#.#", "###"],
  "1": [".#.", "##.", ".#.", ".#.", "###"],
  "2": ["##.", "..#", ".#.", "#..", "###"],
  "3": ["##.", "..#", ".#.", "..#", "##."],
  "4": ["#.#", "#.#", "###", "..#", "..#"],
  "5": ["###", "#..", "##.", "..#", "##."],
  "6": [".##", "#..", "###", "#.#", "###"],
  "7": ["###", "..#", ".#.", ".#.", ".#."],
  "8": ["###", "#.#", "###", "#.#", "###"],
  "9": ["###", "#.#", "###", "..#", "##."],
  ".": [".", ".", ".", ".", "#"],
  ",": [".", ".", ".", "#", "#"],
  "!": ["#", "#", "#", ".", "#"],
  "?": ["##.", "..#", ".#.", "...", ".#."],
  ":": [".", "#", ".", "#", "."],
  ";": [".", "#", ".", "#", "#"],
  "'": ["#", "#", ".", ".", "."],
  '"': ["#.#", "#.#", "...", "...", "..."],
  "-": ["...", "...", "###", "...", "..."],
  "+": ["...", ".#.", "###", ".#.", "..."],
  "=": ["...", "###", "...", "###", "..."],
  "/": ["..#", "..#", ".#.", "#..", "#.."],
  "%": ["#.#", "..#", ".#.", "#..", "#.#"],
  "(": [".#", "#.", "#.", "#.", ".#"],
  ")": ["#.", ".#", ".#", ".#", "#."],
  "<": ["..#", ".#.", "#..", ".#.", "..#"],
  ">": ["#..", ".#.", "..#", ".#.", "#.."],
  _: ["...", "...", "...", "...", "###"],
  "*": ["...", "#.#", ".#.", "#.#", "..."],
  "#": ["#.#", "###", "#.#", "###", "#.#"],
};

/** Glyph rows for a character; lowercase maps to uppercase, unknown characters to '?'. */
export function glyph(ch: string): string[] | undefined {
  if (ch === " ") return undefined;
  return GLYPHS[ch.toUpperCase()] ?? GLYPHS["?"];
}

function glyphWidth(ch: string): number {
  return glyph(ch)?.[0].length ?? SPACE_WIDTH;
}

/** Pixel width of the widest line ("\n" starts a new line). */
export function textWidth(text: string): number {
  let widest = 0;
  for (const line of text.split("\n")) {
    const chars = [...line];
    const width = chars.reduce((sum, ch) => sum + glyphWidth(ch), 0) + Math.max(0, chars.length - 1) * LETTER_SPACING;
    widest = Math.max(widest, width);
  }
  return widest;
}

/** Calls `plot` for every ink pixel of `text` with its top-left at (x, y). */
export function layoutText(text: string, x: number, y: number, plot: (px: number, py: number) => void): void {
  text.split("\n").forEach((line, row) => {
    let cx = x;
    const top = y + row * LINE_HEIGHT;
    for (const ch of line) {
      const rows = glyph(ch);
      if (rows) {
        rows.forEach((bits, gy) => {
          for (let gx = 0; gx < bits.length; gx++) if (bits[gx] === "#") plot(cx + gx, top + gy);
        });
      }
      cx += glyphWidth(ch) + LETTER_SPACING;
    }
  });
}
