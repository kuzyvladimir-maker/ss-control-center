// ChannelMAX File Uploader sheet for the 9 new Uncrustables SKUs.
// Launch SOP: repricer min = ROI floor, max = item price (base LIST price
// never moves; launch cheapness is coupons). Model = "Manual min/max" 59021.
// Tab-delimited, ASIN included (TC's row appears once Amazon assigns it).
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { readFileSync, writeFileSync } from "node:fs";

const SCRATCH = "/private/tmp/claude-501/-Users-vladimirkuznetsov-SS-Command-Center/1dbdc77d-9c20-49be-9e0d-c48b604008f6/scratchpad/";

async function main() {
  const p: any = await import("../src/lib/prisma");
  const prisma = p.prisma ?? p.default?.prisma;
  const cm: any = await import("../src/lib/pricing/cost-model");
  const priceFor = cm.priceFor ?? cm.default?.priceFor;

  const rows: any[] = JSON.parse(readFileSync(SCRATCH + "publish-batch12-skus.json", "utf8"));
  const lines = ["SKU\tASIN\tSellingVenue\tMinSellingPrice\tMaxSellingPrice\tRepricingModelID"];
  const skipped: string[] = [];
  for (const r of rows) {
    const sku = await prisma.channelSKU.findUnique({ where: { id: r.channel_sku_id }, select: { sku: true, asin: true, price_cents: true } });
    if (!sku?.asin) { skipped.push(r.sku); continue; }
    const model = priceFor(r.pack_count);
    lines.push([sku.sku, sku.asin, "Amazon_US", model.floor.toFixed(2), (sku.price_cents / 100).toFixed(2), "59021"].join("\t"));
  }
  const out = lines.join("\r\n") + "\r\n";
  writeFileSync(SCRATCH + "channelmax-batch12-9.txt", out);
  writeFileSync("/Users/vladimirkuznetsov/Desktop/channelmax-batch12-9.txt", out);
  console.log(out);
  console.log("skipped (no ASIN yet):", skipped.join(",") || "none");
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
