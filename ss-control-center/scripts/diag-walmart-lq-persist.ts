// Verify syncListingQuality() end-to-end against a LOCAL test DB (tmp-lqtest.db),
// never prod Turso. Build a file-bound Prisma client directly so @/lib/prisma's
// Turso branch is bypassed.
//   DATABASE_URL=file:./tmp-lqtest.db npx tsx scripts/diag-walmart-lq-persist.ts
import "dotenv/config";
import { resolve } from "path";
import { PrismaClient } from "@/generated/prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { getWalmartClient } from "@/lib/walmart/client";
import { syncListingQuality } from "@/lib/walmart/persist-listing-quality";

async function main() {
  const dbPath = resolve(process.cwd(), "tmp-lqtest.db");
  const adapter = new PrismaLibSql({ url: `file:${dbPath}` });
  const prisma = new PrismaClient({ adapter });

  const client = getWalmartClient(1);
  console.log("Running full sync into", dbPath, "...");
  const result = await syncListingQuality(prisma, client, 1);
  console.log("\n### SYNC RESULT ###");
  console.log(JSON.stringify(result, null, 2));

  // Read back: worklist ranked by traffic-but-low-score, and the snapshot.
  const snap = await prisma.walmartListingQualitySnapshot.findFirst({
    orderBy: { capturedAt: "desc" },
  });
  console.log("\n### LATEST SNAPSHOT ###");
  console.log(`overall=${snap?.listingQuality} content=${snap?.contentScore} shipping=${snap?.shippingScore} reviews=${snap?.ratingReviewScore} offer=${snap?.offerScore} price=${snap?.priceScore}`);

  const totalItems = await prisma.walmartListingQualityItem.count();
  const outOfStock = await prisma.walmartListingQualityItem.count({ where: { isInStock: false } });
  const noFastShip = await prisma.walmartListingQualityItem.count({ where: { isFastAndFreeShipping: false } });
  const noReviews = await prisma.walmartListingQualityItem.count({ where: { ratingCount: 0 } });
  const withTraffic = await prisma.walmartListingQualityItem.count({ where: { pageViews30d: { gt: 0 } } });
  console.log("\n### CATALOG ROLLUP ###");
  console.log(JSON.stringify({ totalItems, outOfStock, noFastShip, noReviews, withTraffic }, null, 2));

  // Highest-ROI worklist: items that get traffic but score low
  const roi = await prisma.walmartListingQualityItem.findMany({
    where: { pageViews30d: { gt: 0 } },
    orderBy: [{ pageViews30d: "desc" }],
    take: 10,
    select: { sku: true, productName: true, lqScore: true, pageViews30d: true, conversionRate30d: true, isInStock: true, gmv30d: true, topFixComponent: true },
  });
  console.log("\n### TOP 10 BY 30d TRAFFIC (highest ROI to fix) ###");
  for (const r of roi) {
    console.log(`  ${r.pageViews30d} views | LQ=${r.lqScore?.toFixed(0)} | conv=${r.conversionRate30d} | inStock=${r.isInStock} | gmv=$${r.gmv30d} | fix=${r.topFixComponent} | ${r.productName?.slice(0, 45)}`);
  }

  await prisma.$disconnect();
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
