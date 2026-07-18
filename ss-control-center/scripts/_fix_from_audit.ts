// Fix every LIVE off-model Uncrustables (from data/price-audit-live.json) back to
// the model: price = suggested (round99 of landed×1.5), band = [floor, item].
// Price + band go in ONE patch so a stale low max (the VN-AS1A $156 trap → err
// 90147) is replaced in the same call. Preview → PUT → sync DB. [DRY=1] to preview.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { readFileSync } from "node:fs";

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { getListing } = await import("@/lib/amazon-sp-api/listings");
  const { setListingPrice } = await import("@/lib/amazon-sp-api/pricing");
  const { getMerchantToken } = await import("@/lib/amazon-sp-api/sellers");
  const { priceFor } = await import("@/lib/pricing/cost-model");
  const DRY = process.env.DRY === "1";
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const audit = JSON.parse(readFileSync("data/price-audit-live.json", "utf8")) as Array<{ sku: string; total: number; live: number | null; status: string }>;
  let bad = audit.filter((r) => r.status === "LOW" || r.status === "HIGH");
  if (process.env.SKUS) { const only = new Set(process.env.SKUS.split(",").map((s) => s.trim())); bad = bad.filter((r) => only.has(r.sku)); }
  if (process.env.EXCLUDE) { const skip = new Set(process.env.EXCLUDE.split(",").map((s) => s.trim())); bad = bad.filter((r) => !skip.has(r.sku)); }
  console.log(`off-model to fix: ${bad.length} | apply=${!DRY}\n`);

  const sellerId = await getMerchantToken(1);
  let ok = 0, fail = 0;
  for (const r of bad) {
    try {
      const model = priceFor(r.total);
      if (!model) { console.log(`✗ ${r.sku}: no model (total ${r.total})`); fail++; continue; }
      const price = model.suggested, minPrice = model.floor, maxPrice = model.suggested; // max = item price (SOP)
      const listing: any = await getListing(1, sellerId, r.sku);
      const pt = listing.summaries?.[0]?.productType;
      if (!pt) { console.log(`✗ ${r.sku}: no productType`); fail++; continue; }
      const prev: any = await setListingPrice(1, sellerId, r.sku, pt, price, { validationPreview: true, minPrice, maxPrice });
      const errs = (prev?.issues ?? []).filter((i: any) => i?.severity === "ERROR");
      if (errs.length) { console.log(`✗ ${r.sku}: preview rejected ${JSON.stringify(errs).slice(0, 130)}`); fail++; continue; }
      if (DRY) { console.log(`• ${r.sku} (${r.total}ct): $${r.live} → $${price}  band[${minPrice}–${maxPrice}]`); ok++; await sleep(200); continue; }
      const res: any = await setListingPrice(1, sellerId, r.sku, pt, price, { minPrice, maxPrice });
      await prisma.channelSKU.updateMany({ where: { sku: r.sku }, data: { price_cents: Math.round(price * 100) } });
      console.log(`✓ ${r.sku} (${r.total}ct): $${r.live} → $${price}  band[${minPrice}–${maxPrice}]  ${res?.status ?? ""}`);
      ok++; await sleep(500);
    } catch (e: any) { console.log(`✗ ${r.sku}: ERROR ${String(e?.message).slice(0, 130)}`); fail++; }
  }
  console.log(`\ndone: ${ok} ${DRY ? "would-fix" : "fixed"}, ${fail} failed`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
