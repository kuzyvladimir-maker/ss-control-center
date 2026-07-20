// BAND-CONSISTENCY audit. The earlier audit only read our_price and so missed the
// real defect the owner spotted in Seller Central: the PRICE sits OUTSIDE the
// listing's own min/max band (e.g. price 78.76 vs max 76.99; price 48.43 vs min
// 66.95), which Amazon flags and which suppresses the offer.
//
// Reads, per SKU: consumer our_price, sale (discounted_price), min/max band,
// B2B offer price, and buyability. Classifies every violation. Writes
// data/band-audit.json for the fixer. Read-only.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });

// tsx now loads these as CJS-interop (named exports land under .default), so
// resolve both shapes rather than destructuring blindly.
async function mod(path: string): Promise<any> {
  const m: any = await import(path);
  return m?.default && typeof m.default === "object" ? { ...m.default, ...m } : m;
}

const money = (v: any): number | null => {
  const n = v?.[0]?.schedule?.[0]?.value_with_tax ?? v?.[0]?.value_with_tax ?? null;
  return typeof n === "number" ? n : null;
};

async function main() {
  const { prisma } = await mod("@/lib/prisma");
  const { getListing } = await mod("@/lib/amazon-sp-api/listings");
  const { getMerchantToken } = await mod("@/lib/amazon-sp-api/sellers");
  const { priceFor } = await mod("@/lib/pricing/cost-model");
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const where: any = { title: { contains: "Uncrustables" } };
  if (!process.env.ALL_STATUS) where.listing_status = { in: ["LIVE", "SUBMITTED"] };
  const rows = (await prisma.channelSKU.findMany({
    where, select: { sku: true, asin: true, title: true, price_cents: true, channel: true, listing_status: true, created_at: true },
  })).filter((r: any) => !(r.channel ?? "").toLowerCase().includes("walmart"));

  const sellerId = await getMerchantToken(1);
  console.log(`auditing ${rows.length} Uncrustables listings (price vs band vs sale vs B2B)…\n`);

  const out: any[] = [];
  let done = 0;
  for (const r of rows) {
    try {
      const l: any = await getListing(1, sellerId, r.sku);
      const offers: any[] = l.attributes?.purchasable_offer ?? [];
      const consumer = offers.find((o) => o.audience === "ALL") ?? offers[0];
      const b2b = offers.find((o) => o.audience === "B2B");
      const price = money(consumer?.our_price);
      const sale = money(consumer?.discounted_price);
      const min = money(consumer?.minimum_seller_allowed_price);
      const max = money(consumer?.maximum_seller_allowed_price);
      const bizPrice = money(b2b?.our_price);
      const st: string[] = l.summaries?.[0]?.status ?? [];
      const model = priceFor(r.title ?? "");

      const v: string[] = [];
      if (price == null) v.push("NO_PRICE");
      if (min == null || max == null) v.push("NO_BAND");
      if (price != null && max != null && price > max) v.push("PRICE_ABOVE_MAX");
      if (price != null && min != null && price < min) v.push("PRICE_BELOW_MIN");
      if (sale != null && min != null && sale < min) v.push("SALE_BELOW_MIN");
      if (bizPrice != null && min != null && bizPrice < min) v.push("B2B_BELOW_MIN");
      if (model) {
        if (min != null && Math.abs(min - model.floor) > 0.02) v.push("MIN_OFF_MODEL");
        if (max != null && Math.abs(max - model.suggested) > 0.02) v.push("MAX_OFF_MODEL");
        if (price != null && Math.abs(price - model.suggested) > 0.02) v.push("PRICE_OFF_MODEL");
      }
      if (!st.includes("BUYABLE")) v.push("NOT_BUYABLE");

      out.push({
        sku: r.sku, asin: r.asin, status: r.listing_status, total: model?.total ?? -1,
        price, sale, min, max, bizPrice, buyable: st.includes("BUYABLE"),
        modelPrice: model?.suggested ?? null, modelMin: model?.floor ?? null,
        violations: v,
      });
    } catch (e: any) {
      out.push({ sku: r.sku, asin: r.asin, error: String(e?.message).slice(0, 120), violations: ["ERROR"] });
    }
    if (++done % 25 === 0) console.log(`  …${done}/${rows.length}`);
    await sleep(170);
  }

  const tally: Record<string, number> = {};
  for (const r of out) for (const v of r.violations) tally[v] = (tally[v] ?? 0) + 1;
  const broken = out.filter((r) => r.violations.length > 0);
  const clean = out.length - broken.length;

  console.log(`\n════ BAND AUDIT (${out.length}) ════`);
  console.log(`CLEAN: ${clean}   BROKEN: ${broken.length}\n`);
  console.log("violations:");
  Object.entries(tally).sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(`  ${k}: ${n}`));

  const critical = out.filter((r) => r.violations.some((v: string) => ["PRICE_ABOVE_MAX", "PRICE_BELOW_MIN", "NO_BAND", "NOT_BUYABLE"].includes(v)));
  console.log(`\n── CRITICAL (price outside band / no band / not buyable): ${critical.length} ──`);
  critical.slice(0, 60).forEach((r) => console.log(
    `  ${r.sku}  ${r.asin ?? "-"}  ${r.total}ct  price $${r.price}  band[${r.min}–${r.max}]  sale $${r.sale}  b2b $${r.bizPrice}  → ${r.violations.join(",")}`
  ));
  if (critical.length > 60) console.log(`  …and ${critical.length - 60} more`);

  const fs = await import("node:fs");
  fs.writeFileSync("data/band-audit.json", JSON.stringify(out, null, 2));
  console.log(`\nwrote data/band-audit.json (${out.length} rows)`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
