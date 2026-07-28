/**
 * Build the exact offline gallery-only repair bundle for the three proven
 * owner-relaxed Uncrustables gallery defects.
 *
 * It writes one standard GALLERY_MEDIA_ONLY selection for the two swap-only
 * canaries and one deliberately non-executable held selection for SZ. It does
 * not call Amazon, ChannelMAX, a database, R2, or any other network service.
 */

import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  verifyPreChangeSnapshot,
  type UncrustablesPreChangeSnapshot,
} from "@/lib/bundle-factory/repair/uncrustables-amazon-rollback";
import {
  MINIMAL_GALLERY_HELD_SELECTION_SCHEMA,
  MINIMAL_GALLERY_RELEASE_BUNDLE_SCHEMA,
  sealMinimalGalleryArtifact,
  verifyMinimalGalleryCasRow,
  verifyMinimalGalleryHeldSelection,
  verifyMinimalGalleryReleaseBundle,
  type MinimalGalleryCasRow,
  type MinimalGalleryHeldSelection,
  type MinimalGalleryReleaseBundle,
} from "@/lib/bundle-factory/repair/uncrustables-minimal-gallery-release";
import {
  DESIRED_MANIFEST_SCHEMA,
  GALLERY_MEDIA_FORBIDDEN_PATCH_PATHS,
  GALLERY_MEDIA_ONLY_PROFILE,
  REPAIR_PLAN_SCHEMA,
  readRepairExecutionSelection,
  repairExecutionSelection,
  sha256,
  stableJson,
  verifyRepairExecutionSelection,
  verifyRepairPlan,
  writeImmutablePlan,
  writeImmutableRepairExecutionSelection,
  type DesiredRepairManifest,
  type RepairPlanEntry,
  type UncrustablesRepairPlan,
} from "@/lib/bundle-factory/repair/uncrustables-surgical";

const APP_ROOT = fileURLToPath(new URL("../", import.meta.url));
const OUTPUT_DIRECTORY =
  "data/repairs/gallery-minimal/uncrustables-minimal-gallery-repair-3-20260719-v1";
const ADJUDICATION_PATH =
  "data/audits/uncrustables-minimal-gallery-adjudication-20260719-v2/uncrustables-minimal-gallery-adjudication-20260719-v2.json";
const DESIRED_MEDIA_PATH =
  "data/audits/uncrustables-minimal-gallery-adjudication-20260719-v2/uncrustables-minimal-gallery-desired-media-20260719-v2.json";
const CURRENT_SNAPSHOT_PATH =
  "data/repairs/rollback/uncrustables-owner-relaxed-main-24-live-20260719-v2/UAPS-20260719T030109596Z-46a80e727880-b91e0e79732b.json";
const IDENTITY_MATRIX_PATH =
  "data/audits/uncrustables-fresh-amazon-price-matrix-20260719-v2/uncrustables-fresh-amazon-price-matrix-20260719-v2.json";
const LEDGER_PATH =
  "data/audits/uncrustables-ledger-20260717T232140568Z-offline.json";
const STANDARD_MANIFEST_NAME =
  "uncrustables-minimal-gallery-desired-manifest-3-20260719-v1.json";
const CANARY_DIRECTORY = "canary-ua-vc";
const HELD_DIRECTORY = "held-sz";
const CANARY_SKUS = ["UA-ASAO-RE7Q", "VC-ASV1-378P"] as const;
const HELD_SKU = "SZ-ASPI-JFAT" as const;
const ALL_SKUS = [HELD_SKU, ...CANARY_SKUS] as const;
const MARKETPLACE_ID = "ATVPDKIKX0DER";

interface DesiredMediaAction {
  sku: string;
  asin: string;
  store_index: number;
  expected_listing_sha256: string;
  source_adjudication_row_sha256: string;
  strategy: string;
  hard_violation_codes: string[];
  desired_slots: Array<{
    slot_index: number;
    attribute: string;
    url: string;
    asset_sha256: string;
    source_role: string;
    represented_recipe_keys: string[];
    change_kind: "ADD" | "KEEP" | "REPLACE";
    expected_before: {
      url: string;
      asset_sha256: string;
      field_sha256: string;
    } | null;
  }>;
  slot_diff: Array<{
    slot_index: number;
    attribute: string;
    url: string;
    asset_sha256: string;
    source_role: string;
    represented_recipe_keys: string[];
    change_kind: "ADD" | "REPLACE";
    expected_before: {
      url: string;
      asset_sha256: string;
      field_sha256: string;
    } | null;
  }>;
  delete_slot_indices: number[];
  action_sha256: string;
}

interface DesiredMediaManifest {
  schema_version: "uncrustables-minimal-gallery-desired-media/v1";
  immutable: true;
  offline_only: true;
  execution_authorized: false;
  body_sha256: string;
  actions: DesiredMediaAction[];
}

interface IdentityMatrix {
  body_sha256: string;
  rows: Array<{
    sku: string;
    asin: string;
    identity: {
      status: string;
      channelmax_hold_asin: string;
      reason_codes: string[];
    };
  }>;
}

function absolute(repoPath: string): string {
  return path.resolve(APP_ROOT, repoPath);
}

function relativeToApp(file: string): string {
  const relative = path.relative(APP_ROOT, path.resolve(file));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Artifact path escapes app root: ${file}`);
  }
  return relative.split(path.sep).join("/");
}

function fileSha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function readJson<T>(repoPath: string): Promise<{ value: T; bytes: Buffer; fileSha256: string }> {
  const bytes = await readFile(absolute(repoPath));
  return {
    value: JSON.parse(bytes.toString("utf8")) as T,
    bytes,
    fileSha256: fileSha256(bytes),
  };
}

function verifyBodySha(value: Record<string, unknown>, label: string): void {
  const claimed = value.body_sha256;
  const body = { ...value };
  delete body.body_sha256;
  assert(
    typeof claimed === "string" && claimed === sha256(stableJson(body)),
    `${label} body SHA-256 mismatch.`,
  );
}

async function writeExclusiveWithSidecar(file: string, bytes: Buffer | string): Promise<string> {
  await writeFile(file, bytes, { flag: "wx" });
  const digest = fileSha256(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
  await writeFile(`${file}.sha256`, `${digest}  ${path.basename(file)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return digest;
}

function sourceSnapshotField(
  snapshotEntry: UncrustablesPreChangeSnapshot["entries"][number],
  patchPath: string,
): { present: boolean; value?: unknown; sha256: string } {
  const current = snapshotEntry.fields[patchPath];
  if (current) {
    const expectedBody = current.present
      ? { present: true, value: current.value }
      : { present: false };
    assert(
      current.sha256 === sha256(stableJson(expectedBody)),
      `Source snapshot field SHA mismatch: ${snapshotEntry.sku} ${patchPath}`,
    );
    return current.present
      ? { present: true, value: current.value, sha256: current.sha256 }
      : { present: false, sha256: current.sha256 };
  }
  const absent = { present: false } as const;
  return { ...absent, sha256: sha256(stableJson(absent)) };
}

function buildCasRow(input: {
  action: DesiredMediaAction;
  snapshot: UncrustablesPreChangeSnapshot;
}): MinimalGalleryCasRow {
  const entry = input.snapshot.entries.find((candidate) => candidate.sku === input.action.sku);
  assert(
    entry &&
      entry.asin === input.action.asin &&
      entry.store_index === input.action.store_index &&
      entry.listing_sha256 === input.action.expected_listing_sha256,
    `Current CAS identity/listing mismatch for ${input.action.sku}.`,
  );
  const touchedPaths = input.action.slot_diff
    .map((slot) => ({
      path: slot.attribute,
      before: sourceSnapshotField(entry, slot.attribute),
      desired_url: slot.url,
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  for (const slot of input.action.slot_diff) {
    const before = touchedPaths.find((candidate) => candidate.path === slot.attribute)?.before;
    assert(before, `Missing current CAS state for ${input.action.sku} ${slot.attribute}.`);
    if (slot.expected_before) {
      assert(
        before.present === true &&
          before.sha256 === slot.expected_before.field_sha256 &&
          stableJson(before.value) ===
            stableJson([
              {
                media_location: slot.expected_before.url,
                marketplace_id: MARKETPLACE_ID,
              },
            ]),
        `Desired manifest before-state mismatch for ${input.action.sku} ${slot.attribute}.`,
      );
    } else {
      assert(before.present === false, `Expected absent before-state for ${input.action.sku} ${slot.attribute}.`);
    }
  }
  const body = {
    sku: input.action.sku,
    asin: input.action.asin,
    store_index: 1 as const,
    listing_sha256: entry.listing_sha256,
    touched_paths: touchedPaths,
  };
  const row = { ...body, cas_sha256: sha256(stableJson(body)) };
  verifyMinimalGalleryCasRow(row);
  return row;
}

function fullDesiredManifest(
  desiredActions: DesiredMediaAction[],
  ledgerSha256: string,
  reviewedAt: string,
  adjudicationFileSha256: string,
  desiredMediaFileSha256: string,
): DesiredRepairManifest {
  return {
    schema_version: DESIRED_MANIFEST_SCHEMA,
    immutable: true,
    source_ledger_sha256: ledgerSha256,
    reviewed_at: reviewedAt,
    repairs: desiredActions
      .slice()
      .sort((left, right) => left.sku.localeCompare(right.sku))
      .map((action) => ({
        sku: action.sku,
        review: {
          confidence: "HIGH" as const,
          rationale:
            action.strategy === "SWAP_SLOT_1_AND_SLOT_7_ONLY"
              ? "Owner-relaxed adjudication proves that the only gallery defect is fixed-card placement; preserve every current asset and swap slots 1 and 7 only."
              : "Owner-relaxed adjudication proves that the current gallery has zero additional images; add the minimum four exact PB_BLACKBERRY assets while preserving the approved card in slot 1.",
          evidence: [
            `Adjudication file SHA-256 ${adjudicationFileSha256}.`,
            `Desired-media file SHA-256 ${desiredMediaFileSha256}.`,
            `Source adjudication row SHA-256 ${action.source_adjudication_row_sha256}.`,
            `Desired action SHA-256 ${action.action_sha256}.`,
          ],
        },
        media: {
          gallery_image_urls: action.desired_slots
            .slice()
            .sort((left, right) => left.slot_index - right.slot_index)
            .map((slot) => slot.url),
        },
      })),
  };
}

function sparseRepairEntries(
  desiredActions: DesiredMediaAction[],
  snapshot: UncrustablesPreChangeSnapshot,
  adjudicationFileSha256: string,
  desiredMediaFileSha256: string,
): RepairPlanEntry[] {
  return desiredActions
    .slice()
    .sort((left, right) => left.sku.localeCompare(right.sku))
    .map((action) => {
      const snapshotEntry = snapshot.entries.find((entry) => entry.sku === action.sku);
      assert(snapshotEntry, `Snapshot entry missing for ${action.sku}.`);
      assert(action.delete_slot_indices.length === 0, `${action.sku} unexpectedly deletes gallery slots.`);
      const gallerySlots = action.slot_diff
        .slice()
        .sort((left, right) => left.slot_index - right.slot_index)
        .map((slot) => ({ slot: slot.slot_index, url: slot.url }));
      assert(gallerySlots.length > 0, `${action.sku} sparse gallery diff is empty.`);
      return {
        sku: action.sku,
        asin: action.asin,
        store_index: action.store_index,
        audited_product_type: snapshotEntry.product_type,
        actions: [
          {
            action_id: `${action.sku}:media`,
            kind: "MEDIA" as const,
            reasons: [
              "OWNER_RELAXED_MINIMAL_GALLERY_REPAIR",
              ...action.hard_violation_codes,
            ],
            review: {
              confidence: "HIGH" as const,
              rationale:
                "Sparse gallery-only diff is derived from the exact 164-row live snapshot and immutable owner-relaxed desired-media action; MAIN, text, structured attributes, and offer are absent.",
              evidence: [
                `Adjudication file SHA-256 ${adjudicationFileSha256}.`,
                `Desired-media file SHA-256 ${desiredMediaFileSha256}.`,
                `Action SHA-256 ${action.action_sha256}.`,
                `Current listing SHA-256 ${action.expected_listing_sha256}.`,
              ],
            },
            desired: {
              kind: "MEDIA" as const,
              value: { gallery_slots: gallerySlots },
            },
          },
        ],
      };
    });
}

async function main(): Promise<void> {
  const createdAt = new Date();
  const createdIso = createdAt.toISOString();
  const outputDirectory = absolute(OUTPUT_DIRECTORY);
  try {
    await stat(outputDirectory);
    throw new Error(`Immutable output directory already exists: ${OUTPUT_DIRECTORY}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(path.dirname(outputDirectory), { recursive: true });
  const tempDirectory = path.join(
    path.dirname(outputDirectory),
    `.tmp-${path.basename(outputDirectory)}-${process.pid}`,
  );
  await mkdir(tempDirectory, { recursive: false });

  const adjudication = await readJson<Record<string, unknown>>(ADJUDICATION_PATH);
  const desiredMedia = await readJson<DesiredMediaManifest>(DESIRED_MEDIA_PATH);
  const currentSnapshot = await readJson<UncrustablesPreChangeSnapshot>(CURRENT_SNAPSHOT_PATH);
  const identityMatrix = await readJson<IdentityMatrix>(IDENTITY_MATRIX_PATH);
  const ledger = await readJson<Record<string, unknown>>(LEDGER_PATH);
  verifyBodySha(adjudication.value, "Minimal gallery adjudication");
  verifyBodySha(desiredMedia.value as unknown as Record<string, unknown>, "Minimal gallery desired media");
  verifyBodySha(identityMatrix.value as unknown as Record<string, unknown>, "Fresh Amazon price matrix");
  verifyPreChangeSnapshot(currentSnapshot.value);
  assert(
    ledger.fileSha256 === currentSnapshot.value.source_ledger.sha256 &&
      ledger.fileSha256 === "46a80e727880d83bd9e52a1c58c753eeeede0cb8cbdd3443e825aba9cbaaa02f",
    "Exact source ledger SHA mismatch.",
  );
  assert(
    desiredMedia.value.schema_version === "uncrustables-minimal-gallery-desired-media/v1" &&
      desiredMedia.value.immutable === true &&
      desiredMedia.value.execution_authorized === false &&
      desiredMedia.value.actions.length === 3,
    "Desired-media input is not the exact non-executable three-action manifest.",
  );
  const desiredBySku = new Map(desiredMedia.value.actions.map((action) => [action.sku, action]));
  assert(
    ALL_SKUS.every((sku) => desiredBySku.has(sku)) && desiredBySku.size === 3,
    "Desired-media input does not cover exactly SZ, UA, and VC.",
  );
  for (const action of desiredMedia.value.actions) {
    const { action_sha256: claimed, ...body } = action;
    assert(claimed === sha256(stableJson(body)), `Desired action SHA mismatch: ${action.sku}`);
    assert(
      action.delete_slot_indices.length === 0 &&
        action.slot_diff.every((slot) =>
          /^\/attributes\/other_product_image_locator_[1-8]$/.test(slot.attribute),
        ),
      `${action.sku} desired action crossed the gallery-only boundary.`,
    );
  }

  const standardManifest = fullDesiredManifest(
    desiredMedia.value.actions,
    ledger.fileSha256,
    createdIso,
    adjudication.fileSha256,
    desiredMedia.fileSha256,
  );
  const standardManifestBytes = Buffer.from(`${JSON.stringify(standardManifest, null, 2)}\n`);
  const standardManifestSha256 = fileSha256(standardManifestBytes);
  const finalStandardManifestPath = path.join(outputDirectory, STANDARD_MANIFEST_NAME);
  const tempStandardManifestPath = path.join(tempDirectory, STANDARD_MANIFEST_NAME);
  await writeExclusiveWithSidecar(tempStandardManifestPath, standardManifestBytes);

  const entries = sparseRepairEntries(
    desiredMedia.value.actions,
    currentSnapshot.value,
    adjudication.fileSha256,
    desiredMedia.fileSha256,
  );
  const planBody: Omit<UncrustablesRepairPlan, "sha256"> = {
    schema_version: REPAIR_PLAN_SCHEMA,
    immutable: true,
    plan_id: `URP-${createdIso.replace(/[-:.]/g, "")}`,
    created_at: createdIso,
    source_ledger: {
      path: absolute(LEDGER_PATH),
      sha256: ledger.fileSha256,
      audit_id: String(ledger.value.audit_id),
      schema_version: String(ledger.value.schema_version),
      completed_at:
        typeof ledger.value.completed_at === "string"
          ? ledger.value.completed_at
          : null,
    },
    desired_manifest_source: {
      path: finalStandardManifestPath,
      sha256: standardManifestSha256,
      schema_version: DESIRED_MANIFEST_SCHEMA,
      reviewed_at: createdIso,
      source_ledger_sha256: ledger.fileSha256,
    },
    launch_pricing_source: null,
    media_asset_source: null,
    structured_attribute_source: null,
    policy: {
      marketplace_id: MARKETPLACE_ID,
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
      brand_card_url:
        "https://pub-6394ee2ba6de41b68a3dcee17c884db8.r2.dev/prod/brand/salutem-brand-card-v1.png",
      verified_brand_card_rehost_url:
        "https://m.media-amazon.com/images/I/81OibsvvU0L.jpg",
    },
    scope: {
      requested_skus: [...ALL_SKUS].sort(),
      limit: null,
      ledger_rows_considered: 3,
      entries: 3,
      actions: 3,
      blocked: 0,
    },
    semantic_audit: {
      validator: "validateSemanticOutput",
      checked: 0,
      passed: 0,
      failed: 0,
      repaired_by_manifest: 0,
      repaired_deterministically: 0,
      blocked: 0,
      failures: [],
    },
    entries,
    blockers: [],
  };
  const plan: UncrustablesRepairPlan = {
    ...planBody,
    sha256: sha256(stableJson(planBody)),
  };
  verifyRepairPlan(plan);
  const tempPlanPath = await writeImmutablePlan(tempDirectory, plan);
  const planName = path.basename(tempPlanPath);
  const finalPlanPath = path.join(outputDirectory, planName);
  const planBytes = await readFile(tempPlanPath);
  const planFileSha256 = fileSha256(planBytes);
  await writeFile(`${tempPlanPath}.sha256`, `${planFileSha256}  ${planName}\n`, {
    encoding: "utf8",
    flag: "wx",
  });

  const planRepoPath = relativeToApp(finalPlanPath);
  const canarySelection = repairExecutionSelection(plan, {
    sourcePlanPath: planRepoPath,
    createdAt,
    skus: [...CANARY_SKUS],
    actionKinds: ["MEDIA"],
  });
  verifyRepairExecutionSelection(plan, canarySelection);
  assert(
    canarySelection.profile === GALLERY_MEDIA_ONLY_PROFILE &&
      stableJson(canarySelection.selected_skus) === stableJson([...CANARY_SKUS]) &&
      stableJson(canarySelection.selected_action_ids) ===
        stableJson(CANARY_SKUS.map((sku) => `${sku}:media`)) &&
      stableJson(canarySelection.forbidden_patch_paths) ===
        stableJson(GALLERY_MEDIA_FORBIDDEN_PATCH_PATHS),
    "Canary selection is not the exact UA+VC gallery-only selection.",
  );
  const tempCanaryDirectory = path.join(tempDirectory, CANARY_DIRECTORY);
  const canarySelectionPath = await writeImmutableRepairExecutionSelection(
    tempCanaryDirectory,
    canarySelection,
  );
  const canarySelectionBytes = await readFile(canarySelectionPath);
  const canarySelectionFileSha256 = fileSha256(canarySelectionBytes);
  await writeFile(
    `${canarySelectionPath}.sha256`,
    `${canarySelectionFileSha256}  ${path.basename(canarySelectionPath)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  const roundTripCanary = await readRepairExecutionSelection(canarySelectionPath, plan);
  assert(stableJson(roundTripCanary) === stableJson(canarySelection), "Canary selection round-trip mismatch.");

  const casRows = desiredMedia.value.actions
    .map((action) => buildCasRow({ action, snapshot: currentSnapshot.value }))
    .sort((left, right) => left.sku.localeCompare(right.sku));
  const casBySku = new Map(casRows.map((row) => [row.sku, row]));

  const szStandardCandidate = repairExecutionSelection(plan, {
    sourcePlanPath: planRepoPath,
    createdAt,
    skus: [HELD_SKU],
    actionKinds: ["MEDIA"],
  });
  verifyRepairExecutionSelection(plan, szStandardCandidate);
  assert(
    szStandardCandidate.profile === GALLERY_MEDIA_ONLY_PROFILE &&
      stableJson(szStandardCandidate.selected_skus) === stableJson([HELD_SKU]),
    "SZ candidate selection is not exact gallery-only scope.",
  );
  const identityHold = identityMatrix.value.rows.find((row) => row.sku === HELD_SKU);
  assert(
    identityHold &&
      identityHold.asin === "B0H776M5B5" &&
      identityHold.identity.status === "HOLD_IDENTITY" &&
      identityHold.identity.channelmax_hold_asin !== identityHold.asin &&
      identityHold.identity.reason_codes.includes("CHANNELMAX_IDENTITY_MISMATCH"),
    "SZ exact ChannelMAX identity hold is missing.",
  );
  const heldBody: Omit<MinimalGalleryHeldSelection, "sha256"> = {
    schema_version: MINIMAL_GALLERY_HELD_SELECTION_SCHEMA,
    immutable: true,
    created_at: createdIso,
    execution_authorized: false,
    confirmation_token: null,
    confirmation_token_emitted: false,
    profile: GALLERY_MEDIA_ONLY_PROFILE,
    source_plan: { path: planRepoPath, sha256: plan.sha256 },
    selected_skus: [HELD_SKU],
    selected_action_ids: [`${HELD_SKU}:media`],
    selected_actions: 1,
    allowed_patch_paths: [2, 3, 4, 5].map(
      (slot) => `/attributes/other_product_image_locator_${slot}`,
    ),
    forbidden_patch_paths: [...GALLERY_MEDIA_FORBIDDEN_PATCH_PATHS],
    current_cas: casBySku.get(HELD_SKU)!,
    identity_hold: {
      evidence_path: IDENTITY_MATRIX_PATH,
      evidence_file_sha256: identityMatrix.fileSha256,
      status: "HOLD_IDENTITY",
      amazon_asin: "B0H776M5B5",
      channelmax_asin: identityHold.identity.channelmax_hold_asin,
      reason_codes: identityHold.identity.reason_codes,
    },
    would_be_standard_selection_sha256: szStandardCandidate.sha256,
    release_requirements: [
      "ChannelMAX SKU SZ-ASPI-JFAT must resolve to Amazon ASIN B0H776M5B5 with exact readback evidence.",
      "Amazon 8541 product-identity blocker must be cleared or explicitly reconciled.",
      "Generate a new standard GALLERY_MEDIA_ONLY_V1 execution selection only after the identity hold is cleared; this held artifact has no confirmation token.",
      "Capture a fresh exact 164-row LIVE_SP_API snapshot and selection-scoped rollback bound to the same plan and desired manifest.",
      "Run Amazon VALIDATION_PREVIEW, then immediate and delayed readbacks if a later owner/network gate authorizes apply.",
    ],
  };
  const heldSelection = sealMinimalGalleryArtifact(
    heldBody as unknown as Record<string, unknown>,
  ) as unknown as MinimalGalleryHeldSelection;
  verifyMinimalGalleryHeldSelection(heldSelection);
  const tempHeldDirectory = path.join(tempDirectory, HELD_DIRECTORY);
  await mkdir(tempHeldDirectory, { recursive: false });
  const heldName = `UGHES-${createdIso.replace(/[-:.]/g, "")}-${heldSelection.sha256.slice(0, 12)}.json`;
  const heldPath = path.join(tempHeldDirectory, heldName);
  const heldFileSha256 = await writeExclusiveWithSidecar(
    heldPath,
    `${JSON.stringify(heldSelection, null, 2)}\n`,
  );

  const finalCanarySelectionPath = path.join(
    outputDirectory,
    CANARY_DIRECTORY,
    path.basename(canarySelectionPath),
  );
  const finalHeldPath = path.join(outputDirectory, HELD_DIRECTORY, heldName);
  const freshRollbackOutput =
    "data/repairs/rollback/uncrustables-minimal-gallery-canary-ua-vc-live-20260719-v1";
  const captureCommand = [
    "node --import tsx scripts/prepare-uncrustables-amazon-rollback.ts",
    "--capture-live",
    `--ledger=${LEDGER_PATH}`,
    `--overrides=${relativeToApp(finalStandardManifestPath)}`,
    `--repair-plan=${planRepoPath}`,
    `--execution-selection=${relativeToApp(finalCanarySelectionPath)}`,
    `--output-dir=${freshRollbackOutput}`,
    "--canary-size=2",
  ].join(" ");
  const allAllowedPaths = [...new Set(
    desiredMedia.value.actions.flatMap((action) =>
      action.slot_diff.map((slot) => slot.attribute),
    ),
  )].sort();

  const sourceArtifacts = {
    adjudication: {
      path: ADJUDICATION_PATH,
      file_sha256: adjudication.fileSha256,
      canonical_sha256: String(adjudication.value.body_sha256),
    },
    desired_media: {
      path: DESIRED_MEDIA_PATH,
      file_sha256: desiredMedia.fileSha256,
      canonical_sha256: desiredMedia.value.body_sha256,
    },
    current_snapshot: {
      path: CURRENT_SNAPSHOT_PATH,
      file_sha256: currentSnapshot.fileSha256,
      canonical_sha256: currentSnapshot.value.sha256,
    },
    identity_matrix: {
      path: IDENTITY_MATRIX_PATH,
      file_sha256: identityMatrix.fileSha256,
      canonical_sha256: identityMatrix.value.body_sha256,
    },
    source_ledger: {
      path: LEDGER_PATH,
      file_sha256: ledger.fileSha256,
    },
    reviewed_manifest: {
      path: relativeToApp(finalStandardManifestPath),
      file_sha256: standardManifestSha256,
    },
  };
  const releaseBody: Omit<MinimalGalleryReleaseBundle, "sha256"> = {
    schema_version: MINIMAL_GALLERY_RELEASE_BUNDLE_SCHEMA,
    immutable: true,
    created_at: createdIso,
    offline_only: true,
    external_mutations: {
      amazon_gets: 0,
      amazon_patches: 0,
      database_writes: 0,
      uploads: 0,
      channelmax_writes: 0,
    },
    source_artifacts: sourceArtifacts,
    repair_plan: {
      path: planRepoPath,
      file_sha256: planFileSha256,
      canonical_sha256: plan.sha256,
      entries: 3,
      actions: 3,
      action_kinds: ["MEDIA"],
    },
    safety_boundary: {
      profile: GALLERY_MEDIA_ONLY_PROFILE,
      allowed_patch_path_pattern:
        "^/attributes/other_product_image_locator_[1-8]$",
      allowed_patch_paths: allAllowedPaths,
      forbidden_patch_paths: [...GALLERY_MEDIA_FORBIDDEN_PATCH_PATHS],
      main_actions: 0,
      text_actions: 0,
      structured_actions: 0,
      offer_actions: 0,
    },
    current_cas: {
      source_snapshot_path: CURRENT_SNAPSHOT_PATH,
      source_snapshot_file_sha256: currentSnapshot.fileSha256,
      source_snapshot_canonical_sha256: currentSnapshot.value.sha256,
      apply_eligible_for_this_plan: false,
      reason:
        "This point-in-time snapshot is exact CAS evidence only: it predates this plan and is bound to a different reviewed manifest. Live apply requires a newly captured exact 164-row snapshot/rollback.",
      rows: casRows,
      rows_sha256: sha256(stableJson(casRows)),
    },
    fresh_rollback_prerequisite: {
      status: "REQUIRED_NOT_PRESENT",
      exact_scope: 164,
      capture_mode: "LIVE_SP_API",
      source_ledger_sha256: ledger.fileSha256,
      reviewed_manifest_sha256: standardManifestSha256,
      selected_canary_selection_sha256: canarySelection.sha256,
      maximum_age_minutes_before_first_write: 60,
      full_image_binary_evidence_required: true,
      selection_scoped_rollback_required: true,
      exact_capture_command: captureCommand,
    },
    canary: {
      execution_authorized_now: false,
      authorization_blocker:
        "FRESH_164_SELECTION_SCOPED_ROLLBACK_NOT_PRESENT",
      skus: [...CANARY_SKUS],
      action_ids: CANARY_SKUS.map((sku) => `${sku}:media`) as [
        "UA-ASAO-RE7Q:media",
        "VC-ASV1-378P:media",
      ],
      selection_path: relativeToApp(finalCanarySelectionPath),
      selection_file_sha256: canarySelectionFileSha256,
      selection_sha256: canarySelection.sha256,
      confirmation_token: canarySelection.confirmation_token,
      required_sequence: [
        "Capture fresh exact 164-row LIVE_SP_API snapshot and selection-scoped rollback using exact_capture_command.",
        "Verify rollback apply_eligible=true, exact source plan/selection/manifest hashes, complete current-image binary evidence, and <=60 minute age.",
        "Run exact canary Amazon VALIDATION_PREVIEW; require VALID with zero issues and gallery-only paths.",
        "Apply only the exact two swap actions under a separate owner/network gate and immutable rollback fence.",
        "Perform immediate readback for slots 1 and 7 on both SKUs and verify MAIN/text/structured/offer unchanged.",
        "Perform delayed readback and buyer-facing order verification; stop before any SZ action.",
      ],
    },
    held_sz: {
      execution_authorized: false,
      selection_path: relativeToApp(finalHeldPath),
      selection_file_sha256: heldFileSha256,
      selection_sha256: heldSelection.sha256,
      release_requires_new_standard_selection: true,
    },
  };
  const releaseBundle = sealMinimalGalleryArtifact(
    releaseBody as unknown as Record<string, unknown>,
  ) as unknown as MinimalGalleryReleaseBundle;
  verifyMinimalGalleryReleaseBundle(releaseBundle);
  const releaseName = `UMGRB-${createdIso.replace(/[-:.]/g, "")}-${releaseBundle.sha256.slice(0, 12)}.json`;
  const releasePath = path.join(tempDirectory, releaseName);
  const releaseFileSha256 = await writeExclusiveWithSidecar(
    releasePath,
    `${JSON.stringify(releaseBundle, null, 2)}\n`,
  );

  await rename(tempDirectory, outputDirectory);

  const finalPlanBytes = await readFile(finalPlanPath);
  const finalCanaryBytes = await readFile(finalCanarySelectionPath);
  const finalHeldBytes = await readFile(finalHeldPath);
  assert(fileSha256(finalPlanBytes) === planFileSha256, "Final plan file SHA drift.");
  assert(fileSha256(finalCanaryBytes) === canarySelectionFileSha256, "Final canary selection SHA drift.");
  assert(fileSha256(finalHeldBytes) === heldFileSha256, "Final held selection SHA drift.");

  console.log(
    JSON.stringify(
      {
        output_directory: OUTPUT_DIRECTORY,
        reviewed_manifest: {
          path: relativeToApp(finalStandardManifestPath),
          file_sha256: standardManifestSha256,
        },
        repair_plan: {
          path: planRepoPath,
          file_sha256: planFileSha256,
          canonical_sha256: plan.sha256,
        },
        canary_selection: {
          path: relativeToApp(finalCanarySelectionPath),
          file_sha256: canarySelectionFileSha256,
          canonical_sha256: canarySelection.sha256,
          skus: canarySelection.selected_skus,
          profile: canarySelection.profile,
          execution_authorized_now: false,
          blocker: "FRESH_164_SELECTION_SCOPED_ROLLBACK_NOT_PRESENT",
        },
        held_sz_selection: {
          path: relativeToApp(finalHeldPath),
          file_sha256: heldFileSha256,
          canonical_sha256: heldSelection.sha256,
          execution_authorized: false,
          confirmation_token_emitted: false,
        },
        release_bundle: {
          path: relativeToApp(path.join(outputDirectory, releaseName)),
          file_sha256: releaseFileSha256,
          canonical_sha256: releaseBundle.sha256,
        },
        exact_current_cas_rows: casRows.length,
        plan_actions: entries.length,
        canary_actions: canarySelection.selected_actions,
        held_actions: 1,
        external_mutations: releaseBundle.external_mutations,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
