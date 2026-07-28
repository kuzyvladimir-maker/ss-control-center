// Turso migration: Reference Catalog (Donor DB) — DonorProduct + DonorOffer +
// EnrichmentJob. Product-centric knowledge base harvested from donor retailers,
// reused by COGS / listing-improvement / Bundle Factory. Idempotent.
// See docs/wiki/reference-catalog-engine.md.
//
//   node --env-file=.env --env-file=.env.local scripts/turso-migrate-reference-catalog.mjs

import { createClient } from "@libsql/client";
import crypto from "crypto";

function clean(v) { return v ? v.trim().replace(/^['"]|['"]$/g, "") : v; }
const url = clean(process.env.TURSO_DATABASE_URL);
const authToken = clean(process.env.TURSO_AUTH_TOKEN);
if (!url || !authToken) { console.error("Missing TURSO_DATABASE_URL / TURSO_AUTH_TOKEN"); process.exit(1); }
const client = createClient({ url, authToken });
console.log(`→ Target: ${url.split("@")[1] || url}`);

const existing = await client.execute({ sql: `SELECT name FROM sqlite_master WHERE type='table' AND name='DonorProduct'` });
if (existing.rows.length > 0) { console.log("· already migrated — skipping"); client.close(); process.exit(0); }

await client.batch([
  `CREATE TABLE "DonorProduct" (
     "id" TEXT NOT NULL PRIMARY KEY,
     "brand" TEXT,
     "productLine" TEXT,
     "flavor" TEXT,
     "containerType" TEXT,
     "size" TEXT,
     "unitMeasure" TEXT,
     "unitAmount" REAL,
     "category" TEXT,
     "upc" TEXT,
     "gtin" TEXT,
     "title" TEXT,
     "description" TEXT,
     "bullets" TEXT,
     "attributes" TEXT,
     "nutritionFacts" TEXT,
     "ingredients" TEXT,
     "mainImageUrl" TEXT,
     "imageUrls" TEXT,
     "bestPrice" REAL,
     "bestRetailer" TEXT,
     "pricePerMeasure" REAL,
     "currency" TEXT NOT NULL DEFAULT 'USD',
     "identityKey" TEXT NOT NULL,
     "confidence" REAL,
     "needsReview" BOOLEAN NOT NULL DEFAULT 0,
     "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
   )`,
  `CREATE UNIQUE INDEX "DonorProduct_identityKey_key" ON "DonorProduct"("identityKey")`,
  `CREATE INDEX "DonorProduct_brand_idx" ON "DonorProduct"("brand")`,
  `CREATE INDEX "DonorProduct_category_idx" ON "DonorProduct"("category")`,
  `CREATE INDEX "DonorProduct_bestPrice_idx" ON "DonorProduct"("bestPrice")`,

  `CREATE TABLE "DonorOffer" (
     "id" TEXT NOT NULL PRIMARY KEY,
     "donorProductId" TEXT NOT NULL,
     "retailer" TEXT NOT NULL,
     "retailerProductId" TEXT NOT NULL,
     "via" TEXT NOT NULL DEFAULT 'direct',
     "price" REAL,
     "packSizeSeen" INTEGER,
     "pricePerUnit" REAL,
     "currency" TEXT NOT NULL DEFAULT 'USD',
     "zip" TEXT,
     "inStock" BOOLEAN,
     "productUrl" TEXT,
     "sellerName" TEXT,
     "isFirstParty" BOOLEAN NOT NULL DEFAULT 0,
     "sourceApi" TEXT,
     "fetchedAt" TEXT,
     "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "DonorOffer_donorProductId_fkey" FOREIGN KEY ("donorProductId") REFERENCES "DonorProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE
   )`,
  `CREATE UNIQUE INDEX "DonorOffer_retailer_retailerProductId_key" ON "DonorOffer"("retailer","retailerProductId")`,
  `CREATE INDEX "DonorOffer_donorProductId_idx" ON "DonorOffer"("donorProductId")`,
  `CREATE INDEX "DonorOffer_retailer_idx" ON "DonorOffer"("retailer")`,

  `CREATE TABLE "EnrichmentJob" (
     "id" TEXT NOT NULL PRIMARY KEY,
     "targetType" TEXT NOT NULL,
     "target" TEXT NOT NULL,
     "status" TEXT NOT NULL DEFAULT 'queued',
     "source" TEXT NOT NULL DEFAULT 'manual',
     "priority" INTEGER NOT NULL DEFAULT 0,
     "requestedBy" TEXT,
     "attempts" INTEGER NOT NULL DEFAULT 0,
     "result" TEXT,
     "error" TEXT,
     "queuedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "startedAt" DATETIME,
     "finishedAt" DATETIME,
     "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
   )`,
  `CREATE INDEX "EnrichmentJob_status_queuedAt_idx" ON "EnrichmentJob"("status","queuedAt")`,
  `CREATE INDEX "EnrichmentJob_targetType_target_idx" ON "EnrichmentJob"("targetType","target")`,
], "write");

const NAME = "20260619160000_reference_catalog";
try {
  await client.execute({
    sql: `INSERT INTO "_prisma_migrations" ("id","checksum","finished_at","migration_name","logs","rolled_back_at","started_at","applied_steps_count")
          VALUES (?, ?, CURRENT_TIMESTAMP, ?, NULL, NULL, CURRENT_TIMESTAMP, 1)`,
    args: [crypto.randomUUID(), "turso-applied", NAME],
  });
  console.log(`✓ registered ${NAME}`);
} catch (e) { console.log(`  (bookkeeping skipped: ${e?.message})`); }
console.log("✓ Reference Catalog migration done (DonorProduct + DonorOffer + EnrichmentJob).");
client.close();
