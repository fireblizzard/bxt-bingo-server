// TEA with BXT's key, as in BunnymodXT/TEA.cpp and runtime_data.cpp
// It hides BXT's runtime data in demos from casual editing, it isn't a secret

const KEY = [0x1337face, 0x12345678, 0xdeadbeef, 0xfeedabcd];
const DELTA = 0x9e3779b9;

/**
 * Decrypts 8-byte blocks in place, little-endian like on x86
 * @param {Uint8Array} bytes A multiple of 8 long
 */
export function decryptBlocks(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const [k0, k1, k2, k3] = KEY;
  for (let at = 0; at + 8 <= bytes.byteLength; at += 8) {
    let v0 = view.getUint32(at, true);
    let v1 = view.getUint32(at + 4, true);
    let sum = (DELTA * 32) >>> 0;
    for (let i = 0; i < 32; i++) {
      v1 = (v1 - ((((v0 << 4) + k2) ^ (v0 + sum) ^ ((v0 >>> 5) + k3)) >>> 0)) >>> 0;
      v0 = (v0 - ((((v1 << 4) + k0) ^ (v1 + sum) ^ ((v1 >>> 5) + k1)) >>> 0)) >>> 0;
      sum = (sum - DELTA) >>> 0;
    }
    view.setUint32(at, v0, true);
    view.setUint32(at + 4, v1, true);
  }
}

/**
 * Encrypts 8-byte blocks in place, for tests that make runtime data like BXT does
 * @param {Uint8Array} bytes A multiple of 8 long
 */
export function encryptBlocks(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const [k0, k1, k2, k3] = KEY;
  for (let at = 0; at + 8 <= bytes.byteLength; at += 8) {
    let v0 = view.getUint32(at, true);
    let v1 = view.getUint32(at + 4, true);
    let sum = 0;
    for (let i = 0; i < 32; i++) {
      sum = (sum + DELTA) >>> 0;
      v0 = (v0 + ((((v1 << 4) + k0) ^ (v1 + sum) ^ ((v1 >>> 5) + k1)) >>> 0)) >>> 0;
      v1 = (v1 + ((((v0 << 4) + k2) ^ (v0 + sum) ^ ((v0 >>> 5) + k3)) >>> 0)) >>> 0;
    }
    view.setUint32(at, v0, true);
    view.setUint32(at + 4, v1, true);
  }
}
