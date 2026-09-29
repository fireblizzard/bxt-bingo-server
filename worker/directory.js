// Join codes, for local testing only
// In production they live in the web side's D1 table `join_codes` (BINGO-WEB.md §7.3),
// made by the join page after Steam login. This stands in for it with the same behaviour:
// personal, single use, valid for 10 minutes, stored only as hashes

import { DurableObject } from "cloudflare:workers";

import { newJoinCode, normalizeJoinCode, sha256Hex } from "./secrets.js";

const CODE_LIFETIME_MS = 10 * 60_000;

/**
 * @typedef {object} CodeEntry
 * @property {string} gameId
 * @property {string} steamid64
 * @property {number} expiresAt
 * @property {boolean} used
 */

export class Directory extends DurableObject {
  /**
   * A new code for a player of a game
   * @param {string} gameId
   * @param {string} steamid64
   */
  async issue(gameId, steamid64) {
    const code = newJoinCode();
    /** @type {CodeEntry} */
    const entry = { gameId, steamid64, expiresAt: Date.now() + CODE_LIFETIME_MS, used: false };
    await this.ctx.storage.put(`code:${await sha256Hex(code)}`, entry);
    return code;
  }

  /**
   * Uses a code up
   * @param {string} code
   * @returns {Promise<{ gameId: string, steamid64: string } | { error: "bad_code" | "code_expired" }>}
   */
  async redeem(code) {
    const key = `code:${await sha256Hex(normalizeJoinCode(code))}`;
    /** @type {CodeEntry | undefined} */
    const entry = await this.ctx.storage.get(key);
    if (!entry || entry.used) {
      return { error: "bad_code" };
    }
    if (Date.now() > entry.expiresAt) {
      await this.ctx.storage.delete(key);
      return { error: "code_expired" };
    }
    entry.used = true;
    await this.ctx.storage.put(key, entry);
    return { gameId: entry.gameId, steamid64: entry.steamid64 };
  }
}
