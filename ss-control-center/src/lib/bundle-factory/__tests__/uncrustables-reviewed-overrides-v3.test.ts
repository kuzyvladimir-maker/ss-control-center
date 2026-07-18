import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";

import {
  buildUncrustablesReviewedOverridesV3,
  type AmazonFoodPtdEvidenceForFullFactualRewrite,
  type FullFactualRewriteSources,
  type UncrustablesDonorEvidenceForFullFactualRewrite,
  type UncrustablesFactualContentAudit,
  type UncrustablesLedgerForFullFactualRewrite,
  type UncrustablesReviewedOverridesV3Manifest,
} from "../repair/uncrustables-reviewed-overrides-v3";
import { hasExcessiveAmazonTitleWordFrequency } from
  "../repair/uncrustables-content";
import {
  sha256,
  type DesiredRepairManifest,
} from "../repair/uncrustables-surgical";

const PATHS = {
  ledger: "data/audits/uncrustables-ledger-20260717T232140568Z-offline.json",
  prior_reviewed_overrides:
    "data/repairs/uncrustables-reviewed-overrides-20260718-v2.json",
  donor_manifest: "data/repairs/uncrustables-donor-enrichment-20260717.json",
  ptd_attribute_proof:
    "data/audits/amazon-food-ptd-attribute-proof-20260718T010205Z.json",
  owner_fulfillment_handoff: "../HANDOFF_Uncrustables_2026-07-17.md",
  frozen_cost_model: "src/lib/pricing/cost-model.ts",
  frozen_image_policy: "src/lib/bundle-factory/image-pipeline.ts",
  renderer: "src/lib/bundle-factory/repair/uncrustables-content.ts",
} as const;
const MANIFEST_PATH =
  "data/repairs/uncrustables-reviewed-overrides-20260718-v3-r6.json";
const MANIFEST_SHA256 =
  "f5df324ecc5b48c9de9549a980f0703dbdd83ec2c01e64a19e7204feb2fa0b06";
const AUDIT_PATH =
  "data/audits/uncrustables-factual-content-audit-20260718-v6.json";
const AUDIT_SHA256 =
  "6e5338549db5eb6c3d9ab2cbe4388ecac44001415e7b7aa8dde1763328e318e6";
const SUPERSEDED_MANIFEST_PATH =
  "data/repairs/uncrustables-reviewed-overrides-20260718-v3-r5.json";
const SUPERSEDED_AUDIT_PATH =
  "data/audits/uncrustables-factual-content-audit-20260718-v5.json";

async function sourceInputs(): Promise<{
  bytes: Record<keyof typeof PATHS, Buffer>;
  sources: FullFactualRewriteSources;
}> {
  const entries = await Promise.all(
    Object.entries(PATHS).map(async ([role, file]) => [role, await readFile(file)] as const),
  );
  const bytes = Object.fromEntries(entries) as Record<keyof typeof PATHS, Buffer>;
  const unlocatedSources = Object.fromEntries(
    Object.entries(PATHS).map(([role, file]) => [
      role,
      { path: file, sha256: sha256(bytes[role as keyof typeof PATHS]) },
    ]),
  );
  const sources = {
    ...unlocatedSources,
    owner_fulfillment_handoff: {
      ...unlocatedSources.owner_fulfillment_handoff,
      locator: "line 19" as const,
    },
  } as FullFactualRewriteSources;
  return { bytes, sources };
}

test("all-164 v3-r6 manifest and factual audit v6 are exact deterministic artifacts", async () => {
  const { bytes, sources } = await sourceInputs();
  const [manifestBytes, auditBytes, manifestSidecar, auditSidecar] = await Promise.all([
    readFile(MANIFEST_PATH),
    readFile(AUDIT_PATH),
    readFile(`${MANIFEST_PATH}.sha256`, "utf8"),
    readFile(`${AUDIT_PATH}.sha256`, "utf8"),
  ]);
  assert.equal(
    manifestSidecar,
    `${sha256(manifestBytes)}  ${path.basename(MANIFEST_PATH)}\n`,
  );
  assert.equal(auditSidecar, `${sha256(auditBytes)}  ${path.basename(AUDIT_PATH)}\n`);
  assert.equal(sha256(manifestBytes), MANIFEST_SHA256);
  assert.equal(sha256(auditBytes), AUDIT_SHA256);

  const built = buildUncrustablesReviewedOverridesV3({
    ledger: JSON.parse(
      bytes.ledger.toString("utf8"),
    ) as UncrustablesLedgerForFullFactualRewrite,
    priorManifest: JSON.parse(
      bytes.prior_reviewed_overrides.toString("utf8"),
    ) as DesiredRepairManifest,
    donorManifest: JSON.parse(
      bytes.donor_manifest.toString("utf8"),
    ) as UncrustablesDonorEvidenceForFullFactualRewrite,
    ptdProof: JSON.parse(
      bytes.ptd_attribute_proof.toString("utf8"),
    ) as AmazonFoodPtdEvidenceForFullFactualRewrite,
    fulfillmentHandoffText: bytes.owner_fulfillment_handoff.toString("utf8"),
    sources,
  });
  assert.deepEqual(JSON.parse(manifestBytes.toString("utf8")), built.manifest);
  assert.deepEqual(JSON.parse(auditBytes.toString("utf8")), built.audit);
});

test("all 164 customer-facing rewrites are exact, commercial, and fail-closed", async () => {
  const manifest = JSON.parse(
    await readFile(MANIFEST_PATH, "utf8"),
  ) as UncrustablesReviewedOverridesV3Manifest;
  const audit = JSON.parse(
    await readFile(AUDIT_PATH, "utf8"),
  ) as UncrustablesFactualContentAudit;
  assert.equal(manifest.repairs.length, 164);
  assert.equal(new Set(manifest.repairs.map((repair) => repair.sku)).size, 164);
  assert.equal(manifest.reviewed_at, "2026-07-18T05:55:00.000Z");
  assert.deepEqual(manifest.supersedes, [
    {
      path: SUPERSEDED_MANIFEST_PATH,
      sha256: "3cd84d9c0b467d40f9565c0f0633c0f7202f30789d2ececf45deec0bc987b1fc",
      status: "SUPERSEDED_DO_NOT_APPLY",
      reason: "FUTURE_REVIEW_TIMESTAMP",
    },
  ]);
  assert.equal(audit.created_at, "2026-07-18T05:55:00.000Z");
  assert.deepEqual(audit.supersedes, [
    {
      path: SUPERSEDED_AUDIT_PATH,
      sha256: "71636419eb377804076fefa0e6443c8bcdc043b909cfbe20d9369a3e89eb662e",
      status: "SUPERSEDED_DO_NOT_APPLY",
      reason: "FUTURE_REVIEW_TIMESTAMP",
    },
  ]);
  assert.deepEqual(audit.summary, {
    source_rows: 167,
    live_rows: 164,
    historical_missing_asin_rows: 3,
    full_rewrites: 164,
    single_flavor_rows: 90,
    mixed_flavor_rows: 74,
    category_counts: {
      PER_ITEM_OR_PACKAGE_WEIGHT: 117,
      NUMERIC_PROTEIN_OR_NUTRITION: 47,
      HANDLING_DURATION_OR_TEMPERATURE: 157,
      FORMULATION_GENERALIZATION: 147,
      ALLERGEN_PROSE: 8,
      FROZEN_DELIVERY_PROMISE: 8,
    },
    retained_12g_subline_rows: 40,
    format_failures_after: 0,
    semantic_failures_after: 0,
    compliance_failures_after: 0,
    unsupported_claim_failures_after: 0,
  });
  assert.equal(audit.policy.owner_fulfillment_source_pinned, true);
  assert.equal(
    audit.sources.owner_fulfillment_handoff.sha256,
    "8ca9bb574a7d940b636871bb1fdfe1c0d6b88bbb39c9833812493f8746bb7841",
  );
  assert.deepEqual(
    audit.skipped_rows.map((row) => row.sku),
    ["CV-ASQK-4P65", "PV-ASZG-X763", "SV-AS9L-DRRH"],
  );

  for (const repair of manifest.repairs) {
    assert.equal(repair.review?.confidence, "HIGH", repair.sku);
    assert.ok(
      repair.review?.evidence.some((entry) =>
        entry.includes("8ca9bb574a7d940b636871bb1fdfe1c0d6b88bbb39c9833812493f8746bb7841")
      ),
      repair.sku,
    );
    assert.ok(repair.text_count?.title, repair.sku);
    assert.equal(repair.text_count?.bullets?.length, 5, repair.sku);
    assert.ok(repair.text_count?.description, repair.sku);
    assert.ok((repair.text_count?.title?.length ?? 0) <= 200, repair.sku);
    assert.equal(
      hasExcessiveAmazonTitleWordFrequency(repair.text_count?.title ?? ""),
      false,
      repair.sku,
    );
    assert.ok(
      repair.text_count?.bullets?.every(
        (bullet) => bullet.length < 255 && !/^[A-Z][A-Z -]+:/.test(bullet),
      ),
      repair.sku,
    );
    const corpus = [
      repair.text_count?.title,
      ...(repair.text_count?.bullets ?? []),
      repair.text_count?.description,
    ].join("\n");
    assert.doesNotMatch(corpus, /Salutem|curated|gift (?:set|basket)|affiliated|authorized/i);
    assert.doesNotMatch(
      corpus,
      /\b(?:\d+(?:\.\d+)?\s*(?:oz|ounces?)|calories?|fat|sodium|sugar|preservatives?|allergen-free|ships?|shipped|shipping|delivered|arrives?|\d+\s*(?:minutes?|hours?|days?)|0\s*(?:degrees|°)|microwave|refreeze)\b/i,
    );
  }

  assert.ok(
    audit.rows.every((row) =>
      row.cold_pack_evidence.owner_fulfillment_handoff.sha256 ===
        "8ca9bb574a7d940b636871bb1fdfe1c0d6b88bbb39c9833812493f8746bb7841" &&
      row.cold_pack_evidence.owner_fulfillment_handoff.locator === "line 19" &&
      row.cold_pack_evidence.owner_fulfillment_handoff.claim ===
        "BRANDED_COOLER_AND_GEL_PACKS"
    ),
  );

  const kp = manifest.repairs.find((repair) => repair.sku === "KP-ASYC-RN84");
  assert.deepEqual(
    {
      unit_count: kp?.text_count?.unit_count,
      unit_count_type: kp?.text_count?.unit_count_type,
      number_of_items: kp?.text_count?.number_of_items,
      request_product_type: kp?.text_count?.request_product_type,
      expected_product_type: kp?.text_count?.expected_product_type,
      must_clear_issue_codes: kp?.text_count?.must_clear_issue_codes,
      fallback: kp?.text_count?.fallback,
    },
    {
      unit_count: 252,
      unit_count_type: "Ounce",
      number_of_items: 90,
      request_product_type: "PASTRY",
      expected_product_type: "PASTRY",
      must_clear_issue_codes: ["90244"],
      fallback: undefined,
    },
  );

  const sz = manifest.repairs.find((repair) => repair.sku === "SZ-ASPI-JFAT");
  assert.equal(sz?.text_count?.unit_count, 24);
  assert.equal(sz?.offer?.consumer_price, 76.99);
  assert.equal(sz?.structured_attributes?.is_expiration_dated_product, true);
  const vn = manifest.repairs.find((repair) => repair.sku === "VN-AS1A-D572");
  assert.equal(vn?.text_count?.unit_count, 45);
  assert.equal(vn?.structured_attributes?.each_unit_count_absent, true);
  const az = manifest.repairs.find((repair) => repair.sku === "AZ-ASMY-VEQ2");
  assert.ok(az?.structured_attributes?.merchant_shipping_group);
});

test("r5 to r6 preserves every customer-facing repair byte-for-byte", async () => {
  const [r5, r6, auditV5, auditV6] = await Promise.all([
    readFile(SUPERSEDED_MANIFEST_PATH, "utf8").then(JSON.parse) as Promise<DesiredRepairManifest>,
    readFile(MANIFEST_PATH, "utf8").then(JSON.parse) as Promise<UncrustablesReviewedOverridesV3Manifest>,
    readFile(SUPERSEDED_AUDIT_PATH, "utf8").then(JSON.parse) as Promise<UncrustablesFactualContentAudit>,
    readFile(AUDIT_PATH, "utf8").then(JSON.parse) as Promise<UncrustablesFactualContentAudit>,
  ]);
  const customerPayload = (manifest: DesiredRepairManifest) =>
    manifest.repairs.map(({ sku, media, offer, text_count, structured_attributes }) => ({
      sku,
      media,
      offer,
      text_count,
      structured_attributes,
    }));
  assert.deepEqual(customerPayload(r6), customerPayload(r5));
  assert.deepEqual(r6.repairs, r5.repairs);
  assert.deepEqual(auditV6.sources, auditV5.sources);
  assert.deepEqual(auditV6.policy, auditV5.policy);
  assert.deepEqual(auditV6.summary, auditV5.summary);
  assert.deepEqual(auditV6.rows, auditV5.rows);
  assert.deepEqual(auditV6.skipped_rows, auditV5.skipped_rows);
});
