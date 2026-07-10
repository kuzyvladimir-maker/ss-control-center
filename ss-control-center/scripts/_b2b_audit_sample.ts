// Does losing B2B / min / max correlate with being REPRICED by our cron?
// RepriceLog holds every SKU the engine SCANNED. Those with action='repriced'
// got a destructive PUT; those only ever 'no_competition'/'skipped_*' were read
// but never written — a clean control group on the same store.
// READ-ONLY (getListing only).
import { config } from "dotenv";
config({ path: ".env.local" }); config({ path: ".env" });

const N = 20;

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { getListing } = await import("@/lib/amazon-sp-api/listings");
  const { getMerchantToken } = await import("@/lib/amazon-sp-api/sellers");

  const repricedRows = await prisma.repriceLog.findMany({
    where: { storeIndex: 1, dryRun: false, action: "repriced" },
    select: { sku: true }, distinct: ["sku"],
  });
  const repriced = new Set(repricedRows.map((r) => r.sku));

  const scannedRows = await prisma.repriceLog.findMany({
    where: { storeIndex: 1, dryRun: false },
    select: { sku: true }, distinct: ["sku"],
  });
  const control = scannedRows.map((r) => r.sku).filter((s) => !repriced.has(s));

  console.log(`store1: ${repriced.size} SKUs were REPRICED (written), ${control.length} were only scanned (never written)\n`);

  const sellerId = await getMerchantToken(1);
  const check = async (sku: string) => {
    try {
      const l = (await getListing(1, sellerId, sku)) as { attributes?: Record<string, unknown> };
      const offers = (l.attributes?.purchasable_offer ?? []) as Array<Record<string, unknown>>;
      const consumer = offers.find((o) => o.audience === "ALL" || o.audience == null);
      return {
        ok: true,
        b2b: offers.some((o) => o.audience === "B2B"),
        min: !!consumer && "minimum_seller_allowed_price" in consumer,
        max: !!consumer && "maximum_seller_allowed_price" in consumer,
      };
    } catch { return { ok: false, b2b: false, min: false, max: false }; }
  };

  const run = async (label: string, skus: string[]) => {
    let n = 0, b2b = 0, min = 0, max = 0;
    for (const s of skus.slice(0, N)) {
      const r = await check(s);
      if (!r.ok) continue;
      n++; if (r.b2b) b2b++; if (r.min) min++; if (r.max) max++;
      await new Promise((res) => setTimeout(res, 250));
    }
    const pct = (x: number) => `${x}/${n} (${n ? Math.round((100 * x) / n) : 0}%)`;
    console.log(`${label.padEnd(24)} B2B present ${pct(b2b).padEnd(14)} min ${pct(min).padEnd(14)} max ${pct(max)}`);
  };

  await run("REPRICED by cron", [...repriced]);
  await run("CONTROL (never written)", control);

  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
