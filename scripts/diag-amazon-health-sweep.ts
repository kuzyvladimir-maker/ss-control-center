// Validate the Amazon Listing Health sweep end-to-end against a small slice:
// resolve sellerId → list+score a few pages → upsert rows → (no snapshot/prune
// since we cap pages so the sweep won't "complete"). Inspect what landed in DB.
//
//   npx tsx scripts/diag-amazon-health-sweep.ts 3 3   # store3, max 3 pages
//   npx tsx scripts/diag-amazon-health-sweep.ts 1 2

import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { syncListingHealth } from "@/lib/amazon/growth/persist-listing-health";

async function main() {
  const storeIndex = Number(process.argv[2] ?? 3);
  const maxPages = Number(process.argv[3] ?? 3);
  console.log(`Sweeping store${storeIndex}, maxPages=${maxPages}…\n`);

  const result = await syncListingHealth(prisma, storeIndex, { maxPages, budgetMs: 120_000 });
  console.log("Sweep result:", JSON.stringify(result, null, 2));

  const rows = await prisma.amazonListingHealthItem.findMany({
    where: { storeIndex },
    orderBy: { healthScore: "asc" },
    take: 8,
  });
  console.log(`\nWorst ${rows.length} scored items in DB:`);
  for (const r of rows) {
    console.log(
      `  ${r.healthScore?.toFixed(0).padStart(3)} | ` +
        `${r.isSuppressed ? "SUPPRESSED" : r.isBuyable ? "buyable   " : "inactive  "} | ` +
        `E${r.errorIssueCount} W${r.warningIssueCount} | fix=${r.topFixComponent ?? "-"} | ` +
        `${(r.itemName ?? "").slice(0, 60)}`,
    );
  }

  const agg = await prisma.amazonListingHealthItem.aggregate({
    where: { storeIndex },
    _avg: { healthScore: true },
    _count: true,
  });
  console.log(`\nTotal rows store${storeIndex}: ${agg._count}, avg health: ${agg._avg.healthScore?.toFixed(1)}`);
  process.exit(0);
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
