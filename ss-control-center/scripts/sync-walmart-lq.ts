// Run a Listing Quality sweep pass against the LIVE (Turso) DB — used to seed
// the Walmart Growth module after deploy / on demand. Resumable: re-run until
// sweepComplete=true. The nightly cron does the same thing automatically.
//   npx tsx scripts/sync-walmart-lq.ts
import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { getWalmartClient } from "@/lib/walmart/client";
import { syncListingQuality } from "@/lib/walmart/persist-listing-quality";

async function main() {
  const client = getWalmartClient(1);
  const result = await syncListingQuality(prisma, client, 1, {
    budgetMs: 240_000,
    maxPages: 30,
  });
  console.log(JSON.stringify(result, null, 2));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
