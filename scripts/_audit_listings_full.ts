// DEFINITIVE live audit: getListing for every Uncrustables SKU → real set price
// + the min/max price BAND + buyability status, vs cost-model. Ground truth
// (works even for no-buy-box listings the offers API misses). Reveals WHY prices
// are off: stale bands (max < model target ⇒ reprice rejected, err 90147) and
// ChannelMAX pricing within whatever band exists.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { getListing } = await import("@/lib/amazon-sp-api/listings");
  const { getMerchantToken } = await import("@/lib/amazon-sp-api/sellers");
  const { priceFor, classify } = await import("@/lib/pricing/cost-model");
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const rows = await prisma.channelSKU.findMany({
    where: { title: { contains: "Uncrustables" }, listing_status: { in: ["LIVE", "SUBMITTED"] } },
    select: { sku: true, asin: true, title: true, price_cents: true, channel: true },
  });
  const list = rows.filter((r) => !(r.channel ?? "").toLowerCase().includes("walmart"));
  const sellerId = await getMerchantToken(1);
  console.log(`auditing ${list.length} Uncrustables listings (live prices + bands)…\n`);

  type Rec = { sku: string; asin: string | null; total: number; live: number | null; bmin: number | null; bmax: number | null; target: number; floor: number; ceiling: number; status: string; buyable: boolean; bandBlocks: boolean };
  const out: Rec[] = [];
  let done = 0;
  for (const r of list) {
    try {
      const l: any = await getListing(1, sellerId, r.sku);
      const a = l.attributes ?? {};
      const po = (a.purchasable_offer ?? []).find((x: any) => x.audience === "ALL") ?? a.purchasable_offer?.[0];
      const live = po?.our_price?.[0]?.schedule?.[0]?.value_with_tax ?? null;
      const bmin = po?.minimum_seller_allowed_price?.[0]?.schedule?.[0]?.value_with_tax ?? null;
      const bmax = po?.maximum_seller_allowed_price?.[0]?.schedule?.[0]?.value_with_tax ?? null;
      const st: string[] = l.summaries?.[0]?.status ?? [];
      const model = priceFor(r.title ?? "");
      const target = model?.target ?? 0;
      out.push({
        sku: r.sku, asin: r.asin, total: model?.total ?? -1, live, bmin, bmax,
        target, floor: model?.floor ?? 0, ceiling: model?.ceiling ?? 0,
        status: model ? classify(live, model) : "UNKNOWN",
        buyable: st.includes("BUYABLE"),
        bandBlocks: bmax != null && bmax < target, // max band too low → can't reprice up to target
      });
    } catch (e: any) {
      out.push({ sku: r.sku, asin: r.asin, total: -1, live: null, bmin: null, bmax: null, target: 0, floor: 0, ceiling: 0, status: "ERROR", buyable: false, bandBlocks: false });
    }
    if (++done % 25 === 0) console.log(`  …${done}/${list.length}`);
    await sleep(180);
  }

  const low = out.filter((r) => r.status === "LOW");
  const high = out.filter((r) => r.status === "HIGH");
  const ok = out.filter((r) => r.status === "OK");
  const notBuyable = out.filter((r) => !r.buyable && r.status !== "ERROR");
  const bandBlocked = out.filter((r) => r.bandBlocks);
  const errored = out.filter((r) => r.status === "ERROR");
  console.log(`\n════ RESULT (${out.length}) ════`);
  console.log(`vs MODEL:  OK ${ok.length} | BELOW-FLOOR ${low.length} | ABOVE-CEILING ${high.length} | ERROR ${errored.length}`);
  console.log(`NOT BUYABLE (suppressed / no buy box): ${notBuyable.length}`);
  console.log(`BAND BLOCKS model (max band < target ⇒ reprice-up rejected): ${bandBlocked.length}`);

  const fmt = (r: Rec) => `  ${r.sku}  ${r.asin ?? "-"}  ${r.total}ct  live $${r.live}  band[${r.bmin}–${r.bmax}]  target $${r.target}  floor $${r.floor}${r.buyable ? "" : "  ⚠NOT-BUYABLE"}`;
  if (low.length) { console.log("\n── BELOW FLOOR ──"); low.sort((a, b) => (a.live ?? 0) - (b.live ?? 0)).forEach((r) => console.log(fmt(r))); }
  if (high.length) { console.log("\n── ABOVE CEILING ──"); high.sort((a, b) => (b.live ?? 0) - (a.live ?? 0)).forEach((r) => console.log(fmt(r))); }
  if (bandBlocked.length) { console.log("\n── STALE BAND (max < target) ──"); bandBlocked.sort((a, b) => (a.bmax ?? 0) - (b.bmax ?? 0)).forEach((r) => console.log(fmt(r))); }
  if (notBuyable.length) { console.log("\n── NOT BUYABLE ──"); notBuyable.forEach((r) => console.log(fmt(r))); }

  // write full JSON for the fixer
  const fs = await import("node:fs");
  fs.writeFileSync("data/price-audit-live.json", JSON.stringify(out, null, 2));
  console.log(`\nwrote data/price-audit-live.json (${out.length} rows)`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
