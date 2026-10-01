// GoldSrc demos (.dem), the parts a check needs: the player's view each frame and BXT's runtime data
//
// Layout: a header, then frames, and a directory at the end listing the segments
// (the loading one and the playback one), each a run of frames up to a "next section" frame
// Each frame is a type byte, a time and a frame number, then the type's data

import { RUNTIME_HEADER, decodeRuntimeData } from "./runtime.js";

const MAGIC = "HLDEMO";
const HEADER_BYTES = 544;
const DIRECTORY_ENTRY_BYTES = 92;

// Frame types. Anything else (0, 1 and above 9) is a network message with the player's view
const DEMO_START = 2;
const CONSOLE_COMMAND = 3;
const CLIENT_DATA = 4;
const NEXT_SECTION = 5;
const EVENT = 6;
const WEAPON_ANIM = 7;
const SOUND = 8;
const DEMO_BUFFER = 9;

// A network message frame starts with the client's view (demo_info): a timestamp, ref_params,
// usercmd and movevars, then the view and the view model, 436 bytes in all
const INFO_BYTES = 436;
const REF_PARAMS = 4;
const MOVEVARS = 4 + 232 + 52;
// Then 7 sequence numbers, the message's length and the message
const SEQUENCE_BYTES = 28;

// sv_ cvars as movevars has them, in its order
const MOVEVARS_FIELDS = [
  "sv_gravity",
  "sv_stopspeed",
  "sv_maxspeed",
  "sv_spectatormaxspeed",
  "sv_accelerate",
  "sv_airaccelerate",
  "sv_wateraccelerate",
  "sv_friction",
  "edgefriction",
  "sv_waterfriction",
  "entgravity",
  "sv_bounce",
  "sv_stepsize",
  "sv_maxvelocity",
  "sv_zmax",
  "sv_wateramp",
];

/**
 * @typedef {object} ViewFrame A network message: what the player saw that frame
 * @property {"view"} kind
 * @property {number} time Demo time, s
 * @property {number} frametime s
 * @property {boolean} paused
 * @property {[number, number, number]} origin The player's position (simorg)
 * @property {number} health
 * @property {Record<string, number>} movevars The server's sv_ cvars as the client got them
 */

/**
 * @typedef {object} RuntimeFrame BXT's runtime data written that frame
 * @property {"runtime"} kind
 * @property {number} time
 * @property {import("./runtime.js").RuntimeEntry[]} entries
 * @property {string | null} error Why it couldn't be read
 */

/**
 * @typedef {object} Demo
 * @property {number} demoProtocol
 * @property {number} netProtocol
 * @property {string} mapName
 * @property {string} gameDir
 * @property {(ViewFrame | RuntimeFrame)[]} frames In order
 * @property {string[]} commands The other console commands in the demo
 */

/**
 * @param {Uint8Array} bytes
 * @param {number} at
 * @param {number} length
 */
function cString(bytes, at, length) {
  const slice = bytes.subarray(at, at + length);
  const end = slice.indexOf(0);
  return new TextDecoder().decode(end < 0 ? slice : slice.subarray(0, end));
}

/**
 * @param {Uint8Array} bytes A whole .dem file
 * @returns {Demo}
 */
export function parseDemo(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < HEADER_BYTES || cString(bytes, 0, 8) !== MAGIC) {
    throw new RangeError("not a Half-Life demo");
  }
  /** @type {Demo} */
  const demo = {
    demoProtocol: view.getInt32(8, true),
    netProtocol: view.getInt32(12, true),
    mapName: cString(bytes, 16, 260),
    gameDir: cString(bytes, 276, 260),
    frames: [],
    commands: [],
  };

  const directoryAt = view.getInt32(540, true);
  if (directoryAt < HEADER_BYTES || directoryAt + 4 > bytes.byteLength) {
    throw new RangeError("the demo has no directory, it may not have been closed");
  }
  const entries = view.getInt32(directoryAt, true);
  if (entries < 1 || entries > 1024 || directoryAt + 4 + entries * DIRECTORY_ENTRY_BYTES > bytes.byteLength) {
    throw new RangeError("the demo's directory is broken");
  }

  for (let e = 0; e < entries; e++) {
    const entryAt = directoryAt + 4 + e * DIRECTORY_ENTRY_BYTES;
    let at = view.getInt32(entryAt + 84, true);
    const length = view.getInt32(entryAt + 88, true);
    const end = Math.min(bytes.byteLength, at + length);

    /** @type {number[]} */
    let runtime = [];
    let runtimeTime = 0;
    const flushRuntime = () => {
      if (runtime.length === 0) {
        return;
      }
      /** @type {RuntimeFrame} */
      const frame = { kind: "runtime", time: runtimeTime, entries: [], error: null };
      try {
        frame.entries = decodeRuntimeData(new Uint8Array(runtime));
      } catch (error) {
        frame.error = /** @type {Error} */ (error).message;
      }
      demo.frames.push(frame);
      runtime = [];
    };

    while (at + 9 <= end) {
      const type = view.getUint8(at);
      const time = view.getFloat32(at + 1, true);
      at += 9;
      if (type === NEXT_SECTION) {
        break;
      }
      switch (type) {
        case DEMO_START:
          break;
        case CONSOLE_COMMAND: {
          const command = bytes.subarray(at, at + 64);
          const text = cString(bytes, at, 64);
          if (text.startsWith(RUNTIME_HEADER)) {
            // BXT reads the commands before each message as one batch
            const zero = command.indexOf(0);
            runtime.push(...command.subarray(RUNTIME_HEADER.length, zero < 0 ? 64 : zero));
            runtimeTime = time;
          } else {
            demo.commands.push(text);
          }
          at += 64;
          break;
        }
        case CLIENT_DATA:
          at += 32;
          break;
        case EVENT:
          at += 84;
          break;
        case WEAPON_ANIM:
          at += 8;
          break;
        case SOUND: {
          const sample = view.getInt32(at + 4, true);
          at += 8 + Math.max(0, sample) + 16;
          break;
        }
        case DEMO_BUFFER:
          at += 4 + Math.max(0, view.getInt32(at, true));
          break;
        default: {
          if (at + INFO_BYTES + SEQUENCE_BYTES + 4 > end) {
            at = end;
            break;
          }
          flushRuntime();
          const ref = at + REF_PARAMS;
          /** @type {Record<string, number>} */
          const movevars = {};
          MOVEVARS_FIELDS.forEach((name, i) => {
            movevars[name] = view.getFloat32(at + MOVEVARS + i * 4, true);
          });
          demo.frames.push({
            kind: "view",
            time,
            frametime: view.getFloat32(ref + 15 * 4, true),
            paused: view.getInt32(ref + 18 * 4, true) !== 0,
            origin: [view.getFloat32(ref + 25 * 4, true), view.getFloat32(ref + 26 * 4, true), view.getFloat32(ref + 27 * 4, true)],
            health: view.getInt32(ref + 35 * 4, true),
            movevars,
          });
          at += INFO_BYTES + SEQUENCE_BYTES;
          const messageLength = view.getInt32(at, true);
          at += 4 + Math.max(0, messageLength);
          break;
        }
      }
    }
    flushRuntime();
  }
  return demo;
}
