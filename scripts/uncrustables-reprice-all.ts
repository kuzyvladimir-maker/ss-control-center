/**
 * Bring ALL store1 Uncrustables listings to target: lower any listing priced
 * >2% above target down to target (rounded to .99 just below). Listings at or
 * below target are left untouched. Approved by Vladimir 2026-06-15.
 *
 * Reads data/uncrustables-reprice-proposal.csv (current + target per SKU).
 * Per SKU: read productType → validation-preview → real PATCH.
 *
 * Run: npx tsx scripts/uncrustables-reprice-all.ts --dry   (preview/count only)
 *      npx tsx scripts/uncrustables-reprice-all.ts         (LIVE)
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { getListing } from "@/lib/amazon-sp-api/listings";
import { setListingPrice } from "@/lib/amazon-sp-api/pricing";
import { getMerchantToken } from "@/lib/amazon-sp-api/sellers";

const STORE = 1;
const DRY = process.argv.includes("--dry");
const OVER = 1.02; // only touch listings priced >2% above target

// Already applied in the first wave — skip (idempotent anyway).
const ALREADY = new Set([
  "743269740767", "VY-DG31-67FN", "743269740583", "SV-2ZYX-WRHI",
  "743269740828", "743269740743", "743269740590", "743269740835", "WP-7XFG-JIB0",
]);

/** Nearest .99 price at or just below target. */
function round99(target: number): number {
  let p = Math.floor(target) + 0.99;
  if (p > target) p -= 1;
  return Math.round(p * 100) / 100;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Change = { sku: string; total: string; cooler: string; current: number; target: number; newPrice: number };

function loadChanges(): Change[] {
  const csv = readFileSync("data/uncrustables-reprice-proposal.csv", "utf8");
  const lines = csv.split(/\r?\n/).filter(Boolean);
  const h = lines[0].split(",");
  const col = (n: string) => h.indexOf(n);
  const iSku = col("sku"), iCur = col("current_item_price"), iTgt = col("target_item_price");
  const iTot = col("total"), iClr = col("cooler");
  const out: Change[] = [];
  for (const line of lines.slice(1)) {
    const c = line.split(",");
    const sku = c[iSku];
    if (ALREADY.has(sku)) continue;
    const current = Number(c[iCur]);
    const target = Number(c[iTgt]);
    if (!Number.isFinite(current) || !Number.isFinite(target) || target <= 0) continue;
    if (current <= target * OVER) continue; // at/below target (+2%) — leave
    out.push({ sku, total: c[iTot], cooler: c[iClr], current, target, newPrice: round99(target) });
  }
  // biggest drops first
  return out.sort((a, b) => (b.current - b.newPrice) - (a.current - a.newPrice));
}

async function main() {
  const changes = loadChanges();
  console.log(`Listings >+2% above target (to lower): ${changes.length}  mode=${DRY ? "DRY" : "LIVE"}\n`);
  if (!changes.length) return;

  const sellerId = await getMerchantToken(STORE);
  let applied = 0;
  for (const ch of changes) {
    const label = `${ch.sku} (${ch.total}ct ${ch.cooler}) $${ch.current}→$${ch.newPrice}`;
    try {
      const listing = await getListing(STORE, sellerId, ch.sku);
      const productType = listing.summaries?.[0]?.productType;
      if (!productType) { console.log(`✗ ${label}: no productType — SKIP`); continue; }

      const prev = await setListingPrice(STORE, sellerId, ch.sku, productType, ch.newPrice, { validationPreview: true });
      const errs = (prev?.issues ?? []).filter((i: any) => i?.severity === "ERROR");
      if (errs.length) { console.log(`✗ ${label}: preview rejected ${JSON.stringify(errs)}`); continue; }

      if (DRY) { console.log(`✓ ${label}: preview OK`); await sleep(250); continue; }

      const res = await setListingPrice(STORE, sellerId, ch.sku, productType, ch.newPrice);
      console.log(`✓ ${label}: status=${res?.status}`);
      applied++;
      await sleep(450);
    } catch (e: any) {
      console.log(`✗ ${label}: ERROR ${e?.message}`);
    }
  }
  console.log(`\n${DRY ? "Preview" : "Applied"} done.${DRY ? "" : ` ${applied}/${changes.length} submitted.`}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
