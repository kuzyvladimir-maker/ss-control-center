import type { Client } from "@libsql/client";

import {
  PHASE1_SCOPE_MANIFEST_VERSION,
  renderPhase1ScopeManifestJson,
  sha256Hex,
  validatePhase1ScopeManifestV3Policy,
  type Phase1ScopeManifest,
} from "./phase1-scope-manifest";
import {
  PRODUCT_TRUTH_MAX_BATCH_SCOPES,
  readProductTruthSnapshots,
  type ProductTruthReadScope,
  type ProductTruthSnapshot,
} from "./product-truth-read-contract";
import { PRODUCT_TRUTH_READ_CONTRACT_VERSION } from "./product-truth-read-contract-version";
import { buildProductTruthListingScope } from "./product-truth-listing-scope";
import {
  productTruthOperationalSha256,
  renderProductTruthOperationalJson,
} from "./product-truth-operational-run-contract";

export const PRODUCT_TRUTH_CONSUMER_READINESS_VERSION =
  "product-truth-consumer-readiness/1.0.0" as const;

type BinaryReadinessStatus = "READY" | "BLOCKED";

export interface ProductTruthConsumerReadinessEntry {
  ordinal: number;
  listingKey: string;
  channel: "amazon" | "walmart";
  storeIndex: number;
  sku: string;
  consumers: {
    bundleFactory: {
      status: BinaryReadinessStatus;
      blockers: string[];
      viewSha256: string;
    };
    listingImprovement: {
      status: BinaryReadinessStatus;
      blockers: string[];
      viewSha256: string;
    };
    unitEconomics: {
      status: "FACT" | "ESTIMATE" | "UNSOURCEABLE" | "MISSING" | "INVALID";
      blockers: string[];
      skuCostId: string | null;
      viewSha256: string;
    };
    procurement: {
      status: BinaryReadinessStatus;
      blockers: string[];
      viewSha256: string;
    };
  };
}

export interface ProductTruthConsumerReadinessReport {
  schemaVersion: typeof PRODUCT_TRUTH_CONSUMER_READINESS_VERSION;
  mode: "READ_ONLY_NO_PAID_READINESS";
  readContractVersion: typeof PRODUCT_TRUTH_READ_CONTRACT_VERSION;
  capturedAt: string;
  asOf: string;
  maxPriceAgeMs: number;
  databaseTargetFingerprint: string;
  authoritativeManifest: {
    schemaVersion: typeof PHASE1_SCOPE_MANIFEST_VERSION;
    sha256: string;
    asOf: string;
    liveListings: number;
  };
  counts: {
    denominator: number;
    reconciled: number;
    bundleFactory: { ready: number; blocked: number };
    listingImprovement: { ready: number; blocked: number };
    unitEconomics: {
      ready: number;
      blocked: number;
      fact: number;
      estimate: number;
      unsourceable: number;
      missing: number;
      invalid: number;
    };
    procurement: { ready: number; blocked: number };
  };
  dataReadyConsumers: Array<
    "BUNDLE_FACTORY" | "LISTING_IMPROVEMENT" | "UNIT_ECONOMICS" | "PROCUREMENT"
  >;
  entries: ProductTruthConsumerReadinessEntry[];
  claims: {
    databaseWrites: false;
    providerCalls: false;
    paidCalls: false;
    enrichmentMutations: false;
    marketplaceMutations: false;
    procurementMutations: false;
    ownerActivationGranted: false;
    consumerCutoverClaimed: false;
  };
  payloadSha256: string;
}

export class ProductTruthConsumerReadinessError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProductTruthConsumerReadinessError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ProductTruthConsumerReadinessError(code, message);
}

function exactSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    fail("READINESS_INPUT_INVALID", `${label} must be an exact lowercase SHA-256`);
  }
  return value;
}

function canonicalInstant(value: unknown, label: string): string {
  if (typeof value !== "string" || value !== value.trim() || !value) {
    fail("READINESS_INPUT_INVALID", `${label} must be exact timestamp text`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    fail("READINESS_INPUT_INVALID", `${label} must be a canonical UTC ISO-8601 instant`);
  }
  return value;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en-US"));
}

function validateManifest(input: {
  manifest: Phase1ScopeManifest;
  manifestJson: string;
  expectedManifestSha256: string;
}): { manifestSha256: string; scopes: ProductTruthReadScope[] } {
  const policyErrors = validatePhase1ScopeManifestV3Policy(input.manifest);
  if (
    input.manifest.schemaVersion !== PHASE1_SCOPE_MANIFEST_VERSION
    || input.manifest.authoritative !== true
    || !Array.isArray(input.manifest.blockers)
    || input.manifest.blockers.length !== 0
    || policyErrors.length > 0
  ) {
    fail(
      "READINESS_MANIFEST_INVALID",
      `manifest is not an authoritative current v3 artifact${
        policyErrors.length ? `: ${policyErrors.join("; ")}` : ""
      }`,
    );
  }
  if (
    input.manifest.counts.blockerCount !== 0
    || input.manifest.counts.liveListings !== input.manifest.listings.length
    || input.manifest.listings.length < 1
  ) {
    fail("READINESS_MANIFEST_INVALID", "manifest listing denominator does not reconcile");
  }
  const canonicalJson = renderPhase1ScopeManifestJson(input.manifest);
  if (canonicalJson !== input.manifestJson) {
    fail("READINESS_MANIFEST_INVALID", "manifest bytes are not canonical or match a different object");
  }
  const manifestSha256 = sha256Hex(input.manifestJson);
  if (manifestSha256 !== exactSha256(
    input.expectedManifestSha256,
    "expectedManifestSha256",
  )) {
    fail("READINESS_MANIFEST_HASH_MISMATCH", "manifest SHA-256 does not match exact bytes");
  }
  const seen = new Set<string>();
  const scopes = input.manifest.listings.map((listing, ordinal) => {
    let exact;
    try {
      exact = buildProductTruthListingScope(listing);
    } catch (error) {
      fail(
        "READINESS_MANIFEST_INVALID",
        `manifest listing ${ordinal} has invalid exact scope: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }
    if (
      (exact.channel !== "amazon" && exact.channel !== "walmart")
      || exact.listingKey !== listing.listingKey
      || seen.has(exact.listingKey)
    ) {
      fail(
        "READINESS_MANIFEST_INVALID",
        `manifest listing ${ordinal} is duplicate or contradicts its listingKey`,
      );
    }
    seen.add(exact.listingKey);
    return {
      channel: exact.channel,
      storeIndex: exact.storeIndex,
      sku: exact.sku,
    };
  });
  return { manifestSha256, scopes };
}

function assertSnapshotBinding(input: {
  snapshot: ProductTruthSnapshot;
  scope: ProductTruthReadScope;
  ordinal: number;
  asOf: string;
  maxPriceAgeMs: number;
}): void {
  const exact = buildProductTruthListingScope(input.scope);
  const snapshot = input.snapshot;
  if (
    snapshot.contractVersion !== PRODUCT_TRUTH_READ_CONTRACT_VERSION
    || snapshot.snapshot.listingKey !== exact.listingKey
    || snapshot.snapshot.channel !== exact.channel
    || snapshot.snapshot.storeIndex !== exact.storeIndex
    || snapshot.snapshot.sku !== exact.sku
    || snapshot.snapshot.asOf !== input.asOf
    || snapshot.snapshot.maxPriceAgeMs !== input.maxPriceAgeMs
  ) {
    fail(
      "READINESS_SNAPSHOT_INVALID",
      `snapshot ${input.ordinal} is not bound to ${exact.listingKey} and the sealed read policy`,
    );
  }
}

function entry(
  snapshot: ProductTruthSnapshot,
  ordinal: number,
): ProductTruthConsumerReadinessEntry {
  const bundle = snapshot.views.bundleFactory;
  const listing = snapshot.views.listingImprovement;
  const economics = snapshot.views.unitEconomics;
  const procurement = snapshot.views.procurement;
  return {
    ordinal,
    listingKey: snapshot.snapshot.listingKey,
    channel: snapshot.snapshot.channel as "amazon" | "walmart",
    storeIndex: snapshot.snapshot.storeIndex,
    sku: snapshot.snapshot.sku,
    consumers: {
      bundleFactory: {
        status: bundle.ready ? "READY" : "BLOCKED",
        blockers: uniqueSorted(bundle.blockers),
        viewSha256: productTruthOperationalSha256(bundle),
      },
      listingImprovement: {
        status: listing.ready ? "READY" : "BLOCKED",
        blockers: uniqueSorted(listing.blockers),
        viewSha256: productTruthOperationalSha256(listing),
      },
      unitEconomics: {
        status: economics.status,
        blockers: uniqueSorted(economics.blockers),
        skuCostId: economics.current?.id ?? null,
        viewSha256: productTruthOperationalSha256(economics),
      },
      procurement: {
        status: procurement.ready ? "READY" : "BLOCKED",
        blockers: uniqueSorted(procurement.blockers),
        viewSha256: productTruthOperationalSha256(procurement),
      },
    },
  };
}

export function compileProductTruthConsumerReadiness(input: {
  manifest: Phase1ScopeManifest;
  manifestJson: string;
  expectedManifestSha256: string;
  databaseTargetFingerprint: string;
  capturedAt: string;
  asOf: string;
  maxPriceAgeMs: number;
  snapshots: readonly ProductTruthSnapshot[];
}): ProductTruthConsumerReadinessReport {
  const manifest = validateManifest(input);
  const databaseTargetFingerprint = exactSha256(
    input.databaseTargetFingerprint,
    "databaseTargetFingerprint",
  );
  const capturedAt = canonicalInstant(input.capturedAt, "capturedAt");
  const asOf = canonicalInstant(input.asOf, "asOf");
  if (Date.parse(asOf) > Date.parse(capturedAt)) {
    fail("READINESS_INPUT_INVALID", "asOf cannot be later than capturedAt");
  }
  if (
    !Number.isSafeInteger(input.maxPriceAgeMs)
    || input.maxPriceAgeMs < 1
    || input.maxPriceAgeMs > 30 * 24 * 60 * 60 * 1_000
  ) {
    fail(
      "READINESS_INPUT_INVALID",
      "maxPriceAgeMs must be an integer between 1 and 30 days",
    );
  }
  if (input.snapshots.length !== manifest.scopes.length) {
    fail("READINESS_RECONCILIATION_FAILED", "snapshot count differs from manifest denominator");
  }
  input.snapshots.forEach((snapshot, ordinal) =>
    assertSnapshotBinding({
      snapshot,
      scope: manifest.scopes[ordinal],
      ordinal,
      asOf,
      maxPriceAgeMs: input.maxPriceAgeMs,
    }));
  const entries = input.snapshots.map(entry);
  const bundleReady = entries.filter(
    (item) => item.consumers.bundleFactory.status === "READY",
  ).length;
  const listingReady = entries.filter(
    (item) => item.consumers.listingImprovement.status === "READY",
  ).length;
  const economicsStatuses = entries.map(
    (item) => item.consumers.unitEconomics.status,
  );
  const economicsFact = economicsStatuses.filter((status) => status === "FACT").length;
  const economicsEstimate = economicsStatuses.filter((status) => status === "ESTIMATE").length;
  const economicsReady = economicsFact + economicsEstimate;
  const procurementReady = entries.filter(
    (item) => item.consumers.procurement.status === "READY",
  ).length;
  const denominator = manifest.scopes.length;
  const counts: ProductTruthConsumerReadinessReport["counts"] = {
    denominator,
    reconciled: entries.length,
    bundleFactory: { ready: bundleReady, blocked: denominator - bundleReady },
    listingImprovement: { ready: listingReady, blocked: denominator - listingReady },
    unitEconomics: {
      ready: economicsReady,
      blocked: denominator - economicsReady,
      fact: economicsFact,
      estimate: economicsEstimate,
      unsourceable: economicsStatuses.filter((status) => status === "UNSOURCEABLE").length,
      missing: economicsStatuses.filter((status) => status === "MISSING").length,
      invalid: economicsStatuses.filter((status) => status === "INVALID").length,
    },
    procurement: { ready: procurementReady, blocked: denominator - procurementReady },
  };
  const dataReadyConsumers: ProductTruthConsumerReadinessReport["dataReadyConsumers"] = [];
  if (counts.bundleFactory.blocked === 0) dataReadyConsumers.push("BUNDLE_FACTORY");
  if (counts.listingImprovement.blocked === 0) dataReadyConsumers.push("LISTING_IMPROVEMENT");
  if (counts.unitEconomics.blocked === 0) dataReadyConsumers.push("UNIT_ECONOMICS");
  if (counts.procurement.blocked === 0) dataReadyConsumers.push("PROCUREMENT");
  const payload = {
    schemaVersion: PRODUCT_TRUTH_CONSUMER_READINESS_VERSION,
    mode: "READ_ONLY_NO_PAID_READINESS" as const,
    readContractVersion: PRODUCT_TRUTH_READ_CONTRACT_VERSION,
    capturedAt,
    asOf,
    maxPriceAgeMs: input.maxPriceAgeMs,
    databaseTargetFingerprint,
    authoritativeManifest: {
      schemaVersion: PHASE1_SCOPE_MANIFEST_VERSION,
      sha256: manifest.manifestSha256,
      asOf: input.manifest.asOf,
      liveListings: denominator,
    },
    counts,
    dataReadyConsumers,
    entries,
    claims: {
      databaseWrites: false as const,
      providerCalls: false as const,
      paidCalls: false as const,
      enrichmentMutations: false as const,
      marketplaceMutations: false as const,
      procurementMutations: false as const,
      ownerActivationGranted: false as const,
      consumerCutoverClaimed: false as const,
    },
  };
  return {
    ...payload,
    payloadSha256: productTruthOperationalSha256(payload),
  };
}

/**
 * Reads the complete manifest denominator in deterministic sequential chunks.
 * The canonical reader uses read transactions and contains no writer/provider
 * path; the returned artifact explicitly grants no activation.
 */
export async function readProductTruthConsumerReadiness(
  db: Client,
  input: Omit<
    Parameters<typeof compileProductTruthConsumerReadiness>[0],
    "snapshots"
  >,
): Promise<ProductTruthConsumerReadinessReport> {
  const manifest = validateManifest(input);
  const snapshots: ProductTruthSnapshot[] = [];
  for (let index = 0; index < manifest.scopes.length; index += PRODUCT_TRUTH_MAX_BATCH_SCOPES) {
    const scopes = manifest.scopes.slice(index, index + PRODUCT_TRUTH_MAX_BATCH_SCOPES);
    snapshots.push(...await readProductTruthSnapshots(db, {
      scopes,
      expectedManifestSha256: manifest.manifestSha256,
      asOf: input.asOf,
      maxPriceAgeMs: input.maxPriceAgeMs,
    }));
  }
  return compileProductTruthConsumerReadiness({ ...input, snapshots });
}

export function renderProductTruthConsumerReadinessJson(
  report: ProductTruthConsumerReadinessReport,
): string {
  return renderProductTruthOperationalJson(report);
}
