/**
 * Read-only provisional Product Truth mirror/catalog diagnostic.
 *
 * Reads only the existing Turso marketplace mirrors and catalog tables. It does
 * NOT call Amazon, Walmart, retailers, vision providers, or enrichment workers,
 * and it performs no INSERT/UPDATE/DELETE statements. Its output is never an
 * authoritative Phase 1 manifest and is ineligible for consumer cutover.
 *
 * Run:
 *   npx tsx scripts/product-truth-baseline.ts
 */

import { config } from "dotenv";
import { createClient, type InArgs } from "@libsql/client";

config({ path: ".env.local" });
config({ path: ".env" });

function clean(value: string | undefined): string | undefined {
  return value?.trim().replace(/^['"]|['"]$/g, "");
}

const resolvedDatabaseUrl = clean(process.env.TURSO_DATABASE_URL) ?? clean(process.env.DATABASE_URL);
const authToken = clean(process.env.TURSO_AUTH_TOKEN);
if (!resolvedDatabaseUrl) throw new Error("TURSO_DATABASE_URL or DATABASE_URL is required");
const databaseUrl: string = resolvedDatabaseUrl;

const db = createClient({ url: databaseUrl, authToken });

type JsonRow = Record<string, string | number | boolean | null>;

function assertReadOnly(sql: string): void {
  const normalized = sql.trimStart().toUpperCase();
  if (!normalized.startsWith("SELECT") && !normalized.startsWith("WITH") && !normalized.startsWith("PRAGMA")) {
    throw new Error(`Baseline rejected non-read-only SQL: ${normalized.slice(0, 32)}`);
  }
}

async function rows(sql: string, args: InArgs = []): Promise<JsonRow[]> {
  assertReadOnly(sql);
  const result = await db.execute({ sql, args });
  return result.rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value == null ? null : value])) as JsonRow);
}

async function optionalRows(sql: string, args: InArgs = []): Promise<JsonRow[]> {
  try {
    return await rows(sql, args);
  } catch {
    return [];
  }
}

function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function ageHours(value: unknown, nowMs: number): number | null {
  if (!value) return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? Math.round(((nowMs - ms) / 3_600_000) * 10) / 10 : null;
}

function databaseLabel(url: string): string {
  if (url.startsWith("file:")) return "local-file";
  try {
    return new URL(url.replace(/^libsql:/, "https:")).hostname || "remote-libsql";
  } catch {
    return "remote-libsql";
  }
}

const scopeCte = `
WITH scope AS (
  SELECT 'walmart' AS channel, storeIndex, sku, NULL AS asin,
         'walmart:' || storeIndex || ':' || sku AS listingKey,
         lower(sku) AS normalizedSku
  FROM "WalmartCatalogItem"
  WHERE publishedStatus='PUBLISHED'
  UNION ALL
  SELECT 'amazon' AS channel, storeIndex, sku, asin,
         'amazon:' || storeIndex || ':' || sku AS listingKey,
         lower(sku) AS normalizedSku
  FROM "AmazonListingHealthItem"
  WHERE isBuyable=1
),
latest_cost AS (
  SELECT * FROM (
    SELECT c.*,
           ROW_NUMBER() OVER (
             PARTITION BY c.sku
             ORDER BY COALESCE(c.effectiveDate, '') DESC, c.updatedAt DESC, c.createdAt DESC
           ) AS rn
    FROM "SkuCost" c
    WHERE c.source='retail:batch'
  ) ranked
  WHERE rn=1
),
component_rollup AS (
  SELECT sc.sku,
         COUNT(*) AS componentRows,
         SUM(CASE WHEN sc.donorProductId IS NOT NULL THEN 1 ELSE 0 END) AS linkedComponents,
         SUM(CASE WHEN sc.costMethod='exact' THEN 1 ELSE 0 END) AS exactPriceComponents,
         SUM(CASE WHEN sc.costMethod IN ('line-price','google') THEN 1 ELSE 0 END) AS estimateComponents,
         SUM(CASE WHEN sc.costMethod='unsourceable' OR sc.perUnitCost IS NULL THEN 1 ELSE 0 END) AS unresolvedComponents
  FROM "SkuComponent" sc
  GROUP BY sc.sku
)
`;

async function main(): Promise<void> {
  const generatedAt = new Date();
  const nowMs = generatedAt.getTime();

  const [
    walmartStores,
    walmartStatuses,
    walmartReport,
    marketplaceAccounts,
    amazonStores,
    amazonAsinSales,
    amazonStatuses,
    amazonSync,
    scopeCounts,
    scopeCombined,
    scopeOverlap,
    scopeCollisions,
    amazonAsinCollisions,
    scopeCoverage,
    donorCoverage,
    offerCoverage,
    queueStatus,
    priorityQueue,
    enrichedReady,
    integrity,
    costHistory,
  ] = await Promise.all([
    rows(`SELECT storeIndex,
                 COUNT(*) AS mirrorRows,
                 SUM(CASE WHEN publishedStatus='PUBLISHED' THEN 1 ELSE 0 END) AS publishedRows,
                 SUM(CASE WHEN publishedStatus='PUBLISHED' AND lifecycleStatus='ACTIVE' THEN 1 ELSE 0 END) AS publishedActiveRows,
                 MIN(syncedAt) AS oldestSyncedAt,
                 MAX(syncedAt) AS newestSyncedAt
          FROM "WalmartCatalogItem" GROUP BY storeIndex ORDER BY storeIndex`),
    rows(`SELECT storeIndex, COALESCE(publishedStatus,'(null)') AS publishedStatus,
                 COALESCE(lifecycleStatus,'(null)') AS lifecycleStatus, COUNT(*) AS rows
          FROM "WalmartCatalogItem"
          GROUP BY storeIndex, publishedStatus, lifecycleStatus
          ORDER BY storeIndex, rows DESC`),
    optionalRows(`SELECT storeIndex, status, requestedAt, downloadedAt, rowCount, updatedAt
                  FROM "WalmartReport"
                  WHERE reportType='ITEM_CATALOG'
                  ORDER BY requestedAt DESC LIMIT 5`),
    optionalRows(`WITH latest_health AS (
                    SELECT storeId, status, syncStatus, syncedAt, createdAt,
                           ROW_NUMBER() OVER (PARTITION BY storeId ORDER BY createdAt DESC) AS rn
                    FROM "AccountHealthSnapshot"
                  )
                  SELECT s.id, s.name, lower(s.channel) AS channel, s.active, s.storeIndex,
                         lh.status AS latestHealthStatus, lh.syncStatus AS latestHealthSyncStatus,
                         lh.syncedAt AS latestHealthSyncedAt
                  FROM "Store" s
                  LEFT JOIN latest_health lh ON lh.storeId=s.id AND lh.rn=1
                  WHERE lower(s.channel) IN ('amazon','walmart')
                  ORDER BY lower(s.channel), s.storeIndex, s.name`),
    rows(`SELECT storeIndex,
                 COUNT(*) AS mirrorRows,
                 SUM(CASE WHEN isBuyable=1 THEN 1 ELSE 0 END) AS buyableRows,
                 SUM(CASE WHEN isDiscoverable=1 THEN 1 ELSE 0 END) AS discoverableRows,
                 SUM(CASE WHEN isSuppressed=1 THEN 1 ELSE 0 END) AS suppressedRows,
                 SUM(CASE WHEN isBuyable=0 THEN 1 ELSE 0 END) AS notBuyableRows,
                 MIN(syncedAt) AS oldestSyncedAt,
                 MAX(syncedAt) AS newestSyncedAt
          FROM "AmazonListingHealthItem" GROUP BY storeIndex ORDER BY storeIndex`),
    rows(`WITH per_asin AS (
            SELECT storeIndex, asin,
                   MAX(COALESCE(revenue30d,0)) AS revenue30d,
                   MAX(COALESCE(unitsOrdered30d,0)) AS units30d
            FROM "AmazonListingHealthItem"
            WHERE asin IS NOT NULL AND asin<>''
            GROUP BY storeIndex, asin
          )
          SELECT storeIndex, COUNT(*) AS distinctAsin,
                 SUM(revenue30d) AS asinLevelRevenue30d,
                 SUM(units30d) AS asinLevelUnits30d
          FROM per_asin GROUP BY storeIndex ORDER BY storeIndex`),
    rows(`SELECT storeIndex, isBuyable, isDiscoverable, isSuppressed, COUNT(*) AS rows
          FROM "AmazonListingHealthItem"
          GROUP BY storeIndex, isBuyable, isDiscoverable, isSuppressed
          ORDER BY storeIndex, rows DESC`),
    optionalRows(`SELECT storeIndex, cursor, sweepStartedAt, pagesThisSweep,
                         itemsThisSweep, lastFullSweepAt, updatedAt
                  FROM "AmazonHealthSyncState" ORDER BY storeIndex`),
    rows(`${scopeCte}
          SELECT channel, COUNT(*) AS channelListingRows,
                 COUNT(DISTINCT listingKey) AS uniqueListings,
                 COUNT(DISTINCT sku) AS uniqueRawSku
          FROM scope GROUP BY channel ORDER BY channel`),
    rows(`${scopeCte}
          SELECT COUNT(*) AS channelListingRows,
                 COUNT(DISTINCT listingKey) AS uniqueListings,
                 COUNT(DISTINCT sku) AS uniqueRawSku
          FROM scope`),
    rows(`${scopeCte}
          SELECT COUNT(*) AS crossChannelSku
          FROM (SELECT sku FROM scope GROUP BY sku HAVING COUNT(DISTINCT channel) > 1)`),
    rows(`${scopeCte}
          SELECT
            (SELECT COUNT(*) FROM (SELECT listingKey FROM scope GROUP BY listingKey HAVING COUNT(*)>1)) AS duplicateListingKeys,
            (SELECT COUNT(*) FROM (SELECT sku FROM scope GROUP BY sku HAVING COUNT(*)>1)) AS rawSkuOnMultipleListings,
            (SELECT COUNT(*) FROM (SELECT channel, sku FROM scope GROUP BY channel, sku HAVING COUNT(DISTINCT storeIndex)>1)) AS rawSkuAcrossAccounts,
            (SELECT COUNT(*) FROM (SELECT normalizedSku FROM scope GROUP BY normalizedSku HAVING COUNT(DISTINCT sku)>1)) AS caseInsensitiveCollisionGroups`),
    rows(`SELECT COUNT(*) AS asinWithMultipleLiveSku,
                 COALESCE(SUM(skuCount),0) AS liveSkuRowsInThoseAsin
          FROM (
            SELECT storeIndex, asin, COUNT(DISTINCT sku) AS skuCount
            FROM "AmazonListingHealthItem"
            WHERE isBuyable=1 AND asin IS NOT NULL AND asin<>''
            GROUP BY storeIndex, asin
            HAVING COUNT(DISTINCT sku)>1
          )`),
    rows(`${scopeCte}
          SELECT s.channel,
                 COUNT(*) AS channelListingRows,
                 COUNT(DISTINCT s.listingKey) AS uniqueListings,
                 COUNT(DISTINCT s.sku) AS uniqueRawSku,
                 SUM(CASE WHEN lc.sku IS NOT NULL THEN 1 ELSE 0 END) AS terminalCostRows,
                 SUM(CASE WHEN lc.totalCost IS NOT NULL AND lc.needsReview=0 THEN 1 ELSE 0 END) AS exactCostRows,
                 SUM(CASE WHEN lc.totalCost IS NOT NULL AND lc.needsReview=1 THEN 1 ELSE 0 END) AS estimateOrReviewCostRows,
                 SUM(CASE WHEN lc.sku IS NOT NULL AND lc.totalCost IS NULL THEN 1 ELSE 0 END) AS unsourceableRows,
                 SUM(CASE WHEN cr.sku IS NOT NULL THEN 1 ELSE 0 END) AS recipeRows,
                 SUM(CASE WHEN cr.componentRows > 0 AND cr.linkedComponents=cr.componentRows THEN 1 ELSE 0 END) AS allComponentsHaveLegacyDonorLinkRows,
                 SUM(CASE WHEN cr.unresolvedComponents > 0 THEN 1 ELSE 0 END) AS unresolvedComponentRows
          FROM scope s
          LEFT JOIN latest_cost lc ON lc.sku=s.sku
          LEFT JOIN component_rollup cr ON cr.sku=s.sku
          GROUP BY s.channel ORDER BY s.channel`),
    rows(`SELECT COUNT(*) AS donorProducts,
                 SUM(CASE WHEN mainImageUrl IS NOT NULL OR (imageUrls IS NOT NULL AND json_valid(imageUrls)=1 AND json_array_length(imageUrls)>0) THEN 1 ELSE 0 END) AS withAnyImage,
                 SUM(CASE WHEN imageUrls IS NOT NULL AND json_valid(imageUrls)=1 AND json_array_length(imageUrls)>=5 THEN 1 ELSE 0 END) AS withFiveImages,
                 SUM(CASE WHEN upc IS NOT NULL OR gtin IS NOT NULL THEN 1 ELSE 0 END) AS withBarcode,
                 SUM(CASE WHEN description IS NOT NULL AND description<>'' THEN 1 ELSE 0 END) AS withDescription,
                 SUM(CASE WHEN ingredients IS NOT NULL AND ingredients<>'' THEN 1 ELSE 0 END) AS withIngredients,
                 SUM(CASE WHEN nutritionFacts IS NOT NULL AND nutritionFacts<>'' THEN 1 ELSE 0 END) AS withNutrition,
                 SUM(CASE WHEN needsReview=1 THEN 1 ELSE 0 END) AS needsReview
          FROM "DonorProduct"`),
    rows(`SELECT COUNT(*) AS donorOffers,
                 SUM(CASE WHEN isFirstParty=1 THEN 1 ELSE 0 END) AS firstParty,
                 SUM(CASE WHEN isFirstParty=1 AND pricePerUnit IS NOT NULL THEN 1 ELSE 0 END) AS pricedFirstParty,
                 SUM(CASE WHEN isFirstParty=1 AND pricePerUnit IS NOT NULL
                                AND COALESCE(datetime(fetchedAt),updatedAt) >= datetime('now','-7 days') THEN 1 ELSE 0 END) AS freshPricedFirstParty,
                 SUM(CASE WHEN zip IS NOT NULL AND zip<>'' THEN 1 ELSE 0 END) AS withZip,
                 SUM(CASE WHEN inStock IS NULL THEN 1 ELSE 0 END) AS unknownAvailability,
                 SUM(CASE WHEN productUrl IS NULL OR productUrl='' THEN 1 ELSE 0 END) AS withoutSourceUrl,
                 SUM(CASE WHEN datetime(fetchedAt) IS NOT NULL THEN 1 ELSE 0 END) AS parseableFetchedAt,
                 MIN(fetchedAt) AS oldestFetchedAt,
                 MAX(fetchedAt) AS newestFetchedAt,
                 MAX(updatedAt) AS newestUpdatedAt
          FROM "DonorOffer"`),
    optionalRows(`SELECT status, COUNT(*) AS jobs, MIN(queuedAt) AS oldestQueuedAt,
                         MAX(attempts) AS maxAttempts
                  FROM "EnrichmentJob" GROUP BY status ORDER BY status`),
    optionalRows(`SELECT CASE
                           WHEN value IS NULL OR value='' THEN 0
                           WHEN json_valid(value)=1 THEN json_array_length(value)
                           ELSE -1
                         END AS queuedSku
                  FROM "Setting" WHERE key='enrich_priority_skus' LIMIT 1`),
    optionalRows(`SELECT COUNT(*) AS rows, COUNT(DISTINCT sku) AS uniqueSku
                  FROM "EnrichedReadySku"`),
    rows(`SELECT
            (SELECT COUNT(*) FROM "SkuComponent") AS skuComponentRows,
            (SELECT COUNT(DISTINCT sku) FROM "SkuComponent") AS skuComponentSku,
            (SELECT COUNT(*) FROM "SkuComponent" sc LEFT JOIN "DonorProduct" dp ON dp.id=sc.donorProductId
              WHERE sc.donorProductId IS NOT NULL AND dp.id IS NULL) AS orphanSkuComponent,
            (SELECT COUNT(*) FROM "DonorOffer" o LEFT JOIN "DonorProduct" dp ON dp.id=o.donorProductId
              WHERE dp.id IS NULL) AS orphanDonorOffer,
            (SELECT COUNT(*) FROM "SkuCost" WHERE source='retail:batch') AS retailCostRows,
            (SELECT COUNT(DISTINCT sku) FROM "SkuCost" WHERE source='retail:batch') AS retailCostSku,
            (SELECT COUNT(*) FROM (SELECT sku FROM "SkuCost" WHERE source='retail:batch' GROUP BY sku HAVING COUNT(*)>1)) AS multiPeriodCostSku,
            (SELECT COUNT(*) FROM "DonorOffer" WHERE isFirstParty=1 AND (sellerName IS NULL OR sellerName='')) AS firstPartyWithoutSellerEvidence`),
    rows(`SELECT COUNT(*) AS rows,
                 COUNT(DISTINCT sku) AS uniqueSku,
                 COUNT(DISTINCT effectiveDate) AS effectiveDates,
                 MIN(effectiveDate) AS oldestEffectiveDate,
                 MAX(effectiveDate) AS newestEffectiveDate
          FROM "SkuCost" WHERE source='retail:batch'`),
  ]);

  const warnings: string[] = [];
  for (const row of walmartStores) {
    const age = ageHours(row.newestSyncedAt, nowMs);
    if (age == null || age > 36) warnings.push(`Walmart store ${row.storeIndex} mirror is ${age ?? "unknown"}h old; refresh before freezing Phase 1 scope.`);
  }
  if (walmartReport.length === 0) warnings.push("No completed/requested Walmart ITEM_CATALOG report is recorded; the current mirror may be the known-underreporting /v3/items fallback.");
  else {
    const downloaded = walmartReport.find((row) => String(row.status).toUpperCase() === "DOWNLOADED");
    const mirrorRows = walmartStores.reduce((sum, row) => sum + number(row.mirrorRows), 0);
    if (!downloaded) warnings.push("Walmart ITEM_CATALOG records exist, but none of the latest records is DOWNLOADED; mirror provenance is not authoritative.");
    else if (number(downloaded.rowCount) !== mirrorRows) warnings.push(`Latest downloaded Walmart ITEM_CATALOG rowCount (${number(downloaded.rowCount)}) does not match mirror rows (${mirrorRows}).`);
  }
  warnings.push("Amazon health mirrors are provisional census sources even when fresh; freeze scope only from per-account GET_MERCHANT_LISTINGS_ALL_DATA reports.");
  const syncByStore = new Map(amazonSync.map((row) => [number(row.storeIndex), row]));
  for (const row of amazonStores) {
    const store = number(row.storeIndex);
    const fullSweepAge = ageHours(syncByStore.get(store)?.lastFullSweepAt, nowMs);
    if (fullSweepAge == null || fullSweepAge > 36) warnings.push(`Amazon store ${store} full sweep is ${fullSweepAge ?? "unknown"}h old; mirror is not authoritative enough to freeze scope.`);
    if (number(row.mirrorRows) === 1000) warnings.push(`Amazon store ${store} mirror stops at exactly 1000 rows, the known Listings Items enumeration ceiling; use a fresh merchant listings report for authoritative scope.`);
  }
  if (number(integrity[0]?.orphanSkuComponent) > 0) warnings.push("SkuComponent contains orphan donor links; recipe/content coverage is overstated until repaired.");
  if (number(costHistory[0]?.uniqueSku) > 0 && number(integrity[0]?.multiPeriodCostSku) < Math.max(2, number(costHistory[0]?.uniqueSku) * 0.01)) warnings.push("Retail cost history is effectively absent; current recost path deletes prior periods for almost every SKU.");
  if (number(offerCoverage[0]?.unknownAvailability) > 0) warnings.push("Some offers have unknown availability; they are not procurement-ready.");
  if (number(offerCoverage[0]?.freshPricedFirstParty) === 0 && number(offerCoverage[0]?.pricedFirstParty) > 0) warnings.push("No first-party priced offer is fresh within 7 days; current offers cannot support a procurement decision without refresh.");
  if (number(scopeCollisions[0]?.rawSkuOnMultipleListings) > 0) warnings.push("Some raw SKU values occur in multiple channel/account listings; coverage joins by global SKU can overstate or misattribute truth until listingKey mappings are canonical.");
  if (number(scopeCollisions[0]?.caseInsensitiveCollisionGroups) > 0) warnings.push("Case-insensitive SKU collisions exist and require explicit canonical mapping.");
  if (number(amazonAsinCollisions[0]?.asinWithMultipleLiveSku) > 0) warnings.push("Some Amazon ASINs have multiple live SKU; ASIN-level sales metrics must be deduplicated before aggregation.");
  warnings.push("This mirror/catalog baseline is provisional diagnostics only. It can never substitute for hashed raw ITEM_CATALOG and GET_MERCHANT_LISTINGS_ALL_DATA reports plus complete owner store dispositions.");

  const output = {
    contractVersion: "product-truth-baseline/v2",
    generatedAt: generatedAt.toISOString(),
    database: databaseLabel(databaseUrl),
    readOnly: true,
    authoritative: false,
    authority: {
      authoritativePhase1Manifest: false,
      consumerCutoverEligible: false,
      reason: "This script reads mutable marketplace mirrors and legacy raw-SKU coverage joins; only the offline report manifest builder can produce an authoritative Phase 1 scope artifact.",
    },
    scopeDefinition: {
      grain: "one listing = (channel, storeIndex, raw sku); listingKey = channel:storeIndex:sku",
      walmart: "WalmartCatalogItem.publishedStatus = PUBLISHED; authoritative only when a fresh completed ITEM_CATALOG report proves the mirror source",
      amazon: "AmazonListingHealthItem.isBuyable = true; provisional until reconciled with a fresh GET_MERCHANT_LISTINGS_ALL_DATA report",
      note: "Non-buyable Amazon rows and non-published Walmart rows remain visible in source-status counts but are outside the initial sellable scope.",
    },
    sourceFreshness: {
      walmartStores,
      walmartStatuses,
      walmartItemReports: walmartReport,
      marketplaceAccounts,
      amazonStores,
      amazonSalesDeduplicatedByAsin: amazonAsinSales,
      amazonStatuses,
      amazonSync,
    },
    phase1Scope: {
      byChannel: scopeCounts,
      combined: scopeCombined[0] ?? {},
      crossChannelSku: number(scopeOverlap[0]?.crossChannelSku),
      collisions: scopeCollisions[0] ?? {},
      amazonAsinMultiplicity: amazonAsinCollisions[0] ?? {},
      coverageSemantics: "LEGACY_RAW_SKU_DIAGNOSTIC_ONLY_NOT_EXACT_LISTING_TRUTH",
      coverageByChannel: scopeCoverage,
    },
    catalog: {
      donors: donorCoverage[0] ?? {},
      offers: offerCoverage[0] ?? {},
      enrichedReady: enrichedReady[0] ?? { rows: 0, uniqueSku: 0 },
    },
    queues: {
      enrichmentJobs: queueStatus,
      legacyPrioritySku: number(priorityQueue[0]?.queuedSku),
    },
    integrity: integrity[0] ?? {},
    costHistory: costHistory[0] ?? {},
    warnings,
  };

  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.close();
  });
