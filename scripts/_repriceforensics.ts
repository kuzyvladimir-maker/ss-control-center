// Forensics: who wiped minimum/maximum_seller_allowed_price?
// Hypothesis: the every-2h Featured-Offer cron -> setListingPrice, which until
// today PUT `op:replace` on /attributes/purchasable_offer carrying ONLY
// our_price, deleting the min/max band (and any B2B offer) on every SKU it
// actually repriced. RepriceLog records each one. READ-ONLY.
import { config } from "dotenv";
config({ path: ".env.local" }); config({ path: ".env" });

const SCREENSHOT = ["P5-EYLN-3YHG", "BU-F2V0-UOCV", "RU-NSMF-CG31", "T4-Y0G0-ZHII"];

async function main() {
  const { prisma } = await import("@/lib/prisma");

  const total = await prisma.repriceLog.count();
  const live = await prisma.repriceLog.count({ where: { dryRun: false, action: "repriced" } });
  const dry = await prisma.repriceLog.count({ where: { dryRun: true } });
  console.log(`RepriceLog rows: ${total} | LIVE repriced: ${live} | dryRun: ${dry}`);

  const first = await prisma.repriceLog.findFirst({ where: { dryRun: false, action: "repriced" }, orderBy: { createdAt: "asc" } });
  const last = await prisma.repriceLog.findFirst({ where: { dryRun: false, action: "repriced" }, orderBy: { createdAt: "desc" } });
  console.log(`first LIVE reprice: ${first?.createdAt.toISOString()} (${first?.sku})`);
  console.log(`last  LIVE reprice: ${last?.createdAt.toISOString()} (${last?.sku})`);

  const distinct = await prisma.repriceLog.findMany({
    where: { dryRun: false, action: "repriced" },
    select: { sku: true }, distinct: ["sku"],
  });
  console.log(`\nDISTINCT SKUs whose price the cron actually changed: ${distinct.length}`);

  const byStore = await prisma.repriceLog.groupBy({
    by: ["storeIndex"], where: { dryRun: false, action: "repriced" }, _count: true,
  });
  console.log("by store:", byStore.map((s) => `store${s.storeIndex}=${(s as { _count: number })._count}`).join(", "));

  console.log("\n=== the SKUs from the screenshot ===");
  for (const sku of SCREENSHOT) {
    const rows = await prisma.repriceLog.findMany({
      where: { sku, dryRun: false, action: "repriced" }, orderBy: { createdAt: "desc" }, take: 3,
    });
    if (!rows.length) { console.log(`  ${sku}: never repriced by the cron`); continue; }
    console.log(`  ${sku}: ${rows.length}+ live reprices; latest:`);
    for (const r of rows) console.log(`     ${r.createdAt.toISOString()}  $${r.oldPrice} -> $${r.newPrice}  (${r.title?.slice(0, 32)})`);
  }

  console.log("\n=== last 8 live reprices overall ===");
  const recent = await prisma.repriceLog.findMany({ where: { dryRun: false, action: "repriced" }, orderBy: { createdAt: "desc" }, take: 8 });
  for (const r of recent) console.log(`  ${r.createdAt.toISOString()} store${r.storeIndex} ${r.sku} $${r.oldPrice} -> $${r.newPrice}`);

  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
