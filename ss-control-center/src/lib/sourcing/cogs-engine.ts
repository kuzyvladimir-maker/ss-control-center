// COGS engine — the shared per-SKU costing core, used by BOTH the CLI batch runner
// (scripts/cogs-enrich-batch.ts) and the background cron (/api/cron/cogs-sweep).
//
// For ONE of our listings it: identifies the exact product (title + description +
// ALL photos, bundles decomposed), then walks the COST LADDER:
//   TIER 0  own-brand   — our own products (Starfit / Salutem Vita), manual landed cost
//   TIER 1  exact 1P    — clean first-party direct price at Walmart/Target/Sam's/Costco
//   TIER 1b cross-size  — same product, 0.25x-4x size, converted by $/measure (est)
//   TIER 2  line-price  — same-brand + same-size sibling (variety line, ±cents)
//   (no Google tier: 3P reseller prices are not our cost — first-party or UNSOURCEABLE)
// then writes SkuCost (the roll-up total) + SkuComponent (the structural bill-of-
// materials, one row per part, each linked to its donor product for full content).
//
// Every estimate (cross-size / line-price / COGS>=sale / low-confidence) is flagged
// needsReview; no clean 1P anywhere → honest UNSOURCEABLE marker (delist candidate).

import { createHash } from "node:crypto";

import { type Client, type InStatement } from "@libsql/client";
import {
  identifyProduct,
  gatherAmazonInputs,
  gatherWalmartInputs,
} from "@/lib/sourcing/identify";
import { enrichTarget } from "@/lib/sourcing/donor-catalog";
import {
  OWN_BRAND_COST_POLICY_VERSION,
  ownBrandCost,
} from "@/lib/sourcing/own-brand-costs";
import {
  selectCanonicalCostEvidence,
  type CanonicalCostCandidate,
  type CanonicalCostSelection,
} from "@/lib/sourcing/canonical-cost-selection";
import {
  CANONICAL_PRODUCT_MATCHER_VERSION,
  normalizeIdentityTokens,
  type CanonicalProductIdentity,
} from "@/lib/sourcing/canonical-product-match";
import {
  buildCanonicalProductVariantKey,
  type CanonicalProductVariantKey,
} from "@/lib/sourcing/canonical-product-variant";
import {
  PRICE_EVIDENCE_POLICY_VERSION,
  PRODUCT_TRUTH_PROCUREMENT_ZIP,
} from "@/lib/sourcing/price-evidence-policy";
import {
  assertProductTruthEvidenceSchema,
  assertProductTruthListingScopeSchema,
} from "@/lib/sourcing/product-truth-schema-gate";
import {
  SKU_COST_LISTING_SCOPE_LINK_VERSION,
  buildProductTruthListingScope,
} from "@/lib/sourcing/product-truth-listing-scope";
import {
  currentMeteredRunPermit,
} from "@/lib/sourcing/metered-call-guard";
import { isMeteredProviderControlError } from "@/lib/sourcing/metered-provider-call";
import { getMerchantToken } from "@/lib/amazon-sp-api/sellers";
import { listSkus } from "@/lib/amazon-sp-api/listings";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Operational paid-source calls are deliberately serialized. The semaphore is
// module-global, so even separate costOneSku callers cannot fan out retailer-search
// groups behind the durable budget ledger.
function makeSemaphore(max: number) {
  let active = 0;
  const q: (() => void)[] = [];
  return {
    async acquire() { while (active >= max) await new Promise<void>((r) => q.push(r)); active++; },
    release() { active--; const n = q.shift(); if (n) n(); },
  };
}
export const COGS_COMPONENT_CONCURRENCY = 1 as const;
const SEARCH_SEM = makeSemaphore(COGS_COMPONENT_CONCURRENCY);

// One durable attempt under the global concurrency cap. Provider retries belong
// to a newly owner-authorized queue job: replaying the same metered fingerprint
// inside this call would either double-spend or collide with the budget ledger.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function enrichOnce(db: Client, opts: any): Promise<any> {
  await SEARCH_SEM.acquire();
  try {
    return await enrichTarget(db, opts);
  } finally { SEARCH_SEM.release(); }
}

const firstToken = (s?: string) => (s || "").trim().toLowerCase().split(/\s+/)[0] || "";

const FILLER = new Set(["the", "and", "with", "for", "of", "a", "an", "size", "oz", "lb", "lbs", "fl", "ml", "g", "kg", "ct", "count", "pack", "pk", "box", "boxes", "can", "cans", "bag", "bags", "cup", "cups", "pouch", "jar", "bottle", "loaf", "loaves", "tray", "case", "each", "variety", "original", "classic", "brand", "new"]);
// Distinctive lowercased words from the product line/flavor (or a component name) —
// used to pin the cost readback to the EXACT product, not just its brand.
function distinctiveTokens(...parts: (string | undefined)[]): string[] {
  const words = parts.filter(Boolean).join(" ").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/);
  const out: string[] = []; const seen = new Set<string>();
  for (const w of words) { if (w.length < 3 || FILLER.has(w) || /^\d+$/.test(w) || seen.has(w)) continue; seen.add(w); out.push(w); }
  return out.slice(0, 3);
}
function parseSizeNum(size?: string | null): number | null {
  const m = String(size || "").match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : null;
}

function componentCanonicalProduct(product?: string | null, flavor?: string | null, size?: string | null) {
  const words = String(product || "").trim().split(/\s+/).filter(Boolean);
  return {
    brand: words[0] || undefined,
    product_line: words.slice(1).join(" ") || undefined,
    flavor: flavor || undefined,
    size: size || undefined,
    outer_pack_count: 1,
  };
}

// --- SKU enumeration --------------------------------------------------------
// Resumable sweep: prefer PUBLISHED SKUs NOT yet costed by this engine (LEFT JOIN
// SkuCost source='retail:batch' IS NULL). Each run advances through the catalog; a
// re-run continues where the last left off, and flagged/no-price SKUs (no SkuCost)
// get retried — which recovers the flaky niche items on a later pass.
// PRIORITY QUEUE (division-of-labor contract, 2026-07-08): the image/content chat
// consumes enriched SKUs and never identifies/searches itself. When it needs specific
// SKUs next, it writes them to Setting key 'enrich_priority_skus' (JSON array) and
// every enrichment driver here serves those FIRST.
export async function enrichPrioritySkus(db: Client): Promise<string[]> {
  try {
    const r = await db.execute(`SELECT value FROM "Setting" WHERE key='enrich_priority_skus' LIMIT 1`);
    const v = JSON.parse(String((r.rows[0] as any)?.value || "[]"));
    return Array.isArray(v) ? v.filter((x) => typeof x === "string" && x) : [];
  } catch { return []; }
}

export async function nextUncostedWalmartSkus(db: Client, n: number): Promise<string[]> {
  // Neighbor-chat priority list first (only those still uncosted).
  const out: string[] = [];
  for (const sku of await enrichPrioritySkus(db)) {
    if (out.length >= n) break;
    const c = await db.execute({ sql: `SELECT 1 FROM "SkuCost" WHERE sku=? AND source='retail:batch' LIMIT 1`, args: [sku] });
    if (!c.rows.length) out.push(sku);
  }
  if (out.length < n) {
    const r = await db.execute({
      sql: `SELECT w.sku FROM WalmartCatalogItem w
            LEFT JOIN "SkuCost" c ON c.sku = w.sku AND c.source='retail:batch'
            WHERE w.publishedStatus='PUBLISHED' AND c.sku IS NULL
            ORDER BY w.syncedAt DESC LIMIT ?`,
      args: [n],
    });
    for (const x of r.rows) { const s = (x as any).sku as string; if (s && !out.includes(s)) out.push(s); if (out.length >= n) break; }
  }
  return out;
}
// How many PUBLISHED Walmart SKUs still lack a cost (sweep progress denominator).
export async function walmartSweepRemaining(db: Client): Promise<{ remaining: number; total: number }> {
  const rem = await db.execute(`SELECT COUNT(*) AS n FROM WalmartCatalogItem w LEFT JOIN "SkuCost" c ON c.sku=w.sku AND c.source='retail:batch' WHERE w.publishedStatus='PUBLISHED' AND c.sku IS NULL`);
  const tot = await db.execute(`SELECT COUNT(*) AS n FROM WalmartCatalogItem WHERE publishedStatus='PUBLISHED'`);
  return { remaining: Number((rem.rows[0] as any)?.n || 0), total: Number((tot.rows[0] as any)?.n || 0) };
}
export async function amazonSkus(n: number): Promise<string[]> {
  const out: string[] = [];
  for (const store of [1, 3]) {
    if (out.length >= n) break;
    try {
      const sellerId = await getMerchantToken(store);
      let token: string | undefined;
      do {
        const page = await listSkus(store, sellerId, { pageSize: 20, includedData: ["summaries"], pageToken: token });
        for (const it of page.items) { if (it.sku) out.push(it.sku); if (out.length >= n) break; }
        token = page.pagination?.nextToken;
        await sleep(250);
      } while (token && out.length < n);
    } catch { /* enumeration skipped for this store */ }
  }
  return out.slice(0, n);
}

// --- cost readback: canonical identity + immutable local price observation --------
const COST_EVIDENCE_MAX_AGE_MS = 48 * 60 * 60 * 1000;

type CostMethod =
  | "exact"
  | "cross-size"
  | "sibling"
  | "size-unknown"
  | "instacart-estimate";

type CostHit = {
  perUnit: number;
  retailer: string;
  title: string;
  size: string;
  method: CostMethod;
  outcome: "FACT" | "ESTIMATE";
  donorProductId: string | null;
  contentDonorProductId: string | null;
  priceEvidenceDonorProductId: string | null;
  priceEvidenceOfferId: string | null;
  priceEvidenceObservationId: string | null;
  targetCanonicalVariantId: string;
  contentCanonicalVariantId: string | null;
  priceCanonicalVariantId: string;
  contentObservationId: string | null;
  priceVariantDecisionId: string;
  evidenceAnchorAt: string;
  matchTier: string;
  matcherVersion: string;
  pricePolicyVersion: string;
};

type CostLookup = {
  hit: CostHit | null;
  content: ContentObservationHit | null;
  evidenceJson: string;
  selection: CanonicalCostSelection;
};

// (Google Shopping as a COST source was removed: it returns 3P resellers — often our
// own STARFITSTORE resale — never a shelf price. First-party or UNSOURCEABLE.)

// Brand as tokens: up to 2 significant words ("Pasta Zara" → ["pasta","zara"]), all
// required in a match. A single first-token let cross-brand matches through (audit).
function brandTokens(...parts: (string | undefined)[]): string[] {
  const words = parts.filter(Boolean).join(" ").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/);
  return words.filter((w) => w.length > 2 && !FILLER.has(w)).slice(0, 2);
}

function canonicalCostIdentity(cp: {
  brand?: string;
  product_line?: string;
  flavor?: string;
  size?: string;
  base_unit?: string;
  container_type?: string;
  outer_pack_count?: number;
}, title: string): CanonicalProductIdentity {
  return {
    brand: cp.brand,
    productLine: cp.product_line,
    flavor: cp.flavor,
    form: cp.container_type || cp.base_unit,
    size: cp.size,
    outerPackCount: cp.outer_pack_count ?? 1,
    title,
  };
}

function boolFromDb(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  return null;
}

function compactSelectionEvidence(selection: CanonicalCostSelection): string {
  const evidence = {
    schemaVersion: "product-truth-cost-selection/1.0.0",
    selectorVersion: selection.selectorVersion,
    outcome: selection.outcome,
    evaluatedCandidateCount: selection.evaluatedCandidateCount,
    eligibleFactCount: selection.eligibleFactCount,
    eligibleEstimateCount: selection.eligibleEstimateCount,
    selected: selection.selected,
    evaluations: selection.evaluations.map((item) => ({
      donorOfferObservationId: item.candidate.donorOfferObservationId,
      donorOfferId: item.candidate.donorOfferId,
      donorProductId: item.candidate.donorProductId,
      canonicalVariantId: item.candidate.canonicalVariantId ?? null,
      variantDecisionId: item.candidate.variantDecisionId ?? null,
      matchMode: item.matchMode,
      matchVerdict: item.match.verdict,
      matchReasonCodes: item.match.reasonCodes,
      priceEligibility: item.priceEvidence.eligibility,
      priceReasonCodes: item.priceEvidence.reasonCodes,
      selectorEligibility: item.selectorEligibility,
      selectorReasonCodes: item.selectorReasonCodes,
    })),
  };
  // `ageMs` is derived from observedAt + the query clock. Persisting it would
  // make the same immutable source observation produce a different row on every
  // replay. Store the source timestamp and decision codes; age is derivable.
  return JSON.stringify(stableEvidenceForHash(evidence));
}

function latestIsoTimestamp(
  values: Array<string | Date | null | undefined>,
  fallback: string,
): string {
  const timestamps = values
    .map((value) => value == null
      ? Number.NaN
      : value instanceof Date ? value.getTime() : Date.parse(value))
    .filter(Number.isFinite);
  if (!timestamps.length) {
    const parsed = Date.parse(fallback);
    const hour = Math.floor(parsed / (60 * 60 * 1000)) * 60 * 60 * 1000;
    return new Date(hour).toISOString();
  }
  return new Date(Math.max(...timestamps)).toISOString();
}

type ContentObservationHit = {
  id: string;
  donorProductId: string;
  canonicalVariantId: string;
  sourceUrl: string;
  sourceApi: string;
  contentHash: string;
  observedAt: string;
  contentJson: unknown;
  completeness: number;
};

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function contentCompleteness(content: Record<string, unknown>): number {
  const nonEmpty = (value: unknown) =>
    typeof value === "string" ? value.trim().length > 0 : value != null;
  const arrayLength = (value: unknown) => Array.isArray(value) ? value.length : 0;
  return (
    (nonEmpty(content.upc) || nonEmpty(content.gtin) ? 25 : 0)
    + (nonEmpty(content.ingredients) ? 20 : 0)
    + (nonEmpty(content.nutritionFacts) ? 20 : 0)
    + (nonEmpty(content.description) ? 10 : 0)
    + Math.min(arrayLength(content.bullets), 10)
    + Math.min(arrayLength(content.imageUrls), 10)
    + (nonEmpty(content.title) ? 5 : 0)
  );
}

/** Pick the richest immutable exact snapshot, then newest/stable as tie-breakers. */
async function bestContentObservationForVariant(
  db: Client,
  canonicalVariantId: string,
  evaluationNow: string,
): Promise<ContentObservationHit | null> {
  const rows = (await db.execute({
    sql: `SELECT content.id, content.donorProductId, content.canonicalVariantId,
                 content.sourceUrl, content.sourceApi, content.contentHash,
                 content.contentJson, content.observedAt
          FROM "ProductContentObservation" content
          JOIN "DonorProductVariantDecision" decision
            ON decision.id=content.variantDecisionId
           AND decision.donorProductId=content.donorProductId
           AND decision.canonicalVariantId=content.canonicalVariantId
           AND decision.decisionStatus='exact_confirmed'
           AND decision.matcherVersion=?
          WHERE content.canonicalVariantId=? AND content.observedAt<=?
          ORDER BY content.observedAt DESC, content.id ASC`,
    args: [CANONICAL_PRODUCT_MATCHER_VERSION, canonicalVariantId, evaluationNow],
  })).rows;
  const candidates = rows.map((row) => {
    const contentJson = parseJsonObject(row.contentJson);
    return {
      id: String(row.id),
      donorProductId: String(row.donorProductId),
      canonicalVariantId: String(row.canonicalVariantId),
      sourceUrl: String(row.sourceUrl),
      sourceApi: String(row.sourceApi),
      contentHash: String(row.contentHash),
      observedAt: String(row.observedAt),
      contentJson,
      completeness: contentCompleteness(contentJson),
    } satisfies ContentObservationHit;
  });
  candidates.sort((left, right) =>
    right.completeness - left.completeness
    || Date.parse(right.observedAt) - Date.parse(left.observedAt)
    || left.id.localeCompare(right.id));
  return candidates[0] ?? null;
}

function methodForSelection(selection: CanonicalCostSelection): CostMethod | null {
  const selected = selection.selected;
  if (!selected) return null;
  if (selected.candidate.via === "instacart") return "instacart-estimate";
  switch (selected.match.verdict) {
    case "EXACT_IDENTITY": return "exact";
    case "CROSS_SIZE_ESTIMATE": return "cross-size";
    case "SIBLING_ESTIMATE": return "sibling";
    case "SIZE_UNKNOWN_ESTIMATE": return "size-unknown";
    default: return null;
  }
}

async function cheapestCostForTarget(
  db: Client,
  target: CanonicalProductIdentity,
  targetCanonicalVariantId: string,
  evaluationNow: string,
  sourcePolicy: ResolvedCostSourcePolicy,
): Promise<CostLookup> {
  const brandTokens = normalizeIdentityTokens(target.brand);
  const candidateRows = brandTokens.length
    ? (await db.execute({
        // This LIKE is only a broad retrieval prefilter. There is deliberately
        // no semantic SQL LIMIT: every retrieved row must pass the canonical
        // matcher and the locality/freshness/stock/first-party policy below.
        sql: `SELECT
                obs.id AS observationId, obs.donorOfferId AS offerId,
                obs.donorProductId AS donorProductId, obs.title AS observationTitle,
                obs.retailer AS retailer, obs.retailerProductId AS retailerProductId,
                obs.productUrl AS productUrl, obs.price AS observedPrice,
                obs.packSizeSeen AS packSizeSeen, obs.sellerName AS sellerName,
                obs.sourceApi AS sourceApi, obs.via AS via,
                obs.pricePerUnit AS pricePerUnit, obs.isFirstParty AS isFirstParty,
                obs.inStock AS inStock, obs.zip AS zip,
                obs.localityEvidence AS localityEvidence, obs.observedAt AS observedAt,
                obs.canonicalVariantId AS canonicalVariantId,
                obs.variantDecisionId AS variantDecisionId,
                dp.brand AS brand, dp.productLine AS productLine, dp.flavor AS flavor,
                dp.containerType AS containerType, dp.size AS size,
                dp.title AS productTitle, dp.identityStatus AS identityStatus
              FROM "DonorOfferObservation" obs
              JOIN "DonorProduct" dp ON dp.id=obs.donorProductId
              JOIN "DonorProductVariantDecision" decision
                ON decision.id=obs.variantDecisionId
               AND decision.donorProductId=obs.donorProductId
               AND decision.canonicalVariantId=obs.canonicalVariantId
               AND decision.decisionStatus='exact_confirmed'
              WHERE obs.id=(
                SELECT latest.id FROM "DonorOfferObservation" latest
                WHERE latest.donorOfferId=obs.donorOfferId AND latest.observedAt<=?
                ORDER BY latest.observedAt DESC, latest.id DESC LIMIT 1
              )
                AND obs.canonicalVariantId IS NOT NULL
                AND obs.variantDecisionId IS NOT NULL
                AND dp.identityStatus='exact_confirmed'
                AND (
                  lower(COALESCE(dp.brand,'')) LIKE ?
                  OR lower(COALESCE(obs.title,dp.title,'')) LIKE ?
                )
              ORDER BY obs.observedAt DESC, obs.id ASC`,
        args: [
          evaluationNow,
          `%${brandTokens[0].replace(/s$/, "")}%`,
          `%${brandTokens[0].replace(/s$/, "")}%`,
        ],
      })).rows
    : [];

  const candidates: CanonicalCostCandidate[] = candidateRows
    .filter((row) => costSourcePolicyAllowsRetailer(sourcePolicy, row.retailer))
    .map((row) => {
    const rawTitle = String(row.observationTitle || row.productTitle || "") || null;
    const structured = row.identityStatus === "exact_confirmed"
      ? {
          brand: row.brand == null ? null : String(row.brand),
          productLine: row.productLine == null ? null : String(row.productLine),
          flavor: row.flavor == null ? null : String(row.flavor),
          form: row.containerType == null ? null : String(row.containerType),
          size: row.size == null ? null : String(row.size),
          outerPackCount: 1,
          title: rawTitle,
        }
      : null;
    return {
      donorOfferObservationId: row.observationId == null ? null : String(row.observationId),
      donorOfferId: row.offerId == null ? null : String(row.offerId),
      donorProductId: row.donorProductId == null ? null : String(row.donorProductId),
      canonicalVariantId: row.canonicalVariantId == null ? null : String(row.canonicalVariantId),
      variantDecisionId: row.variantDecisionId == null ? null : String(row.variantDecisionId),
      retailerProductId: row.retailerProductId == null ? null : String(row.retailerProductId),
      productUrl: row.productUrl == null ? null : String(row.productUrl),
      observedPrice: typeof row.observedPrice === "number" ? row.observedPrice : null,
      packSizeSeen: typeof row.packSizeSeen === "number" ? row.packSizeSeen : null,
      sellerName: row.sellerName == null ? null : String(row.sellerName),
      sourceApi: row.sourceApi == null ? null : String(row.sourceApi),
      donorIdentity: structured,
      rawTitle,
      rawBrand: row.brand == null ? null : String(row.brand),
      retailer: row.retailer == null ? null : String(row.retailer),
      via: row.via == null ? null : String(row.via),
      price: typeof row.pricePerUnit === "number" ? row.pricePerUnit : null,
      isFirstParty: boolFromDb(row.isFirstParty),
      inStock: boolFromDb(row.inStock),
      zip: row.zip == null ? null : String(row.zip),
      localityEvidence: row.localityEvidence == null ? null : String(row.localityEvidence),
      fetchedAt: row.observedAt == null ? null : String(row.observedAt),
    };
  });
  const selection = selectCanonicalCostEvidence(target, candidates, {
    now: evaluationNow,
    maxAgeMs: COST_EVIDENCE_MAX_AGE_MS,
  }, { targetCanonicalVariantId });
  // Content is an independent truth axis. A factual, estimated, or rejected
  // price decision must neither create nor suppress exact target content.
  const content = await bestContentObservationForVariant(
    db,
    targetCanonicalVariantId,
    evaluationNow,
  );
  const method = methodForSelection(selection);
  const selected = selection.selected;
  const perUnit = selection.targetComparablePrice;
  const evidenceJson = compactSelectionEvidence(selection);
  const evidenceWithContent = JSON.stringify({
    ...parseJsonObject(evidenceJson),
    contentContract: content ? {
      status: "EXACT_CONTENT_SELECTED",
      observationId: content.id,
      donorProductId: content.donorProductId,
      canonicalVariantId: content.canonicalVariantId,
      sourceUrl: content.sourceUrl,
      sourceApi: content.sourceApi,
      contentHash: content.contentHash,
      observedAt: content.observedAt,
      completeness: content.completeness,
    } : {
      status: "EXACT_CONTENT_NOT_AVAILABLE",
      targetCanonicalVariantId,
    },
  });
  if (!selected || !method || perUnit == null) {
    return { hit: null, content, evidenceJson: evidenceWithContent, selection };
  }

  const priceCanonicalVariantId = selected.candidate.canonicalVariantId;
  const priceVariantDecisionId = selected.candidate.variantDecisionId;
  if (!priceCanonicalVariantId || !priceVariantDecisionId) {
    return { hit: null, content, evidenceJson: evidenceWithContent, selection };
  }

  return {
    selection,
    content,
    evidenceJson: evidenceWithContent,
    hit: {
      perUnit,
      retailer: String(selected.candidate.retailer || ""),
      title: String(selected.candidate.rawTitle || ""),
      size: String(selected.candidate.donorIdentity?.size || ""),
      method,
      outcome: selection.outcome === "FACT" ? "FACT" : "ESTIMATE",
      donorProductId: content?.donorProductId ?? null,
      contentDonorProductId: content?.donorProductId ?? null,
      priceEvidenceDonorProductId: selection.priceEvidenceDonorProductId,
      priceEvidenceOfferId: selected.candidate.donorOfferId,
      priceEvidenceObservationId: selected.candidate.donorOfferObservationId,
      targetCanonicalVariantId,
      contentCanonicalVariantId: content?.canonicalVariantId ?? null,
      priceCanonicalVariantId,
      contentObservationId: content?.id ?? null,
      priceVariantDecisionId,
      evidenceAnchorAt: latestIsoTimestamp([
        selected.candidate.fetchedAt,
        content?.observedAt,
      ], evaluationNow),
      matchTier: selected.match.verdict,
      matcherVersion: selected.match.matcherVersion,
      pricePolicyVersion: selected.priceEvidence.policyVersion,
    },
  };
}

// Commit only the canonical append-only graph. Legacy SkuComponent is keyed by
// raw SKU and cannot represent channel/store scope; a canonical store1 write
// must never erase or collide with store3. It remains explicitly
// non-authoritative and is not materialized by this path.
async function writeComponents(
  db: Client,
  _sku: string,
  _channel: string,
  _parts: any[],
  prefixStatements: InStatement[] = [],
): Promise<void> {
  if (prefixStatements.length) await db.batch(prefixStatements, "write");
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function expectedInsertPayload(
  statement: InStatement,
  defaults: Record<string, unknown> = {},
): Record<string, unknown> {
  if (typeof statement === "string") {
    throw new Error("IMMUTABLE_INSERT_SHAPE_UNRECOGNIZED");
  }
  const match = String(statement.sql).match(/\(([\s\S]*?)\)\s*VALUES\s*\(/i);
  if (!match) throw new Error("IMMUTABLE_INSERT_SHAPE_UNRECOGNIZED");
  const columns = match[1]
    .split(",")
    .map((column) => column.replace(/["`]/g, "").trim())
    .filter(Boolean);
  if (!Array.isArray(statement.args)) {
    throw new Error("IMMUTABLE_INSERT_POSITIONAL_ARGUMENTS_REQUIRED");
  }
  const args = statement.args;
  if (columns.length !== args.length) {
    throw new Error("IMMUTABLE_INSERT_ARGUMENT_COUNT_MISMATCH");
  }
  const payload = { ...defaults };
  columns.forEach((column, index) => {
    if (column !== "createdAt" && column !== "updatedAt") payload[column] = args[index];
  });
  return payload;
}

function comparableScalar(value: unknown): unknown {
  return typeof value === "bigint" ? Number(value) : value;
}

function assertImmutableRowEquivalent(
  current: Record<string, unknown>,
  expected: Record<string, unknown>,
  errorCode: string,
): void {
  const mismatches = Object.entries(expected)
    .filter(([column, value]) => !Object.is(comparableScalar(current[column]), comparableScalar(value)))
    .map(([column]) => column);
  if (mismatches.length) throw new Error(`${errorCode}:${mismatches.join(",")}`);
}

function canonicalVariantInsertStatement(
  variant: CanonicalProductVariantKey,
  createdAt: string,
): InStatement {
  const row = variant.db;
  return {
    sql: `INSERT INTO "CanonicalProductVariant"
      (id, variantKey, identityHash, keyVersion, normalizedBrand,
       normalizedProductLine, normalizedFlavor, normalizedModifiersJson,
       normalizedForm, sizeDimension, sizeBaseAmount, sizeBaseUnit,
       outerPackCount, identityJson, createdAt)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      row.id, row.variantKey, row.identityHash, row.keyVersion,
      row.normalizedBrand, row.normalizedProductLine, row.normalizedFlavor,
      row.normalizedModifiersJson, row.normalizedForm, row.sizeDimension,
      row.sizeBaseAmount, row.sizeBaseUnit, row.outerPackCount,
      row.identityJson, createdAt,
    ],
  };
}

async function canonicalVariantStatementIfAbsent(
  db: Client,
  variant: CanonicalProductVariantKey,
  createdAt: string,
): Promise<InStatement | null> {
  const row = variant.db;
  const existing = (await db.execute({
    sql: `SELECT * FROM "CanonicalProductVariant"
          WHERE id=? OR variantKey=? OR identityHash=?`,
    args: [row.id, row.variantKey, row.identityHash],
  })).rows;
  if (!existing.length) return canonicalVariantInsertStatement(variant, createdAt);
  if (existing.length !== 1) throw new Error("CANONICAL_PRODUCT_VARIANT_KEY_COLLISION");
  const current = existing[0];
  const fields: Array<keyof typeof row> = [
    "id", "variantKey", "identityHash", "keyVersion", "normalizedBrand",
    "normalizedProductLine", "normalizedFlavor", "normalizedModifiersJson",
    "normalizedForm", "sizeDimension", "sizeBaseAmount", "sizeBaseUnit",
    "outerPackCount", "identityJson",
  ];
  const mismatch = fields.some((field) => {
    const expected = row[field];
    const actual = current[field as string];
    return expected == null ? actual != null : String(actual) !== String(expected);
  });
  if (mismatch) throw new Error("CANONICAL_PRODUCT_VARIANT_KEY_COLLISION");
  return null;
}

function parseEvidenceJson(value: string | null | undefined): unknown {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return { malformedEvidenceJson: true }; }
}

function stableEvidenceForHash(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableEvidenceForHash);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    // Observation age changes with the evaluation clock; observedAt and the
    // actual eligibility/reason codes already preserve the immutable decision.
    if (key === "ageMs") continue;
    out[key] = stableEvidenceForHash(nested);
  }
  return out;
}

function currentRunProvenance(nowMs = Date.now()): { runId: string; approvalId: string } | null {
  const permit = currentMeteredRunPermit(undefined, nowMs);
  if (!permit) return null;
  return { runId: permit.runId, approvalId: permit.approvalId };
}

// --- the per-SKU engine ------------------------------------------------------
export type CostResult = {
  sku: string;
  status: "costed" | "no-price" | "error" | "dry" | "no-input";
  cached?: boolean;
  total?: number;
  perUnit?: number;
  packSize?: number;
  needsReview?: boolean;
  methods?: string[]; // e.g. ["own-brand"] or ["exact","google"]
  note?: string;
  error?: string;
  logs: string[]; // human-readable per-SKU trace (CLI prints; cron ignores)
  identity?: any;
  parts?: any[];
};

export const COST_SOURCE_POLICY_VERSION =
  "product-truth-cost-source-policy/1.0.0" as const;

const COST_RETAILER_ORDER = [
  "walmart",
  "target",
  "publix",
  "aldi",
  "samsclub",
  "costco",
] as const;

export type CostRetailer = (typeof COST_RETAILER_ORDER)[number];

const COST_CLUB_RETAILERS = ["samsclub", "costco"] as const;

/**
 * Per-run source authorization. The caller may narrow the safe default, but
 * membership clubs require a second explicit opt-in. BJ's and BlueCart are not
 * members of CostRetailer and the runtime validator rejects them fail-closed.
 */
export type CostSourcePolicy = Readonly<{
  retailerAllowlist: readonly CostRetailer[];
  allowClubRetailers: boolean;
}>;

export type ResolvedCostSourcePolicy = Readonly<{
  policyVersion: typeof COST_SOURCE_POLICY_VERSION;
  retailerAllowlist: readonly CostRetailer[];
  allowClubRetailers: boolean;
  unwrangleRetailers: readonly ("target" | "samsclub" | "costco")[];
  openClawRetailers: readonly ("publix" | "aldi")[];
}>;

const DEFAULT_COST_RETAILERS = Object.freeze([
  "walmart",
  "target",
  "publix",
] as const);

export const DEFAULT_COST_SOURCE_POLICY: CostSourcePolicy = Object.freeze({
  retailerAllowlist: DEFAULT_COST_RETAILERS,
  allowClubRetailers: false,
});

function frozenList<T extends string>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}

/** Snapshot and validate the source policy before the first await/network call. */
export function resolveCostSourcePolicy(
  input: CostSourcePolicy = DEFAULT_COST_SOURCE_POLICY,
): ResolvedCostSourcePolicy {
  if (!input || typeof input !== "object" || !Array.isArray(input.retailerAllowlist)) {
    throw new Error("COST_SOURCE_POLICY_INVALID");
  }

  const requested = new Set<string>();
  for (const value of input.retailerAllowlist as readonly unknown[]) {
    if (typeof value !== "string" || !(COST_RETAILER_ORDER as readonly string[]).includes(value)) {
      throw new Error(`COST_SOURCE_POLICY_RETAILER_UNSUPPORTED:${String(value)}`);
    }
    requested.add(value);
  }
  if (!requested.has("walmart")) {
    // enrichTarget's calibrated first tier is Walmart. Refuse a policy that
    // claims to disable it while the operational route would still call it.
    throw new Error("COST_SOURCE_POLICY_WALMART_REQUIRED");
  }

  const allowClubRetailers = input.allowClubRetailers === true;
  const requestedClubs = COST_CLUB_RETAILERS.filter((retailer) => requested.has(retailer));
  if (requestedClubs.length && !allowClubRetailers) {
    throw new Error(`COST_SOURCE_POLICY_CLUBS_DISABLED:${requestedClubs.join(",")}`);
  }

  const retailerAllowlist = frozenList(
    COST_RETAILER_ORDER.filter((retailer) => requested.has(retailer)),
  );
  const unwrangleRetailers = frozenList(
    (["target", "samsclub", "costco"] as const).filter((retailer) => requested.has(retailer)),
  );
  const openClawRetailers = frozenList(
    (["publix", "aldi"] as const).filter((retailer) => requested.has(retailer)),
  );

  return Object.freeze({
    policyVersion: COST_SOURCE_POLICY_VERSION,
    retailerAllowlist,
    allowClubRetailers,
    unwrangleRetailers,
    openClawRetailers,
  });
}

function canonicalCostRetailer(value: unknown): CostRetailer | null {
  const normalized = String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (normalized === "sams" || normalized === "samsclub") return "samsclub";
  return (COST_RETAILER_ORDER as readonly string[]).includes(normalized)
    ? normalized as CostRetailer
    : null;
}

/** Apply the same immutable allowlist to cached evidence and new network work. */
export function costSourcePolicyAllowsRetailer(
  policy: ResolvedCostSourcePolicy,
  retailer: unknown,
): boolean {
  const canonical = canonicalCostRetailer(retailer);
  return canonical != null && policy.retailerAllowlist.includes(canonical);
}

/** Sequential by contract: one component may reach paid sourcing at a time. */
export async function runCostComponentsSequentially<T>(
  components: readonly T[],
  run: (component: T) => Promise<void>,
): Promise<void> {
  for (const component of components) await run(component);
}

export type CostOptions = {
  sku: string;
  channel: string; // walmart | amazon
  storeIndex: number;
  minConf?: number;
  sourcePolicy?: CostSourcePolicy;
  /** @deprecated Use sourcePolicy.retailerAllowlist to select OpenClaw retailers. */
  openclaw?: boolean;
  reidentify?: boolean;
  dry?: boolean;
};

export async function costOneSku(db: Client, opts: CostOptions): Promise<CostResult> {
  const sourcePolicy = resolveCostSourcePolicy(opts.sourcePolicy);
  const sourcePolicyEvidence = {
    policyVersion: sourcePolicy.policyVersion,
    retailerAllowlist: [...sourcePolicy.retailerAllowlist],
    allowClubRetailers: sourcePolicy.allowClubRetailers,
  };
  const listingScope = buildProductTruthListingScope({
    sku: opts.sku,
    channel: opts.channel,
    storeIndex: opts.storeIndex,
  });
  const { sku, storeIndex: STORE_INDEX } = listingScope;
  const CHANNEL = listingScope.channel;
  if (CHANNEL !== "amazon" && CHANNEL !== "walmart") {
    throw new Error("PRODUCT_TRUTH_COST_CHANNEL_UNSUPPORTED");
  }
  const MIN_CONF = opts.minConf ?? 0.7;
  const logs: string[] = [];
  const log = (s: string) => logs.push(s);
  try {
    // A non-dry COGS run may reach paid retailers and must be able to persist
    // immutable observations plus separated content/price provenance first.
    if (!opts.dry) {
      await assertProductTruthEvidenceSchema(db);
      await assertProductTruthListingScopeSchema(db);
      const registered = (await db.execute({
        sql: `SELECT listingKey FROM ProductTruthListingScope
              WHERE listingKey=? AND channel=? AND storeIndex=? AND sku=?
                AND registrationKind='AUTHORITATIVE_PHASE1_MANIFEST'
              LIMIT 1`,
        args: [listingScope.listingKey, CHANNEL, STORE_INDEX, sku],
      })).rows[0];
      if (!registered) throw new Error("PRODUCT_TRUTH_LISTING_SCOPE_NOT_REGISTERED");
    }

    // CACHE: identity is stable — reuse a prior identify (skips vision + SP-API/Veeqo)
    // unless reidentify. Prices/content are always re-fetched below.
    let identity: any = null;
    let cached = false;
    let identityInputSource = "exact_marketplace_listing";
    // Transitional bridge only: a raw-SKU cache may be reused when the
    // authoritative registry proves there is exactly one listing scope for
    // that SKU and its marketplace matches the requested channel. Any
    // cross-channel/account collision disables the bridge and forces exact
    // scoped gathering.
    if (!opts.reidentify) {
      const cx = opts.dry
        ? await db.execute({
            sql: `SELECT productIdentity FROM SkuShippingData WHERE sku=? LIMIT 1`,
            args: [sku],
          })
        : await db.execute({
            sql: `SELECT shipping.productIdentity
                  FROM SkuShippingData shipping
                  WHERE shipping.sku=?
                    AND lower(shipping.marketplace)=?
                    AND EXISTS (
                      SELECT 1 FROM ProductTruthListingScope exact
                      WHERE exact.listingKey=? AND exact.channel=?
                        AND exact.storeIndex=? AND exact.sku=shipping.sku
                    )
                    AND 1=(
                      SELECT COUNT(*) FROM ProductTruthListingScope scope
                      WHERE scope.sku=shipping.sku
                    )
                  LIMIT 1`,
            args: [sku, CHANNEL, listingScope.listingKey, CHANNEL, STORE_INDEX],
          });
      const pj = cx.rows[0]?.productIdentity as string | undefined;
      if (pj) {
        try {
          const p = JSON.parse(pj);
          if (p && p.brand) {
            identity = { imagesUsed: 0, components: [], ...p };
            cached = true;
            identityInputSource = opts.dry
              ? "legacy_raw_sku_dry_cache"
              : "legacy_unique_manifest_scope_bridge";
          }
        } catch { /* re-identify */ }
      }
    }
    if (!identity) {
      const inputs = CHANNEL === "amazon"
        ? await gatherAmazonInputs(sku, STORE_INDEX)
        : await gatherWalmartInputs(db, sku, STORE_INDEX);
      if (!inputs.found) { return { sku, status: "no-input", logs: [`❌ ${sku}: no title/photos found`] }; }
      identity = await identifyProduct(inputs);
      // SkuShippingData is raw-SKU legacy and cannot persist this scoped
      // identity without overwriting another channel/account. Canonical scoped
      // writes intentionally do not mutate it.
    }
    const lowConf = identity.confidence < MIN_CONF;

    log(`=== ${sku} ===${cached ? "  (cached identity)" : ""}`);
    log(`  → ${identity.brand} | ${identity.product_line} | ${identity.flavor} | ${identity.size} | ${identity.container_type}`);
    log(`  base unit : ${identity.base_unit}`);
    log(`  UNITS: ${identity.units_in_listing} (${identity.unit_basis})  bundle=${identity.is_bundle}${identity.components.length ? ` [${identity.components.length} comp]` : ""}`);
    if (identity.components.length) log(`  components: ${identity.components.map((c: any) => `${c.qty}× ${c.product}${c.size ? " " + c.size : ""}`).join(" | ")}`);
    log(`  confidence: ${identity.confidence}${lowConf ? "  ⚠️ BELOW THRESHOLD → needsReview" : ""}  ${identity.notes ? "— " + identity.notes : ""}`);

    if (opts.dry) { return { sku, status: "dry", cached, logs, identity }; }

    // Targets: bundle → each component; else → single base unit. Each carries the raw
    // product/flavor/size so we can write a SkuComponent row alongside the cost.
    const targets = identity.is_bundle && identity.components.length
      ? identity.components.map((c: any, i: number) => ({
          idx: i,
          query: [c.product, c.flavor, c.size].filter(Boolean).join(" "),
          brandTok: firstToken(c.product),
          brandToks: brandTokens(c.product),
          tokens: distinctiveTokens(c.product, c.flavor),
          sizeAmount: parseSizeNum(c.size),
          qty: c.qty || 1,
          label: `${c.qty}× ${c.product}`,
          product: c.product || "",
          flavor: c.flavor || null,
          size: c.size || null,
          canonicalProduct: componentCanonicalProduct(c.product, c.flavor, c.size),
          isBundleComp: true,
        }))
      : [{
          idx: 0,
          query: [identity.brand, identity.product_line, identity.flavor, identity.size].filter(Boolean).filter((v: string, i: number, a: string[]) => a.indexOf(v) === i).join(" ") || identity.retail_search_query,
          brandTok: firstToken(identity.brand),
          brandToks: brandTokens(identity.brand),
          tokens: distinctiveTokens(identity.product_line, identity.flavor),
          sizeAmount: parseSizeNum(identity.size),
          qty: identity.units_in_listing || 1,
          label: identity.base_unit || identity.retail_search_query,
          product: identity.product_line || identity.brand || identity.base_unit || "",
          flavor: identity.flavor || null,
          size: identity.size || null,
          canonicalProduct: {
            brand: identity.brand || undefined,
            product_line: identity.product_line || undefined,
            flavor: identity.flavor || undefined,
            size: identity.size || undefined,
            container_type: identity.container_type || undefined,
            outer_pack_count: 1,
          },
          isBundleComp: false,
        }];

    const evaluationNow = new Date().toISOString();
    type Part = {
      idx: number;
      label: string;
      product: string;
      flavor: string | null;
      size: string | null;
      qty: number;
      isBundleComp: boolean;
      perUnit: number | null;
      retailer?: string;
      matched?: string;
      method: string;
      estimated?: boolean;
      ownBrand?: boolean;
      contentDonorProductId?: string | null;
      priceEvidenceDonorProductId?: string | null;
      priceEvidenceOfferId?: string | null;
      priceEvidenceObservationId?: string | null;
      targetVariant: CanonicalProductVariantKey;
      contentCanonicalVariantId?: string | null;
      priceCanonicalVariantId?: string | null;
      contentObservationId?: string | null;
      priceVariantDecisionId?: string | null;
      evidenceAnchorAt: string;
      matchTier?: string | null;
      matcherVersion?: string | null;
      priceEvidenceStatus?: string | null;
      pricePolicyVersion?: string | null;
      priceEvidenceJson?: string | null;
      manualFact?: boolean;
    };
    const parts: Part[] = [];
    let costable = true;

    await runCostComponentsSequentially(targets, async (t: any) => {
      const base = { idx: t.idx, label: t.label, product: t.product, flavor: t.flavor, size: t.size, qty: t.qty, isBundleComp: t.isBundleComp };

      // TIER 0 — OWN-BRAND manual cost: our own products have no retail donor.
      const ob = ownBrandCost({ brand: identity.brand, text: t.query, size: t.size, units: t.qty });
      const costTarget = canonicalCostIdentity(t.canonicalProduct, t.query);
      // Own-brand rules price one physical unit. When the listing identity omits
      // a printed measurement, one unit is still an explicit COUNT identity;
      // third-party products never receive this fallback.
      if (ob && !costTarget.size) costTarget.size = "1 count";
      const targetVariant = buildCanonicalProductVariantKey(costTarget);
      if (ob) {
        parts.push({
          ...base,
          targetVariant,
          perUnit: ob.perUnit,
          retailer: "own-brand",
          matched: ob.label,
          method: "own-brand",
          ownBrand: true,
          manualFact: true,
          contentDonorProductId: null,
          matchTier: "MANUAL_COST",
          matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
          priceEvidenceStatus: "MANUAL_FACT",
          pricePolicyVersion: ob.policyVersion,
          evidenceAnchorAt: ob.effectiveAt,
          priceEvidenceJson: JSON.stringify({
            schemaVersion: "product-truth-manual-cost-evidence/1.0.0",
            outcome: "MANUAL_FACT",
            targetCanonicalVariantId: targetVariant.canonicalVariantId,
            manualCost: {
              policyVersion: ob.policyVersion,
              ruleKey: ob.ruleKey,
              amount: ob.perUnit,
              currency: "USD",
              effectiveAt: ob.effectiveAt,
              source: ob.source,
              actor: "Vladimir",
              reason: "owner-provided landed cost",
              approvalRef: ob.approvalRef,
            },
          }),
        });
        log(`  · ${t.label}  →  $${ob.perUnit.toFixed(2)}/u @ own-brand  «${ob.label}»`);
        return;
      }

      // Reuse already-fresh immutable evidence before spending a single credit.
      let lookup = await cheapestCostForTarget(
        db,
        costTarget,
        targetVariant.canonicalVariantId,
        evaluationNow,
        sourcePolicy,
      );
      let res: Awaited<ReturnType<typeof enrichTarget>> | null = null;
      if (!lookup.hit) {
        res = await enrichOnce(db, {
          target: t.query,
          brand: t.brandTok || null,
          zip: PRODUCT_TRUTH_PROCUREMENT_ZIP,
          matchSpec: { brandToks: t.brandToks?.length ? t.brandToks : (t.brandTok ? [t.brandTok] : []), tokens: t.tokens, sizeAmount: t.sizeAmount },
          canonicalProduct: t.canonicalProduct,
          unwrangleRetailers: [...sourcePolicy.unwrangleRetailers],
          openClawRetailers: [...sourcePolicy.openClawRetailers],
          allowNonGrocery: true,
        });
        lookup = await cheapestCostForTarget(
          db,
          costTarget,
          targetVariant.canonicalVariantId,
          evaluationNow,
          sourcePolicy,
        );
      }
      const cost = lookup.hit;
      const incompleteSources = (res?.sourceAttempts ?? []).filter((attempt) => attempt.status !== "completed");
      if (!cost && incompleteSources.length) {
        throw new Error(
          `SOURCE_COVERAGE_INCOMPLETE ${incompleteSources.map((attempt) => `${attempt.source}:${attempt.status}`).join(",")}`,
        );
      }
      if (cost == null) {
        costable = false;
        parts.push({
          ...base,
          targetVariant,
          perUnit: null,
          method: "unsourceable",
          contentDonorProductId: lookup.content?.donorProductId ?? null,
          contentCanonicalVariantId: lookup.content?.canonicalVariantId ?? null,
          contentObservationId: lookup.content?.id ?? null,
          matcherVersion: CANONICAL_PRODUCT_MATCHER_VERSION,
          priceEvidenceStatus: "REJECT",
          pricePolicyVersion: PRICE_EVIDENCE_POLICY_VERSION,
          evidenceAnchorAt: latestIsoTimestamp(
            [
              ...lookup.selection.evaluations.map((evaluation) => evaluation.candidate.fetchedAt),
              lookup.content?.observedAt,
            ],
            evaluationNow,
          ),
          priceEvidenceJson: lookup.evidenceJson,
        });
      } else {
        parts.push({
          ...base,
          targetVariant,
          perUnit: cost.perUnit,
          retailer: cost.retailer,
          matched: cost.title,
          method: cost.method,
          estimated: cost.outcome === "ESTIMATE",
          contentDonorProductId: cost.contentDonorProductId,
          priceEvidenceDonorProductId: cost.priceEvidenceDonorProductId,
          priceEvidenceOfferId: cost.priceEvidenceOfferId,
          priceEvidenceObservationId: cost.priceEvidenceObservationId,
          contentCanonicalVariantId: cost.contentCanonicalVariantId,
          priceCanonicalVariantId: cost.priceCanonicalVariantId,
          contentObservationId: cost.contentObservationId,
          priceVariantDecisionId: cost.priceVariantDecisionId,
          evidenceAnchorAt: cost.evidenceAnchorAt,
          matchTier: cost.matchTier,
          matcherVersion: cost.matcherVersion,
          priceEvidenceStatus: cost.outcome,
          pricePolicyVersion: cost.pricePolicyVersion,
          priceEvidenceJson: lookup.evidenceJson,
        });
      }
      const searchSummary = res
        ? `hit ${res.retailersHit.join(",") || "none"}, rej ${res.rejected}`
        : "fresh catalog evidence reused; no provider call";
      log(`  · ${t.label}  →  ${cost ? `$${cost.perUnit.toFixed(2)}/u @ ${cost.retailer}${cost.outcome === "ESTIMATE" ? ` (${cost.method})` : ""}  «${(cost.title || "").slice(0, 46)}» ${cost.size}` : "no eligible local price evidence"}  (${searchSummary})`);
    });
    parts.sort((a, b) => a.idx - b.idx);

    // COGS: bundle = Σ component perUnit×qty; single = perUnit × units_in_listing.
    const now = new Date().toISOString();
    const evidenceEvaluatedAt = latestIsoTimestamp(
      parts.map((part) => part.evidenceAnchorAt),
      evaluationNow,
    );
    const eff = evidenceEvaluatedAt;
    const round2 = (n: number) => Math.round(n * 100) / 100;
    const runProvenance = currentRunProvenance(Date.parse(now));
    const componentEvidence = parts.map((part) => ({
      idx: part.idx,
      product: part.product,
      flavor: part.flavor,
      size: part.size,
      qty: part.qty,
      perUnit: part.perUnit,
      method: part.method,
      targetCanonicalVariantId: part.targetVariant.canonicalVariantId,
      contentCanonicalVariantId: part.contentCanonicalVariantId ?? null,
      priceCanonicalVariantId: part.priceCanonicalVariantId ?? null,
      contentDonorProductId: part.contentDonorProductId ?? null,
      priceEvidenceDonorProductId: part.priceEvidenceDonorProductId ?? null,
      priceEvidenceOfferId: part.priceEvidenceOfferId ?? null,
      priceEvidenceObservationId: part.priceEvidenceObservationId ?? null,
      contentObservationId: part.contentObservationId ?? null,
      priceVariantDecisionId: part.priceVariantDecisionId ?? null,
      matchTier: part.matchTier ?? null,
      priceEvidenceStatus: part.priceEvidenceStatus ?? null,
      matcherVersion: part.matcherVersion ?? null,
      pricePolicyVersion: part.pricePolicyVersion ?? null,
      evidence: parseEvidenceJson(part.priceEvidenceJson),
    }));
    const recipeCore = {
      version: "product-truth-recipe/1.0.0",
      sku,
      channel: CHANNEL,
      storeIndex: STORE_INDEX,
      listingKey: listingScope.listingKey,
      listingKeyVersion: listingScope.keyVersion,
      sourcePolicy: sourcePolicyEvidence,
      identity: {
        inputSource: identityInputSource,
        brand: identity.brand ?? null,
        productLine: identity.product_line ?? null,
        flavor: identity.flavor ?? null,
        size: identity.size ?? null,
        containerType: identity.container_type ?? null,
        unitsInListing: identity.units_in_listing ?? null,
        isBundle: !!identity.is_bundle,
      },
      components: componentEvidence.map((part) => ({
        idx: part.idx,
        product: part.product,
        flavor: part.flavor,
        size: part.size,
        qty: part.qty,
        perUnit: part.perUnit,
        method: part.method,
        targetCanonicalVariantId: part.targetCanonicalVariantId,
        contentCanonicalVariantId: part.contentCanonicalVariantId,
        priceCanonicalVariantId: part.priceCanonicalVariantId,
        contentObservationId: part.contentObservationId,
        priceEvidenceObservationId: part.priceEvidenceObservationId,
        priceVariantDecisionId: part.priceVariantDecisionId,
        matchTier: part.matchTier,
        priceEvidenceStatus: part.priceEvidenceStatus,
        evidenceDigest: sha256Json(stableEvidenceForHash(part.evidence)),
      })),
    };
    const recipeHash = sha256Json(recipeCore);
    let result: CostResult;
    let costStatement: InStatement;
    let costId: string;
    let costObservationKey: string;

    if (costable && parts.length) {
      const listingCost = parts.reduce((s, p) => s + (p.perUnit || 0) * p.qty, 0);
      const total = round2(listingCost);
      const packSize = identity.is_bundle ? identity.components.reduce((s: number, c: any) => s + c.qty, 0) : (identity.units_in_listing || 1);
      const perUnitStore = round2(total / Math.max(1, packSize));
      const anyEstimate = parts.some((p) => p.estimated);
      const anyOwnBrand = parts.some((p) => p.ownBrand);
      // SANITY GUARDRAIL: we never buy above our own sale price. COGS >= sale means
      // either a bad match (flag it) or a genuinely unprofitable listing (flag it too —
      // both need human eyes). Sale price from the Buy Box report when we have it.
      let aboveSale = false;
      try {
        const bb: any = (await db.execute({ sql: `SELECT sellerItemPrice p FROM WalmartBuyBoxItem WHERE sku=? AND sellerItemPrice IS NOT NULL LIMIT 1`, args: [sku] })).rows[0];
        if (bb?.p != null && total >= Number(bb.p)) aboveSale = true;
      } catch { /* no buy-box data — skip the check */ }
      // Only exact identity + direct + fresh local first-party evidence is factual.
      const needsReview = (lowConf || aboveSale || anyEstimate) ? 1 : 0;
      const estimateMethods = Array.from(new Set(parts.filter((p) => p.estimated).map((p) => p.method)));
      const noteParts = (identity.is_bundle
        ? `bundle: ${parts.map((p) => `${p.qty}×$${(p.perUnit || 0).toFixed(2)}`).join(" + ")}`
        : `${parts[0].retailer} $${(parts[0].perUnit || 0).toFixed(2)}/u ×${identity.units_in_listing}`) + (estimateMethods.length ? ` [estimate:${estimateMethods.join(",")}]` : "") + (anyOwnBrand ? " [own-brand]" : "") + (aboveSale ? " [COGS>=sale — check match or margin]" : "");
      const costEvidence = {
        schemaVersion: "product-truth-sku-cost-evidence/1.0.0",
        channel: CHANNEL,
        storeIndex: STORE_INDEX,
        listingKey: listingScope.listingKey,
        listingKeyVersion: listingScope.keyVersion,
        evaluatedAt: evidenceEvaluatedAt,
        procurementZip: PRODUCT_TRUTH_PROCUREMENT_ZIP,
        sourcePolicy: sourcePolicyEvidence,
        outcome: anyEstimate ? "ESTIMATE" : "FACT",
        recipeHash,
        total,
        costPerUnit: perUnitStore,
        packSize,
        lowIdentityConfidence: lowConf,
        aboveSale,
        runId: runProvenance?.runId ?? null,
        approvalId: runProvenance?.approvalId ?? null,
        components: componentEvidence,
      };
      const evidenceJson = JSON.stringify(costEvidence);
      const observationKey = sha256Json({
        sku,
        listingKey: listingScope.listingKey,
        source: "retail:batch",
        recipeHash,
        outcome: costEvidence.outcome,
        total,
        costPerUnit: perUnitStore,
        packSize,
        aboveSale,
        evaluatedAt: evidenceEvaluatedAt,
        runId: runProvenance?.runId ?? null,
        approvalId: runProvenance?.approvalId ?? null,
      });
      costObservationKey = observationKey;
      costId = `retail:${sku}:batch:${observationKey.slice(0, 24)}`;
      const rollupPricePolicyVersion = parts.every((part) => part.manualFact)
        ? OWN_BRAND_COST_POLICY_VERSION
        : parts.some((part) => part.manualFact)
          ? `mixed:${PRICE_EVIDENCE_POLICY_VERSION}+${OWN_BRAND_COST_POLICY_VERSION}`
          : PRICE_EVIDENCE_POLICY_VERSION;
      // Cost observations are append-only by effectiveDate; observationKey makes
      // an identical re-evaluation idempotent without rewriting history.
      costStatement = {
        sql: `INSERT INTO "SkuCost"
          (id, observationKey, sku, effectiveDate, productCost, totalCost, costPerUnit,
           packSize, includesPackaging, currency, source, confidence, needsReview, notes,
           recipeHash, evidenceJson, evidenceOutcome, matcherVersion, pricePolicyVersion, runId, approvalId,
           createdAt, updatedAt)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: [
          costId, observationKey, sku, eff,
          total, total, perUnitStore, packSize, 0, "USD", "retail:batch",
          identity.confidence ?? null, needsReview, noteParts.slice(0, 180), recipeHash,
          evidenceJson, costEvidence.outcome, CANONICAL_PRODUCT_MATCHER_VERSION,
          rollupPricePolicyVersion,
          runProvenance?.runId ?? null, runProvenance?.approvalId ?? null, now, now,
        ],
      };
      log(`  → COGS $${total.toFixed(2)} (listing)${identity.is_bundle ? ` = ${parts.length} components summed` : ""}${anyEstimate ? "  [typed estimate]" : ""}${needsReview ? "  [needsReview]" : ""}`);
      result = { sku, status: "costed", cached, total, perUnit: perUnitStore, packSize, needsReview: !!needsReview, methods: Array.from(new Set(parts.map((p) => p.method))), note: noteParts, logs, identity, parts };
    } else {
      log(`  → UNSOURCEABLE: no eligible fresh local first-party evidence — review before any delist decision`);
      const costEvidence = {
        schemaVersion: "product-truth-sku-cost-evidence/1.0.0",
        channel: CHANNEL,
        storeIndex: STORE_INDEX,
        listingKey: listingScope.listingKey,
        listingKeyVersion: listingScope.keyVersion,
        evaluatedAt: evidenceEvaluatedAt,
        procurementZip: PRODUCT_TRUTH_PROCUREMENT_ZIP,
        sourcePolicy: sourcePolicyEvidence,
        outcome: "UNSOURCEABLE",
        runId: runProvenance?.runId ?? null,
        approvalId: runProvenance?.approvalId ?? null,
        recipeHash,
        components: componentEvidence,
      };
      const evidenceJson = JSON.stringify(costEvidence);
      const observationKey = sha256Json({
        sku,
        listingKey: listingScope.listingKey,
        source: "retail:batch",
        recipeHash,
        outcome: "UNSOURCEABLE",
        evaluatedAt: evidenceEvaluatedAt,
        runId: runProvenance?.runId ?? null,
        approvalId: runProvenance?.approvalId ?? null,
      });
      costObservationKey = observationKey;
      costId = `retail:${sku}:batch:${observationKey.slice(0, 24)}`;
      costStatement = {
        sql: `INSERT INTO "SkuCost"
          (id, observationKey, sku, effectiveDate, totalCost, costPerUnit, packSize,
           includesPackaging, currency, source, confidence, needsReview, notes,
           recipeHash, evidenceJson, evidenceOutcome, matcherVersion, pricePolicyVersion, runId, approvalId,
           createdAt, updatedAt)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: [
          costId, observationKey, sku, eff,
          null, null, null, 0, "USD", "retail:batch", identity.confidence ?? null, 1,
          "UNSOURCEABLE: no eligible fresh local first-party evidence; owner review required",
          recipeHash, evidenceJson, "UNSOURCEABLE", CANONICAL_PRODUCT_MATCHER_VERSION,
          PRICE_EVIDENCE_POLICY_VERSION, runProvenance?.runId ?? null,
          runProvenance?.approvalId ?? null, now, now,
        ],
      };
      result = { sku, status: "no-price", cached, logs, identity, parts };
    }

    const authoritativeEvidence = parts.map((part) => {
      const evidenceStatus = part.priceEvidenceStatus;
      if (!evidenceStatus || !part.matchTier || !part.matcherVersion || !part.pricePolicyVersion) {
        throw new Error(`COMPONENT_EVIDENCE_INCOMPLETE index=${part.idx}`);
      }
      const sourceEvidence = parseJsonObject(part.priceEvidenceJson);
      const evidencePayload = {
        ...sourceEvidence,
        schemaVersion: "product-truth-sku-component-evidence/1.0.0",
        sourceEvidenceSchemaVersion: sourceEvidence.schemaVersion ?? null,
        evidenceStatus,
        targetCanonicalVariantId: part.targetVariant.canonicalVariantId,
        contentCanonicalVariantId: part.contentCanonicalVariantId ?? null,
        priceCanonicalVariantId: part.priceCanonicalVariantId ?? null,
        contentObservationId: part.contentObservationId ?? null,
        priceObservationId: part.priceEvidenceObservationId ?? null,
        product: part.product,
        flavor: part.flavor,
        size: part.size,
        qty: part.qty,
        perUnit: part.perUnit,
        method: part.method,
        targetComparableUnitPrice: evidenceStatus === "ESTIMATE" ? part.perUnit : null,
        matchTier: part.matchTier,
        matcherVersion: part.matcherVersion,
        pricePolicyVersion: part.pricePolicyVersion,
      };
      const evidenceJson = JSON.stringify(evidencePayload);
      const evidenceHash = sha256Json(stableEvidenceForHash(evidencePayload));
      const evidenceKey = sha256Json({
        skuCostId: costId,
        componentIndex: part.idx,
        evidenceHash,
      });
      return {
        componentIndex: part.idx,
        evidenceKey,
        evidenceHash,
        statement: {
          sql: `INSERT INTO "SkuComponentEvidence"
            (id, evidenceKey, skuCostId, componentIndex, evidenceStatus,
             targetCanonicalVariantId, contentCanonicalVariantId, priceCanonicalVariantId,
             contentObservationId, priceObservationId, matchTier, matcherVersion,
             pricePolicyVersion, evidenceHash, evidenceJson, createdAt)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          args: [
            `sce:${evidenceKey}`, evidenceKey, costId, part.idx, evidenceStatus,
            part.targetVariant.canonicalVariantId,
            part.contentCanonicalVariantId ?? null,
            part.priceCanonicalVariantId ?? null,
            part.contentObservationId ?? null,
            part.priceEvidenceObservationId ?? null,
            part.matchTier, part.matcherVersion, part.pricePolicyVersion,
            evidenceHash, evidenceJson, now,
          ],
        } satisfies InStatement,
      };
    });
    const scopeLinkStatement: InStatement = {
      sql: `INSERT INTO "SkuCostListingScopeLink"
        (skuCostId, listingKey, linkVersion, createdAt)
        VALUES (?,?,?,?)`,
      args: [
        costId,
        listingScope.listingKey,
        SKU_COST_LISTING_SCOPE_LINK_VERSION,
        now,
      ],
    };

    // Idempotency is resolved before INSERT. SQLite's `OR REPLACE` can bypass
    // delete guards when recursive triggers are disabled, so immutable tables
    // intentionally reject every duplicate INSERT instead of relying on an
    // ON CONFLICT clause.
    const expectedCost = expectedInsertPayload(costStatement, {
      asin: null,
      packagingCost: null,
      iceCost: null,
    });
    const existingCosts = (await db.execute({
      sql: `SELECT * FROM "SkuCost" WHERE id=? OR observationKey=?`,
      args: [costId, costObservationKey],
    })).rows;
    if (existingCosts.length > 1) throw new Error("SKU_COST_IDEMPOTENCY_CONFLICT:multiple_rows");
    const existingCost = existingCosts[0];
    if (existingCost) {
      assertImmutableRowEquivalent(
        existingCost as Record<string, unknown>,
        expectedCost,
        "SKU_COST_IDEMPOTENCY_CONFLICT",
      );
      const existingEvidence = (await db.execute({
        sql: `SELECT * FROM "SkuComponentEvidence" WHERE skuCostId=?
              ORDER BY componentIndex`,
        args: [costId],
      })).rows;
      const expected = [...authoritativeEvidence].sort((a, b) => a.componentIndex - b.componentIndex);
      if (
        existingEvidence.length !== expected.length
      ) {
        throw new Error("SKU_COST_COMPONENT_EVIDENCE_CONFLICT");
      }
      expected.forEach((row, index) => {
        assertImmutableRowEquivalent(
          existingEvidence[index] as Record<string, unknown>,
          expectedInsertPayload(row.statement),
          "SKU_COST_COMPONENT_EVIDENCE_CONFLICT",
        );
      });
      const existingLink = (await db.execute({
        sql: `SELECT * FROM "SkuCostListingScopeLink" WHERE skuCostId=?`,
        args: [costId],
      })).rows[0];
      if (!existingLink) throw new Error("SKU_COST_LISTING_SCOPE_LINK_MISSING");
      assertImmutableRowEquivalent(
        existingLink as Record<string, unknown>,
        expectedInsertPayload(scopeLinkStatement),
        "SKU_COST_LISTING_SCOPE_LINK_CONFLICT",
      );
      await writeComponents(db, sku, CHANNEL, parts);
      return result;
    }

    // A child without its parent cannot be a legitimate prior commit. Refuse to
    // adopt or overwrite an orphan/collision; the only creation path is the one
    // atomic child-first deferred-FK transaction below.
    for (const row of authoritativeEvidence) {
      const expectedEvidence = expectedInsertPayload(row.statement);
      const collisions = (await db.execute({
        sql: `SELECT id FROM "SkuComponentEvidence"
              WHERE id=? OR evidenceKey=? OR (skuCostId=? AND componentIndex=?)`,
        args: [
          expectedEvidence.id as string,
          expectedEvidence.evidenceKey as string,
          costId,
          row.componentIndex,
        ],
      })).rows;
      if (collisions.length) throw new Error("SKU_COST_COMPONENT_EVIDENCE_ORPHAN_CONFLICT");
    }
    if ((await db.execute({
      sql: `SELECT 1 FROM "SkuCostListingScopeLink" WHERE skuCostId=? LIMIT 1`,
      args: [costId],
    })).rows.length) {
      throw new Error("SKU_COST_LISTING_SCOPE_LINK_ORPHAN_CONFLICT");
    }

    const uniqueVariants = new Map<string, CanonicalProductVariantKey>();
    for (const part of parts) {
      uniqueVariants.set(part.targetVariant.canonicalVariantId, part.targetVariant);
    }
    const variantStatements: InStatement[] = [];
    for (const variant of uniqueVariants.values()) {
      const statement = await canonicalVariantStatementIfAbsent(db, variant, now);
      if (statement) variantStatements.push(statement);
    }

    // One transaction: establish target identities, insert deferred child
    // component evidence, insert its SkuCost parent (whose AFTER trigger verifies
    // the complete roll-up), then refresh the non-authoritative structural BOM.
    await writeComponents(db, sku, CHANNEL, parts, [
      ...variantStatements,
      scopeLinkStatement,
      ...authoritativeEvidence.map((row) => row.statement),
      costStatement,
    ]);
    return result;
  } catch (e: any) {
    // Spend-control failures are control-plane decisions, not ordinary SKU
    // misses. Preserve them so callers cannot fall through to another paid
    // source or mark a budget-denied job complete.
    if (isMeteredProviderControlError(e)) throw e;
    return { sku, status: "error", error: String(e?.message).slice(0, 200), logs: [`💥 ${sku}: ${String(e?.message).slice(0, 120)}`] };
  }
}
