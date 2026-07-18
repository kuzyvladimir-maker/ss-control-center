// npx tsx --test src/lib/bundle-factory/__tests__/uncrustables-catalog-title-alignment.test.ts

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  prepareCatalogIdentityDecision,
  prepareCatalogTitleAlignment,
  REVIEWED_CATALOG_EVIDENCE_BODY_SHA256,
  REVIEWED_CATALOG_EVIDENCE_FILE_SHA256,
  writeCatalogIdentityDecisionArtifact,
  writeCatalogTitleAlignmentArtifact,
} from "../repair/uncrustables-catalog-title-alignment";
import {
  CHECKPOINT_SCHEMA,
  DESIRED_MANIFEST_SCHEMA,
  REPAIR_PLAN_SCHEMA,
  sha256,
  stableJson,
  type CheckpointEvent,
  type DesiredTextCountRepair,
  type UncrustablesRepairPlan,
} from "../repair/uncrustables-surgical";

const SKU = "UT-AS01-GRAPE";
const ASIN = "B0H1234567";
const DESIRED_TITLE =
  "Smucker's Uncrustables Peanut Butter & Grape Jelly Frozen Sandwiches, Individually Wrapped, 24 Count";
const CATALOG_TITLE =
  "Uncrustables Peanut Butter & Grape Jelly Frozen Sandwiches, 2 oz Each, 24 Count";
const REVIEWED_AT = "2026-07-18T08:00:00.000Z";
const KP_SKU = "KP-ASYC-RN84";
const KP_ASIN = "B0H83FYZR3";
const KP_DESIRED_TITLE =
  "Smucker's Uncrustables Peanut Butter & Blueberry Frozen Sandwiches, Individually Wrapped, 90 Count";
const KP_CATALOG_TITLE =
  "Uncrustables Peanut Butter & Blueberry Frozen Sandwiches, 2.8 oz Each, 90 Count";
const KD_SKU = "KD-AS12-8HZ3";
const KD_ASIN = "B0H845JBM6";
const KD_DESIRED_TITLE =
  "Smucker's Uncrustables Frozen Sandwich Variety Pack, Peanut Butter & Strawberry Jam – 12g Protein and Morning Protein Peanut Butter & Mixed Berry Spread, 24 Count";
const KD_CATALOG_TITLE =
  "Uncrustables Frozen Crustless Sandwiches, Peanut Butter & Strawberry Jam Protein and Peanut Butter & Mixed Berry, 2.8 oz, 24 Count";
const KD_COMPONENTS = [
  {
    product_name:
      "Smucker's Uncrustables Frozen Peanut Butter & Strawberry Jam Sandwich – 12g Protein 22.4oz/8ct",
    qty: 12,
  },
  {
    product_name:
      "Smucker's Uncrustables Morning Protein Peanut Butter & Mixed Berry Spread Sandwich - 22.4oz/8ct",
    qty: 12,
  },
];

interface FixtureOptions {
  sku?: string;
  asin?: string;
  desiredTitle?: string;
  count?: number;
  components?: Array<{ product_name: string; qty: number }>;
  catalogTitle?: string;
  errorIssue?: Record<string, unknown>;
  omitCheckpoint?: boolean;
  tamperCheckpoint?: boolean;
  issueCode?: string;
  reviewedCatalogEvidence?: boolean;
}

interface Fixture {
  root: string;
  planPath: string;
  plan: UncrustablesRepairPlan;
  planFileSha256: string;
  manifestPath: string;
  manifestFileSha256: string;
  checkpointDirectory: string;
  manifest: Record<string, unknown> & { repairs: Array<Record<string, unknown>> };
  catalogEvidencePath?: string;
  catalogEvidenceFileSha256?: string;
  catalogEvidenceBodySha256?: string;
}

function bodySeal(value: Record<string, unknown>): string {
  return sha256(stableJson(value));
}

function catalogIssue(
  catalogTitle: string,
  code = "8541",
  identity: { asin?: string; desiredTitle?: string } = {},
): Record<string, unknown> {
  const asin = identity.asin ?? ASIN;
  const desiredTitle = identity.desiredTitle ?? DESIRED_TITLE;
  return {
    code,
    message:
      `The Listing data provided is different from what's already in the Amazon catalog. ` +
      `The standard product ids provided matches ASIN ${asin}, but some listing data contradicts the Amazon catalog. ` +
      `The following listing attribute value(s) conflict with Amazon catalog value(s): ` +
      `'item_name' (Merchant [en_US: \"${desiredTitle}\"] / Amazon [en_US: \"${catalogTitle}\"]). ` +
      `Update item_name to match the Amazon catalog.`,
    severity: "ERROR",
    attributeNames: ["item_name"],
    categories: ["INVALID_ATTRIBUTE"],
  };
}

function textRepair(): Record<string, unknown> {
  return {
    title: DESIRED_TITLE,
    bullets: [
      "Exact assortment: 24 individually wrapped frozen sandwiches total: 24 Peanut Butter & Grape Jelly.",
      "Cold-pack components: An insulated foam cooler and frozen gel packs accompany the sandwiches; the stated 24 Count refers only to individual sandwiches.",
      "Original wrappers: Every sandwich remains sealed in its original individual manufacturer wrapper, and the assortment contains only the variety stated above.",
      "Handling guidance: Keep frozen and follow the preparation and handling directions printed on each original wrapper.",
      "Bundle details: The outer cooler and gel packs are shipping components and are not included in the stated sandwich count.",
    ],
    description:
      "This bundle contains exactly 24 Peanut Butter & Grape Jelly Uncrustables sandwiches in original individual wrappers, plus a foam cooler and frozen gel packs.",
    unit_count: 24,
    unit_count_type: "Count",
    number_of_items: 24,
  };
}

async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
  const fixtureSku = options.sku ?? SKU;
  const fixtureAsin = options.asin ?? ASIN;
  const fixtureDesiredTitle = options.desiredTitle ?? DESIRED_TITLE;
  const fixtureComponents = options.components ?? [
    {
      product_name:
        "Smucker's Uncrustables Frozen Peanut Butter & Grape Jelly Sandwich - 8oz/4ct",
      qty: 24,
    },
  ];
  const fixtureCount = options.count ?? 24;
  const fixtureText = {
    ...textRepair(),
    title: fixtureDesiredTitle,
    unit_count: fixtureCount,
    number_of_items: fixtureCount,
  };
  const root = await mkdtemp(path.join(tmpdir(), "catalog-title-alignment-"));
  const ledgerPath = path.join(root, "ledger.json");
  const manifestPath = path.join(root, "desired.json");
  const planPath = path.join(root, "plan.json");
  const checkpointDirectory = path.join(root, "checkpoints");
  const ledger = {
    schema_version: "uncrustables-ledger/v1.2",
    audit_id: "UL-CATALOG-TITLE-TEST",
    complete: true,
    immutable: true,
    mode: "live",
    external_mutations: false,
    completed_at: "2026-07-18T07:55:00.000Z",
    rows: [
      {
        sku: fixtureSku,
        asin: fixtureAsin,
        canonical: {
          components: fixtureComponents,
        },
      },
    ],
  };
  const ledgerBytes = Buffer.from(`${JSON.stringify(ledger, null, 2)}\n`);
  await writeFile(ledgerPath, ledgerBytes);
  const ledgerSha256 = sha256(ledgerBytes);

  const repair = {
    sku: fixtureSku,
    review: {
      confidence: "HIGH",
      rationale: "Exact recipe-grounded customer copy was reviewed.",
      evidence: [`Ledger ${ledgerSha256}.`],
    },
    text_count: fixtureText,
    offer: {
      currency: "USD",
      consumer_price: 76.99,
      business_price: 76.99,
      minimum_seller_allowed_price: 66.95,
      maximum_seller_allowed_price: 76.99,
      discounted_price_absent: true,
      list_price_absent: true,
    },
  };
  const manifestBody = {
    schema_version: DESIRED_MANIFEST_SCHEMA,
    immutable: true,
    reviewed_at: "2026-07-18T07:56:00.000Z",
    source_ledger_sha256: ledgerSha256,
    source_artifacts: { synthetic: true },
    supersedes: [],
    merge_summary: { final_repairs: 1 },
    repairs: [repair],
  };
  const manifest = {
    ...manifestBody,
    body_sha256: bodySeal(manifestBody),
  } as Record<string, unknown> & { repairs: Array<Record<string, unknown>> };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(manifestPath, manifestBytes);
  const manifestFileSha256 = sha256(manifestBytes);

  const planBody: Omit<UncrustablesRepairPlan, "sha256"> = {
    schema_version: REPAIR_PLAN_SCHEMA,
    immutable: true,
    plan_id: "URP-CATALOG-TITLE-TEST",
    created_at: "2026-07-18T07:57:00.000Z",
    source_ledger: {
      path: ledgerPath,
      sha256: ledgerSha256,
      audit_id: "UL-CATALOG-TITLE-TEST",
      schema_version: "uncrustables-ledger/v1.2",
      completed_at: "2026-07-18T07:55:00.000Z",
    },
    desired_manifest_source: {
      path: manifestPath,
      sha256: manifestFileSha256,
      schema_version: DESIRED_MANIFEST_SCHEMA,
      reviewed_at: "2026-07-18T07:56:00.000Z",
      source_ledger_sha256: ledgerSha256,
    },
    media_asset_source: null,
    structured_attribute_source: null,
    policy: {
      marketplace_id: "ATVPDKIKX0DER",
      patch_only: true,
      validation_preview_required: true,
      post_get_verification_required: true,
      business_price_equals_consumer_price: true,
      discounted_price_absent: true,
      list_price_absent: true,
      structured_attributes_donor_reviewed: true,
      structured_attributes_ptd_proof_required: true,
      ingredient_keyword_allergen_inference: false,
      shelf_life_mutation: false,
      inventory_mutation: false,
      nutrition_mutation: false,
      brand_card_url: "https://cdn.example.com/card.jpg",
      verified_brand_card_rehost_url:
        "https://m.media-amazon.com/images/I/81OibsvvU0L.jpg",
    },
    scope: {
      requested_skus: [fixtureSku],
      limit: null,
      ledger_rows_considered: 1,
      entries: 1,
      actions: 1,
      blocked: 0,
    },
    semantic_audit: {
      validator: "validateSemanticOutput",
      checked: 1,
      passed: 1,
      failed: 0,
      repaired_by_manifest: 1,
      repaired_deterministically: 0,
      blocked: 0,
      failures: [],
    },
    entries: [
      {
        sku: fixtureSku,
        asin: fixtureAsin,
        store_index: 1,
        audited_product_type: "GROCERY",
        actions: [
          {
            action_id: `${fixtureSku}:text_count`,
            kind: "TEXT_COUNT",
            reasons: ["EXPLICIT_REVIEWED_TEXT_COUNT_MANIFEST"],
            review: repair.review as {
              confidence: "HIGH";
              rationale: string;
              evidence: string[];
            },
            desired: {
              kind: "TEXT_COUNT",
              value: fixtureText,
            },
          },
        ],
      },
    ],
    blockers: [],
  };
  const plan: UncrustablesRepairPlan = {
    ...planBody,
    sha256: sha256(stableJson(planBody)),
  };
  const planBytes = Buffer.from(`${JSON.stringify(plan, null, 2)}\n`);
  await writeFile(planPath, planBytes);
  const planFileSha256 = sha256(planBytes);

  await mkdir(checkpointDirectory, { recursive: true });
  if (!options.omitCheckpoint) {
    const response = {
      status: "INVALID",
      submission_id: "submission-title-test",
      issues: [
        options.errorIssue ??
          catalogIssue(options.catalogTitle ?? CATALOG_TITLE, options.issueCode, {
            asin: fixtureAsin,
            desiredTitle: fixtureDesiredTitle,
          }),
      ],
    };
    const eventBody: Omit<CheckpointEvent, "sha256"> = {
      schema_version: CHECKPOINT_SCHEMA,
      immutable: true,
      event_id: "checkpoint-title-test",
      created_at: "2026-07-18T07:58:00.000Z",
      plan_sha256: plan.sha256,
      action_id: `${fixtureSku}:text_count`,
      sku: fixtureSku,
      kind: "TEXT_COUNT",
      status: "FAILED",
      detail: {
        error: `VALIDATION_PREVIEW rejected ${fixtureSku}:text_count: ${JSON.stringify(response)}`,
      },
    };
    const event: CheckpointEvent = {
      ...eventBody,
      sha256: options.tamperCheckpoint
        ? "0".repeat(64)
        : sha256(stableJson(eventBody)),
    };
    await writeFile(
      path.join(checkpointDirectory, "checkpoint.json"),
      `${JSON.stringify(event, null, 2)}\n`,
    );
  }
  let catalogEvidencePath: string | undefined;
  if (options.reviewedCatalogEvidence) {
    catalogEvidencePath = path.join(root, "reviewed-catalog-evidence.json");
    const reviewedEvidencePath = path.resolve(
      "data/audits/uncrustables-catalog-title-api-evidence-20260718T065137Z.json",
    );
    await writeFile(catalogEvidencePath, await readFile(reviewedEvidencePath));
  }
  return {
    root,
    planPath,
    plan,
    planFileSha256,
    manifestPath,
    manifestFileSha256,
    checkpointDirectory,
    manifest,
    ...(catalogEvidencePath
      ? {
          catalogEvidencePath,
          catalogEvidenceFileSha256: REVIEWED_CATALOG_EVIDENCE_FILE_SHA256,
          catalogEvidenceBodySha256: REVIEWED_CATALOG_EVIDENCE_BODY_SHA256,
        }
      : {}),
  };
}

function prepare(input: Fixture) {
  return prepareCatalogTitleAlignment({
    planPath: input.planPath,
    expectedPlanInternalSha256: input.plan.sha256,
    expectedPlanFileSha256: input.planFileSha256,
    desiredManifestPath: input.manifestPath,
    expectedDesiredManifestFileSha256: input.manifestFileSha256,
    checkpointDirectory: input.checkpointDirectory,
    ...(input.catalogEvidencePath
      ? {
          catalogEvidencePath: input.catalogEvidencePath,
          expectedCatalogEvidenceFileSha256: input.catalogEvidenceFileSha256,
          expectedCatalogEvidenceBodySha256: input.catalogEvidenceBodySha256,
        }
      : {}),
    reviewedAt: REVIEWED_AT,
    requiredManifestRows: 1,
  });
}

async function kpDependencyFixture(options: {
  includeWarning?: boolean;
  textPreviewValid?: boolean;
} = {}): Promise<Fixture> {
  const base = await fixture();
  const ledgerPath = path.join(base.root, "ledger.json");
  const kpText: DesiredTextCountRepair = {
    ...textRepair(),
    title: KP_DESIRED_TITLE,
    bullets: [
      "Exact assortment: 90 individually wrapped frozen sandwiches total: 90 Peanut Butter & Blueberry.",
      "Cold-pack components: An insulated foam cooler and frozen gel packs accompany the sandwiches; the stated 90 Count refers only to individual sandwiches.",
      "Original wrappers: Every sandwich remains sealed in its original individual manufacturer wrapper, and the assortment contains only the variety stated above.",
      "Handling guidance: Keep frozen and follow the preparation and handling directions printed on each original wrapper.",
      "Bundle details: The outer cooler and gel packs are shipping components and are not included in the stated sandwich count.",
    ],
    description:
      "This bundle contains exactly 90 Peanut Butter & Blueberry Uncrustables sandwiches in original individual wrappers, plus a foam cooler and frozen gel packs.",
    unit_count: 252,
    unit_count_type: "Ounce",
    number_of_items: 90,
    request_product_type: "PASTRY",
    expected_product_type: "PASTRY",
    must_clear_issue_codes: ["90244"],
  };
  const ledger = {
    schema_version: "uncrustables-ledger/v1.2",
    audit_id: "UL-KP-DEPENDENCY-TEST",
    complete: true,
    immutable: true,
    mode: "live",
    external_mutations: false,
    completed_at: "2026-07-18T07:55:00.000Z",
    rows: [
      {
        sku: KP_SKU,
        asin: KP_ASIN,
        canonical: {
          components: [
            {
              product_name:
                "Smucker's Uncrustables Frozen Peanut Butter & Blueberry Sandwich - 22.4oz/8ct",
              qty: 90,
            },
          ],
        },
      },
    ],
  };
  const ledgerBytes = Buffer.from(`${JSON.stringify(ledger, null, 2)}\n`);
  await writeFile(ledgerPath, ledgerBytes);
  const ledgerSha256 = sha256(ledgerBytes);
  const review = {
    confidence: "HIGH" as const,
    rationale: "Exact KP PASTRY strategy and recipe-grounded customer copy were reviewed.",
    evidence: [`Ledger ${ledgerSha256}.`],
  };
  const repair = {
    sku: KP_SKU,
    review,
    text_count: kpText,
    media: { main_image_url: "https://cdn.example.com/kp-main.jpg" },
    offer: {
      currency: "USD" as const,
      consumer_price: 252.99,
      business_price: 252.99,
      minimum_seller_allowed_price: 219.57,
      maximum_seller_allowed_price: 252.99,
      discounted_price_absent: true as const,
      list_price_absent: true as const,
    },
  };
  const manifestBody = {
    schema_version: DESIRED_MANIFEST_SCHEMA,
    immutable: true,
    reviewed_at: "2026-07-18T07:56:00.000Z",
    source_ledger_sha256: ledgerSha256,
    source_artifacts: { synthetic: true },
    supersedes: [],
    merge_summary: { final_repairs: 1 },
    repairs: [repair],
  };
  const manifest = {
    ...manifestBody,
    body_sha256: bodySeal(manifestBody),
  } as Record<string, unknown> & { repairs: Array<Record<string, unknown>> };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(base.manifestPath, manifestBytes);
  const manifestFileSha256 = sha256(manifestBytes);
  const actions: UncrustablesRepairPlan["entries"][number]["actions"] = [
    {
      action_id: `${KP_SKU}:text_count`,
      kind: "TEXT_COUNT",
      reasons: ["EXPLICIT_REVIEWED_TEXT_COUNT_MANIFEST"],
      review,
      desired: { kind: "TEXT_COUNT", value: kpText },
    },
    {
      action_id: `${KP_SKU}:media`,
      kind: "MEDIA",
      reasons: ["EXPLICIT_REVIEWED_MEDIA_MANIFEST"],
      review,
      desired: {
        kind: "MEDIA",
        value: {
          main_image_url: "https://cdn.example.com/kp-main.jpg",
          gallery_slots: [],
        },
      },
    },
    {
      action_id: `${KP_SKU}:offer`,
      kind: "OFFER",
      reasons: ["EXPLICIT_REVIEWED_OFFER_MANIFEST"],
      review,
      desired: { kind: "OFFER", value: repair.offer },
    },
  ];
  const originalPlan = base.plan;
  const { sha256: _originalPlanSha256, ...originalPlanBody } = originalPlan;
  const planBody: Omit<UncrustablesRepairPlan, "sha256"> = {
    ...originalPlanBody,
    plan_id: "URP-KP-DEPENDENCY-TEST",
    source_ledger: {
      ...originalPlan.source_ledger,
      path: ledgerPath,
      sha256: ledgerSha256,
      audit_id: "UL-KP-DEPENDENCY-TEST",
    },
    desired_manifest_source: {
      path: base.manifestPath,
      sha256: manifestFileSha256,
      schema_version: DESIRED_MANIFEST_SCHEMA,
      reviewed_at: "2026-07-18T07:56:00.000Z",
      source_ledger_sha256: ledgerSha256,
    },
    scope: {
      ...originalPlan.scope,
      requested_skus: [KP_SKU],
      actions: 3,
    },
    entries: [
      {
        sku: KP_SKU,
        asin: KP_ASIN,
        store_index: 1,
        audited_product_type: "PASTRY",
        actions,
      },
    ],
  };
  const plan: UncrustablesRepairPlan = {
    ...planBody,
    sha256: sha256(stableJson(planBody)),
  };
  const planBytes = Buffer.from(`${JSON.stringify(plan, null, 2)}\n`);
  await writeFile(base.planPath, planBytes);
  const planFileSha256 = sha256(planBytes);

  await rm(base.checkpointDirectory, { recursive: true, force: true });
  await mkdir(base.checkpointDirectory, { recursive: true });
  async function checkpoint(input: {
    actionId: string;
    kind: CheckpointEvent["kind"];
    status: "PREVIEW_VALID" | "FAILED";
    createdAt: string;
    detail: Record<string, unknown>;
  }): Promise<void> {
    const eventBody: Omit<CheckpointEvent, "sha256"> = {
      schema_version: CHECKPOINT_SCHEMA,
      immutable: true,
      event_id: `event-${input.actionId}`,
      created_at: input.createdAt,
      plan_sha256: plan.sha256,
      action_id: input.actionId,
      sku: KP_SKU,
      kind: input.kind,
      status: input.status,
      detail: input.detail,
    };
    const event = { ...eventBody, sha256: sha256(stableJson(eventBody)) };
    await writeFile(
      path.join(base.checkpointDirectory, `${input.actionId.replaceAll(":", "-")}.json`),
      `${JSON.stringify(event, null, 2)}\n`,
    );
  }
  const kpConflict = {
    code: "8541",
    message:
      `The Listing data provided is different from what's already in the Amazon catalog. ` +
      `The standard product ids provided matches ASIN ${KP_ASIN}, but listing data contradicts the Amazon catalog. ` +
      `'item_name' (Merchant [en_US: \"${KP_DESIRED_TITLE}\"] / Amazon [en_US: \"${KP_CATALOG_TITLE}\"]).`,
    severity: "ERROR",
    attributeNames: ["item_name"],
  };
  const textPreviewValid = options.textPreviewValid ?? true;
  await checkpoint(
    textPreviewValid
      ? {
          actionId: `${KP_SKU}:text_count`,
          kind: "TEXT_COUNT",
          status: "PREVIEW_VALID",
          createdAt: "2026-07-18T07:58:00.000Z",
          detail: {
            validation_only: true,
            status: "VALID",
            submission_id: "kp-text-valid",
            patch_paths: [
              "/attributes/item_name",
              "/attributes/unit_count",
              "/attributes/number_of_items",
            ],
            issues: [],
          },
        }
      : {
          actionId: `${KP_SKU}:text_count`,
          kind: "TEXT_COUNT",
          status: "FAILED",
          createdAt: "2026-07-18T07:58:00.000Z",
          detail: {
            error: `VALIDATION_PREVIEW rejected ${KP_SKU}:text_count: ${JSON.stringify({
              status: "INVALID",
              submission_id: "kp-text-failed",
              issues: [kpConflict],
            })}`,
          },
        },
  );
  await checkpoint({
    actionId: `${KP_SKU}:media`,
    kind: "MEDIA",
    status: "FAILED",
    createdAt: "2026-07-18T07:59:00.000Z",
    detail: {
      error: `VALIDATION_PREVIEW rejected ${KP_SKU}:media: ${JSON.stringify({
        status: "INVALID",
        submission_id: "kp-media-title-conflict",
        issues: [kpConflict],
      })}`,
    },
  });
  const dependencyIssues: Record<string, unknown>[] = [
    {
      code: "90244",
      message:
        "We can't accept the Count you entered for Unit Count. Select an approved value and resubmit.",
      severity: "ERROR",
      attributeNames: ["unit_count"],
    },
  ];
  if (options.includeWarning) {
    dependencyIssues.push({
      code: "90000900",
      message: "Obsolete business_price warning.",
      severity: "WARNING",
      attributeNames: ["business_price"],
    });
  }
  await checkpoint({
    actionId: `${KP_SKU}:offer`,
    kind: "OFFER",
    status: "FAILED",
    createdAt: "2026-07-18T08:00:00.000Z",
    detail: {
      error: `VALIDATION_PREVIEW rejected ${KP_SKU}:offer: ${JSON.stringify({
        status: "INVALID",
        submission_id: "kp-offer-dependency",
        issues: dependencyIssues,
      })}`,
    },
  });
  return {
    ...base,
    plan,
    planFileSha256,
    manifestFileSha256,
    manifest,
  };
}

test("aligns only title, seals review evidence/supersedes, and writes immutable files", async (t) => {
  const input = await fixture({ issueCode: "CATALOG_VALUE_CONFLICT_V2" });
  t.after(() => rm(input.root, { recursive: true, force: true }));
  const prepared = await prepare(input);
  assert.equal(prepared.reviews.length, 1);
  const after = prepared.manifest.repairs[0];
  const before = input.manifest.repairs[0];
  assert.equal(after.text_count?.title, CATALOG_TITLE);
  assert.equal(after.review?.confidence, "HIGH");
  assert.equal(after.review?.supersedes?.[0]?.prior_value, DESIRED_TITLE);
  assert.match(after.review?.evidence.at(-1) ?? "", /checkpoint event SHA-256/i);
  assert.deepEqual(after.media, before.media);
  assert.deepEqual(after.offer, before.offer);
  assert.deepEqual(after.structured_attributes, before.structured_attributes);
  assert.deepEqual(
    { ...after.text_count, title: undefined },
    { ...(before.text_count as Record<string, unknown>), title: undefined },
  );
  const written = await writeCatalogTitleAlignmentArtifact(
    path.join(input.root, "output"),
    prepared,
  );
  assert.equal(sha256(await readFile(written.manifestPath)), written.fileSha256);
  assert.equal(
    (await readFile(written.sidecarPath, "utf8")).trim(),
    `${written.fileSha256}  ${path.basename(written.manifestPath)}`,
  );
});

test("uses the separately recorded exact KD Catalog API evidence override without weakening the generic gate", async (t) => {
  const input = await fixture({
    sku: KD_SKU,
    asin: KD_ASIN,
    desiredTitle: KD_DESIRED_TITLE,
    catalogTitle: KD_CATALOG_TITLE,
    components: KD_COMPONENTS,
    reviewedCatalogEvidence: true,
  });
  t.after(() => rm(input.root, { recursive: true, force: true }));
  const prepared = await prepare(input);
  assert.equal(prepared.reviews.length, 1);
  assert.equal(prepared.reviews[0].sku, KD_SKU);
  assert.equal(prepared.reviews[0].identity_validation, "REVIEWED_CATALOG_API_EVIDENCE");
  assert.equal(
    prepared.reviews[0].reviewed_catalog_override?.catalog_evidence_file_sha256,
    REVIEWED_CATALOG_EVIDENCE_FILE_SHA256,
  );
  assert.match(
    prepared.reviews[0].reviewed_catalog_override?.generic_rejection ?? "",
    /Morning Protein/i,
  );
  assert.equal(prepared.manifest.repairs[0].text_count?.title, KD_CATALOG_TITLE);
  const source = prepared.manifest.source_artifacts?.amazon_catalog_title_alignment;
  assert.equal(source?.reviewed_catalog_api_overrides, 1);
  assert.deepEqual(source?.reviewed_catalog_api_evidence?.exact_override_skus, [KD_SKU]);
});

test("fails closed when an exceptional title has no exact reviewed Catalog API artifact", async (t) => {
  const input = await fixture({
    sku: KD_SKU,
    asin: KD_ASIN,
    desiredTitle: KD_DESIRED_TITLE,
    catalogTitle: KD_CATALOG_TITLE,
    components: KD_COMPONENTS,
  });
  t.after(() => rm(input.root, { recursive: true, force: true }));
  await assert.rejects(prepare(input), /exact reviewed Catalog API evidence artifact is required/i);
});

test("reviewed override rejects wrong SKU, title, and count even with the exact evidence artifact", async (t) => {
  const wrongSku = await fixture({
    sku: "KD-AS12-8HZ4",
    asin: KD_ASIN,
    desiredTitle: KD_DESIRED_TITLE,
    catalogTitle: KD_CATALOG_TITLE,
    components: KD_COMPONENTS,
    reviewedCatalogEvidence: true,
  });
  t.after(() => rm(wrongSku.root, { recursive: true, force: true }));
  await assert.rejects(prepare(wrongSku), /no exact reviewed Catalog API evidence override/i);

  const wrongTitle = await fixture({
    sku: KD_SKU,
    asin: KD_ASIN,
    desiredTitle: KD_DESIRED_TITLE,
    catalogTitle: `${KD_CATALOG_TITLE} Bundle`,
    components: KD_COMPONENTS,
    reviewedCatalogEvidence: true,
  });
  t.after(() => rm(wrongTitle.root, { recursive: true, force: true }));
  await assert.rejects(prepare(wrongTitle), /identity differs from the exact reviewed override/i);

  const wrongCount = await fixture({
    sku: KD_SKU,
    asin: KD_ASIN,
    desiredTitle: KD_DESIRED_TITLE.replace("24 Count", "30 Count"),
    catalogTitle: KD_CATALOG_TITLE.replace("24 Count", "30 Count"),
    count: 30,
    components: KD_COMPONENTS.map((component) => ({ ...component, qty: 15 })),
    reviewedCatalogEvidence: true,
  });
  t.after(() => rm(wrongCount.root, { recursive: true, force: true }));
  await assert.rejects(prepare(wrongCount), /identity differs from the exact reviewed override/i);
});

test("reviewed Catalog API evidence is pinned against tamper and caller-selected SHA drift", async (t) => {
  const input = await fixture({
    sku: KD_SKU,
    asin: KD_ASIN,
    desiredTitle: KD_DESIRED_TITLE,
    catalogTitle: KD_CATALOG_TITLE,
    components: KD_COMPONENTS,
    reviewedCatalogEvidence: true,
  });
  t.after(() => rm(input.root, { recursive: true, force: true }));
  const original = await readFile(input.catalogEvidencePath as string);
  await writeFile(input.catalogEvidencePath as string, Buffer.concat([original, Buffer.from(" ")]));
  await assert.rejects(prepare(input), /Catalog API evidence file SHA-256 mismatch/i);
  await writeFile(input.catalogEvidencePath as string, original);
  await assert.rejects(
    prepareCatalogTitleAlignment({
      planPath: input.planPath,
      expectedPlanInternalSha256: input.plan.sha256,
      expectedPlanFileSha256: input.planFileSha256,
      desiredManifestPath: input.manifestPath,
      expectedDesiredManifestFileSha256: input.manifestFileSha256,
      checkpointDirectory: input.checkpointDirectory,
      reviewedAt: REVIEWED_AT,
      requiredManifestRows: 1,
      catalogEvidencePath: input.catalogEvidencePath,
      expectedCatalogEvidenceFileSha256: "f".repeat(64),
      expectedCatalogEvidenceBodySha256: REVIEWED_CATALOG_EVIDENCE_BODY_SHA256,
    }),
    /not the exact code-reviewed/i,
  );
});

test("TY and VN remain fail-closed and can never consume a catalog-title override", async (t) => {
  const ty = await fixture({
    sku: "TY-AST2-JE9P",
    asin: "B0H84WQRXB",
    desiredTitle:
      "Smucker's Uncrustables Frozen Sandwich Variety Pack, Peanut Butter & Raspberry Spread and Morning Protein Peanut Butter & Mixed Berry Spread, 24 Count",
    catalogTitle:
      "Uncrustables Peanut Butter & Raspberry Spread and Peanut Butter & Mixed Berry Spread Frozen Sandwiches, 2 oz Each, 24 Count",
    components: [
      {
        product_name:
          "Smuckers Uncrustables Peanut Butter & Raspberry Spread Sandwiches, 10 Count, 2 oz Each, Frozen",
        qty: 12,
      },
      {
        product_name:
          "Smucker's Uncrustables Morning Protein Peanut Butter & Mixed Berry Spread Sandwich - 22.4oz/8ct",
        qty: 12,
      },
    ],
    reviewedCatalogEvidence: true,
  });
  t.after(() => rm(ty.root, { recursive: true, force: true }));
  await assert.rejects(prepare(ty), /explicitly BLOCKED/i);

  const vn = await fixture({
    sku: "VN-AS1A-D572",
    asin: "B0H82PKK18",
    desiredTitle:
      "Smucker's Uncrustables Peanut Butter & Strawberry Jam Frozen Sandwiches, Individually Wrapped, 45 Count",
    count: 45,
    components: [
      {
        product_name:
          "Smucker's Uncrustables Frozen Peanut Butter & Strawberry Jam Sandwich - 8oz/4ct",
        qty: 45,
      },
    ],
    errorIssue: {
      code: "8541",
      message:
        "ASIN B0H82PKK18 catalog unit_count is 180 Count; merchant attempted 45 Count.",
      severity: "ERROR",
      attributeNames: ["unit_count"],
    },
    reviewedCatalogEvidence: true,
  });
  t.after(() => rm(vn.root, { recursive: true, force: true }));
  await assert.rejects(prepare(vn), /not exclusively an item_name conflict/i);
});

test("creates the immutable 5-safe/2-block scope decision with exact seals and exclusions", async (t) => {
  const output = await mkdtemp(path.join(tmpdir(), "catalog-identity-decision-"));
  t.after(() => rm(output, { recursive: true, force: true }));
  const prepared = await prepareCatalogIdentityDecision({
    createdAt: "2026-07-18T07:23:04.000Z",
    sourcePlanPath:
      "data/repairs/generated/uncrustables-final-164-20260718-v5/URP-20260718T060953141Z-480ed383f696.json",
    desiredManifestPath:
      "data/repairs/uncrustables-gallery-nonmedia-merged-desired-20260718-v4.json",
    sourceLedgerPath:
      "data/audits/uncrustables-ledger-20260717T232140568Z-offline.json",
    donorEnrichmentPath: "data/repairs/uncrustables-donor-enrichment-20260717.json",
    vnCheckpointPath:
      "data/repairs/checkpoints/final-validation-preview-full-diagnostic-20260718-v5/480ed383f6963ac4983c/20260718T064118064Z-VN-AS1A-D572_text_count-FAILED-7add80ea-35bf-44bb-a38f-6fd24db79710.json",
    catalogEvidencePath:
      "data/audits/uncrustables-catalog-title-api-evidence-20260718T065137Z.json",
    expectedCatalogEvidenceFileSha256: REVIEWED_CATALOG_EVIDENCE_FILE_SHA256,
    expectedCatalogEvidenceBodySha256: REVIEWED_CATALOG_EVIDENCE_BODY_SHA256,
  });
  assert.deepEqual(prepared.artifact.scope.final_apply_exclusions, [
    "TY-AST2-JE9P",
    "VN-AS1A-D572",
  ]);
  assert.equal(
    prepared.artifact.decisions.filter((decision) => decision.decision === "ALIGN_SAFE").length,
    5,
  );
  assert.equal(
    prepared.artifact.decisions.filter((decision) => decision.decision === "BLOCK").length,
    2,
  );
  const written = await writeCatalogIdentityDecisionArtifact(output, prepared);
  assert.equal(sha256(await readFile(written.artifactPath)), written.fileSha256);
  assert.equal(
    (await readFile(written.sidecarPath, "utf8")).trim(),
    `${written.fileSha256}  ${path.basename(written.artifactPath)}`,
  );
});

test("fails closed on incomplete selected-action checkpoint coverage", async (t) => {
  const input = await fixture({ omitCheckpoint: true });
  t.after(() => rm(input.root, { recursive: true, force: true }));
  await assert.rejects(prepare(input), /no JSON events|Missing checkpoint coverage/i);
});

test("fails closed when Amazon catalog title has the wrong Count", async (t) => {
  const input = await fixture({
    catalogTitle:
      "Uncrustables Peanut Butter & Grape Jelly Frozen Sandwiches, 2 oz Each, 30 Count",
  });
  t.after(() => rm(input.root, { recursive: true, force: true }));
  await assert.rejects(prepare(input), /exactly one exact 24 Count/i);
});

test("fails closed when Amazon catalog title has the wrong flavor", async (t) => {
  const input = await fixture({
    catalogTitle:
      "Uncrustables Peanut Butter & Strawberry Jam Frozen Sandwiches, 2 oz Each, 24 Count",
  });
  t.after(() => rm(input.root, { recursive: true, force: true }));
  await assert.rejects(prepare(input), /missing recipe marker grape|unexpected recipe marker strawberry/i);
});

test("fails closed on any non-title ERROR", async (t) => {
  const input = await fixture({
    errorIssue: {
      code: "90244",
      message: "We can't accept the Count entered for Unit Count.",
      severity: "ERROR",
      attributeNames: ["unit_count"],
      categories: ["INVALID_ATTRIBUTE"],
    },
  });
  t.after(() => rm(input.root, { recursive: true, force: true }));
  await assert.rejects(prepare(input), /not exclusively an item_name conflict/i);
});

test("records the exact KP 90244 stateless-preview dependency without treating it as title evidence", async (t) => {
  const input = await kpDependencyFixture();
  t.after(() => rm(input.root, { recursive: true, force: true }));
  const prepared = await prepare(input);
  assert.equal(prepared.reviews.length, 1);
  assert.equal(prepared.reviews[0].sku, KP_SKU);
  assert.equal(prepared.stagedDependencyExceptions.length, 1);
  assert.deepEqual(
    {
      sku: prepared.stagedDependencyExceptions[0].sku,
      asin: prepared.stagedDependencyExceptions[0].asin,
      kind: prepared.stagedDependencyExceptions[0].kind,
      code: prepared.stagedDependencyExceptions[0].issue_code,
      dependency: prepared.stagedDependencyExceptions[0].depends_on_text_count_action_id,
    },
    {
      sku: KP_SKU,
      asin: KP_ASIN,
      kind: "OFFER",
      code: "90244",
      dependency: `${KP_SKU}:text_count`,
    },
  );
  const source = prepared.manifest.source_artifacts?.amazon_catalog_title_alignment;
  assert.equal(source?.checkpoint_set.terminal_staged_dependency_exceptions, 1);
  assert.equal(source?.checkpoint_set.terminal_failed_catalog_title_conflict, 1);
  assert.equal(source?.checkpoint_set.staged_dependency_exceptions.length, 1);
});

test("rejects the KP dependency exception when the obsolete warning is also present", async (t) => {
  const input = await kpDependencyFixture({ includeWarning: true });
  t.after(() => rm(input.root, { recursive: true, force: true }));
  await assert.rejects(prepare(input), /not exclusively an item_name conflict|unrecognized catalog/i);
});

test("rejects the KP dependency exception unless exact KP TEXT_COUNT is PREVIEW_VALID in the same set", async (t) => {
  const input = await kpDependencyFixture({ textPreviewValid: false });
  t.after(() => rm(input.root, { recursive: true, force: true }));
  await assert.rejects(
    prepare(input),
    /requires terminal PREVIEW_VALID for TEXT_COUNT in the same checkpoint set/i,
  );
});

test("fails closed on checkpoint tamper", async (t) => {
  const input = await fixture({ tamperCheckpoint: true });
  t.after(() => rm(input.root, { recursive: true, force: true }));
  await assert.rejects(prepare(input), /Invalid\/tampered checkpoint event/i);
});

test("fails closed on explicit source-plan or desired-manifest SHA drift", async (t) => {
  const input = await fixture();
  t.after(() => rm(input.root, { recursive: true, force: true }));
  await assert.rejects(
    prepareCatalogTitleAlignment({
      planPath: input.planPath,
      expectedPlanInternalSha256: input.plan.sha256,
      expectedPlanFileSha256: "f".repeat(64),
      desiredManifestPath: input.manifestPath,
      expectedDesiredManifestFileSha256: input.manifestFileSha256,
      checkpointDirectory: input.checkpointDirectory,
      reviewedAt: REVIEWED_AT,
      requiredManifestRows: 1,
    }),
    /Source URP file SHA-256 mismatch/i,
  );
  await assert.rejects(
    prepareCatalogTitleAlignment({
      planPath: input.planPath,
      expectedPlanInternalSha256: input.plan.sha256,
      expectedPlanFileSha256: input.planFileSha256,
      desiredManifestPath: input.manifestPath,
      expectedDesiredManifestFileSha256: "e".repeat(64),
      checkpointDirectory: input.checkpointDirectory,
      reviewedAt: REVIEWED_AT,
      requiredManifestRows: 1,
    }),
    /Desired manifest file SHA-256 mismatch/i,
  );
});
