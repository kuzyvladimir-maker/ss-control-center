// Smoke: end-to-end funds run against Turso with a TEMP payout (deleted after).
// Run: npx tsx --env-file=.env scripts/smoke-finance.ts
import { runDistribution } from "@/lib/finance/run";
import { prisma } from "@/lib/prisma";

(async () => {
  const funds = await prisma.fund.findMany();
  console.log(`Funds: ${funds.map((f) => `${f.name}[${f.group}]`).join(", ")}`);

  // Insert a temporary manual payout to exercise the waterfall, then remove it.
  const tmp = await prisma.payout.create({
    data: { marketplace: "manual", externalId: `smoke:${Math.round(performance.now())}`, netAmount: 1000, source: "manual", depositDate: "2026-06-20" },
  });
  try {
    const run = await runDistribution({ preview: true });
    console.log("Preview with $1000 in:", JSON.stringify(run.distribution, null, 2));
  } finally {
    await prisma.payout.delete({ where: { id: tmp.id } });
    console.log("temp payout removed");
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
