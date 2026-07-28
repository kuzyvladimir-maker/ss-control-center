// Fix ONE mispriced live listing to the cost-model price (validation-preview → PATCH),
// and sync our channelSKU.price_cents. Owner-flagged: B0H85MGP35 was $44.30 (below
// the $51.50 landed cost for 24ct). Correct 24ct price = $76.99.
//
// Env: SKU=<sku>  PRICE=<dollars>  [DRY=1]
import "dotenv/config";
async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { getListing } = await import("@/lib/amazon-sp-api/listings");
  const { setListingPrice } = await import("@/lib/amazon-sp-api/pricing");
  const { getMerchantToken } = await import("@/lib/amazon-sp-api/sellers");
  const { priceFor } = await import("@/lib/pricing/cost-model");

  const sku = process.env.SKU!;
  const price = Number(process.env.PRICE);
  const DRY = process.env.DRY === "1";
  if (!sku || !Number.isFinite(price)) { console.error("set SKU and PRICE"); process.exit(1); }

  const row = await prisma.channelSKU.findFirst({ where: { sku }, select: { title: true, price_cents: true, channel: true } });
  console.log("SKU:", sku, "| current $", (row?.price_cents ?? 0) / 100, "| title:", row?.title?.slice(0, 70));
  const model = row?.title ? priceFor(row.title) : null;
  if (model) console.log(`model: total=${model.total} cooler=${model.cooler} landed=$${model.landed} target=$${model.target} floor=$${model.floor} suggested=$${model.suggested}`);
  console.log(`→ setting $${price}\n`);

  const store = 1;
  const sellerId = await getMerchantToken(store);
  const listing = await getListing(store, sellerId, sku);
  const productType = listing.summaries?.[0]?.productType;
  if (!productType) { console.error("no productType"); process.exit(1); }

  // The stuck low price is caused by a bad max band (=$44.30). Move the band:
  // floor protects margin, ceiling leaves repricer room, both allow the new price.
  const minPrice = process.env.MIN ? Number(process.env.MIN) : (model?.floor ?? undefined);
  const maxPrice = process.env.MAX ? Number(process.env.MAX) : Math.round(price * 1.10 * 100) / 100;
  console.log(`band: min=$${minPrice} max=$${maxPrice}`);

  const prev = await setListingPrice(store, sellerId, sku, productType, price, { validationPreview: true, minPrice, maxPrice });
  const errs = (prev?.issues ?? []).filter((i: any) => i?.severity === "ERROR");
  if (errs.length) { console.error("preview rejected:", JSON.stringify(errs)); process.exit(1); }
  console.log("preview OK");
  if (DRY) { console.log("DRY — not patching"); return; }

  const res = await setListingPrice(store, sellerId, sku, productType, price, { minPrice, maxPrice });
  console.log(`PATCH → status=${res?.status} sub=${res?.submissionId ?? "?"}`);
  await prisma.channelSKU.updateMany({ where: { sku }, data: { price_cents: Math.round(price * 100) } });
  console.log("synced channelSKU.price_cents");
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
