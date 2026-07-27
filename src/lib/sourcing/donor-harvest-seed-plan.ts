/**
 * Pure, network-free planner for bootstrapping DonorHarvestState from the
 * current DonorProduct/DonorOffer snapshot.
 *
 * A plan contains at most one concrete source identity per donor. It never
 * treats a price proxy as content identity: callers must set exactDonorLink
 * only for an offer that is attached to this exact DonorProduct variant.
 */

import {
  completedHarvestFieldsFromDonorProduct,
  type DonorProductHarvestSnapshot,
} from "./donor-harvest-store";
import { normalizeDonorHarvestFields } from "./donor-harvest-lifecycle";

export const DONOR_HARVEST_BOOTSTRAP_FIELDS = normalizeDonorHarvestFields([
  "gallery",
  "title",
  "description",
  "bullets",
  "attributes",
  "ingredients",
  "nutrition",
  "upc",
]);

/**
 * Operational evidence from the stopped legacy cron: these fields remain
 * absent on the Target-only rows that caused the endless paid loop. A Target
 * row is terminalized without dispatch only when *all* of its remaining gaps
 * are in this set. Gallery/title gaps still justify one bounded detail attempt.
 */
export const TARGET_STRUCTURALLY_UNAVAILABLE_FIELDS = normalizeDonorHarvestFields([
  "description",
  "bullets",
  "attributes",
  "ingredients",
  "nutrition",
  "upc",
]);

export const TARGET_ONLY_TERMINAL_REASON = "TARGET_ONLY_REMAINING_FIELDS_STRUCTURALLY_UNAVAILABLE";

export type HarvestableRetailer = "walmart" | "target" | "samsclub" | "costco";
export type HarvestSeedSource =
  | `unwrangle:${HarvestableRetailer}`
  | "bluecart:walmart";

export interface HarvestSeedOfferSnapshot {
  retailer: unknown;
  retailerProductId: unknown;
  productUrl: unknown;
  via?: unknown;
  /** True only when this offer belongs to the exact DonorProduct variant. */
  exactDonorLink: boolean;
}

export interface HarvestSeedDonorSnapshot extends DonorProductHarvestSnapshot {
  id: string;
  offers: readonly HarvestSeedOfferSnapshot[];
}

export interface DonorHarvestSeedPlanOptions {
  /** Explicit opt-in replacement for unwrangle:walmart. Defaults to false. */
  useBluecartWalmart?: boolean;
  minGalleryImages?: number;
  maxAttempts?: number;
}

export type DonorHarvestSeedDisposition =
  | "already_complete"
  | "no_exact_offer_url"
  | "queue"
  | "terminal_source_unavailable";

export interface DonorHarvestSeedPlan {
  donorProductId: string;
  disposition: DonorHarvestSeedDisposition;
  completedFields: readonly string[];
  requestedFields: readonly string[];
  source: HarvestSeedSource | null;
  retailer: HarvestableRetailer | null;
  retailerProductId: string | null;
  productUrl: string | null;
  targetOnly: boolean;
  terminalReason: string | null;
  maxAttempts: number;
  estimatedCallsFirstAttempt: number;
  estimatedUnitsFirstAttempt: number;
  maximumCallsAtAttemptCap: number;
  maximumUnitsAtAttemptCap: number;
}

interface ExactOffer {
  retailer: HarvestableRetailer;
  retailerProductId: string;
  productUrl: string;
}

const RETAILER_PREFERENCE: Record<HarvestableRetailer, number> = {
  walmart: 0,
  target: 1,
  samsclub: 2,
  costco: 3,
};

// Conservative budget units. Target uses the 2.5-unit observed operational
// cost (rather than an older 1-unit capability note); clubs remain isolated at
// their documented 10-unit detail cost. This is a forecast, never a permit.
const UNITS_PER_ATTEMPT: Record<HarvestSeedSource, number> = {
  "unwrangle:walmart": 2.5,
  "unwrangle:target": 2.5,
  "unwrangle:samsclub": 10,
  "unwrangle:costco": 10,
  "bluecart:walmart": 1,
};

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} is required`);
  }
  return value.trim();
}

function canonicalRetailer(value: unknown): HarvestableRetailer | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[’']/g, "")
    .replace(/[\s_-]+/g, "");
  if (normalized === "walmart") return "walmart";
  if (normalized === "target") return "target";
  if (normalized === "sams" || normalized === "samsclub") return "samsclub";
  if (normalized === "costco") return "costco";
  return null;
}

function exactHttpUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    if ((parsed.protocol !== "https:" && parsed.protocol !== "http:") || !parsed.hostname) return null;
    if (parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function isDirect(via: unknown): boolean {
  // DonorOffer has a database default of direct. A null/empty legacy value is
  // accepted as that default; an explicit Instacart/other intermediary is not.
  if (via == null || String(via).trim() === "") return true;
  return String(via).trim().toLocaleLowerCase("en-US") === "direct";
}

function exactOffers(offers: readonly HarvestSeedOfferSnapshot[]): ExactOffer[] {
  const deduped = new Map<string, ExactOffer>();
  for (const offer of offers) {
    if (offer.exactDonorLink !== true || !isDirect(offer.via)) continue;
    const retailer = canonicalRetailer(offer.retailer);
    const productUrl = exactHttpUrl(offer.productUrl);
    const retailerProductId = typeof offer.retailerProductId === "string"
      ? offer.retailerProductId.trim()
      : "";
    if (!retailer || !productUrl || !retailerProductId) continue;
    const identity = `${retailer}\u0000${retailerProductId}`;
    if (!deduped.has(identity)) {
      deduped.set(identity, { retailer, retailerProductId, productUrl });
    }
  }
  return [...deduped.values()].sort((a, b) => (
    RETAILER_PREFERENCE[a.retailer] - RETAILER_PREFERENCE[b.retailer]
    || a.retailerProductId.localeCompare(b.retailerProductId, "en-US")
    || a.productUrl.localeCompare(b.productUrl, "en-US")
  ));
}

function validateOptions(options: DonorHarvestSeedPlanOptions): Required<DonorHarvestSeedPlanOptions> {
  const minGalleryImages = options.minGalleryImages ?? 5;
  const maxAttempts = options.maxAttempts ?? 3;
  if (!Number.isSafeInteger(minGalleryImages) || minGalleryImages < 5) {
    throw new RangeError("minGalleryImages must be an integer of at least 5");
  }
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
    throw new RangeError("maxAttempts must be an integer between 1 and 3");
  }
  return {
    useBluecartWalmart: options.useBluecartWalmart === true,
    minGalleryImages,
    maxAttempts,
  };
}

function emptyPlan(
  donorProductId: string,
  disposition: "already_complete" | "no_exact_offer_url",
  completedFields: readonly string[],
  requestedFields: readonly string[],
  maxAttempts: number,
): DonorHarvestSeedPlan {
  return {
    donorProductId,
    disposition,
    completedFields,
    requestedFields,
    source: null,
    retailer: null,
    retailerProductId: null,
    productUrl: null,
    targetOnly: false,
    terminalReason: null,
    maxAttempts,
    estimatedCallsFirstAttempt: 0,
    estimatedUnitsFirstAttempt: 0,
    maximumCallsAtAttemptCap: 0,
    maximumUnitsAtAttemptCap: 0,
  };
}

/** Plans one donor without touching a database, filesystem, or network. */
export function planDonorHarvestSeed(
  donor: HarvestSeedDonorSnapshot,
  rawOptions: DonorHarvestSeedPlanOptions = {},
): DonorHarvestSeedPlan {
  const options = validateOptions(rawOptions);
  const donorProductId = requiredText(donor.id, "donor.id");
  const completedFields = completedHarvestFieldsFromDonorProduct(
    donor,
    DONOR_HARVEST_BOOTSTRAP_FIELDS,
    { minGalleryImages: options.minGalleryImages },
  );
  const completed = new Set(completedFields);
  const requestedFields = DONOR_HARVEST_BOOTSTRAP_FIELDS.filter((field) => !completed.has(field));
  if (requestedFields.length === 0) {
    return emptyPlan(donorProductId, "already_complete", completedFields, requestedFields, options.maxAttempts);
  }

  const offers = exactOffers(donor.offers);
  if (offers.length === 0) {
    return emptyPlan(donorProductId, "no_exact_offer_url", completedFields, requestedFields, options.maxAttempts);
  }

  const targetOnly = offers.every((offer) => offer.retailer === "target");
  const targetUnavailable = new Set(TARGET_STRUCTURALLY_UNAVAILABLE_FIELDS);
  const terminalTarget = targetOnly && requestedFields.every((field) => targetUnavailable.has(field));
  const selected = offers[0];
  const source: HarvestSeedSource = selected.retailer === "walmart" && options.useBluecartWalmart
    ? "bluecart:walmart"
    : `unwrangle:${selected.retailer}`;
  const units = terminalTarget ? 0 : UNITS_PER_ATTEMPT[source];
  return {
    donorProductId,
    disposition: terminalTarget ? "terminal_source_unavailable" : "queue",
    completedFields,
    requestedFields,
    source,
    retailer: selected.retailer,
    retailerProductId: selected.retailerProductId,
    productUrl: selected.productUrl,
    targetOnly,
    terminalReason: terminalTarget ? TARGET_ONLY_TERMINAL_REASON : null,
    maxAttempts: options.maxAttempts,
    estimatedCallsFirstAttempt: terminalTarget ? 0 : 1,
    estimatedUnitsFirstAttempt: units,
    maximumCallsAtAttemptCap: terminalTarget ? 0 : options.maxAttempts,
    maximumUnitsAtAttemptCap: units * options.maxAttempts,
  };
}

export function donorHarvestSeedConfirmation(runId: string): string {
  return `APPLY_DONOR_HARVEST_SEED:${requiredText(runId, "runId")}`;
}
