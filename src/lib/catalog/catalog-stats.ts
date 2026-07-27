// Catalog / COGS / enrichment stats — the numbers behind the Catalog Status
// dashboard. One compute function shared by the live API (always-current) and the
// hourly snapshot cron (the time-series for the graph), so they can never diverge.

import { type Client } from "@libsql/client";

export interface CatalogStats {
  walmartTotal: number;
  walmartPublished: number;
  costedTotal: number;
  costedPublished: number; // published Walmart SKUs that have a cost (coverage numerator)
  needsReview: number;
  ownBrand: number;
  exact: number;
  linePrice: number;
  google: number;
  donorProducts: number;
  donorOffers: number;
  withBom: number;
}

const n = (r: any): number => Number(r?.rows?.[0]?.n ?? 0);

const LATEST_RETAIL_COST = `WITH latest_cost AS (
  SELECT * FROM (
    SELECT c.*, ROW_NUMBER() OVER (
      PARTITION BY c.sku
      ORDER BY COALESCE(c.effectiveDate,'') DESC, c.updatedAt DESC, c.createdAt DESC
    ) AS rn
    FROM "SkuCost" c WHERE c.source='retail:batch'
  ) ranked WHERE rn=1
)`;

export async function computeCatalogStats(db: Client): Promise<CatalogStats> {
  const [wTot, wPub, cTot, cPub, rev, donP, donO, bom, methods] = await Promise.all([
    db.execute(`SELECT COUNT(*) n FROM WalmartCatalogItem`),
    db.execute(`SELECT COUNT(*) n FROM WalmartCatalogItem WHERE publishedStatus='PUBLISHED'`),
    db.execute(`${LATEST_RETAIL_COST} SELECT COUNT(*) n FROM latest_cost WHERE totalCost IS NOT NULL`),
    db.execute(`${LATEST_RETAIL_COST} SELECT COUNT(*) n FROM WalmartCatalogItem w JOIN latest_cost c ON c.sku=w.sku WHERE w.publishedStatus='PUBLISHED' AND c.totalCost IS NOT NULL`),
    db.execute(`${LATEST_RETAIL_COST} SELECT COUNT(*) n FROM latest_cost WHERE needsReview=1`),
    db.execute(`SELECT COUNT(*) n FROM "DonorProduct"`).catch(() => ({ rows: [{ n: 0 }] })),
    db.execute(`SELECT COUNT(*) n FROM "DonorOffer"`).catch(() => ({ rows: [{ n: 0 }] })),
    db.execute(`SELECT COUNT(DISTINCT sku) n FROM "SkuComponent"`),
    db.execute(`SELECT costMethod m, COUNT(DISTINCT sku) c FROM "SkuComponent" GROUP BY costMethod`),
  ]);

  const byMethod: Record<string, number> = {};
  for (const row of (methods.rows as any[])) byMethod[String(row.m || "none")] = Number(row.c || 0);

  return {
    walmartTotal: n(wTot),
    walmartPublished: n(wPub),
    costedTotal: n(cTot),
    costedPublished: n(cPub),
    needsReview: n(rev),
    ownBrand: byMethod["own-brand"] || 0,
    exact: byMethod["exact"] || 0,
    linePrice: byMethod["line-price"] || 0,
    google: byMethod["google"] || 0,
    donorProducts: n(donP),
    donorOffers: n(donO),
    withBom: n(bom),
  };
}

/** Persist one snapshot row. */
export async function writeCatalogSnapshot(db: Client, s: CatalogStats, id: string, capturedAtIso: string): Promise<void> {
  await db.execute({
    sql: `INSERT INTO "CatalogSnapshot"
      (id, capturedAt, walmartTotal, walmartPublished, costedTotal, costedPublished, needsReview,
       ownBrand, exact, linePrice, google, donorProducts, donorOffers, withBom)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      id, capturedAtIso, s.walmartTotal, s.walmartPublished, s.costedTotal, s.costedPublished, s.needsReview,
      s.ownBrand, s.exact, s.linePrice, s.google, s.donorProducts, s.donorOffers, s.withBom,
    ],
  });
}

export interface SnapshotPoint extends CatalogStats { capturedAt: string; }

/** Read the most recent snapshots (oldest-first for charting). */
export async function readSnapshotSeries(db: Client, limit = 96): Promise<SnapshotPoint[]> {
  const r = await db.execute({
    sql: `SELECT capturedAt, walmartTotal, walmartPublished, costedTotal, costedPublished, needsReview,
                 ownBrand, exact, linePrice, google, donorProducts, donorOffers, withBom
          FROM "CatalogSnapshot" ORDER BY capturedAt DESC LIMIT ?`,
    args: [limit],
  });
  return (r.rows as any[])
    .map((x) => ({
      capturedAt: String(x.capturedAt),
      walmartTotal: Number(x.walmartTotal), walmartPublished: Number(x.walmartPublished),
      costedTotal: Number(x.costedTotal), costedPublished: Number(x.costedPublished),
      needsReview: Number(x.needsReview), ownBrand: Number(x.ownBrand), exact: Number(x.exact),
      linePrice: Number(x.linePrice), google: Number(x.google),
      donorProducts: Number(x.donorProducts), donorOffers: Number(x.donorOffers), withBom: Number(x.withBom),
    }))
    .reverse();
}
