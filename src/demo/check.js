// Automatic checks of a run's demo (BINGO.md §5.4): does it show the run BXT reported?
// Anything odd becomes a flag for the host to review, nothing is rejected here
// The runtime data can be edited by someone determined, so this raises the bar rather than proving a run

/**
 * @typedef {import("./parse.js").Demo} Demo
 * @typedef {import("./parse.js").ViewFrame} ViewFrame
 * @typedef {import("../protocol/segment.js").Ruleset} Ruleset
 * @typedef {import("../protocol/segment.js").CvarRule} CvarRule
 * @typedef {import("../protocol/segment.js").StartCondition} StartCondition
 * @typedef {import("../protocol/segment.js").EndCondition} EndCondition
 */

/**
 * @typedef {object} Expectation What the server knows about the run
 * @property {string} attemptId
 * @property {string | null} nonce Sent to BXT at `attempt_started`
 * @property {number} timeMs The reported time
 * @property {string | null} dllSha256 From the player's `hello`
 * @property {Ruleset} ruleset The player's own, with their handicaps
 * @property {StartCondition} start
 * @property {EndCondition} end
 */

/**
 * @typedef {object} DemoCheck
 * @property {string[]} flags Empty when nothing looked wrong
 * @property {object} summary For the review page
 */

// The demo's frames may add up to a bit more or less than BXT's timer
const DURATION_TOLERANCE_MS = 1000;
const DURATION_TOLERANCE_RATIO = 0.05;

// How far from a trigger the player's position may be when it fires: the player's box around
// the origin (16 across, 36 up and down standing), and a frame of movement
const TRIGGER_MARGIN = [16 + 32, 16 + 32, 36 + 32];

// Movevars are floats, so a set value only matches this closely
const FLOAT_EPSILON = 0.01;

/**
 * The rule for a cvar: the longest matching name wins, like in BXT
 * @param {CvarRule[]} rules
 * @param {string} name
 */
function ruleFor(rules, name) {
  /** @type {CvarRule | null} */
  let best = null;
  let length = -1;
  for (const rule of rules) {
    const prefix = rule.name.endsWith("*");
    const base = prefix ? rule.name.slice(0, -1) : rule.name;
    const matches = prefix ? name.toLowerCase().startsWith(base.toLowerCase()) : name.toLowerCase() === base.toLowerCase();
    if (matches && base.length > length) {
      best = rule;
      length = base.length;
    }
  }
  return best;
}

/**
 * Why a value breaks a rule, or null. `default`, `unchanged` and `any` aren't checked here
 * @param {CvarRule} rule
 * @param {string | number} value
 */
function breaks(rule, value) {
  if (rule.value === undefined) {
    return null;
  }
  const a = Number(value);
  const b = Number(rule.value);
  const numbers = String(value).trim() !== "" && Number.isFinite(a) && rule.value.trim() !== "" && Number.isFinite(b);
  switch (rule.op) {
    case "eq":
    case "set":
      if (numbers ? Math.abs(a - b) > FLOAT_EPSILON : String(value) !== rule.value) {
        return `must be ${rule.value}`;
      }
      return null;
    case "ne":
      return (numbers ? Math.abs(a - b) <= FLOAT_EPSILON : String(value) === rule.value) ? `must not be ${rule.value}` : null;
    case "lte":
      return numbers && a > b + FLOAT_EPSILON ? `must be at most ${rule.value}` : null;
    case "gte":
      return numbers && a < b - FLOAT_EPSILON ? `must be at least ${rule.value}` : null;
    default:
      return null;
  }
}

/**
 * Whether a position is at a box, with the margin
 * @param {[number, number, number]} origin
 * @param {[[number, number, number], [number, number, number]]} corners
 */
function atBox(origin, corners) {
  return origin.every((v, i) => {
    const low = Math.min(corners[0][i], corners[1][i]) - TRIGGER_MARGIN[i];
    const high = Math.max(corners[0][i], corners[1][i]) + TRIGGER_MARGIN[i];
    return v >= low && v <= high;
  });
}

/** @param {number} v */
const round = (v) => Math.round(v * 100) / 100;

/**
 * @param {Demo[]} parts The demo's parts, in order (one per load)
 * @param {Expectation} expect
 * @returns {DemoCheck}
 */
export function checkDemo(parts, expect) {
  const flags = [];

  // Every frame of every part, in order
  const frames = parts.flatMap((demo, part) => demo.frames.map((frame) => ({ part, frame })));
  const runtime = frames.flatMap(({ part, frame }, index) => (frame.kind === "runtime" ? [{ part, frame, index }] : []));
  if (runtime.length === 0) {
    flags.push("demo: no BXT runtime data in it (_bxt_save_runtime_data_in_demos must be 1)");
  }
  for (const { part, frame } of runtime) {
    if (frame.error) {
      flags.push(`demo: runtime data in part ${part + 1} can't be read (${frame.error})`);
      break;
    }
  }

  /** @param {string} event */
  const info = (event) => {
    for (const { frame, index } of runtime) {
      for (const entry of frame.entries) {
        if (entry.type === "bingo_info" && entry.info.event === event && entry.info.attempt_id === expect.attemptId) {
          return { info: entry.info, index };
        }
      }
    }
    return null;
  };
  const start = info("start");
  const finish = info("finish");
  const nonces = runtime.flatMap(({ frame }) =>
    frame.entries.flatMap((e) => (e.type === "bingo_info" && e.info.event === "nonce" && e.info.attempt_id === expect.attemptId ? [e.info.nonce] : [])),
  );

  if (!start) {
    flags.push("demo: it doesn't have the start of this run");
  }
  if (!finish) {
    flags.push("demo: it doesn't have the end of this run");
  } else if (Math.abs(finish.info.time_ms - expect.timeMs) > 1) {
    flags.push(`demo: it ends the run at ${finish.info.time_ms} ms, and ${expect.timeMs} ms was reported`);
  }
  if (expect.nonce && !nonces.includes(expect.nonce)) {
    flags.push("demo: it doesn't have the server's nonce for this run, it may be from another run");
  }
  if (start && expect.dllSha256 && start.info.bxt_dll_sha256 && start.info.bxt_dll_sha256 !== expect.dllSha256) {
    flags.push("demo: recorded with another BXT build than the one playing");
  }

  // The run: from the start to the end, or the whole demo without them
  const from = start?.index ?? 0;
  const to = finish?.index ?? frames.length;
  const run = frames.slice(from, to);
  const views = run.flatMap(({ part, frame }) => (frame.kind === "view" ? [{ part, frame }] : []));

  // How long the frames of the run add up to, without pauses
  const seconds = views.reduce((sum, { frame }) => sum + (frame.paused ? 0 : Math.max(0, frame.frametime)), 0);
  const allowed = Math.max(DURATION_TOLERANCE_MS, expect.timeMs * DURATION_TOLERANCE_RATIO);
  if (start && finish && Math.abs(seconds * 1000 - expect.timeMs) > allowed) {
    flags.push(`demo: its frames add up to ${round(seconds)} s for a ${round(expect.timeMs / 1000)} s run`);
  }

  // The server's movement cvars, which the client gets every frame
  const cvarRules = expect.ruleset.cvars ?? [];
  const reported = new Set();
  for (const { frame } of views) {
    for (const [name, value] of Object.entries(frame.movevars)) {
      const rule = ruleFor(cvarRules, name);
      const why = rule && !reported.has(name) ? breaks(rule, value) : null;
      if (why) {
        reported.add(name);
        flags.push(`demo: ${name} was ${round(value)} during the run, it ${why}`);
      }
    }
  }

  // The cvars BXT wrote down: the values when the run started, then any change during it
  /** @type {Record<string, string>} */
  const cvars = {};
  /** @type {Record<string, string>} */
  const atStart = {};
  runtime.forEach(({ frame, index }) => {
    for (const entry of frame.entries) {
      if (entry.type !== "cvar_values") {
        continue;
      }
      for (const [name, value] of Object.entries(entry.values)) {
        cvars[name] = value;
        if (index < from) {
          continue;
        }
        if (index > to) {
          return;
        }
        const rule = ruleFor(cvarRules, name);
        const why = rule && !reported.has(name) ? breaks(rule, value) : null;
        if (why) {
          reported.add(name);
          flags.push(`demo: ${name} was ${value} during the run, it ${why}`);
        } else if (rule?.op === "unchanged" && name in atStart && atStart[name] !== value && !reported.has(name)) {
          reported.add(name);
          flags.push(`demo: ${name} changed from ${atStart[name]} to ${value} during the run`);
        }
      }
    }
    if (index <= from) {
      Object.assign(atStart, cvars);
    }
  });
  for (const [name, value] of Object.entries(atStart)) {
    const rule = ruleFor(cvarRules, name);
    const why = rule && !reported.has(name) ? breaks(rule, value) : null;
    if (why) {
      reported.add(name);
      flags.push(`demo: ${name} was ${value} when the run started, it ${why}`);
    }
  }

  // No damage%: health only goes down with damage, loads aside
  if (expect.ruleset.no_damage) {
    for (let i = 1; i < views.length; i++) {
      const [before, after] = [views[i - 1], views[i]];
      if (before.part === after.part && after.frame.health < before.frame.health && after.frame.health > 0) {
        flags.push(`demo: health went from ${before.frame.health} to ${after.frame.health} in a no damage run`);
        break;
      }
    }
  }

  // Where the player was when the timer started and stopped
  /** @param {number} index */
  const originAt = (index) => {
    for (let i = Math.min(index, frames.length - 1); i >= 0; i--) {
      const { frame } = frames[i];
      if (frame.kind === "view") {
        return frame.origin;
      }
    }
    return null;
  };
  if (start && expect.start.type === "trigger") {
    const origin = originAt(start.index);
    if (origin && !atBox(origin, expect.start.corners)) {
      flags.push(`demo: the run started at ${origin.map(round).join(" ")}, away from the start trigger`);
    }
  }
  if (finish && expect.end.type !== "game_end") {
    const origin = originAt(finish.index);
    if (origin && !atBox(origin, expect.end.corners)) {
      flags.push(`demo: the run ended at ${origin.map(round).join(" ")}, away from the end trigger`);
    }
  }

  return {
    flags,
    summary: {
      parts: parts.length,
      maps: parts.map((demo) => demo.mapName),
      frames: views.length,
      seconds: round(seconds),
      started_utc: start?.info.utc ?? null,
      game_id: start?.info.game_id ?? null,
      match_clock_ms: start?.info.match_clock_ms ?? null,
      bxt_version: start?.info.bxt_version ?? null,
    },
  };
}
