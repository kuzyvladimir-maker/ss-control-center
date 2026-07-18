// LIVE price audit for Uncrustables. The old _scan_prices.ts reads our DB cache
// (channelSKU.price_cents); this reads the REAL marketplace price via the Amazon
// Product Pricing offers API, so it catches ChannelMAX drift / stale cache — the
// exact gap the owner spotted (24ct showing $46 and $96 while DB says on-model).
//
// For each live Uncrustables SKU: live price → classify vs cost-model
// (floor=landed×1.3 / target=landed×1.5 / ceiling=landed×1.53) and show DB drift.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { getListingOffersBatch } = await import("@/lib/amazon-sp-api/pricing");
  const { priceFor, classify } = await import("@/lib/pricing/cost-model");

  const rows = await prisma.channelSKU.findMany({
    where: { title: { contains: "Uncrustables" }, listing_status: { in: ["LIVE", "SUBMITTED"] } },
    select: { sku: true, asin: true, title: true, price_cents: true, channel: true },
  });
  // Amazon only (frozen Uncrustables never on Walmart). Bundle-factory Uncrustables
  // live on store1 (Salutem) — same assumption the reprice scripts use.
  const amazon = rows.filter((r) => !(r.channel ?? "").toLowerCase().includes("walmart"));
  const byStore = new Map<number, typeof amazon>([[1, amazon]]);
  console.log(`Uncrustables live/submitted (Amazon): ${amazon.length}\n`);

  type Rec = { sku: string; asin: string | null; store: number; total: number; live: number | null; db: number; target: number; floor: number; ceiling: number; status: string; drift: number | null };
  const out: Rec[] = [];

  for (const [store, list] of byStore) {
    const bySku = new Map(list.map((r) => [r.sku, r]));
    for (let i = 0; i < list.length; i += 20) {
      const chunk = list.slice(i, i + 20).map((r) => r.sku);
      let offers;
      try { offers = await getListingOffersBatch(store, chunk); }
      catch (e: any) { console.error(`  store${store} batch err: ${String(e?.message).slice(0, 90)}`); continue; }
      for (const o of offers) {
        const r = bySku.get(o.sku)!;
        const model = priceFor(r.title ?? "");
        const mine = o.offers?.find((x: any) => x.isBuyBoxWinner) ?? o.offers?.[0];
        const live = mine?.listingPrice ?? o.buyBoxLanded ?? null;
        const db = (r.price_cents ?? 0) / 100;
        out.push({
          sku: o.sku, asin: r.asin, store, total: model?.total ?? -1, live, db,
          target: model?.target ?? 0, floor: model?.floor ?? 0, ceiling: model?.ceiling ?? 0,
          status: model ? classify(live, model) : "UNKNOWN",
          drift: live != null ? Math.round((live - db) * 100) / 100 : null,
        });
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  }

  const low = out.filter((r) => r.status === "LOW");
  const high = out.filter((r) => r.status === "HIGH");
  const ok = out.filter((r) => r.status === "OK");
  const noOffer = out.filter((r) => r.live == null);
  console.log(`LIVE vs MODEL:  OK ${ok.length} | LOW(<floor) ${low.length} | HIGH(>ceiling) ${high.length} | no-live-offer ${noOffer.length}`);
  const drift = out.filter((r) => r.live != null && Math.abs(r.drift!) >= 2);
  console.log(`DB≠LIVE drift (|Δ|≥$2, i.e. cache wrong or ChannelMAX moved it): ${drift.length}\n`);

  const fmt = (r: Rec) => `  ${r.sku}  ${r.asin ?? "-"}  s${r.store}  ${r.total}ct  LIVE $${r.live}  (db $${r.db}, target $${r.target}, floor $${r.floor}, ceil $${r.ceiling})`;
  if (low.length) { console.log("── BELOW FLOOR (live) ──"); low.sort((a, b) => a.live! - b.live!).forEach((r) => console.log(fmt(r))); }
  if (high.length) { console.log("\n── ABOVE CEILING (live) ──"); high.sort((a, b) => b.live! - a.live!).forEach((r) => console.log(fmt(r))); }

  // 24ct group the owner called out explicitly
  const c24 = out.filter((r) => r.total === 24).sort((a, b) => (a.live ?? 0) - (b.live ?? 0));
  console.log(`\n── 24ct group (${c24.length}); model target $${c24[0]?.target ?? "?"} ──`);
  c24.forEach((r) => console.log(`  ${r.sku}  ${r.asin ?? "-"}  LIVE $${r.live}  [${r.status}]  (db $${r.db})`));

  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
