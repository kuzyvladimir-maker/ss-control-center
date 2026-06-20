// Live smoke: Get Report (ingest Amazon settlement + Walmart recon) against Turso.
// Run: npx tsx --env-file=.env scripts/smoke-finance-report.ts
import { ingestAllPayouts } from "@/lib/finance/payouts";
import { prisma } from "@/lib/prisma";

(async () => {
  const results = await ingestAllPayouts(60);
  for (const r of results) {
    console.log(`\n[${r.marketplace}] created=${r.created} updated=${r.updated} errors=${r.errors.length}`);
    r.periods.slice(0, 6).forEach((p) => console.log(`   ${p.period}  net=${p.net}  ${p.externalId}`));
    r.errors.slice(0, 4).forEach((e) => console.log(`   ! ${e}`));
  }
  const payoutCount = await prisma.payout.count();
  const lineCount = await prisma.payoutLine.count();
  console.log(`\nDB: ${payoutCount} payouts, ${lineCount} lines`);

  // Aggregate breakdown
  const lines = await prisma.payoutLine.findMany();
  const agg = new Map<string, number>();
  for (const l of lines) agg.set(l.bucket, (agg.get(l.bucket) ?? 0) + l.amount);
  console.log("Breakdown:");
  for (const [b, a] of [...agg.entries()].sort((x, y) => y[1] - x[1])) console.log(`   ${b.padEnd(16)} ${a.toFixed(2)}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
