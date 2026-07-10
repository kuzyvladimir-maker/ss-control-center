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
  // Dimensions identify which hero is live:
  //   2048 = the AI cooler hero (image-generation.ts normalizes to 2048x2048)
  //   2200 = the real-photo box composite (composeUnitGrid canvas)
  if (loc) {
    const buf = Buffer.from(await (await fetch(loc)).arrayBuffer());
    const sharp = (await import("sharp")).default;
    const meta = await sharp(buf).metadata();
    const kind = meta.width === 2048 ? "→ COOLER HERO" : meta.width === 2200 ? "→ box composite" : "→ ?";
    console.log("LIVE image dims:", `${meta.width}x${meta.height}`, kind);
  }
  await prisma.$disconnect();
}
main().catch(e=>{console.error(e);process.exit(1);});
