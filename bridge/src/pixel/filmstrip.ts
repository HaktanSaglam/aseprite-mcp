import { createRgbaImage, type RgbaImage } from "./RgbaImage.js";

/**
 * Lays frames out left to right (wrapping into rows) with a 1px gap, so a model can
 * judge a whole animation from one image. Gaps stay transparent, which the preview
 * renders as checkerboard.
 */
export function filmstrip(frames: RgbaImage[], maxColumns = 8, gap = 1): RgbaImage {
  if (frames.length === 0) throw new Error("filmstrip: no frames");
  const { width, height } = frames[0];
  const columns = Math.min(maxColumns, frames.length);
  const rows = Math.ceil(frames.length / columns);
  const sheet = createRgbaImage(columns * width + (columns - 1) * gap, rows * height + (rows - 1) * gap);

  frames.forEach((frame, i) => {
    const ox = (i % columns) * (width + gap);
    const oy = Math.floor(i / columns) * (height + gap);
    for (let y = 0; y < height; y++) {
      const src = frame.data.subarray(y * width * 4, (y + 1) * width * 4);
      sheet.data.set(src, ((oy + y) * sheet.width + ox) * 4);
    }
  });
  return sheet;
}
