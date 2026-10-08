import { createRgbaImage, type RgbaImage } from "./RgbaImage.js";

/**
 * The format Claude reads and writes: one character per pixel plus a palette legend.
 * Far cheaper in tokens than per-pixel hex, and it maps naturally onto indexed palettes.
 */
export interface PixelGrid {
  palette: Record<string, string>;
  rows: string[];
}

export const TRANSPARENT_KEY = ".";

// Excludes ".", whitespace, quotes and backslash so rows stay unambiguous inside JSON.
const KEY_ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#$%&*+-=?@^~!:;<>/|_()[]{}";

function toHexColor(r: number, g: number, b: number, a: number): string {
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return a === 255 ? `#${hex(r)}${hex(g)}${hex(b)}` : `#${hex(r)}${hex(g)}${hex(b)}${hex(a)}`;
}

/** Accepts #rgb, #rrggbb, #rrggbbaa and "transparent". Returns [r, g, b, a]. */
export function parseColor(value: string): [number, number, number, number] {
  const v = value.trim().toLowerCase();
  if (v === "transparent") return [0, 0, 0, 0];
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(v);
  if (!m) throw new Error(`Invalid color "${value}" (use #rrggbb, #rrggbbaa or "transparent")`);
  let hex = m[1];
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  if (hex.length === 6) hex += "ff";
  return [0, 2, 4, 6].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as [
    number,
    number,
    number,
    number,
  ];
}

export function encodeGrid(image: RgbaImage): PixelGrid {
  const keyByColor = new Map<string, string>();
  const palette: Record<string, string> = {};
  const rows: string[] = [];
  let used = false;

  for (let y = 0; y < image.height; y++) {
    let row = "";
    for (let x = 0; x < image.width; x++) {
      const o = (y * image.width + x) * 4;
      const [r, g, b, a] = image.data.subarray(o, o + 4);
      if (a === 0) {
        row += TRANSPARENT_KEY;
        used = true;
        continue;
      }
      const color = toHexColor(r, g, b, a);
      let key = keyByColor.get(color);
      if (key === undefined) {
        if (keyByColor.size >= KEY_ALPHABET.length) {
          throw new Error(
            `Region has more than ${KEY_ALPHABET.length} colors; read a smaller region instead`,
          );
        }
        key = KEY_ALPHABET[keyByColor.size];
        keyByColor.set(color, key);
        palette[key] = color;
      }
      row += key;
    }
    rows.push(row);
  }

  if (used) palette[TRANSPARENT_KEY] = "transparent";
  return { palette, rows };
}

/** Error messages point at the exact row/column so Claude can fix its own output. */
export function decodeGrid(grid: PixelGrid): RgbaImage {
  const { rows } = grid;
  if (rows.length === 0) throw new Error("rows must not be empty");
  const width = [...rows[0]].length;
  if (width === 0) throw new Error("rows must not be empty strings");

  const colors = new Map<string, [number, number, number, number]>();
  colors.set(TRANSPARENT_KEY, [0, 0, 0, 0]);
  for (const [key, value] of Object.entries(grid.palette)) {
    if ([...key].length !== 1) throw new Error(`Palette key "${key}" must be a single character`);
    colors.set(key, parseColor(value));
  }

  const image = createRgbaImage(width, rows.length);
  rows.forEach((row, y) => {
    const chars = [...row];
    if (chars.length !== width) {
      throw new Error(`Row ${y} has ${chars.length} pixels, expected ${width} (same as row 0)`);
    }
    chars.forEach((ch, x) => {
      const rgba = colors.get(ch);
      if (!rgba) throw new Error(`Unknown palette key "${ch}" at row ${y}, column ${x}`);
      image.data.set(rgba, (y * width + x) * 4);
    });
  });
  return image;
}
