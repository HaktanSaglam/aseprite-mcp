/** Small seeded PRNG (mulberry32): deterministic output for the same seed. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type NoiseFn = (x: number, y: number, scale?: number, octaves?: number) => number;

const MAX_OCTAVES = 6;

/**
 * Seeded 2D value noise in 0..1 (smoothstep-interpolated lattice). Unlike rand() it is a
 * pure function of (x, y), so scripts get organic texture (terrain, clouds, rust) that
 * stays identical across frames and re-runs.
 */
export function createValueNoise(seed: number): NoiseFn {
  const s = Math.imul(seed | 0, 0x27d4eb2d);
  const lattice = (ix: number, iy: number): number => {
    let h = (Math.imul(ix, 0x165667b1) + Math.imul(iy, 0x5bd1e995) + s) | 0;
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
    h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
    return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
  };
  const smooth = (t: number) => t * t * (3 - 2 * t);
  const value = (x: number, y: number): number => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const u = smooth(x - x0);
    const v = smooth(y - y0);
    const top = lattice(x0, y0) + (lattice(x0 + 1, y0) - lattice(x0, y0)) * u;
    const bottom = lattice(x0, y0 + 1) + (lattice(x0 + 1, y0 + 1) - lattice(x0, y0 + 1)) * u;
    return top + (bottom - top) * v;
  };

  return (x, y, scale = 8, octaves = 1) => {
    const size = scale > 0 ? scale : 8;
    const count = Math.max(1, Math.min(MAX_OCTAVES, Math.round(octaves)));
    let sum = 0;
    let norm = 0;
    let amplitude = 1;
    let frequency = 1 / size;
    for (let o = 0; o < count; o++) {
      // Offsetting each octave avoids every octave sharing a lattice point at the origin.
      sum += amplitude * value(x * frequency + o * 17.31, y * frequency + o * 9.73);
      norm += amplitude;
      amplitude /= 2;
      frequency *= 2;
    }
    return sum / norm;
  };
}
