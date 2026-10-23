import { inflateSync } from "node:zlib";
import { PNG } from "pngjs";
import type { RgbaImage } from "./RgbaImage.js";

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
// Signature (8) + IHDR length (4) + "IHDR" (4) + width (4) + height (4) + bit depth,
// color type, compression, filter and interlace method (1 each).
const HEADER_BYTES = 29;
// Samples per pixel by PNG color type: gray, RGB, palette, gray + alpha, RGBA.
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const BIT_DEPTHS = [1, 2, 4, 8, 16];
// Adam7 passes as [x start, y start, x step, y step].
const ADAM7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const;

interface PngHeader {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlaced: boolean;
}

function readHeader(buffer: Uint8Array): PngHeader {
  const isPng =
    buffer.length >= HEADER_BYTES &&
    SIGNATURE.every((byte, i) => buffer[i] === byte) &&
    String.fromCharCode(buffer[12], buffer[13], buffer[14], buffer[15]) === "IHDR";
  if (!isPng) throw new Error("not a PNG file (its first bytes are not a PNG signature)");
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  return {
    width: view.getUint32(16),
    height: view.getUint32(20),
    bitDepth: buffer[24],
    colorType: buffer[25],
    interlaced: buffer[28] === 1,
  };
}

/** Width and height from the PNG header, without decoding any pixels. */
export function pngSize(buffer: Uint8Array): { width: number; height: number } {
  const { width, height } = readHeader(buffer);
  return { width, height };
}

/** Bytes the 7 Adam7 passes inflate to: each pass row is a filter byte plus its packed samples. */
function interlacedDataSize({ width, height, bitDepth, colorType }: PngHeader): number {
  const bitsPerPixel = CHANNELS[colorType] * bitDepth;
  let total = 0;
  for (const [x0, y0, dx, dy] of ADAM7) {
    const columns = width > x0 ? Math.ceil((width - x0) / dx) : 0;
    const rows = height > y0 ? Math.ceil((height - y0) / dy) : 0;
    if (columns > 0) total += rows * (1 + Math.ceil((columns * bitsPerPixel) / 8));
  }
  return total;
}

/** The compressed pixel stream: every IDAT chunk's data in file order, as a decoder joins them. */
function idatStream(buffer: Uint8Array): Buffer {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const parts: Uint8Array[] = [];
  let at = SIGNATURE.length;
  while (at + 8 <= buffer.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(buffer[at + 4], buffer[at + 5], buffer[at + 6], buffer[at + 7]);
    const end = at + 8 + length;
    // A truncated chunk: pngjs reports it before inflating anything.
    if (end + 4 > buffer.length) break;
    if (type === "IDAT") parts.push(buffer.subarray(at + 8, end));
    if (type === "IEND") break;
    at = end + 4;
  }
  return Buffer.concat(parts);
}

/**
 * pngjs inflates interlaced pixel data without any size limit, so a small file whose
 * header passes the size check could still decompress to gigabytes. Inflating it here
 * first, capped at what the header's size needs, proves the stream is no bigger; pngjs
 * then repeats the same bounded work. Non-interlaced data pngjs already caps itself.
 */
function checkInterlacedData(buffer: Uint8Array, header: PngHeader): void {
  if (CHANNELS[header.colorType] === undefined || !BIT_DEPTHS.includes(header.bitDepth)) {
    throw new Error(`unsupported PNG format (color type ${header.colorType}, bit depth ${header.bitDepth})`);
  }
  try {
    inflateSync(idatStream(buffer), { maxOutputLength: interlacedDataSize(header) });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE") {
      throw new Error(
        `its pixel data is bigger than its ${header.width}x${header.height} header says (a corrupt or hostile file)`,
      );
    }
    throw new Error(`the PNG could not be decoded (${error instanceof Error ? error.message : String(error)})`);
  }
}

/**
 * Decodes a PNG of any color type or bit depth to 8-bit RGBA. The size is checked from
 * the header first: a tiny file can declare a gigantic image, and decoding that would
 * exhaust memory before any later check ran.
 */
export function decodePng(buffer: Uint8Array, maxSide: number): RgbaImage {
  const header = readHeader(buffer);
  const { width, height } = header;
  if (width === 0 || height === 0) throw new Error("the PNG is empty (0 pixels wide or high)");
  if (width > maxSide || height > maxSide) {
    throw new Error(`the image is ${width}x${height}; at most ${maxSide}x${maxSide} can be imported`);
  }
  if (header.interlaced) checkInterlacedData(buffer, header);
  let png: PNG;
  try {
    png = PNG.sync.read(Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength));
  } catch (error) {
    throw new Error(`the PNG could not be decoded (${error instanceof Error ? error.message : String(error)})`);
  }
  return { width: png.width, height: png.height, data: new Uint8Array(png.data) };
}
