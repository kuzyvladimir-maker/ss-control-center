import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { Client } from "@libsql/client";
import type { ChannelSKU } from "@/generated/prisma/client";

import { prisma } from "@/lib/prisma";
import { assertProductTruthEvidenceSchema } from "@/lib/sourcing/product-truth-schema-gate";
import { getWalmartClient, getWalmartStoreStatus } from "@/lib/walmart/client";
import { approveDraftForDistribution } from "./approval";
import {
  normalizeAllergenDeclaration,
  serializeAllergenDeclaration,
} from "./allergen-declaration";
import { runWalmartPilotDistribution } from "./distribution/distribution-pipeline";
import { pollAndPersistWalmartSubmission } from "./distribution/status-poller";
import {
  assertCurrentWalmartBuyerEvidenceTarget,
  getWalmartBuyerPublicationEvidenceStatus,
  recordWalmartBuyerPublicationEvidence,
  type WalmartBuyerPublicationEvidenceInput,
} from "./distribution/walmart-buyer-publication-evidence";
import {
  readProductTruthNewSkuView,
  type ProductTruthNewSkuRecipeComponentEvidence,
} from "@/lib/sourcing/product-truth-read-contract";
import {
  assertWalmartCertifiedSubmissionAttemptBinding,
  assertWalmartPublishLifecycleSchema,
  hashWalmartPayload,
  walmartSubmissionIdempotencyKey,
  type WalmartCertifiedSubmissionAttemptBinding,
} from "./distribution/walmart-publish-lifecycle";
import {
  buildWalmartPayload,
} from "./distribution/walmart-publish";
import {
  fetchWalmartItemSpecSchema,
  validateWalmartPayloadAgainstFetchedSpec,
  validateWalmartPayloadAgainstLiveSpec,
} from "./distribution/walmart-item-spec";
import { getConfiguredWalmartSpecVersion } from "./distribution/walmart-item-contract";
import {
  parseVerifiedPhysicalPackageSpecs,
  physicalPackageFields,
} from "./physical-package-specs";
import {
  buildProductTruthListingManifest,
  assertValidWalmartDistributionApproval,
  mergeWalmartListingContracts,
  parseWalmartListingAttributes,
  sha256WalmartJson,
  stableWalmartJson,
  type WalmartPrepublicationEvidence,
  type WalmartPublicListingContract,
} from "./walmart-listing-contract";
import {
  runValidation,
  runValidationForDraft,
} from "./validation/validation-pipeline";
import {
  WALMART_POLICY_VERSION,
} from "./validation/walmart-prepublication-policy";
import {
  inspectWalmartPublicImageSet,
  type VerifiedWalmartPublicImage,
} from "./validation/walmart-public-image-inspection";
import {
  parseAndValidateWalmartNewSkuPolicyReviewEvidence,
} from "./walmart-new-sku-policy-review-evidence";
import {
  verifyWalmartExactIdentifierDuplicateGuardBinding,
  type SealedWalmartExactIdentifierDuplicateGuardBinding,
} from "./walmart-new-sku-catalog-authority";
import {
  WALMART_NEW_SKU_CERTIFICATION_SCHEMA,
  assertWalmartNewSkuDoctorReceiptIntegrity,
  assertWalmartNewSkuOwnerPermitIntegrity,
  assertWalmartNewSkuCertificationArtifactIntegrity,
  assertWalmartNewSkuCertificationReceiptIntegrity,
  assertWalmartNewSkuDryRunReceiptIntegrity,
  assertWalmartNewSkuApprovalArtifactIntegrity,
  assertWalmartNewSkuPlanIntegrity,
  assertWalmartNewSkuCertificationInput,
  assertWalmartNewSkuStageArtifactIntegrity,
  assertWalmartNewSkuUpcRotationReceiptIntegrity,
  buildWalmartNewSkuUpcRotationPreview,
  buildWalmartNewSkuStagePreview,
  certifyNoExactWalmartCatalogMatch,
  certifyWalmartSellerSkuAbsent,
  fingerprintWalmartSellerAccount,
  hashWalmartNewSkuCertificationInput,
  isValidOwnerPoolUpca,
  proveExactWalmartCatalogMatch,
  sealWalmartNewSkuCertificationArtifact,
  sealWalmartNewSkuApprovalArtifact,
  sealWalmartNewSkuStageArtifact,
  sealWalmartNewSkuUpcRotationReceipt,
  type WalmartNewSkuPlan,
  type WalmartNewSkuCertificationArtifact,
  type WalmartNewSkuCertificationReceipt,
  type WalmartNewSkuDryRunReceipt,
  type WalmartNewSkuApprovalArtifact,
  type WalmartNewSkuApplyReceipt,
  type WalmartNewSkuDoctorReceipt,
  type WalmartNewSkuOwnerPermit,
  type WalmartNewSkuCertificationInput,
  type WalmartNewSkuStageArtifact,
  type WalmartNewSkuUpcRotationPreview,
  type WalmartNewSkuUpcRotationReceipt,
  WalmartNewSkuPlanError,
} from "./walmart-new-sku-engine";

const UPC_RESERVATION_TTL_MS = 24 * 60 * 60 * 1_000;

/**
 * Re-resolve the configured seller at each operator/runtime boundary. The
 * sealed artifact contains only a non-secret fingerprint, never credentials
 * or the raw seller ID.
 */
export function assertCurrentWalmartSellerAccountBinding(input: {
  store_index: number;
  seller_account_fingerprint_sha256: string;
}): void {
  const status = getWalmartStoreStatus(input.store_index);
  if (!status.configured || !status.sellerId) {
    throw new WalmartNewSkuPlanError([
      `SELLER_ACCOUNT_NOT_CONFIGURED:STORE_${input.store_index}`,
    ]);
  }
  const currentFingerprint = fingerprintWalmartSellerAccount({
    storeIndex: input.store_index,
    sellerId: status.sellerId,
  });
  if (currentFingerprint !== input.seller_account_fingerprint_sha256) {
    throw new WalmartNewSkuPlanError([
      `SELLER_ACCOUNT_BINDING_MISMATCH:STORE_${input.store_index}`,
    ]);
  }
}

/**
 * Re-resolve the business seller identity for every duplicate-guard mode. The
 * legacy optional all-status mode additionally rechecks its capture credential
 * and source mirror; the pilot's exact-identifier mode does not require them.
 */
export function assertCurrentWalmartSellerCatalogAuthorityScope(
  input: SealedWalmartExactIdentifierDuplicateGuardBinding,
): SealedWalmartExactIdentifierDuplicateGuardBinding {
  const authority = verifyWalmartExactIdentifierDuplicateGuardBinding(input);
  const storeIndex = authority.account_scope.store_index;
  const status = getWalmartStoreStatus(storeIndex);
  if (!status.configured || !status.sellerId) {
    throw new WalmartNewSkuPlanError([
      `SELLER_CATALOG_AUTHORITY_ACCOUNT_NOT_CONFIGURED:STORE_${storeIndex}`,
    ]);
  }
  assertCurrentWalmartSellerAccountBinding({
    store_index: storeIndex,
    seller_account_fingerprint_sha256:
      authority.account_scope.business_seller_account_fingerprint_sha256,
  });
  return authority;
}

async function assertWalmartExactIdentifierDuplicateGuardPlan(input: {
  component: ProductTruthNewSkuRecipeComponentEvidence;
}): Promise<void> {
  if (!input.component.donor_product_id
    || !input.component.canonical_variant_id
    || !Number.isInteger(input.component.qty)
    || input.component.qty < 1) {
    throw new Error("EXACT_IDENTIFIER_DUPLICATE_GUARD_COMPONENT_INVALID");
  }
  // The selected mode does not require an all-status seller-catalog read.
  // Certification still requires exact staged-SKU absence plus exact staged-
  // UPC SPEC search before any Walmart publish transport can be prepared.
}

export async function assertCurrentWalmartSellerCatalogAuthority(input: {
  db: Client;
  authority: SealedWalmartExactIdentifierDuplicateGuardBinding;
  now?: Date;
}): Promise<SealedWalmartExactIdentifierDuplicateGuardBinding> {
  void input.db;
  void input.now;
  const authority = assertCurrentWalmartSellerCatalogAuthorityScope(
    input.authority,
  );
  return verifyWalmartExactIdentifierDuplicateGuardBinding(authority);
}

function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "P2002",
  );
}

function shelfStableCategory(value: string | null): string {
  const normalized = (value ?? "").trim();
  if (/frozen|refrigerated|chilled|cold/i.test(normalized)) {
    throw new Error(`Cold-chain candidate is not eligible for Walmart pilot: ${normalized}`);
  }
  if (!/dry|shelf|grocery|snack|food|pantry/i.test(normalized)) {
    throw new Error(
      `Pilot requires an explicit shelf-stable grocery category; got ${normalized || "missing"}`,
    );
  }
  return "SHELF_STABLE";
}

function exactEvidenceFingerprint(component: unknown): string {
  return sha256WalmartJson(component);
}

async function assertPlanEvidenceStillCurrent(input: {
  db: Client;
  plan: WalmartNewSkuPlan;
  candidateKey: string;
  now: Date;
}): Promise<void> {
  const candidate = input.plan.candidates.find(
    (item) => item.candidate_key === input.candidateKey,
  );
  if (!candidate) throw new Error(`Candidate ${input.candidateKey} is not in plan`);
  const planComponent = candidate.recipe_input.components[0];
  const planAge = input.now.getTime() - Date.parse(input.plan.as_of);
  if (
    !Number.isFinite(planAge) ||
    planAge < -5 * 60_000 ||
    planAge > candidate.recipe_input.price_max_age_ms
  ) {
    throw new Error("Plan price evidence is stale; create a new read-only plan");
  }
  const fresh = await readProductTruthNewSkuView(
    input.db,
    [{ donorProductId: candidate.donor_product_id, qty: candidate.pack_count }],
    {
      asOf: input.now,
      maxPriceAgeMs: candidate.recipe_input.price_max_age_ms,
      zip: input.plan.zip,
    },
  );
  if (
    exactEvidenceFingerprint(planComponent) !==
    exactEvidenceFingerprint(fresh.components[0])
  ) {
    throw new Error(
      "Product Truth evidence changed after the plan was sealed; create a new plan",
    );
  }
}

/** Re-read the shared canonical Product Truth view at every late gate. The
 * certification carries only exact identities and a component hash, never a
 * mutable legacy donor snapshot. */
export async function assertCertifiedWalmartProductTruthStillCurrent(input: {
  db: Client;
  certification: WalmartNewSkuCertificationArtifact;
  now?: Date;
}): Promise<ProductTruthNewSkuRecipeComponentEvidence> {
  const now = input.now ?? new Date();
  assertWalmartNewSkuCertificationArtifactIntegrity(input.certification);
  await assertProductTruthEvidenceSchema(input.db);
  const binding = input.certification.product_truth_binding;
  const fresh = await readProductTruthNewSkuView(
    input.db,
    [{ donorProductId: binding.donor_product_id, qty: binding.qty }],
    {
      asOf: now,
      maxPriceAgeMs: binding.price_max_age_ms,
      zip: binding.zip,
    },
  );
  const component = fresh.components[0];
  if (
    !component ||
    component.donor_product_id !== binding.donor_product_id ||
    component.canonical_variant_id !== binding.canonical_variant_id ||
    component.content_observation_id !== binding.content_observation_id ||
    component.price_evidence.observation_id !== binding.price_observation_id ||
    component.qty !== binding.qty ||
    exactEvidenceFingerprint(component) !== binding.component_sha256
  ) {
    throw new Error(
      "Canonical Product Truth changed or was revoked after certification; restart from plan",
    );
  }
  return component;
}

export interface VerifiedWalmartNewSkuEvidenceArtifact {
  ref: string;
  kind: WalmartNewSkuCertificationInput["evidence_artifacts"][number]["kind"];
  path: string;
  sha256: string;
  byte_size: number;
  captured_at: string;
  source_url: string | null;
}

function localEvidencePath(value: string): string {
  if (value.includes("\0")) throw new Error("Evidence artifact path contains a null byte");
  if (value.startsWith("file:")) {
    const url = new URL(value);
    if (url.protocol !== "file:" || url.search || url.hash) {
      throw new Error("Evidence artifact file URL must not contain query or fragment");
    }
    return resolve(fileURLToPath(url));
  }
  if (!isAbsolute(value)) throw new Error("Evidence artifact path must be absolute");
  return resolve(value);
}

/** Read and hash every operator evidence byte before certification can mutate
 * internal state. A URI-shaped label alone is never treated as evidence. */
export async function verifyWalmartNewSkuCertificationEvidenceArtifacts(input: {
  certification: WalmartNewSkuCertificationInput;
  plan: WalmartNewSkuPlan;
  stage: WalmartNewSkuStageArtifact;
  now?: Date;
}): Promise<VerifiedWalmartNewSkuEvidenceArtifact[]> {
  const now = input.now ?? new Date();
  const candidate = input.plan.candidates.find(
    (item) => item.candidate_key === input.stage.candidate_key,
  );
  if (!candidate) {
    throw new Error("Policy evidence candidate is absent from the sealed plan");
  }
  const verified: VerifiedWalmartNewSkuEvidenceArtifact[] = [];
  for (const artifact of input.certification.evidence_artifacts) {
    const path = localEvidencePath(artifact.path);
    const canonicalBefore = await realpath(path).catch(() => null);
    const before = await lstat(path).catch(() => null);
    if (
      !canonicalBefore ||
      !before ||
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.nlink !== 1
    ) {
      throw new Error(`Evidence artifact is not a regular non-symlink file: ${path}`);
    }
    if (before.size !== artifact.byte_size || before.size > 25 * 1024 * 1024) {
      throw new Error(`Evidence artifact byte size differs from certification: ${artifact.ref}`);
    }
    const handle = await open(
      canonicalBefore,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    )
      .catch(() => null);
    if (!handle) throw new Error(`Evidence artifact cannot be opened safely: ${path}`);
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino ||
        opened.size !== before.size ||
        opened.mtimeMs !== before.mtimeMs ||
        opened.ctimeMs !== before.ctimeMs ||
        opened.nlink !== 1
      ) {
        throw new Error(`Evidence artifact changed before read: ${artifact.ref}`);
      }
      const bytes = await handle.readFile();
      const after = await handle.stat();
      const canonicalAfter = await realpath(path).catch(() => null);
      const pathAfter = await lstat(path).catch(() => null);
      if (
        canonicalAfter !== canonicalBefore ||
        !pathAfter ||
        pathAfter.isSymbolicLink() ||
        !pathAfter.isFile() ||
        after.dev !== opened.dev ||
        after.ino !== opened.ino ||
        after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs ||
        after.ctimeMs !== opened.ctimeMs ||
        after.nlink !== 1 ||
        pathAfter.dev !== after.dev ||
        pathAfter.ino !== after.ino ||
        pathAfter.size !== after.size ||
        pathAfter.mtimeMs !== after.mtimeMs ||
        pathAfter.ctimeMs !== after.ctimeMs ||
        pathAfter.nlink !== 1 ||
        bytes.length !== artifact.byte_size
      ) {
        throw new Error(`Evidence artifact changed during read: ${artifact.ref}`);
      }
      const actual = createHash("sha256").update(bytes).digest("hex");
      if (actual !== artifact.sha256) {
        throw new Error(`Evidence artifact SHA-256 mismatch: ${artifact.ref}`);
      }
      if (artifact.kind === "POLICY_REVIEW") {
        parseAndValidateWalmartNewSkuPolicyReviewEvidence({
          bytes,
          context: {
            expected_binding: {
              wave_id: input.plan.wave_id,
              plan_sha256: input.plan.plan_sha256,
              stage_sha256: input.stage.stage_sha256,
              candidate_key: candidate.candidate_key,
              candidate_sha256: sha256WalmartJson(candidate),
              store_index: input.plan.store_index,
              business_seller_account_fingerprint_sha256:
                input.plan.seller_account_fingerprint_sha256,
              sku: input.stage.proposed_sku,
              upc: input.stage.upc,
              donor_product_id: candidate.donor_product_id,
              canonical_variant_id: candidate.canonical_variant_id,
              product_type: input.certification.walmart.product_type,
            },
            certification_policy_review:
              input.certification.prepublication.sku_policy_review,
            certification_category_approvals:
              input.certification.prepublication.category_approvals,
            artifact,
            now,
          },
        });
      }
      verified.push({ ...artifact, path, sha256: actual });
    } finally {
      await handle.close();
    }
  }
  return verified;
}

async function ensureDraft(input: {
  plan: WalmartNewSkuPlan;
  candidateKey: string;
  actor: string;
  now: Date;
}): Promise<{ draftId: string }> {
  const preview = buildWalmartNewSkuStagePreview({
    plan: input.plan,
    candidateKey: input.candidateKey,
  });
  const candidate = input.plan.candidates.find(
    (item) => item.candidate_key === input.candidateKey,
  )!;
  const component = candidate.recipe_input.components[0];
  const category = shelfStableCategory(candidate.source_candidate.category);
  const unitPriceCents = Math.round(component.price_evidence.price_per_unit * 100);
  if (!Number.isInteger(unitPriceCents) || unitPriceCents <= 0) {
    throw new Error("Canonical component cost must be positive integer cents");
  }
  const recipeFingerprint = `walmart:${input.plan.store_index}:${candidate.canonical_variant_id}:${candidate.pack_count}`;
  const snapshot = [{
    research_pool_id: component.donor_product_id,
    product_name: component.product_name,
    brand: component.manufacturer_brand,
    flavor: component.flavor,
    manufacturer_upc: component.manufacturer_upc,
    qty: component.qty,
    unit_price_cents: unitPriceCents,
    ingredients: component.facts.ingredients,
    allergens: component.facts.allergens,
    nutrition_facts: component.facts.nutrition_facts,
    storage_temp: "Shelf-stable",
    donor_image_urls: component.facts.attributes._exact_image_urls ?? [],
    product_truth_component: component,
  }];
  const brief = {
    engine: "walmart-new-sku-engine",
    wave_id: input.plan.wave_id,
    plan_sha256: input.plan.plan_sha256,
    store_index: input.plan.store_index,
    actor: input.actor,
  };

  await prisma.$transaction(async (tx) => {
    const existingJob = await tx.generationJob.findUnique({
      where: { id: preview.generation_job_id },
      select: { brief: true },
    });
    if (existingJob) {
      const parsed = JSON.parse(existingJob.brief) as Record<string, unknown>;
      if (parsed.plan_sha256 !== input.plan.plan_sha256) {
        throw new Error("GenerationJob ID collision with another sealed plan");
      }
    } else {
      await tx.generationJob.create({
        data: {
          id: preview.generation_job_id,
          brief: JSON.stringify(brief),
          current_stage: "VARIATION_MATRIX",
          status: "IN_PROGRESS",
          bundles_target: input.plan.candidates.length,
          notes: `Walmart new-SKU ${input.plan.wave_id}; staged by ${input.actor}`,
        },
      });
    }

    const sameRecipe = await tx.bundleDraft.findUnique({
      where: { recipe_fingerprint: recipeFingerprint },
      select: { id: true, generation_job_id: true, target_channels: true },
    });
    if (sameRecipe && sameRecipe.id !== preview.bundle_draft_id) {
      throw new Error(
        `Exact Walmart recipe is already staged as BundleDraft ${sameRecipe.id}`,
      );
    }
    const existingDraft = await tx.bundleDraft.findUnique({
      where: { id: preview.bundle_draft_id },
      select: { generation_job_id: true, recipe_fingerprint: true },
    });
    if (existingDraft) {
      if (
        existingDraft.generation_job_id !== preview.generation_job_id ||
        existingDraft.recipe_fingerprint !== recipeFingerprint
      ) {
        throw new Error("BundleDraft ID collision with another engine recipe");
      }
      return;
    }
    await tx.bundleDraft.create({
      data: {
        id: preview.bundle_draft_id,
        generation_job_id: preview.generation_job_id,
        draft_name: `${component.product_name} (Pack of ${candidate.pack_count})`,
        brand: component.manufacturer_brand,
        category,
        composition_type: "SINGLE_FLAVOR",
        pack_count: candidate.pack_count,
        draft_components: JSON.stringify(snapshot),
        draft_title: candidate.content.title,
        draft_bullets: JSON.stringify(candidate.content.bullets),
        draft_description: candidate.content.description,
        draft_cost_cents: unitPriceCents * candidate.pack_count,
        status: "VARIATION_SELECTED",
        recipe_fingerprint: recipeFingerprint,
        target_channels: JSON.stringify(["WALMART"]),
      },
    });
  });
  return { draftId: preview.bundle_draft_id };
}

async function reserveManagedUpc(input: {
  draftId: string;
  now: Date;
}): Promise<{
  id: string;
  upc: string;
  acquired_from: string;
  gs1_owner: string;
  reserved_until: Date;
}> {
  const reservedUntil = new Date(input.now.getTime() + UPC_RESERVATION_TTL_MS);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const existing = await prisma.uPCPool.findUnique({
      where: { reserved_for_id: input.draftId },
      select: {
        id: true,
        upc: true,
        acquired_from: true,
        gs1_owner: true,
        reserved_until: true,
      },
    });
    if (existing) {
      if (!isValidOwnerPoolUpca(existing.upc)) {
        throw new Error(
          `Draft ${input.draftId} already holds checksum-invalid UPC ${existing.upc}`,
        );
      }
      if (!existing.acquired_from?.trim() || !existing.gs1_owner?.trim()) {
        throw new Error(
          `Draft ${input.draftId} holds UPC ${existing.upc} without pool provenance`,
        );
      }
      const renewed =
        existing.reserved_until && existing.reserved_until > input.now
          ? existing.reserved_until
          : reservedUntil;
      if (renewed !== existing.reserved_until) {
        const renewedRow = await prisma.uPCPool.updateMany({
          where: {
            id: existing.id,
            reserved_for_id: input.draftId,
            status: "RESERVED",
            assigned_to_id: null,
          },
          data: { reserved_at: input.now, reserved_until: renewed },
        });
        if (renewedRow.count !== 1) continue;
      }
      return {
        id: existing.id,
        upc: existing.upc,
        acquired_from: existing.acquired_from,
        gs1_owner: existing.gs1_owner,
        reserved_until: renewed,
      };
    }

    const rows = await prisma.uPCPool.findMany({
      where: { status: "AVAILABLE", assigned_to_id: null },
      orderBy: [{ acquired_at: "asc" }, { id: "asc" }],
      take: 100,
      select: {
        id: true,
        upc: true,
        acquired_from: true,
        gs1_owner: true,
      },
    });
    const row = rows.find(
      (candidate) =>
        isValidOwnerPoolUpca(candidate.upc) &&
        Boolean(candidate.acquired_from?.trim()) &&
        Boolean(candidate.gs1_owner?.trim()),
    );
    if (!row) {
      throw new Error("UPC pool has no AVAILABLE checksum-valid UPC-A rows");
    }
    let claimed;
    try {
      claimed = await prisma.uPCPool.updateMany({
        where: {
          id: row.id,
          status: "AVAILABLE",
          assigned_to_id: null,
          reserved_for_id: null,
        },
        data: {
          status: "RESERVED",
          reserved_for_id: input.draftId,
          reserved_at: input.now,
          reserved_until: reservedUntil,
        },
      });
    } catch (error) {
      // Another process may have won the per-draft unique fence. Re-read on
      // the next iteration and return that exact reservation idempotently.
      if (isUniqueConstraintError(error)) continue;
      throw error;
    }
    if (claimed.count === 1) {
      return {
        id: row.id,
        upc: row.upc,
        acquired_from: row.acquired_from!,
        gs1_owner: row.gs1_owner!,
        reserved_until: reservedUntil,
      };
    }
  }
  throw new Error("Could not atomically reserve a UPC after 10 races");
}

/**
 * The first state-changing engine operation. It writes only internal staging
 * rows and reserves one existing managed UPC; it never calls Walmart.
 */
export async function stageWalmartNewSkuCandidate(input: {
  productTruthDb: Client;
  plan: WalmartNewSkuPlan;
  candidateKey: string;
  actor: string;
  now?: Date;
}): Promise<WalmartNewSkuStageArtifact> {
  assertWalmartNewSkuPlanIntegrity(input.plan);
  assertCurrentWalmartSellerAccountBinding(input.plan);
  const actor = input.actor.trim();
  if (!actor) throw new Error("Staging actor is required");
  const now = input.now ?? new Date();

  // Both runtime schemas are mandatory before the first write. This keeps an
  // undeployed Product Truth/lifecycle migration from producing legacy drafts.
  await assertProductTruthEvidenceSchema(input.productTruthDb);
  await assertWalmartPublishLifecycleSchema();
  await assertCurrentWalmartSellerCatalogAuthority({
    db: input.productTruthDb,
    authority: input.plan.seller_catalog_authority,
    now,
  });
  await assertPlanEvidenceStillCurrent({
    db: input.productTruthDb,
    plan: input.plan,
    candidateKey: input.candidateKey,
    now,
  });

  const candidate = input.plan.candidates.find(
    (item) => item.candidate_key === input.candidateKey,
  );
  if (!candidate) throw new Error(`Candidate ${input.candidateKey} is not in plan`);
  await assertWalmartExactIdentifierDuplicateGuardPlan({
    component: candidate.recipe_input.components[0],
  });

  const preview = buildWalmartNewSkuStagePreview({
    plan: input.plan,
    candidateKey: input.candidateKey,
  });
  assertCurrentWalmartSellerAccountBinding(input.plan);
  await assertCurrentWalmartSellerCatalogAuthority({
    db: input.productTruthDb,
    authority: input.plan.seller_catalog_authority,
    now: new Date(),
  });
  const { draftId } = await ensureDraft({
    plan: input.plan,
    candidateKey: input.candidateKey,
    actor,
    now,
  });
  await assertCurrentWalmartSellerCatalogAuthority({
    db: input.productTruthDb,
    authority: input.plan.seller_catalog_authority,
    now: new Date(),
  });
  const upc = await reserveManagedUpc({ draftId, now });
  return sealWalmartNewSkuStageArtifact({
    ...preview,
    staged_at: now.toISOString(),
    staged_by: actor,
    upc_pool_id: upc.id,
    upc: upc.upc,
    upc_checksum_valid: true,
    upc_pool_acquired_from: upc.acquired_from,
    upc_pool_recorded_owner: upc.gs1_owner,
    upc_reserved_until: upc.reserved_until.toISOString(),
    state: "UPC_RESERVED",
  });
}

const UPC_ROTATION_NOTE_PREFIX =
  "WALMART_NEW_SKU_UPC_ROTATION_V1=";

class UpcRotationRaceError extends Error {}

function appendUpcAuditNote(existing: string | null, line: string): string {
  return [existing?.trim(), line].filter(Boolean).join("\n");
}

function readPersistedUpcRotationReceipt(
  notes: string | null,
): WalmartNewSkuUpcRotationReceipt | null {
  if (!notes) return null;
  const marker = notes
    .split("\n")
    .reverse()
    .find((line) => line.startsWith(UPC_ROTATION_NOTE_PREFIX));
  if (!marker) return null;
  try {
    return JSON.parse(
      marker.slice(UPC_ROTATION_NOTE_PREFIX.length),
    ) as WalmartNewSkuUpcRotationReceipt;
  } catch {
    throw new Error("Retired UPC contains a malformed durable rotation receipt");
  }
}

async function readExactCatalogMatchForRotation(input: {
  productTruthDb: Client;
  plan: WalmartNewSkuPlan;
  stage: WalmartNewSkuStageArtifact;
  now: Date;
}): Promise<WalmartNewSkuUpcRotationPreview> {
  assertWalmartNewSkuStageArtifactIntegrity(input.stage, input.plan);
  assertCurrentWalmartSellerAccountBinding(input.plan);
  await assertCurrentWalmartSellerCatalogAuthority({
    db: input.productTruthDb,
    authority: input.plan.seller_catalog_authority,
    now: input.now,
  });
  const client = getWalmartClient(input.plan.store_index);
  const response = await client.requestRaw(
    "GET",
    "/items/walmart/search",
    {
      params: { upc: input.stage.upc, responseFormat: "SPEC" },
      noRetryOn429: true,
    },
  );
  if (response.status !== 200 || !response.ok) {
    throw new Error(
      `Walmart SPEC catalog search returned HTTP ${response.status} ` +
      `(cid=${response.correlationId || "unknown"}); UPC rotation is blocked`,
    );
  }
  const exactMatch = proveExactWalmartCatalogMatch({
    upc: input.stage.upc,
    responseBody: response.body,
    searchedAt: input.now,
    correlationId: response.correlationId,
  });
  return buildWalmartNewSkuUpcRotationPreview({
    plan: input.plan,
    stage: input.stage,
    exactMatch,
  });
}

/**
 * Read-only preflight for rotating a UPC that Walmart proves is an existing,
 * live catalog item. The request is identifier-only `responseFormat=SPEC`;
 * only an unambiguous MP_ITEM_MATCH result produces a confirmation hash.
 */
export async function previewWalmartNewSkuUpcRotation(input: {
  productTruthDb: Client;
  plan: WalmartNewSkuPlan;
  stage: WalmartNewSkuStageArtifact;
  now?: Date;
}): Promise<WalmartNewSkuUpcRotationPreview> {
  return readExactCatalogMatchForRotation({
    productTruthDb: input.productTruthDb,
    plan: input.plan,
    stage: input.stage,
    now: input.now ?? new Date(),
  });
}

export interface RotateWalmartNewSkuUpcResult {
  preview: WalmartNewSkuUpcRotationPreview;
  new_stage: WalmartNewSkuStageArtifact;
  receipt: WalmartNewSkuUpcRotationReceipt;
  idempotent_recovery: boolean;
}

/**
 * Rotate only an UPC proven by a fresh MP_ITEM_MATCH SPEC response. The old
 * pool row remains recoverable as RETIRED for a future match adapter. The old
 * draft fence is cleared and the next checksum-valid UPC is reserved in one
 * database transaction. No Walmart mutation exists in this path.
 */
export async function rotateExactMatchedWalmartNewSkuUpc(input: {
  productTruthDb: Client;
  plan: WalmartNewSkuPlan;
  stage: WalmartNewSkuStageArtifact;
  actor: string;
  confirmationSha256: string;
  now?: Date;
}): Promise<RotateWalmartNewSkuUpcResult> {
  assertWalmartNewSkuStageArtifactIntegrity(input.stage, input.plan);
  assertCurrentWalmartSellerAccountBinding(input.plan);
  const actor = input.actor.trim().replace(/\s+/g, " ");
  if (!actor) throw new Error("UPC rotation actor is required");
  const now = input.now ?? new Date();
  await assertWalmartPublishLifecycleSchema();

  // This is deliberately the last external operation before the transaction.
  // The exact proof is re-read even when a prior preview was already shown.
  const preview = await readExactCatalogMatchForRotation({
    productTruthDb: input.productTruthDb,
    plan: input.plan,
    stage: input.stage,
    now,
  });
  if (input.confirmationSha256 !== preview.confirmation_sha256) {
    throw new Error(
      "UPC rotation requires --confirm equal to the current exact-match confirmation SHA-256",
    );
  }

  assertCurrentWalmartSellerAccountBinding(input.plan);
  await assertCurrentWalmartSellerCatalogAuthority({
    db: input.productTruthDb,
    authority: input.plan.seller_catalog_authority,
    now: new Date(),
  });

  const reservedUntil = new Date(now.getTime() + UPC_RESERVATION_TTL_MS);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await assertCurrentWalmartSellerCatalogAuthority({
        db: input.productTruthDb,
        authority: input.plan.seller_catalog_authority,
        now: new Date(),
      });
      return await prisma.$transaction(async (tx) => {
        const [draft, oldPool] = await Promise.all([
          tx.bundleDraft.findUnique({
            where: { id: input.stage.bundle_draft_id },
            select: {
              id: true,
              approved_at: true,
              master_bundle_id: true,
            },
          }),
          tx.uPCPool.findUnique({
            where: { id: input.stage.upc_pool_id },
            select: {
              id: true,
              upc: true,
              gs1_validated: true,
              acquired_from: true,
              gs1_owner: true,
              status: true,
              assigned_to_id: true,
              reserved_for_id: true,
              reserved_at: true,
              reserved_until: true,
              notes: true,
            },
          }),
        ]);
        if (!draft) throw new Error("Staged BundleDraft does not exist");
        if (!oldPool || oldPool.upc !== input.stage.upc) {
          throw new Error("Prior staged UPC pool row is missing or changed");
        }
        if (draft.approved_at || draft.master_bundle_id) {
          throw new Error("Certified or approved drafts cannot rotate their UPC");
        }

        if (oldPool.status === "RETIRED") {
          if (
            oldPool.assigned_to_id != null ||
            oldPool.reserved_for_id != null ||
            oldPool.reserved_at != null ||
            oldPool.reserved_until != null
          ) {
            throw new Error(
              "RETIRED UPC still carries assignment or reservation state",
            );
          }
          const persisted = readPersistedUpcRotationReceipt(oldPool.notes);
          if (!persisted) {
            throw new Error(
              "Prior UPC is RETIRED without a recoverable engine rotation receipt",
            );
          }
          assertWalmartNewSkuUpcRotationReceiptIntegrity(
            persisted,
            input.plan,
            input.stage,
          );
          if (persisted.confirmation_sha256 !== preview.confirmation_sha256) {
            throw new Error(
              "Persisted UPC rotation proof differs from the current catalog match",
            );
          }
          const currentNewPool = await tx.uPCPool.findUnique({
            where: { id: persisted.new_upc_pool_id },
            select: {
              upc: true,
              acquired_from: true,
              gs1_owner: true,
              status: true,
              assigned_to_id: true,
              reserved_for_id: true,
              reserved_until: true,
            },
          });
          if (
            !currentNewPool ||
            currentNewPool.upc !== persisted.new_upc ||
            currentNewPool.acquired_from !==
              persisted.new_stage.upc_pool_acquired_from ||
            currentNewPool.gs1_owner !==
              persisted.new_stage.upc_pool_recorded_owner ||
            currentNewPool.status !== "RESERVED" ||
            currentNewPool.assigned_to_id != null ||
            currentNewPool.reserved_for_id !== draft.id ||
            currentNewPool.reserved_until == null ||
            currentNewPool.reserved_until <= now ||
            currentNewPool.reserved_until?.toISOString() !==
              persisted.new_stage.upc_reserved_until
          ) {
            throw new Error(
              "Persisted UPC rotation no longer has its exact active draft reservation",
            );
          }
          return {
            preview,
            new_stage: persisted.new_stage,
            receipt: persisted,
            idempotent_recovery: true,
          };
        }

        if (
          oldPool.status !== "RESERVED" ||
          oldPool.assigned_to_id != null ||
          oldPool.reserved_for_id !== draft.id ||
          oldPool.reserved_until == null ||
          oldPool.reserved_until <= now
        ) {
          throw new Error(
            "Prior UPC is not an active reservation for this exact draft",
          );
        }
        const channelSku = await tx.channelSKU.findFirst({
          where: {
            OR: [
              { upc_pool_id: oldPool.id },
              { upc: oldPool.upc },
            ],
          },
          select: { id: true, sku: true },
        });
        if (channelSku) {
          throw new Error(
            `UPC is already referenced by ChannelSKU ${channelSku.id} (${channelSku.sku})`,
          );
        }

        const available = await tx.uPCPool.findMany({
          where: {
            status: "AVAILABLE",
            assigned_to_id: null,
            reserved_for_id: null,
          },
          orderBy: [{ acquired_at: "asc" }, { id: "asc" }],
          select: {
            id: true,
            upc: true,
            gs1_validated: true,
            acquired_from: true,
            gs1_owner: true,
            notes: true,
          },
        });
        const nextPool = available.find(
          (row) =>
            isValidOwnerPoolUpca(row.upc) &&
            Boolean(row.acquired_from?.trim()) &&
            Boolean(row.gs1_owner?.trim()),
        );
        if (!nextPool) {
          throw new Error("UPC pool has no AVAILABLE checksum-valid UPC-A rows");
        }

        const priorUnsigned = Object.fromEntries(
          Object.entries(input.stage).filter(([key]) => key !== "stage_sha256"),
        ) as Omit<WalmartNewSkuStageArtifact, "stage_sha256">;
        const newStage = sealWalmartNewSkuStageArtifact({
          ...priorUnsigned,
          staged_at: now.toISOString(),
          staged_by: actor,
          upc_pool_id: nextPool.id,
          upc: nextPool.upc,
          upc_checksum_valid: true,
          upc_pool_acquired_from: nextPool.acquired_from!,
          upc_pool_recorded_owner: nextPool.gs1_owner!,
          upc_reserved_until: reservedUntil.toISOString(),
          state: "UPC_RESERVED",
        });
        const receipt = sealWalmartNewSkuUpcRotationReceipt({
          schema_version: "walmart-new-sku-upc-rotation-receipt/1.0.0",
          confirmation_sha256: preview.confirmation_sha256,
          plan_sha256: input.plan.plan_sha256,
          prior_stage_sha256: input.stage.stage_sha256,
          new_stage_sha256: newStage.stage_sha256,
          candidate_key: input.stage.candidate_key,
          bundle_draft_id: input.stage.bundle_draft_id,
          rotated_at: now.toISOString(),
          rotated_by: actor,
          exact_match: preview.exact_match,
          retired_upc_pool_id: oldPool.id,
          retired_upc: oldPool.upc,
          retired_upc_status: "RETIRED",
          retired_upc_disposition: "FUTURE_MP_ITEM_MATCH",
          new_upc_pool_id: nextPool.id,
          new_upc: nextPool.upc,
          new_upc_status: "RESERVED",
          new_stage: newStage,
          internal_database_mutated: true,
          marketplace_mutated: false,
        }, input.plan, input.stage);
        const exactItemLabel =
          preview.exact_match.walmart_item_id ?? "not-returned-by-SPEC";
        const auditLine =
          `[${now.toISOString()}] RETIRED by walmart-new-sku-engine; ` +
          `exact live Walmart catalog MP_ITEM_MATCH item=${exactItemLabel}; ` +
          `preserved for future MP_ITEM_MATCH; actor=${actor}; ` +
          `rotation_receipt_sha256=${receipt.receipt_sha256}`;
        const durableReceiptLine =
          `${UPC_ROTATION_NOTE_PREFIX}${stableWalmartJson(receipt)}`;

        const retired = await tx.uPCPool.updateMany({
          where: {
            id: oldPool.id,
            upc: oldPool.upc,
            status: "RESERVED",
            assigned_to_id: null,
            reserved_for_id: draft.id,
            reserved_until: oldPool.reserved_until,
          },
          data: {
            status: "RETIRED",
            reserved_for_id: null,
            reserved_at: null,
            reserved_until: null,
            notes: appendUpcAuditNote(
              oldPool.notes,
              `${auditLine}\n${durableReceiptLine}`,
            ),
          },
        });
        if (retired.count !== 1) throw new UpcRotationRaceError();
        const reserved = await tx.uPCPool.updateMany({
          where: {
            id: nextPool.id,
            upc: nextPool.upc,
            status: "AVAILABLE",
            assigned_to_id: null,
            reserved_for_id: null,
          },
          data: {
            status: "RESERVED",
            reserved_for_id: draft.id,
            reserved_at: now,
            reserved_until: reservedUntil,
            notes: appendUpcAuditNote(
              nextPool.notes,
              `[${now.toISOString()}] RESERVED after exact-match UPC rotation; ` +
              `receipt=${receipt.receipt_sha256}; actor=${actor}`,
            ),
          },
        });
        if (reserved.count !== 1) throw new UpcRotationRaceError();
        return {
          preview,
          new_stage: newStage,
          receipt,
          idempotent_recovery: false,
        };
      });
    } catch (error) {
      if (error instanceof UpcRotationRaceError || isUniqueConstraintError(error)) {
        continue;
      }
      throw error;
    }
  }
  throw new Error("Could not atomically rotate the UPC after 10 races");
}

function exactQuantityAttributes(
  current: Record<string, unknown>,
  packCount: number,
): Record<string, unknown> {
  const expected = {
    multipackQuantity: packCount,
    countPerPack: 1,
    count: packCount,
  };
  const output = { ...current };
  for (const [key, value] of Object.entries(expected)) {
    if (output[key] != null && output[key] !== value) {
      throw new Error(
        `public_attributes.${key} conflicts with exact recipe count ${packCount}`,
      );
    }
    output[key] = value;
  }
  return output;
}

function deterministicRuntimeId(prefix: string, seed: unknown): string {
  return `${prefix}-${sha256WalmartJson(seed).slice(0, 24)}`;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function serializeProductTruthAllergenDeclaration(value: unknown): string {
  if (Array.isArray(value)) {
    if (value.length !== 0) {
      throw new Error(
        "Product Truth allergen arrays may only be [] for an explicit no-allergen declaration",
      );
    }
    return serializeAllergenDeclaration({ contains: [], may_contain: [] });
  }
  return serializeAllergenDeclaration(
    normalizeAllergenDeclaration(value, "Product Truth allergens"),
  );
}

function stagedSkuShape(input: {
  id: string;
  masterBundleId: string;
  sku: string;
  upc: string;
  upcPoolId: string;
  title: string;
  bullets: string[];
  description: string;
  attributes: string;
  priceCents: number;
  mainImageUrl: string;
  countryOfOrigin: string;
  itemType: string;
  physical: WalmartNewSkuCertificationInput["physical_package"];
}): ChannelSKU {
  return {
    id: input.id,
    master_bundle_id: input.masterBundleId,
    channel: "WALMART",
    brand_account_id: null,
    sku: input.sku,
    upc: input.upc,
    upc_pool_id: input.upcPoolId,
    asin: null,
    walmart_item_id: null,
    ebay_item_id: null,
    tiktok_product_id: null,
    title: input.title,
    bullets: JSON.stringify(input.bullets),
    description: input.description,
    search_terms: null,
    attributes: input.attributes,
    channel_category: input.itemType,
    channel_browse_node: null,
    price_cents: input.priceCents,
    business_price_cents: null,
    lifecycle_status: "GENERATED",
    submitted_at: null,
    processing_at: null,
    live_at: null,
    live_url: null,
    last_error_at: null,
    errors: null,
    units_sold_30d: 0,
    revenue_30d_cents: 0,
    compliance_status: "CAN_PUBLISH",
    compliance_check_id: null,
    compliance_blocked_at: null,
    compliance_blocked_reasons: null,
    main_image_url: input.mainImageUrl,
    validation_status: "PENDING",
    validation_errors: null,
    validated_at: null,
    validation_check_id: null,
    validation_attempt_count: 0,
    available_quantity: null,
    inventory_checked_at: null,
    package_length_in: input.physical.length_in,
    package_width_in: input.physical.width_in,
    package_height_in: input.physical.height_in,
    package_weight_oz: input.physical.weight_oz,
    country_of_origin: input.countryOfOrigin,
    item_type: input.itemType,
    listing_status: "PENDING",
    submission_id: null,
    published_at: null,
    distribution_errors: null,
    distribution_attempt_count: 0,
    last_status_check_at: null,
    created_at: new Date(0),
    updated_at: new Date(0),
  };
}

export interface WalmartNewSkuCertificationSourceReceipt {
  operator_evidence: VerifiedWalmartNewSkuEvidenceArtifact[];
  public_images: VerifiedWalmartPublicImage[];
  seller_sku_absence: {
    endpoint: string;
    sku: string;
    http_status: 404;
    correlation_id: string;
    response_sha256: string;
    response_body: unknown;
  };
  catalog_search: {
    endpoint: "/v3/items/walmart/search";
    query: { upc: string; responseFormat: "SPEC" };
    correlation_id: string;
    response_sha256: string;
    response_body: unknown;
  };
  item_spec: {
    endpoint: "/v3/items/spec";
    schema_sha256: string;
    fetched_at: string;
    required_paths: string[];
    conditional_required_paths: string[];
    schema: Record<string, unknown>;
  };
}

export interface CertifyWalmartNewSkuResult {
  artifact: WalmartNewSkuCertificationArtifact;
  payload: Record<string, unknown>;
  validation: Awaited<ReturnType<typeof runValidationForDraft>>;
  source_receipt: WalmartNewSkuCertificationSourceReceipt;
}

/**
 * Create the exact MasterBundle/ChannelSKU and run every gate. Walmart calls
 * in this function are read-only catalog/Get-Spec requests; no feed is posted.
 */
export async function certifyWalmartNewSkuCandidate(input: {
  productTruthDb: Client;
  plan: WalmartNewSkuPlan;
  stage: WalmartNewSkuStageArtifact;
  certification: WalmartNewSkuCertificationInput;
  actor: string;
  now?: Date;
}): Promise<CertifyWalmartNewSkuResult> {
  const now = input.now ?? new Date();
  const actor = input.actor.trim();
  if (!actor) throw new Error("Certification actor is required");
  assertWalmartNewSkuCertificationInput({
    certification: input.certification,
    plan: input.plan,
    stage: input.stage,
    now,
  });
  const verifiedOperatorEvidence =
    await verifyWalmartNewSkuCertificationEvidenceArtifacts({
      certification: input.certification,
      plan: input.plan,
      stage: input.stage,
      now,
    });
  assertCurrentWalmartSellerAccountBinding(input.plan);
  await assertProductTruthEvidenceSchema(input.productTruthDb);
  await assertWalmartPublishLifecycleSchema();
  await assertCurrentWalmartSellerCatalogAuthority({
    db: input.productTruthDb,
    authority: input.plan.seller_catalog_authority,
    now,
  });
  await assertPlanEvidenceStillCurrent({
    db: input.productTruthDb,
    plan: input.plan,
    candidateKey: input.stage.candidate_key,
    now,
  });
  assertWalmartNewSkuStageArtifactIntegrity(input.stage, input.plan);

  const candidate = input.plan.candidates.find(
    (item) => item.candidate_key === input.stage.candidate_key,
  )!;
  const component = candidate.recipe_input.components[0];
  const masterBundleId = deterministicRuntimeId("wmmaster", {
    store_index: input.plan.store_index,
    candidate_key: candidate.candidate_key,
  });
  const channelSkuId = deterministicRuntimeId("wmsku", {
    store_index: input.plan.store_index,
    candidate_key: candidate.candidate_key,
  });
  const bundleComponentId = deterministicRuntimeId("wmcomponent", {
    master_bundle_id: masterBundleId,
    component_key: component.component_key,
  });

  await assertWalmartExactIdentifierDuplicateGuardPlan({
    component,
  });

  const [draft, pool] = await Promise.all([
    prisma.bundleDraft.findUnique({
      where: { id: input.stage.bundle_draft_id },
      select: { id: true, approved_at: true, master_bundle_id: true },
    }),
    prisma.uPCPool.findUnique({
      where: { id: input.stage.upc_pool_id },
      select: {
        id: true,
        upc: true,
        acquired_from: true,
        gs1_owner: true,
        status: true,
        assigned_to_id: true,
        reserved_for_id: true,
        reserved_until: true,
      },
    }),
  ]);
  if (!draft) throw new Error("Staged BundleDraft does not exist");
  if (draft.approved_at) throw new Error("Approved draft cannot be recertified");
  if (!pool || pool.upc !== input.stage.upc) {
    throw new Error("Staged UPC pool row is missing or changed");
  }
  if (
    pool.acquired_from !== input.stage.upc_pool_acquired_from ||
    pool.gs1_owner !== input.stage.upc_pool_recorded_owner
  ) {
    throw new Error("Staged UPC pool provenance changed after stage sealing");
  }
  const reservationMatches =
    pool.status === "RESERVED" &&
    pool.assigned_to_id == null &&
    pool.reserved_for_id === draft.id &&
    pool.reserved_until != null &&
    pool.reserved_until > now;
  const assignmentMatches =
    pool.status === "ASSIGNED" && pool.assigned_to_id === channelSkuId;
  if (!reservationMatches && !assignmentMatches) {
    throw new Error("Staged UPC is neither actively reserved nor assigned to this exact SKU");
  }

  const client = getWalmartClient(input.plan.store_index);
  const sellerSkuResponse = await client.requestRaw(
    "GET",
    `/items/${encodeURIComponent(input.stage.proposed_sku)}`,
    { noRetryOn429: true },
  );
  const sellerSkuAbsence = certifyWalmartSellerSkuAbsent({
    sku: input.stage.proposed_sku,
    httpStatus: sellerSkuResponse.status,
    responseBody: sellerSkuResponse.body,
    checkedAt: now,
    correlationId: sellerSkuResponse.correlationId,
  });
  const catalogResponse = await client.requestRaw(
    "GET",
    "/items/walmart/search",
    {
      params: { upc: input.stage.upc, responseFormat: "SPEC" },
      noRetryOn429: true,
    },
  );
  if (catalogResponse.status !== 200 || !catalogResponse.ok) {
    throw new Error(
      `Walmart catalog search returned HTTP ${catalogResponse.status} ` +
      `(cid=${catalogResponse.correlationId || "unknown"})`,
    );
  }
  const catalogSearch = certifyNoExactWalmartCatalogMatch({
    upc: input.stage.upc,
    responseBody: catalogResponse.body,
    searchedAt: now,
    correlationId: catalogResponse.correlationId,
    responseFormat: "SPEC",
  });

  const specVersion = getConfiguredWalmartSpecVersion();
  const fetchedSpec = await fetchWalmartItemSpecSchema(client, {
    version: specVersion,
    productType: input.certification.walmart.product_type,
    now,
  });
  const publicAttributes = exactQuantityAttributes(
    input.certification.walmart.public_attributes,
    candidate.pack_count,
  );
  const mainImage = input.certification.images.find((image) => image.role === "MAIN")!;
  const secondaryImages = input.certification.images
    .filter((image) => image.role !== "MAIN")
    .map((image) => image.url);
  const verifiedPublicImages = await inspectWalmartPublicImageSet([
    mainImage.url,
    ...secondaryImages,
  ]);
  const manifest = buildProductTruthListingManifest({
    sku: input.stage.proposed_sku,
    storeIndex: input.plan.store_index,
    verifiedAt: now,
    packCount: candidate.pack_count,
    components: candidate.recipe_input.components,
    images: input.certification.images,
  });
  const walmartContract: WalmartPublicListingContract = {
    contract_version: "walmart-mp-item-public/1.0.0",
    spec_version: specVersion,
    spec_schema_hash: fetchedSpec.schema_sha256,
    spec_fetched_at: fetchedSpec.fetched_at,
    product_type: input.certification.walmart.product_type,
    country_of_origin_substantial_transformation:
      input.certification.walmart.country_of_origin_substantial_transformation,
    secondary_image_urls: secondaryImages,
    public_attributes: publicAttributes,
    offer_handoff: input.certification.walmart.offer_handoff,
  };
  const prepublication: WalmartPrepublicationEvidence = {
    schema_version: "walmart-prepublication-evidence/1.2.0",
    policy_version: WALMART_POLICY_VERSION,
    generated_at: now.toISOString(),
    store_index: input.plan.store_index,
    sku: input.stage.proposed_sku,
    catalog_search: catalogSearch,
    seller_account_health:
      input.certification.prepublication.seller_account_health,
    fulfillment_compliance:
      input.certification.prepublication.fulfillment_compliance,
    category_approvals: input.certification.prepublication.category_approvals,
    sku_policy_review: input.certification.prepublication.sku_policy_review,
    recall_check: input.certification.prepublication.recall_check,
    brand_rights: input.certification.prepublication.brand_rights,
    product_identifier: input.certification.prepublication.product_identifier,
    condition: input.certification.prepublication.condition,
    expiration: input.certification.prepublication.expiration,
    item_spec: {
      feed_type: "MP_ITEM",
      version: specVersion,
      product_type: input.certification.walmart.product_type,
      retrieved_at: fetchedSpec.fetched_at,
      schema_sha256: fetchedSpec.schema_sha256,
      attributes_sha256: sha256WalmartJson(publicAttributes),
      required_attributes: ["sku", "productName", "brand", "price", "mainImageUrl"],
      missing_required_attributes: [],
      validation_status: "PASSED",
    },
  };
  const attributes = mergeWalmartListingContracts("{}", {
    productTruth: manifest,
    walmart: walmartContract,
    prepublication,
  });
  const provisionalSku = stagedSkuShape({
    id: channelSkuId,
    masterBundleId,
    sku: input.stage.proposed_sku,
    upc: input.stage.upc,
    upcPoolId: input.stage.upc_pool_id,
    title: candidate.content.title,
    bullets: candidate.content.bullets,
    description: candidate.content.description,
    attributes,
    priceCents: input.certification.price_cents,
    mainImageUrl: mainImage.url,
    countryOfOrigin:
      input.certification.walmart.country_of_origin_substantial_transformation,
    itemType: input.certification.walmart.product_type,
    physical: input.certification.physical_package,
  });
  const verifiedPhysical = parseVerifiedPhysicalPackageSpecs(JSON.stringify({
    verified_physical_package: input.certification.physical_package,
  }));
  if (!verifiedPhysical) throw new Error("Physical package proof failed runtime limits");
  const payload = buildWalmartPayload(provisionalSku, {
    brand: component.manufacturer_brand,
    packCount: candidate.pack_count,
    physicalPackageSpecs: verifiedPhysical,
    walmart: walmartContract,
  });
  const liveSpec = validateWalmartPayloadAgainstFetchedSpec({
    fetchedSpec,
    contract: walmartContract,
    payload,
  });
  if (!liveSpec.valid || liveSpec.schema_sha256 !== fetchedSpec.schema_sha256) {
    throw new Error(
      `Live Walmart item spec rejected the candidate: ${liveSpec.issues
        .map((issue) => `${issue.code}${issue.path ? ` ${issue.path}` : ""}: ${issue.message}`)
        .join("; ")}`,
    );
  }

  const unitPriceCents = Math.round(component.price_evidence.price_per_unit * 100);
  const goodsCents = unitPriceCents * component.qty;
  const exactDonorImages = stringArray(component.facts.attributes._exact_image_urls);
  const structuredAllergens = serializeProductTruthAllergenDeclaration(
    component.facts.allergens,
  );
  const packagingSpec = JSON.stringify({
    verified_physical_package: input.certification.physical_package,
    engine: "walmart-new-sku-engine",
    plan_sha256: input.plan.plan_sha256,
  });
  const internalSlug = `walmart-${input.plan.store_index}-${candidate.candidate_key}`;

  assertCurrentWalmartSellerAccountBinding(input.plan);
  await assertCurrentWalmartSellerCatalogAuthority({
    db: input.productTruthDb,
    authority: input.plan.seller_catalog_authority,
    now: new Date(),
  });
  await prisma.$transaction(async (tx) => {
    const existingSku = await tx.channelSKU.findUnique({
      where: { id: channelSkuId },
      select: { listing_status: true },
    });
    if (existingSku && !["PENDING", "FAILED"].includes(existingSku.listing_status)) {
      throw new Error(`Cannot recertify SKU in ${existingSku.listing_status} state`);
    }
    await tx.masterBundle.upsert({
      where: { id: masterBundleId },
      create: {
        id: masterBundleId,
        name: candidate.content.title,
        internal_slug: internalSlug,
        brand: component.manufacturer_brand,
        category: "SHELF_STABLE",
        composition_type: "SINGLE_FLAVOR",
        pack_count: candidate.pack_count,
        total_weight_oz: verifiedPhysical.weight_oz,
        total_weight_lb: verifiedPhysical.weight_oz / 16,
        cost_breakdown: JSON.stringify({
          goods_cents: goodsCents,
          packaging_cents: input.certification.packaging_cost_cents,
          fba_cents: 0,
          closing_cents: 0,
          shipping_label_cents: input.certification.shipping_label_cents,
          shipping_in_price: input.certification.shipping_in_price,
          sourcing_overhead_cents: 0,
        }),
        estimated_cost_cents: goodsCents,
        suggested_price_cents: input.certification.price_cents,
        packaging_spec: packagingSpec,
        main_image_url: mainImage.url,
        secondary_images: JSON.stringify(secondaryImages),
        image_generation_meta: JSON.stringify({
          source: "CERTIFIED_EXTERNAL_ASSET",
          rights_evidence: input.certification.images.map((image) => ({
            url: image.url,
            rights_basis: image.rights_basis,
            rights_evidence_ref: image.rights_evidence_ref,
          })),
        }),
        lifecycle_status: "GENERATED",
        generation_job_id: input.stage.generation_job_id,
      },
      update: {
        name: candidate.content.title,
        brand: component.manufacturer_brand,
        total_weight_oz: verifiedPhysical.weight_oz,
        total_weight_lb: verifiedPhysical.weight_oz / 16,
        cost_breakdown: JSON.stringify({
          goods_cents: goodsCents,
          packaging_cents: input.certification.packaging_cost_cents,
          fba_cents: 0,
          closing_cents: 0,
          shipping_label_cents: input.certification.shipping_label_cents,
          shipping_in_price: input.certification.shipping_in_price,
          sourcing_overhead_cents: 0,
        }),
        estimated_cost_cents: goodsCents,
        suggested_price_cents: input.certification.price_cents,
        packaging_spec: packagingSpec,
        main_image_url: mainImage.url,
        secondary_images: JSON.stringify(secondaryImages),
        lifecycle_status: "GENERATED",
      },
    });
    await tx.bundleComponent.upsert({
      where: { id: bundleComponentId },
      create: {
        id: bundleComponentId,
        master_bundle_id: masterBundleId,
        product_name: component.product_name,
        manufacturer_brand: component.manufacturer_brand,
        manufacturer_upc: component.manufacturer_upc,
        flavor: component.flavor,
        qty: component.qty,
        unit_price_cents: unitPriceCents,
        source_url: component.price_evidence.source_url,
        ingredients: component.facts.ingredients,
        allergens: structuredAllergens,
        storage_temp: "Shelf-stable",
        expiration_days: input.certification.prepublication.expiration.shelf_life_days,
        donor_image_urls: JSON.stringify(exactDonorImages),
      },
      update: {
        product_name: component.product_name,
        manufacturer_brand: component.manufacturer_brand,
        manufacturer_upc: component.manufacturer_upc,
        flavor: component.flavor,
        qty: component.qty,
        unit_price_cents: unitPriceCents,
        source_url: component.price_evidence.source_url,
        ingredients: component.facts.ingredients,
        allergens: structuredAllergens,
        storage_temp: "Shelf-stable",
        expiration_days: input.certification.prepublication.expiration.shelf_life_days,
        donor_image_urls: JSON.stringify(exactDonorImages),
      },
    });
    await tx.bundleDraft.update({
      where: { id: input.stage.bundle_draft_id },
      data: {
        draft_title: candidate.content.title,
        draft_bullets: JSON.stringify(candidate.content.bullets),
        draft_description: candidate.content.description,
        draft_main_image_url: mainImage.url,
        draft_secondary_images: JSON.stringify(secondaryImages),
        image_generated_at: now,
        draft_cost_cents: goodsCents,
        draft_suggested_price_cents: input.certification.price_cents,
        status: "IMAGE_GENERATED",
        compliance_status: "CAN_PUBLISH",
        master_bundle_id: masterBundleId,
      },
    });
    await tx.generatedContent.upsert({
      where: {
        bundle_draft_id_channel: {
          bundle_draft_id: input.stage.bundle_draft_id,
          channel: "WALMART",
        },
      },
      create: {
        bundle_draft_id: input.stage.bundle_draft_id,
        channel: "WALMART",
        template: "walmart-deterministic-product-truth",
        title: candidate.content.title,
        bullets_json: JSON.stringify(candidate.content.bullets),
        description: candidate.content.description,
        compliance_status: "CAN_PUBLISH",
        main_image_url: mainImage.url,
        image_generated_at: now,
      },
      update: {
        title: candidate.content.title,
        bullets_json: JSON.stringify(candidate.content.bullets),
        description: candidate.content.description,
        compliance_status: "CAN_PUBLISH",
        main_image_url: mainImage.url,
        image_generated_at: now,
      },
    });
    await tx.channelSKU.upsert({
      where: { id: channelSkuId },
      create: {
        id: channelSkuId,
        master_bundle_id: masterBundleId,
        channel: "WALMART",
        sku: input.stage.proposed_sku,
        upc: input.stage.upc,
        upc_pool_id: input.stage.upc_pool_id,
        title: candidate.content.title,
        bullets: JSON.stringify(candidate.content.bullets),
        description: candidate.content.description,
        attributes,
        channel_category: input.certification.walmart.product_type,
        price_cents: input.certification.price_cents,
        main_image_url: mainImage.url,
        compliance_status: "CAN_PUBLISH",
        lifecycle_status: "GENERATED",
        country_of_origin:
          input.certification.walmart.country_of_origin_substantial_transformation,
        item_type: input.certification.walmart.product_type,
        ...physicalPackageFields(verifiedPhysical),
      },
      update: {
        title: candidate.content.title,
        bullets: JSON.stringify(candidate.content.bullets),
        description: candidate.content.description,
        attributes,
        channel_category: input.certification.walmart.product_type,
        price_cents: input.certification.price_cents,
        main_image_url: mainImage.url,
        compliance_status: "CAN_PUBLISH",
        lifecycle_status: "GENERATED",
        validation_status: "PENDING",
        validation_errors: null,
        validated_at: null,
        validation_check_id: null,
        available_quantity: null,
        inventory_checked_at: null,
        country_of_origin:
          input.certification.walmart.country_of_origin_substantial_transformation,
        item_type: input.certification.walmart.product_type,
        ...physicalPackageFields(verifiedPhysical),
      },
    });
    await tx.uPCPool.update({
      where: { id: input.stage.upc_pool_id },
      data: {
        status: "ASSIGNED",
        assigned_to_id: channelSkuId,
        reserved_for_id: null,
        reserved_at: null,
        reserved_until: null,
      },
    });
  });

  await assertCurrentWalmartSellerCatalogAuthority({
    db: input.productTruthDb,
    authority: input.plan.seller_catalog_authority,
    now: new Date(),
  });
  const validation = await runValidationForDraft({
    bundle_draft_id: input.stage.bundle_draft_id,
    channels: ["WALMART"],
    actor,
  });
  const validatedSku = await prisma.channelSKU.findUniqueOrThrow({
    where: { id: channelSkuId },
  });
  const skuValidation = validation.per_sku.find((item) => item.sku_id === channelSkuId);
  if (
    !validation.ok ||
    skuValidation?.status !== "PASSED" ||
    validatedSku.validation_status !== "PASSED" ||
    (validatedSku.available_quantity ?? 0) < 1 ||
    !validatedSku.validated_at
  ) {
    throw new Error(
      `Certification validators did not pass: ${JSON.stringify(
        skuValidation ?? validation,
      )}`,
    );
  }
  const validationRunId = deterministicRuntimeId("wmvalidation", {
    channel_sku_id: channelSkuId,
    validated_at: validatedSku.validated_at.toISOString(),
    validation_errors: validatedSku.validation_errors,
  });
  await assertCurrentWalmartSellerCatalogAuthority({
    db: input.productTruthDb,
    authority: input.plan.seller_catalog_authority,
    now: new Date(),
  });
  await prisma.channelSKU.update({
    where: { id: channelSkuId },
    data: { validation_check_id: validationRunId },
  });
  await assertCurrentWalmartSellerCatalogAuthority({
    db: input.productTruthDb,
    authority: input.plan.seller_catalog_authority,
    now: new Date(),
  });
  const finalSku = { ...validatedSku, validation_check_id: validationRunId };
  const finalPayload = buildWalmartPayload(finalSku, {
    brand: component.manufacturer_brand,
    packCount: candidate.pack_count,
    physicalPackageSpecs: verifiedPhysical,
  });
  const initialHash = hashWalmartPayload(payload);
  const finalHash = hashWalmartPayload(finalPayload);
  if (initialHash !== finalHash) {
    throw new Error("Persisted Walmart payload drifted during certification");
  }

  const sourceReceipt: WalmartNewSkuCertificationSourceReceipt = {
    operator_evidence: verifiedOperatorEvidence,
    public_images: verifiedPublicImages,
    seller_sku_absence: {
      endpoint: sellerSkuAbsence.endpoint,
      sku: sellerSkuAbsence.sku,
      http_status: sellerSkuAbsence.http_status,
      correlation_id: sellerSkuAbsence.correlation_id,
      response_sha256: sellerSkuAbsence.response_sha256,
      response_body: sellerSkuResponse.body,
    },
    catalog_search: {
      endpoint: "/v3/items/walmart/search",
      query: { upc: input.stage.upc, responseFormat: "SPEC" },
      correlation_id: catalogResponse.correlationId,
      response_sha256: sha256WalmartJson(catalogResponse.body),
      response_body: catalogResponse.body,
    },
    item_spec: {
      endpoint: "/v3/items/spec",
      schema_sha256: fetchedSpec.schema_sha256,
      fetched_at: fetchedSpec.fetched_at,
      required_paths: fetchedSpec.required_paths,
      conditional_required_paths: fetchedSpec.conditional_required_paths,
      schema: fetchedSpec.schema,
    },
  };

  const artifact = sealWalmartNewSkuCertificationArtifact({
    schema_version: WALMART_NEW_SKU_CERTIFICATION_SCHEMA,
    wave_id: input.plan.wave_id,
    plan_sha256: input.plan.plan_sha256,
    stage_sha256: input.stage.stage_sha256,
    candidate_key: candidate.candidate_key,
    store_index: input.plan.store_index,
    seller_account_fingerprint_sha256:
      input.plan.seller_account_fingerprint_sha256,
    seller_catalog_authority: input.plan.seller_catalog_authority,
    bundle_draft_id: input.stage.bundle_draft_id,
    master_bundle_id: masterBundleId,
    channel_sku_id: channelSkuId,
    sku: input.stage.proposed_sku,
    upc: input.stage.upc,
    certified_at: now.toISOString(),
    certification_input_sha256:
      hashWalmartNewSkuCertificationInput(input.certification),
    validation_run_id: validationRunId,
    validation_status: "PASSED",
    payload_sha256: finalHash,
    product_truth_recipe_hash: manifest.recipe_hash,
    product_truth_binding: {
      donor_product_id: component.donor_product_id,
      canonical_variant_id: component.canonical_variant_id,
      content_observation_id: component.content_observation_id,
      price_observation_id: component.price_evidence.observation_id,
      qty: component.qty,
      zip: input.plan.zip,
      price_max_age_ms: candidate.recipe_input.price_max_age_ms,
      component_sha256: exactEvidenceFingerprint(component),
    },
    catalog_search_evidence_ref: catalogSearch.evidence_ref,
    seller_sku_absence_evidence_ref: sellerSkuAbsence.evidence_ref,
    seller_account_health_evidence_ref:
      input.certification.prepublication.seller_account_health.evidence_ref,
    seller_account_health_verified_at:
      input.certification.prepublication.seller_account_health.verified_at,
    fulfillment_compliance_evidence_ref:
      input.certification.prepublication.fulfillment_compliance.evidence_ref,
    fulfillment_compliance_verified_at:
      input.certification.prepublication.fulfillment_compliance.verified_at,
    item_spec_schema_sha256: fetchedSpec.schema_sha256,
    source_evidence_sha256: sha256WalmartJson(sourceReceipt),
    marketplace_mutation_allowed: false,
  });
  return {
    artifact,
    payload: finalPayload,
    validation,
    source_receipt: sourceReceipt,
  };
}

export interface DryRunCertifiedWalmartNewSkuResult {
  sku: string;
  channel_sku_id: string;
  payload: Record<string, unknown>;
  payload_sha256: string;
  validation: Awaited<ReturnType<typeof runValidation>>;
  schema_validation: NonNullable<
    Awaited<ReturnType<typeof validateWalmartPayloadAgainstLiveSpec>>
  >;
  offer_handoff: WalmartPublicListingContract["offer_handoff"];
}

export interface LocalCertifiedWalmartNewSkuReplay {
  sku: string;
  channel_sku_id: string;
  payload: Record<string, unknown>;
  payload_sha256: string;
  validation: Awaited<ReturnType<typeof runValidation>>;
  walmart_contract: WalmartPublicListingContract;
  offer_handoff: WalmartPublicListingContract["offer_handoff"];
}

/** Network-free deterministic replay used by approve/apply drift fences. */
export async function replayCertifiedWalmartNewSkuLocally(input: {
  certification: WalmartNewSkuCertificationArtifact;
}): Promise<LocalCertifiedWalmartNewSkuReplay> {
  assertWalmartNewSkuCertificationArtifactIntegrity(input.certification);
  assertCurrentWalmartSellerAccountBinding(input.certification);
  await assertWalmartPublishLifecycleSchema();
  const sku = await prisma.channelSKU.findUnique({
    where: { id: input.certification.channel_sku_id },
  });
  if (!sku) throw new Error("Certified ChannelSKU does not exist");
  if (
    sku.channel !== "WALMART" ||
    sku.sku !== input.certification.sku ||
    sku.upc !== input.certification.upc ||
    sku.master_bundle_id !== input.certification.master_bundle_id
  ) {
    throw new Error("Certified artifact identity differs from current ChannelSKU");
  }
  const currentAttributes = parseWalmartListingAttributes(sku.attributes);
  const currentStoreIndex =
    currentAttributes.product_truth_manifest?.listing_scope.store_index;
  if (currentStoreIndex !== input.certification.store_index) {
    throw new Error(
      "Certification store_index differs from current Product Truth listing scope",
    );
  }
  const walmartContract = currentAttributes.walmart;
  if (!walmartContract) {
    throw new Error("Certified ChannelSKU has no current Walmart public contract");
  }
  if (
    sku.validation_status !== "PASSED" ||
    sku.validation_check_id !== input.certification.validation_run_id
  ) {
    throw new Error("Persisted validation run differs from certification artifact");
  }
  const master = await prisma.masterBundle.findUnique({
    where: { id: input.certification.master_bundle_id },
    select: {
      brand: true,
      pack_count: true,
      packaging_spec: true,
    },
  });
  if (!master) throw new Error("Certified MasterBundle does not exist");
  const validation = await runValidation(sku, master.brand);
  if (!validation.can_publish || validation.status !== "PASSED") {
    throw new Error(
      `Read-only validation replay failed: ${JSON.stringify(validation.results.filter((row) => !row.passed))}`,
    );
  }
  const physical = parseVerifiedPhysicalPackageSpecs(master.packaging_spec);
  if (!physical) throw new Error("Verified physical package proof is missing");
  const result = await (await import("./distribution/walmart-publish")).submitToWalmart({
    sku,
    storeIndex: input.certification.store_index,
    brand: master.brand,
    packCount: master.pack_count,
    physicalPackageSpecs: physical,
    dryRun: true,
    validateLiveSpec: false,
  });
  if (
    !result.ok ||
    !result.dry_run ||
    !result.offer_handoff
  ) {
    throw new Error(
      `Walmart dry-run failed: ${result.error ?? JSON.stringify(result.issues)}`,
    );
  }
  const payloadHash = hashWalmartPayload(result.payload);
  if (payloadHash !== input.certification.payload_sha256) {
    throw new Error(
      `Current payload ${payloadHash} differs from certified ${input.certification.payload_sha256}`,
    );
  }
  return {
    sku: sku.sku,
    channel_sku_id: sku.id,
    payload: result.payload,
    payload_sha256: payloadHash,
    validation,
    walmart_contract: walmartContract,
    offer_handoff: result.offer_handoff,
  };
}

/** Read-only end-to-end replay with exactly one current Get Spec request. */
export async function dryRunCertifiedWalmartNewSku(input: {
  productTruthDb: Client;
  certification: WalmartNewSkuCertificationArtifact;
}): Promise<DryRunCertifiedWalmartNewSkuResult> {
  await assertCurrentWalmartSellerCatalogAuthority({
    db: input.productTruthDb,
    authority: input.certification.seller_catalog_authority,
  });
  const component = await assertCertifiedWalmartProductTruthStillCurrent({
    db: input.productTruthDb,
    certification: input.certification,
  });
  await assertWalmartExactIdentifierDuplicateGuardPlan({
    component,
  });
  const replay = await replayCertifiedWalmartNewSkuLocally(input);
  const client = getWalmartClient(input.certification.store_index);
  const schemaValidation = await validateWalmartPayloadAgainstLiveSpec({
    client,
    contract: replay.walmart_contract,
    payload: replay.payload,
  });
  if (!schemaValidation.valid || !schemaValidation.schema_sha256) {
    throw new Error(
      `Walmart dry-run Get Spec validation failed: ${schemaValidation.issues
        .map((issue) => `${issue.code}${issue.path ? ` ${issue.path}` : ""}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return {
    sku: replay.sku,
    channel_sku_id: replay.channel_sku_id,
    payload: replay.payload,
    payload_sha256: replay.payload_sha256,
    validation: replay.validation,
    schema_validation: schemaValidation,
    offer_handoff: replay.offer_handoff,
  };
}

/** Record/reconfirm the explicit owner gate after a fresh reviewed dry-run.
 * This mutates only internal approval state and performs no Walmart write. */
export async function approveCertifiedWalmartNewSku(input: {
  productTruthDb: Client;
  certification: WalmartNewSkuCertificationArtifact;
  certificationReceipt: WalmartNewSkuCertificationReceipt;
  dryRunReceipt: WalmartNewSkuDryRunReceipt;
  actor: string;
  note?: string;
  now?: Date;
}): Promise<WalmartNewSkuApprovalArtifact> {
  const now = input.now ?? new Date();
  const actor = input.actor.trim();
  if (!actor) throw new Error("Approval actor is required");
  assertCurrentWalmartSellerAccountBinding(input.certification);
  await assertCurrentWalmartSellerCatalogAuthority({
    db: input.productTruthDb,
    authority: input.certification.seller_catalog_authority,
    now,
  });
  assertWalmartNewSkuCertificationReceiptIntegrity(
    input.certificationReceipt,
    input.certification,
  );
  assertWalmartNewSkuDryRunReceiptIntegrity(
    input.dryRunReceipt,
    input.certification,
    now,
  );
  const component = await assertCertifiedWalmartProductTruthStillCurrent({
    db: input.productTruthDb,
    certification: input.certification,
    now,
  });
  await assertWalmartExactIdentifierDuplicateGuardPlan({
    component,
  });

  // Re-run every deterministic local gate at approval time. The fresh sealed
  // dry-run receipt carries the reviewed Get Spec result; another network call
  // here would consume the strict Get Spec budget without adding a new gate.
  const current = await replayCertifiedWalmartNewSkuLocally({
    certification: input.certification,
  });
  if (current.payload_sha256 !== input.certification.payload_sha256) {
    throw new Error("Walmart payload changed before approval");
  }
  assertCurrentWalmartSellerAccountBinding(input.certification);
  await assertCurrentWalmartSellerCatalogAuthority({
    db: input.productTruthDb,
    authority: input.certification.seller_catalog_authority,
    now: new Date(),
  });
  await approveDraftForDistribution({
    draftId: input.certification.bundle_draft_id,
    actor,
    note: input.note,
  });

  const [draft, sku] = await Promise.all([
    prisma.bundleDraft.findUniqueOrThrow({
      where: { id: input.certification.bundle_draft_id },
      select: { status: true, approved_at: true },
    }),
    prisma.channelSKU.findUniqueOrThrow({
      where: { id: input.certification.channel_sku_id },
    }),
  ]);
  if (!draft.approved_at || !["APPROVED", "PUBLISHING", "PUBLISHED", "ERROR"]
    .includes(draft.status)) {
    throw new Error("Draft approval was not persisted");
  }
  const distributionApproval = assertValidWalmartDistributionApproval(sku);
  if (
    distributionApproval.marketplace_payload_sha256 !==
      input.certification.payload_sha256 ||
    distributionApproval.validation_run_id !==
      input.certification.validation_run_id
  ) {
    throw new Error("Persisted distribution approval differs from certification");
  }
  return sealWalmartNewSkuApprovalArtifact({
    schema_version: "walmart-new-sku-approval/1.0.0",
    certification_sha256: input.certification.certification_sha256,
    certification_receipt_sha256: input.certificationReceipt.receipt_sha256,
    dry_run_receipt_sha256: input.dryRunReceipt.receipt_sha256,
    candidate_key: input.certification.candidate_key,
    bundle_draft_id: input.certification.bundle_draft_id,
    channel_sku_id: input.certification.channel_sku_id,
    sku: input.certification.sku,
    payload_sha256: input.certification.payload_sha256,
    validation_run_id: input.certification.validation_run_id,
    approved_at: now.toISOString(),
    approved_by: actor,
    distribution_approval: distributionApproval,
    live_apply_authorized: true,
    max_apply_skus: 1,
    marketplace_mutation_performed: false,
  }, input.certification, input.certificationReceipt, input.dryRunReceipt, now);
}

export interface ApplyCertifiedWalmartNewSkuResult {
  distribution: Awaited<ReturnType<typeof runWalmartPilotDistribution>>;
  latest_submission_attempt: {
    id: string;
    state: string;
    payload_hash: string;
    marketplace_submission_id: string | null;
    marketplace_disposition: string | null;
    created_at: string;
  } | null;
}

/** The only engine path that may invoke the Walmart feed POST. */
export async function applyCertifiedWalmartNewSku(input: {
  productTruthDb: Client;
  certification: WalmartNewSkuCertificationArtifact;
  certificationReceipt: WalmartNewSkuCertificationReceipt;
  dryRunReceipt: WalmartNewSkuDryRunReceipt;
  approval: WalmartNewSkuApprovalArtifact;
  actor: string;
  live: boolean;
  doctorReceipt?: WalmartNewSkuDoctorReceipt;
  applyPreviewReceipt?: WalmartNewSkuApplyReceipt;
  ownerPermit?: WalmartNewSkuOwnerPermit;
  currentDatabaseTargetFingerprint: string;
  engineReleaseSha256: string;
  now?: Date;
}): Promise<ApplyCertifiedWalmartNewSkuResult> {
  const now = input.now ?? new Date();
  const actor = input.actor.trim();
  if (!actor) throw new Error("Apply actor is required");
  if (input.live) {
    if (!input.doctorReceipt || !input.applyPreviewReceipt || !input.ownerPermit) {
      throw new Error(
        "Live apply requires fresh doctor, reviewed preview, and external owner permit",
      );
    }
    assertWalmartNewSkuDoctorReceiptIntegrity(input.doctorReceipt, now);
    if (
      input.doctorReceipt.store_index !== input.certification.store_index ||
      input.doctorReceipt.seller_account_fingerprint_sha256 !==
        input.certification.seller_account_fingerprint_sha256 ||
      input.doctorReceipt.database_target_fingerprint_sha256 !==
        input.currentDatabaseTargetFingerprint ||
      input.doctorReceipt.item_spec_version !== getConfiguredWalmartSpecVersion()
    ) {
      throw new Error("Doctor receipt does not bind the current seller/database/spec");
    }
    assertWalmartNewSkuOwnerPermitIntegrity(
      input.ownerPermit,
      input.certification,
      input.approval,
      input.doctorReceipt,
      input.applyPreviewReceipt,
      input.engineReleaseSha256,
      now,
    );
  }
  assertCurrentWalmartSellerAccountBinding(input.certification);
  assertWalmartNewSkuApprovalArtifactIntegrity(
    input.approval,
    input.certification,
    input.certificationReceipt,
    input.dryRunReceipt,
    now,
  );
  await assertWalmartPublishLifecycleSchema();
  const [draft, sku] = await Promise.all([
    prisma.bundleDraft.findUniqueOrThrow({
      where: { id: input.certification.bundle_draft_id },
      select: { id: true, master_bundle_id: true },
    }),
    prisma.channelSKU.findUniqueOrThrow({
      where: { id: input.certification.channel_sku_id },
    }),
  ]);
  if (
    !draft.master_bundle_id ||
    sku.master_bundle_id !== draft.master_bundle_id ||
    sku.sku !== input.certification.sku
  ) {
    throw new Error("Current draft/SKU identity differs from certification");
  }
  const currentApproval = assertValidWalmartDistributionApproval(sku);
  if (
    currentApproval.marketplace_payload_sha256 !==
      input.certification.payload_sha256 ||
    currentApproval.validation_run_id !== input.certification.validation_run_id
  ) {
    throw new Error("Current DB approval differs from approval artifact");
  }

  const currentAttempt = await prisma.marketplaceSubmissionAttempt.findFirst({
    where: {
      channel_sku_id: sku.id,
      marketplace: "WALMART",
    },
  });
  const listingCanBeClaimed = ["PENDING", "FAILED", "RETRYABLE"].includes(
    sku.listing_status,
  );
  const retryCanBeClaimed =
    !currentAttempt ||
    (currentAttempt.state === "RETRYABLE" &&
      (!currentAttempt.retry_after || currentAttempt.retry_after <= now));
  const canInitiateWalmartPost =
    input.live && listingCanBeClaimed && retryCanBeClaimed;
  const requiresPrepublicationCatalogAuthority =
    !input.live || canInitiateWalmartPost;
  if (canInitiateWalmartPost) {
    if (
      stableWalmartJson(input.doctorReceipt!.seller_catalog_authority) !==
        stableWalmartJson(input.certification.seller_catalog_authority)
    ) {
      throw new Error(
        "Doctor receipt catalog authority differs from the certified prepublication authority",
      );
    }
  }
  if (requiresPrepublicationCatalogAuthority) {
    await assertCurrentWalmartSellerCatalogAuthority({
      db: input.productTruthDb,
      authority: input.certification.seller_catalog_authority,
      now,
    });
  }

  // This network-free replay happens next to the distribution call. A live
  // apply performs one fresh Get Spec in submitToWalmart and rechecks approval
  // after its durable claim and directly before POST /feeds.
  const replay = await replayCertifiedWalmartNewSkuLocally({
    certification: input.certification,
  });
  if (replay.payload_sha256 !== input.approval.payload_sha256) {
    throw new Error("Current payload differs from approved payload");
  }

  const attemptedPilotRows =
    await prisma.$queryRaw<Array<{ value: bigint | number }>>`
      SELECT COUNT(DISTINCT "channel_sku_id") AS "value"
      FROM "MarketplaceSubmissionAttempt"
      WHERE "marketplace" = 'WALMART'
    `;
  const attemptedPilotSkus = Number(attemptedPilotRows[0]?.value ?? 0);
  if (input.live && !currentAttempt && attemptedPilotSkus >= 2) {
    throw new Error("Walmart pilot release already reached its global two-SKU apply cap");
  }

  const currentComponent = await assertCertifiedWalmartProductTruthStillCurrent({
    db: input.productTruthDb,
    certification: input.certification,
    now,
  });
  if (requiresPrepublicationCatalogAuthority) {
    await assertWalmartExactIdentifierDuplicateGuardPlan({
      component: currentComponent,
    });
  }
  if (canInitiateWalmartPost) {
    const catalogResponse = await getWalmartClient(
      input.certification.store_index,
    ).requestRaw("GET", "/items/walmart/search", {
      params: { upc: input.certification.upc, responseFormat: "SPEC" },
      noRetryOn429: true,
    });
    if (!catalogResponse.ok || catalogResponse.status !== 200) {
      throw new Error(
        `Fresh Walmart account/catalog probe failed with HTTP ${catalogResponse.status}`,
      );
    }
    certifyNoExactWalmartCatalogMatch({
      upc: input.certification.upc,
      responseBody: catalogResponse.body,
      searchedAt: now,
      correlationId: catalogResponse.correlationId,
      responseFormat: "SPEC",
    });
  }
  const currentImageUrls = [
    sku.main_image_url,
    ...replay.walmart_contract.secondary_image_urls,
  ];
  if (currentImageUrls.some((url) => !url)) {
    throw new Error("Certified Walmart payload has a missing public image URL");
  }
  assertCurrentWalmartSellerAccountBinding(input.certification);
  if (requiresPrepublicationCatalogAuthority) {
    await assertCurrentWalmartSellerCatalogAuthority({
      db: input.productTruthDb,
      authority: input.certification.seller_catalog_authority,
      now: new Date(),
    });
  }
  const distribution = await runWalmartPilotDistribution({
    bundle_draft_id: draft.id,
    apply: input.live,
    actor,
    beforeWalmartFeedPost: input.live
      ? async () => {
          try {
            assertCurrentWalmartSellerAccountBinding(input.certification);
            await assertWalmartExactIdentifierDuplicateGuardPlan({
              component: currentComponent,
            });
            const sellerSkuResponse = await getWalmartClient(
              input.certification.store_index,
            ).requestRaw(
              "GET",
              `/items/${encodeURIComponent(input.certification.sku)}`,
              { noRetryOn429: true },
            );
            certifyWalmartSellerSkuAbsent({
              sku: input.certification.sku,
              httpStatus: sellerSkuResponse.status,
              responseBody: sellerSkuResponse.body,
              checkedAt: new Date(),
              correlationId: sellerSkuResponse.correlationId,
            });
            await inspectWalmartPublicImageSet(currentImageUrls as string[]);
            // This is deliberately the final awaited catalog guard before the
            // synchronous permit fence and POST /feeds inside submitToWalmart.
            await assertCurrentWalmartSellerCatalogAuthority({
              db: input.productTruthDb,
              authority: input.certification.seller_catalog_authority,
              now: new Date(),
            });
          } catch (error) {
            throw new Error(
              `Walmart catalog authority preflight failed before POST: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
      : undefined,
    walmartPilotPermit: input.live
      ? {
          permitSha256: input.ownerPermit!.permit_sha256,
          permitId: input.ownerPermit!.signed_body.permit_id,
          ownerKeyId: input.ownerPermit!.key_id,
          ownerSignatureSha256: input.ownerPermit!.signature_sha256,
          signedPermit: input.ownerPermit!,
          engineReleaseSha256: input.engineReleaseSha256,
          pilotSlot: input.ownerPermit!.signed_body.pilot_slot,
          approvalSha256: input.ownerPermit!.signed_body.approval_sha256,
          certificationSha256:
            input.ownerPermit!.signed_body.certification_sha256,
          sellerAccountFingerprintSha256:
            input.ownerPermit!.signed_body.seller_account_fingerprint_sha256,
        }
      : undefined,
  });
  if (
    distribution.per_sku.some(
      (row) => row.sku_id !== sku.id || row.channel !== "WALMART",
    )
  ) {
    throw new Error("Distribution result escaped the certified Walmart SKU scope");
  }
  const latest = await prisma.marketplaceSubmissionAttempt.findFirst({
    where: { channel_sku_id: sku.id, marketplace: "WALMART" },
    orderBy: { created_at: "desc" },
  });
  const idempotentlyProtectedAcceptedSubmission = Boolean(
    input.live &&
    !distribution.ok &&
    latest?.marketplace_submission_id &&
    ["ACCEPTED", "PENDING_REVIEW", "BUYER_VERIFIED"].includes(latest.state),
  );
  const effectiveDistribution = idempotentlyProtectedAcceptedSubmission
    ? { ...distribution, ok: true }
    : distribution;
  return {
    distribution: effectiveDistribution,
    latest_submission_attempt: latest
      ? {
          id: latest.id,
          state: latest.state,
          payload_hash: latest.payload_hash,
          marketplace_submission_id: latest.marketplace_submission_id,
          marketplace_disposition: latest.marketplace_disposition,
          created_at: latest.created_at.toISOString(),
        }
      : null,
  };
}

export interface VerifyCertifiedWalmartNewSkuResult {
  poll_result: Awaited<ReturnType<typeof pollAndPersistWalmartSubmission>> | null;
  buyer_evidence_recorded: boolean;
  buyer_evidence_status: Awaited<
    ReturnType<typeof getWalmartBuyerPublicationEvidenceStatus>
  >;
  listing_status: string;
  lifecycle_status: string;
  submission_attempt_binding: WalmartCertifiedSubmissionAttemptBinding | null;
}

/** Read Walmart state and reconcile the local lifecycle. It never mutates
 * Walmart. Optional buyer evidence is validated and stored immutably first. */
export async function verifyCertifiedWalmartNewSku(input: {
  certification: WalmartNewSkuCertificationArtifact;
  buyerEvidence?: WalmartBuyerPublicationEvidenceInput;
}): Promise<VerifyCertifiedWalmartNewSkuResult> {
  assertWalmartNewSkuCertificationArtifactIntegrity(input.certification);
  assertCurrentWalmartSellerAccountBinding(input.certification);
  await assertWalmartPublishLifecycleSchema();
  const before = await prisma.channelSKU.findUniqueOrThrow({
    where: { id: input.certification.channel_sku_id },
  });
  if (
    before.channel !== "WALMART" ||
    before.sku !== input.certification.sku ||
    before.upc !== input.certification.upc
  ) {
    throw new Error("Verify target differs from certification artifact");
  }
  const pollable = [
    "SUBMITTED",
    "PENDING_REVIEW",
    "SUBMITTING",
    "SUBMISSION_UNKNOWN",
  ].includes(before.listing_status);
  const latestAttempt = await prisma.marketplaceSubmissionAttempt.findFirst({
    where: { channel_sku_id: before.id, marketplace: "WALMART" },
    orderBy: [{ created_at: "desc" }, { id: "desc" }],
    select: {
      id: true,
      channel_sku_id: true,
      marketplace: true,
      certification_sha256: true,
      payload_hash: true,
      seller_account_fingerprint_sha256: true,
      idempotency_key: true,
    },
  });
  const attemptBinding: WalmartCertifiedSubmissionAttemptBinding | null =
    latestAttempt
      ? {
          attemptId: latestAttempt.id,
          channelSkuId: before.id,
          certificationSha256: input.certification.certification_sha256,
          payloadSha256: input.certification.payload_sha256,
          sellerAccountFingerprintSha256:
            input.certification.seller_account_fingerprint_sha256,
          idempotencyKey: walmartSubmissionIdempotencyKey(
            before.id,
            input.certification.payload_sha256,
          ),
        }
      : null;
  if (attemptBinding) {
    assertWalmartCertifiedSubmissionAttemptBinding({
      expected: attemptBinding,
      attempt: latestAttempt,
    });
  } else if (input.buyerEvidence || pollable) {
    throw new Error(
      "Walmart durable submission attempt is missing for certified verification",
    );
  }
  let buyerEvidenceRecorded = false;
  if (input.buyerEvidence) {
    if (!attemptBinding) {
      throw new Error("Buyer evidence requires an exact certified attempt");
    }
    assertCurrentWalmartBuyerEvidenceTarget({
      evidence: input.buyerEvidence,
      channelSku: {
        id: before.id,
        sku: before.sku,
        walmartItemId: before.walmart_item_id,
      },
      latestSubmissionAttemptId: attemptBinding.attemptId,
    });
    assertCurrentWalmartSellerAccountBinding(input.certification);
    await recordWalmartBuyerPublicationEvidence(
      input.buyerEvidence,
      attemptBinding,
    );
    buyerEvidenceRecorded = true;
  }
  const pollResult = pollable
    ? await (async () => {
        if (!attemptBinding) {
          throw new Error("Walmart poll requires an exact certified attempt");
        }
        assertCurrentWalmartSellerAccountBinding(input.certification);
        return pollAndPersistWalmartSubmission(before.id, attemptBinding);
      })()
    : null;
  const [after, evidenceStatus] = await Promise.all([
    prisma.channelSKU.findUniqueOrThrow({ where: { id: before.id } }),
    getWalmartBuyerPublicationEvidenceStatus(
      before.id,
      attemptBinding?.attemptId,
    ),
  ]);
  if (
    attemptBinding &&
    (evidenceStatus.attempt_id !== attemptBinding.attemptId ||
      (pollResult?.submission_attempt_id != null &&
        pollResult.submission_attempt_id !== attemptBinding.attemptId))
  ) {
    throw new Error(
      "Walmart verify result escaped the exact certified submission attempt",
    );
  }
  return {
    poll_result: pollResult,
    buyer_evidence_recorded: buyerEvidenceRecorded,
    buyer_evidence_status: evidenceStatus,
    listing_status: after.listing_status,
    lifecycle_status: after.lifecycle_status,
    submission_attempt_binding: attemptBinding,
  };
}
