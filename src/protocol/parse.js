// Strict checks for what BXT sends: anything unexpected is refused, not guessed at

import { isTileId, isUuid } from "./ids.js";
import { MAX_DEMO_PARTS, MAX_MESSAGE_BYTES } from "./messages.js";

/** Longest time any measured interval may have: 24 h */
export const MAX_TIME_MS = 24 * 60 * 60 * 1000;

/** Largest file count in `download_progress` */
const MAX_FILES = 1000;

/** Largest frame count, fits a signed 32-bit int */
const MAX_FRAMES = 2 ** 31 - 1;

/**
 * Checks one field, returns why it's wrong or null
 * @typedef {(value: unknown) => string | null} Check
 */

/**
 * @param {number} min
 * @param {number} max
 * @returns {Check}
 */
const int = (min, max) => (v) =>
  Number.isInteger(v) && /** @type {number} */ (v) >= min && /** @type {number} */ (v) <= max
    ? null
    : `must be a whole number from ${min} to ${max}`;

/**
 * @param {RegExp} pattern
 * @param {string} what
 * @returns {Check}
 */
const text = (pattern, what) => (v) => (typeof v === "string" && pattern.test(v) ? null : `must be ${what}`);

/** @type {Check} */
const bool = (v) => (typeof v === "boolean" ? null : "must be true or false");

/** @type {Check} */
const tile = (v) => (isTileId(v) ? null : "must be a tile, A1 to E5");

/** @type {Check} */
const uuid = (v) => (isUuid(v) ? null : "must be a UUID");

/**
 * A field that may be null or left out, normalized to null
 * @param {Check} check
 * @returns {Check & { optional: true }}
 */
const nullable = (check) => Object.assign((/** @type {unknown} */ v) => (v === null ? null : check(v)), { optional: /** @type {const} */ (true) });

// Printable text without control characters
const label = (/** @type {number} */ max) => text(new RegExp(`^[^\\p{Cc}]{1,${max}}$`, "u"), `text of 1 to ${max} characters`);
const sha256 = text(/^[0-9a-f]{64}$/, "64 lowercase hex digits");
const time = int(0, MAX_TIME_MS);

/** @type {Record<string, Record<string, Check>>} */
const FIELDS = {
  hello: {
    protocol: int(1, 1_000_000),
    bxt_version: label(64),
    engine_build: text(/^[a-z0-9_]{1,16}$/, "a short lowercase name, e.g. won"),
    dll_sha256: nullable(sha256),
    steamid64: nullable(text(/^\d{17}$/, "17 digits")),
  },
  tile_selected: {
    tile: nullable(tile),
  },
  ping: {},
  download_progress: {
    done: int(0, MAX_FILES),
    total: int(0, MAX_FILES),
  },
  ready: {
    manifest_hash: text(/^[0-9A-Za-z_-]{1,128}$/, "a hash"),
  },
  attempt_started: {
    attempt_id: uuid,
    tile,
  },
  attempt_result: {
    attempt_id: uuid,
    tile,
    time_ms: int(1, MAX_TIME_MS),
    server_time_delta_ms: time,
    frames: int(0, MAX_FRAMES),
    real_ms: time,
    load_ms: time,
    save_sha256: sha256,
    ruleset_ok: bool,
    demo: nullable(label(128)),
  },
  attempt_invalidated: {
    attempt_id: uuid,
    tile,
    reason: label(200),
  },
  demo_uploaded: {
    attempt_id: uuid,
    parts: int(1, MAX_DEMO_PARTS),
  },
  demo_unavailable: {
    attempt_id: uuid,
    reason: label(200),
  },
};

/**
 * @typedef {{ ok: true, message: import("./messages.js").ClientMessage } | { ok: false, detail: string }} ParseResult
 */

/**
 * Parses one text message from BXT
 * A wrong message should be answered with `error` code `bad_message` and `detail`
 * @param {string} data
 * @returns {ParseResult}
 */
export function parseClientMessage(data) {
  /** @param {string} detail */
  const bad = (detail) => /** @type {const} */ ({ ok: false, detail });

  if (typeof data !== "string") {
    return bad("messages must be JSON text");
  }
  // Every UTF-16 unit is at most 3 UTF-8 bytes, so short messages skip the encoding
  if (data.length * 3 > MAX_MESSAGE_BYTES && new TextEncoder().encode(data).length > MAX_MESSAGE_BYTES) {
    return bad(`messages must be at most ${MAX_MESSAGE_BYTES} bytes`);
  }

  let value;
  try {
    value = JSON.parse(data);
  } catch {
    return bad("not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return bad("a message must be a JSON object");
  }

  const type = value.type;
  const fields = typeof type === "string" && Object.hasOwn(FIELDS, type) ? FIELDS[type] : undefined;
  if (!fields) {
    return bad(`unknown message type ${JSON.stringify(type)}`);
  }

  /** @type {Record<string, unknown>} */
  const message = { type };
  for (const [name, check] of Object.entries(fields)) {
    const present = Object.hasOwn(value, name);
    if (!present && !("optional" in check)) {
      return bad(`${type}: missing ${name}`);
    }
    const field = present ? value[name] : null;
    const error = check(field);
    if (error) {
      return bad(`${type}: ${name} ${error}`);
    }
    message[name] = field;
  }
  for (const name of Object.keys(value)) {
    if (name !== "type" && !Object.hasOwn(fields, name)) {
      return bad(`${type}: unknown field ${name}`);
    }
  }

  if (type === "download_progress" && /** @type {number} */ (message.done) > /** @type {number} */ (message.total)) {
    return bad("download_progress: done must not be above total");
  }

  return { ok: true, message: /** @type {import("./messages.js").ClientMessage} */ (message) };
}
