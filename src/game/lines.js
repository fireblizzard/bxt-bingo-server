import { BOARD_SIZE, tileFromIndex } from "../protocol/ids.js";

const N = BOARD_SIZE;

/**
 * All 12 winning lines: 5 rows (top to bottom), 5 columns (left to right),
 * then the two diagonals (A1..E5, E1..A5)
 * When a capture completes several lines at once, the first one in this order is reported
 * @type {readonly (readonly import("../protocol/ids.js").TileId[])[]}
 */
export const LINES = Object.freeze(
  [
    ...Array.from({ length: N }, (_, row) => Array.from({ length: N }, (_, col) => row * N + col)),
    ...Array.from({ length: N }, (_, col) => Array.from({ length: N }, (_, row) => row * N + col)),
    Array.from({ length: N }, (_, i) => i * N + i),
    Array.from({ length: N }, (_, i) => i * N + (N - 1 - i)),
  ].map((line) => Object.freeze(line.map(tileFromIndex))),
);
