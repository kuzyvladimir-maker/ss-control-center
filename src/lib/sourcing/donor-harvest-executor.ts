/**
 * Reusable execution boundary for one durable donor-content harvest state.
 *
 * Both cron and one-shot operational runners must call this module instead of
 * invoking `harvestDonorDetail` directly. It owns the exact first-party source
 * preflight, atomic claim, metered-reservation checkpoint, terminal outcome and
 * expired-lease reconciliation. A paid reservation is never auto-replayed.
 */

import { randomUUID } from "node:crypto";

import type { Client } from "@libsql/client";

import {
  harvestDonorDetail,
  type HarvestDonorDetailOptions,
  type HarvestResult,
} from "./donor-catalog";
import {
  isDonorHarvestTerminal,
  type DonorHarvestMeteredBoundary,
} from "./donor-harvest-lifecycle";
import {
  claimDonorHarvestState,
  completedHarvestFieldsFromDonorProduct,
  getDonorHarvestState,
  persistDonorHarvestTransition,
  reapExpiredDonorHarvestLeases,
  type ReapExpiredDonorHarvestLeaseResult,
  type StoredDonorHarvestState,
} from "./donor-harvest-store";
import {
  isMeteredProviderControlError,
  meteredProviderReservationKey,
  type MeteredProviderAuthorization,
} from "./metered-provider-call";

export type DonorHarvestSource = {
  provider: "unwrangle" | "bluecart";
  retailer: "walmart" | "target" | "samsclub" | "costco";
};

const UNWRANGLE_DETAIL_PLATFORM: Record<DonorHarvestSource["retailer"], string> = {
  walmart: "walmart_detail",
  target: "target_detail",
  samsclub: "samsclub_detail",
  costco: "costco_detail",
};

const FIRST_PARTY_RETAILER_DOMAIN: Record<DonorHarvestSource["retailer"], string> = {
  walmart: "walmart.com",
  target: "target.com",
  samsclub: "samsclub.com",
  costco: "costco.com",
};

const DEFAULT_LEASE_MS = 4 * 60_000;
const DEFAULT_RETRY_MS = 6 * 60 * 60_000;

type HarvestDetail = (
  db: Client,
  productId: string,
  options: HarvestDonorDetailOptions,
) => Promise<HarvestResult>;

type ExactFirstPartyOffer = {
  productUrl: string;
};

export type DonorHarvestExecutionDisposition =
  | "complete"
  | "terminal"
  | "blocked"
  | "lost_race";

export interface ExecuteDonorHarvestCandidateInput {
  db: Client;
  candidate: StoredDonorHarvestState;
  runId: string;
  approvalId: string;
  leaseOwner: string;
  leaseToken?: string;
  leaseMs?: number;
  retryDelayMs?: number;
  now?: () => string;
  /** Explicitly false for a sealed two-provider lane; prevents implicit OFF I/O. */
  allowOpenFoodFactsSupplement?: boolean;
  /** Walmart new-SKU pilot only; generic exact multipack harvests remain allowed. */
  requireBaseUnit?: boolean;
  /** Sealed exact-one lanes forbid cross-product UPC quarantine writes. */
  upcConflictPolicy?: "quarantine" | "block";
  /** Sealed-lane drift/deadline fence after provider response and before writes. */
  beforeCatalogWrite?: () => Promise<string | void>;
  /** Test seam only; production callers use the guarded catalog adapter. */
  harvestDetail?: HarvestDetail;
}

export interface ExecuteDonorHarvestCandidateResult {
  disposition: DonorHarvestExecutionDisposition;
  state: StoredDonorHarvestState | null;
  harvest: HarvestResult | null;
  reason: string;
}

export interface ReapExpiredDonorHarvestForExecutionOptions {
  now: string;
  limit?: number;
  retryDelayMs?: number;
  /** Test seam; the default probes the durable metered ledger. */
  meteredBoundaryFor?: (
    state: StoredDonorHarvestState,
  ) => DonorHarvestMeteredBoundary | Promise<DonorHarvestMeteredBoundary>;
}

export class DonorHarvestExecutionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "DonorHarvestExecutionError";
  }
}

function requiredText(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new DonorHarvestExecutionError(`${label} is required`);
  return normalized;
}

function positiveMilliseconds(value: number | undefined, fallback: number, label: string): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new DonorHarvestExecutionError(`${label} must be a positive integer`);
  }
  return normalized;
}

function canonicalIso(value: string, label: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new DonorHarvestExecutionError(`${label} must be a valid timestamp`);
  }
  return new Date(timestamp).toISOString();
}

function eventAt(state: StoredDonorHarvestState, clock: () => string): string {
  const proposed = Date.parse(canonicalIso(clock(), "now()"));
  return new Date(Math.max(proposed, Date.parse(state.updatedAt))).toISOString();
}

function later(at: string, delayMs: number): string {
  return new Date(Date.parse(at) + delayMs).toISOString();
}

function exactHttpUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || !parsed.hostname) return null;
    if (parsed.username || parsed.password) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function boundedError(error: unknown): string {
  const raw = String(error instanceof Error ? error.message : error).trim() || "Unknown harvest error";
  return raw
    .replace(/([?&](?:api_key|key|token)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/\bBearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .slice(0, 500);
}

/** Explicit allow-list. BJ's and every unknown source fail closed. */
export function parseDonorHarvestSource(source: string): DonorHarvestSource | null {
  const [provider, retailer, extra] = source.split(":");
  if (extra || (provider !== "unwrangle" && provider !== "bluecart")) return null;
  if (!(["walmart", "target", "samsclub", "costco"] as const).includes(
    retailer as DonorHarvestSource["retailer"],
  )) return null;
  if (provider === "bluecart" && retailer !== "walmart") return null;
  return {
    provider,
    retailer: retailer as DonorHarvestSource["retailer"],
  };
}

async function exactFirstPartyOffer(
  db: Client,
  state: StoredDonorHarvestState,
  source: DonorHarvestSource,
  requireBaseUnit = false,
): Promise<{ offer: ExactFirstPartyOffer | null; reason: string | null }> {
  const result = await db.execute({
    sql: `SELECT "productUrl", "via", "isFirstParty", "sellerName", "packSizeSeen"
          FROM "DonorOffer"
          WHERE "donorProductId"=? AND "retailer"=? AND "retailerProductId"=?
          LIMIT 1`,
    args: [state.donorProductId, source.retailer, state.retailerProductId],
  });
  const row = result.rows[0];
  if (!row) return { offer: null, reason: "SOURCE_ITEM_OFFER_UNAVAILABLE" };
  if (String(row.via || "").trim().toLocaleLowerCase("en-US") !== "direct") {
    return { offer: null, reason: "SOURCE_ITEM_NOT_DIRECT" };
  }
  if (Number(row.isFirstParty) !== 1) {
    return { offer: null, reason: "SOURCE_ITEM_NOT_EXPLICIT_FIRST_PARTY" };
  }
  if (source.retailer === "walmart" && String(row.sellerName ?? "") !== "Walmart.com") {
    return { offer: null, reason: "SOURCE_ITEM_SELLER_NOT_WALMART_COM" };
  }
  if (requireBaseUnit && Number(row.packSizeSeen) !== 1) {
    return { offer: null, reason: "SOURCE_ITEM_NOT_BASE_UNIT" };
  }
  const productUrl = exactHttpUrl(row.productUrl);
  if (!productUrl) return { offer: null, reason: "SOURCE_ITEM_URL_UNAVAILABLE" };
  const hostname = new URL(productUrl).hostname.toLocaleLowerCase("en-US");
  const expectedDomain = FIRST_PARTY_RETAILER_DOMAIN[source.retailer];
  if (hostname !== expectedDomain && !hostname.endsWith(`.${expectedDomain}`)) {
    return { offer: null, reason: "SOURCE_ITEM_RETAILER_DOMAIN_MISMATCH" };
  }
  return { offer: { productUrl }, reason: null };
}

async function terminalizeSourcePrecondition(
  db: Client,
  current: StoredDonorHarvestState,
  at: string,
  reason: string,
  error?: string,
): Promise<ExecuteDonorHarvestCandidateResult> {
  const saved = await persistDonorHarvestTransition(db, current, {
    type: "source_unavailable",
    at,
    reason,
    error: error == null ? null : boundedError(error),
  });
  return {
    disposition: saved ? "terminal" : "lost_race",
    state: saved,
    harvest: null,
    reason,
  };
}

async function latestTerminalOrAmbiguous(
  db: Client,
  stateId: string,
  at: string,
  error: unknown,
  reason = "METERED_ATTEMPT_OUTCOME_AMBIGUOUS",
): Promise<StoredDonorHarvestState | null> {
  let latest = await getDonorHarvestState(db, stateId);
  if (!latest || isDonorHarvestTerminal(latest.status)) return latest;
  const transitionAt = new Date(Math.max(Date.parse(at), Date.parse(latest.updatedAt))).toISOString();
  const saved = await persistDonorHarvestTransition(db, latest, {
    type: "metered_outcome_ambiguous",
    at: transitionAt,
    reason,
    error: boundedError(error),
  });
  if (saved) return saved;
  latest = await getDonorHarvestState(db, stateId);
  if (!latest || isDonorHarvestTerminal(latest.status)) return latest;
  throw new DonorHarvestExecutionError(
    `Could not terminalize ambiguous harvest state ${stateId} after a CAS race`,
  );
}

async function releasePreReservationBlock(
  db: Client,
  current: StoredDonorHarvestState,
  at: string,
  retryDelayMs: number,
  reason: string,
): Promise<ExecuteDonorHarvestCandidateResult> {
  const saved = await persistDonorHarvestTransition(db, current, {
    type: "permit_denied",
    at,
    nextEligibleAt: later(at, retryDelayMs),
    reason,
  });
  return {
    disposition: saved ? "blocked" : "lost_race",
    state: saved,
    harvest: null,
    reason,
  };
}

function assertAuthorization(
  authorization: MeteredProviderAuthorization,
  source: DonorHarvestSource,
  runId: string,
  approvalId: string,
): void {
  if (
    authorization.runId !== runId
    || authorization.approvalId !== approvalId
    || authorization.provider !== source.provider
    || authorization.operation !== "detail"
  ) {
    throw new DonorHarvestExecutionError("HARVEST_METERED_AUTHORIZATION_MISMATCH");
  }
}

/**
 * Executes exactly one claimable lifecycle row. It never adds an attempt nonce
 * to the paid request. Therefore every outcome after a reservation is terminal:
 * success resolves missing source fields as unavailable, while failure/unknown
 * requires review and cannot become an automatic second charge.
 */
export async function executeDonorHarvestCandidate(
  input: ExecuteDonorHarvestCandidateInput,
): Promise<ExecuteDonorHarvestCandidateResult> {
  const runId = requiredText(input.runId, "runId");
  const approvalId = requiredText(input.approvalId, "approvalId");
  const leaseOwner = requiredText(input.leaseOwner, "leaseOwner");
  const leaseMs = positiveMilliseconds(input.leaseMs, DEFAULT_LEASE_MS, "leaseMs");
  const retryDelayMs = positiveMilliseconds(input.retryDelayMs, DEFAULT_RETRY_MS, "retryDelayMs");
  const clock = input.now ?? (() => new Date().toISOString());
  const harvestDetail = input.harvestDetail ?? harvestDonorDetail;
  if (input.candidate.attempts > 0) {
    const saved = await persistDonorHarvestTransition(input.db, input.candidate, {
      type: "metered_outcome_ambiguous",
      at: eventAt(input.candidate, clock),
      reason: "AUTOMATIC_METERED_REPLAY_FORBIDDEN",
      error: "A prior metered source attempt exists; operator reconciliation is required before any new request",
    });
    return {
      disposition: saved ? "terminal" : "lost_race",
      state: saved,
      harvest: null,
      reason: "AUTOMATIC_METERED_REPLAY_FORBIDDEN",
    };
  }
  if (
    input.candidate.runId
    && input.candidate.approvalId
    && input.candidate.claimedAt
  ) {
    let priorBoundary: DonorHarvestMeteredBoundary = "observed_or_unknown";
    let probeFailure: string | null = null;
    try {
      priorBoundary = await probeMeteredBoundary(input.db, input.candidate);
    } catch (error) {
      probeFailure = boundedError(error);
    }
    if (priorBoundary === "observed_or_unknown") {
      const saved = await persistDonorHarvestTransition(input.db, input.candidate, {
        type: "metered_outcome_ambiguous",
        at: eventAt(input.candidate, clock),
        error: probeFailure
          ? `Prior metered boundary could not be disproved: ${probeFailure}`
          : "A durable receipt appeared after the prior lease was released",
      });
      return {
        disposition: saved ? "terminal" : "lost_race",
        state: saved,
        harvest: null,
        reason: "METERED_ATTEMPT_OUTCOME_AMBIGUOUS",
      };
    }
  }
  const source = parseDonorHarvestSource(input.candidate.source);
  if (!source) {
    return terminalizeSourcePrecondition(
      input.db,
      input.candidate,
      eventAt(input.candidate, clock),
      "SOURCE_CAPABILITY_UNSUPPORTED",
    );
  }

  const sourceOffer = await exactFirstPartyOffer(
    input.db,
    input.candidate,
    source,
    input.requireBaseUnit === true,
  );
  if (!sourceOffer.offer) {
    return terminalizeSourcePrecondition(
      input.db,
      input.candidate,
      eventAt(input.candidate, clock),
      sourceOffer.reason || "SOURCE_ITEM_OFFER_UNAVAILABLE",
    );
  }

  const claimAt = eventAt(input.candidate, clock);
  let current = await claimDonorHarvestState(input.db, input.candidate, {
    type: "claim",
    at: claimAt,
    runId,
    approvalId,
    leaseOwner,
    leaseToken: input.leaseToken ? requiredText(input.leaseToken, "leaseToken") : randomUUID(),
    leaseExpiresAt: later(claimAt, leaseMs),
  });
  if (!current) {
    return { disposition: "lost_race", state: null, harvest: null, reason: "CLAIM_CAS_LOST" };
  }

  let reservationObserved = false;
  try {
    const harvest = await harvestDetail(input.db, current.donorProductId, {
      ...source,
      retailerProductId: current.retailerProductId,
      productUrl: sourceOffer.offer.productUrl,
      allowOpenFoodFactsSupplement: input.allowOpenFoodFactsSupplement,
      requireBaseUnit: input.requireBaseUnit,
      upcConflictPolicy: input.upcConflictPolicy,
      beforeCatalogWrite: input.beforeCatalogWrite,
      onMeteredReservation: async (authorization) => {
        // Set first: even a binding/CAS exception occurs after durable budget
        // reservation and must never be downgraded to a retryable permit denial.
        reservationObserved = true;
        assertAuthorization(authorization, source, runId, approvalId);
        const attemptAt = eventAt(current as StoredDonorHarvestState, clock);
        const attempt = await persistDonorHarvestTransition(input.db, current as StoredDonorHarvestState, {
          type: "source_attempt_started",
          at: attemptAt,
        });
        if (!attempt) throw new DonorHarvestExecutionError("HARVEST_STATE_CAS_LOST_AFTER_RESERVATION");
        current = attempt;
      },
    });

    if (!reservationObserved) {
      if (harvest.ok) {
        const terminal = await latestTerminalOrAmbiguous(
          input.db,
          current.id,
          eventAt(current, clock),
          "Harvest mutation reported success without a durable reservation callback",
          "METERED_RESERVATION_CALLBACK_MISSING",
        );
        return {
          disposition: terminal ? "terminal" : "lost_race",
          state: terminal,
          harvest,
          reason: "METERED_RESERVATION_CALLBACK_MISSING",
        };
      }
      if (harvest.reason && harvest.reason !== "detail fetch failed") {
        return terminalizeSourcePrecondition(
          input.db,
          current,
          eventAt(current, clock),
          "SOURCE_PRECONDITION_REJECTED",
          harvest.reason,
        );
      }
      return releasePreReservationBlock(
        input.db,
        current,
        eventAt(current, clock),
        retryDelayMs,
        "PRE_NETWORK_SOURCE_CONFIGURATION_BLOCKED",
      );
    }

    if (!harvest.ok) {
      let failed = await persistDonorHarvestTransition(input.db, current, {
        type: "permanent_failure",
        at: eventAt(current, clock),
        reason: "SOURCE_DETAIL_UNAVAILABLE_AFTER_METERED_ATTEMPT",
        error: boundedError(harvest.reason || "detail fetch failed"),
      });
      if (!failed) {
        failed = await latestTerminalOrAmbiguous(
          input.db,
          current.id,
          eventAt(current, clock),
          "Metered provider miss lost its terminal lifecycle CAS",
        );
      }
      return {
        disposition: failed ? "terminal" : "lost_race",
        state: failed,
        harvest,
        reason: "SOURCE_DETAIL_UNAVAILABLE_AFTER_METERED_ATTEMPT",
      };
    }

    const donor = await input.db.execute({
      sql: `SELECT "title", "description", "bullets", "attributes", "nutritionFacts",
                   "ingredients", "mainImageUrl", "imageUrls", "upc", "gtin"
            FROM "DonorProduct" WHERE "id"=? LIMIT 1`,
      args: [current.donorProductId],
    });
    const completedFields = completedHarvestFieldsFromDonorProduct(
      (donor.rows[0] || {}) as Record<string, unknown>,
      current.requestedFields,
    );
    const completed = new Set(completedFields);
    // This state is source-item-specific. A successful detail response resolves
    // absent fields as unavailable from this exact source item; repeating the
    // same paid request cannot manufacture them and is explicitly forbidden.
    const unavailableFields = current.requestedFields.filter((field) => !completed.has(field));
    const saved = await persistDonorHarvestTransition(input.db, current, {
      type: "source_result",
      at: eventAt(current, clock),
      completedFields,
      unavailableFields,
    });
    if (!saved) {
      const terminal = await latestTerminalOrAmbiguous(
        input.db,
        current.id,
        eventAt(current, clock),
        "Harvest completed but its lifecycle result lost the version CAS",
      );
      return {
        disposition: terminal ? "terminal" : "lost_race",
        state: terminal,
        harvest,
        reason: "RESULT_CAS_LOST_AFTER_METERED_ATTEMPT",
      };
    }
    return {
      disposition: saved.status === "complete" ? "complete" : "terminal",
      state: saved,
      harvest,
      reason: saved.status === "complete" ? "SOURCE_ITEM_RESOLVED" : String(saved.terminalReason),
    };
  } catch (error) {
    // The sealed execution clock itself may be the failure (rollback/deadline).
    // Terminal cleanup must not call that failed clock again and strand the
    // source-item lease; the last durable state timestamp is monotonic-safe.
    let failedAt = current.updatedAt;
    try {
      failedAt = eventAt(current, clock);
    } catch {
      // Preserve the original provider/write-fence error below.
    }
    if (reservationObserved || current.sourceAttemptStartedAt) {
      const terminal = await latestTerminalOrAmbiguous(input.db, current.id, failedAt, error);
      return {
        disposition: terminal ? "terminal" : "lost_race",
        state: terminal,
        harvest: null,
        reason: "METERED_ATTEMPT_OUTCOME_AMBIGUOUS",
      };
    }
    if (isMeteredProviderControlError(error)) {
      let boundary: DonorHarvestMeteredBoundary = "observed_or_unknown";
      try {
        boundary = await probeMeteredBoundary(input.db, current);
      } catch {
        // A control error plus an unreadable ledger cannot prove that the
        // reservation boundary was not crossed. Fail closed below.
      }
      if (boundary === "observed_or_unknown") {
        const terminal = await latestTerminalOrAmbiguous(input.db, current.id, failedAt, error);
        return {
          disposition: terminal ? "terminal" : "lost_race",
          state: terminal,
          harvest: null,
          reason: "METERED_ATTEMPT_OUTCOME_AMBIGUOUS",
        };
      }
    }
    return releasePreReservationBlock(
      input.db,
      current,
      failedAt,
      retryDelayMs,
      isMeteredProviderControlError(error)
        ? `METERED_PROVIDER_BLOCKED:${error instanceof Error ? error.name : "unknown"}`
        : "PRE_NETWORK_FAILURE",
    );
  }
}

async function probeMeteredBoundary(
  db: Client,
  state: StoredDonorHarvestState,
): Promise<DonorHarvestMeteredBoundary> {
  const source = parseDonorHarvestSource(state.source);
  if (!source || !state.runId || !state.approvalId) return "observed_or_unknown";
  const sourceOffer = await exactFirstPartyOffer(db, state, source);
  if (!sourceOffer.offer) return "observed_or_unknown";
  const reservationKey = source.provider === "unwrangle"
    ? meteredProviderReservationKey({
        provider: source.provider,
        operation: "detail",
        requestFingerprint: {
          platform: UNWRANGLE_DETAIL_PLATFORM[source.retailer],
          retailer: source.retailer,
          url: sourceOffer.offer.productUrl,
        },
      })
    : meteredProviderReservationKey({
        provider: source.provider,
        operation: "detail",
        requestFingerprint: {
          itemId: state.retailerProductId,
          domain: "walmart.com",
        },
      });
  const result = await db.execute({
    sql: `SELECT receipt."status"
          FROM "MeteredProviderBudget" budget
          JOIN "MeteredReservationReceipt" receipt ON receipt."budgetId"=budget."id"
          WHERE budget."runId"=? AND budget."approvalId"=? AND budget."provider"=?
            AND receipt."reservationKey"=?
          LIMIT 1`,
    args: [state.runId, state.approvalId, source.provider, reservationKey],
  });
  const status = result.rows[0] ? String(result.rows[0].status) : null;
  if (status === "reserved" || status === "succeeded" || status === "failed") {
    return "observed_or_unknown";
  }
  if (status !== null && status !== "pending" && status !== "rejected") {
    return "observed_or_unknown";
  }

  // The offer URL and adapter fingerprint can evolve after a worker dies. An
  // exact-key miss is therefore not sufficient proof by itself. Concurrency is
  // one, so any reserved detail receipt created after this claim is an
  // ambiguous boundary for the stranded row and must stop automatic replay.
  if (!state.claimedAt) return "observed_or_unknown";
  const laterReceipt = await db.execute({
    sql: `SELECT receipt."status"
          FROM "MeteredProviderBudget" budget
          JOIN "MeteredReservationReceipt" receipt ON receipt."budgetId"=budget."id"
          WHERE budget."runId"=? AND budget."approvalId"=? AND budget."provider"=?
            AND receipt."operation"='detail'
            AND (
              julianday(receipt."createdAt") >= julianday(?)
              OR julianday(receipt."createdAt") IS NULL
            )
            AND receipt."status" IN ('reserved','succeeded','failed')
          ORDER BY receipt."createdAt" ASC
          LIMIT 1`,
    args: [state.runId, state.approvalId, source.provider, state.claimedAt],
  });
  return laterReceipt.rows[0] ? "observed_or_unknown" : "not_observed";
}

/** Reaps expired rows before a caller lists new claimable work. */
export async function reapExpiredDonorHarvestForExecution(
  db: Client,
  options: ReapExpiredDonorHarvestForExecutionOptions,
): Promise<ReapExpiredDonorHarvestLeaseResult> {
  return reapExpiredDonorHarvestLeases(db, {
    ...options,
    meteredBoundaryFor: options.meteredBoundaryFor
      ?? ((state) => probeMeteredBoundary(db, state)),
  });
}
