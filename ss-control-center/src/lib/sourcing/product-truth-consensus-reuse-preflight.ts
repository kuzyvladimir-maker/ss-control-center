import { createHash } from "node:crypto";

import type { Client, Row } from "@libsql/client";

import {
  PRODUCT_TRUTH_CONSENSUS_REUSE_SCOPE_VERSION,
  renderProductTruthConsensusReuseScope,
  type ProductTruthConsensusReuseCandidate,
  type ProductTruthConsensusReuseScope,
} from "./product-truth-consensus-reuse-scope";
import {
  checkProductTruthConsensusReuseForeignKeys,
} from "./product-truth-consensus-reuse-foreign-key";
import {
  productTruthOperationalSha256,
  renderProductTruthOperationalJson,
} from "./product-truth-operational-run-contract";
import {
  assertProductTruthEvidenceSchema,
  assertProductTruthListingScopeSchema,
} from "./product-truth-schema-gate";

export const PRODUCT_TRUTH_CONSENSUS_REUSE_PREFLIGHT_VERSION =
  "product-truth-consensus-reuse-preflight/1.0.0" as const;
export const PRODUCT_TRUTH_CONSENSUS_REUSE_WAVE_MAX_LISTINGS = 5;
export const PRODUCT_TRUTH_CONSENSUS_REUSE_WAVE_MAX_ROWS = 100;

export type ProductTruthConsensusReusePreflightBlockerCode =
  | "LISTING_SCOPE_MISSING"
  | "LISTING_SCOPE_IDENTITY_DRIFT"
  | "LISTING_SCOPE_MANIFEST_DRIFT"
  | "LISTING_RECIPE_ALREADY_EXISTS"
  | "SOURCE_COMPONENT_MISSING"
  | "SOURCE_COMPONENT_DRIFT"
  | "DONOR_PRODUCT_MISSING"
  | "DONOR_TITLE_DRIFT"
  | "DONOR_SIZE_DRIFT"
  | "DONOR_IDENTITY_STATE_INVALID"
  | "DONOR_EXACT_DECISION_COLLISION"
  | "CANONICAL_VARIANT_COLLISION"
  | "FOREIGN_KEY_VIOLATION";

export interface ProductTruthConsensusReusePreflightBlocker {
  code: ProductTruthConsensusReusePreflightBlockerCode;
  scope: "LISTING" | "DONOR" | "DATABASE";
  listingKey: string | null;
  donorProductId: string | null;
  message: string;
}

export interface ProductTruthConsensusReusePreflightWave {
  ordinal: number;
  waveKey: string;
  listingKeys: string[];
  donorProductIds: string[];
  maximumRows: number;
  canonicalVariantCreates: number;
  canonicalVariantReuses: number;
  decisionCreates: number;
  decisionReuses: number;
  donorTransitions: number;
  contentObservationCreates: number;
  listingRecipeCreates: number;
  listingRecipeComponentCreates: number;
  skuCostCreates: number;
  skuCostLinkCreates: number;
  skuComponentEvidenceCreates: number;
}

export interface ProductTruthConsensusReusePreflightReport {
  schemaVersion: typeof PRODUCT_TRUTH_CONSENSUS_REUSE_PREFLIGHT_VERSION;
  status: "READY_TO_PLAN" | "PARTIALLY_READY" | "BLOCKED";
  checkedAt: string;
  databaseTargetFingerprint: string;
  source: {
    consensusReuseScopeSha256: string;
    consensusReuseScopeGeneratedAt: string;
    targetFingerprint: string;
    manifestSha256: string;
  };
  counts: {
    selectedCandidates: number;
    reconciliationCandidatesQuarantined: number;
    directCandidates: number;
    directDonors: number;
    readyListings: number;
    readyDonors: number;
    blockedListings: number;
    blockedDonors: number;
    canonicalVariantCreates: number;
    canonicalVariantReuses: number;
    decisionCreates: number;
    decisionReuses: number;
    donorTransitions: number;
    existingRecipes: number;
    recommendedWaves: number;
  };
  blockers: ProductTruthConsensusReusePreflightBlocker[];
  readyListingKeys: string[];
  readyDonorProductIds: string[];
  readyDonorStates: Array<{
    donorProductId: string;
    proposedCanonicalVariantId: string;
    variantState: "CREATE" | "REUSE";
    decisionState: "CREATE" | "REUSE";
    existingDecision: {
      id: string;
      decidedAt: string;
    } | null;
    donorTransitionRequired: boolean;
    sourceIdentity: {
      identityKey: string;
      identityStatus: string;
      brand: string | null;
      productLine: string | null;
      flavor: string | null;
      containerType: string | null;
      size: string | null;
    };
    sourceIdentitySha256: string;
    listingKeys: string[];
  }>;
  waves: ProductTruthConsensusReusePreflightWave[];
  claims: {
    readOnlyDatabase: true;
    databaseWrites: 0;
    providerCalls: 0;
    paidCalls: 0;
    retailerFetches: 0;
    marketplaceMutations: 0;
    authorizesExecution: false;
    completeDonorGroupsOnly: true;
    maxListingsPerWave: 5;
    maxRowsPerWave: 100;
  };
}

export class ProductTruthConsensusReusePreflightError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "ProductTruthConsensusReusePreflightError";
    this.code = code;
  }
}

type JsonRow = Record<string, unknown>;

type DonorState = {
  id: string;
  identityKey: string;
  brand: string | null;
  productLine: string | null;
  flavor: string | null;
  containerType: string | null;
  title: string | null;
  size: string | null;
  identityStatus: string;
  identityMatcherVersion: string | null;
  identityMatcherImplementationSha256: string | null;
  identityMatcherReleaseSha256: string | null;
};

type DecisionState = {
  id: string;
  donorProductId: string;
  canonicalVariantId: string;
  decisionStatus: string;
  decidedAt: string;
};

export type ProductTruthConsensusReuseDonorPreflightState = {
  donorProductId: string;
  listingKeys: string[];
  proposedCanonicalVariantId: string;
  variantState: "CREATE" | "REUSE";
  decisionState: "CREATE" | "REUSE";
  existingDecision: {
    id: string;
    decidedAt: string;
  } | null;
  donorTransitionRequired: boolean;
  sourceIdentity: {
    identityKey: string;
    identityStatus: string;
    brand: string | null;
    productLine: string | null;
    flavor: string | null;
    containerType: string | null;
    size: string | null;
  };
  sourceIdentitySha256: string;
  blockers: ProductTruthConsensusReusePreflightBlocker[];
};

function fail(code: string, message: string): never {
  throw new ProductTruthConsensusReusePreflightError(code, message);
}

function bytesSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactSha256(value: string, label: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    fail("CONSENSUS_REUSE_PREFLIGHT_INPUT_INVALID", `${label} must be SHA-256`);
  }
  return value;
}

function exactInstant(value: string, label: string): string {
  if (
    !Number.isFinite(Date.parse(value))
    || new Date(Date.parse(value)).toISOString() !== value
  ) {
    fail("CONSENSUS_REUSE_PREFLIGHT_INPUT_INVALID", `${label} must be canonical UTC`);
  }
  return value;
}

function rowObject(row: Row): JsonRow {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, value ?? null]),
  );
}

function sameScalar(left: unknown, right: unknown): boolean {
  if (typeof left === "number" && typeof right === "number") {
    return Object.is(left, right);
  }
  return left === right;
}

function blocker(input: Omit<ProductTruthConsensusReusePreflightBlocker, "message"> & {
  message: string;
}): ProductTruthConsensusReusePreflightBlocker {
  return input;
}

function placeholders(values: readonly unknown[]): string {
  if (!values.length) fail("CONSENSUS_REUSE_PREFLIGHT_INTERNAL", "empty IN list");
  return values.map(() => "?").join(",");
}

async function queryByValues(input: {
  db: Client;
  table: string;
  key: string;
  values: readonly string[];
  columns: readonly string[];
}): Promise<JsonRow[]> {
  if (!input.values.length) return [];
  const result = await input.db.execute({
    sql: `SELECT ${input.columns.map((column) => `"${column}"`).join(",")}
      FROM "${input.table}"
      WHERE "${input.key}" IN (${placeholders(input.values)})`,
    args: [...input.values],
  });
  return result.rows.map(rowObject);
}

function uniqueBy<T>(
  values: readonly T[],
  key: (value: T) => string,
  label: string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const itemKey = key(value);
    if (result.has(itemKey)) {
      fail("CONSENSUS_REUSE_PREFLIGHT_DUPLICATE", `${label} ${itemKey}`);
    }
    result.set(itemKey, value);
  }
  return result;
}

function expectedWaveRows(input: {
  listings: number;
  donorStates: readonly ProductTruthConsensusReuseDonorPreflightState[];
}): Omit<
  ProductTruthConsensusReusePreflightWave,
  "ordinal" | "waveKey" | "listingKeys" | "donorProductIds" | "maximumRows"
> & { maximumRows: number } {
  const canonicalVariantCreates = input.donorStates.filter(
    (state) => state.variantState === "CREATE",
  ).length;
  const canonicalVariantReuses = input.donorStates.length
    - canonicalVariantCreates;
  const decisionCreates = input.donorStates.filter(
    (state) => state.decisionState === "CREATE",
  ).length;
  const decisionReuses = input.donorStates.length - decisionCreates;
  const donorTransitions = input.donorStates.filter(
    (state) => state.donorTransitionRequired,
  ).length;
  const contentObservationCreates = input.donorStates.length;
  const listingRecipeCreates = input.listings;
  const listingRecipeComponentCreates = input.listings;
  const skuCostCreates = input.listings;
  const skuCostLinkCreates = input.listings;
  const skuComponentEvidenceCreates = input.listings;
  return {
    maximumRows:
      // The materialization plan carries one immutable canonical-variant row
      // projection per donor even when that row already exists. Apply will
      // verify and reuse it rather than insert it, but it still consumes one
      // plan/preflight row slot and therefore belongs in the bounded graph.
      canonicalVariantCreates
      + canonicalVariantReuses
      + decisionCreates
      + donorTransitions
      + contentObservationCreates
      + listingRecipeCreates
      + listingRecipeComponentCreates
      + skuCostCreates
      + skuCostLinkCreates
      + skuComponentEvidenceCreates,
    canonicalVariantCreates,
    canonicalVariantReuses,
    decisionCreates,
    decisionReuses,
    donorTransitions,
    contentObservationCreates,
    listingRecipeCreates,
    listingRecipeComponentCreates,
    skuCostCreates,
    skuCostLinkCreates,
    skuComponentEvidenceCreates,
  };
}

export function buildProductTruthConsensusReuseWaves(input: {
  candidates: readonly ProductTruthConsensusReuseCandidate[];
  donorStates: readonly ProductTruthConsensusReuseDonorPreflightState[];
}): ProductTruthConsensusReusePreflightWave[] {
  const candidatesByDonor = Map.groupBy(
    input.candidates,
    (candidate) => candidate.donorProductId,
  );
  const stateByDonor = uniqueBy(
    input.donorStates,
    (state) => state.donorProductId,
    "donor state",
  );
  const groups = [...candidatesByDonor]
    .map(([donorProductId, candidates]) => {
      const donorState = stateByDonor.get(donorProductId);
      if (!donorState || donorState.blockers.length) {
        fail(
          "CONSENSUS_REUSE_PREFLIGHT_WAVE_INVALID",
          `${donorProductId} is not a blocker-free donor`,
        );
      }
      const listingKeys = candidates
        .map((candidate) => candidate.listingKey)
        .sort();
      const rows = expectedWaveRows({
        listings: listingKeys.length,
        donorStates: [donorState],
      });
      if (
        listingKeys.length > PRODUCT_TRUTH_CONSENSUS_REUSE_WAVE_MAX_LISTINGS
        || rows.maximumRows > PRODUCT_TRUTH_CONSENSUS_REUSE_WAVE_MAX_ROWS
      ) {
        fail(
          "CONSENSUS_REUSE_PREFLIGHT_WAVE_INVALID",
          `${donorProductId} cannot fit one complete donor group`,
        );
      }
      return { donorState, listingKeys };
    })
    .sort((left, right) =>
      left.listingKeys[0]!.localeCompare(right.listingKeys[0]!, "en-US"));

  const buckets: Array<{
    listingKeys: string[];
    donorStates: ProductTruthConsensusReuseDonorPreflightState[];
  }> = [];
  for (const group of groups) {
    const current = buckets.at(-1);
    const proposedListingCount =
      (current?.listingKeys.length ?? 0) + group.listingKeys.length;
    const proposedDonors = [
      ...(current?.donorStates ?? []),
      group.donorState,
    ];
    const proposedRows = expectedWaveRows({
      listings: proposedListingCount,
      donorStates: proposedDonors,
    }).maximumRows;
    if (
      !current
      || proposedListingCount
        > PRODUCT_TRUTH_CONSENSUS_REUSE_WAVE_MAX_LISTINGS
      || proposedRows > PRODUCT_TRUTH_CONSENSUS_REUSE_WAVE_MAX_ROWS
    ) {
      buckets.push({
        listingKeys: [...group.listingKeys],
        donorStates: [group.donorState],
      });
    } else {
      current.listingKeys.push(...group.listingKeys);
      current.donorStates.push(group.donorState);
    }
  }

  return buckets.map((bucket, ordinal) => {
    const listingKeys = [...bucket.listingKeys].sort();
    const donorProductIds = bucket.donorStates
      .map((state) => state.donorProductId)
      .sort();
    const rows = expectedWaveRows({
      listings: listingKeys.length,
      donorStates: bucket.donorStates,
    });
    return {
      ordinal,
      waveKey: productTruthOperationalSha256({
        schemaVersion: PRODUCT_TRUTH_CONSENSUS_REUSE_PREFLIGHT_VERSION,
        ordinal,
        listingKeys,
        donorProductIds,
        maximumRows: rows.maximumRows,
      }),
      listingKeys,
      donorProductIds,
      ...rows,
    };
  });
}

function variantMatches(
  row: JsonRow,
  candidate: ProductTruthConsensusReuseCandidate,
): boolean {
  const expected = candidate.proposedCanonicalVariant;
  return [
    "id",
    "variantKey",
    "identityHash",
    "keyVersion",
    "normalizedBrand",
    "normalizedProductLine",
    "normalizedFlavor",
    "normalizedModifiersJson",
    "normalizedForm",
    "sizeDimension",
    "sizeBaseAmount",
    "sizeBaseUnit",
    "outerPackCount",
    "identityJson",
  ].every((column) =>
    sameScalar(row[column], expected[column as keyof typeof expected]));
}

function sourceComponentMatches(
  row: JsonRow,
  candidate: ProductTruthConsensusReuseCandidate,
): boolean {
  const linkedDonor =
    row.contentDonorProductId ?? row.donorProductId;
  return row.id === candidate.legacyComponentId
    && row.sku === candidate.sku
    && Number(row.idx) === candidate.componentIndex
    && Number(row.qty) === candidate.quantity
    && linkedDonor === candidate.donorProductId;
}

export async function preflightProductTruthConsensusReuse(input: {
  db: Client;
  databaseTargetFingerprint: string;
  scope: ProductTruthConsensusReuseScope;
  scopeJson: string;
  scopeSha256: string;
  checkedAt: string;
}): Promise<ProductTruthConsensusReusePreflightReport> {
  const checkedAt = exactInstant(input.checkedAt, "checkedAt");
  const scopeSha256 = exactSha256(input.scopeSha256, "scopeSha256");
  if (
    input.scope.schemaVersion !== PRODUCT_TRUTH_CONSENSUS_REUSE_SCOPE_VERSION
    || renderProductTruthConsensusReuseScope(input.scope) !== input.scopeJson
    || bytesSha256(input.scopeJson) !== scopeSha256
  ) {
    fail(
      "CONSENSUS_REUSE_PREFLIGHT_SCOPE_INVALID",
      "scope bytes, hash or schema are invalid",
    );
  }
  if (
    input.databaseTargetFingerprint
      !== input.scope.source.recipeRepairScope.targetFingerprint
  ) {
    fail(
      "CONSENSUS_REUSE_PREFLIGHT_DATABASE_TARGET_MISMATCH",
      "database fingerprint differs from bound repair scope",
    );
  }
  await assertProductTruthEvidenceSchema(input.db);
  await assertProductTruthListingScopeSchema(input.db);

  const direct = input.scope.candidates.filter(
    (candidate) => candidate.lane === "DIRECT_SINGLE_VARIANT",
  );
  const listingKeys = direct.map((candidate) => candidate.listingKey);
  const donorIds = [...new Set(
    direct.map((candidate) => candidate.donorProductId),
  )];
  const variantIds = [...new Set(
    direct.map((candidate) => candidate.proposedCanonicalVariant.id),
  )];
  const componentIds = direct.flatMap((candidate) =>
    candidate.legacyComponentId ? [candidate.legacyComponentId] : []);

  // libSQL remote clients can stall when several large IN queries and a
  // PRAGMA share one HTTP/2 connection concurrently. These reads are small
  // and bounded (at most one selected scope), so deterministic sequencing is
  // both faster under contention and prevents orphaned preflight processes.
  const listingRows = await queryByValues({
    db: input.db,
    table: "ProductTruthListingScope",
    key: "listingKey",
    values: listingKeys,
    columns: [
      "listingKey", "channel", "storeIndex", "sku", "manifestSha256",
    ],
  });
  const recipeRows = await queryByValues({
    db: input.db,
    table: "ProductTruthListingRecipe",
    key: "listingKey",
    values: listingKeys,
    columns: ["id", "listingKey", "recipeHash", "sourceArtifactSha256"],
  });
  const componentRows = await queryByValues({
    db: input.db,
    table: "SkuComponent",
    key: "id",
    values: componentIds,
    columns: [
      "id", "sku", "idx", "qty", "donorProductId",
      "contentDonorProductId",
    ],
  });
  const donorRows = await queryByValues({
    db: input.db,
    table: "DonorProduct",
    key: "id",
    values: donorIds,
    columns: [
      "id", "title", "size", "identityStatus", "identityMatcherVersion",
      "identityMatcherImplementationSha256", "identityMatcherReleaseSha256",
      "identityKey", "brand", "productLine", "flavor", "containerType",
    ],
  });
  const decisionRows = await queryByValues({
    db: input.db,
    table: "DonorProductVariantDecision",
    key: "donorProductId",
    values: donorIds,
    columns: [
      "id", "donorProductId", "canonicalVariantId", "decisionStatus",
      "decidedAt",
    ],
  });
  const variantRows = await queryByValues({
    db: input.db,
    table: "CanonicalProductVariant",
    key: "id",
    values: variantIds,
    columns: [
      "id", "variantKey", "identityHash", "keyVersion", "normalizedBrand",
      "normalizedProductLine", "normalizedFlavor", "normalizedModifiersJson",
      "normalizedForm", "sizeDimension", "sizeBaseAmount", "sizeBaseUnit",
      "outerPackCount", "identityJson",
    ],
  });
  const foreignKeyViolations =
    await checkProductTruthConsensusReuseForeignKeys(input.db);
  const listingByKey = uniqueBy(
    listingRows,
    (row) => String(row.listingKey),
    "listing scope",
  );
  const recipesByListing = Map.groupBy(
    recipeRows,
    (row) => String(row.listingKey),
  );
  const componentById = uniqueBy(
    componentRows,
    (row) => String(row.id),
    "source component",
  );
  const donorById = uniqueBy(
    donorRows as unknown as DonorState[],
    (row) => row.id,
    "donor product",
  );
  const decisionsByDonor = Map.groupBy(
    (decisionRows as unknown as DecisionState[]).filter(
      (row) => row.decisionStatus === "exact_confirmed",
    ),
    (row) => row.donorProductId,
  );
  const variantById = uniqueBy(
    variantRows,
    (row) => String(row.id),
    "canonical variant",
  );

  const blockers: ProductTruthConsensusReusePreflightBlocker[] =
    foreignKeyViolations.map((row) =>
      blocker({
        code: "FOREIGN_KEY_VIOLATION",
        scope: "DATABASE",
        listingKey: null,
        donorProductId: null,
        message: renderProductTruthOperationalJson(row).trim(),
      }));
  const listingBlockers = new Map<
    string,
    ProductTruthConsensusReusePreflightBlocker[]
  >();
  for (const candidate of direct) {
    const candidateBlockers: ProductTruthConsensusReusePreflightBlocker[] = [];
    const listing = listingByKey.get(candidate.listingKey);
    if (!listing) {
      candidateBlockers.push(blocker({
        code: "LISTING_SCOPE_MISSING",
        scope: "LISTING",
        listingKey: candidate.listingKey,
        donorProductId: candidate.donorProductId,
        message: "authoritative listing scope row is absent",
      }));
    } else {
      if (
        listing.channel !== candidate.channel
        || Number(listing.storeIndex) !== candidate.storeIndex
        || listing.sku !== candidate.sku
      ) {
        candidateBlockers.push(blocker({
          code: "LISTING_SCOPE_IDENTITY_DRIFT",
          scope: "LISTING",
          listingKey: candidate.listingKey,
          donorProductId: candidate.donorProductId,
          message: "channel/store/SKU differs from immutable candidate",
        }));
      }
      if (
        listing.manifestSha256
          !== input.scope.source.recipeRepairScope.manifestSha256
      ) {
        candidateBlockers.push(blocker({
          code: "LISTING_SCOPE_MANIFEST_DRIFT",
          scope: "LISTING",
          listingKey: candidate.listingKey,
          donorProductId: candidate.donorProductId,
          message: "listing scope belongs to a different manifest",
        }));
      }
    }
    if ((recipesByListing.get(candidate.listingKey) ?? []).length > 0) {
      candidateBlockers.push(blocker({
        code: "LISTING_RECIPE_ALREADY_EXISTS",
        scope: "LISTING",
        listingKey: candidate.listingKey,
        donorProductId: candidate.donorProductId,
        message: "append-only listing recipe is already present",
      }));
    }
    if (candidate.legacyComponentId) {
      const component = componentById.get(candidate.legacyComponentId);
      if (!component) {
        candidateBlockers.push(blocker({
          code: "SOURCE_COMPONENT_MISSING",
          scope: "LISTING",
          listingKey: candidate.listingKey,
          donorProductId: candidate.donorProductId,
          message: `${candidate.legacyComponentId} is absent`,
        }));
      } else if (!sourceComponentMatches(component, candidate)) {
        candidateBlockers.push(blocker({
          code: "SOURCE_COMPONENT_DRIFT",
          scope: "LISTING",
          listingKey: candidate.listingKey,
          donorProductId: candidate.donorProductId,
          message: `${candidate.legacyComponentId} critical fields drifted`,
        }));
      }
    }
    listingBlockers.set(candidate.listingKey, candidateBlockers);
    blockers.push(...candidateBlockers);
  }

  const candidatesByDonor = Map.groupBy(
    direct,
    (candidate) => candidate.donorProductId,
  );
  const donorStates: ProductTruthConsensusReuseDonorPreflightState[] = [];
  for (const [donorProductId, candidates] of candidatesByDonor) {
    const first = candidates[0]!;
    const proposedIds = new Set(
      candidates.map(
        (candidate) => candidate.proposedCanonicalVariant.id,
      ),
    );
    if (proposedIds.size !== 1) {
      fail(
        "CONSENSUS_REUSE_PREFLIGHT_SCOPE_INVALID",
        `${donorProductId} direct lane contains multiple variants`,
      );
    }
    const donorBlockers: ProductTruthConsensusReusePreflightBlocker[] = [];
    const donor = donorById.get(donorProductId);
    if (!donor) {
      donorBlockers.push(blocker({
        code: "DONOR_PRODUCT_MISSING",
        scope: "DONOR",
        listingKey: null,
        donorProductId,
        message: "donor product is absent",
      }));
    } else {
      if (donor.title !== first.donorTitle) {
        donorBlockers.push(blocker({
          code: "DONOR_TITLE_DRIFT",
          scope: "DONOR",
          listingKey: null,
          donorProductId,
          message: "current donor title differs from immutable evidence",
        }));
      }
      if (
        first.donorDeclaredSize !== null
        && donor.size !== first.donorDeclaredSize
      ) {
        donorBlockers.push(blocker({
          code: "DONOR_SIZE_DRIFT",
          scope: "DONOR",
          listingKey: null,
          donorProductId,
          message: "current donor size differs from frozen review evidence",
        }));
      }
    }
    const exactDecisions = decisionsByDonor.get(donorProductId) ?? [];
    let decisionState:
      ProductTruthConsensusReuseDonorPreflightState["decisionState"] =
      "CREATE";
    let existingDecision:
      ProductTruthConsensusReuseDonorPreflightState["existingDecision"] =
      null;
    let donorTransitionRequired = true;
    if (exactDecisions.length > 1) {
      donorBlockers.push(blocker({
        code: "DONOR_EXACT_DECISION_COLLISION",
        scope: "DONOR",
        listingKey: null,
        donorProductId,
        message: "multiple exact decisions violate one-donor invariant",
      }));
    } else if (exactDecisions.length === 1) {
      const exactDecision = exactDecisions[0]!;
      if (
        exactDecision.canonicalVariantId
          !== first.proposedCanonicalVariant.id
      ) {
        donorBlockers.push(blocker({
          code: "DONOR_EXACT_DECISION_COLLISION",
          scope: "DONOR",
          listingKey: null,
          donorProductId,
          message:
            `existing ${exactDecision.canonicalVariantId} != proposed `
            + first.proposedCanonicalVariant.id,
        }));
      } else {
        decisionState = "REUSE";
        existingDecision = {
          id: exactDecision.id,
          decidedAt: exactDecision.decidedAt,
        };
        donorTransitionRequired = false;
      }
    }
    if (
      donor
      && (
        (donor.identityStatus === "exact_confirmed"
          && exactDecisions.length !== 1)
        || (donor.identityStatus !== "exact_confirmed"
          && exactDecisions.length === 1)
      )
    ) {
      donorBlockers.push(blocker({
        code: "DONOR_IDENTITY_STATE_INVALID",
        scope: "DONOR",
        listingKey: null,
        donorProductId,
        message: "donor identity projection and exact decision disagree",
      }));
    }
    const variant = variantById.get(first.proposedCanonicalVariant.id);
    let variantState:
      ProductTruthConsensusReuseDonorPreflightState["variantState"] =
      "CREATE";
    if (variant) {
      if (!variantMatches(variant, first)) {
        donorBlockers.push(blocker({
          code: "CANONICAL_VARIANT_COLLISION",
          scope: "DONOR",
          listingKey: null,
          donorProductId,
          message: `${first.proposedCanonicalVariant.id} columns drifted`,
        }));
      } else {
        variantState = "REUSE";
      }
    }
    blockers.push(...donorBlockers);
    const sourceIdentity = {
      identityKey: donor?.identityKey ?? "",
      identityStatus: donor?.identityStatus ?? "MISSING",
      brand: donor?.brand ?? null,
      productLine: donor?.productLine ?? null,
      flavor: donor?.flavor ?? null,
      containerType: donor?.containerType ?? null,
      size: donor?.size ?? null,
    };
    donorStates.push({
      donorProductId,
      listingKeys: candidates.map((candidate) => candidate.listingKey).sort(),
      proposedCanonicalVariantId: first.proposedCanonicalVariant.id,
      variantState,
      decisionState,
      existingDecision,
      donorTransitionRequired,
      sourceIdentity,
      sourceIdentitySha256:
        productTruthOperationalSha256(sourceIdentity),
      blockers: donorBlockers,
    });
  }

  const databaseBlocked = blockers.some(
    (row) => row.scope === "DATABASE",
  );
  const readyDonorStates = donorStates.filter((state) =>
    !databaseBlocked
    && state.blockers.length === 0
    && state.listingKeys.every(
      (listingKey) => (listingBlockers.get(listingKey) ?? []).length === 0,
    ));
  const readyDonorIds = new Set(
    readyDonorStates.map((state) => state.donorProductId),
  );
  const readyCandidates = direct.filter((candidate) =>
    readyDonorIds.has(candidate.donorProductId));
  const waves = buildProductTruthConsensusReuseWaves({
    candidates: readyCandidates,
    donorStates: readyDonorStates,
  });
  const readyListingKeys = readyCandidates
    .map((candidate) => candidate.listingKey)
    .sort();
  const readyDonorProductIds = [...readyDonorIds].sort();
  const blockedListingKeys = new Set(
    direct
      .filter((candidate) => !readyDonorIds.has(candidate.donorProductId))
      .map((candidate) => candidate.listingKey),
  );
  const aggregate = expectedWaveRows({
    listings: readyCandidates.length,
    donorStates: readyDonorStates,
  });
  const status =
    readyCandidates.length === direct.length && blockers.length === 0
      ? "READY_TO_PLAN"
      : readyCandidates.length > 0
        ? "PARTIALLY_READY"
        : "BLOCKED";
  return {
    schemaVersion: PRODUCT_TRUTH_CONSENSUS_REUSE_PREFLIGHT_VERSION,
    status,
    checkedAt,
    databaseTargetFingerprint: input.databaseTargetFingerprint,
    source: {
      consensusReuseScopeSha256: scopeSha256,
      consensusReuseScopeGeneratedAt: input.scope.generatedAt,
      targetFingerprint:
        input.scope.source.recipeRepairScope.targetFingerprint,
      manifestSha256:
        input.scope.source.recipeRepairScope.manifestSha256,
    },
    counts: {
      selectedCandidates: input.scope.counts.selected,
      reconciliationCandidatesQuarantined:
        input.scope.counts.fieldPartitionReconciliationRequired,
      directCandidates: direct.length,
      directDonors: donorStates.length,
      readyListings: readyCandidates.length,
      readyDonors: readyDonorStates.length,
      blockedListings: blockedListingKeys.size,
      blockedDonors: donorStates.length - readyDonorStates.length,
      canonicalVariantCreates: aggregate.canonicalVariantCreates,
      canonicalVariantReuses: aggregate.canonicalVariantReuses,
      decisionCreates: aggregate.decisionCreates,
      decisionReuses: aggregate.decisionReuses,
      donorTransitions: aggregate.donorTransitions,
      existingRecipes: recipeRows.length,
      recommendedWaves: waves.length,
    },
    blockers: blockers.sort((left, right) =>
      left.code.localeCompare(right.code, "en-US")
      || (left.donorProductId ?? "").localeCompare(
        right.donorProductId ?? "",
        "en-US",
      )
      || (left.listingKey ?? "").localeCompare(
        right.listingKey ?? "",
        "en-US",
      )),
    readyListingKeys,
    readyDonorProductIds,
    readyDonorStates: readyDonorStates.map((state) => ({
      donorProductId: state.donorProductId,
      proposedCanonicalVariantId: state.proposedCanonicalVariantId,
      variantState: state.variantState,
      decisionState: state.decisionState,
      existingDecision: state.existingDecision,
      donorTransitionRequired: state.donorTransitionRequired,
      sourceIdentity: state.sourceIdentity,
      sourceIdentitySha256: state.sourceIdentitySha256,
      listingKeys: state.listingKeys,
    })),
    waves,
    claims: {
      readOnlyDatabase: true,
      databaseWrites: 0,
      providerCalls: 0,
      paidCalls: 0,
      retailerFetches: 0,
      marketplaceMutations: 0,
      authorizesExecution: false,
      completeDonorGroupsOnly: true,
      maxListingsPerWave:
        PRODUCT_TRUTH_CONSENSUS_REUSE_WAVE_MAX_LISTINGS,
      maxRowsPerWave: PRODUCT_TRUTH_CONSENSUS_REUSE_WAVE_MAX_ROWS,
    },
  };
}

export function renderProductTruthConsensusReusePreflight(
  value: ProductTruthConsensusReusePreflightReport,
): string {
  return renderProductTruthOperationalJson(value);
}
