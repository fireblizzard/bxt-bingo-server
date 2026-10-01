import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ALL_TILES,
  MAX_MESSAGE_BYTES,
  PING_TEXT,
  TILE_COUNT,
  isColor,
  isTileId,
  normalizeColor,
  otherTeam,
  parseClientMessage,
  tileFromIndex,
  tileIndex,
} from "../src/protocol/index.js";

const ID = "5f0c6a52-5b1e-4d4e-9a3a-0d5b6f1c2e3f";
const HASH = "ab".repeat(32);

/** @param {object} value */
const parse = (value) => parseClientMessage(JSON.stringify(value));

/** @param {object} value */
function ok(value) {
  const result = parse(value);
  assert.ok(result.ok, result.ok ? "" : result.detail);
  return result.message;
}

/**
 * @param {object | string} value
 * @param {RegExp} [detail]
 */
function bad(value, detail) {
  const result = typeof value === "string" ? parseClientMessage(value) : parse(value);
  assert.equal(result.ok, false, `should be refused: ${JSON.stringify(value)}`);
  if (detail && !result.ok) {
    assert.match(result.detail, detail);
  }
}

test("tile ids round trip in row-major order", () => {
  assert.equal(ALL_TILES.length, TILE_COUNT);
  ALL_TILES.forEach((tile, i) => {
    assert.equal(tileIndex(tile), i);
    assert.equal(tileFromIndex(i), tile);
  });
  assert.equal(tileIndex("A1"), 0);
  assert.equal(tileIndex("B3"), 11);
  assert.equal(tileIndex("E5"), 24);
});

test("tile ids refuse garbage", () => {
  for (const s of ["", "A", "A0", "A6", "F1", "AA", "A10", "11", "é1", "e5", null, 3]) {
    assert.equal(isTileId(s), false, `${JSON.stringify(s)} should be refused`);
  }
  assert.throws(() => tileIndex("Z9"), RangeError);
  assert.throws(() => tileFromIndex(25), RangeError);
});

test("teams and colors", () => {
  assert.equal(otherTeam("red"), "blue");
  assert.equal(otherTeam("blue"), "red");
  assert.equal(normalizeColor("#E64B28"), "#e64b28");
  for (const s of ["", "e64b28", "#e64b2", "#e64b281", "#g64b28", "red"]) {
    assert.equal(isColor(s), false, `${s} should be refused`);
  }
});

test("hello, with optional fields left out or null", () => {
  const hello = ok({ type: "hello", protocol: 1, bxt_version: "abc123", engine_build: "won" });
  assert.deepEqual(hello, {
    type: "hello",
    protocol: 1,
    bxt_version: "abc123",
    engine_build: "won",
    dll_sha256: null,
    steamid64: null,
  });
  ok({ type: "hello", protocol: 1, bxt_version: "abc", engine_build: "won", dll_sha256: HASH, steamid64: "76561197960287930" });
  bad({ type: "hello", protocol: 1, bxt_version: "abc", engine_build: "won", steamid64: "123" }, /steamid64/);
  bad({ type: "hello", protocol: 1, bxt_version: "abc", engine_build: "won", session_token: "x" }, /unknown field session_token/);
  bad({ type: "hello", protocol: 1, bxt_version: "a\u0007b", engine_build: "won" }, /bxt_version/);
});

test("attempt messages", () => {
  const result = {
    type: "attempt_result",
    attempt_id: ID,
    tile: "B3",
    time_ms: 12345,
    server_time_delta_ms: 12346,
    frames: 1234,
    real_ms: 12410,
    load_ms: 0,
    save_sha256: HASH,
    ruleset_ok: true,
    demo: null,
  };
  assert.deepEqual(ok(result), result);
  bad({ ...result, time_ms: 0 }, /time_ms/);
  bad({ ...result, time_ms: 12.5 }, /time_ms/);
  bad({ ...result, time_ms: 25 * 3600 * 1000 }, /time_ms/);
  bad({ ...result, tile: "b3" }, /tile/);
  bad({ ...result, attempt_id: "1" }, /attempt_id/);
  bad({ ...result, save_sha256: HASH.toUpperCase() }, /save_sha256/);
  bad({ ...result, invalid_reason: null }, /unknown field/);
  const { frames, ...missing } = result;
  bad(missing, /missing frames/);

  ok({ type: "attempt_started", attempt_id: ID, tile: "E5" });
  ok({ type: "attempt_invalidated", attempt_id: ID, tile: "E5", reason: "host_framerate must be 0" });
  ok({ type: "demo_uploaded", attempt_id: ID, parts: 2 });
  ok({ type: "demo_unavailable", attempt_id: ID, reason: "the demo isn't on the player's PC" });
});

test("small messages", () => {
  assert.deepEqual(ok({ type: "tile_selected", tile: "C4" }), { type: "tile_selected", tile: "C4" });
  assert.deepEqual(ok({ type: "tile_selected", tile: null }), { type: "tile_selected", tile: null });
  assert.equal(parseClientMessage(PING_TEXT).ok, true);
  ok({ type: "download_progress", done: 17, total: 25 });
  bad({ type: "download_progress", done: 26, total: 25 }, /above total/);
  ok({ type: "ready", manifest_hash: "abc123" });
});

test("malformed messages", () => {
  bad("not json", /JSON/);
  bad("[1,2]", /object/);
  bad("null", /object/);
  bad({ cmd: "quit" }, /unknown message type/);
  bad({ type: "exec", cmd: "quit" }, /unknown message type/);
  bad({ type: "constructor" }, /unknown message type/);
  bad({ type: "__proto__" }, /unknown message type/);
  bad({ type: "attempt_invalidated", attempt_id: ID, tile: "A1", reason: "x".repeat(MAX_MESSAGE_BYTES) }, /bytes/);
});
