// Random codes and tokens, and their hashes. Only hashes are stored

// No 0/O, 1/I/L, so codes are easy to read and type
const CODE_LETTERS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** A personal join code like `K7QF-29` */
export function newJoinCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  const chars = [...bytes].map((b) => CODE_LETTERS[b % CODE_LETTERS.length]);
  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

/**
 * Codes are typed by hand, so case and spaces don't matter
 * @param {string} code
 */
export function normalizeJoinCode(code) {
  return code.trim().toUpperCase();
}

/**
 * A session token for BXT to reconnect with: `<game id>.<secret>`
 * The game id lets the Worker find the game without a lookup
 * @param {string} gameId
 */
export function newSessionToken(gameId) {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const secret = btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${gameId}.${secret}`;
}

/** An id for a new game */
export function newGameId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Lowercase hex SHA-256 of a text or bytes
 * @param {string | ArrayBuffer | Uint8Array} data
 */
export async function sha256Hex(data) {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
