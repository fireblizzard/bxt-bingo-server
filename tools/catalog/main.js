// Makes the segment catalog from the Half-Life Practice Kit (BINGO.md §3.1)
//
// npm run catalog -- "<Half-Life Practice Kit folder>"
//   writes catalog/hl1-maps.json with the whole maps (OAR2)
//   and catalog/hl1-micro.json with their sections (OAR2.1 and OAR2.2)
// npm run catalog -- "<folder>" --pool hl1-standard --prefix std
//   for segments of your own, made as cfgs like the kit's
//   named freely (07.cfg), with their tile text and chapter in comment lines
//     // bingo label OC3-BP1
//     // bingo chapter Office Complex
//   and `// bingo end game` for one that ends when the game does (Nihilanth), without an end trigger
//   writes them all to catalog/<pool>.json, with ids that start with the prefix (std-07)
//   so they never match an id from the kit
// --out <folder> writes the files somewhere other than catalog
// Reads PracticeCfgs/*.cfg and hashes the saves they load from SAVE/
// Every segment gets game `valve`, and its save for the WON build
// Cfgs it can't use are listed at the end, with why

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { KIT_POOLS, compareIds, kitPool, parseCfg } from "./kit.js";

/**
 * Finds a file case-insensitively, as the kit's names don't always match their case
 * @param {string} dir
 * @param {string} name
 */
function findFile(dir, name) {
  const found = readdirSync(dir).find((f) => f.toLowerCase() === name.toLowerCase());
  return found ? join(dir, found) : null;
}

/**
 * @param {string} kit
 * @param {string} outDir
 * @param {{ pool: string, prefix: string } | null} own The pool and id prefix for segments not from the kit
 */
function run(kit, outDir, own) {
  const cfgDir = join(kit, "PracticeCfgs");
  const saveDir = join(kit, "SAVE");
  /** @type {import("../../src/protocol/segment.js").Segment[]} */
  const segments = [];
  /** @type {string[]} */
  const skipped = [];
  /** @type {string[]} */
  const notes = [];

  const names = readdirSync(cfgDir)
    .filter((f) => f.toLowerCase().endsWith(".cfg"))
    .map((f) => f.slice(0, -4));
  for (const name of names) {
    const result = parseCfg(name, readFileSync(join(cfgDir, `${name}.cfg`), "latin1"), own !== null);
    if ("skip" in result) {
      if (result.skip !== "not a segment") {
        skipped.push(`${name}: ${result.skip}`);
      }
      continue;
    }
    const { segment, notes: cfgNotes } = result;
    notes.push(...cfgNotes.map((n) => `${name}: ${n}`));

    const path = findFile(saveDir, `${segment.save}.sav`);
    if (!path) {
      skipped.push(`${name}: its save ${segment.save}.sav isn't in SAVE`);
      continue;
    }
    const bytes = readFileSync(path);
    segments.push({
      id: own ? `${own.prefix}-${segment.id}` : segment.id,
      label: segment.label,
      chapter: segment.chapter,
      pool: own ? own.pool : kitPool(segment.id),
      game: "valve",
      saves: { won: { sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length } },
      start: segment.start,
      end: segment.end,
      ...(segment.requirements.length > 0 ? { requirements: segment.requirements } : {}),
      reference_time_ms: null,
    });
  }

  // The kit's in its order, and ours by name with numbers in order (2 before 10)
  if (own) {
    segments.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  } else {
    segments.sort((a, b) => compareIds(a.id, b.id));
  }
  mkdirSync(outDir, { recursive: true });
  for (const pool of new Set(segments.map((s) => s.pool))) {
    const inPool = segments.filter((s) => s.pool === pool);
    const out = join(outDir, `${pool}.json`);
    writeFileSync(out, JSON.stringify(inPool, null, 2) + "\n");
    const saves = new Set(inPool.map((s) => s.saves.won.sha256)).size;
    console.log(`${out}: ${inPool.length} segments, ${saves} different saves`);
  }

  for (const [title, lines] of /** @type {const} */ ([
    ["Left out", skipped],
    ["Notes", notes],
  ])) {
    if (lines.length > 0) {
      console.log(`\n${title}:`);
      for (const line of lines) {
        console.log(`  ${line}`);
      }
    }
  }
}

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

const pool = option("pool");
const prefix = option("prefix");
const outDir = option("out") ?? "catalog";
const [kit] = args;
if (!kit || (pool === undefined) !== (prefix === undefined)) {
  console.error('usage: npm run catalog -- "<Half-Life Practice Kit folder>"');
  console.error('   or: npm run catalog -- "<folder with PracticeCfgs and SAVE>" --pool hl1-standard --prefix std');
  process.exit(1);
}
if (pool !== undefined && prefix !== undefined) {
  if (!/^[a-z0-9-]+$/.test(pool) || !/^[a-z0-9]+$/.test(prefix)) {
    console.error("the pool can have lowercase letters, digits and -, the prefix only lowercase letters and digits");
    process.exit(1);
  }
  if (Object.values(KIT_POOLS).includes(pool)) {
    console.error(`${pool} is one of the kit's pools`);
    process.exit(1);
  }
}
run(kit, outDir, pool !== undefined && prefix !== undefined ? { pool, prefix } : null);
