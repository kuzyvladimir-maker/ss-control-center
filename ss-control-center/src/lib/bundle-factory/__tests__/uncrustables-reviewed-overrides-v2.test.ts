import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { rulePromotionalLanguage } from "../compliance/rules/rule-8-promotional-language";
import {
  FROZEN_DELIVERY_FULL_REWRITE_SKUS,
  FULL_TEXT_REPAIR_SKUS,
  buildUncrustablesReviewedOverridesV2,
  type UncrustablesLedgerForReviewedOverrides,
} from "../repair/uncrustables-reviewed-overrides-v2";
import {
  buildRepairPlan,
  sha256,
  type DesiredRepairManifest,
} from "../repair/uncrustables-surgical";

const LEDGER_PATH =
  "data/audits/uncrustables-ledger-20260717T232140568Z-offline.json";
const BASE_PATH =
  "data/repairs/uncrustables-reviewed-overrides-20260717.json";
const V2_PATH =
  "data/repairs/uncrustables-reviewed-overrides-20260718-v2.json";
const DONOR_PATH =
  "data/repairs/uncrustables-donor-enrichment-20260717.json";
const PTD_PATH =
  "data/audits/amazon-food-ptd-attribute-proof-20260718T010205Z.json";

test("v2 reviewed overrides are deterministic, exact-scope, and fully gated", async () => {
  const [ledgerBytes, baseBytes, outputBytes] = await Promise.all([
    readFile(LEDGER_PATH),
    readFile(BASE_PATH),
    readFile(V2_PATH),
  ]);
  const ledger = JSON.parse(
    ledgerBytes.toString("utf8"),
  ) as UncrustablesLedgerForReviewedOverrides;
  const base = JSON.parse(baseBytes.toString("utf8")) as DesiredRepairManifest;
  const output = JSON.parse(outputBytes.toString("utf8")) as DesiredRepairManifest;
  assert.deepEqual(
    output,
    buildUncrustablesReviewedOverridesV2({ ledger, baseManifest: base }),
  );
  assert.equal(output.repairs.length, 10);

  const fullTextRepairs = output.repairs
    .filter((repair) => repair.text_count?.title)
    .map((repair) => repair.sku)
    .sort();
  assert.deepEqual(fullTextRepairs, [...FULL_TEXT_REPAIR_SKUS].sort());
  for (const sku of FROZEN_DELIVERY_FULL_REWRITE_SKUS) {
    const repair = output.repairs.find((candidate) => candidate.sku === sku);
    assert.equal(repair?.review?.confidence, "HIGH", sku);
    assert.equal(repair?.text_count?.bullets?.length, 5, sku);
    assert.ok(repair?.text_count?.description, sku);
    assert.equal(
      rulePromotionalLanguage({
        title: repair?.text_count?.title ?? "",
        bullets: repair?.text_count?.bullets ?? [],
        description: repair?.text_count?.description ?? "",
        brand: "Uncrustables",
        bundle_components: [],
        skip_image_check: true,
      }).passed,
      true,
      sku,
    );
  }

  const kp = output.repairs.find((repair) => repair.sku === "KP-ASYC-RN84");
  assert.equal(kp?.text_count?.request_product_type, "GROCERY");
  assert.equal(kp?.text_count?.expected_product_type, "GROCERY");
  assert.equal(kp?.text_count?.fallback?.request_product_type, "PASTRY");
  assert.equal(kp?.text_count?.fallback?.unit_count, 252);
  assert.equal(kp?.text_count?.fallback?.unit_count_type, "Ounce");
  assert.equal(kp?.text_count?.fallback?.number_of_items, 90);
  assert.match(kp?.text_count?.title ?? "", /90 Count$/);
});

test("v2 plan keeps KP full text/fallback compatible with its structured action", async () => {
  const [ledgerBytes, manifestBytes, donorBytes, ptdBytes] = await Promise.all([
    readFile(LEDGER_PATH),
    readFile(V2_PATH),
    readFile(DONOR_PATH),
    readFile(PTD_PATH),
  ]);
  const plan = buildRepairPlan({
    ledgerPath: LEDGER_PATH,
    ledgerBytes,
    manifest: JSON.parse(manifestBytes.toString("utf8")) as DesiredRepairManifest,
    donorManifest: { path: DONOR_PATH, bytes: donorBytes },
    ptdProof: { path: PTD_PATH, bytes: ptdBytes },
    createdAt: new Date("2026-07-18T04:50:00.000Z"),
  });
  assert.equal(plan.source_ledger.sha256, sha256(ledgerBytes));
  assert.equal(plan.scope.entries, 164);
  // The immutable 167-row creation ledger contains three failed creation
  // attempts with no ASIN. They are intentionally retained as blockers and
  // are outside the 164 existing listings in this repair scope.
  assert.equal(plan.scope.blocked, 3);
  assert.deepEqual(
    plan.blockers.map((blocker) => blocker.sku).sort(),
    ["CV-ASQK-4P65", "PV-ASZG-X763", "SV-AS9L-DRRH"],
  );
  assert.equal(
    plan.entries.flatMap((entry) => entry.actions)
      .filter((action) => action.kind === "TEXT_COUNT").length,
    9,
  );

  const kp = plan.entries.find((entry) => entry.sku === "KP-ASYC-RN84");
  assert.ok(kp);
  assert.deepEqual(
    kp.actions.map((action) => action.kind),
    ["OFFER", "TEXT_COUNT", "STRUCTURED_ATTRIBUTES"],
  );
  const text = kp.actions.find((action) => action.kind === "TEXT_COUNT");
  const structured = kp.actions.find(
    (action) => action.kind === "STRUCTURED_ATTRIBUTES",
  );
  assert.ok(text?.desired.kind === "TEXT_COUNT");
  assert.equal(text.desired.value.request_product_type, "GROCERY");
  assert.equal(text.desired.value.fallback?.request_product_type, "PASTRY");
  assert.ok(text.desired.value.title);
  assert.equal(text.desired.value.bullets?.length, 5);
  assert.ok(text.desired.value.description);
  assert.ok(structured?.desired.kind === "STRUCTURED_ATTRIBUTES");
  assert.ok(structured.desired.value.ingredients.length > 0);
  assert.ok(structured.desired.value.allergen_information.length > 0);
});
