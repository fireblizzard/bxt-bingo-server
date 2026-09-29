// Just enough of the zip format to read one entry of an .ods file

import { inflateRawSync } from "node:zlib";

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;

/**
 * The entries of a zip archive by name, read on demand
 * @param {Buffer} zip
 * @returns {Map<string, () => Buffer>}
 */
export function readZip(zip) {
  // The end record is last, followed by a comment of up to 64 KB
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === END_OF_CENTRAL_DIRECTORY) {
      end = i;
      break;
    }
  }
  if (end < 0) {
    throw new Error("not a zip file");
  }

  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  /** @type {Map<string, () => Buffer>} */
  const entries = new Map();

  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(at) !== CENTRAL_DIRECTORY_ENTRY) {
      throw new Error("broken zip central directory");
    }
    const method = zip.readUInt16LE(at + 10);
    const compressedSize = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const localHeader = zip.readUInt32LE(at + 42);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;

    entries.set(name, () => {
      if (zip.readUInt32LE(localHeader) !== LOCAL_HEADER) {
        throw new Error(`broken zip entry ${name}`);
      }
      // The local header has its own name and extra field lengths
      const start = localHeader + 30 + zip.readUInt16LE(localHeader + 26) + zip.readUInt16LE(localHeader + 28);
      const data = zip.subarray(start, start + compressedSize);
      if (method === 0) {
        return data;
      }
      if (method === 8) {
        return inflateRawSync(data);
      }
      throw new Error(`zip entry ${name} uses compression method ${method}`);
    });
  }

  return entries;
}
