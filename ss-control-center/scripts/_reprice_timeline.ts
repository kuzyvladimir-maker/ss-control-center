// Did a MASS run happen today? Owner says min/max/B2B were there in the morning
// and gone by midday. Test: reprices per day, DISTINCT SKUs per day, and how many
// SKUs got their FIRST-EVER live reprice today (= newly pulled into scope).
// The cron only reprices SKUs that have a SkuCost row — and the COGS chat has been
// mass-costing the catalog, which would silently EXPAND the repricer's scope.
// READ-ONLY.
import { config } from "dotenv";
config({ path: ".env.local" }); config({ path: ".env" });

async function main() {
  const { prisma } = await import("@/lib/prisma");

  const rows = await prisma.repriceLog.findMany({
    where: { dryRun: false, action: "repriced" },
    select: { sku: true, createdAt: true, storeIndex: true },
    orderBy: { createdAt: "asc" },
  });

  const day = (d: Date) => d.toISOString().slice(0, 10);
  const perDay = new Map<string, { n: number; skus: Set<string> }>();
  const firstSeen = new Map<string, string>(); // sku -> first day repriced
  for (const r of rows) {
    const k = day(r.createdAt);
    if (!perDay.has(k)) perDay.set(k, { n: 0, skus: new Set() });
    const e = perDay.get(k)!;
    e.n++; e.skus.add(r.sku);
    if (!firstSeen.has(r.sku)) firstSeen.set(r.sku, k);
  }

  console.log("date        reprices  distinctSKUs  first-ever-repriced-that-day");
  for (const [d, e] of [...perDay.entries()].sort()) {
    const firsts = [...firstSeen.entries()].filter(([, fd]) => fd === d).length;
    console.log(`${d}   ${String(e.n).padStart(6)}  ${String(e.skus.size).padStart(11)}  ${String(firsts).padStart(6)}`);
  }

  // Hour-by-hour for today
  const today = day(new Date(rows[rows.length - 1].createdAt));
  console.log(`\n=== ${today} by hour (UTC) ===`);
  const perHour = new Map<string, { n: number; skus: Set<string> }>();
  for (const r of rows) {
    if (day(r.createdAt) !== today) continue;
    const h = r.createdAt.toISOString().slice(11, 13);
    if (!perHour.has(h)) perHour.set(h, { n: 0, skus: new Set() });
    const e = perHour.get(h)!; e.n++; e.skus.add(r.sku);
  }
  for (const [h, e] of [...perHour.entries()].sort()) {
    console.log(`  ${h}:00  reprices=${String(e.n).padStart(5)}  distinctSKUs=${e.skus.size}`);
  }

  // Has the repricer's SCOPE (SkuCost rows) exploded recently?
  const costTotal = await prisma.skuCost.count();
  const costDistinct = (await prisma.skuCost.findMany({ select: { sku: true }, distinct: ["sku"] })).length;
  console.log(`\nSkuCost rows: ${costTotal} | distinct SKUs with a cost: ${costDistinct}`);
  console.log("(the cron only reprices SKUs that have a SkuCost row)");

  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
