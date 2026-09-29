import assert from "node:assert/strict";
import { test } from "node:test";

import { Game, LINES } from "../src/game/index.js";

const MIN = 60_000;

/** Small harness: numbered attempts, a clock that moves 1 ms per result unless told otherwise */
class T {
  /** @param {import("../src/game/game.js").Settings} [settings] */
  constructor(settings) {
    this.game = new Game(settings);
    this.next = 1;
    this.at = 0;
  }

  /**
   * @param {"red" | "blue"} team
   * @param {string} tile
   * @param {number} timeMs
   * @param {number} [atMs]
   */
  submit(team, tile, timeMs, atMs) {
    this.at = atMs ?? this.at + 1;
    const attemptId = `00000000-0000-4000-8000-${String(this.next++).padStart(12, "0")}`;
    const outcome = this.game.submit({ attemptId, player: `${team}-player`, team, tile, timeMs, atMs: this.at });
    return { attemptId, ...outcome };
  }

  /**
   * @param {"red" | "blue"} team
   * @param {string} tile
   * @param {number} timeMs
   * @param {number} [atMs]
   */
  verdict(team, tile, timeMs, atMs) {
    return this.submit(team, tile, timeMs, atMs).verdict;
  }

  /** @param {string} tile */
  owner(tile) {
    const h = this.game.holder(tile);
    return h && [h.team, h.timeMs];
  }

  get ending() {
    const e = this.game.ending;
    return e && { winner: e.winner, reason: e.reason, tiebreaker: e.tiebreaker, line: e.line };
  }
}

const TIMED = { timeLimitMs: 15 * MIN };

test("the lines", () => {
  assert.equal(LINES.length, 12);
  assert.equal(new Set(LINES.map((l) => l.join())).size, 12);
  assert.deepEqual(LINES[1], ["A2", "B2", "C2", "D2", "E2"]);
  assert.deepEqual(LINES[5], ["A1", "A2", "A3", "A4", "A5"]);
  assert.deepEqual(LINES[10], ["A1", "B2", "C3", "D4", "E5"]);
  assert.deepEqual(LINES[11], ["E1", "D2", "C3", "B4", "A5"]);
});

test("first finish captures", () => {
  const g = new T();
  assert.equal(g.verdict("red", "B3", 12_345), "captured");
  assert.deepEqual(g.owner("B3"), ["red", 12_345]);
  assert.equal(g.owner("B4"), null);
});

test("stealing needs a strictly faster time", () => {
  const g = new T();
  g.verdict("red", "B3", 12_345);
  assert.equal(g.verdict("blue", "B3", 12_346), "not_faster");
  assert.equal(g.verdict("blue", "B3", 12_345), "not_faster", "ties go to the first time");
  assert.deepEqual(g.owner("B3"), ["red", 12_345]);
  assert.equal(g.verdict("blue", "B3", 12_344), "stolen");
  assert.deepEqual(g.owner("B3"), ["blue", 12_344]);
  assert.equal(g.verdict("red", "B3", 12_000), "stolen", "can steal back");
});

test("own tile is locked without redo", () => {
  const g = new T();
  g.verdict("red", "B3", 12_345);
  assert.equal(g.game.isPlayable("red", "B3"), false);
  assert.equal(g.game.isPlayable("blue", "B3"), true);
  assert.equal(g.game.isPlayable("red", "B4"), true);
  assert.equal(g.verdict("red", "B3", 1_000), "locked");
  assert.deepEqual(g.owner("B3"), ["red", 12_345]);

  // Once stolen, the first team can play it again
  g.verdict("blue", "B3", 12_000);
  assert.equal(g.game.isPlayable("red", "B3"), true);
  assert.equal(g.game.isPlayable("blue", "B3"), false);
});

test("own tile can be improved with redo", () => {
  const g = new T({ redoOwnTile: true });
  g.verdict("red", "B3", 12_345);
  assert.equal(g.game.isPlayable("red", "B3"), true);
  assert.equal(g.verdict("red", "B3", 12_345), "not_faster");
  assert.equal(g.verdict("red", "B3", 11_000), "improved");
  assert.deepEqual(g.owner("B3"), ["red", 11_000]);
  assert.equal(g.verdict("blue", "B3", 11_500), "not_faster", "blue has to beat the improved time");
});

test("lockout: a claimed tile can't be stolen", () => {
  const g = new T({ lockout: true, redoOwnTile: true });
  g.verdict("red", "B3", 12_345);
  assert.equal(g.game.isPlayable("blue", "B3"), false);
  assert.equal(g.verdict("blue", "B3", 1_000), "locked");
  assert.deepEqual(g.owner("B3"), ["red", 12_345]);
  assert.equal(g.game.isPlayable("red", "B3"), true, "redo still works for the owner");
  assert.equal(g.verdict("red", "B3", 12_000), "improved");
});

test("every row, column and diagonal wins", () => {
  for (const line of LINES) {
    const g = new T();
    line.forEach((tile, i) => {
      assert.equal(g.ending, null, `won too early on ${line}`);
      const outcome = g.submit("blue", tile, 1_000);
      assert.equal(outcome.verdict, "captured");
      assert.equal(outcome.ending !== null, i === line.length - 1);
    });
    assert.deepEqual(g.ending, { winner: "blue", reason: "line", tiebreaker: null, line: [...line] });
  }
});

test("a mixed line doesn't win until it's stolen", () => {
  const g = new T();
  for (const tile of ["A1", "B1", "C1", "D1"]) {
    g.verdict("red", tile, 1_000);
  }
  g.verdict("blue", "E1", 1_000);
  assert.equal(g.ending, null);
  assert.equal(g.verdict("red", "E1", 999), "stolen");
  assert.deepEqual(g.game.ending?.line, ["A1", "B1", "C1", "D1", "E1"]);
});

test("a stolen tile breaks the other team's line", () => {
  const g = new T();
  for (const tile of ["A1", "B1", "C1", "D1"]) {
    g.verdict("red", tile, 1_000);
  }
  g.verdict("blue", "C1", 900);
  g.verdict("red", "E1", 1_000);
  assert.equal(g.ending, null, "C1 is blue's now");
});

test("nothing counts after the game is over", () => {
  const g = new T();
  for (const tile of ["A1", "A2", "A3", "A4", "A5"]) {
    g.verdict("blue", tile, 1_000);
  }
  assert.notEqual(g.ending, null);
  assert.equal(g.verdict("red", "C3", 1_000), "game_over");
  assert.equal(g.verdict("red", "A1", 1), "game_over");
  assert.equal(g.owner("C3"), null);
  assert.equal(g.game.isPlayable("red", "C3"), false);
});

test("a resent attempt isn't applied twice", () => {
  const g = new T({ redoOwnTile: true });
  const { attemptId, verdict } = g.submit("red", "B3", 12_345);
  assert.equal(verdict, "captured");
  const again = g.game.submit({ attemptId, player: "x", team: "red", tile: "B3", timeMs: 11_000, atMs: 10 });
  assert.deepEqual(again, { verdict: "captured", ending: null, duplicate: true });
  assert.deepEqual(g.owner("B3"), ["red", 12_345]);
});

test("bad input throws", () => {
  const g = new T();
  assert.throws(() => g.submit("red", "B3", 0), RangeError);
  assert.throws(() => g.submit("red", "Z9", 100), RangeError);
  g.submit("red", "B3", 100, 50);
  assert.throws(() => g.submit("red", "B4", 100, 49), /backwards/);
  // @ts-expect-error not a tiebreaker
  assert.throws(() => new Game({ tiebreakers: ["coin_flip"] }), RangeError);
  assert.throws(() => new Game({ tiebreakers: ["steals", "steals"] }), RangeError);
  assert.throws(() => new Game({ timeLimitMs: 0 }), RangeError);
});

test("voiding a steal gives the tile back", () => {
  const g = new T();
  g.verdict("red", "B3", 12_345);
  const steal = g.submit("blue", "B3", 10_000);
  g.game.void(steal.attemptId);
  assert.deepEqual(g.owner("B3"), ["red", 12_345]);
  assert.equal(g.game.verdictOf(steal.attemptId), null);
});

test("voiding a capture judges later results again", () => {
  const g = new T();
  const capture = g.submit("red", "B3", 10_000);
  const slower = g.submit("blue", "B3", 11_000);
  assert.equal(slower.verdict, "not_faster");
  g.game.void(capture.attemptId);
  assert.deepEqual(g.owner("B3"), ["blue", 11_000]);
  assert.equal(g.game.verdictOf(slower.attemptId), "captured");
});

test("voiding the winning capture reopens the game", () => {
  const g = new T();
  for (const tile of ["A1", "A2", "A3", "A4"]) {
    g.verdict("blue", tile, 1_000);
  }
  const winning = g.submit("blue", "A5", 1_000);
  const late = g.submit("red", "C3", 2_000);
  assert.equal(late.verdict, "game_over");
  g.game.void(winning.attemptId);
  assert.equal(g.ending, null);
  assert.equal(g.owner("A5"), null);
  assert.equal(g.game.verdictOf(late.attemptId), "captured", "the late result counts now");
  assert.equal(g.game.isPlayable("blue", "A5"), true);
});

test("void errors, and a voided attempt can't sneak back in", () => {
  const g = new T();
  const { attemptId } = g.submit("red", "B3", 1_000);
  assert.throws(() => g.game.void("00000000-0000-4000-8000-999999999999"), /unknown attempt/);
  g.game.void(attemptId);
  assert.throws(() => g.game.void(attemptId), /already void/);
  const again = g.game.submit({ attemptId, player: "x", team: "red", tile: "B3", timeMs: 1_000, atMs: 10 });
  assert.equal(again.duplicate, true);
  assert.equal(again.verdict, "rejected");
  assert.equal(g.owner("B3"), null);
});

test("time limit: most tiles wins", () => {
  const g = new T(TIMED);
  g.verdict("red", "A1", 1_000);
  g.verdict("red", "B2", 1_000);
  g.verdict("blue", "C3", 1_000);
  assert.equal(g.game.nextDeadlineMs(), 15 * MIN);
  assert.equal(g.game.advance(15 * MIN - 1), null);
  const ending = g.game.advance(15 * MIN);
  assert.equal(ending?.winner, "red");
  assert.equal(ending?.reason, "most_tiles");
  assert.equal(ending?.atMs, 15 * MIN);
  assert.equal(g.game.nextDeadlineMs(), null);
});

test("a result at the time limit is too late, one just before counts", () => {
  const g = new T(TIMED);
  g.verdict("blue", "A1", 1_000);
  assert.equal(g.verdict("red", "B1", 1_000, 15 * MIN - 1), "captured");
  // Nobody called advance(), the result itself finds the time is up
  const late = g.submit("red", "C1", 1_000, 15 * MIN);
  assert.equal(late.verdict, "game_over");
  assert.deepEqual(late.ending, { winner: null, reason: "draw", tiebreaker: null, line: null, atMs: 15 * MIN }, "the call that finds the end reports it");
  assert.equal(g.verdict("red", "D1", 1_000, 16 * MIN), "game_over");
});

test("a line still wins before the time limit", () => {
  const g = new T(TIMED);
  for (const tile of ["A1", "B1", "C1", "D1", "E1"]) {
    g.verdict("red", tile, 1_000);
  }
  assert.equal(g.ending?.reason, "line");
});

test("no time limit: nothing ends on the clock", () => {
  const g = new T();
  g.verdict("red", "A1", 1_000);
  assert.equal(g.game.nextDeadlineMs(), null);
  assert.equal(g.game.advance(10 * 60 * MIN), null);
});

test("sudden death: the first team to get ahead wins", () => {
  const g = new T({ ...TIMED, suddenDeathMs: 10 * MIN, redoOwnTile: true });
  g.verdict("red", "A1", 5_000);
  g.verdict("blue", "B1", 5_000);
  assert.equal(g.game.advance(15 * MIN), null);
  assert.equal(g.game.suddenDeath, true);
  assert.equal(g.game.nextDeadlineMs(), 25 * MIN);

  assert.equal(g.verdict("red", "A1", 4_000, 16 * MIN), "improved");
  assert.equal(g.ending, null, "improving doesn't get a team ahead");
  assert.equal(g.verdict("red", "B1", 4_900, 17 * MIN), "stolen");
  assert.deepEqual(g.ending, { winner: "red", reason: "sudden_death", tiebreaker: null, line: null });
  assert.equal(g.game.suddenDeath, false);
});

test("sudden death runs out into the tiebreakers, then a draw", () => {
  const settings = { ...TIMED, suddenDeathMs: 10 * MIN };
  const g = new T({ ...settings, tiebreakers: ["total_time"] });
  g.verdict("red", "A1", 12_500);
  g.verdict("red", "A2", 8_700);
  g.verdict("blue", "B1", 10_400);
  g.verdict("blue", "B2", 15_600);
  assert.equal(g.game.advance(20 * MIN), null);
  const ending = g.game.advance(25 * MIN);
  assert.deepEqual(g.ending, { winner: "blue", reason: "tiebreaker", tiebreaker: "total_time", line: null });
  assert.equal(ending?.atMs, 25 * MIN);

  const draw = new T(settings);
  draw.game.advance(25 * MIN);
  assert.equal(draw.ending?.reason, "draw");
  assert.equal(draw.ending?.winner, null);
});

test("without sudden death, even tiles go straight to the tiebreakers", () => {
  const g = new T({ ...TIMED, tiebreakers: ["steals"] });
  g.verdict("red", "A1", 5_000);
  g.verdict("blue", "B1", 5_000);
  g.verdict("red", "B1", 4_000);
  g.verdict("blue", "C1", 5_000);
  g.verdict("blue", "D1", 5_000);
  g.game.advance(15 * MIN);
  assert.deepEqual(g.ending, { winner: "red", reason: "tiebreaker", tiebreaker: "steals", line: null });
});

test("tiebreakers are checked in order, and an even one passes to the next", () => {
  const stats = { red: { players: 3, handicaps: 0 }, blue: { players: 2, handicaps: 1 } };
  const g = new T({ ...TIMED, tiebreakers: ["steals", "fewest_players", "most_handicaps"] });
  g.verdict("red", "A1", 5_000);
  g.verdict("blue", "B1", 5_000);
  g.game.advance(15 * MIN, stats);
  assert.equal(g.ending?.tiebreaker, "fewest_players");
  assert.equal(g.ending?.winner, "blue");

  const h = new T({ ...TIMED, tiebreakers: ["most_handicaps", "fewest_players"] });
  h.game.advance(15 * MIN, { red: { players: 2, handicaps: 3 }, blue: { players: 2, handicaps: 1 } });
  assert.equal(h.ending?.tiebreaker, "most_handicaps");
  assert.equal(h.ending?.winner, "red");
});

test("first to the final score, the example in BINGO.md §10.2", () => {
  const g = new T({ ...TIMED, tiebreakers: ["first_to_final_score"] });
  // 8 tiles each in 2x2 blocks, so neither team has a line
  let at = 1_000;
  for (const tile of ["A1", "B1", "C2", "D2", "A3", "B3", "C4", "D4", "E1"]) {
    g.verdict("red", tile, 5_000, at++);
  }
  for (const tile of ["C1", "D1", "A2", "B2", "C3", "D3", "A4", "B4", "E2"]) {
    g.verdict("blue", tile, 5_000, at++);
  }
  // 14:33 red 10, 14:45 red 11, 14:50 blue steals: 10 each
  g.verdict("red", "E3", 5_000, 14 * MIN + 33_000);
  g.verdict("red", "E4", 5_000, 14 * MIN + 45_000);
  assert.equal(g.verdict("blue", "E4", 4_000, 14 * MIN + 50_000), "stolen");
  assert.deepEqual(g.game.tileCounts(), { red: 10, blue: 10 });
  assert.equal(g.ending, null);
  g.game.advance(15 * MIN);
  assert.deepEqual(g.ending, { winner: "red", reason: "tiebreaker", tiebreaker: "first_to_final_score", line: null });
});

test("the host ends the game", () => {
  const g = new T(TIMED);
  g.verdict("red", "A1", 1_000);
  const ending = g.game.endByHost(5 * MIN);
  assert.deepEqual(g.ending, { winner: null, reason: "host_ended", tiebreaker: null, line: null });
  assert.equal(ending?.atMs, 5 * MIN);
  assert.equal(g.verdict("blue", "B1", 1_000, 6 * MIN), "game_over");
  assert.equal(g.game.endByHost(7 * MIN), null, "already over");
});

test("a void replays the clock too", () => {
  // Red won on most tiles, but one of its results is voided after the game: now it's a draw
  const g = new T(TIMED);
  const doubtful = g.submit("red", "A1", 1_000);
  g.verdict("red", "B2", 1_000);
  g.verdict("blue", "C3", 1_000);
  g.game.advance(15 * MIN);
  assert.equal(g.ending?.reason, "most_tiles");
  g.game.void(doubtful.attemptId);
  assert.equal(g.ending?.reason, "draw");
  assert.equal(g.game.ending?.atMs, 15 * MIN);
});

test("a void before the host ended the game keeps the host's ending", () => {
  const g = new T(TIMED);
  const first = g.submit("red", "A1", 1_000);
  g.game.endByHost(5 * MIN);
  g.game.void(first.attemptId);
  assert.equal(g.ending?.reason, "host_ended");
});

test("a game restored from its stored log is the same game", () => {
  const settings = { ...TIMED, suddenDeathMs: 10 * MIN, tiebreakers: /** @type {const} */ (["steals"]) };
  const g = new T({ ...settings, tiebreakers: [...settings.tiebreakers] });
  g.verdict("red", "A1", 5_000);
  const steal = g.submit("blue", "A1", 4_000);
  g.verdict("red", "B1", 5_000);
  g.game.advance(15 * MIN, { red: { players: 2, handicaps: 0 }, blue: { players: 2, handicaps: 0 } });
  assert.equal(g.game.suddenDeath, true);

  const stored = JSON.parse(JSON.stringify({ log: g.game.log, now: g.game.now, teamStats: g.game.teamStats }));
  const restored = Game.restore({ ...settings, tiebreakers: [...settings.tiebreakers] }, stored);
  assert.equal(restored.suddenDeath, true);
  assert.deepEqual(restored.holder("A1"), g.game.holder("A1"));
  assert.equal(restored.verdictOf(steal.attemptId), "stolen");
  assert.equal(restored.nextDeadlineMs(), 25 * MIN);
  restored.advance(25 * MIN);
  assert.equal(restored.ending?.tiebreaker, "steals");
  assert.equal(restored.ending?.winner, "blue");
});
