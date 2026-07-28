import assert from "node:assert/strict";
import { createClient } from "@libsql/client";
import { test } from "node:test";

import { computeCatalogStats } from "@/lib/catalog/catalog-stats";

test("catalog stats count latest cost state, not historical rows", async () => {
  const db = createClient({ url: "file::memory:" });
  try {
    for (const sql of [
      `CREATE TABLE WalmartCatalogItem (sku TEXT, publishedStatus TEXT)`,
      `CREATE TABLE SkuCost (id TEXT, sku TEXT, source TEXT, totalCost REAL, needsReview INTEGER, effectiveDate TEXT, updatedAt TEXT, createdAt TEXT)`,
      `CREATE TABLE DonorProduct (id TEXT)`,
      `CREATE TABLE DonorOffer (id TEXT)`,
      `CREATE TABLE SkuComponent (sku TEXT, costMethod TEXT)`,
      `INSERT INTO WalmartCatalogItem VALUES ('A','PUBLISHED'),('B','PUBLISHED')`,
      `INSERT INTO SkuCost VALUES
        ('a-old','A','retail:batch',5.00,0,'2026-07-01','2026-07-01','2026-07-01'),
        ('a-new','A','retail:batch',NULL,1,'2026-07-18','2026-07-18','2026-07-18'),
        ('b-old','B','retail:batch',4.00,1,'2026-07-01','2026-07-01','2026-07-01'),
        ('b-new','B','retail:batch',6.00,0,'2026-07-18','2026-07-18','2026-07-18')`,
      `INSERT INTO SkuComponent VALUES ('A','unsourceable'),('B','exact')`,
    ]) await db.execute(sql);

    const stats = await computeCatalogStats(db);
    assert.equal(stats.costedTotal, 1, "only B latest period is costed");
    assert.equal(stats.costedPublished, 1);
    assert.equal(stats.needsReview, 1, "A latest terminal state needs review");
    assert.equal(stats.exact, 1);
    assert.equal(stats.withBom, 2);
  } finally {
    await db.close();
  }
});
