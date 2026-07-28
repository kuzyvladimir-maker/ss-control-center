// "Why did Amazon reject this listing?" — non-mutating SP-API VALIDATION_PREVIEW.
//
// The distribution pipeline only stores listing_status=FAILED, not Amazon's
// reason. This asks Amazon directly and prints the exact issue codes. PUT with
// mode=VALIDATION_PREVIEW validates the payload and NEVER writes the listing,
// so it is safe to run against live SKUs.
//
//   SKUS=AB-CDEF-GHIJ,KL-MNOP-QRST npx tsx scripts/_amz_preview.ts
//
// Common codes seen on this catalog:
//   8572  — UPC doesn't match Amazon's brand records (usually a wrong `brand`)
//   8566  — SKU matches no ASIN and can't create one (UPC/GS1)
//   99300 — bullets/description contain promotional OR sale/shipping claims
//           (use scripts/_bisect_99300.ts to find the exact offending bullet)
//   90000900 (WARNING) — recommended_browse_nodes ignored for this product type
import { config } from "dotenv";
config({ path: ".env.local" }); config({ path: ".env" });

async function main() {
  const skus = (process.env.SKUS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!skus.length) { console.error("set SKUS=sku1,sku2"); process.exit(1); }

  const { prisma } = await import("@/lib/prisma");
  const { buildAmazonPayload } = await import("@/lib/bundle-factory/distribution/amazon-publish");
  const { channelTarget } = await import("@/lib/bundle-factory/distribution/account-map");
  const { spApiPut, MARKETPLACE_ID } = await import("@/lib/amazon-sp-api/client");
  const { getMerchantToken } = await import("@/lib/amazon-sp-api/sellers");
  const { productTypeForBundle } = await import("@/lib/bundle-factory/attributes");

  for (const sku of skus) {
    const row = await prisma.channelSKU.findFirst({ where: { sku } });
    if (!row) { console.log(`${sku}: NOT FOUND`); continue; }
    const mb = row.master_bundle_id
      ? await prisma.masterBundle.findUnique({ where: { id: row.master_bundle_id }, select: { brand: true, category: true } })
      : null;
    const storeIndex = (channelTarget(row.channel) as { storeIndex: number }).storeIndex;
    const payload = buildAmazonPayload(row as never, productTypeForBundle(), mb?.brand, mb?.category);

    console.log(`\n=== ${sku} | ${row.channel} store${storeIndex} | db=${row.listing_status} | brand=${mb?.brand} ===`);
    console.log(`    ${row.title?.slice(0, 72)}`);
    try {
      const sellerId = await getMerchantToken(storeIndex);
      const url = `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku)}`;
      const preview = (await spApiPut(url, payload, {
        storeId: `store${storeIndex}`,
        params: { marketplaceIds: MARKETPLACE_ID, mode: "VALIDATION_PREVIEW" },
      })) as { status?: string; issues?: Array<{ severity?: string; code?: string; message?: string; attributeNames?: string[] }> };
      console.log(`    status: ${preview?.status}`);
      for (const i of preview?.issues ?? []) {
        console.log(`    • [${i.severity}] ${i.code} — ${String(i.message).slice(0, 150)}`);
        if (i.attributeNames?.length) console.log(`        attrs: ${i.attributeNames.join(", ")}`);
      }
    } catch (e) {
      console.log(`    PREVIEW ERROR: ${(e as Error).message.slice(0, 200)}`);
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
