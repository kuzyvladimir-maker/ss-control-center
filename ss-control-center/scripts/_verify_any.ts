import { config } from "dotenv";
config({ path: ".env.local" }); config({ path: ".env" });
async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { getListing } = await import("@/lib/amazon-sp-api/listings");
  const { getMerchantToken } = await import("@/lib/amazon-sp-api/sellers");
  const sku = process.env.SKU!;
  const skuRow = await prisma.channelSKU.findFirst({ where: { sku }, select: { channel: true, main_image_url: true } });
  const storeIndex = skuRow?.channel === "AMAZON_AMZCOM" ? 3 : 1;
  console.log("channel:", skuRow?.channel, "→ store", storeIndex, "| DB main:", skuRow?.main_image_url?.slice(60, 110));
  const sellerId = await getMerchantToken(storeIndex);
  const listing = await getListing(storeIndex, sellerId, sku);
  const img = (listing as any).attributes?.main_product_image_locator;
  const loc = img?.[0]?.media_location ?? "";
  console.log("LIVE image:", loc);
  // fetch dims to tell composite (2200) from old AI (2048)
  if (loc) {
    const buf = Buffer.from(await (await fetch(loc)).arrayBuffer());
    const sharp = (await import("sharp")).default;
    const meta = await sharp(buf).metadata();
    console.log("LIVE image dims:", `${meta.width}x${meta.height}`, meta.width === 2200 ? "→ COMPOSITE ✓" : meta.width === 2048 ? "→ still OLD AI (ingesting)" : "→ ?");
  }
  await prisma.$disconnect();
}
main().catch(e=>{console.error(e);process.exit(1);});
