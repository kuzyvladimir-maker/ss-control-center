import type { Client } from "@libsql/client";

import {
  readTargetedWalmartDonorSnapshot,
  targetedWalmartDetailHarvestStateAbsent,
} from "@/lib/sourcing/product-truth-targeted-walmart-evidence";
import {
  ProductTruthWebControlAdmissionError,
  admitProductTruthWalmartCollectionBatch,
  readProductTruthWalmartCollectionStatus,
} from "@/lib/sourcing/product-truth-web-control-admission";
import type {
  ProductTruthWebControlRuntimeActive,
} from "@/lib/sourcing/product-truth-web-control-runtime";
import {
  buildProductTruthWalmartCollectionBatch,
} from "@/lib/sourcing/product-truth-walmart-collection-contract";
import type {
  ProductTruthWalmartRequestDiagnostic,
} from "@/lib/sourcing/product-truth-read-contract";
import type {
  WalmartShippingTemplateDetails,
} from "@/lib/bundle-factory/walmart-shipping-templates";

export const WALMART_DURABLE_BUILD_PREPARATION_WORKFLOW =
  "CANONICAL_WALMART_NEW_SKU_PREPARATION" as const;
export const WALMART_DURABLE_BUILD_PREPARATION_SCHEMA =
  "bundle-factory.walmart-build-preparation/1.0.0" as const;

export interface WalmartDurableBuildPreparationBrief {
  studio_version: 6;
  workflow: typeof WALMART_DURABLE_BUILD_PREPARATION_WORKFLOW;
  build_schema_version: typeof WALMART_DURABLE_BUILD_PREPARATION_SCHEMA;
  source: "prompt";
  prompt: string;
  channel: "WALMART";
  listing_count: number;
  pack_count: number;
  target_margin_pct: number;
  photo_strategy: "reuse-donor";
  walmart_shipping: {
    store_index: number;
    account_name: string;
    selected_at: string;
    template: WalmartShippingTemplateDetails;
  };
  product_truth_collection: {
    batch_id: string;
    requested_at: string;
    admitted_jobs: number;
    attempts: Array<{
      batch_id: string;
      requested_at: string;
      admitted_jobs: number;
      donor_product_ids: string[];
    }>;
  };
  operator_contract: {
    marketplace_mutation_authorized: false;
    upc_reservation_authorized: false;
    paid_execution_requires_exact_owner_click: true;
  };
}

export function rankWalmartDurableCollectionCandidates(
  diagnostic: ProductTruthWalmartRequestDiagnostic,
  excludedDonorProductIds: readonly string[] = [],
) {
  const excluded = new Set(excludedDonorProductIds);
  return diagnostic.candidates
    .filter((candidate) =>
      !candidate.ready && !excluded.has(candidate.donor_product_id),
    )
    .sort((left, right) => {
      const leftPriceOnly =
        left.missing.length === 1 && left.missing[0] === "FRESH_LOCAL_PRICE";
      const rightPriceOnly =
        right.missing.length === 1 && right.missing[0] === "FRESH_LOCAL_PRICE";
      if (leftPriceOnly !== rightPriceOnly) return leftPriceOnly ? -1 : 1;
      if (left.missing.length !== right.missing.length) {
        return left.missing.length - right.missing.length;
      }
      return right.match_score - left.match_score;
    });
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function integer(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    throw new Error(`${label} must be a whole number from 1 to ${maximum}`);
  }
  return Number(value);
}

export function parseWalmartDurableBuildPreparationBrief(
  value: unknown,
): WalmartDurableBuildPreparationBrief {
  const raw = record(value);
  if (
    !raw
    || raw.workflow !== WALMART_DURABLE_BUILD_PREPARATION_WORKFLOW
    || raw.build_schema_version !== WALMART_DURABLE_BUILD_PREPARATION_SCHEMA
    || raw.channel !== "WALMART"
    || raw.source !== "prompt"
    || raw.photo_strategy !== "reuse-donor"
  ) {
    throw new Error("GenerationJob is not a supported durable Walmart build");
  }
  const shipping = record(raw.walmart_shipping);
  const collection = record(raw.product_truth_collection);
  const operator = record(raw.operator_contract);
  const template = record(shipping?.template);
  if (!shipping || !collection || !operator || !template) {
    throw new Error("Durable Walmart build is missing a sealed section");
  }
  if (
    operator.marketplace_mutation_authorized !== false
    || operator.upc_reservation_authorized !== false
    || operator.paid_execution_requires_exact_owner_click !== true
  ) {
    throw new Error("Durable Walmart build authority changed");
  }
  const selectedAt = text(shipping.selected_at, "walmart_shipping.selected_at");
  const requestedAt = text(
    collection.requested_at,
    "product_truth_collection.requested_at",
  );
  if (
    !Array.isArray(collection.attempts)
    || collection.attempts.length < 1
    || collection.attempts.length > 5
  ) {
    throw new Error("Durable Walmart build must preserve its Product Truth attempts");
  }
  const attempts = collection.attempts.map((value, index) => {
    const attempt = record(value);
    if (!attempt || !Array.isArray(attempt.donor_product_ids)) {
      throw new Error(`product_truth_collection.attempts[${index}] is invalid`);
    }
    const attemptRequestedAt = text(
      attempt.requested_at,
      `product_truth_collection.attempts[${index}].requested_at`,
    );
    if (new Date(attemptRequestedAt).toISOString() !== attemptRequestedAt) {
      throw new Error("Durable Walmart build attempt timestamp is not canonical UTC");
    }
    const donorProductIds = attempt.donor_product_ids.map((entry, donorIndex) =>
      text(
        entry,
        `product_truth_collection.attempts[${index}].donor_product_ids[${donorIndex}]`,
      ),
    );
    if (donorProductIds.length < 1 || new Set(donorProductIds).size !== donorProductIds.length) {
      throw new Error("Durable Walmart build attempt donor identities are invalid");
    }
    const batchId = text(
        attempt.batch_id,
        `product_truth_collection.attempts[${index}].batch_id`,
      );
    if (!/^ptbfw-[a-f0-9]{24}$/u.test(batchId)) {
      throw new Error("Durable Walmart build attempt batch ID is invalid");
    }
    return {
      batch_id: batchId,
      requested_at: attemptRequestedAt,
      admitted_jobs: integer(
        attempt.admitted_jobs,
        `product_truth_collection.attempts[${index}].admitted_jobs`,
        5,
      ),
      donor_product_ids: donorProductIds,
    };
  });
  if (
    new Date(selectedAt).toISOString() !== selectedAt
    || new Date(requestedAt).toISOString() !== requestedAt
  ) {
    throw new Error("Durable Walmart build timestamps are not canonical UTC");
  }
  const currentBatchId = text(collection.batch_id, "batch_id");
  const currentAttempt = attempts.at(-1);
  if (
    !currentAttempt
    || currentAttempt.batch_id !== currentBatchId
    || currentAttempt.requested_at !== requestedAt
    || currentAttempt.admitted_jobs !== collection.admitted_jobs
    // Every attempt is its own immutable batch. Attempts may legitimately
    // target the SAME donors: after an attempt with an unknown paid outcome
    // the owner explicitly retries those exact products. Cross-attempt donor
    // uniqueness was therefore the wrong invariant — paying twice for one
    // product is prevented by the doctor harvest-state gate, which refuses a
    // donor that already owns a detail-harvest lifecycle.
    || new Set(attempts.map((attempt) => attempt.batch_id)).size !== attempts.length
  ) {
    throw new Error("Durable Walmart build current Product Truth attempt drifted");
  }
  const targetMarginPct = Number(raw.target_margin_pct);
  if (
    !Number.isFinite(targetMarginPct)
    || targetMarginPct <= 0
    || targetMarginPct > 50
  ) {
    throw new Error("target_margin_pct must be between 0 and 50");
  }
  return {
    studio_version: 6,
    workflow: WALMART_DURABLE_BUILD_PREPARATION_WORKFLOW,
    build_schema_version: WALMART_DURABLE_BUILD_PREPARATION_SCHEMA,
    source: "prompt",
    prompt: text(raw.prompt, "prompt"),
    channel: "WALMART",
    listing_count: integer(raw.listing_count, "listing_count", 500),
    pack_count: integer(raw.pack_count, "pack_count", 500),
    target_margin_pct: targetMarginPct,
    photo_strategy: "reuse-donor",
    walmart_shipping: {
      store_index: integer(shipping.store_index, "store_index", 5),
      account_name: text(shipping.account_name, "account_name"),
      selected_at: selectedAt,
      template: template as unknown as WalmartShippingTemplateDetails,
    },
    product_truth_collection: {
      batch_id: currentBatchId,
      requested_at: requestedAt,
      admitted_jobs: integer(collection.admitted_jobs, "admitted_jobs", 5),
      attempts,
    },
    operator_contract: {
      marketplace_mutation_authorized: false,
      upc_reservation_authorized: false,
      paid_execution_requires_exact_owner_click: true,
    },
  };
}

export interface WalmartDurableBuildRequestDetail {
  matched_variants: number;
  ready_variants: number;
  requested_listings: number;
  missing_needed: number;
}

/**
 * A build request the catalogue cannot serve — not a server fault.
 *
 * The API layer turns this into a 422 that names what was found and what to do
 * next, instead of the generic 500 the previous bare Error produced.
 */
export class WalmartDurableBuildRequestError extends Error {
  readonly code: "NO_EXACT_MATCHES" | "NO_COLLECTIBLE_CANDIDATES";
  readonly detail: WalmartDurableBuildRequestDetail;

  constructor(
    code: "NO_EXACT_MATCHES" | "NO_COLLECTIBLE_CANDIDATES",
    detail: WalmartDurableBuildRequestDetail,
  ) {
    super(
      code === "NO_EXACT_MATCHES"
        ? "The donor catalogue has no exact product matching this request."
        : "Every matching product has already been through targeted collection.",
    );
    this.name = "WalmartDurableBuildRequestError";
    this.code = code;
    this.detail = detail;
  }
}

export async function prepareWalmartDurableBuildCollection(input: {
  db: Client;
  diagnostic: ProductTruthWalmartRequestDiagnostic;
  runtime: ProductTruthWebControlRuntimeActive;
  requestedByUserId: string;
  requestedAt: string;
  prompt: string;
  listingCount: number;
  packCount: number;
  /**
   * Different products per listing. A mixed assortment consumes this many
   * distinct variants per listing, so the readiness gate below must ask for
   * that many times more of them — comparing ready variants against the
   * listing count alone declared "nothing missing" while the build was
   * genuinely short, and the request died as NO_COLLECTIBLE_CANDIDATES.
   */
  flavorsPerListing?: number;
  excludedDonorProductIds?: readonly string[];
  /**
   * 1-based ordinal of this collection attempt inside the durable build.
   * Attempts after the first get their own batch identity so a fresh
   * owner-approved quote can never collide with or inherit authority from an
   * earlier attempt's immutable paid lifecycle.
   */
  attempt?: number;
}) {
  const variantsPerListing = Math.max(1, Math.trunc(input.flavorsPerListing ?? 1));
  const missingNeeded = Math.max(
    0,
    input.listingCount * variantsPerListing - input.diagnostic.ready_variants,
  );
  const rankedCandidates = rankWalmartDurableCollectionCandidates(
    input.diagnostic,
    input.excludedDonorProductIds,
  );
  const candidates = [];
  for (const candidate of rankedCandidates) {
    if (candidate.ready || candidates.length >= Math.min(5, missingNeeded)) {
      continue;
    }
    try {
      const snapshot = await readTargetedWalmartDonorSnapshot(
        input.db,
        candidate.donor_product_id,
      );
      if (!await targetedWalmartDetailHarvestStateAbsent(
        input.db,
        snapshot.donorProductId,
        snapshot.retailerProductId,
      )) {
        continue;
      }
    } catch {
      continue;
    }
    candidates.push({
      donorProductId: candidate.donor_product_id,
      canonicalVariantId: candidate.canonical_variant_id,
      title: candidate.title,
      query: candidate.title,
      missingFields: candidate.missing,
    });
  }
  if (candidates.length < 1) {
    // Two very different situations reach this line and the operator has to be
    // able to tell them apart: the catalogue does not know this product at
    // all, or it knows it but every match has already been through the
    // targeted collector. Throwing one bare Error turned both into a browser
    // page reading "Internal server error", which says nothing and suggests
    // nothing.
    throw new WalmartDurableBuildRequestError(
      input.diagnostic.matched_variants === 0
        ? "NO_EXACT_MATCHES"
        : "NO_COLLECTIBLE_CANDIDATES",
      {
        matched_variants: input.diagnostic.matched_variants,
        ready_variants: input.diagnostic.ready_variants,
        requested_listings: input.listingCount,
        missing_needed: missingNeeded,
      },
    );
  }
  const batch = buildProductTruthWalmartCollectionBatch({
    requestedByUserId: input.requestedByUserId,
    requestedAt: input.requestedAt,
    prompt: input.prompt,
    listingCount: input.listingCount,
    packCount: input.packCount,
    unwrangleReserveFloor: input.runtime.unwrangleReserveFloor,
    candidates,
    ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
  });
  let status;
  try {
    status = await readProductTruthWalmartCollectionStatus({
      batchId: batch.batchId,
      requestedByUserId: input.requestedByUserId,
      runtime: input.runtime,
    });
  } catch (error) {
    if (
      !(error instanceof ProductTruthWebControlAdmissionError)
      || error.code !== "WEB_CONTROL_BATCH_NOT_FOUND"
    ) {
      throw error;
    }
    status = await admitProductTruthWalmartCollectionBatch({
      batch,
      runtime: input.runtime,
    });
  }
  if (status.status === "FAILED") {
    // Same retry semantics as the data-collection route: failed no-spend
    // preparation re-admits idempotently (fresh attempt rows only when the
    // engine release changed). AMBIGUOUS never re-runs implicitly.
    status = await admitProductTruthWalmartCollectionBatch({
      batch,
      runtime: input.runtime,
    });
  }
  return { batch, status };
}
