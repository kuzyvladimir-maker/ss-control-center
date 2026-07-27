#!/usr/bin/env node

/**
 * Build the smallest useful independent layout-control cohort.
 *
 * The full 24-image paired golden already covers product correctness in the
 * historical ordered batch. These six cases concentrate the failure modes
 * most likely to expose attachment-order or singleton-vs-batch instability:
 * foreign product, wrong formulation, wrong package tier, small net-weight
 * OCR, role-swapped product/variant text, and a split FAMILY/SIZE badge.
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateAuditManifest } from "../src/lib/walmart/catalog-visual-audit.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "data/audits/walmart-visual-pilot-golden-pairs-v3.json");
const OUTPUT = path.join(ROOT, "data/audits/walmart-visual-control-6-v3.json");

const CASE_IDS = [
  "bad-pair-faisalx-1183",
  "bad-pair-faisalx-2223",
  "bad-pair-faisalx-4779",
  "pass-pair-faisalx-1130",
  "pass-pair-faisalx-1208",
  "pass-pair-faisalx-4215",
];

async function main() {
  const source = JSON.parse(await readFile(SOURCE, "utf8"));
  const byId = new Map(source.cases.map((item) => [item.case_id, item]));
  const cases = CASE_IDS.map((caseId) => {
    const item = byId.get(caseId);
    if (!item) throw new Error(`source golden is missing ${caseId}`);
    return item;
  });
  if (new Set(cases.map((item) => item.sku)).size !== cases.length) {
    throw new Error("control cohort must use six distinct SKUs");
  }
  const manifest = validateAuditManifest({
    schema_version: "walmart-visual-audit/v3",
    manifest_id: "walmart-main-control-6-20260718-v3",
    purpose: "golden-pilot",
    cases,
    layouts: [
      { name: "batch-6-shuffled", batch_size: 6, shuffle_seed: 7182026 },
      { name: "singleton", batch_size: 1, shuffle_seed: null },
    ],
  });
  const bytes = `${JSON.stringify(manifest, null, 2)}\n`;
  try {
    await writeFile(OUTPUT, bytes, { flag: "wx" });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = await readFile(OUTPUT, "utf8");
    if (existing !== bytes) throw new Error("immutable control manifest already exists with different bytes");
  }
  console.log(`wrote ${path.relative(ROOT, OUTPUT)}: 6 cases, exactly 7 planned calls`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
