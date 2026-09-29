// Bingo rules: tile ownership, stealing, redo and lockout, and how a game ends (BINGO.md §10.2)
//
// Pure logic with no I/O, so it runs anywhere (a Durable Object, tests, the browser)
// A game is an event log of results plus the board derived from it
// The board is always a function of (settings, log without voided results, clock),
// so voiding a result replays the log without it
//
// Checks that need more than the board (save hashes, clock checks, plausibility)
// happen before a result reaches submit(). That layer decides `flagged` and `rejected`
// Times are in ms since the round started

import { TEAMS, TILE_COUNT, isTeam, otherTeam, tileIndex } from "../protocol/ids.js";
import { TIEBREAKERS } from "../protocol/messages.js";
import { LINES } from "./lines.js";

/**
 * @typedef {import("../protocol/ids.js").Team} Team
 * @typedef {import("../protocol/ids.js").TileId} TileId
 * @typedef {import("../protocol/messages.js").Verdict} Verdict
 * @typedef {import("../protocol/messages.js").EndReason} EndReason
 * @typedef {import("../protocol/messages.js").Tiebreaker} Tiebreaker
 */

/**
 * The lobby creator's choices (BINGO.md §10)
 * @typedef {object} Settings
 * @property {boolean} [redoOwnTile] A team may replay a tile it owns to improve its time
 * @property {boolean} [lockout] Once claimed, the other team can't steal a tile
 * @property {number | null} [timeLimitMs] `null` for no time limit
 * @property {number | null} [suddenDeathMs] Length of sudden death after the time limit, `null` for off
 * @property {Tiebreaker[]} [tiebreakers] Checked in this order when the tiles are even at the end
 */

/**
 * A finished attempt that passed the checks before the rules
 * @typedef {object} Submission
 * @property {string} attemptId
 * @property {string} player SteamID64
 * @property {Team} team
 * @property {TileId} tile
 * @property {number} timeMs The run's time
 * @property {number} atMs When the server got it. Never earlier than the previous call's time
 */

/**
 * @typedef {object} Holder
 * @property {Team} team
 * @property {string} player
 * @property {number} timeMs
 * @property {string} attemptId
 */

/**
 * @typedef {object} Ending
 * @property {Team | null} winner
 * @property {EndReason} reason
 * @property {Tiebreaker | null} tiebreaker
 * @property {TileId[] | null} line
 * @property {number} atMs
 */

/**
 * What the tiebreakers need that the board doesn't know, at the end of the game
 * `handicaps` is the team's handicaps minus its assists
 * @typedef {Record<Team, { players: number, handicaps: number }>} TeamStats
 */

/**
 * @typedef {object} Outcome
 * @property {Verdict} verdict
 * @property {Ending | null} ending Set when this submission ended the game
 * @property {boolean} duplicate The attempt was already submitted, so nothing changed
 *   `verdict` is its current one, to re-ack with (`rejected` if it was voided)
 */

/**
 * @typedef {{ kind: "result", submission: Submission, voided: boolean, verdict: Verdict | null }
 *   | { kind: "host_end", atMs: number }} Entry
 */

export class Game {
  /** @param {Settings} [settings] */
  constructor(settings = {}) {
    const tiebreakers = settings.tiebreakers ?? [];
    for (const tiebreaker of tiebreakers) {
      if (!TIEBREAKERS.includes(tiebreaker)) {
        throw new RangeError(`unknown tiebreaker ${tiebreaker}`);
      }
    }
    if (new Set(tiebreakers).size !== tiebreakers.length) {
      throw new RangeError("a tiebreaker is listed twice");
    }
    for (const name of /** @type {const} */ (["timeLimitMs", "suddenDeathMs"])) {
      const value = settings[name];
      if (value != null && !(Number.isInteger(value) && value > 0)) {
        throw new RangeError(`${name} must be a positive whole number or null`);
      }
    }

    /** @type {Readonly<{ redoOwnTile: boolean, lockout: boolean, timeLimitMs: number | null, suddenDeathMs: number | null, tiebreakers: readonly Tiebreaker[] }>} */
    this.settings = Object.freeze({
      redoOwnTile: settings.redoOwnTile ?? false,
      lockout: settings.lockout ?? false,
      timeLimitMs: settings.timeLimitMs ?? null,
      suddenDeathMs: settings.suddenDeathMs ?? null,
      tiebreakers: Object.freeze([...tiebreakers]),
    });

    /** @type {Entry[]} */
    this.log = [];
    /** Latest time seen */
    this.now = 0;
    /** @type {TeamStats} */
    this.teamStats = { red: { players: 0, handicaps: 0 }, blue: { players: 0, handicaps: 0 } };
    this.#reset();
  }

  /** @type {(Holder | null)[]} */
  #board = [];
  /** @type {Ending | null} */
  #ending = null;
  #suddenDeath = false;
  /** @type {Record<Team, number>} */
  #steals = { red: 0, blue: 0 };
  /**
   * When each team first had each tile count
   * @type {Record<Team, Map<number, number>>}
   */
  #firstReached = { red: new Map(), blue: new Map() };

  #reset() {
    this.#board = Array(TILE_COUNT).fill(null);
    this.#ending = null;
    this.#suddenDeath = false;
    this.#steals = { red: 0, blue: 0 };
    this.#firstReached = { red: new Map([[0, 0]]), blue: new Map([[0, 0]]) };
  }

  /**
   * Rebuilds a game from what was stored, e.g. when a hibernated Durable Object wakes up
   * Store `log`, `now` and `teamStats` after every change
   * @param {Settings} settings
   * @param {{ log: Entry[], now: number, teamStats: TeamStats }} stored
   */
  static restore(settings, { log, now, teamStats }) {
    const game = new Game(settings);
    game.log = structuredClone(log);
    game.now = now;
    game.teamStats = structuredClone(teamStats);
    game.#replay();
    return game;
  }

  /**
   * @param {TileId} tile
   * @returns {Readonly<Holder> | null}
   */
  holder(tile) {
    return this.#board[tileIndex(tile)];
  }

  /** @returns {Readonly<Ending> | null} */
  get ending() {
    return this.#ending;
  }

  /** Whether the time limit ran out on even tiles and sudden death is on */
  get suddenDeath() {
    return this.#suddenDeath && !this.#ending;
  }

  /** @returns {Record<Team, number>} */
  tileCounts() {
    const counts = { red: 0, blue: 0 };
    for (const holder of this.#board) {
      if (holder) {
        counts[holder.team]++;
      }
    }
    return counts;
  }

  /**
   * When the server has to call advance() next: the time limit, or the end of sudden death
   * `null` when nothing is timed
   */
  nextDeadlineMs() {
    const { timeLimitMs, suddenDeathMs } = this.settings;
    if (this.#ending || timeLimitMs === null) {
      return null;
    }
    return this.#suddenDeath && suddenDeathMs !== null ? timeLimitMs + suddenDeathMs : timeLimitMs;
  }

  /**
   * Current verdict of an attempt, `null` if unknown or voided
   * Can differ from the one at submission after a void changes history
   * @param {string} attemptId
   */
  verdictOf(attemptId) {
    return this.#find(attemptId)?.verdict ?? null;
  }

  /**
   * Whether `team` may play `tile` now. This is `playable_for_you` in the board
   * @param {Team} team
   * @param {TileId} tile
   */
  isPlayable(team, tile) {
    return this.#ending === null && this.#judge(team, tile, 1) !== "locked";
  }

  /**
   * @param {Submission} submission
   * @returns {Outcome}
   */
  submit(submission) {
    const existing = this.#find(submission.attemptId);
    if (existing) {
      return { verdict: existing.verdict ?? "rejected", ending: null, duplicate: true };
    }
    if (!Number.isInteger(submission.timeMs) || submission.timeMs <= 0) {
      throw new RangeError("timeMs must be a positive whole number");
    }
    if (!isTeam(submission.team)) {
      throw new RangeError(`invalid team ${submission.team}`);
    }
    tileIndex(submission.tile);
    this.#moveClock(submission.atMs);

    const wasOver = this.#ending !== null;
    this.#checkClock(submission.atMs);
    const verdict = this.#ending ? "game_over" : this.#apply(submission);
    this.log.push({ kind: "result", submission: { ...submission }, voided: false, verdict });
    return { verdict, ending: wasOver ? null : this.#ending, duplicate: false };
  }

  /**
   * Moves the clock: call it when nextDeadlineMs() is reached, and whenever the teams change
   * Returns the ending if the game ended now
   * @param {number} atMs
   * @param {TeamStats} [teamStats] The teams as they are now, for the tiebreakers
   * @returns {Readonly<Ending> | null}
   */
  advance(atMs, teamStats) {
    this.#moveClock(atMs);
    if (teamStats) {
      this.teamStats = structuredClone(teamStats);
    }
    const wasOver = this.#ending !== null;
    this.#checkClock(atMs);
    return wasOver ? null : this.#ending;
  }

  /**
   * The host ends the game early, with no winner
   * Returns the ending, or null if the game was already over
   * @param {number} atMs
   * @returns {Readonly<Ending> | null}
   */
  endByHost(atMs) {
    this.#moveClock(atMs);
    this.#checkClock(atMs);
    if (this.#ending) {
      return null;
    }
    this.log.push({ kind: "host_end", atMs });
    this.#end(null, "host_ended", atMs);
    return this.#ending;
  }

  /**
   * Removes a result (host or moderator) and replays the log
   * Later results are judged again: voiding the winning capture reopens the game,
   * and results that were `game_over` count now
   * @param {string} attemptId
   */
  void(attemptId) {
    const entry = this.#find(attemptId);
    if (!entry) {
      throw new RangeError(`unknown attempt ${attemptId}`);
    }
    if (entry.voided) {
      throw new RangeError(`attempt ${attemptId} is already void`);
    }
    entry.voided = true;
    this.#replay();
  }

  /** @param {string} attemptId */
  #find(attemptId) {
    for (const entry of this.log) {
      if (entry.kind === "result" && entry.submission.attemptId === attemptId) {
        return entry;
      }
    }
    return undefined;
  }

  /** @param {number} atMs */
  #moveClock(atMs) {
    if (!Number.isFinite(atMs) || atMs < this.now) {
      throw new RangeError(`time went backwards: ${atMs} after ${this.now}`);
    }
    this.now = atMs;
  }

  #replay() {
    this.#reset();
    for (const entry of this.log) {
      if (entry.kind === "host_end") {
        this.#checkClock(entry.atMs);
        if (!this.#ending) {
          this.#end(null, "host_ended", entry.atMs);
        }
      } else if (entry.voided) {
        entry.verdict = null;
      } else {
        this.#checkClock(entry.submission.atMs);
        entry.verdict = this.#ending ? "game_over" : this.#apply(entry.submission);
      }
    }
    this.#checkClock(this.now);
  }

  /**
   * What a finish in `timeMs` on `tile` would do for `team`
   * @param {Team} team
   * @param {TileId} tile
   * @param {number} timeMs
   * @returns {Verdict}
   */
  #judge(team, tile, timeMs) {
    const holder = this.#board[tileIndex(tile)];
    if (!holder) {
      return "captured";
    }
    if (holder.team === team ? !this.settings.redoOwnTile : this.settings.lockout) {
      return "locked";
    }
    // Strictly faster only: on a tie, whoever set the time first keeps the tile
    if (timeMs >= holder.timeMs) {
      return "not_faster";
    }
    return holder.team === team ? "improved" : "stolen";
  }

  /**
   * @param {Submission} s
   * @returns {Verdict}
   */
  #apply(s) {
    const verdict = this.#judge(s.team, s.tile, s.timeMs);
    if (verdict === "locked" || verdict === "not_faster") {
      return verdict;
    }

    this.#board[tileIndex(s.tile)] = { team: s.team, player: s.player, timeMs: s.timeMs, attemptId: s.attemptId };
    if (verdict === "stolen") {
      this.#steals[s.team]++;
    }
    const counts = this.tileCounts();
    for (const team of TEAMS) {
      if (!this.#firstReached[team].has(counts[team])) {
        this.#firstReached[team].set(counts[team], s.atMs);
      }
    }

    // Only the team that just took a tile can have completed a line
    const line = LINES.find((l) => l.every((t) => this.#board[tileIndex(t)]?.team === s.team));
    if (line) {
      this.#end(s.team, "line", s.atMs, null, [...line]);
    } else if (this.#suddenDeath && counts.red !== counts.blue) {
      this.#end(s.team, "sudden_death", s.atMs);
    }
    return verdict;
  }

  /**
   * Ends the game if the clock says so. Results at or after the end don't count
   * @param {number} atMs
   */
  #checkClock(atMs) {
    const { timeLimitMs, suddenDeathMs } = this.settings;
    if (this.#ending || timeLimitMs === null || atMs < timeLimitMs) {
      return;
    }

    if (!this.#suddenDeath) {
      const counts = this.tileCounts();
      if (counts.red !== counts.blue) {
        this.#end(counts.red > counts.blue ? "red" : "blue", "most_tiles", timeLimitMs);
        return;
      }
      if (suddenDeathMs === null) {
        this.#breakTie(timeLimitMs);
        return;
      }
      this.#suddenDeath = true;
    }

    const end = timeLimitMs + /** @type {number} */ (suddenDeathMs);
    if (atMs >= end) {
      this.#breakTie(end);
    }
  }

  /**
   * The tiles are even: the tiebreakers in order, then a draw
   * @param {number} atMs
   */
  #breakTie(atMs) {
    for (const tiebreaker of this.settings.tiebreakers) {
      const winner = this.#tiebreakWinner(tiebreaker);
      if (winner) {
        this.#end(winner, "tiebreaker", atMs, tiebreaker);
        return;
      }
    }
    this.#end(null, "draw", atMs);
  }

  /**
   * @param {Tiebreaker} tiebreaker
   * @returns {Team | null}
   */
  #tiebreakWinner(tiebreaker) {
    /**
     * The team with the bigger value, or null when even
     * @param {(team: Team) => number} value
     */
    const higher = (value) => {
      const red = value("red");
      const blue = value("blue");
      return red === blue ? null : red > blue ? "red" : "blue";
    };

    switch (tiebreaker) {
      case "total_time":
        return higher((team) =>
          this.#board.reduce((sum, h) => (h?.team === team ? sum + h.timeMs : sum), 0),
        );
      case "steals":
        return higher((team) => this.#steals[team]);
      case "first_to_final_score": {
        // Tiles are even here, so both teams have the same final count
        const count = this.tileCounts().red;
        const first = higher((team) => this.#firstReached[team].get(count) ?? Infinity);
        return first && otherTeam(first);
      }
      case "fewest_players": {
        const most = higher((team) => this.teamStats[team].players);
        return most && otherTeam(most);
      }
      case "most_handicaps":
        return higher((team) => this.teamStats[team].handicaps);
    }
  }

  /**
   * @param {Team | null} winner
   * @param {EndReason} reason
   * @param {number} atMs
   * @param {Tiebreaker | null} [tiebreaker]
   * @param {TileId[] | null} [line]
   */
  #end(winner, reason, atMs, tiebreaker = null, line = null) {
    this.#ending = Object.freeze({ winner, reason, tiebreaker, line, atMs });
  }
}
