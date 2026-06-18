/**
 * How are Uncrustables prices behaving now (store1) vs the snapshot we set.
 * Reads the stored snapshot (yesterday's prices + floor/target/ceiling), pulls
 * LIVE current price per SKU (getListing our_price), and reports movement +
 * where each sits in the [floor, target, ceiling] band.
 *
 * Run: npx tsx scripts/uncrustables-price-movement.ts
 */
import "dotenv/config";
import { prisma } from "@/lib/prisma";
import { getListing } from "@/lib/amazon-sp-api/listings";
import { getMerchantToken } from "@/lib/amazon-sp-api/sellers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ourPrice(po: any): number | null {
  if (!Array.isArray(po)) return null;
  const blk = po.find((o) => o.audience === "ALL") ?? po[0];
  const v = blk?.our_price?.[0]?.schedule?.[0]?.value_with_tax;
  return typeof v === "number" ? v : null;
}

async function main() {
  const row = await prisma.setting.findUnique({
    where: { key: "pricing_uncrustables_snapshot" },
  });
  if (!row) {
    console.log("No snapshot found — run pricing-warm first.");
    return;
  }
  const snap = JSON.parse(row.value);
  const rows = (snap.rows as any[]).filter((r) => r.store === 1);
  console.log(`Snapshot from ${snap.updatedAt}`);
  console.log(`store1 Uncrustables: ${rows.length}\n`);

  const sellerId = await getMerchantToken(1);
  const out: any[] = [];
  let inactive = 0,
    err = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    try {
      const listing = await getListing(1, sellerId, r.sku);
      const now = ourPrice((listing.attributes as any)?.purchasable_offer);
      if (now == null) {
        inactive++;
        continue;
      }
      out.push({ ...r, now });
    } catch {
      err++;
    }
    if ((i + 1) % 30 === 0) console.error(`…${i + 1}/${rows.length}`);
    await sleep(120);
  }

  // classify now vs band
  const f = (n: number) => `$${n.toFixed(2)}`;
  let atFloor = 0,
    belowFloor = 0,
    inBand = 0,
    atAboveTarget = 0,
    aboveCeil = 0;
  let movedDown = 0,
    movedUp = 0,
    flat = 0,
    moveDownSum = 0,
    moveUpSum = 0;
  for (const r of out) {
    const d = r.now - (r.current ?? r.now); // now vs snapshot price
    if (d < -0.5) {
      movedDown++;
      moveDownSum += -d;
    } else if (d > 0.5) {
      movedUp++;
      moveUpSum += d;
    } else flat++;

    if (r.now < r.floor - 0.5) belowFloor++;
    else if (r.now <= r.floor + 1) atFloor++;
    else if (r.now < r.target - 0.5) inBand++;
    else if (r.now <= r.ceiling + 0.5) atAboveTarget++;
    else aboveCeil++;
  }

  console.log(`=== read: ${out.length} live, ${inactive} inactive, ${err} err ===\n`);
  console.log(`=== MOVEMENT vs snapshot (${snap.updatedAt.slice(0, 10)}) ===`);
  console.log(`  moved DOWN: ${movedDown} (avg -$${movedDown ? (moveDownSum / movedDown).toFixed(2) : 0})`);
  console.log(`  moved UP:   ${movedUp} (avg +$${movedUp ? (moveUpSum / movedUp).toFixed(2) : 0})`);
  console.log(`  flat:       ${flat}`);
  console.log(`\n=== WHERE PRICES SIT NOW (band: floor → target → ceiling) ===`);
  console.log(`  below floor (!):     ${belowFloor}`);
  console.log(`  at floor:            ${atFloor}`);
  console.log(`  in band (floor→tgt): ${inBand}`);
  console.log(`  target→ceiling:      ${atAboveTarget}`);
  console.log(`  above ceiling (!):   ${aboveCeil}`);

  // biggest movers
  const movers = out
    .map((r) => ({ ...r, d: r.now - (r.current ?? r.now) }))
    .filter((r) => Math.abs(r.d) > 0.5)
    .sort((a, b) => a.d - b.d);
  console.log(`\n=== biggest DOWN moves ===`);
  console.log("total | floor | target | was → now | Δ | title");
  for (const r of movers.slice(0, 10))
    console.log(`  ${r.total} | ${f(r.floor)} | ${f(r.target)} | ${f(r.current)} → ${f(r.now)} | ${r.d > 0 ? "+" : ""}${r.d.toFixed(2)} | ${r.title.slice(0, 40)}`);
  console.log(`\n=== biggest UP moves ===`);
  for (const r of movers.slice(-6).reverse())
    console.log(`  ${r.total} | ${f(r.floor)} | ${f(r.target)} | ${f(r.current)} → ${f(r.now)} | +${r.d.toFixed(2)} | ${r.title.slice(0, 40)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
