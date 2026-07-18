/**
 * Offline-only alignment of reviewed Uncrustables titles to exact Amazon
 * catalog `item_name` values returned by Listings Items VALIDATION_PREVIEW.
 *
 * This module has no Amazon gateway and no database dependency. It accepts
 * only an exact SHA-pinned repair plan, its exact desired manifest, the exact
 * source ledger, and a complete sealed checkpoint set. Any incomplete preview
 * coverage or ERROR other than an unambiguous catalog `item_name` conflict
 * aborts the whole operation.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  CHECKPOINT_SCHEMA,
  DESIRED_MANIFEST_SCHEMA,
  type CheckpointEvent,
  type DesiredRepairManifest,
  type RepairActionKind,
  type UncrustablesRepairPlan,
  sha256,
  stableJson,
  verifyRepairPlan,
} from "./uncrustables-surgical";

export const CATALOG_TITLE_ALIGNMENT_SCHEMA =
  "uncrustables-amazon-catalog-title-alignment/v1" as const;
export const CATALOG_TITLE_API_EVIDENCE_SCHEMA =
  "uncrustables-catalog-title-api-evidence/v1" as const;

/**
 * These pins are deliberately code-reviewed constants. The five exceptional
 * title alignments below may only consume the exact immutable Catalog Items
 * capture reviewed on 2026-07-18; supplying a different caller-selected SHA is
 * not sufficient to expand the allow-list.
 */
export const REVIEWED_CATALOG_EVIDENCE_FILE_SHA256 =
  "b26c6933c301cec61a03a143d39c646e87943db7e4411e43129314918be86c49" as const;
export const REVIEWED_CATALOG_EVIDENCE_BODY_SHA256 =
  "2ffb50e1c21fd060a0b1f49a0bae39981f87d5288b55429e504c0f71992e1b3e" as const;
const REVIEWED_CATALOG_EVIDENCE_SOURCE_PLAN_INTERNAL_SHA256 =
  "480ed383f6963ac4983c142085599ee1877e12343a63be55eec4e6d1cecdebe3" as const;
const REVIEWED_CATALOG_EVIDENCE_SOURCE_PLAN_FILE_SHA256 =
  "15d85932f70871a41b39f33d9290f840e6bbdb50c498964b01fed355a23f4957" as const;
const REVIEWED_DESIRED_MANIFEST_FILE_SHA256 =
  "f7e02809067844330baf60f8cc1b886d15ab6154d72eff77b7b3a56715629dea" as const;
const REVIEWED_DESIRED_MANIFEST_BODY_SHA256 =
  "82d59b1d3795f7b058204c4ca7848a4372e61fc1559799aac933cb67bf120e61" as const;
const REVIEWED_SOURCE_LEDGER_FILE_SHA256 =
  "46a80e727880d83bd9e52a1c58c753eeeede0cb8cbdd3443e825aba9cbaaa02f" as const;
const REVIEWED_DONOR_ENRICHMENT_FILE_SHA256 =
  "999348227982c169477ad13fb806ddba42fb15cb68397308e4289a9cbbcee9f9" as const;
const REVIEWED_VN_CHECKPOINT_FILE_SHA256 =
  "c7b352ae4cda67f2a2fe4281f13dbe3dc2e705c29857621d81a0a428ca1131ad" as const;
const REVIEWED_VN_CHECKPOINT_EVENT_SHA256 =
  "afb4da20d7b99d1bc0a30cbd149d3d20ea7a837f3c021292d75a44264e0eaa76" as const;
const MARKETPLACE_ID = "ATVPDKIKX0DER" as const;

type UnknownRecord = Record<string, unknown>;

interface LedgerComponent {
  product_name: string;
  qty: number;
}

interface LedgerRow {
  sku: string;
  asin: string;
  canonical: { components: LedgerComponent[] };
}

interface CatalogConflictEvidence {
  sku: string;
  asin: string;
  action_id: string;
  kind: RepairActionKind;
  submission_id: string;
  issue_code: string;
  catalog_title: string;
  checkpoint_event_sha256: string;
  checkpoint_file_sha256: string;
  checkpoint_file: string;
  issue_message_sha256: string;
}

interface StagedDependencyExceptionEvidence {
  sku: "KP-ASYC-RN84";
  asin: "B0H83FYZR3";
  action_id: string;
  kind: "STRUCTURED_ATTRIBUTES" | "OFFER";
  submission_id: string;
  issue_code: "90244";
  attribute_name: "unit_count";
  checkpoint_event_sha256: string;
  checkpoint_file_sha256: string;
  checkpoint_file: string;
  issue_message_sha256: string;
  depends_on_text_count_action_id: "KP-ASYC-RN84:text_count";
  depends_on_text_count_checkpoint_sha256: string;
  desired_text_count_sha256: string;
}

interface CatalogTitleAlignmentReview {
  sku: string;
  asin: string;
  intended_count: number;
  prior_title: string;
  catalog_title: string;
  recipe_identities: RecipeIdentity[];
  evidence: CatalogConflictEvidence[];
  identity_validation: "GENERIC_STRICT" | "REVIEWED_CATALOG_API_EVIDENCE";
  reviewed_catalog_override?: ReviewedCatalogOverrideEvidence;
}

interface CatalogApiEvidenceRow {
  sku?: unknown;
  asin?: unknown;
  preview_catalog_title?: unknown;
  preview_submission_ids?: unknown;
  checkpoint_event_sha256s?: unknown;
  checkpoint_file_sha256s?: unknown;
  catalog_api_title?: unknown;
  catalog_api_brand?: unknown;
  catalog_api_product_type?: unknown;
  catalog_api_number_of_items?: unknown;
  catalog_api_unit_count?: unknown;
  catalog_api_product_identifiers?: unknown;
  exact_preview_match?: unknown;
}

interface CatalogApiEvidenceArtifact extends UnknownRecord {
  schema_version?: unknown;
  immutable?: unknown;
  read_only?: unknown;
  captured_at?: unknown;
  source_plan?: unknown;
  source_checkpoint_set?: unknown;
  scope?: unknown;
  evidence?: unknown;
  body_sha256?: unknown;
}

interface ValidatedCatalogApiEvidence {
  path: string;
  file_sha256: string;
  body_sha256: string;
  captured_at: string;
  source_plan_internal_sha256: string;
  source_plan_file_sha256: string;
  rows_by_sku: Map<string, CatalogApiEvidenceRow>;
}

interface ReviewedCatalogOverrideEvidence {
  policy: "EXACT_REVIEWED_CATALOG_API_EVIDENCE_V1";
  catalog_evidence_path: string;
  catalog_evidence_file_sha256: string;
  catalog_evidence_body_sha256: string;
  catalog_evidence_row_sha256: string;
  catalog_api_identifiers: Array<{ type: string; value: string }>;
  exact_unit_count: number;
  exact_number_of_items: number | null;
  recipe_components_sha256: string;
  generic_rejection: string;
}

interface AlignmentSourceArtifact {
  schema_version: typeof CATALOG_TITLE_ALIGNMENT_SCHEMA;
  offline_only: true;
  source_plan: {
    path: string;
    internal_sha256: string;
    file_sha256: string;
  };
  source_desired_manifest: {
    path: string;
    file_sha256: string;
    body_sha256: string;
  };
  source_ledger: {
    path: string;
    file_sha256: string;
  };
  checkpoint_set: {
    path: string;
    sha256: string;
    files: number;
    selected_actions: number;
    terminal_preview_valid: number;
    terminal_failed_catalog_title_conflict: number;
    terminal_staged_dependency_exceptions: number;
    staged_dependency_exceptions: StagedDependencyExceptionEvidence[];
  };
  reviewed_catalog_api_evidence?: {
    schema_version: typeof CATALOG_TITLE_API_EVIDENCE_SCHEMA;
    path: string;
    file_sha256: string;
    body_sha256: string;
    captured_at: string;
    source_plan_internal_sha256: string;
    source_plan_file_sha256: string;
    exact_override_skus: string[];
  };
  aligned_rows: number;
  generic_strict_alignments: number;
  reviewed_catalog_api_overrides: number;
}

export interface CatalogTitleAlignedManifest extends DesiredRepairManifest {
  immutable: true;
  reviewed_at: string;
  source_artifacts?: Record<string, unknown> & {
    amazon_catalog_title_alignment?: AlignmentSourceArtifact;
  };
  supersedes?: Array<Record<string, unknown>>;
  merge_summary?: Record<string, unknown> & {
    amazon_catalog_title_alignments?: number;
  };
  repairs: Array<
    DesiredRepairManifest["repairs"][number] & {
      review?: NonNullable<DesiredRepairManifest["repairs"][number]["review"]> & {
        supersedes?: Array<{
          field: "text_count.title";
          prior_value: string;
          source_manifest_path: string;
          source_manifest_sha256: string;
          reason: "AMAZON_CATALOG_ITEM_NAME_CONFLICT";
        }>;
      };
    }
  >;
  body_sha256: string;
}

export interface PrepareCatalogTitleAlignmentOptions {
  planPath: string;
  expectedPlanInternalSha256: string;
  expectedPlanFileSha256: string;
  desiredManifestPath: string;
  expectedDesiredManifestFileSha256: string;
  checkpointDirectory: string;
  reviewedAt: string;
  catalogEvidencePath?: string;
  expectedCatalogEvidenceFileSha256?: string;
  expectedCatalogEvidenceBodySha256?: string;
  /** Production callers leave this at 164. Tests may supply their exact scope. */
  requiredManifestRows?: number;
}

export interface PreparedCatalogTitleAlignment {
  manifest: CatalogTitleAlignedManifest;
  sourcePlan: UncrustablesRepairPlan;
  sourcePlanFileSha256: string;
  sourceDesiredManifestFileSha256: string;
  checkpointSetSha256: string;
  reviews: CatalogTitleAlignmentReview[];
  stagedDependencyExceptions: StagedDependencyExceptionEvidence[];
  reviewedCatalogOverrides: ReviewedCatalogOverrideEvidence[];
}

export interface WrittenCatalogTitleAlignment {
  manifestPath: string;
  sidecarPath: string;
  fileSha256: string;
  bodySha256: string;
  alignedRows: number;
}

export const CATALOG_IDENTITY_DECISION_SCHEMA =
  "uncrustables-catalog-identity-decision/v1" as const;

export interface PrepareCatalogIdentityDecisionOptions {
  createdAt: string;
  sourcePlanPath: string;
  desiredManifestPath: string;
  sourceLedgerPath: string;
  donorEnrichmentPath: string;
  vnCheckpointPath: string;
  catalogEvidencePath: string;
  expectedCatalogEvidenceFileSha256: string;
  expectedCatalogEvidenceBodySha256: string;
}

export interface CatalogIdentityDecisionArtifact extends UnknownRecord {
  schema_version: typeof CATALOG_IDENTITY_DECISION_SCHEMA;
  immutable: true;
  read_only: true;
  created_at: string;
  source_artifacts: Record<string, unknown>;
  scope: {
    cohort_skus: 164;
    align_safe: 5;
    blocked: 2;
    intended_final_apply_scope: 162;
    final_apply_exclusions: ["TY-AST2-JE9P", "VN-AS1A-D572"];
  };
  decisions: Array<Record<string, unknown>>;
  body_sha256: string;
}

export interface PreparedCatalogIdentityDecision {
  artifact: CatalogIdentityDecisionArtifact;
}

export interface WrittenCatalogIdentityDecision {
  artifactPath: string;
  sidecarPath: string;
  fileSha256: string;
  bodySha256: string;
}

type RecipeIdentity =
  | "APPLE_CINNAMON_12G_PROTEIN"
  | "BLACKBERRY"
  | "BLUEBERRY"
  | "CHOCOLATE_FLAVORED_SPREAD"
  | "CHOCOLATE_HAZELNUT"
  | "GRAPE"
  | "GRAPE_WHOLE_WHEAT"
  | "HONEY"
  | "MIXED_BERRY"
  | "MIXED_BERRY_MORNING_PROTEIN"
  | "PLAIN_PEANUT_BUTTER"
  | "RASPBERRY"
  | "STRAWBERRY"
  | "STRAWBERRY_12G_PROTEIN"
  | "STRAWBERRY_WHOLE_WHEAT";

interface ReviewedCatalogOverridePolicy {
  sku: string;
  asin: string;
  prior_title: string;
  catalog_title: string;
  intended_count: number;
  number_of_items: number | null;
  unit_count: number;
  product_type: "GROCERY";
  identifiers: Array<{ type: "ean" | "upc"; value: string }>;
  recipe_components: LedgerComponent[];
}

const REVIEWED_CATALOG_OVERRIDE_POLICY_ROWS: ReviewedCatalogOverridePolicy[] = [
    {
      sku: "KD-AS12-8HZ3",
      asin: "B0H845JBM6",
      prior_title:
        "Smucker's Uncrustables Frozen Sandwich Variety Pack, Peanut Butter & Strawberry Jam – 12g Protein and Morning Protein Peanut Butter & Mixed Berry Spread, 24 Count",
      catalog_title:
        "Uncrustables Frozen Crustless Sandwiches, Peanut Butter & Strawberry Jam Protein and Peanut Butter & Mixed Berry, 2.8 oz, 24 Count",
      intended_count: 24,
      number_of_items: 24,
      unit_count: 24,
      product_type: "GROCERY",
      identifiers: [
        { type: "ean", value: "0756441904598" },
        { type: "upc", value: "756441904598" },
      ],
      recipe_components: [
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
      ],
    },
    {
      sku: "RL-AS64-Q8QX",
      asin: "B0H82LZLM2",
      prior_title:
        "Smucker's Uncrustables Morning Protein Peanut Butter & Mixed Berry Spread Frozen Sandwiches, Individually Wrapped, 30 Count",
      catalog_title:
        "Uncrustables Morning Protein Peanut Butter & Mixed Berry Spread on Wheat Bread, 2.8 oz, 30 Count",
      intended_count: 30,
      number_of_items: 30,
      unit_count: 30,
      product_type: "GROCERY",
      identifiers: [
        { type: "ean", value: "0756441901962" },
        { type: "upc", value: "756441901962" },
      ],
      recipe_components: [
        {
          product_name:
            "Smucker's Uncrustables Morning Protein Peanut Butter & Mixed Berry Spread Sandwich - 22.4oz/8ct",
          qty: 30,
        },
      ],
    },
    {
      sku: "SZ-ASPI-JFAT",
      asin: "B0H776M5B5",
      prior_title:
        "Smucker's Uncrustables Peanut Butter & Blackberry Spread Frozen Sandwiches, Individually Wrapped, 24 Count",
      catalog_title:
        "Uncrustables Frozen Peanut Butter & Blackberry Spread Sandwiches, 8oz/4ct - Pack of 6 (24 Sandwiches Total)",
      intended_count: 24,
      number_of_items: null,
      unit_count: 24,
      product_type: "GROCERY",
      identifiers: [
        { type: "ean", value: "0664554043946" },
        { type: "upc", value: "664554043946" },
      ],
      recipe_components: [
        {
          product_name:
            "Smucker's Uncrustables Frozen Peanut Butter & Blackberry Spread Sandwich - 8oz/4ct",
          qty: 24,
        },
      ],
    },
    {
      sku: "VA-ASOK-QJCA",
      asin: "B0H85RZDX5",
      prior_title:
        "Smucker's Uncrustables Frozen Sandwich Variety Pack, Peanut Butter & Apple Cinnamon Jelly – 12g Protein and Morning Protein Peanut Butter & Mixed Berry Spread, 24 Count",
      catalog_title:
        "Uncrustables Frozen Crustless Peanut Butter Sandwiches, Apple Cinnamon Jelly & Mixed Berry Variety Pack, 2.8 oz Each, 24 Count",
      intended_count: 24,
      number_of_items: 24,
      unit_count: 24,
      product_type: "GROCERY",
      identifiers: [
        { type: "ean", value: "0756441905670" },
        { type: "upc", value: "756441905670" },
      ],
      recipe_components: [
        {
          product_name:
            "Smucker's Uncrustables Frozen Peanut Butter & Apple Cinnamon Jelly Sandwich – 12g Protein 22.4oz/8ct",
          qty: 12,
        },
        {
          product_name:
            "Smucker's Uncrustables Morning Protein Peanut Butter & Mixed Berry Spread Sandwich - 22.4oz/8ct",
          qty: 12,
        },
      ],
    },
    {
      sku: "WK-AS2R-FJUW",
      asin: "B0H82XBNVN",
      prior_title:
        "Smucker's Uncrustables Peanut Butter Frozen Sandwiches, Individually Wrapped, 90 Count",
      catalog_title:
        "Uncrustables Frozen Peanut Butter Sandwich, Individually Wrapped, No Crust, 1.8 oz, Pack of 90",
      intended_count: 90,
      number_of_items: 90,
      unit_count: 90,
      product_type: "GROCERY",
      identifiers: [
        { type: "ean", value: "0756441902969" },
        { type: "upc", value: "756441902969" },
      ],
      recipe_components: [
        {
          product_name:
            "Smucker's Uncrustables Frozen Peanut Butter Sandwich - 7.2oz/4ct",
          qty: 90,
        },
      ],
    },
  ];

const REVIEWED_CATALOG_OVERRIDE_POLICIES: ReadonlyMap<
  string,
  ReviewedCatalogOverridePolicy
> = new Map(
  REVIEWED_CATALOG_OVERRIDE_POLICY_ROWS.map((policy) => [policy.sku, policy]),
);

const NEVER_ALIGN_CATALOG_IDENTITY_SKUS = new Set([
  "TY-AST2-JE9P",
  "VN-AS1A-D572",
]);

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isRecord(value: unknown): value is UnknownRecord {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function exactSha(label: string, value: string): string {
  const normalized = value.trim().toLowerCase();
  assert(/^[a-f0-9]{64}$/.test(normalized), `${label} must be an exact SHA-256.`);
  return normalized;
}

function canonicalBodySeal(value: UnknownRecord): string {
  const body = { ...value };
  delete body.body_sha256;
  return sha256(stableJson(body));
}

function exactStringArray(label: string, value: unknown): string[] {
  assert(Array.isArray(value) && value.length > 0, `${label} must be a non-empty array.`);
  const result = value.map((item) => String(item).trim());
  assert(result.every(Boolean), `${label} contains an empty value.`);
  assert(new Set(result).size === result.length, `${label} contains duplicate values.`);
  return result;
}

async function readReviewedCatalogApiEvidence(input: {
  path?: string;
  expectedFileSha256?: string;
  expectedBodySha256?: string;
  reviewedAt: string;
}): Promise<ValidatedCatalogApiEvidence | null> {
  const supplied = [input.path, input.expectedFileSha256, input.expectedBodySha256];
  if (supplied.every((value) => value == null)) return null;
  assert(
    supplied.every((value) => typeof value === "string" && value.trim().length > 0),
    "Catalog API evidence path, file SHA-256, and body SHA-256 must be supplied together.",
  );
  const expectedFileSha256 = exactSha(
    "expectedCatalogEvidenceFileSha256",
    input.expectedFileSha256 as string,
  );
  const expectedBodySha256 = exactSha(
    "expectedCatalogEvidenceBodySha256",
    input.expectedBodySha256 as string,
  );
  assert(
    expectedFileSha256 === REVIEWED_CATALOG_EVIDENCE_FILE_SHA256 &&
      expectedBodySha256 === REVIEWED_CATALOG_EVIDENCE_BODY_SHA256,
    "Catalog API evidence pins are not the exact code-reviewed 2026-07-18 artifact pins.",
  );
  const evidencePath = path.resolve(input.path as string);
  const bytes = await readFile(evidencePath);
  assert(sha256(bytes) === expectedFileSha256, "Catalog API evidence file SHA-256 mismatch.");
  let artifact: CatalogApiEvidenceArtifact;
  try {
    const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
    assert(isRecord(parsed), "Catalog API evidence JSON is not an object.");
    artifact = parsed as CatalogApiEvidenceArtifact;
  } catch (cause) {
    throw new Error(
      `Catalog API evidence JSON is invalid: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  assert(
    artifact.schema_version === CATALOG_TITLE_API_EVIDENCE_SCHEMA &&
      artifact.immutable === true &&
      artifact.read_only === true,
    "Catalog API evidence is not the exact immutable read-only schema.",
  );
  assert(
    artifact.body_sha256 === expectedBodySha256 &&
      canonicalBodySeal(artifact) === expectedBodySha256,
    "Catalog API evidence body SHA-256 mismatch.",
  );
  const capturedAt = String(artifact.captured_at ?? "");
  assert(
    !Number.isNaN(Date.parse(capturedAt)) &&
      new Date(capturedAt).toISOString() === capturedAt &&
      Date.parse(capturedAt) <= Date.parse(input.reviewedAt),
    "Catalog API evidence captured_at is invalid or later than reviewedAt.",
  );
  assert(isRecord(artifact.source_plan), "Catalog API evidence source_plan is missing.");
  const sourcePlanInternalSha256 = exactSha(
    "catalog evidence source-plan internal SHA-256",
    String(artifact.source_plan.internal_sha256 ?? ""),
  );
  const sourcePlanFileSha256 = exactSha(
    "catalog evidence source-plan file SHA-256",
    String(artifact.source_plan.file_sha256 ?? ""),
  );
  assert(
    sourcePlanInternalSha256 === REVIEWED_CATALOG_EVIDENCE_SOURCE_PLAN_INTERNAL_SHA256 &&
      sourcePlanFileSha256 === REVIEWED_CATALOG_EVIDENCE_SOURCE_PLAN_FILE_SHA256,
    "Catalog API evidence is not bound to the exact reviewed v5 diagnostic plan.",
  );
  assert(isRecord(artifact.source_checkpoint_set), "Catalog API evidence checkpoint set is missing.");
  assert(
    artifact.source_checkpoint_set.files === 612 &&
      artifact.source_checkpoint_set.sha256 ===
        "c5ae519542f879694fcf32e0250bcaa0d6ac0bb22de81fd299075c9b4bba1639",
    "Catalog API evidence is not bound to the exact complete 612-event checkpoint set.",
  );
  assert(isRecord(artifact.scope), "Catalog API evidence scope is missing.");
  assert(
    artifact.scope.catalog_title_conflict_skus === 35 &&
      artifact.scope.exact_preview_api_matches === 35 &&
      artifact.scope.mismatches === 0,
    "Catalog API evidence scope is not the reviewed exact 35/35 zero-mismatch capture.",
  );
  assert(Array.isArray(artifact.evidence) && artifact.evidence.length === 35, "Catalog API evidence must contain exactly 35 rows.");
  const rowsBySku = new Map<string, CatalogApiEvidenceRow>();
  for (const raw of artifact.evidence) {
    assert(isRecord(raw), "Catalog API evidence row is not an object.");
    const row = raw as CatalogApiEvidenceRow;
    const sku = String(row.sku ?? "").trim();
    assert(sku.length > 0 && !rowsBySku.has(sku), `Catalog API evidence has duplicate/empty SKU ${sku}.`);
    assert(row.exact_preview_match === true, `${sku}: Catalog API title does not exactly match preview evidence.`);
    rowsBySku.set(sku, row);
  }
  return {
    path: evidencePath,
    file_sha256: expectedFileSha256,
    body_sha256: expectedBodySha256,
    captured_at: capturedAt,
    source_plan_internal_sha256: sourcePlanInternalSha256,
    source_plan_file_sha256: sourcePlanFileSha256,
    rows_by_sku: rowsBySku,
  };
}

function reviewedCatalogOverride(input: {
  sku: string;
  asin: string;
  priorTitle: string;
  catalogTitle: string;
  intendedCount: number;
  components: LedgerComponent[];
  genericError: Error;
  evidence: ValidatedCatalogApiEvidence | null;
}): { identities: RecipeIdentity[]; evidence: ReviewedCatalogOverrideEvidence } {
  assert(
    !NEVER_ALIGN_CATALOG_IDENTITY_SKUS.has(input.sku),
    `${input.sku}: catalog identity is explicitly BLOCKED and can never use a reviewed title override.`,
  );
  const policy = REVIEWED_CATALOG_OVERRIDE_POLICIES.get(input.sku);
  assert(policy, `${input.sku}: no exact reviewed Catalog API evidence override exists.`);
  assert(input.evidence, `${input.sku}: exact reviewed Catalog API evidence artifact is required.`);
  assert(
    input.asin === policy.asin &&
      input.priorTitle === policy.prior_title &&
      input.catalogTitle === policy.catalog_title &&
      input.intendedCount === policy.intended_count,
    `${input.sku}: plan/manifest/checkpoint identity differs from the exact reviewed override.`,
  );
  assert(
    stableJson(input.components) === stableJson(policy.recipe_components),
    `${input.sku}: source-ledger recipe differs from the exact reviewed override.`,
  );
  const row = input.evidence.rows_by_sku.get(input.sku);
  assert(row, `${input.sku}: reviewed Catalog API evidence row is missing.`);
  assert(
    row.sku === policy.sku &&
      row.asin === policy.asin &&
      row.preview_catalog_title === policy.catalog_title &&
      row.catalog_api_title === policy.catalog_title &&
      row.catalog_api_brand === "Uncrustables" &&
      row.catalog_api_product_type === policy.product_type &&
      row.exact_preview_match === true,
    `${input.sku}: Catalog API evidence row identity/title differs from the exact reviewed override.`,
  );
  const expectedNumberOfItems =
    policy.number_of_items == null
      ? null
      : [{ value: policy.number_of_items, marketplace_id: MARKETPLACE_ID }];
  const expectedUnitCount = [
    {
      type: { language_tag: "en_US", value: "Count" },
      value: policy.unit_count,
      marketplace_id: MARKETPLACE_ID,
    },
  ];
  const expectedIdentifiers = policy.identifiers.map((identifier) => ({
    value: identifier.value,
    type: identifier.type,
    marketplace_id: MARKETPLACE_ID,
  }));
  assert(
    stableJson(row.catalog_api_number_of_items) === stableJson(expectedNumberOfItems) &&
      stableJson(row.catalog_api_unit_count) === stableJson(expectedUnitCount) &&
      stableJson(row.catalog_api_product_identifiers) === stableJson(expectedIdentifiers),
    `${input.sku}: Catalog API count/unit/identifier evidence differs from the exact reviewed override.`,
  );
  const submissions = exactStringArray(
    `${input.sku} preview_submission_ids`,
    row.preview_submission_ids,
  );
  const eventShas = exactStringArray(
    `${input.sku} checkpoint_event_sha256s`,
    row.checkpoint_event_sha256s,
  );
  const fileShas = exactStringArray(
    `${input.sku} checkpoint_file_sha256s`,
    row.checkpoint_file_sha256s,
  );
  assert(
    submissions.length === eventShas.length &&
      eventShas.length === fileShas.length &&
      eventShas.every((value) => /^[a-f0-9]{64}$/.test(value)) &&
      fileShas.every((value) => /^[a-f0-9]{64}$/.test(value)),
    `${input.sku}: Catalog API preview/checkpoint provenance is incomplete.`,
  );
  return {
    identities: input.components.map((component) => classifyRecipeIdentity(component.product_name)),
    evidence: {
      policy: "EXACT_REVIEWED_CATALOG_API_EVIDENCE_V1",
      catalog_evidence_path: input.evidence.path,
      catalog_evidence_file_sha256: input.evidence.file_sha256,
      catalog_evidence_body_sha256: input.evidence.body_sha256,
      catalog_evidence_row_sha256: sha256(stableJson(row)),
      catalog_api_identifiers: policy.identifiers.map((identifier) => ({ ...identifier })),
      exact_unit_count: policy.unit_count,
      exact_number_of_items: policy.number_of_items,
      recipe_components_sha256: sha256(stableJson(policy.recipe_components)),
      generic_rejection: input.genericError.message,
    },
  };
}

function normalizedTitle(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function classifyRecipeIdentity(productName: string): RecipeIdentity {
  const title = normalizedTitle(productName);
  const has = (value: string): boolean => title.includes(value);
  if (has("apple") && has("cinnamon")) return "APPLE_CINNAMON_12G_PROTEIN";
  if (has("strawberry") && /12\s*g\s+protein/.test(title)) {
    return "STRAWBERRY_12G_PROTEIN";
  }
  if (has("mixed berry") && has("morning protein")) {
    return "MIXED_BERRY_MORNING_PROTEIN";
  }
  if (has("whole wheat") && has("strawberry")) {
    return "STRAWBERRY_WHOLE_WHEAT";
  }
  if (has("whole wheat") && has("grape")) return "GRAPE_WHOLE_WHEAT";
  if (has("chocolate") && has("hazelnut")) return "CHOCOLATE_HAZELNUT";
  if (has("chocolate")) return "CHOCOLATE_FLAVORED_SPREAD";
  if (has("blackberry")) return "BLACKBERRY";
  if (has("blueberry")) return "BLUEBERRY";
  if (has("raspberry")) return "RASPBERRY";
  if (has("strawberry")) return "STRAWBERRY";
  if (has("grape")) return "GRAPE";
  if (has("mixed berry")) return "MIXED_BERRY";
  if (has("honey")) return "HONEY";
  if (/\bpeanut butter\b/.test(title)) return "PLAIN_PEANUT_BUTTER";
  throw new Error(`Unrecognized Uncrustables recipe identity: ${productName}`);
}

const FLAVOR_MARKERS = [
  ["mixed_berry", /\bmixed\s+berry\b/],
  ["strawberry", /\bstrawberr(?:y|ies)\b/],
  ["blackberry", /\bblackberr(?:y|ies)\b/],
  ["blueberry", /\bblueberr(?:y|ies)\b/],
  ["raspberry", /\braspberr(?:y|ies)\b/],
  ["grape", /\bgrape\b/],
  ["apple", /\bapple\b/],
  ["cinnamon", /\bcinnamon\b/],
  ["honey", /\bhoney\b/],
  ["chocolate", /\bchocolate\b/],
  ["hazelnut", /\bhazelnut\b/],
] as const;

function expectedFlavorMarkers(identity: RecipeIdentity): string[] {
  switch (identity) {
    case "APPLE_CINNAMON_12G_PROTEIN":
      return ["apple", "cinnamon"];
    case "BLACKBERRY":
      return ["blackberry"];
    case "BLUEBERRY":
      return ["blueberry"];
    case "CHOCOLATE_FLAVORED_SPREAD":
      return ["chocolate"];
    case "CHOCOLATE_HAZELNUT":
      return ["chocolate", "hazelnut"];
    case "GRAPE":
    case "GRAPE_WHOLE_WHEAT":
      return ["grape"];
    case "HONEY":
      return ["honey"];
    case "MIXED_BERRY":
    case "MIXED_BERRY_MORNING_PROTEIN":
      return ["mixed_berry"];
    case "RASPBERRY":
      return ["raspberry"];
    case "STRAWBERRY":
    case "STRAWBERRY_12G_PROTEIN":
    case "STRAWBERRY_WHOLE_WHEAT":
      return ["strawberry"];
    case "PLAIN_PEANUT_BUTTER":
      return [];
  }
}

function foundFlavorMarkers(title: string): Set<string> {
  const normalized = normalizedTitle(title);
  const found = new Set<string>();
  for (const [marker, pattern] of FLAVOR_MARKERS) {
    if (pattern.test(normalized)) found.add(marker);
  }
  return found;
}

function hasStandalonePlainPeanutButter(title: string): boolean {
  const normalized = normalizedTitle(title);
  return /(?:^|,|\band\b)\s*(?:frozen\s+)?peanut butter(?:\s+sandwich(?:es)?)?(?=\s*(?:,|\band\b|$))/.test(
    normalized,
  );
}

/** Conservative, vocabulary-bound product identity check. It intentionally
 * rejects ambiguous catalog abbreviations instead of guessing. */
export function assertCatalogTitleMatchesRecipe(input: {
  catalogTitle: string;
  desiredTitle: string;
  intendedCount: number;
  componentProductNames: string[];
}): RecipeIdentity[] {
  const { catalogTitle, desiredTitle, intendedCount, componentProductNames } = input;
  assert(componentProductNames.length > 0, "Recipe has no components.");
  assert(Number.isInteger(intendedCount) && intendedCount > 0, "Intended count is invalid.");
  const identities = componentProductNames.map(classifyRecipeIdentity);
  const catalog = normalizedTitle(catalogTitle);
  assert(/\buncrustables\b/.test(catalog), "Amazon catalog title is not an Uncrustables title.");
  assert(/\bsandwich(?:es)?\b/.test(catalog), "Amazon catalog title does not identify sandwiches.");

  const countMatches = Array.from(
    catalogTitle.matchAll(/\b(\d+)\s+Count\b/gi),
    (match) => Number(match[1]),
  );
  assert(
    countMatches.length === 1 && countMatches[0] === intendedCount,
    `Amazon catalog title must contain exactly one exact ${intendedCount} Count claim.`,
  );
  const desiredCounts = Array.from(
    desiredTitle.matchAll(/\b(\d+)\s+Count\b/gi),
    (match) => Number(match[1]),
  );
  assert(
    desiredCounts.length === 1 && desiredCounts[0] === intendedCount,
    `Reviewed desired title must contain exactly one exact ${intendedCount} Count claim.`,
  );

  const expectedMarkers = new Set(identities.flatMap(expectedFlavorMarkers));
  const catalogMarkers = foundFlavorMarkers(catalogTitle);
  for (const marker of expectedMarkers) {
    assert(catalogMarkers.has(marker), `Amazon catalog title is missing recipe marker ${marker}.`);
  }
  for (const marker of catalogMarkers) {
    assert(expectedMarkers.has(marker), `Amazon catalog title contains unexpected recipe marker ${marker}.`);
  }

  const expectedProtein = identities.some((identity) =>
    [
      "APPLE_CINNAMON_12G_PROTEIN",
      "MIXED_BERRY_MORNING_PROTEIN",
      "STRAWBERRY_12G_PROTEIN",
    ].includes(identity),
  );
  const catalogHasProtein = /\bprotein\b/.test(catalog);
  assert(
    expectedProtein === catalogHasProtein,
    expectedProtein
      ? "Amazon catalog title omits the reviewed protein variant."
      : "Amazon catalog title adds an unreviewed protein variant.",
  );
  if (identities.includes("MIXED_BERRY_MORNING_PROTEIN")) {
    assert(
      /\bmorning\s+protein\b/.test(catalog),
      "Amazon catalog title does not prove the Morning Protein mixed-berry variant.",
    );
  } else {
    assert(
      !/\bmorning\s+protein\b/.test(catalog),
      "Amazon catalog title adds an unreviewed Morning Protein variant.",
    );
  }

  const expectedWholeWheat = identities.some((identity) =>
    ["GRAPE_WHOLE_WHEAT", "STRAWBERRY_WHOLE_WHEAT"].includes(identity),
  );
  const catalogHasWholeWheat = /\bwhole\s+wheat\b|\breduced\s+sugar\b/.test(catalog);
  assert(
    expectedWholeWheat === catalogHasWholeWheat,
    expectedWholeWheat
      ? "Amazon catalog title omits the reviewed whole-wheat/reduced-sugar variant."
      : "Amazon catalog title adds an unreviewed whole-wheat/reduced-sugar variant.",
  );

  const plainCount = identities.filter(
    (identity) => identity === "PLAIN_PEANUT_BUTTER",
  ).length;
  if (plainCount > 0) {
    assert(
      identities.length === 1
        ? catalogMarkers.size === 0 && /\bpeanut butter\b/.test(catalog)
        : hasStandalonePlainPeanutButter(catalogTitle),
      "Amazon catalog title does not prove the plain peanut-butter component.",
    );
  }

  // The desired title must itself prove the same reviewed identity. This keeps
  // the comparison anchored to both the exact manifest and the exact recipe.
  const desiredMarkers = foundFlavorMarkers(desiredTitle);
  for (const marker of expectedMarkers) {
    assert(desiredMarkers.has(marker), `Desired title is missing recipe marker ${marker}.`);
  }
  return identities;
}

function intendedCount(
  text: NonNullable<DesiredRepairManifest["repairs"][number]["text_count"]>,
): number {
  const value =
    text.unit_count_type === "Ounce"
      ? text.number_of_items
      : text.unit_count ?? text.number_of_items;
  assert(Number.isInteger(value) && Number(value) > 0, "Desired text has no exact sellable count.");
  return Number(value);
}

function parseQuotedCatalogTitle(message: string): string {
  const marker = /Amazon\s*\[\s*en_US\s*:\s*"/gi;
  const matches = [...message.matchAll(marker)];
  assert(matches.length === 1, "Catalog conflict must contain exactly one Amazon [en_US] title.");
  let index = (matches[0].index ?? 0) + matches[0][0].length;
  let value = "";
  let escaped = false;
  for (; index < message.length; index++) {
    const character = message[index];
    if (escaped) {
      value += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === '"') {
      const suffix = message.slice(index + 1);
      assert(/^\s*\]/.test(suffix), "Amazon catalog title has an ambiguous closing delimiter.");
      assert(value.trim() === value && value.length > 0, "Amazon catalog title is empty or padded.");
      return value;
    } else {
      value += character;
    }
  }
  throw new Error("Amazon catalog title is unterminated.");
}

function issueStrings(issue: UnknownRecord): {
  code: string;
  message: string;
  severity: string;
  attributeNames: string[];
} {
  const code = String(issue.code ?? "").trim();
  const message = String(issue.message ?? "").trim();
  const severity = String(issue.severity ?? "").trim().toUpperCase();
  const attributeNames = Array.isArray(issue.attributeNames)
    ? issue.attributeNames.map((value) => String(value).trim()).filter(Boolean)
    : [];
  return { code, message, severity, attributeNames };
}

function assertCatalogConflictIssue(issue: UnknownRecord): {
  code: string;
  message: string;
  asin: string;
  catalogTitle: string;
} {
  const parsed = issueStrings(issue);
  assert(parsed.severity === "ERROR", "Catalog-conflict parser received a non-ERROR issue.");
  assert(
    parsed.attributeNames.length === 1 && parsed.attributeNames[0] === "item_name",
    "ERROR is not exclusively an item_name conflict.",
  );
  const recognizedCode = parsed.code === "8541";
  const recognizedEquivalent =
    /amazon\s+catalog/i.test(parsed.message) &&
    /(conflict|contradict|different)/i.test(parsed.message);
  assert(
    recognizedCode || recognizedEquivalent,
    `Unrecognized catalog item_name ERROR code ${parsed.code || "<empty>"}.`,
  );
  assert(recognizedEquivalent, "Catalog item_name ERROR message is not an explicit Amazon catalog conflict.");
  const asins = [...parsed.message.matchAll(/\bASIN\s+([A-Z0-9]{10})\b/g)].map(
    (match) => match[1],
  );
  assert(new Set(asins).size === 1 && asins.length >= 1, "Catalog conflict has no unique ASIN.");
  return {
    code: parsed.code,
    message: parsed.message,
    asin: asins[0],
    catalogTitle: parseQuotedCatalogTitle(parsed.message),
  };
}

function parseFailedPreview(event: CheckpointEvent): {
  submissionId: string;
  issues: UnknownRecord[];
  errors: UnknownRecord[];
} {
  const error = typeof event.detail.error === "string" ? event.detail.error : "";
  assert(error.includes("VALIDATION_PREVIEW rejected"), `${event.action_id}: FAILED is not a preview rejection.`);
  const jsonStart = error.indexOf("{");
  assert(jsonStart >= 0, `${event.action_id}: FAILED preview has no response JSON.`);
  let response: UnknownRecord;
  try {
    const parsed = JSON.parse(error.slice(jsonStart)) as unknown;
    assert(isRecord(parsed), "FAILED preview response is not an object.");
    response = parsed;
  } catch (cause) {
    throw new Error(
      `${event.action_id}: FAILED preview response JSON is invalid: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  const submissionId = String(response.submission_id ?? "").trim();
  assert(submissionId.length > 0, `${event.action_id}: FAILED preview has no submission id.`);
  assert(
    Array.isArray(response.issues) && response.issues.every(isRecord),
    `${event.action_id}: FAILED preview issues are absent or malformed.`,
  );
  const issues = response.issues as UnknownRecord[];
  const errors = issues.filter((issue) => issueStrings(issue).severity === "ERROR");
  assert(errors.length > 0, `${event.action_id}: FAILED preview has no ERROR issue.`);
  return { submissionId, issues, errors };
}

const KP_DEPENDENCY_SKU = "KP-ASYC-RN84" as const;
const KP_DEPENDENCY_ASIN = "B0H83FYZR3" as const;
const KP_TEXT_ACTION_ID = "KP-ASYC-RN84:text_count" as const;
const KP_EXPECTED_TITLE =
  "Smucker's Uncrustables Peanut Butter & Blueberry Frozen Sandwiches, Individually Wrapped, 90 Count" as const;

function stagedKpDependencyException(input: {
  event: CheckpointEvent;
  parsed: ReturnType<typeof parseFailedPreview>;
  file: { file: string; fileSha256: string };
  plan: UncrustablesRepairPlan;
  terminalByAction: ReadonlyMap<string, CheckpointEvent>;
}): StagedDependencyExceptionEvidence | null {
  const { event, parsed, file, plan, terminalByAction } = input;
  if (
    event.sku !== KP_DEPENDENCY_SKU ||
    !["STRUCTURED_ATTRIBUTES", "OFFER"].includes(event.kind)
  ) {
    return null;
  }
  if (parsed.issues.length !== 1 || parsed.errors.length !== 1) return null;
  const issue = issueStrings(parsed.errors[0]);
  if (
    issue.code !== "90244" ||
    issue.attributeNames.length !== 1 ||
    issue.attributeNames[0] !== "unit_count"
  ) {
    return null;
  }
  // No WARNING (including obsolete business_price 90000900), INFO, or second
  // ERROR is permitted in this exception response.
  assert(issue.severity === "ERROR", `${event.action_id}: staged dependency issue is not ERROR.`);
  const entry = plan.entries.find((candidate) => candidate.sku === KP_DEPENDENCY_SKU);
  assert(
    entry?.asin === KP_DEPENDENCY_ASIN && entry.audited_product_type === "PASTRY",
    "KP staged dependency exception is not bound to exact ASIN B0H83FYZR3 / PASTRY.",
  );
  const textActions = entry.actions.filter(
    (action) => action.action_id === KP_TEXT_ACTION_ID && action.desired.kind === "TEXT_COUNT",
  );
  assert(textActions.length === 1, "KP staged dependency requires the exact TEXT_COUNT action.");
  const textAction = textActions[0];
  assert(textAction.desired.kind === "TEXT_COUNT", "KP TEXT_COUNT desired state is missing.");
  const desired = textAction.desired.value;
  assert(
    desired.title === KP_EXPECTED_TITLE &&
      desired.unit_count === 252 &&
      desired.unit_count_type === "Ounce" &&
      desired.number_of_items === 90 &&
      desired.request_product_type === "PASTRY" &&
      desired.expected_product_type === "PASTRY" &&
      stableJson(desired.must_clear_issue_codes) === stableJson(["90244"]) &&
      desired.fallback === undefined,
    "KP staged dependency TEXT_COUNT desired state differs from exact 252 Ounce / 90 items PASTRY strategy.",
  );
  const dependencyCheckpoint = terminalByAction.get(KP_TEXT_ACTION_ID);
  assert(
    dependencyCheckpoint?.status === "PREVIEW_VALID" &&
      dependencyCheckpoint.detail.validation_only === true &&
      dependencyCheckpoint.detail.status === "VALID",
    "KP staged dependency requires terminal PREVIEW_VALID for TEXT_COUNT in the same checkpoint set.",
  );
  const patchPaths = Array.isArray(dependencyCheckpoint.detail.patch_paths)
    ? dependencyCheckpoint.detail.patch_paths.map(String)
    : [];
  assert(
    patchPaths.includes("/attributes/unit_count") &&
      patchPaths.includes("/attributes/number_of_items"),
    "KP TEXT_COUNT preview does not prove both unit_count and number_of_items patches.",
  );
  return {
    sku: KP_DEPENDENCY_SKU,
    asin: KP_DEPENDENCY_ASIN,
    action_id: event.action_id,
    kind: event.kind as "STRUCTURED_ATTRIBUTES" | "OFFER",
    submission_id: parsed.submissionId,
    issue_code: "90244",
    attribute_name: "unit_count",
    checkpoint_event_sha256: event.sha256,
    checkpoint_file_sha256: file.fileSha256,
    checkpoint_file: path.resolve(file.file),
    issue_message_sha256: sha256(issue.message),
    depends_on_text_count_action_id: KP_TEXT_ACTION_ID,
    depends_on_text_count_checkpoint_sha256: dependencyCheckpoint.sha256,
    desired_text_count_sha256: sha256(stableJson(desired)),
  };
}

async function jsonFilesRecursively(directory: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && entry.name.endsWith(".json")) result.push(target);
    }
  }
  await visit(directory);
  return result;
}

async function readSealedCheckpoints(input: {
  directory: string;
  plan: UncrustablesRepairPlan;
}): Promise<{
  events: Array<{ event: CheckpointEvent; file: string; fileSha256: string }>;
  terminalByAction: Map<string, CheckpointEvent>;
  checkpointSetSha256: string;
}> {
  const expectedActions = new Map(
    input.plan.entries.flatMap((entry) =>
      entry.actions.map((action) => [action.action_id, { entry, action }] as const),
    ),
  );
  const files = await jsonFilesRecursively(path.resolve(input.directory));
  assert(files.length > 0, "Checkpoint directory contains no JSON events.");
  const events: Array<{ event: CheckpointEvent; file: string; fileSha256: string }> = [];
  const eventIds = new Set<string>();
  const byAction = new Map<string, CheckpointEvent[]>();
  for (const file of files) {
    const bytes = await readFile(file);
    let event: CheckpointEvent;
    try {
      event = JSON.parse(bytes.toString("utf8")) as CheckpointEvent;
    } catch {
      throw new Error(`Invalid checkpoint JSON: ${file}`);
    }
    const { sha256: claimed, ...body } = event;
    assert(
      event.schema_version === CHECKPOINT_SCHEMA &&
        event.immutable === true &&
        event.plan_sha256 === input.plan.sha256 &&
        /^[a-f0-9]{64}$/.test(String(claimed)) &&
        claimed === sha256(stableJson(body)),
      `Invalid/tampered checkpoint event: ${file}`,
    );
    assert(!eventIds.has(event.event_id), `Duplicate checkpoint event id: ${event.event_id}`);
    eventIds.add(event.event_id);
    assert(
      event.status === "PREVIEW_VALID" || event.status === "FAILED",
      `Checkpoint set is not a pure diagnostic preview: ${event.action_id} has ${event.status}.`,
    );
    const expected = expectedActions.get(event.action_id);
    assert(expected, `Checkpoint references an unselected action: ${event.action_id}`);
    assert(
      event.sku === expected.entry.sku && event.kind === expected.action.kind,
      `Checkpoint identity differs from plan action ${event.action_id}.`,
    );
    assert(!Number.isNaN(Date.parse(event.created_at)), `Checkpoint has invalid created_at: ${file}`);
    const fileSha256 = sha256(bytes);
    if (event.status === "PREVIEW_VALID") {
      assert(
        event.detail.validation_only === true && event.detail.status === "VALID",
        `${event.action_id}: PREVIEW_VALID is not a validation-only VALID response.`,
      );
      const issues = Array.isArray(event.detail.issues)
        ? event.detail.issues.filter(isRecord)
        : [];
      assert(
        !issues.some((issue) => issueStrings(issue).severity === "ERROR"),
        `${event.action_id}: PREVIEW_VALID contains an ERROR issue.`,
      );
    }
    events.push({ event, file, fileSha256 });
    const actionEvents = byAction.get(event.action_id) ?? [];
    actionEvents.push(event);
    byAction.set(event.action_id, actionEvents);
  }

  const terminalByAction = new Map<string, CheckpointEvent>();
  for (const actionId of expectedActions.keys()) {
    const actionEvents = byAction.get(actionId) ?? [];
    assert(actionEvents.length > 0, `Missing checkpoint coverage for selected action ${actionId}.`);
    actionEvents.sort(
      (left, right) =>
        left.created_at.localeCompare(right.created_at) ||
        left.event_id.localeCompare(right.event_id),
    );
    const terminal = actionEvents[actionEvents.length - 1];
    assert(
      terminal.status === "PREVIEW_VALID" || terminal.status === "FAILED",
      `Selected action ${actionId} has no terminal PREVIEW_VALID/FAILED outcome.`,
    );
    const statuses = new Set(actionEvents.map((event) => event.status));
    assert(
      !(statuses.has("FAILED") && statuses.has("PREVIEW_VALID")),
      `${actionId}: mixed FAILED/PREVIEW_VALID history is ambiguous; use one clean diagnostic run.`,
    );
    terminalByAction.set(actionId, terminal);
  }

  assert(
    byAction.size === expectedActions.size,
    "Checkpoint action coverage differs from the exact selected plan action set.",
  );
  const checkpointSetSha256 = sha256(
    stableJson(
      events
        .map(({ event, fileSha256 }) => ({
          action_id: event.action_id,
          event_sha256: event.sha256,
          file_sha256: fileSha256,
        }))
        .sort(
          (left, right) =>
            left.action_id.localeCompare(right.action_id) ||
            left.event_sha256.localeCompare(right.event_sha256),
        ),
    ),
  );
  return { events, terminalByAction, checkpointSetSha256 };
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function customerProjection(repair: UnknownRecord): UnknownRecord {
  const result: UnknownRecord = { sku: repair.sku };
  for (const key of ["media", "offer", "text_count", "structured_attributes"]) {
    if (repair[key] !== undefined) result[key] = repair[key];
  }
  return result;
}

export async function prepareCatalogTitleAlignment(
  options: PrepareCatalogTitleAlignmentOptions,
): Promise<PreparedCatalogTitleAlignment> {
  const expectedPlanInternalSha256 = exactSha(
    "expectedPlanInternalSha256",
    options.expectedPlanInternalSha256,
  );
  const expectedPlanFileSha256 = exactSha(
    "expectedPlanFileSha256",
    options.expectedPlanFileSha256,
  );
  const expectedManifestSha256 = exactSha(
    "expectedDesiredManifestFileSha256",
    options.expectedDesiredManifestFileSha256,
  );
  const reviewed = new Date(options.reviewedAt);
  assert(
    !Number.isNaN(reviewed.valueOf()) && reviewed.toISOString() === options.reviewedAt,
    "reviewedAt must be an exact canonical ISO-8601 timestamp.",
  );
  const requiredRows = options.requiredManifestRows ?? 164;
  assert(Number.isInteger(requiredRows) && requiredRows > 0, "requiredManifestRows is invalid.");
  const catalogApiEvidence = await readReviewedCatalogApiEvidence({
    path: options.catalogEvidencePath,
    expectedFileSha256: options.expectedCatalogEvidenceFileSha256,
    expectedBodySha256: options.expectedCatalogEvidenceBodySha256,
    reviewedAt: options.reviewedAt,
  });

  const planPath = path.resolve(options.planPath);
  const planBytes = await readFile(planPath);
  assert(sha256(planBytes) === expectedPlanFileSha256, "Source URP file SHA-256 mismatch.");
  const plan = JSON.parse(planBytes.toString("utf8")) as UncrustablesRepairPlan;
  verifyRepairPlan(plan);
  assert(plan.sha256 === expectedPlanInternalSha256, "Source URP internal SHA-256 mismatch.");
  assert(plan.desired_manifest_source, "Source URP has no exact desired-manifest binding.");

  const desiredManifestPath = path.resolve(options.desiredManifestPath);
  assert(
    path.resolve(plan.desired_manifest_source.path) === desiredManifestPath,
    "Desired manifest path differs from the exact source URP binding.",
  );
  const manifestBytes = await readFile(desiredManifestPath);
  assert(sha256(manifestBytes) === expectedManifestSha256, "Desired manifest file SHA-256 mismatch.");
  assert(
    plan.desired_manifest_source.sha256 === expectedManifestSha256,
    "Source URP is bound to a different desired manifest SHA-256.",
  );
  const sourceManifest = JSON.parse(manifestBytes.toString("utf8")) as
    DesiredRepairManifest & UnknownRecord & { body_sha256?: string };
  assert(
    sourceManifest.schema_version === DESIRED_MANIFEST_SCHEMA &&
      sourceManifest.immutable === true &&
      sourceManifest.source_ledger_sha256 === plan.source_ledger.sha256 &&
      Array.isArray(sourceManifest.repairs),
    "Desired manifest is not the exact immutable ledger-bound source expected by the URP.",
  );
  assert(
    typeof sourceManifest.body_sha256 === "string" &&
      canonicalBodySeal(sourceManifest) === sourceManifest.body_sha256,
    "Desired manifest body seal is invalid.",
  );
  assert(
    sourceManifest.repairs.length === requiredRows,
    `Desired manifest must contain exactly ${requiredRows} repairs.`,
  );

  const ledgerPath = path.resolve(plan.source_ledger.path);
  const ledgerBytes = await readFile(ledgerPath);
  assert(sha256(ledgerBytes) === plan.source_ledger.sha256, "Source ledger file SHA-256 mismatch.");
  const ledger = JSON.parse(ledgerBytes.toString("utf8")) as { rows?: unknown };
  assert(Array.isArray(ledger.rows), "Source ledger has no rows.");
  const ledgerBySku = new Map<string, LedgerRow>();
  for (const raw of ledger.rows) {
    if (!isRecord(raw)) continue;
    const sku = String(raw.sku ?? "").trim();
    const asin = String(raw.asin ?? "").trim();
    const canonical = isRecord(raw.canonical) ? raw.canonical : null;
    const components = canonical && Array.isArray(canonical.components)
      ? canonical.components
          .filter(isRecord)
          .map((component) => ({
            product_name: String(component.product_name ?? "").trim(),
            qty: Number(component.qty),
          }))
      : [];
    if (sku && asin) {
      assert(!ledgerBySku.has(sku), `Duplicate source-ledger SKU ${sku}.`);
      ledgerBySku.set(sku, { sku, asin, canonical: { components } });
    }
  }

  const repairBySku = new Map(sourceManifest.repairs.map((repair) => [repair.sku, repair]));
  assert(repairBySku.size === sourceManifest.repairs.length, "Desired manifest contains duplicate SKUs.");
  assert(
    plan.entries.length > 0 && plan.entries.length <= requiredRows,
    `Source URP must select between 1 and ${requiredRows} entries.`,
  );
  const planSkus = new Set(plan.entries.map((entry) => entry.sku));
  assert(planSkus.size === plan.entries.length, "Source URP contains duplicate SKUs.");
  assert(
    [...planSkus].every((sku) => repairBySku.has(sku)),
    "Source URP selects a SKU absent from the exact full desired manifest.",
  );
  for (const entry of plan.entries) {
    const repair = repairBySku.get(entry.sku);
    assert(repair?.text_count?.title, `${entry.sku}: desired manifest lacks a title.`);
    const textActions = entry.actions.filter((action) => action.desired.kind === "TEXT_COUNT");
    assert(textActions.length === 1, `${entry.sku}: URP must contain exactly one TEXT_COUNT action.`);
    assert(
      textActions[0].desired.kind === "TEXT_COUNT" &&
        textActions[0].desired.value.title === repair.text_count.title,
      `${entry.sku}: URP title differs from its exact desired manifest.`,
    );
    const ledgerRow = ledgerBySku.get(entry.sku);
    assert(ledgerRow && ledgerRow.asin === entry.asin, `${entry.sku}: ledger/URP ASIN mismatch.`);
  }

  const checkpoints = await readSealedCheckpoints({
    directory: options.checkpointDirectory,
    plan,
  });
  const eventFileBySha = new Map(
    checkpoints.events.map((item) => [item.event.sha256, item]),
  );
  const evidenceBySku = new Map<string, CatalogConflictEvidence[]>();
  const stagedDependencyExceptions: StagedDependencyExceptionEvidence[] = [];
  for (const checkpoint of checkpoints.events) {
    const terminal = checkpoint.event;
    if (terminal.status !== "FAILED") continue;
    const parsed = parseFailedPreview(terminal);
    const entry = plan.entries.find((candidate) =>
      candidate.actions.some((action) => action.action_id === terminal.action_id),
    );
    assert(entry, `${terminal.action_id}: source plan entry is missing.`);
    const file = eventFileBySha.get(terminal.sha256);
    assert(file, `${terminal.action_id}: checkpoint file evidence is missing.`);
    const stagedDependency = stagedKpDependencyException({
      event: terminal,
      parsed,
      file,
      plan,
      terminalByAction: checkpoints.terminalByAction,
    });
    if (stagedDependency) {
      stagedDependencyExceptions.push(stagedDependency);
      continue;
    }
    for (const issue of parsed.errors) {
      const conflict = assertCatalogConflictIssue(issue);
      assert(conflict.asin === entry.asin, `${entry.sku}: catalog conflict belongs to another ASIN.`);
      const evidence: CatalogConflictEvidence = {
        sku: entry.sku,
        asin: entry.asin,
        action_id: terminal.action_id,
        kind: terminal.kind,
        submission_id: parsed.submissionId,
        issue_code: conflict.code,
        catalog_title: conflict.catalogTitle,
        checkpoint_event_sha256: terminal.sha256,
        checkpoint_file_sha256: file.fileSha256,
        checkpoint_file: path.resolve(file.file),
        issue_message_sha256: sha256(conflict.message),
      };
      const values = evidenceBySku.get(entry.sku) ?? [];
      values.push(evidence);
      evidenceBySku.set(entry.sku, values);
    }
  }
  const terminalFailedActionIds = new Set(
    [...checkpoints.terminalByAction.values()]
      .filter((event) => event.status === "FAILED")
      .map((event) => event.action_id),
  );
  const classifiedFailedActionIds = new Set([
    ...[...evidenceBySku.values()].flat().map((item) => item.action_id),
    ...stagedDependencyExceptions.map((item) => item.action_id),
  ]);
  assert(
    terminalFailedActionIds.size === classifiedFailedActionIds.size &&
      [...terminalFailedActionIds].every((actionId) => classifiedFailedActionIds.has(actionId)),
    "Every terminal FAILED action must be classified exactly as catalog-title evidence or a staged dependency exception.",
  );
  assert(evidenceBySku.size > 0, "Complete preview contains no catalog title conflicts to align.");

  const reviews: CatalogTitleAlignmentReview[] = [];
  for (const [sku, evidence] of [...evidenceBySku.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const entry = plan.entries.find((candidate) => candidate.sku === sku);
    const repair = repairBySku.get(sku);
    const ledgerRow = ledgerBySku.get(sku);
    assert(entry && repair?.text_count?.title && ledgerRow, `${sku}: alignment source row is incomplete.`);
    const catalogTitles = new Set(evidence.map((item) => item.catalog_title));
    assert(catalogTitles.size === 1, `${sku}: checkpoints disagree on the exact Amazon catalog title.`);
    const catalogTitle = [...catalogTitles][0];
    assert(catalogTitle !== repair.text_count.title, `${sku}: catalog conflict would not change the title.`);
    const count = intendedCount(repair.text_count);
    const recipeTotal = ledgerRow.canonical.components.reduce(
      (sum, component) => sum + component.qty,
      0,
    );
    assert(recipeTotal === count, `${sku}: source recipe total differs from intended count.`);
    if (NEVER_ALIGN_CATALOG_IDENTITY_SKUS.has(sku)) {
      throw new Error(
        `${sku}: catalog identity is explicitly BLOCKED and must be excluded from an apply plan.`,
      );
    }
    let identities: RecipeIdentity[];
    let identityValidation: CatalogTitleAlignmentReview["identity_validation"] =
      "GENERIC_STRICT";
    let reviewedOverride: ReviewedCatalogOverrideEvidence | undefined;
    try {
      identities = assertCatalogTitleMatchesRecipe({
        catalogTitle,
        desiredTitle: repair.text_count.title,
        intendedCount: count,
        componentProductNames: ledgerRow.canonical.components.map(
          (component) => component.product_name,
        ),
      });
    } catch (cause) {
      const genericError = cause instanceof Error ? cause : new Error(String(cause));
      if (!REVIEWED_CATALOG_OVERRIDE_POLICIES.has(sku)) {
        throw new Error(
          `${genericError.message} ${sku}: no exact reviewed Catalog API evidence override exists.`,
        );
      }
      const override = reviewedCatalogOverride({
        sku,
        asin: entry.asin,
        priorTitle: repair.text_count.title,
        catalogTitle,
        intendedCount: count,
        components: ledgerRow.canonical.components,
        genericError,
        evidence: catalogApiEvidence,
      });
      identities = override.identities;
      reviewedOverride = override.evidence;
      identityValidation = "REVIEWED_CATALOG_API_EVIDENCE";
    }
    reviews.push({
      sku,
      asin: entry.asin,
      intended_count: count,
      prior_title: repair.text_count.title,
      catalog_title: catalogTitle,
      recipe_identities: identities,
      identity_validation: identityValidation,
      ...(reviewedOverride ? { reviewed_catalog_override: reviewedOverride } : {}),
      evidence: evidence.sort(
        (left, right) =>
          left.action_id.localeCompare(right.action_id) ||
          left.submission_id.localeCompare(right.submission_id),
      ),
    });
  }

  const cloned = deepClone(sourceManifest) as CatalogTitleAlignedManifest;
  const clonedBySku = new Map(cloned.repairs.map((repair) => [repair.sku, repair]));
  for (const review of reviews) {
    const repair = clonedBySku.get(review.sku);
    assert(repair?.text_count?.title, `${review.sku}: cloned manifest row has no title.`);
    const originalReview = repair.review;
    repair.text_count.title = review.catalog_title;
    repair.review = {
      confidence: "HIGH",
      rationale: `${originalReview?.rationale ?? "Exact recipe-grounded customer copy was reviewed."} The title is aligned to the exact Amazon catalog item_name returned for the same ASIN after count and ${review.identity_validation === "GENERIC_STRICT" ? "conservative recipe-identity validation" : "a separately recorded exact reviewed Catalog API evidence override"}.`,
      evidence: [
        ...(originalReview?.evidence ?? []),
        `Amazon catalog-title alignment source URP internal SHA-256: ${plan.sha256}; file SHA-256: ${expectedPlanFileSha256}.`,
        `Exact source desired manifest SHA-256: ${expectedManifestSha256}.`,
        `Validated same ASIN ${review.asin}, exact ${review.intended_count} Count, and recipe identities ${review.recipe_identities.join(", ")}.`,
        ...(review.reviewed_catalog_override
          ? [
              `Exact reviewed Catalog API evidence file SHA-256: ${review.reviewed_catalog_override.catalog_evidence_file_sha256}; body SHA-256: ${review.reviewed_catalog_override.catalog_evidence_body_sha256}; row SHA-256: ${review.reviewed_catalog_override.catalog_evidence_row_sha256}.`,
            ]
          : []),
        `VALIDATION_PREVIEW submission IDs: ${review.evidence.map((item) => item.submission_id).join(", ")}.`,
        `Sealed checkpoint event SHA-256 values: ${review.evidence.map((item) => item.checkpoint_event_sha256).join(", ")}.`,
      ],
      supersedes: [
        ...((originalReview as typeof repair.review | undefined)?.supersedes ?? []),
        {
          field: "text_count.title",
          prior_value: review.prior_title,
          source_manifest_path: desiredManifestPath,
          source_manifest_sha256: expectedManifestSha256,
          reason: "AMAZON_CATALOG_ITEM_NAME_CONFLICT",
        },
      ],
    };
  }

  const terminalValues = [...checkpoints.terminalByAction.values()];
  const reviewedCatalogOverrides = reviews
    .map((review) => review.reviewed_catalog_override)
    .filter((value): value is ReviewedCatalogOverrideEvidence => value != null);
  const sourceArtifact: AlignmentSourceArtifact = {
    schema_version: CATALOG_TITLE_ALIGNMENT_SCHEMA,
    offline_only: true,
    source_plan: {
      path: planPath,
      internal_sha256: plan.sha256,
      file_sha256: expectedPlanFileSha256,
    },
    source_desired_manifest: {
      path: desiredManifestPath,
      file_sha256: expectedManifestSha256,
      body_sha256: sourceManifest.body_sha256 as string,
    },
    source_ledger: {
      path: ledgerPath,
      file_sha256: plan.source_ledger.sha256,
    },
    checkpoint_set: {
      path: path.resolve(options.checkpointDirectory),
      sha256: checkpoints.checkpointSetSha256,
      files: checkpoints.events.length,
      selected_actions: terminalValues.length,
      terminal_preview_valid: terminalValues.filter((event) => event.status === "PREVIEW_VALID").length,
      terminal_failed_catalog_title_conflict: new Set(
        [...evidenceBySku.values()].flat().map((item) => item.action_id),
      ).size,
      terminal_staged_dependency_exceptions: new Set(
        stagedDependencyExceptions.map((item) => item.action_id),
      ).size,
      staged_dependency_exceptions: stagedDependencyExceptions.sort((left, right) =>
        left.action_id.localeCompare(right.action_id),
      ),
    },
    ...(reviewedCatalogOverrides.length > 0
      ? {
          reviewed_catalog_api_evidence: {
            schema_version: CATALOG_TITLE_API_EVIDENCE_SCHEMA,
            path: catalogApiEvidence?.path as string,
            file_sha256: catalogApiEvidence?.file_sha256 as string,
            body_sha256: catalogApiEvidence?.body_sha256 as string,
            captured_at: catalogApiEvidence?.captured_at as string,
            source_plan_internal_sha256:
              catalogApiEvidence?.source_plan_internal_sha256 as string,
            source_plan_file_sha256: catalogApiEvidence?.source_plan_file_sha256 as string,
            exact_override_skus: reviews
              .filter((review) => review.reviewed_catalog_override)
              .map((review) => review.sku)
              .sort(),
          },
        }
      : {}),
    aligned_rows: reviews.length,
    generic_strict_alignments: reviews.filter(
      (review) => review.identity_validation === "GENERIC_STRICT",
    ).length,
    reviewed_catalog_api_overrides: reviewedCatalogOverrides.length,
  };
  cloned.reviewed_at = options.reviewedAt;
  cloned.source_artifacts = {
    ...(isRecord(sourceManifest.source_artifacts) ? deepClone(sourceManifest.source_artifacts) : {}),
    amazon_catalog_title_alignment: sourceArtifact,
  };
  cloned.supersedes = [
    ...(Array.isArray(sourceManifest.supersedes) ? deepClone(sourceManifest.supersedes) : []),
    {
      path: desiredManifestPath,
      sha256: expectedManifestSha256,
      status: "SUPERSEDED_DO_NOT_APPLY",
      reason: "Exact Amazon catalog item_name conflicts aligned after complete validation preview.",
    },
  ];
  cloned.merge_summary = {
    ...(isRecord(sourceManifest.merge_summary) ? deepClone(sourceManifest.merge_summary) : {}),
    amazon_catalog_title_alignments: reviews.length,
    amazon_catalog_title_generic_strict_alignments:
      sourceArtifact.generic_strict_alignments,
    amazon_catalog_title_reviewed_api_overrides:
      sourceArtifact.reviewed_catalog_api_overrides,
  };
  delete (cloned as unknown as UnknownRecord).body_sha256;
  cloned.body_sha256 = canonicalBodySeal(cloned as unknown as UnknownRecord);

  const reviewBySku = new Map(reviews.map((review) => [review.sku, review]));
  for (const original of sourceManifest.repairs) {
    const after = clonedBySku.get(original.sku);
    assert(after, `${original.sku}: cloned row is missing.`);
    if (!reviewBySku.has(original.sku)) {
      assert(
        stableJson(after) === stableJson(original),
        `${original.sku}: unaffected repair row changed.`,
      );
      continue;
    }
    const beforeCustomer = deepClone(customerProjection(original as unknown as UnknownRecord));
    const afterCustomer = deepClone(customerProjection(after as unknown as UnknownRecord));
    const beforeText = beforeCustomer.text_count as UnknownRecord;
    const afterText = afterCustomer.text_count as UnknownRecord;
    delete beforeText.title;
    delete afterText.title;
    assert(
      stableJson(beforeCustomer) === stableJson(afterCustomer),
      `${original.sku}: a customer field other than text_count.title changed.`,
    );
  }
  assert(
    canonicalBodySeal(cloned as unknown as UnknownRecord) === cloned.body_sha256,
    "Aligned desired manifest body seal failed.",
  );
  return {
    manifest: cloned,
    sourcePlan: plan,
    sourcePlanFileSha256: expectedPlanFileSha256,
    sourceDesiredManifestFileSha256: expectedManifestSha256,
    checkpointSetSha256: checkpoints.checkpointSetSha256,
    reviews,
    stagedDependencyExceptions,
    reviewedCatalogOverrides,
  };
}

async function writeIdenticalOrCreate(file: string, bytes: Buffer): Promise<void> {
  try {
    const existing = await readFile(file);
    assert(existing.equals(bytes), `Refusing to overwrite immutable artifact: ${file}`);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  await writeFile(temporary, bytes, { flag: "wx" });
  await rename(temporary, file);
}

export async function writeCatalogTitleAlignmentArtifact(
  outputDirectory: string,
  prepared: PreparedCatalogTitleAlignment,
): Promise<WrittenCatalogTitleAlignment> {
  const bytes = Buffer.from(`${JSON.stringify(prepared.manifest, null, 2)}\n`);
  const fileSha256 = sha256(bytes);
  const timestamp = prepared.manifest.reviewed_at.replace(/[-:.]/g, "");
  const basename =
    `uncrustables-amazon-catalog-title-aligned-${timestamp}-` +
    `${prepared.manifest.body_sha256.slice(0, 12)}.json`;
  const manifestPath = path.resolve(outputDirectory, basename);
  const sidecarPath = `${manifestPath}.sha256`;
  await writeIdenticalOrCreate(manifestPath, bytes);
  await writeIdenticalOrCreate(
    sidecarPath,
    Buffer.from(`${fileSha256}  ${basename}\n`),
  );
  return {
    manifestPath,
    sidecarPath,
    fileSha256,
    bodySha256: prepared.manifest.body_sha256,
    alignedRows: prepared.reviews.length,
  };
}

function rawLedgerDecisionRow(ledger: UnknownRecord, sku: string): UnknownRecord {
  assert(Array.isArray(ledger.rows), "Decision source ledger has no rows.");
  const matches = ledger.rows.filter(
    (row): row is UnknownRecord => isRecord(row) && row.sku === sku,
  );
  assert(matches.length === 1, `Decision source ledger must contain exactly one ${sku} row.`);
  return matches[0];
}

function decisionRecipeComponents(row: UnknownRecord): LedgerComponent[] {
  assert(isRecord(row.canonical) && Array.isArray(row.canonical.components), "Decision ledger recipe is missing.");
  return row.canonical.components.map((component) => {
    assert(isRecord(component), "Decision ledger recipe component is malformed.");
    return {
      product_name: String(component.product_name ?? ""),
      qty: Number(component.qty),
    };
  });
}

function desiredDecisionRepair(manifest: DesiredRepairManifest, sku: string) {
  const matches = manifest.repairs.filter((repair) => repair.sku === sku);
  assert(matches.length === 1, `Decision desired manifest must contain exactly one ${sku} row.`);
  assert(matches[0].text_count?.title, `${sku}: decision desired text/count row is missing.`);
  return matches[0];
}

export async function prepareCatalogIdentityDecision(
  options: PrepareCatalogIdentityDecisionOptions,
): Promise<PreparedCatalogIdentityDecision> {
  const createdAt = new Date(options.createdAt);
  assert(
    !Number.isNaN(createdAt.valueOf()) &&
      createdAt.toISOString() === options.createdAt &&
      createdAt.valueOf() <= Date.now(),
    "Catalog identity decision createdAt must be a canonical, non-future ISO timestamp.",
  );
  const catalogEvidence = await readReviewedCatalogApiEvidence({
    path: options.catalogEvidencePath,
    expectedFileSha256: options.expectedCatalogEvidenceFileSha256,
    expectedBodySha256: options.expectedCatalogEvidenceBodySha256,
    reviewedAt: options.createdAt,
  });
  assert(catalogEvidence, "Catalog identity decision requires exact Catalog API evidence.");

  const sourcePlanPath = path.resolve(options.sourcePlanPath);
  const sourcePlanBytes = await readFile(sourcePlanPath);
  assert(
    sha256(sourcePlanBytes) === REVIEWED_CATALOG_EVIDENCE_SOURCE_PLAN_FILE_SHA256,
    "Decision source plan file SHA-256 mismatch.",
  );
  const sourcePlan = JSON.parse(sourcePlanBytes.toString("utf8")) as UncrustablesRepairPlan;
  const { sha256: sourcePlanClaimedSha, ...sourcePlanBody } = sourcePlan;
  assert(
    sourcePlan.schema_version === "uncrustables-surgical-repair/v2" &&
      sourcePlan.immutable === true &&
      sourcePlanClaimedSha === REVIEWED_CATALOG_EVIDENCE_SOURCE_PLAN_INTERNAL_SHA256 &&
      sha256(stableJson(sourcePlanBody)) ===
        REVIEWED_CATALOG_EVIDENCE_SOURCE_PLAN_INTERNAL_SHA256 &&
      sourcePlan.entries.length === 164,
    "Decision source plan is not the exact sealed historical 164-SKU v5 plan.",
  );

  const desiredManifestPath = path.resolve(options.desiredManifestPath);
  const desiredManifestBytes = await readFile(desiredManifestPath);
  assert(
    sha256(desiredManifestBytes) === REVIEWED_DESIRED_MANIFEST_FILE_SHA256,
    "Decision desired manifest file SHA-256 mismatch.",
  );
  const desiredManifest = JSON.parse(
    desiredManifestBytes.toString("utf8"),
  ) as DesiredRepairManifest & UnknownRecord & { body_sha256?: string };
  assert(
    desiredManifest.schema_version === DESIRED_MANIFEST_SCHEMA &&
      desiredManifest.immutable === true &&
      desiredManifest.repairs.length === 164 &&
      desiredManifest.body_sha256 === REVIEWED_DESIRED_MANIFEST_BODY_SHA256 &&
      canonicalBodySeal(desiredManifest) === REVIEWED_DESIRED_MANIFEST_BODY_SHA256,
    "Decision desired manifest body/schema/scope is not exact.",
  );
  assert(
    sourcePlan.desired_manifest_source?.sha256 === REVIEWED_DESIRED_MANIFEST_FILE_SHA256 &&
      path.resolve(sourcePlan.desired_manifest_source.path) === desiredManifestPath,
    "Decision source plan is not bound to the exact desired manifest path/SHA.",
  );

  const sourceLedgerPath = path.resolve(options.sourceLedgerPath);
  const sourceLedgerBytes = await readFile(sourceLedgerPath);
  assert(
    sha256(sourceLedgerBytes) === REVIEWED_SOURCE_LEDGER_FILE_SHA256,
    "Decision source ledger file SHA-256 mismatch.",
  );
  assert(
    sourcePlan.source_ledger.sha256 === REVIEWED_SOURCE_LEDGER_FILE_SHA256 &&
      path.resolve(sourcePlan.source_ledger.path) === sourceLedgerPath,
    "Decision source plan is not bound to the exact source ledger path/SHA.",
  );
  const sourceLedger = JSON.parse(sourceLedgerBytes.toString("utf8")) as UnknownRecord;

  const donorEnrichmentPath = path.resolve(options.donorEnrichmentPath);
  const donorEnrichmentBytes = await readFile(donorEnrichmentPath);
  assert(
    sha256(donorEnrichmentBytes) === REVIEWED_DONOR_ENRICHMENT_FILE_SHA256,
    "Decision donor-enrichment file SHA-256 mismatch.",
  );
  const donorEnrichment = JSON.parse(donorEnrichmentBytes.toString("utf8")) as UnknownRecord;
  assert(Array.isArray(donorEnrichment.donors), "Decision donor enrichment has no donor rows.");
  assert(Array.isArray(donorEnrichment.aliases), "Decision donor enrichment has no aliases.");
  const morningMixedBerry = donorEnrichment.donors.find(
    (row) => isRecord(row) && row.donor_id === "b0ce034d-3bbb-49bf-af02-39588a4da3f7",
  );
  const standardMixedBerry = donorEnrichment.donors.find(
    (row) => isRecord(row) && row.donor_id === "20d65340-4c9f-4361-a997-e839e26747ca",
  );
  const standardMixedBerryAlias = donorEnrichment.aliases.find(
    (row) =>
      isRecord(row) &&
      row.from_donor_id === "281b4a71-92e7-4300-821c-a9ef54461312" &&
      row.to_donor_id === "20d65340-4c9f-4361-a997-e839e26747ca",
  );
  assert(
    isRecord(morningMixedBerry) &&
      morningMixedBerry.expected_title ===
        "Smucker's Uncrustables Morning Protein Peanut Butter & Mixed Berry Spread Sandwich - 22.4oz/8ct" &&
      isRecord(standardMixedBerry) &&
      standardMixedBerry.expected_title ===
        "Smucker's Uncrustables Frozen Peanut Butter & Mixed Berry Spread Sandwich - 8oz/4ct" &&
      isRecord(standardMixedBerryAlias),
    "Decision donor evidence does not prove distinct 2.8-oz Morning Protein and 2-oz standard mixed-berry variants.",
  );

  const decisions: Array<Record<string, unknown>> = [];
  const safeRationales: Record<string, string> = {
    "KD-AS12-8HZ3":
      "Both intended components are 2.8 oz; exact flavors, total 24, ASIN, UPC/EAN and Catalog API unit/count match. The shortened catalog wording omits Morning only, while the 2.8-oz format distinguishes the reviewed Morning Protein mixed-berry donor from the separate 2-oz standard donor.",
    "RL-AS64-Q8QX":
      "Catalog title states Morning Protein Mixed Berry, 2.8 oz and 30 Count exactly; generic validation rejected only the absence of the literal word sandwich.",
    "SZ-ASPI-JFAT":
      "The selected recipe is 24 blackberry sandwiches sourced as six 4-count retail packs; catalog title explicitly states Pack of 6 and 24 Sandwiches Total, and Catalog API unit_count is 24 Count. Live UPC 664554043946 is authoritative over the stale collided local UPC.",
    "VA-ASOK-QJCA":
      "Both intended protein components are 2.8 oz; exact apple-cinnamon and mixed-berry flavors, total 24, ASIN, UPC/EAN and unit/count match. Protein marketing words are omitted but no incompatible variant or weight is introduced.",
    "WK-AS2R-FJUW":
      "Catalog title identifies individually wrapped plain peanut-butter sandwiches at 1.8 oz and Pack of 90; Catalog API unit_count and number_of_items are both 90, so Pack of 90 denotes individual sandwiches rather than 90 four-count cartons.",
  };
  for (const policy of REVIEWED_CATALOG_OVERRIDE_POLICY_ROWS) {
    const ledgerRow = rawLedgerDecisionRow(sourceLedger, policy.sku);
    const components = decisionRecipeComponents(ledgerRow);
    const repair = desiredDecisionRepair(desiredManifest, policy.sku);
    const validated = reviewedCatalogOverride({
      sku: policy.sku,
      asin: String(ledgerRow.asin),
      priorTitle: repair.text_count?.title as string,
      catalogTitle: policy.catalog_title,
      intendedCount: intendedCount(repair.text_count as NonNullable<typeof repair.text_count>),
      components,
      genericError: new Error("Generic strict parser intentionally rejected this exact exceptional wording."),
      evidence: catalogEvidence,
    });
    decisions.push({
      sku: policy.sku,
      asin: policy.asin,
      decision: "ALIGN_SAFE",
      intended_recipe: {
        individual_sandwich_count: policy.intended_count,
        components: policy.recipe_components,
      },
      amazon_catalog: {
        title: policy.catalog_title,
        unit_count: { value: policy.unit_count, type: "Count" },
        number_of_items: policy.number_of_items,
        identifiers: policy.identifiers,
      },
      same_identity: true,
      rationale: safeRationales[policy.sku],
      required_remediation: "Align only text_count.title to the exact catalog title; preserve all other reviewed customer fields.",
      evidence: validated.evidence,
    });
  }

  const tySku = "TY-AST2-JE9P";
  const tyAsin = "B0H84WQRXB";
  const tyCatalogTitle =
    "Uncrustables Peanut Butter & Raspberry Spread and Peanut Butter & Mixed Berry Spread Frozen Sandwiches, 2 oz Each, 24 Count";
  const tyLedgerRow = rawLedgerDecisionRow(sourceLedger, tySku);
  const tyComponents = decisionRecipeComponents(tyLedgerRow);
  const tyRepair = desiredDecisionRepair(desiredManifest, tySku);
  const tyEvidence = catalogEvidence.rows_by_sku.get(tySku);
  assert(
    String(tyLedgerRow.asin) === tyAsin &&
      stableJson(tyComponents) ===
        stableJson([
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
        ]) &&
      tyRepair.text_count?.title ===
        "Smucker's Uncrustables Frozen Sandwich Variety Pack, Peanut Butter & Raspberry Spread and Morning Protein Peanut Butter & Mixed Berry Spread, 24 Count" &&
      tyEvidence?.asin === tyAsin &&
      tyEvidence.catalog_api_title === tyCatalogTitle &&
      stableJson(tyEvidence.catalog_api_unit_count) ===
        stableJson([
          {
            type: { language_tag: "en_US", value: "Count" },
            value: 24,
            marketplace_id: MARKETPLACE_ID,
          },
        ]),
    "TY block decision evidence differs from the exact reviewed mixed-weight recipe/catalog conflict.",
  );
  decisions.push({
    sku: tySku,
    asin: tyAsin,
    decision: "BLOCK",
    intended_recipe: { individual_sandwich_count: 24, components: tyComponents },
    amazon_catalog: {
      title: tyCatalogTitle,
      unit_count: { value: 24, type: "Count" },
      number_of_items: 24,
      identifiers: [
        { type: "ean", value: "0756441904864" },
        { type: "upc", value: "756441904864" },
      ],
    },
    same_identity: false,
    block_reason:
      "Catalog title claims 2 oz Each and omits Morning Protein, but 12 of 24 intended sandwiches are the distinct 22.4oz/8ct (2.8 oz each) Morning Protein mixed-berry variant; a separate reviewed 8oz/4ct (2 oz each) standard mixed-berry donor exists.",
    required_remediation: [
      "Do not align to the current catalog title.",
      "Correct/appeal the Amazon catalog title so the mixed-berry component is Morning Protein 2.8 oz, or create a correctly identified ASIN with a valid unused GTIN.",
      "Capture fresh Catalog Items evidence and obtain a clean validation preview before adding TY to an apply plan.",
    ],
    evidence: {
      catalog_evidence_row_sha256: sha256(stableJson(tyEvidence)),
      donor_enrichment_file_sha256: REVIEWED_DONOR_ENRICHMENT_FILE_SHA256,
    },
  });

  const vnSku = "VN-AS1A-D572";
  const vnAsin = "B0H82PKK18";
  const vnLedgerRow = rawLedgerDecisionRow(sourceLedger, vnSku);
  const vnComponents = decisionRecipeComponents(vnLedgerRow);
  const vnRepair = desiredDecisionRepair(desiredManifest, vnSku);
  assert(isRecord(vnLedgerRow.live), "VN live ledger evidence is missing.");
  assert(
    String(vnLedgerRow.asin) === vnAsin &&
      stableJson(vnComponents) ===
        stableJson([
          {
            product_name:
              "Smucker's Uncrustables Frozen Peanut Butter & Strawberry Jam Sandwich - 8oz/4ct",
            qty: 45,
          },
        ]) &&
      vnRepair.text_count?.unit_count === 45 &&
      vnRepair.text_count.number_of_items === 45 &&
      vnLedgerRow.live.title ===
        "Smucker's Uncrustables Frozen Peanut Butter & Strawberry Jam Sandwich, 8 oz, 4 ct - Pack of 45" &&
      vnLedgerRow.live.unit_count === 180 &&
      vnLedgerRow.live.number_of_items === 45,
    "VN block decision ledger/manifest evidence differs from exact intended 45 vs catalog 180.",
  );
  const vnCheckpointPath = path.resolve(options.vnCheckpointPath);
  const vnCheckpointBytes = await readFile(vnCheckpointPath);
  assert(
    sha256(vnCheckpointBytes) === REVIEWED_VN_CHECKPOINT_FILE_SHA256,
    "VN checkpoint file SHA-256 mismatch.",
  );
  const vnCheckpoint = JSON.parse(vnCheckpointBytes.toString("utf8")) as CheckpointEvent;
  const { sha256: vnClaimedSha, ...vnCheckpointBody } = vnCheckpoint;
  assert(
    vnCheckpoint.schema_version === CHECKPOINT_SCHEMA &&
      vnCheckpoint.immutable === true &&
      vnCheckpoint.plan_sha256 === REVIEWED_CATALOG_EVIDENCE_SOURCE_PLAN_INTERNAL_SHA256 &&
      vnCheckpoint.sku === vnSku &&
      vnCheckpoint.action_id === `${vnSku}:text_count` &&
      vnCheckpoint.status === "FAILED" &&
      vnClaimedSha === REVIEWED_VN_CHECKPOINT_EVENT_SHA256 &&
      sha256(stableJson(vnCheckpointBody)) === REVIEWED_VN_CHECKPOINT_EVENT_SHA256,
    "VN checkpoint event seal/identity is not exact.",
  );
  const vnPreview = parseFailedPreview(vnCheckpoint);
  assert(
    vnPreview.submissionId === "0c6b0ea1d2f44b43a8c59c33dfba098e" &&
      vnPreview.errors.length === 1 &&
      issueStrings(vnPreview.errors[0]).code === "8541" &&
      stableJson(issueStrings(vnPreview.errors[0]).attributeNames) === stableJson(["unit_count"]) &&
      issueStrings(vnPreview.errors[0]).message.includes('value "45"') &&
      issueStrings(vnPreview.errors[0]).message.includes('value "180"'),
    "VN preview does not prove the exact 45-versus-180 unit_count conflict.",
  );
  decisions.push({
    sku: vnSku,
    asin: vnAsin,
    decision: "BLOCK",
    intended_recipe: { individual_sandwich_count: 45, components: vnComponents },
    amazon_catalog: {
      title: vnLedgerRow.live.title,
      unit_count: { value: 180, type: "Count" },
      number_of_items: 45,
      identifiers: [{ type: "upc", value: "756441902563" }],
    },
    same_identity: false,
    block_reason:
      "The intended recipe is 45 individual sandwiches, while the catalog title multiplies a 4-count retail carton by 45 and the catalog unit_count is 180. Aligning to 180 would preserve a false sellable quantity.",
    required_remediation: [
      "Never align or submit unit_count 180 for the intended 45-sandwich bundle.",
      "Correct/appeal Amazon catalog unit_count to 45, or create a correctly identified ASIN with a valid unused GTIN.",
      "Run a separately staged text/count validation preview and capture fresh Catalog Items evidence before adding VN to an apply plan.",
    ],
    evidence: {
      checkpoint_path: vnCheckpointPath,
      checkpoint_file_sha256: REVIEWED_VN_CHECKPOINT_FILE_SHA256,
      checkpoint_event_sha256: REVIEWED_VN_CHECKPOINT_EVENT_SHA256,
      submission_id: vnPreview.submissionId,
    },
  });

  decisions.sort((left, right) => String(left.sku).localeCompare(String(right.sku)));
  assert(
    decisions.length === 7 &&
      decisions.filter((decision) => decision.decision === "ALIGN_SAFE").length === 5 &&
      decisions.filter((decision) => decision.decision === "BLOCK").length === 2,
    "Catalog identity decision must contain exactly five ALIGN_SAFE and two BLOCK rows.",
  );
  const body: Omit<CatalogIdentityDecisionArtifact, "body_sha256"> = {
    schema_version: CATALOG_IDENTITY_DECISION_SCHEMA,
    immutable: true,
    read_only: true,
    created_at: options.createdAt,
    source_artifacts: {
      catalog_api_evidence: {
        path: catalogEvidence.path,
        file_sha256: catalogEvidence.file_sha256,
        body_sha256: catalogEvidence.body_sha256,
        captured_at: catalogEvidence.captured_at,
      },
      validation_preview_source_plan: {
        path: sourcePlanPath,
        internal_sha256: REVIEWED_CATALOG_EVIDENCE_SOURCE_PLAN_INTERNAL_SHA256,
        file_sha256: REVIEWED_CATALOG_EVIDENCE_SOURCE_PLAN_FILE_SHA256,
      },
      validation_preview_checkpoint_set: {
        path: path.resolve(
          "data/repairs/checkpoints/final-validation-preview-full-diagnostic-20260718-v5/480ed383f6963ac4983c",
        ),
        files: 612,
        sha256: "c5ae519542f879694fcf32e0250bcaa0d6ac0bb22de81fd299075c9b4bba1639",
      },
      desired_manifest: {
        path: desiredManifestPath,
        file_sha256: REVIEWED_DESIRED_MANIFEST_FILE_SHA256,
        body_sha256: REVIEWED_DESIRED_MANIFEST_BODY_SHA256,
      },
      source_ledger: {
        path: sourceLedgerPath,
        file_sha256: REVIEWED_SOURCE_LEDGER_FILE_SHA256,
      },
      donor_enrichment: {
        path: donorEnrichmentPath,
        file_sha256: REVIEWED_DONOR_ENRICHMENT_FILE_SHA256,
      },
      vn_unit_count_checkpoint: {
        path: vnCheckpointPath,
        file_sha256: REVIEWED_VN_CHECKPOINT_FILE_SHA256,
        event_sha256: REVIEWED_VN_CHECKPOINT_EVENT_SHA256,
      },
    },
    scope: {
      cohort_skus: 164,
      align_safe: 5,
      blocked: 2,
      intended_final_apply_scope: 162,
      final_apply_exclusions: ["TY-AST2-JE9P", "VN-AS1A-D572"],
    },
    decisions,
  };
  const artifact = {
    ...body,
    body_sha256: canonicalBodySeal(body as UnknownRecord),
  } as CatalogIdentityDecisionArtifact;
  assert(
    canonicalBodySeal(artifact) === artifact.body_sha256,
    "Catalog identity decision body seal failed.",
  );
  return { artifact };
}

export async function writeCatalogIdentityDecisionArtifact(
  outputDirectory: string,
  prepared: PreparedCatalogIdentityDecision,
): Promise<WrittenCatalogIdentityDecision> {
  const bytes = Buffer.from(`${JSON.stringify(prepared.artifact, null, 2)}\n`);
  const fileSha256 = sha256(bytes);
  const timestamp = prepared.artifact.created_at.replace(/[-:.]/g, "");
  const basename =
    `uncrustables-catalog-identity-decision-${timestamp}-` +
    `${prepared.artifact.body_sha256.slice(0, 12)}.json`;
  const artifactPath = path.resolve(outputDirectory, basename);
  const sidecarPath = `${artifactPath}.sha256`;
  await writeIdenticalOrCreate(artifactPath, bytes);
  await writeIdenticalOrCreate(
    sidecarPath,
    Buffer.from(`${fileSha256}  ${basename}\n`),
  );
  return {
    artifactPath,
    sidecarPath,
    fileSha256,
    bodySha256: prepared.artifact.body_sha256,
  };
}

/** A stable digest helper exported for synthetic sealed-checkpoint tests. */
export function catalogTitleAlignmentCheckpointDigest(
  event: Omit<CheckpointEvent, "sha256">,
): string {
  return createHash("sha256").update(stableJson(event)).digest("hex");
}
