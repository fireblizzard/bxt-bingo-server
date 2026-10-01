import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { checkDemo } from "../src/demo/check.js";
import { parseDemo } from "../src/demo/parse.js";
import { RUNTIME_HEADER, decodeRuntimeData, encodeRuntimeData } from "../src/demo/runtime.js";

const scriptless = JSON.parse(readFileSync(new URL("../rules/won-scriptless.json", import.meta.url), "utf8"));

const ATTEMPT = "00000000-0000-4000-8000-000000000001";
const NONCE = "ab".repeat(16);

test("runtime data written by BXT's own code", () => {
  // Made by runtime_data.cpp's writer (encrypt, escape, 64-byte commands), one command per line in hex
  const lines = readFileSync(new URL("fixtures/bxt-runtime-data.txt", import.meta.url), "utf8").trim().split("\n");
  const bytes = lines.flatMap((line) => [...Buffer.from(line, "hex").subarray(RUNTIME_HEADER.length)]);
  assert.deepEqual(decodeRuntimeData(new Uint8Array(bytes)), [
    { type: "bingo_info", info: { event: "start", attempt_id: 'a"b;c' } },
    { type: "player_health", health: 100 },
    { type: "cvar_values", values: { sv_gravity: "800" } },
    { type: "bound_command", command: "+jump;wait" },
    { type: "version_info", build_number: 3248, bxt_version: "abc" },
    { type: "time", hours: 1, minutes: 2, seconds: 3, remainder: 0.5 },
    { type: "loaded_modules", filenames: ["hl.exe", "bxt.dll"] },
  ]);
});

/** Movevars as the default rules want them */
const MOVEVARS = [800, 100, 320, 500, 10, 10, 10, 4, 2, 1, 1, 1, 18, 2000, 4096, 0];

/**
 * A demo file with one playback segment
 * @param {({ view: { frametime?: number, origin?: number[], health?: number, gravity?: number } } | { runtime: any[] })[]} frames
 */
function makeDemo(frames) {
  /** @type {number[]} */
  const out = [];
  const u8 = (/** @type {number} */ v) => out.push(v & 0xff);
  const i32 = (/** @type {number} */ v) => {
    const b = Buffer.alloc(4);
    b.writeInt32LE(v);
    out.push(...b);
  };
  const f32 = (/** @type {number} */ v) => {
    const b = Buffer.alloc(4);
    b.writeFloatLE(v);
    out.push(...b);
  };
  const text = (/** @type {string} */ s, /** @type {number} */ size) => {
    const b = Buffer.alloc(size);
    b.write(s, "latin1");
    out.push(...b);
  };
  text("HLDEMO", 8);
  i32(5);
  i32(46);
  text("c1a0", 260);
  text("valve", 260);
  i32(0);
  const directoryAt = out.length;
  i32(0);
  const start = out.length;
  let time = 0;
  for (const frame of frames) {
    if ("runtime" in frame) {
      for (const command of encodeRuntimeData(frame.runtime)) {
        u8(3);
        f32(time);
        i32(0);
        text(command, 64);
      }
      continue;
    }
    const { frametime = 0.01, origin = [0, 0, 0], health = 100, gravity = 800 } = frame.view;
    time += frametime;
    u8(1);
    f32(time);
    i32(0);
    // demo_info: timestamp, then ref_params with frametime, paused, simorg and health where BXT reads them
    f32(time);
    const ref = new Array(58).fill(0);
    for (let i = 0; i < 58; i++) {
      if (i === 15) f32(frametime);
      else if (i === 25 || i === 26 || i === 27) f32(origin[i - 25]);
      else if (i === 35) i32(health);
      else f32(ref[i]);
    }
    for (let i = 0; i < 52; i++) u8(0);
    MOVEVARS.forEach((v, i) => f32(i === 0 ? gravity : v));
    i32(0);
    text("", 32);
    for (let i = 0; i < 8; i++) f32(0);
    for (let i = 0; i < 4; i++) f32(0);
    for (let i = 0; i < 7; i++) i32(0);
    i32(0);
  }
  u8(5);
  f32(time);
  i32(0);
  const length = out.length - start;
  const directory = out.length;
  i32(1);
  i32(1);
  text("Playback", 64);
  i32(0);
  i32(0);
  f32(time);
  i32(frames.length);
  i32(start);
  i32(length);
  const bytes = Buffer.from(out);
  bytes.writeInt32LE(directory, directoryAt);
  return new Uint8Array(bytes);
}

const segment = {
  start: /** @type {const} */ ({ type: "trigger", corners: [[0, 0, 0], [10, 10, 10]] }),
  end: { corners: /** @type {[[number, number, number], [number, number, number]]} */ ([[1000, 0, 0], [1010, 10, 10]]) },
};

/**
 * A 1 s run from the start trigger to the end trigger
 * @param {{ nonce?: string, gravity?: number, endAt?: number[], timeMs?: number, hurt?: boolean }} [change]
 */
function runDemo(change = {}) {
  /** @type {any[]} */
  const frames = [{ view: { origin: [5, 5, 5] } }, { runtime: [{ type: "bingo_info", info: { event: "start", attempt_id: ATTEMPT, utc: "2026-10-01T12:00:00Z" } }] }];
  // The nonce comes a few frames later, when the server's answer arrives
  frames.push({ view: { origin: [6, 5, 5], frametime: 0, gravity: change.gravity } });
  frames.push({ runtime: [{ type: "bingo_info", info: { event: "nonce", attempt_id: ATTEMPT, nonce: change.nonce ?? NONCE } }] });
  for (let i = 1; i <= 100; i++) {
    frames.push({ view: { origin: i === 100 ? change.endAt ?? [1005, 5, 5] : [i * 10, 5, 5], gravity: change.gravity, health: change.hurt && i > 50 ? 90 : 100 } });
  }
  frames.push({ runtime: [{ type: "bingo_info", info: { event: "finish", attempt_id: ATTEMPT, time_ms: change.timeMs ?? 1000 } }] });
  return parseDemo(makeDemo(frames));
}

/** @param {Partial<import("../src/demo/check.js").Expectation>} [change] */
const expect = (change = {}) => ({
  attemptId: ATTEMPT,
  nonce: NONCE,
  timeMs: 1000,
  dllSha256: null,
  ruleset: { ...scriptless, no_damage: true },
  ...segment,
  ...change,
});

test("a demo is read frame by frame", () => {
  const demo = runDemo();
  assert.equal(demo.mapName, "c1a0");
  assert.equal(demo.gameDir, "valve");
  const views = demo.frames.filter((f) => f.kind === "view");
  assert.equal(views.length, 102);
  assert.deepEqual(views[0].kind === "view" && views[0].origin, [5, 5, 5]);
  assert.equal(views[0].kind === "view" && views[0].movevars.sv_gravity, 800);
  const runtime = demo.frames.filter((f) => f.kind === "runtime");
  assert.equal(runtime.length, 3);
  assert.throws(() => parseDemo(new TextEncoder().encode("fake demo")), /not a Half-Life demo/);
});

test("a clean run has no flags", () => {
  const result = checkDemo([runDemo()], expect());
  assert.deepEqual(result.flags, []);
  assert.equal(result.summary.frames, 101);
  assert.equal(result.summary.started_utc, "2026-10-01T12:00:00Z");
});

test("what the checks catch", () => {
  const flags = (/** @type {Parameters<typeof runDemo>[0]} */ change, /** @type {any} */ expected = {}) => checkDemo([runDemo(change)], expect(expected)).flags;
  assert.match(flags({ nonce: "cd".repeat(16) }).join(), /nonce/);
  assert.match(flags({ gravity: 400 }).join(), /sv_gravity was 400 during the run, it must be 800/);
  assert.match(flags({}, { timeMs: 3000 }).join(), /reported|add up to 1 s for a 3 s run/);
  assert.match(flags({ endAt: [500, 5, 5] }).join(), /away from the end trigger/);
  assert.match(flags({ hurt: true }).join(), /health went from 100 to 90/);
  assert.match(flags({}, { attemptId: "00000000-0000-4000-8000-000000000002" }).join(), /doesn't have the start of this run/);
  // A handicap's gravity is the one the rules want then
  const jupiter = { ...scriptless, cvars: [...scriptless.cvars.filter((/** @type {any} */ r) => r.name !== "sv_gravity"), { name: "sv_gravity", op: "set", value: "2021.61" }] };
  assert.deepEqual(flags({ gravity: 2021.61 }, { ruleset: jupiter }), []);
});
