// Scan all live Uncrustables listings: current price vs cost-model floor/target.
// Flags SKUs stuck BELOW the margin floor (the $44.30-style bad-band problem).
import "dotenv/config";
async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { priceFor, classify } = await import("@/lib/pricing/cost-model");
  const rows = await prisma.channelSKU.findMany({
    where: { title: { contains: "Uncrustables" }, listing_status: { in: ["LIVE", "SUBMITTED"] } },
    select: { sku: true, asin: true, title: true, price_cents: true, listing_status: true },
  });
  console.log(`Uncrustables live/submitted SKUs: ${rows.length}\n`);
  let low = 0, high = 0, ok = 0, unknown = 0;
  const lows: any[] = [];
  for (const r of rows) {
    const cur = (r.price_cents ?? 0) / 100;
    const model = priceFor(r.title ?? "");
    const status = classify(cur, model);
    if (status === "LOW") { low++; lows.push({ sku: r.sku, asin: r.asin, cur, floor: model?.floor, target: model?.target, total: model?.total }); }
    else if (status === "HIGH") high++;
    else if (status === "OK") ok++;
    else unknown++;
  }
  console.log(`OK ${ok} | LOW ${low} | HIGH ${high} | UNKNOWN ${unknown}\n`);
  console.log("── BELOW FLOOR (stuck low / losing margin) ──");
  lows.sort((a, b) => a.cur - b.cur).forEach((l) => console.log(`  ${l.sku}  ${l.asin ?? ""}  ${l.total}ct  $${l.cur}  (floor $${l.floor}, target $${l.target})`));
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
