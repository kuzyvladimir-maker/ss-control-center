// Does the live listing carry min/max (the "band") and a B2B offer?
// Compare SKUs the cron NEVER repriced vs SKUs it repriced many times.
// If the destructive replace wiped bands, the repriced group should have none.
// READ-ONLY (getListing).
import { config } from "dotenv";
config({ path: ".env.local" }); config({ path: ".env" });

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { getListing } = await import("@/lib/amazon-sp-api/listings");
  const { getMerchantToken } = await import("@/lib/amazon-sp-api/sellers");

  const untouched = ["P5-EYLN-3YHG", "BU-F2V0-UOCV", "RU-NSMF-CG31", "T4-Y0G0-ZHII"];

  // store1 SKUs the cron actually repriced (most recent first)
  const repricedRows = await prisma.repriceLog.findMany({
    where: { dryRun: false, action: "repriced", storeIndex: 1 },
    orderBy: { createdAt: "desc" }, select: { sku: true }, distinct: ["sku"], take: 4,
  });
  const repriced = repricedRows.map((r) => r.sku);

  // Bundle Factory SKUs — published WITH a band by promote-draft.
  const bf = await prisma.channelSKU.findMany({
    where: { listing_status: "LIVE", channel: "AMAZON_SALUTEM" },
    select: { sku: true }, take: 2,
  });

  const sellerId = await getMerchantToken(1);
  const inspect = async (sku: string, label: string) => {
    try {
      const l = (await getListing(1, sellerId, sku)) as { attributes?: Record<string, unknown> };
      const offers = (l.attributes?.purchasable_offer ?? []) as Array<Record<string, unknown>>;
      const consumer = offers.find((o) => o.audience === "ALL" || o.audience == null);
      const has = (k: string) => (consumer && k in consumer ? "yes" : "NO");
      const b2b = offers.some((o) => o.audience === "B2B") ? "yes" : "NO";
      const price = (consumer?.our_price as Array<{ schedule: Array<{ value_with_tax: number }> }> | undefined)?.[0]?.schedule?.[0]?.value_with_tax;
      const n = await prisma.repriceLog.count({ where: { sku, dryRun: false, action: "repriced" } });
      console.log(`  ${label.padEnd(12)} ${sku.padEnd(15)} price=$${String(price).padEnd(7)} min=${has("minimum_seller_allowed_price").padEnd(3)} max=${has("maximum_seller_allowed_price").padEnd(3)} b2b=${b2b.padEnd(3)} cron-reprices=${n}`);
    } catch (e) {
      console.log(`  ${label.padEnd(12)} ${sku}: ${(e as Error).message.slice(0, 60)}`);
    }
  };

  console.log("=== NEVER repriced by our cron (the screenshot ones) ===");
  for (const s of untouched) await inspect(s, "untouched");
  console.log("\n=== REPRICED many times by our cron (store1) ===");
  for (const s of repriced) await inspect(s, "repriced");
  console.log("\n=== Bundle Factory listings (born WITH a band) ===");
  for (const s of bf) await inspect(s.sku, "bundle-fac");

  console.log("\n=== are any Bundle Factory SKUs in RepriceLog at all? ===");
  const bfAll = await prisma.channelSKU.findMany({ select: { sku: true } });
  const bfSkus = new Set(bfAll.map((b) => b.sku));
  const logged = await prisma.repriceLog.findMany({ where: { dryRun: false, action: "repriced" }, select: { sku: true }, distinct: ["sku"] });
  const overlap = logged.filter((l) => bfSkus.has(l.sku)).map((l) => l.sku);
  console.log(`  ${overlap.length} of ${bfSkus.size} BF SKUs were repriced by the cron${overlap.length ? ": " + overlap.slice(0, 6).join(", ") : ""}`);

  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
