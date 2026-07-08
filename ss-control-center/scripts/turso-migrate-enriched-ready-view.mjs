// One-off: EnrichedReadySku VIEW — the explicit "enriched AND image-ready" signal for
// the image/content chat (division-of-labor contract). A row exists ONLY when the SKU
// has a recipe donor WITH a harvested image gallery; costStatus tells clean/estimate/
// unsourceable; hasIdentity confirms the identity cache.
import { createClient } from "@libsql/client";
const clean = (v) => (v || "").trim().replace(/^['"]|['"]$/g, "");
const db = createClient({ url: clean(process.env.TURSO_DATABASE_URL), authToken: clean(process.env.TURSO_AUTH_TOKEN) });
await db.execute(`DROP VIEW IF EXISTS EnrichedReadySku`);
await db.execute(`CREATE VIEW EnrichedReadySku AS
  SELECT sc.sku,
         sc.idx           AS componentIdx,
         sc.qty           AS qty,
         sc.donorProductId,
         dp.title         AS donorTitle,
         dp.imageUrls     AS donorImageUrls,
         dp.mainImageUrl  AS donorMainImage,
         k.totalCost      AS totalCost,
         k.needsReview    AS needsReview,
         CASE WHEN k.sku IS NULL THEN 'uncosted'
              WHEN k.totalCost IS NULL THEN 'unsourceable'
              WHEN k.needsReview=1 THEN 'estimate'
              ELSE 'clean' END AS costStatus,
         (s.productIdentity IS NOT NULL) AS hasIdentity
  FROM SkuComponent sc
  JOIN DonorProduct dp ON dp.id = sc.donorProductId
  LEFT JOIN "SkuCost" k ON k.sku = sc.sku AND k.source='retail:batch'
  LEFT JOIN SkuShippingData s ON s.sku = sc.sku
  WHERE dp.imageUrls IS NOT NULL AND dp.imageUrls != '[]'`);
const n = await db.execute(`SELECT COUNT(DISTINCT sku) n FROM EnrichedReadySku`);
console.log("EnrichedReadySku view created; image-ready SKUs now:", n.rows[0].n);
process.exit(0);
