// Drive the Amazon Growth report state machine to completion for one store and
// report what got enriched. Requests FYP + Sales&Traffic, polls until both
// ingest (or timeout), then prints suppression + conversion + buy-box coverage.
//
//   npx tsx scripts/diag-amazon-reports.ts 3

import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { advanceReports } from "@/lib/amazon/growth/reports";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const storeIndex = Number(process.argv[2] ?? 3);
  const deadline = Date.now() + 8 * 60_000;
  console.log(`Driving reports for store${storeIndex} (force-fresh)…\n`);

  let round = 0;
  while (Date.now() < deadline) {
    round++;
    // staleHours: 0 on first round forces a fresh request even if a recent one exists.
    const steps = await advanceReports(prisma, storeIndex, { staleHours: round === 1 ? 0 : 12 });
    for (const s of steps) {
      console.log(`  r${round} ${s.reportType}: ${s.action}${s.status ? ` (${s.status})` : ""}${s.rowsEnriched != null ? ` rows=${s.rowsEnriched}` : ""}${s.error ? ` ERR=${s.error}` : ""}`);
    }
    const parsed = await prisma.amazonGrowthReport.count({
      where: { storeIndex, status: "PARSED", doneAt: { gte: new Date(Date.now() - 10 * 60_000) } },
    });
    if (parsed >= 2) break;
    await sleep(20_000);
  }

  // Coverage after ingest.
  const [supp, withConv, withBb, sample] = await Promise.all([
    prisma.amazonListingHealthItem.count({ where: { storeIndex, isSuppressed: true } }),
    prisma.amazonListingHealthItem.count({ where: { storeIndex, conversionScore: { not: null } } }),
    prisma.amazonListingHealthItem.count({ where: { storeIndex, buyBoxPercentage: { not: null } } }),
    prisma.amazonListingHealthItem.findMany({
      where: { storeIndex, isSuppressed: true },
      take: 3,
    }),
  ]);
  console.log(`\nstore${storeIndex} after ingest: suppressed=${supp}, withConversionScore=${withConv}, withBuyBoxPct=${withBb}`);
  for (const s of sample) {
    console.log(`  SUPPRESSED ${s.sku} health=${s.healthScore} reason="${s.suppressionReason}"`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
