// A scripted stand-in for BXT, to test the server before BXT's networking exists
//
// npm run fake-bxt -- <join code> [options]
//   --server ws://localhost:8787/bxt
//   --runs <n>        how many runs to play once the game is running (default 0: only get ready)
//   --tiles A1,B1     which tiles to play, in order (default: the first playable one)
//   --time <ms>       the time each run reports (default 30000, slow enough to beat when testing)
//   --wait <ms>       how long each run takes for real (default 1000)
//   --session <token> reconnect with a session token instead of a join code
//   --no-demos        answer demo requests with demo_unavailable instead of uploading a fake demo
//   --quiet           don't print every message
// It reconnects with its session token when the connection drops, like BXT will

import { randomUUID } from "node:crypto";

import { DEMO_PART_HEADER, JOIN_HEADER, PING_INTERVAL_MS, PING_TEXT, PROTOCOL_VERSION, SESSION_HEADER } from "../src/protocol/index.js";

const args = process.argv.slice(2);

/** @param {string} name */
function option(name) {
  const i = args.indexOf(`--${name}`);
  if (i < 0) {
    return undefined;
  }
  const [, value] = args.splice(i, 2);
  return value;
}

/** @param {string} name */
function flag(name) {
  const i = args.indexOf(`--${name}`);
  if (i >= 0) {
    args.splice(i, 1);
  }
  return i >= 0;
}

const server = option("server") ?? "ws://localhost:8787/bxt";
let runsLeft = Number(option("runs") ?? 0);
const tiles = option("tiles")?.split(",") ?? [];
const timeMs = Number(option("time") ?? 30_000);
const waitMs = Number(option("wait") ?? 1000);
let session = option("session") ?? null;
const noDemos = flag("no-demos");
const quiet = flag("quiet");
const [joinCode] = args;

if (!joinCode && !session) {
  console.error("usage: npm run fake-bxt -- <join code> [--runs n] [--tiles A1,B1] [--time ms] [--wait ms]");
  process.exit(1);
}

/** @type {any} */
let manifest = null;
/** @type {any} */
let board = null;
let state = "lobby";
/** @type {string | null} */
let team = null;
let running = false;
let retryMs = 1000;
let over = false;

/** @param {string} text */
const log = (text) => console.log(`[${new Date().toISOString().slice(11, 23)}] ${text}`);

function connect() {
  const headers = session ? { [SESSION_HEADER]: session } : { [JOIN_HEADER]: joinCode };
  // Node's WebSocket takes headers, unlike a browser's
  const ws = new WebSocket(server, /** @type {any} */ ({ headers }));
  /** @type {NodeJS.Timeout | undefined} */
  let ping;

  /** @param {object} message */
  const send = (message) => {
    const text = JSON.stringify(message);
    if (!quiet) {
      log(`> ${text}`);
    }
    ws.send(text);
  };

  /**
   * Uploads a made-up demo in one part, the way BXT sends each part of a real one
   * @param {{ attempt_id: string, upload_url: string }} request
   */
  const sendDemo = async (request) => {
    if (noDemos) {
      send({ type: "demo_unavailable", attempt_id: request.attempt_id, reason: "fake-bxt was started with --no-demos" });
      return;
    }
    // A path is on the server BXT connected to, ws://host/bxt -> http://host/...
    const url = request.upload_url.startsWith("/") ? new URL(request.upload_url, server.replace(/^ws/, "http")).href : request.upload_url;
    const response = await fetch(url, {
      method: "PUT",
      headers: { [SESSION_HEADER]: session ?? "", [DEMO_PART_HEADER]: "1/1" },
      body: new TextEncoder().encode(`fake demo of ${request.attempt_id}`),
    });
    log(`demo upload: ${response.status} ${await response.text()}`);
    if (response.ok) {
      send({ type: "demo_uploaded", attempt_id: request.attempt_id, parts: 1 });
    }
  };

  const playNext = () => {
    if (running || runsLeft <= 0 || state !== "running" || !board) {
      return;
    }
    // Free tiles first, then the other team's, and its own last (redo is on by default,
    // and replaying its own tile with the same time does nothing)
    const rank = (/** @type {any} */ t) => (t.owner === null ? 0 : t.owner !== team ? 1 : 2);
    const playable = board.tiles
      .filter((/** @type {any} */ t) => t.playable_for_you)
      .sort((/** @type {any} */ a, /** @type {any} */ b) => rank(a) - rank(b))
      .map((/** @type {any} */ t) => t.id);
    const tile = tiles.find((t) => playable.includes(t)) ?? (tiles.length === 0 ? playable[0] : undefined);
    if (!tile) {
      // Wait for a board where one is playable
      return;
    }
    running = true;
    runsLeft--;
    const attempt_id = randomUUID();
    const save = manifest.tiles.find((/** @type {any} */ t) => t.id === tile).save.sha256;
    send({ type: "tile_selected", tile });
    send({ type: "attempt_started", attempt_id, tile });
    setTimeout(() => {
      send({
        type: "attempt_result",
        attempt_id,
        tile,
        time_ms: timeMs,
        server_time_delta_ms: timeMs,
        frames: Math.round(timeMs / 10),
        real_ms: timeMs,
        load_ms: 0,
        save_sha256: save,
        ruleset_ok: true,
        demo: null,
      });
    }, waitMs);
  };

  ws.addEventListener("open", () => {
    retryMs = 1000;
    log(`connected to ${server}`);
    send({ type: "hello", protocol: PROTOCOL_VERSION, bxt_version: "fake-bxt", engine_build: "won", dll_sha256: null, steamid64: null });
    ping = setInterval(() => ws.send(PING_TEXT), PING_INTERVAL_MS);
  });

  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!quiet) {
      const text = message.type === "board" || message.type === "manifest" ? summary(message) : JSON.stringify(message);
      log(`< ${text}`);
    }
    switch (message.type) {
      case "welcome":
        session = message.session_token;
        team = message.player.team;
        log(`playing as ${message.player.name} (${message.player.team}), session ${session}`);
        break;
      case "manifest":
        manifest = message;
        // A real BXT downloads what's missing and checks every file first
        send({ type: "download_progress", done: manifest.tiles.length, total: manifest.tiles.length });
        send({ type: "ready", manifest_hash: manifest.manifest_hash });
        break;
      case "lobby":
        state = message.state;
        break;
      case "board":
        board = message;
        playNext();
        break;
      case "result_ack":
        log(`result: ${message.verdict}${message.flagged ? ", flagged" : ""}${message.detail ? ` (${message.detail})` : ""}`);
        // The next run is picked from the board that follows
        running = false;
        break;
      case "event":
        log(`* ${message.text}`);
        break;
      case "request_demo":
        sendDemo(message);
        break;
      case "game_over":
        over = true;
        log(`game over: ${message.reason}, winner ${message.winner ?? "none"}`);
        ws.close(1000);
        break;
    }
  });

  ws.addEventListener("close", (event) => {
    clearInterval(ping);
    log(`closed ${event.code} ${event.reason}`);
    running = false;
    // Codes that mean the player is out: kicked, game deleted, replaced, banned
    if (over || [1008, 4001, 4002, 4003, 4004].includes(event.code) || !session) {
      process.exit(0);
    }
    log(`reconnecting in ${retryMs / 1000} s`);
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 2, 30_000);
  });

  ws.addEventListener("error", () => {
    // The close event follows
  });
}

/** @param {any} message */
function summary(message) {
  if (message.type === "manifest") {
    return `manifest ${message.manifest_hash}, ${message.tiles.length} tiles, ${message.ruleset.cvars.length} cvar rules`;
  }
  const owned = message.tiles.filter((/** @type {any} */ t) => t.owner).map((/** @type {any} */ t) => `${t.id}=${t.owner}`);
  const busy = message.tiles.filter((/** @type {any} */ t) => t.contesting.length).map((/** @type {any} */ t) => `${t.id}:${t.contesting.length}`);
  return `board #${message.seq} at ${(message.clock_ms / 1000).toFixed(1)} s, owned [${owned.join(" ")}], contesting [${busy.join(" ")}]`;
}

connect();
