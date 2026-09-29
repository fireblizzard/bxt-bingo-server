// Handicaps: named patches to one player's ruleset, for balancing teams (BINGO.md §10.1)
// Assists make a run easier (Autojump), handicaps harder (No damage%)
// "Handicaps" also means both, as in the lobby option and the protocol
// The presets live in rules/handicaps.json

/**
 * @typedef {import("../protocol/segment.js").Ruleset} Ruleset
 */

/**
 * @typedef {object} Handicap
 * @property {string} name Shown in the lobby, in BXT and in results
 * @property {"assist" | "handicap"} kind Assists count against the team in the "most handicaps" tiebreaker
 * @property {string[]} [allow_commands] Added to the allowed commands
 * @property {string[]} [allow_cvars] Cvars that may have any value, exempted from wider rules
 * @property {string[]} [block_commands] Taken out of the allowed commands and dropped by BXT instead
 * @property {boolean} [no_damage] Taking damage after the start trigger invalidates the run
 * @property {boolean} [single_segment] Loading a save or dying cancels the run
 * @property {boolean} [require_kill] The run only counts after killing an enemy monster
 * @property {Record<string, string>} [set_cvars] Server cvars BXT sets for the player, e.g. `sv_gravity`
 */

/**
 * The ruleset with the handicaps applied, in order. The input isn't changed
 * @param {Ruleset} ruleset
 * @param {Handicap[]} handicaps
 * @returns {Ruleset}
 */
export function applyHandicaps(ruleset, handicaps) {
  /** @type {Ruleset} */
  const out = structuredClone(ruleset);
  for (const h of handicaps) {
    for (const command of h.allow_commands ?? []) {
      if (!out.commands.allowed.includes(command)) {
        out.commands.allowed.push(command);
      }
    }
    for (const name of h.allow_cvars ?? []) {
      // An exact rule wins over any wider `*` rule, as the longest name wins
      out.cvars = out.cvars.filter((r) => r.name !== name);
      out.cvars.push({ name, op: "any" });
    }
    for (const command of h.block_commands ?? []) {
      out.commands.allowed = out.commands.allowed.filter((c) => c !== command);
      if (!out.commands.blocked.includes(command)) {
        out.commands.blocked.push(command);
      }
    }
    if (h.no_damage) {
      out.no_damage = true;
    }
    if (h.single_segment) {
      out.single_segment = true;
    }
    if (h.require_kill) {
      out.require_kill = true;
    }
    for (const [name, value] of Object.entries(h.set_cvars ?? {})) {
      // Replaces the rule the ruleset had, e.g. sv_gravity eq 800
      out.cvars = out.cvars.filter((r) => r.name !== name);
      out.cvars.push({ name, op: "set", value });
    }
  }
  return out;
}

/**
 * Checks a presets file, e.g. rules/handicaps.json
 * @param {unknown} presets
 * @returns {Record<string, Handicap>}
 */
export function checkHandicapPresets(presets) {
  if (typeof presets !== "object" || presets === null) {
    throw new TypeError("handicap presets must be an object");
  }
  const lists = ["allow_commands", "allow_cvars", "block_commands"];
  const flags = ["no_damage", "single_segment", "require_kill"];
  for (const [id, h] of Object.entries(presets)) {
    if (typeof h?.name !== "string" || h.name === "") {
      throw new TypeError(`handicap ${id}: missing name`);
    }
    for (const key of Object.keys(h)) {
      if (key !== "name" && key !== "kind" && key !== "set_cvars" && !flags.includes(key) && !lists.includes(key)) {
        throw new TypeError(`handicap ${id}: unknown field ${key}`);
      }
    }
    if (h.kind !== "assist" && h.kind !== "handicap") {
      throw new TypeError(`handicap ${id}: kind must be assist or handicap`);
    }
    for (const list of lists) {
      if (h[list] !== undefined && !(Array.isArray(h[list]) && h[list].every((c) => typeof c === "string" && c !== ""))) {
        throw new TypeError(`handicap ${id}: ${list} must be a list of names`);
      }
    }
    for (const flag of flags) {
      if (h[flag] !== undefined && typeof h[flag] !== "boolean") {
        throw new TypeError(`handicap ${id}: ${flag} must be true or false`);
      }
    }
    if (h.set_cvars !== undefined) {
      if (typeof h.set_cvars !== "object" || h.set_cvars === null || Array.isArray(h.set_cvars)) {
        throw new TypeError(`handicap ${id}: set_cvars must be an object`);
      }
      for (const [name, value] of Object.entries(h.set_cvars)) {
        // BXT only sets server cvars, and only to numbers
        if (!/^sv_[a-z0-9_]+$/.test(name) || typeof value !== "string" || !/^-?\d+(\.\d+)?$/.test(value)) {
          throw new TypeError(`handicap ${id}: set_cvars can only set sv_ cvars to numbers, not ${name}`);
        }
      }
    }
  }
  return /** @type {Record<string, Handicap>} */ (presets);
}
