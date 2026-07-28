// Cross-check EVERY Uncrustables listing on DATA (deterministic, no vision):
//   • TITLE total count vs RECIPE total (sum of composition qty) — the B0H85MGP35
//     bug (title 24, recipe only Honey 12). This is the fulfillment-critical one.
//   • TITLE flavor count vs RECIPE flavor count (variety pack with 1-flavor recipe).
//   • PRICE vs cost-model band.
// Prints a categorized report so we know EXACTLY which listings are wrong.
import "dotenv/config";
import type { Variant } from "@/lib/bundle-factory/variation-matrix";

async function main() {
  const { prisma } = await import("@/lib/prisma");
  const { priceFor, classify, parseTotal } = await import("@/lib/pricing/cost-model");

  const skus = await prisma.channelSKU.findMany({
    where: { title: { contains: "Uncrustables" } },
    select: { sku: true, asin: true, title: true, price_cents: true, master_bundle_id: true, listing_status: true },
  });

  const titleFlavorCount = (t: string) => {
    // Flavors in these titles are joined by " and "; a single flavor has none.
    const head = t.split(/,\s*\d+\s*count/i)[0] ?? t;
    const parts = head.split(/\s+and\s+/i).filter((p) => /butter|spread|jam|jelly|hazelnut|honey|berry|chocolate/i.test(p));
    return Math.max(1, parts.length);
  };

  async function compOf(sku: { master_bundle_id: string | null }): Promise<Variant["composition"] | null> {
    if (!sku.master_bundle_id) return null;
    const dd = await prisma.bundleDraft.findFirst({ where: { master_bundle_id: sku.master_bundle_id }, select: { id: true } });
    const draftId = dd?.id ?? null;
    if (!draftId) return null;
    const d = await prisma.bundleDraft.findUnique({ where: { id: draftId }, select: { variation_matrix: { select: { selected_variant_idx: true, variants_json: true } } } });
    if (!d?.variation_matrix || d.variation_matrix.selected_variant_idx == null) return null;
    try { return JSON.parse(d.variation_matrix.variants_json)[d.variation_matrix.selected_variant_idx]?.composition ?? null; } catch { return null; }
  }

  const totalMismatch: any[] = [], flavorMismatch: any[] = [], priceLow: any[] = [], priceHigh: any[] = [], noRecipe: any[] = [];
  let clean = 0;
  for (const s of skus) {
    const comp = await compOf(s);
    const tTotal = parseTotal(s.title ?? "");
    const price = (s.price_cents ?? 0) / 100;
    const pstatus = classify(price, priceFor(s.title ?? ""));
    let bad = false;
    if (!comp) { noRecipe.push({ sku: s.sku, asin: s.asin }); bad = true; }
    else {
      const cTotal = comp.reduce((a, c) => a + (c.qty ?? 0), 0);
      const cFlavors = comp.length;
      const tFlavors = titleFlavorCount(s.title ?? "");
      if (tTotal > 0 && cTotal > 0 && tTotal !== cTotal) { totalMismatch.push({ sku: s.sku, asin: s.asin, titleTotal: tTotal, recipeTotal: cTotal, recipe: comp.map((c) => `${c.qty}×${c.product_name.replace(/smucker'?s |uncrustables |frozen /gi, "").slice(0, 22)}`).join(" + ") }); bad = true; }
      if (tFlavors !== cFlavors) { flavorMismatch.push({ sku: s.sku, asin: s.asin, titleFlavors: tFlavors, recipeFlavors: cFlavors }); bad = true; }
    }
    if (pstatus === "LOW") { priceLow.push({ sku: s.sku, price }); bad = true; }
    if (pstatus === "HIGH") { priceHigh.push({ sku: s.sku, price }); bad = true; }
    if (!bad) clean++;
  }

  const p = (label: string, arr: any[]) => { console.log(`\n── ${label}: ${arr.length} ──`); arr.slice(0, 60).forEach((x) => console.log("  " + JSON.stringify(x))); };
  console.log(`\n===== ${skus.length} Uncrustables SKUs checked =====`);
  console.log(`CLEAN (no data issue): ${clean}`);
  p("TITLE↔RECIPE TOTAL MISMATCH (fulfillment-critical)", totalMismatch);
  p("TITLE↔RECIPE FLAVOR-COUNT MISMATCH", flavorMismatch);
  p("NO RECIPE RESOLVED", noRecipe);
  p("PRICE BELOW COST (LOW)", priceLow);
  console.log(`\nPRICE OVER CEILING (HIGH): ${priceHigh.length} (separate decision)`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
