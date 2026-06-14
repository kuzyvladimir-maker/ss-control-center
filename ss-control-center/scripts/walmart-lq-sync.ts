// Refresh the listing-quality mirror (WalmartListingQualityItem) by running the
// resumable sweep until a full pass completes (or a wall-clock cap). This is the
// per-item snapshot of score + conversion + page views + GMV used as the
// before/after baseline for remediation analytics.
//
//   npx tsx scripts/walmart-lq-sync.ts            # run until full sweep or 8 min
//   npx tsx scripts/walmart-lq-sync.ts 15         # cap at 15 minutes

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });
import { prisma } from "../src/lib/prisma";
import { getWalmartClient } from "../src/lib/walmart/client";
import { syncListingQuality } from "../src/lib/walmart/persist-listing-quality";

async function main() {
  const capMin = Number(process.argv[2]) || 8;
  const deadline = Date.now() + capMin * 60_000;
  const client = getWalmartClient(1);
  let runs = 0;
  while (Date.now() < deadline) {
    const r: any = await syncListingQuality(prisma as any, client, 1, { budgetMs: 60_000, maxPages: 25, pacingMs: 1500 });
    runs++;
    console.log(`run ${runs}: pages=${r.pagesThisSweep ?? r.pages ?? "?"} items=${r.itemsThisSweep ?? r.items ?? "?"} done=${r.sweepComplete ?? r.done ?? "?"} sellerScore=${r.sellerScore ?? "?"}`);
    if (r.sweepComplete || r.done) { console.log("full sweep complete"); break; }
  }
  await prisma.$disconnect?.();
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
