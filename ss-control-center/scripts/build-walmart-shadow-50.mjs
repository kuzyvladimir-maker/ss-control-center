#!/usr/bin/env node
/**
 * Offline-only shadow-50 manifest builder.
 *
 * Input must already be a read-only export of WalmartShadowCandidate[]. This
 * script has no environment loading, database client, fetch, or marketplace
 * client, so running it cannot touch production systems.
 *
 * node --experimental-strip-types scripts/build-walmart-shadow-50.mjs \
 *   --input=data/audits/walmart-shadow-candidates.json \
 *   --output=data/audits/walmart-shadow-50.json
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildWalmartShadow50 } from "../src/lib/walmart/shadow-50.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const out = { input: null, output: null, seed: "walmart-shadow-50-v1" };
  for (const arg of argv) {
    if (arg.startsWith("--input=")) out.input = path.resolve(ROOT, arg.slice("--input=".length));
    else if (arg.startsWith("--output=")) out.output = path.resolve(ROOT, arg.slice("--output=".length));
    else if (arg.startsWith("--seed=")) out.seed = arg.slice("--seed=".length);
    else throw new Error(`unsupported argument: ${arg}`);
  }
  if (!out.input) throw new Error("--input=<offline candidate JSON> is required");
  return out;
}

const args = parseArgs(process.argv.slice(2));
const parsed = JSON.parse(await readFile(args.input, "utf8"));
const candidates = Array.isArray(parsed) ? parsed : parsed?.candidates;
if (!Array.isArray(candidates)) throw new Error("input must be an array or {candidates:[...]}");
const manifest = buildWalmartShadow50(candidates, args.seed);
const output = args.output ?? path.join(ROOT, "data/audits", `${manifest.manifest_id}.json`);
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
console.log(`shadow-50: ${manifest.cases.length} exact SKU/item pairs`);
console.log(`manifest: ${path.relative(ROOT, output)}`);
