import assert from "node:assert/strict";
import { test } from "node:test";

import { compareIds, kitPool, parseCfg } from "../tools/catalog/kit.js";

/**
 * A kit cfg with these triggers and load
 * @param {string[]} lines
 */
const cfg = (lines) => ["//Load a placeholder map to draw triggers", "map c1a0", "bxt_triggers_clear", ...lines, "bxt_hud_timer 1", "w 5"].join("\r\n");

/**
 * The segment, or a failed test with why the cfg was skipped
 * @param {ReturnType<typeof parseCfg>} result
 */
function used(result) {
  if ("skip" in result) {
    throw new Error(result.skip);
  }
  return result;
}

const START = ["bxt_triggers_add 1 2 3 4 5 6", 'bxt_triggers_setcommand "bxt_timer_reset;bxt_timer_start"'];
const END = ["bxt_triggers_add -1.5 -2 -3 7 8 9.25", 'bxt_triggers_setcommand "bxt_timer_stop"'];

test("a whole segment and its halves", () => {
  const whole = parseCfg("oar-2-0", cfg([...START, ...END, "load oar2start"]));
  assert.deepEqual(whole, {
    segment: {
      id: "oar-2-0",
      label: "OAR2",
      chapter: "On A Rail",
      save: "oar2start",
      start: { type: "trigger", corners: [[1, 2, 3], [4, 5, 6]] },
      end: { corners: [[-1.5, -2, -3], [7, 8, 9.25]] },
      requirements: [],
    },
    notes: [],
  });
  const half = used(parseCfg("oar-2-2", cfg([...START, ...END, "load oar2half"])));
  assert.equal(half.segment.label, "OAR2.2");
  assert.equal(half.segment.save, "oar2half");
});

test("the end trigger listed first, and a start that deletes triggers", () => {
  const result = used(parseCfg("oar-9-0", cfg([...END, "bxt_triggers_add 1 2 3 4 5 6", 'bxt_triggers_setcommand "bxt_timer_reset;bxt_timer_start;bxt_triggers_delete"', "load oar9start"])));
  assert.deepEqual(result.segment.start, { type: "trigger", corners: [[1, 2, 3], [4, 5, 6]] });
  assert.deepEqual(result.segment.end, { corners: [[-1.5, -2, -3], [7, 8, 9.25]] });
});

test("the timer started by the cfg, Nihilanth, and cfgs that aren't segments", () => {
  const onLoad = used(parseCfg("am-5-2", cfg([...END, "load am5half", "bxt_timer_reset", "w 6", "bxt_timer_start"])));
  assert.deepEqual(onLoad.segment.start, { type: "on_load" });

  const nihi = used(parseCfg("nihi-1-0", cfg([...START, "//bxt_triggers_add ", '//bxt_triggers_setcommand "bxt_timer_stop"', "load nihi1start"])));
  assert.deepEqual(nihi.segment.end, { type: "game_end" });

  assert.deepEqual(parseCfg("am-1-0", cfg([...END, "bxt_timer_start"])), { skip: "loads no save (it starts from the map itself)" });
  assert.deepEqual(parseCfg("buffer", "load practiceBuffer"), { skip: "not a segment" });
  assert.deepEqual(parseCfg("st-1-0", cfg([...START, "load st1start"])), { skip: "nothing stops the timer" });
});

test("triggers without a command are left out with a note", () => {
  const result = used(parseCfg("wgh-1-1", cfg([...START, ...END, "bxt_triggers_add 1 1 1 2 2 2", "load wgh1start"])));
  assert.deepEqual(result.notes, ["1 trigger(s) without a timer command, left out"]);
});

test("a cfg of our own, with its label and chapter in comment lines", () => {
  const own = (/** @type {string[]} */ lines) => cfg([...lines, ...START, ...END, "load std7"]);
  const result = used(parseCfg("07", own(["// bingo label OC3-BP1", "//bingo chapter Office Complex"]), true));
  assert.deepEqual(result.segment, {
    id: "07",
    label: "OC3-BP1",
    chapter: "Office Complex",
    save: "std7",
    start: { type: "trigger", corners: [[1, 2, 3], [4, 5, 6]] },
    end: { corners: [[-1.5, -2, -3], [7, 8, 9.25]] },
    requirements: [],
  });
  assert.deepEqual(result.notes, []);

  // A chapter's prefix works too, and a long label gets a note
  const long = used(parseCfg("08", own(["// bingo label WGH-ALL-OF-IT", "// bingo chapter WGH"]), true));
  assert.equal(long.segment.chapter, "We've Got Hostiles");
  assert.deepEqual(long.notes, ["the label WGH-ALL-OF-IT is longer than 8 characters, the board may cut it short"]);

  assert.deepEqual(parseCfg("07", own(["// bingo chapter oc"]), true), { skip: "it has no // bingo label line" });
  assert.deepEqual(parseCfg("07", own(["// bingo label OC3"]), true), { skip: "it has no // bingo chapter line" });
  assert.deepEqual(parseCfg("07", own(["// bingo label OC3", "// bingo chapter Black Mesa"]), true), {
    skip: "Black Mesa isn't a chapter, use a name like Office Complex or a prefix like oc",
  });
  assert.deepEqual(parseCfg("Std 07", own(["// bingo label OC3", "// bingo chapter oc"]), true), {
    skip: "its name can only have lowercase letters, digits and -",
  });
});

test("a cfg of our own that ends with the game", () => {
  const lines = ["// bingo label INT3-NIHI", "// bingo chapter Interloper", "// bingo end game", ...START, "load std50"];
  assert.deepEqual(used(parseCfg("50", cfg(lines), true)).segment.end, { type: "game_end" });

  // Without the line it needs an end trigger
  assert.deepEqual(parseCfg("50", cfg(lines.filter((l) => !l.includes("end game"))), true), { skip: "nothing stops the timer" });
  assert.deepEqual(parseCfg("50", cfg([...lines, ...END]), true), {
    skip: "it has an end trigger and // bingo end game, it can only have one of them",
  });
  assert.deepEqual(parseCfg("50", cfg([...lines.slice(0, 2), "// bingo end later", ...START, "load std50"]), true), {
    skip: '// bingo end can only be "game", not later',
  });
});

test("requirements, from // bingo require lines", () => {
  const lines = [
    "// bingo label OC3",
    "// bingo chapter oc",
    "// bingo require Go through the lab",
    "bxt_triggers_add 10 20 30 40 50 60",
    'bxt_triggers_setcommand "echo Lab done"',
    ...START,
    "//bingo require 50 HP or more at the end | health 50",
    "// bingo require Some armor | armor 1",
    "// bingo require Have the crossbow | weapon weapon_crossbow",
    ...END,
    "load std7",
  ];
  const result = used(parseCfg("07", cfg(lines), true));
  assert.deepEqual(result.segment.requirements, [
    { type: "area", text: "Go through the lab", corners: [[10, 20, 30], [40, 50, 60]] },
    { type: "health", text: "50 HP or more at the end", min: 50 },
    { type: "armor", text: "Some armor", min: 1 },
    { type: "weapon", text: "Have the crossbow", weapon: "weapon_crossbow" },
  ]);
  // The area's trigger isn't the start or end, and isn't left out with a note
  assert.deepEqual(result.segment.start, { type: "trigger", corners: [[1, 2, 3], [4, 5, 6]] });
  assert.deepEqual(result.notes, []);

  const head = ["// bingo label OC3", "// bingo chapter oc"];
  const skip = (/** @type {string[]} */ more) => parseCfg("07", cfg([...head, ...more, ...START, ...END, "load std7"]), true);
  assert.deepEqual(parseCfg("07", cfg([...head, ...START, ...END, "load std7", "// bingo require Go through the lab"]), true), {
    skip: "// bingo require Go through the lab has no bxt_triggers_add after it",
  });
  assert.deepEqual(skip(["// bingo require | health 5"]), { skip: "a // bingo require line without a text: // bingo require | health 5" });
  assert.deepEqual(skip(["// bingo require Healthy | health lots"]), { skip: "// bingo require Healthy: health needs a whole number above 0" });
  assert.deepEqual(skip(["// bingo require Armed | weapon crossbow"]), { skip: "// bingo require Armed: weapon needs a weapon's name like weapon_crossbow" });
  assert.deepEqual(skip(["// bingo require Press it | fired o2"]), {
    skip: "// bingo require Press it: unknown kind fired, use area, health <number>, armor <number> or weapon <weapon_name>",
  });
  assert.deepEqual(skip(["// bingo require Lab", "bxt_triggers_add 1 1 1 2 2 2", 'bxt_triggers_setcommand "bxt_timer_stop"']), {
    skip: "the trigger of // bingo require Lab also starts or stops the timer",
  });
});

test("whole maps and sections go in their own pools", () => {
  assert.equal(kitPool("oar-2-0"), "hl1-maps");
  assert.equal(kitPool("am-10-0"), "hl1-maps");
  assert.equal(kitPool("oar-2-1"), "hl1-micro");
  assert.equal(kitPool("oar-2-2"), "hl1-micro");
});

test("the kit's order", () => {
  const ids = ["uc-1-0", "am-10-0", "am-2-1", "am-2-0", "nihi-1-0"];
  assert.deepEqual(ids.sort(compareIds), ["am-2-0", "am-2-1", "am-10-0", "uc-1-0", "nihi-1-0"]);
});
