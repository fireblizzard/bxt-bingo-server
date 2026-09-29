// Tiny WebSocket echo server, to check BXT's WinHTTP WebSockets inside hl.exe (Windows, Wine, Proton)
//
// Usage: npm run echo -- [host:port], default 127.0.0.1:8765 (any path works)
//
// - Sends `welcome to bingo-echo` right after connecting
// - Sends every text or binary message back unchanged
// - `ticks <n>` sends `tick 1/<n>` to `tick <n>/<n>`, one per second, to check that BXT
//   receives messages while the game runs and nothing is being sent
//   A new `ticks` replaces the run in progress
// - `close` makes the server close the connection, to test a server-initiated close
//
// Plain Node with no packages, so it handles only what BXT sends: no extensions, no compression

import { createHash } from "node:crypto";
import { createServer } from "node:http";

const DEFAULT_ADDRESS = "127.0.0.1:8765";

// Upper bound for `ticks <n>`, so a typo can't keep a connection busy for hours
const MAX_TICKS = 60;
const TICK_INTERVAL_MS = 1000;

// Longest message printed in full to the server's own output
const MAX_LOGGED_CHARS = 200;

// Largest message accepted, anything bigger closes the connection
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const OP = { CONTINUATION: 0, TEXT: 1, BINARY: 2, CLOSE: 8, PING: 9, PONG: 10 };

/** @param {string} text */
function shorten(text) {
  return text.length <= MAX_LOGGED_CHARS
    ? JSON.stringify(text)
    : `${JSON.stringify(text.slice(0, MAX_LOGGED_CHARS))}… (${Buffer.byteLength(text)} bytes)`;
}

/**
 * A server frame: never masked, never fragmented
 * @param {number} opcode
 * @param {Buffer} payload
 */
function frame(opcode, payload) {
  const length = payload.length;
  const header = length < 126 ? Buffer.alloc(2) : length < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  if (length < 126) {
    header[1] = length;
  } else if (length < 65536) {
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

/**
 * @param {number} code
 * @param {string} reason
 */
function closePayload(code, reason) {
  const payload = Buffer.alloc(2 + Buffer.byteLength(reason));
  payload.writeUInt16BE(code, 0);
  payload.write(reason, 2);
  return payload;
}

/**
 * @param {import("node:net").Socket} socket
 * @param {string} peer
 */
function session(socket, peer) {
  console.log(`${peer}: connected`);
  let buffer = Buffer.alloc(0);
  /** @type {{ opcode: number, parts: Buffer[], size: number } | null} */
  let message = null;
  let closed = false;
  /** @type {NodeJS.Timeout | undefined} */
  let ticks;

  /**
   * @param {number} opcode
   * @param {Buffer} payload
   */
  const send = (opcode, payload) => {
    if (!closed) {
      socket.write(frame(opcode, payload));
    }
  };

  /** @param {string} text */
  const sendText = (text) => send(OP.TEXT, Buffer.from(text));

  /**
   * @param {number} code
   * @param {string} reason
   */
  const close = (code, reason) => {
    send(OP.CLOSE, closePayload(code, reason));
    closed = true;
    clearInterval(ticks);
    socket.end();
  };

  /** @param {string} count */
  const startTicks = (count) => {
    const n = /^\d+$/.test(count.trim()) ? Math.min(Number(count.trim()), MAX_TICKS) : NaN;
    if (Number.isNaN(n)) {
      sendText(`ticks needs a number, e.g. \`ticks 5\` (at most ${MAX_TICKS})`);
      return;
    }
    clearInterval(ticks);
    let sent = 0;
    if (n === 0) {
      return;
    }
    ticks = setInterval(() => {
      sent++;
      const text = `tick ${sent}/${n}`;
      console.log(`${peer}: sent ${JSON.stringify(text)}`);
      sendText(text);
      if (sent >= n) {
        clearInterval(ticks);
      }
    }, TICK_INTERVAL_MS);
  };

  /**
   * @param {number} opcode
   * @param {Buffer} payload
   */
  const onMessage = (opcode, payload) => {
    if (opcode === OP.BINARY) {
      console.log(`${peer}: binary, ${payload.length} bytes`);
      send(OP.BINARY, payload);
      return;
    }
    const text = payload.toString("utf8");
    console.log(`${peer}: text ${shorten(text)}`);
    if (text === "close") {
      close(1000, "closed by bingo-echo");
      console.log(`${peer}: closed by the server`);
    } else if (text.startsWith("ticks ")) {
      startTicks(text.slice(6));
    } else {
      sendText(text);
    }
  };

  /**
   * @param {number} opcode
   * @param {boolean} fin
   * @param {Buffer} payload
   */
  const onFrame = (opcode, fin, payload) => {
    if (opcode === OP.PING) {
      send(OP.PONG, payload);
    } else if (opcode === OP.PONG) {
      // Nothing to do
    } else if (opcode === OP.CLOSE) {
      if (payload.length >= 2) {
        console.log(`${peer}: client closed, status ${payload.readUInt16BE(0)}, reason ${JSON.stringify(payload.subarray(2).toString("utf8"))}`);
      } else {
        console.log(`${peer}: client closed without a status`);
      }
      // Answer the close handshake with the same status
      close(payload.length >= 2 ? payload.readUInt16BE(0) : 1000, "");
    } else if (opcode === OP.TEXT || opcode === OP.BINARY || opcode === OP.CONTINUATION) {
      if (opcode !== OP.CONTINUATION) {
        message = { opcode, parts: [], size: 0 };
      }
      if (!message) {
        close(1002, "continuation without a message");
        return;
      }
      message.parts.push(payload);
      message.size += payload.length;
      if (message.size > MAX_MESSAGE_BYTES) {
        close(1009, "message too big");
      } else if (fin) {
        const { opcode: first, parts } = message;
        message = null;
        onMessage(first, Buffer.concat(parts));
      }
    } else {
      close(1002, `unknown opcode ${opcode}`);
    }
  };

  socket.on("data", (/** @type {Buffer} */ data) => {
    buffer = Buffer.concat([buffer, data]);
    while (!closed && buffer.length >= 2) {
      const fin = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let at = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        at = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const big = buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE_BYTES)) {
          close(1009, "message too big");
          return;
        }
        length = Number(big);
        at = 10;
      }
      if (!masked) {
        // Clients must mask every frame
        close(1002, "unmasked frame");
        return;
      }
      if (buffer.length < at + 4 + length) return;
      const mask = buffer.subarray(at, at + 4);
      const payload = Buffer.from(buffer.subarray(at + 4, at + 4 + length));
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= mask[i % 4];
      }
      buffer = buffer.subarray(at + 4 + length);
      onFrame(opcode, fin, payload);
    }
  });

  socket.on("close", () => {
    clearInterval(ticks);
    if (!closed) {
      console.log(`${peer}: connection dropped without a close handshake`);
    }
    closed = true;
  });
  socket.on("error", (error) => console.log(`${peer}: socket error: ${error.message}`));

  sendText("welcome to bingo-echo");
}

const address = process.argv[2] ?? DEFAULT_ADDRESS;
const colon = address.lastIndexOf(":");
const host = address.slice(0, colon);
const port = Number(address.slice(colon + 1));

const server = createServer((request, response) => {
  const peer = `${request.socket.remoteAddress}:${request.socket.remotePort}`;
  console.log(`${peer}: ${request.url} is not a WebSocket upgrade`);
  response.writeHead(426, { "Content-Type": "text/plain" }).end("expected a WebSocket upgrade\n");
});

server.on("upgrade", (request, socket) => {
  const peer = `${request.socket.remoteAddress}:${request.socket.remotePort}`;
  const key = request.headers["sec-websocket-key"];
  if (request.headers.upgrade?.toLowerCase() !== "websocket" || typeof key !== "string") {
    console.log(`${peer}: ${request.url} is not a WebSocket upgrade`);
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return;
  }
  console.log(`${peer}: upgrading ${request.url}`);
  const accept = createHash("sha1").update(key + GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  session(/** @type {import("node:net").Socket} */ (socket), peer);
});

server.listen(port, host, () => console.log(`bingo-echo listening on ws://${host}:${port}`));
