/** Straight (non-premultiplied) RGBA, 4 bytes per pixel, row-major. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export function createRgbaImage(width: number, height: number): RgbaImage {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

/** The Aseprite extension sends pixels as "rrggbbaa" per pixel; hex keeps the Lua side trivial. */
export function rgbaFromHex(hex: string, width: number, height: number): RgbaImage {
  const expected = width * height * 8;
  if (hex.length !== expected) {
    throw new Error(`Pixel payload length ${hex.length} does not match ${width}x${height}`);
  }
  const image = createRgbaImage(width, height);
  for (let i = 0; i < image.data.length; i++) {
    image.data[i] = Number.parseInt(hex.substr(i * 2, 2), 16);
  }
  return image;
}

export function rgbaToHex(image: RgbaImage): string {
  let out = "";
  for (const byte of image.data) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}
