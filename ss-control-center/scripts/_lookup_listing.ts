// One-off: inspect a live listing by ASIN — SKU, price fields, draft, flavors.
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
async function main() {
  const { prisma } = await import("@/lib/prisma");
  const asin = process.env.ASIN || "B0H85MGP35";
  // Discover which fields the ChannelSKU model actually has.
  const anySku = await prisma.channelSKU.findFirst({ select: { id: true } });
  const cols = anySku ? Object.keys(await prisma.channelSKU.findFirst({ where: { id: anySku.id } }) ?? {}) : [];
  console.log("ChannelSKU columns:", cols.join(", "));
  const priceFields = cols.filter((c) => /price|cost|min|max|amount/i.test(c));
  const asinField = cols.find((c) => /asin/i.test(c));
  console.log("asin field:", asinField, "| price-ish:", priceFields.join(", "));

  const rows = await prisma.channelSKU.findMany({
    where: asinField ? ({ [asinField]: asin } as any) : {},
    take: 5,
  });
  for (const r of rows as any[]) {
    const pick: any = { sku: r.sku, status: r.listing_status, draft: r.bundle_draft_id, mb: r.master_bundle_id };
    for (const f of priceFields) pick[f] = r[f];
    if (asinField) pick.asin = r[asinField];
    console.log(JSON.stringify(pick));
    if (r.bundle_draft_id) {
      const d = await prisma.bundleDraft.findUnique({ where: { id: r.bundle_draft_id }, select: { draft_name: true, category: true } });
      console.log("   draft:", d?.draft_name, "| cat:", d?.category);
    }
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e.message); process.exit(1); });
