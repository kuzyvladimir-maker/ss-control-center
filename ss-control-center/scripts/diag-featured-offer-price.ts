// Diagnostic — Featured Offer Expected Price (FOEP) probe.
//
// Purpose: verify the SP-API app has the "Product Pricing" role and see,
// for a sample of live SKUs, the price Amazon expects would win the
// Featured Offer (the same number the "Match Featured Offer Price"
// dashboard card shows) vs. our current listing price.
//
// READ ONLY — does not change any price.
//
// Run:  npx tsx scripts/diag-featured-offer-price.ts [storeIndex] [sampleSize]
//       (defaults: store 1, 15 SKUs)

import "dotenv/config";
import { spApiPost, MARKETPLACE_ID } from "@/lib/amazon-sp-api/client";
import { getMerchantToken } from "@/lib/amazon-sp-api/sellers";
import { listSkus } from "@/lib/amazon-sp-api/listings";

const FOEP_PATH =
  "/batches/products/pricing/2022-05-01/offer/featuredOfferExpectedPrice";

function money(v: unknown): string {
  if (v == null) return "—";
  const n = typeof v === "number" ? v : Number((v as any)?.amount ?? v);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : String(v);
}

async function main() {
  const storeIndex = Number(process.argv[2] ?? 1);
  const sampleSize = Math.min(Number(process.argv[3] ?? 15), 20); // batch max 20

  console.log(`Marketplace: ${MARKETPLACE_ID}`);
  console.log(`Store: store${storeIndex}  |  sample: ${sampleSize} SKUs\n`);

  const sellerId = await getMerchantToken(storeIndex);
  console.log(`Merchant token: ${sellerId}\n`);

  // 1) Pull a sample of SKUs (with their own offer so we know current price)
  const page = await listSkus(storeIndex, sellerId, {
    pageSize: sampleSize,
    includedData: ["summaries", "offers"],
  });
  const skus = page.items.map((i) => i.sku).filter(Boolean);
  console.log(`Pulled ${skus.length} SKUs (of ${page.numberOfResults} total).\n`);

  if (skus.length === 0) {
    console.log("No SKUs returned — nothing to probe.");
    process.exit(0);
  }

  // Current price per SKU from the listings "offers" block, when present.
  const currentPrice = new Map<string, number>();
  for (const item of page.items) {
    const offers = (item as any).offers as any[] | undefined;
    const price = offers?.[0]?.price?.amount ?? offers?.[0]?.price;
    if (price != null && item.sku) currentPrice.set(item.sku, Number(price));
  }

  // 2) Build the FOEP batch request (each entry is a "sub-request").
  const body = {
    requests: skus.map((sku) => ({
      uri: "/products/pricing/2022-05-01/offer/featuredOfferExpectedPrice",
      method: "GET",
      marketplaceId: MARKETPLACE_ID,
      sku,
    })),
  };

  console.log("Calling getFeaturedOfferExpectedPriceBatch…\n");
  let resp: any;
  try {
    resp = await spApiPost(FOEP_PATH, body, { storeId: `store${storeIndex}` });
  } catch (e: any) {
    console.error("❌ FOEP call FAILED:");
    console.error(String(e?.message ?? e));
    if (/403|Access to requested resource is denied|Unauthorized/i.test(String(e))) {
      console.error(
        "\n→ Looks like the SP-API app is MISSING the 'Product Pricing' role.\n" +
          "  Fix: Seller Central → Apps & Services → Develop Apps → edit the app →\n" +
          "  add the 'Pricing' role, then re-authorize. Until then FOEP is blocked.",
      );
    }
    process.exit(1);
  }

  // 3) Print results.
  const responses: any[] = resp?.responses ?? [];
  console.log(`Got ${responses.length} responses.\n`);
  console.log(
    "SKU".padEnd(24) +
      "Current".padEnd(10) +
      "FOEP".padEnd(10) +
      "Δ".padEnd(9) +
      "Status",
  );
  console.log("-".repeat(70));

  let winnable = 0;
  responses.forEach((r, idx) => {
    const sku = skus[idx] ?? "?";
    const status = r?.body?.featuredOfferExpectedPriceResults?.[0]?.resultStatus
      ?? r?.status?.statusCode
      ?? "?";
    const result = r?.body?.featuredOfferExpectedPriceResults?.[0];
    const foep =
      result?.featuredOfferExpectedPrice?.listingPrice?.amount ??
      result?.featuredOfferExpectedPrice?.listingPrice ??
      null;
    const cur = currentPrice.get(sku) ?? null;
    const delta = foep != null && cur != null ? cur - foep : null;
    const flag =
      delta != null && delta > 0 ? "  ← lower to win" : delta != null && delta <= 0 ? "  ok" : "";
    if (delta != null && delta > 0) winnable++;
    console.log(
      sku.slice(0, 22).padEnd(24) +
        money(cur).padEnd(10) +
        money(foep).padEnd(10) +
        (delta != null ? (delta >= 0 ? "+" : "") + delta.toFixed(2) : "—").padEnd(9) +
        String(status) +
        flag,
    );
  });

  console.log("-".repeat(70));
  console.log(
    `\n${winnable}/${responses.length} sampled SKUs are priced ABOVE the Featured Offer ` +
      `(could win by lowering).`,
  );
  console.log(
    "\nNOTE: this is a SAMPLE and READ-ONLY. No prices were changed.",
  );
  process.exit(0);
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
