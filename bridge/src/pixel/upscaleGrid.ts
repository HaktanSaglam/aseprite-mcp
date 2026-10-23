/** How upscaled pixel art sits on its canvas: every art pixel is a scale x scale block. */
export interface UpscaleGrid {
  /** Canvas pixels per art pixel; 1 means not upscaled. */
  scale: number;
  /** Where the first whole block starts on each axis (0..scale-1); a partial block may sit before it. */
  offsetX: number;
  offsetY: number;
  /** Share of the color edges that lie on the grid lines (0..1). */
  fit: number;
}

/** One block, in canvas pixels (x1/y1 exclusive). */
export interface GridCell {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Block start positions along one axis, followed by `size` as the end of the last block. */
export function cellStarts(size: number, scale: number, offset: number): number[] {
  const starts = offset > 0 ? [0] : [];
  for (let s = offset; s < size; s += scale) starts.push(s);
  starts.push(size);
  return starts;
}

/** Size of the downscaled image; blocks cut by the canvas edge still become pixels. */
export function gridSize(width: number, height: number, grid: UpscaleGrid): { width: number; height: number } {
  return {
    width: cellStarts(width, grid.scale, grid.offsetX).length - 1,
    height: cellStarts(height, grid.scale, grid.offsetY).length - 1,
  };
}

/** Visits every block row by row; `index` is the block's pixel index in the downscaled image. */
export function forEachCell(
  size: { width: number; height: number },
  grid: UpscaleGrid,
  visit: (cell: GridCell, index: number) => void,
): void {
  const xs = cellStarts(size.width, grid.scale, grid.offsetX);
  const ys = cellStarts(size.height, grid.scale, grid.offsetY);
  const columns = xs.length - 1;
  for (let cy = 0; cy + 1 < ys.length; cy++) {
    for (let cx = 0; cx < columns; cx++) {
      visit({ x0: xs[cx], y0: ys[cy], x1: xs[cx + 1], y1: ys[cy + 1] }, cy * columns + cx);
    }
  }
}
