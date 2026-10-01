// BXT's runtime data in demos (BunnymodXT/runtime_data.cpp): what BXT saw while recording,
// like the cvars, the commands each key ran, the loaded modules, and bingo's own info
//
// BXT writes it as console commands starting with `//BXTD0`, 64 bytes each
// The rest of the command is escaped (no 0, quote, newline or ;), and under that it's
// TEA-encrypted 8-byte blocks of a cereal binary archive: a vector of entries, each a type byte and its fields

import { decryptBlocks, encryptBlocks } from "./tea.js";

export const RUNTIME_HEADER = "//BXTD0";

// Escaped byte -> original byte, from escape_filter
const UNESCAPE = new Map([
  [0x01, 0x00],
  [0x02, 0x22],
  [0x03, 0x0a],
  [0x04, 0x3b],
  [0xff, 0xff],
]);
const ESCAPE = new Map([...UNESCAPE].map(([escaped, original]) => [original, escaped]));
const ESCAPE_BYTE = 0xff;
const FILL_BYTE = 0xfe;

/**
 * @typedef {{ type: "version_info", build_number: number, bxt_version: string }
 *   | { type: "cvar_values", values: Record<string, string> }
 *   | { type: "time", hours: number, minutes: number, seconds: number, remainder: number }
 *   | { type: "bound_command", command: string }
 *   | { type: "alias_expansion", name: string, command: string }
 *   | { type: "script_execution", filename: string, contents: string }
 *   | { type: "command_execution", command: string }
 *   | { type: "game_end_marker" }
 *   | { type: "loaded_modules", filenames: string[] }
 *   | { type: "custom_trigger_command", corner_min: number[], corner_max: number[], command: string }
 *   | { type: "edicts", edicts: number }
 *   | { type: "player_health", health: number }
 *   | { type: "split_marker", corner_min: number[], corner_max: number[], name: string, map_name: string }
 *   | { type: "flags", flags: number }
 *   | { type: "bingo_info", info: any }} RuntimeEntry
 */

/** Reads a cereal binary archive, sizes as uint32 (CEREAL_SIZE_TYPE in runtime_data.cpp) */
class Reader {
  /** @param {Uint8Array} bytes */
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.at = 0;
  }

  /** @param {number} count */
  #need(count) {
    if (this.at + count > this.bytes.byteLength) {
      throw new RangeError("the runtime data ends too early");
    }
  }

  u8() {
    this.#need(1);
    return this.view.getUint8(this.at++);
  }

  u32() {
    this.#need(4);
    const v = this.view.getUint32(this.at, true);
    this.at += 4;
    return v;
  }

  i32() {
    this.#need(4);
    const v = this.view.getInt32(this.at, true);
    this.at += 4;
    return v;
  }

  f32() {
    this.#need(4);
    const v = this.view.getFloat32(this.at, true);
    this.at += 4;
    return v;
  }

  f64() {
    this.#need(8);
    const v = this.view.getFloat64(this.at, true);
    this.at += 8;
    return v;
  }

  string() {
    const length = this.u32();
    this.#need(length);
    const text = new TextDecoder().decode(this.bytes.subarray(this.at, this.at + length));
    this.at += length;
    return text;
  }

  vec3() {
    return [this.f32(), this.f32(), this.f32()];
  }
}

/**
 * One entry, as RuntimeData::load reads it
 * @param {Reader} r
 * @returns {RuntimeEntry}
 */
function readEntry(r) {
  const type = r.u8();
  switch (type) {
    case 1:
      return { type: "version_info", build_number: r.i32(), bxt_version: r.string() };
    case 2: {
      /** @type {Record<string, string>} */
      const values = {};
      for (let i = r.u32(); i > 0; i--) {
        const name = r.string();
        values[name] = r.string();
      }
      return { type: "cvar_values", values };
    }
    case 3:
      return { type: "time", hours: r.u32(), minutes: r.u8(), seconds: r.u8(), remainder: r.f64() };
    case 4:
      return { type: "bound_command", command: r.string() };
    case 5:
      return { type: "alias_expansion", name: r.string(), command: r.string() };
    case 6:
      return { type: "script_execution", filename: r.string(), contents: r.string() };
    case 7:
      return { type: "command_execution", command: r.string() };
    case 8:
      return { type: "game_end_marker" };
    case 9: {
      const filenames = [];
      for (let i = r.u32(); i > 0; i--) {
        filenames.push(r.string());
      }
      return { type: "loaded_modules", filenames };
    }
    case 10:
      return { type: "custom_trigger_command", corner_min: r.vec3(), corner_max: r.vec3(), command: r.string() };
    case 11:
      return { type: "edicts", edicts: r.i32() };
    case 12:
      return { type: "player_health", health: r.i32() };
    case 13:
      return { type: "split_marker", corner_min: r.vec3(), corner_max: r.vec3(), name: r.string(), map_name: r.string() };
    case 14:
      return { type: "flags", flags: r.i32() };
    case 15: {
      const json = r.string();
      let info;
      try {
        info = JSON.parse(json);
      } catch {
        info = { unreadable: json };
      }
      return { type: "bingo_info", info };
    }
    default:
      throw new RangeError(`unknown runtime data type ${type}`);
  }
}

/**
 * The entries in one batch of runtime data: what one frame's `//BXTD0` commands carry,
 * each without its header, joined
 * @param {Uint8Array} escaped
 * @returns {RuntimeEntry[]}
 */
export function decodeRuntimeData(escaped) {
  const bytes = new Uint8Array(escaped.byteLength);
  let length = 0;
  for (let i = 0; i < escaped.byteLength; i++) {
    let b = escaped[i];
    if (b === ESCAPE_BYTE) {
      const original = UNESCAPE.get(escaped[++i]);
      if (original === undefined) {
        throw new RangeError("bad escape in the runtime data");
      }
      b = original;
    }
    bytes[length++] = b;
  }
  // The last block is padded by BXT, so a cut one can't be read
  const blocks = bytes.subarray(0, length - (length % 8));
  decryptBlocks(blocks);

  // Usually one archive, but a frame can have more than one, each padded to whole blocks
  const r = new Reader(blocks);
  const entries = [];
  while (r.at + 4 <= blocks.byteLength) {
    for (let count = r.u32(); count > 0; count--) {
      entries.push(readEntry(r));
    }
    r.at = Math.ceil(r.at / 8) * 8;
  }
  return entries;
}

// For tests: runtime data the way BXT writes it

/** Writes a cereal binary archive */
class Writer {
  /** @type {number[]} */
  bytes = [];

  /** @param {number} v */
  u8(v) {
    this.bytes.push(v & 0xff);
  }

  /** @param {number} v */
  u32(v) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v, true);
    this.bytes.push(...b);
  }

  /** @param {number} v */
  i32(v) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, v, true);
    this.bytes.push(...b);
  }

  /** @param {string} text */
  string(text) {
    const b = new TextEncoder().encode(text);
    this.u32(b.byteLength);
    this.bytes.push(...b);
  }
}

/**
 * The `//BXTD0` console commands BXT stores for these entries (only the types bingo's tests need)
 * @param {RuntimeEntry[]} entries
 * @returns {string[]} Latin-1 strings of at most 63 characters
 */
export function encodeRuntimeData(entries) {
  const w = new Writer();
  w.u32(entries.length);
  for (const e of entries) {
    switch (e.type) {
      case "cvar_values":
        w.u8(2);
        w.u32(Object.keys(e.values).length);
        for (const [name, value] of Object.entries(e.values)) {
          w.string(name);
          w.string(value);
        }
        break;
      case "bound_command":
        w.u8(4);
        w.string(e.command);
        break;
      case "player_health":
        w.u8(12);
        w.i32(e.health);
        break;
      case "bingo_info":
        w.u8(15);
        w.string(JSON.stringify(e.info));
        break;
      default:
        throw new RangeError(`the test encoder doesn't write ${e.type}`);
    }
  }
  const blocks = new Uint8Array(Math.ceil(w.bytes.length / 8) * 8).fill(FILL_BYTE);
  blocks.set(w.bytes);
  encryptBlocks(blocks);

  /** @type {number[]} */
  const escaped = [];
  for (const b of blocks) {
    const e = ESCAPE.get(b);
    if (e === undefined) {
      escaped.push(b);
    } else {
      escaped.push(ESCAPE_BYTE, e);
    }
  }

  // 56 bytes after the header in each command, like concmd_frame_sink
  const commands = [];
  const room = 63 - RUNTIME_HEADER.length;
  for (let i = 0; i < escaped.length; i += room) {
    commands.push(RUNTIME_HEADER + String.fromCharCode(...escaped.slice(i, i + room)));
  }
  return commands;
}
