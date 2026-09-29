// Tiles, teams and colors

/** 5 means a 5x5 bingo board */
export const BOARD_SIZE = 5;
export const TILE_COUNT = BOARD_SIZE * BOARD_SIZE;

/** @typedef {"red" | "blue"} Team */

/** @type {readonly Team[]} */
export const TEAMS = Object.freeze(["red", "blue"]);

/**
 * @param {Team} team
 * @returns {Team}
 */
export function otherTeam(team) {
  return team === "red" ? "blue" : "red";
}

/**
 * @param {unknown} value
 * @returns {value is Team}
 */
export function isTeam(value) {
  return value === "red" || value === "blue";
}

/**
 * A board coordinate, column letter + row number: `A1` (top-left) .. `E5` (bottom-right)
 * @typedef {string} TileId
 */

/**
 * Only the uppercase form is valid on the wire
 * @param {unknown} value
 * @returns {value is TileId}
 */
export function isTileId(value) {
  return typeof value === "string" && /^[A-E][1-5]$/.test(value);
}

/**
 * Index in row-major order (A1 = 0, B1 = 1, ..., E5 = 24)
 * @param {TileId} tile
 */
export function tileIndex(tile) {
  if (!isTileId(tile)) {
    throw new RangeError(`invalid tile id ${JSON.stringify(tile)}, expected A1..E5`);
  }
  const col = tile.charCodeAt(0) - 65;
  const row = tile.charCodeAt(1) - 49;
  return row * BOARD_SIZE + col;
}

/**
 * @param {number} index
 * @returns {TileId}
 */
export function tileFromIndex(index) {
  if (!Number.isInteger(index) || index < 0 || index >= TILE_COUNT) {
    throw new RangeError(`invalid tile index ${index}`);
  }
  const col = index % BOARD_SIZE;
  const row = Math.floor(index / BOARD_SIZE);
  return String.fromCharCode(65 + col) + String(row + 1);
}

/** All tiles in row-major order */
export const ALL_TILES = Object.freeze(
  Array.from({ length: TILE_COUNT }, (_, i) => tileFromIndex(i)),
);

/**
 * A team's color, `#rrggbb`
 * @param {unknown} value
 * @returns {value is string}
 */
export function isColor(value) {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
}

/**
 * Colors are always sent lowercase
 * @param {string} color
 */
export function normalizeColor(color) {
  if (!isColor(color)) {
    throw new RangeError(`invalid color ${JSON.stringify(color)}, expected #rrggbb`);
  }
  return color.toLowerCase();
}

/**
 * Client-generated id of one attempt at a tile, used to dedupe resent results
 * @param {unknown} value
 * @returns {value is string}
 */
export function isUuid(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(value)
  );
}
