#!/usr/bin/env node
/**
 * Offline-only shadow-50 manifest builder.
 *
 * Inputs must already be sealed offline exports: one compiled by the shared
 * Product Truth Platform, and one complete listing-key performance/risk
 * evidence snapshot. The full population is keyed by
 * WALMART_US/store_index/raw SKU/listing_key and must not use seller WPID or a
 * buyer item ID as its listing identity.
 * This script has no environment loading, database client, fetch, or
 * marketplace client, so running it cannot touch production systems.
 *
 * node --experimental-strip-types scripts/build-walmart-shadow-50.mjs \
 *   --truth-input=data/audits/walmart-catalog-truth-audit-export.json \
 *   --product-truth-snapshot=data/audits/product-truth-walmart-snapshot.json \
 *   --buyer-index=data/audits/walmart-buyer-snapshot-index.json \
 *   --selection-input=data/audits/walmart-shadow-selection-evidence.json \
 *   --published-catalog-source=data/audits/walmart-published-catalog-source.json \
 *   --performance-source=data/audits/walmart-performance-source.json \
 *   --prior-visual-source=data/audits/walmart-prior-visual-source.json \
 *   --remediation-source=data/audits/walmart-remediation-source.json \
 *   --output=data/audits/walmart-shadow-50.json
 */

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildWalmartShadow50 } from "../src/lib/walmart/shadow-50.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const out = {
    truthInput: null,
    truthSnapshot: null,
    buyerIndex: null,
    selectionInput: null,
    publishedCatalogSource: null,
    performanceSource: null,
    priorVisualSource: null,
    remediationSource: null,
    output: null,
  };
  for (const arg of argv) {
    if (arg.startsWith("--truth-input=")) {
      out.truthInput = path.resolve(ROOT, arg.slice("--truth-input=".length));
    } else if (arg.startsWith("--product-truth-snapshot=")) {
      out.truthSnapshot = path.resolve(ROOT, arg.slice("--product-truth-snapshot=".length));
    } else if (arg.startsWith("--buyer-index=")) {
      out.buyerIndex = path.resolve(ROOT, arg.slice("--buyer-index=".length));
    } else if (arg.startsWith("--selection-input=")) {
      out.selectionInput = path.resolve(ROOT, arg.slice("--selection-input=".length));
    } else if (arg.startsWith("--published-catalog-source=")) {
      out.publishedCatalogSource = path.resolve(ROOT, arg.slice("--published-catalog-source=".length));
    } else if (arg.startsWith("--performance-source=")) {
      out.performanceSource = path.resolve(ROOT, arg.slice("--performance-source=".length));
    } else if (arg.startsWith("--prior-visual-source=")) {
      out.priorVisualSource = path.resolve(ROOT, arg.slice("--prior-visual-source=".length));
    } else if (arg.startsWith("--remediation-source=")) {
      out.remediationSource = path.resolve(ROOT, arg.slice("--remediation-source=".length));
    }
    else if (arg.startsWith("--output=")) out.output = path.resolve(ROOT, arg.slice("--output=".length));
    else throw new Error(`unsupported argument: ${arg}`);
  }
  if (!out.truthInput) throw new Error("--truth-input=<sealed Product Truth export JSON> is required");
  if (!out.truthSnapshot) {
    throw new Error("--product-truth-snapshot=<sealed shared Product Truth snapshot JSON> is required");
  }
  if (!out.buyerIndex) {
    throw new Error("--buyer-index=<sealed buyer snapshot index JSON> is required");
  }
  if (!out.selectionInput) {
    throw new Error("--selection-input=<sealed performance/risk evidence JSON> is required");
  }
  if (!out.publishedCatalogSource) {
    throw new Error("--published-catalog-source=<sealed complete PUBLISHED catalog JSON> is required");
  }
  if (!out.performanceSource) {
    throw new Error("--performance-source=<sealed exact 180-day performance JSON> is required");
  }
  if (!out.priorVisualSource) {
    throw new Error("--prior-visual-source=<sealed prior-visual labels JSON> is required");
  }
  if (!out.remediationSource) {
    throw new Error("--remediation-source=<sealed verified-remediation JSON> is required");
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const [
  catalogTruthInput,
  productTruthSnapshotInput,
  buyerSnapshotIndexInput,
  selectionEvidenceInput,
  publishedCatalogSourceInput,
  performanceSourceInput,
  priorVisualSourceInput,
  remediationSourceInput,
] = await Promise.all([
  readFile(args.truthInput, "utf8").then(JSON.parse),
  readFile(args.truthSnapshot, "utf8").then(JSON.parse),
  readFile(args.buyerIndex, "utf8").then(JSON.parse),
  readFile(args.selectionInput, "utf8").then(JSON.parse),
  readFile(args.publishedCatalogSource, "utf8").then(JSON.parse),
  readFile(args.performanceSource, "utf8").then(JSON.parse),
  readFile(args.priorVisualSource, "utf8").then(JSON.parse),
  readFile(args.remediationSource, "utf8").then(JSON.parse),
]);
const manifest = buildWalmartShadow50(
  catalogTruthInput,
  productTruthSnapshotInput,
  buyerSnapshotIndexInput,
  selectionEvidenceInput,
  publishedCatalogSourceInput,
  performanceSourceInput,
  priorVisualSourceInput,
  remediationSourceInput,
);
const output = args.output ?? path.join(ROOT, "data/audits", `${manifest.manifest_id}.json`);
await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
console.log(`shadow-50: ${manifest.cases.length} sealed AUDITABLE listing/buyer-item pairs`);
console.log("status: SOURCE_SCHEMAS_READY_UPSTREAM_PROVENANCE_NO_GO");
console.log("pending: raw-source verification for published/performance/prior/remediation plus PDP/human/runner gates");
console.log(`manifest: ${path.relative(ROOT, output)}`);
