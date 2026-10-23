import { PNG } from "pngjs";
import type { RgbaImage } from "./RgbaImage.js";

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
// Signature (8) + IHDR length (4) + "IHDR" (4) + width (4) + height (4).
const HEADER_BYTES = 24;

/** Width and height from the PNG header, without decoding any pixels. */
export function pngSize(buffer: Uint8Array): { width: number; height: number } {
  const isPng =
    buffer.length >= HEADER_BYTES &&
    SIGNATURE.every((byte, i) => buffer[i] === byte) &&
    String.fromCharCode(buffer[12], buffer[13], buffer[14], buffer[15]) === "IHDR";
  if (!isPng) throw new Error("not a PNG file (its first bytes are not a PNG signature)");
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * Decodes a PNG of any color type or bit depth to 8-bit RGBA. The size is checked from
 * the header first: a tiny file can declare a gigantic image, and decoding that would
 * exhaust memory before any later check ran.
 */
export function decodePng(buffer: Uint8Array, maxSide: number): RgbaImage {
  const { width, height } = pngSize(buffer);
  if (width === 0 || height === 0) throw new Error("the PNG is empty (0 pixels wide or high)");
  if (width > maxSide || height > maxSide) {
    throw new Error(`the image is ${width}x${height}; at most ${maxSide}x${maxSide} can be imported`);
  }
  let png: PNG;
  try {
    png = PNG.sync.read(Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength));
  } catch (error) {
    throw new Error(`the PNG could not be decoded (${error instanceof Error ? error.message : String(error)})`);
  }
  return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
}
