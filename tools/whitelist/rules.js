// Turns the whitelist rows into rulesets
//
// The sheet's colors say what's allowed: green is allowed, red is banned
// (a cvar with a default value has to stay at it) and yellow depends on the category,
// with a note saying how

import { emptyRuleset } from "../../src/protocol/segment.js";

/**
 * @typedef {import("./ods.js").Cell} Cell
 * @typedef {import("../../src/protocol/segment.js").Ruleset} Ruleset
 * @typedef {import("../../src/protocol/segment.js").CvarRule} CvarRule
 */

export const GREEN = "#b6d7a8";
export const RED = "#ea9999";
export const YELLOW = "#ffd966";

/**
 * What a row allows
 * `not_in_scripts`: allowed, but not as part of a script (e.g. `+forward`)
 * `other_category`: only for categories and builds bingo doesn't play (thirdperson, +duck%, jumpless, Steam)
 * @typedef {"allowed" | "banned" | "scripted_only" | "not_in_scripts" | "other_category"} Status
 */

/**
 * @typedef {object} Output
 * @property {Ruleset} scriptless
 * @property {Ruleset} scripted
 * @property {string[]} skipped Rows that couldn't be turned into a rule, to check by hand
 */

/**
 * @param {Cell[][]} rows
 * @returns {Output}
 */
export function build(rows) {
  /** @type {Output} */
  const out = { scriptless: emptyRuleset(false), scripted: emptyRuleset(true), skipped: [] };

  /** @type {"cvars" | "skill_cvars" | "commands" | null} */
  let section = null;
  for (const row of rows) {
    const text = (/** @type {number} */ i) => (row[i]?.text ?? "").trim();
    const name = text(0);
    const color = row[0]?.color ?? "";

    // Header rows name the section, e.g. "Key cvars" or "Remaning commands"
    const header = name.toLowerCase();
    if (header.endsWith(" cvars") && !header.startsWith("all ")) {
      section = header.startsWith("skill") ? "skill_cvars" : "cvars";
      continue;
    }
    if (header.endsWith(" commands") && !header.startsWith("all ")) {
      section = "commands";
      continue;
    }

    const notes = `${text(1)} ${text(2)}`.toUpperCase();
    /** @type {Status} */
    let status;
    if (color === GREEN) {
      status = "allowed";
    } else if (color === RED) {
      status = "banned";
    } else if (color === YELLOW) {
      if (notes.includes("ONLY ALLOWED IN SCRIPTED")) {
        status = "scripted_only";
      } else if (notes.includes("BANNED IN SCRIPTED SEQUENCES")) {
        status = "not_in_scripts";
      } else {
        status = "other_category";
      }
    } else {
      out.skipped.push(`${name}: unknown color ${JSON.stringify(color)}`);
      continue;
    }

    if (section === "cvars") {
      addCvar(out, name, text(1), status);
    } else if (section === "skill_cvars") {
      addSkillCvar(out, name, status);
    } else if (section === "commands") {
      addCommand(out, name, text(1), text(2), status);
    } else {
      out.skipped.push(`${name}: before any section`);
    }
  }

  if (out.scriptless.commands.allowed.length === 0 || out.scriptless.cvars.length === 0) {
    throw new Error("no rules found, is this the whitelist sheet?");
  }
  return out;
}

/**
 * The WON value of a default like "30 WON 60 steam", or the plain value
 * @param {string} value
 * @returns {string | null}
 */
function wonDefault(value) {
  const words = value.split(/\s+/).filter(Boolean);
  const i = words.findIndex((w) => w.toLowerCase() === "won");
  if (i >= 0) {
    return i > 0 ? words[i - 1] : null;
  }
  return value === "" ? null : value;
}

/** @param {string} name */
const isBxtCvar = (name) => name.startsWith("bxt_") || name.startsWith("_bxt_");

/**
 * Cvars whose value in the sheet is wrong, with the right one (null for no value)
 * @type {Record<string, string | null>}
 */
const SHEET_FIXES = {
  // Both only matter in multiplayer: `ip` defaults to localhost, not 1,
  // and `mp_teamlist` is hgrunt;scientist or empty depending on the build, not 0
  ip: null,
  mp_teamlist: null,
  // With these off the player's own splits can't start or stop BXT's timer, which bingo drives
  bxt_splits_start_timer_on_first_split: "0",
  bxt_splits_end_on_last_split: "0",
};

/**
 * The WON value the sheet gives a cvar, after the fixes above
 * @param {string} name
 * @param {string} value
 */
function sheetValue(name, value) {
  return Object.hasOwn(SHEET_FIXES, name) ? SHEET_FIXES[name] : wonDefault(value);
}

/**
 * The rule that keeps a banned cvar where it should be
 * `off` is for cvars that turn on something the run can't use (e.g. bxt_autojump in scriptless),
 * which have to stay at BXT's default instead of whatever the player had
 * @param {Output} out
 * @param {string} name
 * @param {string} value
 * @param {boolean} off
 * @returns {CvarRule | null}
 */
function bannedCvar(out, name, value, off) {
  // "ALL bxt_tas_ cvars" and the like
  if (name.startsWith("ALL ")) {
    const prefix = name.slice(4).split(/\s+/).filter(Boolean)[0] ?? "";
    if (isBxtCvar(prefix)) {
      return { name: `${prefix}*`, op: "default" };
    }
    out.skipped.push(`cvar ${name}: banned, but only BXT cvars can be banned by prefix`);
    return null;
  }

  const fixed = sheetValue(name, value);
  if (fixed !== null) {
    return { name, op: "eq", value: fixed };
  }
  // With no value in the sheet, the player keeps theirs but can't change it during the run
  return { name, op: off && isBxtCvar(name) ? "default" : "unchanged" };
}

/**
 * The skill cvars come from `skill.cfg`, so there's no default in the sheet to compare with
 * @param {Output} out
 * @param {string} name
 * @param {Status} status
 */
function addSkillCvar(out, name, status) {
  if (!name.startsWith("sk_")) {
    out.skipped.push(`cvar ${name}: in the skill cvars, but not sk_`);
    return;
  }
  if (status !== "banned") {
    out.skipped.push(`cvar ${name}: a skill cvar that isn't banned`);
    return;
  }
  for (const ruleset of [out.scriptless, out.scripted]) {
    if (!ruleset.cvars.some((r) => r.name === "sk_*" && r.op === "unchanged")) {
      ruleset.cvars.push({ name: "sk_*", op: "unchanged" });
    }
  }
}

/**
 * Cvars bingo allows whatever the sheet says
 * The HUD only shows information, so every bxt_hud_ cvar is safe to change
 */
const ALWAYS_ALLOWED_CVAR_PREFIXES = ["bxt_hud_"];

/**
 * Cvars the game changes by itself during a run, so a rule would cancel runs for nothing
 * v_dark: maps that start dark set it to 1 for the fade-in (e.g. Interloper), and it only fades the screen
 */
const ALWAYS_ALLOWED_CVARS = ["v_dark"];

/**
 * @param {Output} out
 * @param {string} name
 * @param {string} value
 * @param {Status} status
 */
function addCvar(out, name, value, status) {
  if (ALWAYS_ALLOWED_CVAR_PREFIXES.some((prefix) => name.startsWith(prefix)) || ALWAYS_ALLOWED_CVARS.includes(name)) {
    return;
  }

  if (status === "banned" || status === "other_category") {
    const rule = bannedCvar(out, name, value, status === "other_category");
    if (rule) {
      out.scriptless.cvars.push(rule);
      out.scripted.cvars.push({ ...rule });
    }
  } else if (status === "scripted_only") {
    const rule = bannedCvar(out, name, value, true);
    if (rule) {
      out.scriptless.cvars.push(rule);
    }
    // Exempts it from a wider rule, like bxt_tas_ducktap_priority from bxt_tas_*
    out.scripted.cvars.push({ name, op: "any" });
  }
}

/**
 * @param {Output} out
 * @param {string} name
 * @param {string} col1
 * @param {string} col2
 * @param {Status} status
 */
function addCommand(out, name, col1, col2, status) {
  // Anything not allowed is banned, e.g. "ALL bxt_tas_ commands"
  if (status === "banned" || status === "other_category") {
    return;
  }

  // Only for binds that start a full-game run (map c1a0, bxt_timer_start, bxt_timer_reset)
  // A bingo run starts on its own and BXT drives the timer, so these aren't allowed
  if (col1.toUpperCase().includes("RUN-START-BIND")) {
    return;
  }

  if (name.includes(" ") && name !== "ALL -commands") {
    out.skipped.push(`command ${name}: not a single command`);
    return;
  }

  /** @type {string[]} */
  let allowed;
  if (name === "ALL -commands") {
    allowed = ["-*"];
  } else if (name === "weapon_") {
    allowed = ["weapon_*"];
  } else {
    // "100 (FLASHLIGHT) | 201 (SPRAY)" limits the argument
    const args = [col1, col2].flatMap((c) => c.split(/\s+/)).filter((w) => /^[0-9]+$/.test(w));
    allowed = args.length === 0 ? [name] : args.map((a) => `${name} ${a}`);
  }

  if (status === "allowed") {
    out.scriptless.commands.allowed.push(...allowed);
    out.scripted.commands.allowed.push(...allowed);
  } else if (status === "scripted_only") {
    out.scripted.commands.allowed.push(...allowed);
  } else if (status === "not_in_scripts") {
    out.scriptless.commands.allowed.push(...allowed);
    out.scripted.commands.not_in_scripts.push(...allowed);
    out.scripted.commands.allowed.push(...allowed);
  }
}
