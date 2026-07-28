import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseDonorEnrichmentManifest,
  projectDonorEnrichment,
  projectSelectedVariantAliases,
  rewriteSelectedVariantAliases,
  UNCRUSTABLES_DONOR_MANIFEST_PATH,
  UNCRUSTABLES_DONOR_MANIFEST_SHA256,
} from "@/lib/bundle-factory/donor-enrichment";
import type { Variant } from "@/lib/bundle-factory/variation-matrix";
import { parseArgs as parseRecipeBackfillArgs } from "../../../../scripts/backfill-bundle-recipes";
import { parseArgs as parseEnrichmentArgs } from "../../../../scripts/enrich-uncrustables-donors";

function rawManifest(): Buffer {
  return readFileSync(UNCRUSTABLES_DONOR_MANIFEST_PATH);
}

function manifest() {
  return parseDonorEnrichmentManifest(
    JSON.parse(rawManifest().toString("utf8")),
  );
}

function selectedMixedBerryVariant(productName?: string): Variant {
  const reviewedAlias = manifest().aliases[0];
  return {
    idx: 1,
    name: "Mixed Berry",
    composition: [
      {
        research_pool_id: reviewedAlias.from_donor_id,
        product_name:
          productName ?? reviewedAlias.expected_selected_product_name,
        brand: "Uncrustables",
        qty: 24,
        unit_price_cents: 100,
      },
    ],
    cost_cents: 2400,
    suggested_price_cents: 6000,
    margin_cents: 3600,
    margin_pct: 60,
    feasibility_score: 90,
    notes: "",
  };
}

test("reviewed manifest is immutable, complete, and SHA-pinned", () => {
  const raw = rawManifest();
  assert.equal(
    createHash("sha256").update(raw).digest("hex"),
    UNCRUSTABLES_DONOR_MANIFEST_SHA256,
  );
  const parsed = manifest();
  assert.equal(parsed.selected_donor_ids.length, 16);
  assert.equal(parsed.donors.length, 16);
  assert.equal(parsed.aliases.length, 1);
  assert.equal(
    parsed.donors.filter(
      (entry) => entry.catalog_snapshot.ingredients.action === "fill_if_missing",
    )
      .length,
    12,
  );
  assert.equal(
    parsed.donors.filter(
      (entry) => entry.catalog_snapshot.ingredients.action === "replace_exact",
    ).length,
    3,
  );
  assert.equal(
    parsed.donors.filter((entry) => entry.catalog_snapshot.upc.value === null).length,
    2,
  );
  assert.equal(parsed.aliases[0].expected_occurrences, 3);
  assert.equal(parsed.aliases[0].targets.length, 3);
  assert.equal(new Set(parsed.aliases[0].targets.map((target) => target.variation_matrix_id)).size, 3);
  const unprovenExistingUpc = parsed.donors.find(
    (entry) => entry.donor_id === "858a6915-7970-4bd5-83a3-9ba5913bf5b5",
  )!;
  assert.equal(unprovenExistingUpc.catalog_snapshot.upc.action, "verify_exact_no_write");
  assert.equal(unprovenExistingUpc.catalog_snapshot.upc.checksum_valid, true);
  assert.equal(unprovenExistingUpc.reviewed.upc_source.kind, "catalog_snapshot");
  assert.ok(
    parsed.donors.every(
      (entry) =>
        entry.reviewed.ingredients.length > 100 &&
        entry.reviewed.allergens.contains.length > 0 &&
        entry.reviewed.ingredients_source.retrieved_at === "2026-07-17" &&
        entry.reviewed.upc_source.retrieved_at === "2026-07-17",
    ),
  );
});

test("manifest parser rejects a repair set that is no longer exactly closed", () => {
  const parsed = JSON.parse(rawManifest().toString("utf8"));
  parsed.selected_donor_ids.pop();
  assert.throws(
    () => parseDonorEnrichmentManifest(parsed),
    /exactly 16 ledger-selected donor IDs/,
  );
});

test("projection fills missing facts and rejects unreviewed drift", () => {
  const parsed = manifest();
  const entry = parsed.donors.find(
    (candidate) => candidate.catalog_snapshot.upc.value === null,
  )!;
  const enriched = projectDonorEnrichment(
    { id: entry.donor_id, upc: null, ingredients: null },
    parsed,
  );
  assert.equal(enriched.upc, entry.reviewed.upc);
  assert.equal(enriched.ingredients, entry.reviewed.ingredients);

  assert.deepEqual(enriched.allergenDeclaration, entry.reviewed.allergens);

  assert.throws(
    () => projectDonorEnrichment(
      { id: entry.donor_id, upc: "051500000005", ingredients: "existing label" },
      parsed,
    ),
    /UPC does not match reviewed value or exact catalog snapshot/,
  );
});

test("projection replaces only an exact dirty ingredient value and digest", () => {
  const parsed = manifest();
  const entry = parsed.donors.find(
    (candidate) => candidate.catalog_snapshot.ingredients.action === "replace_exact",
  )!;
  const repaired = projectDonorEnrichment(
    {
      id: entry.donor_id,
      upc: entry.catalog_snapshot.upc.value,
      ingredients: entry.catalog_snapshot.ingredients.value,
    },
    parsed,
  );
  assert.equal(repaired.ingredients, entry.reviewed.ingredients);
  assert.throws(
    () => projectDonorEnrichment(
      {
        id: entry.donor_id,
        upc: entry.catalog_snapshot.upc.value,
        ingredients: `${entry.catalog_snapshot.ingredients.value} `,
      },
      parsed,
    ),
    /ingredients do not match reviewed value or exact catalog snapshot/,
  );
});

test("legacy alias changes only the reviewed selected donor ID", () => {
  const parsed = manifest();
  const reviewedAlias = parsed.aliases[0];
  const selected = selectedMixedBerryVariant();
  const result = projectSelectedVariantAliases(selected, parsed);
  assert.equal(result.replacements, 1);
  assert.equal(
    result.variant?.composition[0].research_pool_id,
    reviewedAlias.to_donor_id,
  );
  assert.equal(
    result.variant?.composition[0].product_name,
    reviewedAlias.expected_selected_product_name,
  );

  const unselected = { ...selected, idx: 0, name: "Unselected legacy" };
  const rewritten = rewriteSelectedVariantAliases({
    variantsJson: JSON.stringify([unselected, selected]),
    selectedVariantIdx: 1,
    manifest: parsed,
  });
  const variants = JSON.parse(rewritten.variantsJson) as Variant[];
  assert.equal(
    variants[0].composition[0].research_pool_id,
    reviewedAlias.from_donor_id,
  );
  assert.equal(
    variants[1].composition[0].research_pool_id,
    reviewedAlias.to_donor_id,
  );
});

test("legacy alias fails closed when selected component title changed", () => {
  assert.throws(
    () => projectSelectedVariantAliases(
      selectedMixedBerryVariant("a different product"),
      manifest(),
    ),
    /alias title mismatch/,
  );
});

test("manifest parser rejects alias target-count or digest drift", () => {
  const parsed = JSON.parse(rawManifest().toString("utf8"));
  parsed.aliases[0].expected_occurrences = 2;
  assert.throws(
    () => parseDonorEnrichmentManifest(parsed),
    /expected_occurrences must be exactly 3/,
  );

  const digestDrift = JSON.parse(rawManifest().toString("utf8"));
  digestDrift.donors.find(
    (entry: { catalog_snapshot: { ingredients: { action: string } } }) =>
      entry.catalog_snapshot.ingredients.action === "replace_exact",
  ).catalog_snapshot.ingredients.value += " ";
  assert.throws(
    () => parseDonorEnrichmentManifest(digestDrift),
    /sha256 does not match the exact UTF-8 value/,
  );
});

test("donor enrichment CLI is dry-run by default and exact-confirmation locked", () => {
  assert.equal(parseEnrichmentArgs([]).apply, false);
  assert.throws(
    () => parseEnrichmentArgs(["--apply"]),
    /Writes are locked/,
  );
  assert.throws(
    () => parseEnrichmentArgs([
      "--apply",
      "--confirm=NOT_THE_REVIEWED_PHRASE",
    ]),
    /Writes are locked/,
  );
  assert.equal(
    parseEnrichmentArgs([
      "--apply",
      "--confirm=ENRICH_UNCRUSTABLES_DONORS_AND_ALIAS",
    ]).apply,
    true,
  );
});

test("recipe backfill permits reviewed allergens on apply behind runtime preflight", () => {
  assert.equal(
    parseRecipeBackfillArgs([
      "--enrichment-manifest=reviewed.json",
      "--apply",
      "--confirm=BACKFILL_BUNDLE_RECIPES",
    ]).apply,
    true,
  );
});
