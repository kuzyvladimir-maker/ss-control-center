// Fix all Uncrustables listings stuck BELOW the margin floor (bad low-max band,
// $44.30-style). Per SKU: model price from title → set price=suggested with a
// proper band (floor..suggested×1.10). Preview → PATCH → sync DB. Owner-flagged
// class of bug (below-cost prices losing money on every sale).
//
// Env: SKUS=a,b,c  (explicit)  or  BF_AUTO=1 (all LOW Uncrustables)  [DRY=1]
import "dotenv/config";
async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { getListing } = await import("@/lib/amazon-sp-api/listings");
  const { setListingPrice } = await import("@/lib/amazon-sp-api/pricing");
  const { getMerchantToken } = await import("@/lib/amazon-sp-api/sellers");
  const { priceFor, classify } = await import("@/lib/pricing/cost-model");
  const DRY = process.env.DRY === "1";
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // Which price statuses to correct to the model. Default LOW; set STATUS=HIGH
  // for the overpriced set, or STATUS=ALL for every non-OK listing.
  const STATUS = (process.env.STATUS || "LOW").toUpperCase();
  const wanted = (s: string) => STATUS === "ALL" ? s !== "OK" : STATUS.split(",").includes(s);
  let skus: string[];
  if (process.env.SKUS) skus = process.env.SKUS.split(",").map((s) => s.trim()).filter(Boolean);
  else if (process.env.BF_AUTO === "1") {
    const rows = await prisma.channelSKU.findMany({ where: { title: { contains: "Uncrustables" }, listing_status: { in: ["LIVE", "SUBMITTED"] } }, select: { sku: true, title: true, price_cents: true } });
    skus = rows.filter((r) => wanted(classify((r.price_cents ?? 0) / 100, priceFor(r.title ?? "")))).map((r) => r.sku);
  } else { console.error("set SKUS or BF_AUTO=1"); process.exit(1); }
  const exclude = new Set((process.env.BF_EXCLUDE || "").split(",").map((s) => s.trim()).filter(Boolean));
  if (exclude.size) skus = skus.filter((s) => !exclude.has(s));
  console.log(`fixing ${skus.length} SKUs | apply=${!DRY}${exclude.size ? ` | excluded ${exclude.size}` : ""}\n`);

  const store = 1;
  const sellerId = await getMerchantToken(store);
  let ok = 0, fail = 0;
  for (const sku of skus) {
    try {
      const row = await prisma.channelSKU.findFirst({ where: { sku }, select: { title: true, price_cents: true } });
      const model = priceFor(row?.title ?? "");
      if (!model) { console.log(`✗ ${sku}: no model (title?)`); fail++; continue; }
      const price = model.suggested, minPrice = model.floor, maxPrice = Math.round(model.suggested * 1.10 * 100) / 100;
      const listing = await getListing(store, sellerId, sku);
      const pt = listing.summaries?.[0]?.productType;
      if (!pt) { console.log(`✗ ${sku}: no productType`); fail++; continue; }
      const prev = await setListingPrice(store, sellerId, sku, pt, price, { validationPreview: true, minPrice, maxPrice });
      const errs = (prev?.issues ?? []).filter((i: any) => i?.severity === "ERROR");
      if (errs.length) { console.log(`✗ ${sku}: preview rejected ${JSON.stringify(errs).slice(0, 120)}`); fail++; continue; }
      if (DRY) { console.log(`✓ ${sku} (${model.total}ct): would set $${price} [$${(row!.price_cents ?? 0) / 100} → $${price}, band ${minPrice}-${maxPrice}]`); ok++; await sleep(300); continue; }
      const res = await setListingPrice(store, sellerId, sku, pt, price, { minPrice, maxPrice });
      await prisma.channelSKU.updateMany({ where: { sku }, data: { price_cents: Math.round(price * 100) } });
      console.log(`✓ ${sku} (${model.total}ct): $${(row!.price_cents ?? 0) / 100} → $${price}  status=${res?.status}`);
      ok++; await sleep(500);
    } catch (e: any) { console.log(`✗ ${sku}: ERROR ${e?.message?.slice(0, 120)}`); fail++; }
  }
  console.log(`\ndone: ${ok} fixed, ${fail} failed`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
