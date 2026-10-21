/** Straight (non-premultiplied) RGBA, 4 bytes per pixel, row-major. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export function createRgbaImage(width: number, height: number): RgbaImage {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

export function cloneImage(image: RgbaImage): RgbaImage {
  return { width: image.width, height: image.height, data: new Uint8Array(image.data) };
}
