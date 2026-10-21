import { describe, expect, it } from "vitest";
import { GLYPH_HEIGHT, glyph, textWidth } from "../src/pixel/pixelFont.js";
import { bayer, Raster } from "../src/pixel/Raster.js";

const RED = "#ff0000";
const BLUE = "#0000ff";

/** Rows of '#' (opaque) / '.' (transparent): readable shape assertions. */
function mask(r: Raster): string[] {
  const rows: string[] = [];
  for (let y = 0; y < r.height; y++) {
    let row = "";
    for (let x = 0; x < r.width; x++) row += r.get(x, y) ? "#" : ".";
    rows.push(row);
  }
  return rows;
}

function opaqueCount(r: Raster): number {
  return mask(r).join("").split("#").length - 1;
}

describe("Raster basics", () => {
  it("get returns #rrggbb for opaque, #rrggbbaa for translucent, null for transparent/outside", () => {
    const r = new Raster(3, 1);
    r.set(0, 0, "#12345678");
    r.set(1, 0, "#abcdef");
    expect(r.get(0, 0)).toBe("#12345678");
    expect(r.get(1, 0)).toBe("#abcdef");
    expect(r.get(2, 0)).toBeNull();
    expect(r.get(-1, 0)).toBeNull();
    expect(r.get(0, 5)).toBeNull();
  });

  it("rejects a base image of the wrong size", () => {
    expect(() => new Raster(2, 2, { width: 3, height: 2, data: new Uint8Array(24) })).toThrow(/3x2/);
  });

  it("rect radius 1 cuts exactly the corner pixels, radius 2 the classic 2-1 step", () => {
    const r1 = new Raster(4, 3);
    r1.rect(0, 0, 4, 3, RED, 1);
    expect(mask(r1)).toEqual([".##.", "####", ".##."]);

    const r2 = new Raster(6, 5);
    r2.rect(0, 0, 6, 5, RED, 2);
    expect(mask(r2)).toEqual(["..##..", ".####.", "######", ".####.", "..##.."]);
  });

  it("circles have no single-pixel nubs and r=1 is a plus", () => {
    const plus = new Raster(3, 3);
    plus.circle(1, 1, 1, RED);
    expect(mask(plus)).toEqual([".#.", "###", ".#."]);

    // Mixed integer/half-integer centre used to add a lone pixel on the widest row.
    const r = new Raster(12, 12);
    r.circle(5.5, 5, 5, RED);
    const rows = mask(r).map((row) => row.split("#").length - 1);
    const widest = Math.max(...rows);
    expect(rows.filter((n) => n === widest).length).toBeGreaterThan(1);
  });

  it("thick lines use a round brush", () => {
    const r = new Raster(9, 9);
    r.line(1, 4, 7, 4, RED, 3);
    expect(mask(r).slice(3, 6)).toEqual([".#######.", "#########", ".#######."]);
  });

  it("curve is one connected stroke without L-corners", () => {
    const r = new Raster(20, 12);
    r.curve(0, 11, 10, -6, 19, 11, RED);
    const pts: number[][] = [];
    mask(r).forEach((row, y) => [...row].forEach((c, x) => c === "#" && pts.push([x, y])));
    const set = new Set(pts.map(([x, y]) => `${x},${y}`));
    const has = (x: number, y: number) => set.has(`${x},${y}`);
    // No 2x2 L-corner: a pixel with both an orthogonal horizontal and vertical neighbour
    // that are also diagonal to each other indicates a doubled corner.
    for (const [x, y] of pts) {
      for (const [dx, dy] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        expect(has(x + dx, y) && has(x, y + dy) && !has(x + dx, y + dy)).toBe(false);
      }
    }
    expect(has(0, 11)).toBe(true);
    expect(has(19, 11)).toBe(true);
    // Connected: flood from one end reaches every pixel (8-connectivity).
    const seen = new Set<string>(["0,11"]);
    const stack = [[0, 11]];
    while (stack.length) {
      const [x, y] = stack.pop()!;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const k = `${x + dx},${y + dy}`;
          if (set.has(k) && !seen.has(k)) {
            seen.add(k);
            stack.push([x + dx, y + dy]);
          }
        }
    }
    expect(seen.size).toBe(pts.length);
  });

  it("bayer thresholds are in (0, 1) and dither paints the requested share", () => {
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) expect(bayer(x, y)).toBeGreaterThan(0);
    expect(bayer(-1, -1)).toBe(bayer(3, 3));
    const r = new Raster(8, 8);
    r.dither(0, 0, 8, 8, RED, 0.25);
    expect(opaqueCount(r)).toBe(16);
  });
});

describe("gradient", () => {
  it("bands: equal flat bands in order, top to bottom", () => {
    const r = new Raster(2, 6);
    r.gradient(0, 0, 2, 6, ["#000000", "#808080", "#ffffff"], "v", "bands");
    expect([0, 1, 2, 3, 4, 5].map((y) => r.get(0, y))).toEqual([
      "#000000", "#000000", "#808080", "#808080", "#ffffff", "#ffffff",
    ]);
  });

  it("checker: flat bands joined by a 2px 50% checkerboard", () => {
    const r = new Raster(4, 8);
    r.gradient(0, 0, 4, 8, [RED, BLUE], "v", "checker");
    expect(r.get(0, 0)).toBe(RED);
    expect(r.get(0, 7)).toBe(BLUE);
    for (const y of [3, 4]) {
      const row = [0, 1, 2, 3].map((x) => r.get(x, y));
      expect(new Set(row)).toEqual(new Set([RED, BLUE]));
      expect(row[0]).not.toBe(row[1]);
    }
  });

  it("dither: share of the second color grows along the axis", () => {
    const r = new Raster(16, 4);
    r.gradient(0, 0, 16, 4, [RED, BLUE], "h", "dither");
    const blueIn = (x0: number) => {
      let n = 0;
      for (let y = 0; y < 4; y++) for (let x = x0; x < x0 + 4; x++) if (r.get(x, y) === BLUE) n++;
      return n;
    };
    expect(blueIn(0)).toBeLessThan(blueIn(6));
    expect(blueIn(6)).toBeLessThan(blueIn(12));
  });

  it("radial: first color at the centre, last at the edge", () => {
    const r = new Raster(9, 9);
    r.gradient(0, 0, 9, 9, [RED, "#00ff00", BLUE], "radial", "bands");
    expect(r.get(4, 4)).toBe(RED);
    expect(r.get(0, 0)).toBe(BLUE);
  });
});

describe("sphere", () => {
  it("lit side is lighter, highlight is a small cluster toward the light", () => {
    const colors = ["#000000", "#404040", "#808080", "#c0c0c0", "#ffffff"];
    const r = new Raster(21, 21);
    r.sphere(10, 10, 9, 9, colors, "tl");
    const index = (x: number, y: number) => colors.indexOf(r.get(x, y)!);
    expect(index(5, 5)).toBeGreaterThan(index(15, 15));
    let highlight = 0;
    let total = 0;
    let hx = 0;
    let hy = 0;
    for (let y = 0; y < 21; y++)
      for (let x = 0; x < 21; x++) {
        if (!r.get(x, y)) continue;
        total++;
        if (index(x, y) === 4) {
          highlight++;
          hx += x;
          hy += y;
        }
      }
    expect(highlight / total).toBeGreaterThan(0.03);
    expect(highlight / total).toBeLessThan(0.15);
    expect(hx / highlight).toBeLessThan(10);
    expect(hy / highlight).toBeLessThan(10);
  });

  it("uses only the given colors and supports ellipsoids", () => {
    const colors = ["#111111", "#555555", "#999999"];
    const r = new Raster(20, 10);
    r.sphere(10, 5, 9, 4, colors, "t");
    const used = new Set(mask(r).flatMap((row, y) => [...row].map((c, x) => (c === "#" ? r.get(x, y) : null))));
    used.delete(null);
    expect([...used].every((c) => colors.includes(c!))).toBe(true);
    expect(r.get(10, 1)).toBe("#999999");
  });
});

describe("whole-raster passes", () => {
  it("mirror x copies the left half onto the right", () => {
    const r = new Raster(5, 1);
    r.set(0, 0, RED);
    r.set(1, 0, BLUE);
    r.mirror("x");
    expect([0, 1, 2, 3, 4].map((x) => r.get(x, 0))).toEqual([RED, BLUE, null, BLUE, RED]);
    r.set(4, 0, "#00ff00");
    r.mirror("x", false);
    expect(r.get(0, 0)).toBe("#00ff00");
  });

  it("mirror y copies the top half onto the bottom", () => {
    const r = new Raster(1, 4);
    r.set(0, 0, RED);
    r.mirror("y");
    expect(r.get(0, 3)).toBe(RED);
  });

  it("stamp draws a write_pixels grid and '.' keeps what is below", () => {
    const r = new Raster(4, 2);
    r.rect(0, 0, 4, 2, BLUE);
    r.stamp(["a.a", ".a."], { a: RED }, 1, 0);
    expect(mask(r)).toEqual(["####", "####"]);
    expect(r.get(1, 0)).toBe(RED);
    expect(r.get(2, 0)).toBe(BLUE);
    expect(r.get(2, 1)).toBe(RED);
  });

  it("stamp reports grid errors with row/column", () => {
    const r = new Raster(4, 4);
    expect(() => r.stamp(["ab", "a"], { a: RED, b: BLUE }, 0, 0)).toThrow(/Row 1/);
    expect(() => r.stamp(["az"], { a: RED }, 0, 0)).toThrow(/"z"/);
  });

  it("outline outside (4-connected) surrounds a shape without corners", () => {
    const r = new Raster(5, 5);
    r.set(2, 2, RED);
    r.outline(BLUE);
    expect(mask(r)).toEqual([".....", "..#..", ".###.", "..#..", "....."]);
    expect(r.get(2, 1)).toBe(BLUE);
  });

  it("outline 8-connected also fills diagonals; inside recolors the edge", () => {
    const r8 = new Raster(5, 5);
    r8.set(2, 2, RED);
    r8.outline(BLUE, { connectivity: 8 });
    expect(mask(r8)).toEqual([".....", ".###.", ".###.", ".###.", "....."]);

    const inside = new Raster(5, 5);
    inside.rect(1, 1, 3, 3, RED);
    inside.outline(BLUE, { placement: "inside" });
    expect(inside.get(2, 2)).toBe(RED);
    expect(inside.get(1, 1)).toBe(BLUE);
    expect(inside.get(0, 0)).toBeNull();
  });

  it("outline with a function derives the color from the darkest touching pixel", () => {
    const r = new Raster(4, 3);
    r.set(1, 1, "#ffffff");
    r.set(2, 1, "#202020");
    const seen: string[] = [];
    r.outline((edge) => {
      seen.push(edge);
      return "#00ff00";
    });
    expect(r.get(1, 0)).toBe("#00ff00");
    expect(seen).toContain("#202020ff");
    // (1,0) touches only the white pixel; (3,1) only the dark one.
    expect(seen.filter((c) => c === "#ffffffff").length).toBeGreaterThan(0);
  });

  it("replace swaps exact colors, optionally inside a rect", () => {
    const r = new Raster(4, 1);
    r.rect(0, 0, 4, 1, RED);
    r.replace(RED, BLUE, 2, 0, 2, 1);
    expect([0, 1, 2, 3].map((x) => r.get(x, 0))).toEqual([RED, RED, BLUE, BLUE]);
    r.replace("transparent", "#00ff00");
    expect(opaqueCount(r)).toBe(4);
  });

  it("copy skips transparent pixels and can flip; move clears the source", () => {
    const r = new Raster(6, 2);
    r.set(0, 0, RED);
    r.set(1, 0, BLUE);
    r.rect(4, 0, 2, 1, "#00ff00");
    r.copy(0, 0, 2, 1, 4, 0, "x");
    expect(r.get(4, 0)).toBe(BLUE);
    expect(r.get(5, 0)).toBe(RED);
    r.copy(0, 0, 3, 1, 3, 1);
    expect(r.get(5, 1)).toBeNull(); // the transparent source pixel did not overwrite

    const m = new Raster(3, 3);
    m.set(0, 0, RED);
    m.move(0, 0, 1, 1, 2, 2);
    expect(m.get(0, 0)).toBeNull();
    expect(m.get(2, 2)).toBe(RED);
  });
});

describe("text", () => {
  it("draws 3x5 glyphs with 1px spacing and returns the width", () => {
    const r = new Raster(12, 6);
    const w = r.text(0, 0, "HI", RED);
    expect(w).toBe(7);
    expect(textWidth("HI")).toBe(7);
    const rows = mask(r);
    expect(rows.slice(0, 5).map((row) => row.slice(0, 7))).toEqual([
      "#.#.###",
      "#.#..#.",
      "###..#.",
      "#.#..#.",
      "#.#.###",
    ]);
    expect(rows[5]).toBe("............");
  });

  it("every glyph fits the 5px height, lowercase maps to uppercase, unknown to '?'", () => {
    for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,!?:;'\"-+=/%()<>_*#") {
      const rows = glyph(ch)!;
      expect(rows).toHaveLength(GLYPH_HEIGHT);
      expect(new Set(rows.map((row) => row.length)).size).toBe(1);
      expect(rows.join("")).toContain("#");
    }
    expect(glyph("a")).toEqual(glyph("A"));
    expect(glyph("~")).toEqual(glyph("?"));
    expect(glyph(" ")).toBeUndefined();
  });

  it("multi-line text: width of the widest line, lines 6px apart", () => {
    expect(textWidth("A\nABC")).toBe(11);
    const r = new Raster(4, 12);
    r.text(0, 0, "I\nI", RED);
    expect(r.get(1, 6)).toBe(RED);
    expect(r.get(1, 5)).toBeNull();
  });
});
