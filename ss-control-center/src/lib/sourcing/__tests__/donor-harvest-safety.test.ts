import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const PROJECT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const donorCatalog = readFileSync(resolve(PROJECT, "src/lib/sourcing/donor-catalog.ts"), "utf8");
const harvestStart = donorCatalog.indexOf("export async function harvestDonorDetail");
const harvestEnd = donorCatalog.indexOf("async function quarantineUpcConflicts", harvestStart);
const harvestSource = donorCatalog.slice(harvestStart, harvestEnd);
const completeWriterStart = donorCatalog.indexOf(
  "export async function persistCompleteExactContentObservation",
);
const completeWriterEnd = donorCatalog.indexOf(
  "function searchContentSnapshot",
  completeWriterStart,
);
const completeWriterSource = donorCatalog.slice(completeWriterStart, completeWriterEnd);

test("legacy destructive donor cleanup entrypoints are quarantined", () => {
  assert.match(donorCatalog, /DESTRUCTIVE_CATALOG_CLEANUP_DISABLED/);
  assert.match(donorCatalog, /DESTRUCTIVE_OFFER_DEDUPE_DISABLED/);
  assert.doesNotMatch(donorCatalog, /DELETE\s+FROM\s+"Donor(?:Product|Offer)"/i);
});

test("harvest never certifies product identity from content or image QC", () => {
  assert.ok(harvestStart >= 0 && harvestEnd > harvestStart);
  assert.ok(completeWriterStart >= 0 && completeWriterEnd > completeWriterStart);
  assert.doesNotMatch(harvestSource, /needsReview\s*=\s*0/);
  assert.match(harvestSource, /persistCompleteExactContentObservation\(db/);
  assert.match(completeWriterSource, /needsReview=1/);
  assert.match(harvestSource, /explicit harvest source required/);
  assert.doesNotMatch(harvestSource, /classifyTemperatureLLM/);
  assert.doesNotMatch(harvestSource, /qcProductImage\(db/);
});

test("shared UPC is quarantined without moving offers or deleting donors", () => {
  assert.match(completeWriterSource, /quarantineUpcConflicts/);
  const exactContentPath = `${harvestSource}\n${completeWriterSource}`;
  assert.doesNotMatch(exactContentPath, /mergeByUpc/);
  assert.doesNotMatch(exactContentPath, /UPDATE\s+"DonorOffer"\s+SET\s+donorProductId/i);
  assert.doesNotMatch(exactContentPath, /DELETE\s+FROM\s+"DonorProduct"/i);
  assert.match(harvestSource, /merged:\s*0/);
});
