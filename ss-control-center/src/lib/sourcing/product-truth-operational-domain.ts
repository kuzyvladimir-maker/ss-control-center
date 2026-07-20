import type { Client } from "@libsql/client";

import type { CostResult } from "./cogs-engine";
import {
  DONOR_HARVEST_BOOTSTRAP_FIELDS,
  planDonorHarvestSeed,
  type DonorHarvestSeedPlan,
  type HarvestSeedDonorSnapshot,
  type HarvestSeedOfferSnapshot,
} from "./donor-harvest-seed-plan";
import type {
  ProductTruthOperationalField,
  ProductTruthSourcePolicy,
} from "./product-truth-operational-run-contract";
import type { ProductTruthSnapshot } from "./product-truth-read-contract";
import {
  donorHarvestStateId,
  getDonorHarvestState,
  persistDonorHarvestTransition,
  seedDonorHarvestState,
} from "./donor-harvest-store";
import { isDonorHarvestTerminal } from "./donor-harvest-lifecycle";
import {
  executeDonorHarvestCandidate,
  type ExecuteDonorHarvestCandidateResult,
} from "./donor-harvest-executor";

export const PRODUCT_TRUTH_OPERATIONAL_DOMAIN_VERSION =
  "product-truth-operational-domain/1.0.0" as const;

export interface ProductTruthDonorContentInspection {
  donorProductId: string;
  plan: DonorHarvestSeedPlan;
  fullContentComplete: boolean;
  missingFields: string[];
}

export interface ProductTruthDonorHarvestOutcome {
  donorProductId: string;
  disposition:
    | "already_complete"
    | "source_unavailable"
    | "existing_terminal"
    | "executed"
    | "state_conflict"
    | "blocked";
  source: string | null;
  stateId: string | null;
  stateStatus: string | null;
  reason: string;
  execution: ExecuteDonorHarvestCandidateResult | null;
}

export interface ProductTruthOperationalTruthAssessment {
  schemaVersion: typeof PRODUCT_TRUTH_OPERATIONAL_DOMAIN_VERSION;
  outcome: "FACT" | "ESTIMATE" | "UNSOURCEABLE" | "INCOMPLETE";
  complete: boolean;
  completedFields: ProductTruthOperationalField[];
  unavailableFields: ProductTruthOperationalField[];
  donorProductIds: string[];
  blockers: string[];
  consumers: {
    bundleFactoryReady: boolean;
    listingImprovementReady: boolean;
    unitEconomicsStatus: string;
    procurementReady: boolean;
  };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en-US"));
}

function donorIdsFromCost(cost: CostResult | null | undefined): string[] {
  if (!Array.isArray(cost?.parts)) return [];
  return unique(cost.parts.flatMap((part: unknown) => {
    if (!part || typeof part !== "object") return [];
    const value = (part as { contentDonorProductId?: unknown }).contentDonorProductId;
    return typeof value === "string" && value.trim() ? [value.trim()] : [];
  }));
}

export function productTruthDonorIds(
  snapshot: ProductTruthSnapshot,
  cost?: CostResult | null,
): string[] {
  const fromSnapshot = snapshot.recipe.components.flatMap((component) => {
    const value = component.content?.provenance.donorProductId;
    return typeof value === "string" && value.trim() ? [value.trim()] : [];
  });
  return unique([...fromSnapshot, ...donorIdsFromCost(cost)]);
}

function normalizedRetailer(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const compact = value.toLowerCase().replace(/[’']/g, "").replace(/[\s_-]+/g, "").trim();
  if (compact === "sams" || compact === "samsclub") return "samsclub";
  return ["walmart", "target", "publix", "costco"].includes(compact) ? compact : null;
}

function valueOrNull(value: unknown): unknown {
  return value == null ? null : value;
}

/** Load one exact donor plus direct offers, filtered by the sealed retailer policy. */
export async function loadProductTruthDonorHarvestSnapshot(
  db: Client,
  donorProductId: string,
  sourcePolicy: ProductTruthSourcePolicy,
): Promise<HarvestSeedDonorSnapshot> {
  const id = donorProductId.trim();
  if (!id) throw new TypeError("donorProductId is required");
  const result = await db.execute({
    sql: `SELECT product.id AS donorProductId, product.identityStatus,
                 product.title, product.description, product.bullets,
                 product.attributes, product.nutritionFacts, product.ingredients,
                 product.mainImageUrl, product.imageUrls, product.upc, product.gtin,
                 offer.id AS offerId, offer.retailer, offer.retailerProductId,
                 offer.productUrl, offer.via, offer.isFirstParty
          FROM "DonorProduct" product
          LEFT JOIN "DonorOffer" offer ON offer.donorProductId=product.id
          WHERE product.id=?
          ORDER BY offer.retailer, offer.retailerProductId, offer.id`,
    args: [id],
  });
  if (!result.rows.length) throw new Error(`DONOR_PRODUCT_NOT_FOUND:${id}`);
  const first = result.rows[0];
  const allowed = new Set(sourcePolicy.retailers);
  const offers: HarvestSeedOfferSnapshot[] = [];
  for (const row of result.rows) {
    if (row.offerId == null) continue;
    const retailer = normalizedRetailer(row.retailer);
    if (
      !retailer
      || !allowed.has(retailer as ProductTruthSourcePolicy["retailers"][number])
      || Number(row.isFirstParty) !== 1
    ) continue;
    offers.push({
      retailer,
      retailerProductId: valueOrNull(row.retailerProductId),
      productUrl: valueOrNull(row.productUrl),
      via: valueOrNull(row.via),
      exactDonorLink: row.identityStatus === "exact_confirmed",
    });
  }
  return {
    id,
    title: valueOrNull(first.title),
    description: valueOrNull(first.description),
    bullets: valueOrNull(first.bullets),
    attributes: valueOrNull(first.attributes),
    nutritionFacts: valueOrNull(first.nutritionFacts),
    ingredients: valueOrNull(first.ingredients),
    mainImageUrl: valueOrNull(first.mainImageUrl),
    imageUrls: valueOrNull(first.imageUrls),
    upc: valueOrNull(first.upc),
    gtin: valueOrNull(first.gtin),
    offers,
  };
}

export async function inspectProductTruthDonorContent(
  db: Client,
  input: {
    donorProductIds: readonly string[];
    sourcePolicy: ProductTruthSourcePolicy;
    minGalleryImages: 5;
  },
): Promise<ProductTruthDonorContentInspection[]> {
  const inspections: ProductTruthDonorContentInspection[] = [];
  for (const donorProductId of unique(input.donorProductIds)) {
    const donor = await loadProductTruthDonorHarvestSnapshot(db, donorProductId, input.sourcePolicy);
    const plan = planDonorHarvestSeed(donor, {
      useBluecartWalmart: false,
      minGalleryImages: input.minGalleryImages,
      maxAttempts: 1,
    });
    const complete = new Set(plan.completedFields);
    const missingFields = DONOR_HARVEST_BOOTSTRAP_FIELDS.filter((field) => !complete.has(field));
    inspections.push({
      donorProductId,
      plan,
      fullContentComplete: missingFields.length === 0,
      missingFields,
    });
  }
  return inspections;
}

function eventInstant(now: string, previous: string): string {
  const at = Date.parse(now);
  const last = Date.parse(previous);
  if (!Number.isFinite(at) || !Number.isFinite(last)) throw new TypeError("invalid harvest event timestamp");
  return new Date(Math.max(at, last)).toISOString();
}

/**
 * Execute at most one paid detail attempt for each exact donor, sequentially.
 * Existing terminal rows and seed-intent conflicts are evidence, not permission
 * to reopen or create a second paid attempt.
 */
export async function executeProductTruthDonorHarvests(
  db: Client,
  input: {
    inspections: readonly ProductTruthDonorContentInspection[];
    runId: string;
    approvalId: string;
    leaseOwner: string;
    now: () => string;
  },
): Promise<ProductTruthDonorHarvestOutcome[]> {
  const outcomes: ProductTruthDonorHarvestOutcome[] = [];
  for (const inspection of input.inspections) {
    const plan = inspection.plan;
    if (inspection.fullContentComplete || plan.disposition === "already_complete") {
      outcomes.push({
        donorProductId: inspection.donorProductId,
        disposition: "already_complete",
        source: plan.source,
        stateId: null,
        stateStatus: null,
        reason: "FULL_CONTENT_ALREADY_PRESENT",
        execution: null,
      });
      continue;
    }
    if (!plan.source || !plan.retailerProductId) {
      outcomes.push({
        donorProductId: inspection.donorProductId,
        disposition: "source_unavailable",
        source: null,
        stateId: null,
        stateStatus: null,
        reason: plan.disposition === "no_exact_offer_url"
          ? "NO_EXACT_FIRST_PARTY_DIRECT_OFFER"
          : "HARVEST_SOURCE_UNAVAILABLE",
        execution: null,
      });
      continue;
    }

    const identity = {
      donorProductId: inspection.donorProductId,
      source: plan.source,
      retailerProductId: plan.retailerProductId,
    };
    const stateId = donorHarvestStateId(identity);
    let state = await getDonorHarvestState(db, stateId);
    if (!state) {
      try {
        state = (await seedDonorHarvestState(db, {
          ...identity,
          requestedFields: plan.requestedFields,
          maxAttempts: 1,
          now: input.now(),
        })).state;
      } catch (error) {
        outcomes.push({
          donorProductId: inspection.donorProductId,
          disposition: "state_conflict",
          source: plan.source,
          stateId,
          stateStatus: null,
          reason: error instanceof Error ? error.message.slice(0, 500) : "HARVEST_STATE_CONFLICT",
          execution: null,
        });
        continue;
      }
    }

    if (plan.disposition === "terminal_source_unavailable") {
      if (!isDonorHarvestTerminal(state.status)) {
        const terminal = await persistDonorHarvestTransition(db, state, {
          type: "source_unavailable",
          at: eventInstant(input.now(), state.updatedAt),
          reason: plan.terminalReason || "SOURCE_CAPABILITY_UNAVAILABLE",
        });
        if (terminal) state = terminal;
      }
      outcomes.push({
        donorProductId: inspection.donorProductId,
        disposition: "source_unavailable",
        source: plan.source,
        stateId: state.id,
        stateStatus: state.status,
        reason: plan.terminalReason || "SOURCE_CAPABILITY_UNAVAILABLE",
        execution: null,
      });
      continue;
    }

    if (isDonorHarvestTerminal(state.status)) {
      outcomes.push({
        donorProductId: inspection.donorProductId,
        disposition: "existing_terminal",
        source: plan.source,
        stateId: state.id,
        stateStatus: state.status,
        reason: state.terminalReason || state.status,
        execution: null,
      });
      continue;
    }
    if (state.attempts > 0 || state.status === "running") {
      outcomes.push({
        donorProductId: inspection.donorProductId,
        disposition: "blocked",
        source: plan.source,
        stateId: state.id,
        stateStatus: state.status,
        reason: "AUTOMATIC_METERED_REPLAY_FORBIDDEN",
        execution: null,
      });
      continue;
    }

    const execution = await executeDonorHarvestCandidate({
      db,
      candidate: state,
      runId: input.runId,
      approvalId: input.approvalId,
      leaseOwner: input.leaseOwner,
      now: input.now,
    });
    outcomes.push({
      donorProductId: inspection.donorProductId,
      disposition: execution.disposition === "blocked" ? "blocked" : "executed",
      source: plan.source,
      stateId: execution.state?.id ?? state.id,
      stateStatus: execution.state?.status ?? null,
      reason: execution.reason,
      execution,
    });
  }
  return outcomes;
}

export function assessProductTruthOperationalSnapshot(input: {
  snapshot: ProductTruthSnapshot;
  donorInspections: readonly ProductTruthDonorContentInspection[];
  cost?: CostResult | null;
}): ProductTruthOperationalTruthAssessment {
  const { snapshot } = input;
  const donorProductIds = productTruthDonorIds(snapshot, input.cost);
  const inspections = new Map(input.donorInspections.map((item) => [item.donorProductId, item]));
  const blockers: string[] = [];

  const identityComplete = snapshot.recipe.components.length > 0
    && snapshot.recipe.blockers.length === 0;
  if (!identityComplete) blockers.push(...snapshot.recipe.blockers, "IDENTITY_RECIPE_INCOMPLETE");

  const componentOffers = snapshot.views.procurement.components;
  const offersComplete = componentOffers.length > 0 && componentOffers.every((component) => (
    component.factualOptions.length > 0 || component.estimateOptions.length > 0
  ));
  if (!offersComplete) blockers.push(...snapshot.views.procurement.blockers, "RETAILER_OFFERS_INCOMPLETE");

  const contentComplete = donorProductIds.length > 0
    && snapshot.recipe.components.every((component) => !!component.content)
    && donorProductIds.every((id) => inspections.get(id)?.fullContentComplete === true);
  if (!contentComplete) {
    blockers.push(...snapshot.views.listingImprovement.blockers);
    for (const donorProductId of donorProductIds) {
      const inspection = inspections.get(donorProductId);
      if (!inspection) blockers.push(`DONOR_${donorProductId}:CONTENT_NOT_INSPECTED`);
      else blockers.push(...inspection.missingFields.map((field) => (
        `DONOR_${donorProductId}:MISSING_${field.toUpperCase()}`
      )));
    }
    if (!donorProductIds.length) blockers.push("CONTENT_DONOR_MISSING");
  }

  const economicsStatus = snapshot.views.unitEconomics.status;
  const cogsComplete = economicsStatus === "FACT"
    || economicsStatus === "ESTIMATE"
    || economicsStatus === "UNSOURCEABLE";
  if (!cogsComplete) blockers.push(...snapshot.views.unitEconomics.blockers, "COGS_INCOMPLETE");

  const completedFields: ProductTruthOperationalField[] = [];
  if (identityComplete) completedFields.push("identity");
  if (offersComplete) completedFields.push("offers");
  if (contentComplete) completedFields.push("content");
  if (cogsComplete) completedFields.push("cogs");
  const unavailableFields = (["identity", "offers", "content", "cogs"] as const)
    .filter((field) => !completedFields.includes(field));
  const outcome = economicsStatus === "FACT"
    ? "FACT"
    : economicsStatus === "ESTIMATE"
      ? "ESTIMATE"
      : economicsStatus === "UNSOURCEABLE"
        ? "UNSOURCEABLE"
        : "INCOMPLETE";
  return {
    schemaVersion: PRODUCT_TRUTH_OPERATIONAL_DOMAIN_VERSION,
    outcome,
    complete: unavailableFields.length === 0,
    completedFields,
    unavailableFields,
    donorProductIds,
    blockers: unique(blockers.filter(Boolean)),
    consumers: {
      bundleFactoryReady: snapshot.views.bundleFactory.ready,
      listingImprovementReady: snapshot.views.listingImprovement.ready,
      unitEconomicsStatus: economicsStatus,
      procurementReady: snapshot.views.procurement.ready,
    },
  };
}
