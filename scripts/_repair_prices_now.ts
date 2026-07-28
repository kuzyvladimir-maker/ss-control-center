// OWNER-ORDERED (Vladimir, 2026-07-19/20, verbatim: «когда ты уже поменяешь
// цены… сделать эти грёбаные минимум максимум правильные») direct repair of the
// 161 sealed-plan Uncrustables base offers. Surgical SEMANTICS without the
// ceremony: per SKU — live read → mergePurchasableOffer (rewrites ONLY the
// consumer our_price/min/max; preserves discounted_price a.k.a. Sale Price and
// the B2B sibling) → one PATCH. Targets are the sealed 2026-07-19 v3 plan's own
// canonical numbers (price=.99 model, min=floor, max=price). Idempotent: SKUs
// already at target are skipped. The 3 identity holds are not in the plan.
//
// Env: DRY=1 preview-only | LIMIT=n first n | SKUS=a,b,c subset
import { config } from "dotenv"; config({ path: ".env.local" }); config({ path: ".env" });
import { readFileSync } from "node:fs";

async function main() {
  const { getListing, patchListing } = await import("../src/lib/amazon-sp-api/listings");
  const { mergePurchasableOffer } = await import("../src/lib/amazon-sp-api/pricing");
  const { getMerchantToken } = await import("../src/lib/amazon-sp-api/sellers");
  const DRY = process.env.DRY === "1";
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const plan = JSON.parse(readFileSync(
    "data/repairs/base-offer-preserve/uncrustables-base-offer-preserve-20260719-v3/base-offer-preserve-plan.json", "utf8"));
  let entries: Array<{ sku: string; product_type: string; target: { regular_base: number; minimum: number; maximum: number } }> =
    plan.entries.map((e: any) => ({ sku: e.sku, product_type: e.product_type, target: e.target }));
  if (process.env.SKUS) { const only = new Set(process.env.SKUS.split(",").map((s) => s.trim())); entries = entries.filter((e) => only.has(e.sku)); }
  if (process.env.LIMIT) entries = entries.slice(0, Number(process.env.LIMIT));

  const sellerId = await getMerchantToken(1);
  console.log(`repair ${entries.length} SKUs | apply=${!DRY}\n`);
  const money = (o: any, k: string): number | null =>
    o?.[k]?.[0]?.schedule?.[0]?.value_with_tax ?? null;

  let ok = 0, skipped = 0, fail = 0;
  const failures: string[] = [];
  for (const e of entries) {
    const t = e.target;
    try {
      const live: any = await getListing(1, sellerId, e.sku);
      const offers: any[] = live.attributes?.purchasable_offer ?? [];
      const consumer = offers.find((o) => o.audience === "ALL" || o.audience == null);
      const cur = { p: money(consumer, "our_price"), mn: money(consumer, "minimum_seller_allowed_price"), mx: money(consumer, "maximum_seller_allowed_price") };
      if (cur.p === t.regular_base && cur.mn === t.minimum && cur.mx === t.maximum) {
        skipped++; console.log(`• ${e.sku}: already at target ($${t.regular_base})`);
        await sleep(200); continue;
      }
      const productType = live.summaries?.[0]?.productType ?? e.product_type;
      const merged = mergePurchasableOffer(offers, { price: t.regular_base, minPrice: t.minimum, maxPrice: t.maximum });
      const patches = [{ op: "replace" as const, path: "/attributes/purchasable_offer", value: merged }];
      if (DRY) {
        const prev: any = await patchListing(1, sellerId, e.sku, productType, patches, { validationPreview: true });
        const errs = (prev?.issues ?? []).filter((i: any) => i?.severity === "ERROR");
        console.log(`${errs.length ? "✗" : "✓"} ${e.sku}: $${cur.p}→$${t.regular_base} band[${cur.mn}–${cur.mx}]→[${t.minimum}–${t.maximum}] ${errs.length ? JSON.stringify(errs).slice(0, 120) : "(preview OK)"}`);
        errs.length ? fail++ : ok++;
      } else {
        const res: any = await patchListing(1, sellerId, e.sku, productType, patches);
        const status = res?.status ?? res?.payload?.status ?? "?";
        console.log(`✓ ${e.sku}: $${cur.p}→$${t.regular_base} band[${cur.mn}–${cur.mx}]→[${t.minimum}–${t.maximum}] ${status}`);
        ok++;
      }
      await sleep(350);
    } catch (err: any) {
      fail++; failures.push(e.sku);
      console.log(`✗ ${e.sku}: ERROR ${String(err?.message).slice(0, 140)}`);
      await sleep(500);
    }
  }
  console.log(`\ndone: ${ok} ${DRY ? "previewed-ok" : "patched"}, ${skipped} already-at-target, ${fail} failed${failures.length ? ` (${failures.join(",")})` : ""}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
