import assert from "node:assert/strict";
import { test } from "node:test";

import { GREEN, RED, YELLOW, build } from "../tools/whitelist/rules.js";
import { tokenize } from "../tools/whitelist/xml.js";

/**
 * @param {string} color
 * @param {string[]} cells
 */
const row = (color, cells) => cells.map((text) => ({ text, color }));

/**
 * @param {import("../src/protocol/segment.js").Ruleset} ruleset
 * @param {string} name
 */
const cvar = (ruleset, name) => ruleset.cvars.find((r) => r.name === name);

function sheet() {
  return [
    row("#000000", ["Key cvars", "Default value"]),
    row(RED, ["ALL bxt_tas_ cvars", "", "BESIDES ducktap_priority"]),
    row(YELLOW, ["bxt_tas_ducktap_priority", "", "ONLY ALLOWED IN SCRIPTED"]),
    row(RED, ["sv_gravity", "800"]),
    row(RED, ["cl_cmdrate", "30 WON 60 steam"]),
    row(RED, ["ip", "1"]),
    row(RED, ["bxt_splits_end_on_last_split"]),
    row(RED, ["bxt_show_bullets"]),
    row(YELLOW, ["bxt_autojump", "", "ONLY ALLOWED IN SCRIPTED"]),
    row(YELLOW, ["bxt_force_duck", "", "ONLY ALLOWED IN +DUCK% CATEGORY EXTENSION"]),
    row(RED, ["bxt_hud_origin", "0"]),
    row(RED, ["bxt_hud_origin_anchor"]),
    row(RED, ["hostname"]),
    row(RED, ["v_dark", "0"]),
    row(GREEN, ["fps_max"]),
    row(YELLOW, ["fps_override", "0", "ONLY ALLOWED ON STEAM VERSION"]),
    row("#000000", ["Key commands"]),
    row(GREEN, ["ALL -commands"]),
    row(YELLOW, ["+bxt_tas_autojump", "ONLY ALLOWED IN SCRIPTED"]),
    row(YELLOW, ["+forward", "BANNED IN SCRIPTED SEQUENCES"]),
    row(GREEN, ["impulse", "100 (FLASHLIGHT) | 201 (SPRAY)"]),
    row(GREEN, ["map c1a0", "ONLY ALLOWED FOR RUN-START-BIND"]),
    row(GREEN, ["bxt_timer_start", "ONLY ALLOWED FOR RUN-START-BIND"]),
    row(GREEN, ["weapon_"]),
    row(RED, ["noclip"]),
    row(YELLOW, ["thirdperson", "ONLY ALLOWED IN THIRDPERSON"]),
    row("#000000", ["Skill Cvars"]),
    row(RED, ["sk_12mm_bullet1"]),
    row(RED, ["sk_12mm_bullet2"]),
  ];
}

test("cvars", () => {
  const out = build(sheet());
  const { scriptless: sl, scripted: sc } = out;

  assert.equal(cvar(sl, "bxt_tas_*")?.op, "default");
  assert.equal(cvar(sc, "bxt_tas_*")?.op, "default");
  assert.equal(cvar(sl, "bxt_tas_ducktap_priority")?.op, "default");
  assert.equal(cvar(sc, "bxt_tas_ducktap_priority")?.op, "any");

  assert.equal(cvar(sl, "sv_gravity")?.value, "800");
  assert.equal(cvar(sl, "cl_cmdrate")?.value, "30");
  assert.equal(cvar(sl, "ip")?.op, "unchanged");
  assert.deepEqual(cvar(sl, "bxt_splits_end_on_last_split"), { name: "bxt_splits_end_on_last_split", op: "eq", value: "0" });
  // No value in the sheet, so the player keeps theirs
  assert.equal(cvar(sl, "bxt_show_bullets")?.op, "unchanged");
  // Turns on something the run can't use, so it has to be off
  assert.equal(cvar(sl, "bxt_autojump")?.op, "default");
  assert.equal(cvar(sc, "bxt_autojump")?.op, "any");
  assert.equal(cvar(sc, "bxt_force_duck")?.op, "default");
  assert.equal(cvar(sc, "fps_override")?.value, "0");
  assert.equal(cvar(sl, "fps_max"), undefined);
  assert.ok(!sl.cvars.some((r) => r.name.startsWith("bxt_hud_")));
  assert.equal(cvar(sl, "hostname")?.op, "unchanged");
  assert.equal(cvar(sl, "v_dark"), undefined, "the game changes it by itself");
  assert.equal(cvar(sl, "sk_*")?.op, "unchanged");
  assert.equal(sl.cvars.filter((r) => r.name === "sk_*").length, 1);
  assert.deepEqual(out.skipped, []);
});

test("commands", () => {
  const out = build(sheet());
  const sl = out.scriptless.commands;
  const sc = out.scripted.commands;

  assert.ok(sl.allowed.includes("-*") && sc.allowed.includes("-*"));
  assert.ok(!sl.allowed.includes("+bxt_tas_autojump") && sc.allowed.includes("+bxt_tas_autojump"));
  assert.ok(sl.allowed.includes("+forward") && sc.not_in_scripts.includes("+forward"));
  assert.deepEqual(sl.not_in_scripts, []);
  assert.ok(sl.allowed.includes("impulse 100") && sl.allowed.includes("impulse 201"));
  assert.ok(!sl.allowed.includes("impulse"));
  assert.ok(sl.allowed.includes("weapon_*"));
  assert.ok(!sl.allowed.includes("noclip") && !sc.allowed.includes("noclip"));
  assert.ok(!sc.allowed.includes("thirdperson"));
  assert.ok(!sl.allowed.some((c) => c.startsWith("map")));
  assert.ok(!sl.allowed.includes("bxt_timer_start") && !sc.allowed.includes("bxt_timer_start"));
});

test("flags", () => {
  const out = build(sheet());
  assert.equal(out.scriptless.scripted, false);
  assert.equal(out.scripted.scripted, true);
  assert.equal(out.scriptless.single_segment, false);
  assert.equal(out.scripted.single_segment, false);
});

test("not the whitelist sheet", () => {
  assert.throws(() => build([row(GREEN, ["hello"])]), /no rules found/);
});

test("xml tokenizer", () => {
  const events = [
    ...tokenize('<?xml version="1.0"?><!-- c --><a x="1 &amp; 2" f=\'b>c\'><b/>t&lt;&#65;&#x42;</a>'),
  ];
  assert.deepEqual(events, [
    { kind: "start", name: "a", attrs: new Map([["x", "1 & 2"], ["f", "b>c"]]), empty: false },
    { kind: "start", name: "b", attrs: new Map(), empty: true },
    { kind: "text", text: "t<AB" },
    { kind: "end", name: "a" },
  ]);
});
