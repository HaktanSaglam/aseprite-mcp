/** Frame order of a "directions" sprite; each frame is tagged with its direction's name. */
export const DIRECTION_ORDER = {
  4: ["down", "right", "up", "left"],
  8: ["down", "down-right", "right", "up-right", "up", "up-left", "left", "down-left"],
} as const;

export type Direction = (typeof DIRECTION_ORDER)[8][number];

const ALL_DIRECTIONS: readonly string[] = DIRECTION_ORDER[8];

export function isDirection(name: string): name is Direction {
  return ALL_DIRECTIONS.includes(name);
}

/** Sorts direction names into the order they are drawn in (down first). */
export function byDirectionOrder(a: Direction, b: Direction): number {
  return ALL_DIRECTIONS.indexOf(a) - ALL_DIRECTIONS.indexOf(b);
}

/** A left-facing direction the bridge mirrors from its right-facing twin. */
export interface MirrorPair {
  from: Direction;
  to: Direction;
}

const MIRROR_OF: Partial<Record<Direction, Direction>> = {
  left: "right",
  "up-left": "up-right",
  "down-left": "down-right",
};

/**
 * Left-facing sprites are mirrors of the right-facing ones (asymmetric details aside),
 * so the bridge copies them flipped instead of a model drawing them. Every source comes
 * before its target in DIRECTION_ORDER, so drawing in that order always has it ready.
 */
export function mirrorPairs(directions: readonly string[]): MirrorPair[] {
  const present = new Set(directions);
  const pairs: MirrorPair[] = [];
  for (const to of directions) {
    if (!isDirection(to)) continue;
    const from = MIRROR_OF[to];
    if (from && present.has(from)) pairs.push({ from, to });
  }
  return pairs;
}
