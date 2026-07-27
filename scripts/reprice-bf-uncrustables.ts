// One-off — reprice the 3 Bundle-Factory Uncrustables listings to the FIXED
// pricing engine (computeBundlePrice: markup 2.3 on goods+packaging, shipping
// OUT of the item price — Vladimir 2026-07-01). These were minted overnight
// with the buggy formula (cooler-always-M + double-shipping); this recomputes
// each with the corrected engine and pushes the new item price via SP-API.
//
// Safe by default: PREVIEW (VALIDATION_PREVIEW, no mutation). Pass --apply to
// actually write. ChannelMAX does NOT manage these SKUs (not in its uploaded
// file → no Min set → it never reprices them), so there is no revert risk.
//
// Run:  npx tsx scripts/reprice-bf-uncrustables.ts           # preview only
//       npx tsx scripts/reprice-bf-uncrustables.ts --apply   # write live
//       npx tsx scripts/reprice-bf-uncrustables.ts --apply --db  # + sync our DB

import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: ".env" });

import { prisma } from "@/lib/prisma";
import { getMerchantToken } from "@/lib/amazon-sp-api/sellers";
import { getListing } from "@/lib/amazon-sp-api/listings";
import { getPricingModel, computeBundlePrice } from "@/lib/bundle-factory/pricing-config";
import { applyReprice } from "@/lib/pricing/uncrustables";

const STORE = 1; // AMAZON_SALUTEM
const TARGETS = [
  { asin: "B0H788M8WM", sku: "AZ-ASMY-VEQ2", count: 30 },
  { asin: "B0H784LMG6", sku: "UA-ASAO-RE7Q", count: 45 },
  { asin: "B0H786L5MW", sku: "VC-ASV1-378P", count: 90 },
];

async function liveItemPrice(sellerId: string, sku: string): Promise<number | null> {
  try {
    const l = await getListing(STORE, sellerId, sku);
    const po = (l.attributes as { purchasable_offer?: unknown })?.purchasable_offer as
      | Array<{ audience?: string; our_price?: Array<{ schedule?: Array<{ value_with_tax?: number }> }> }>
      | undefined;
    if (!Array.isArray(po) || !po.length) return null;
    const all = po.find((o) => o.audience === "ALL") ?? po[0];
    const v = all?.our_price?.[0]?.schedule?.[0]?.value_with_tax;
    return typeof v === "number" ? v : null;
  } catch {
    return null;
  }
}

async function main() {
  const apply = process.argv.includes("--apply");
  const syncDb = process.argv.includes("--db");
  const model = await getPricingModel();
  const sellerId = await getMerchantToken(STORE);

  console.log(`\nMode: ${apply ? "APPLY (live write)" : "PREVIEW (no mutation)"}`);
  console.log(`Pricing model: mode=${model.mode} markup=${model.markup} shipping_in_price=${model.shipping_in_price}\n`);
  console.log("ASIN         SKU            ct  live$     new$      Δ$      cooler  ship(sep)  preview");
  console.log("─".repeat(96));

  for (const t of TARGETS) {
    const priced = computeBundlePrice(
      { cogs_cents: t.count * 100, unit_count: t.count, weight_lb: null, category: "FROZEN_GROCERY" },
      model,
    );
    const newDollars = priced.selling_price_cents / 100;
    const live = await liveItemPrice(sellerId, t.sku);
    const shipSep = priced.cost.own_shipping_cents / 100;

    const res = await applyReprice(STORE, t.sku, newDollars, { preview: !apply });
    const delta = live != null ? (newDollars - live) : NaN;
    const row =
      `${t.asin}  ${t.sku.padEnd(13)}  ${String(t.count).padStart(2)}  ` +
      `${(live != null ? `$${live.toFixed(2)}` : "?").padStart(8)}  ` +
      `$${newDollars.toFixed(2).padStart(7)}  ` +
      `${(Number.isFinite(delta) ? (delta >= 0 ? "+" : "") + delta.toFixed(2) : "?").padStart(7)}  ` +
      `${(priced.cooler_size ?? "?").padEnd(5)}   $${shipSep.toFixed(2).padStart(5)}    ` +
      `${res.ok ? "OK " + (res.status ?? "") : "FAIL " + (res.error ?? "")}`;
    console.log(row);

    if (apply && syncDb && res.ok) {
      await prisma.channelSKU.updateMany({
        where: { sku: t.sku },
        data: { price_cents: priced.selling_price_cents },
      });
    }
  }
  console.log("");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
