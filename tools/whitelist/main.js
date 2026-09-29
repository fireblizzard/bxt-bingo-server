// Makes the bingo rulesets from the community's command and cvar whitelist
//
// Usage: npm run whitelist -- Whitelist.ods rules
// Writes won-scriptless.json and won-scripted.json, the `ruleset` the server sends in the manifest
// (the server sets `single_segment` and the handicaps per game)
//
// The sheet goes through colors, so export it from Google Sheets as .ods, not .csv

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { readFirstSheet } from "./ods.js";
import { build } from "./rules.js";

/**
 * @param {string} sheet
 * @param {string} outDir
 */
function run(sheet, outDir) {
  const out = build(readFirstSheet(sheet));

  mkdirSync(outDir, { recursive: true });
  for (const [file, ruleset] of /** @type {const} */ ([
    ["won-scriptless.json", out.scriptless],
    ["won-scripted.json", out.scripted],
  ])) {
    const path = join(outDir, file);
    writeFileSync(path, JSON.stringify(ruleset, null, 2) + "\n");
    console.log(`${path}: ${ruleset.cvars.length} cvar rules, ${ruleset.commands.allowed.length} allowed commands`);
  }

  if (out.skipped.length > 0) {
    console.log("\nRows without a rule, check these by hand:");
    for (const row of out.skipped) {
      console.log(`  ${row}`);
    }
  }
}

const args = process.argv.slice(2);
if (args.length !== 2) {
  console.error("usage: npm run whitelist -- <Whitelist.ods> <output dir>");
  process.exit(1);
}
try {
  run(args[0], args[1]);
} catch (e) {
  console.error(`error: ${/** @type {Error} */ (e).message}`);
  process.exit(1);
}
