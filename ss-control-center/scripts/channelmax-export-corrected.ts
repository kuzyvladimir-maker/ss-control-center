/**
 * Option A: build a corrected ChannelMAX upload that LOWERS the floor to our real
 * dno and feeds PurchaseCost, WITHOUT pushing any current price down.
 *   MinSellingPrice = our floor (landed × 1.3)  ← the fix (unstick non-sellers)
 *   MaxSellingPrice = max(existing Max, our target)  ← never caps below current
 *   PurchaseCost    = our landed cost (product + packaging + real label)
 * Built straight from the ChannelMAX inventory export (has SKU, current Max,
 * FolderName→venue). Covers all 3 venues (Salutem/Retailer/STARFIT).
 *
 * Run: npx tsx scripts/channelmax-export-corrected.ts [exportPath]
 * Output: data/channelmax-uncrustables-corrected.txt
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { priceFor } from "@/lib/pricing/cost-model";

const path =
  process.argv[2] ?? "data/cmax_salutem_InventoryDownload_20260615_225846.txt";
const raw = readFileSync(path, "latin1");
const lines = raw.split(/\r?\n/).filter((l) => l.length);
const header = lines[0].split("\t").map((h) => h.trim());
const ix = (n: string) => header.indexOf(n);
const C = {
  sku: ix("SKU"),
  asin: ix("ASIN"),
  name: ix("ItemName"),
  max: ix("MaxSellingPrice"),
  myFloor: ix("MyFloor"),
  folder: ix("FolderName"),
};
const num = (s: string | undefined) => {
  const n = Number((s ?? "").trim());
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n: number) => Math.round(n * 100) / 100;

// FolderName → SellingVenue. Salutem proven as "AmazonUS"; others best-guess
// (confirm AmznUS3/AmznUS4 before upload — wrong venue just fails to match).
function venueFor(folder: string): string {
  if (/AmznUS4/i.test(folder)) return "AmznUS4"; // Retailer Distributor — CONFIRM
  if (/AmznUS3/i.test(folder)) return "AmznUS3"; // STARFIT — CONFIRM
  if (/AmznUS2/i.test(folder)) return "AmznUS2"; // AMZ Com
  return "AmazonUS"; // Salutem (proven)
}

// Move our SKUs to the dedicated "Frozen own-cost" [60067] model: clean floor
// (35a=100% Cost-Min, 42a=100% Retail-Max, floor-additions 48a/48f/36a OFF →
// MyFloor=Min) + Sales Velocity (no sale/24h → -1.5%, >=2 sales/24h → +1%).
const REPRICING_MODEL_ID = "60067";
const out = [
  "SKU\tASIN\tSellingVenue\tMinSellingPrice\tMaxSellingPrice\tPurchaseCost\tRepricingModelID",
];
const byVenue = new Map<string, number>();
let floorDrops = 0,
  floorDropSum = 0,
  skipped = 0;

for (const line of lines.slice(1)) {
  const c = line.split("\t");
  const name = c[C.name] ?? "";
  if (!/uncrustable/i.test(name)) continue;
  const p = priceFor(name);
  if (!p) {
    skipped++;
    continue;
  }
  const venue = venueFor(c[C.folder] ?? "");
  const newMin = round2(p.floor);
  const newMax = round2(Math.max(num(c[C.max]), p.target));
  const cost = round2(p.landed);
  out.push(
    [c[C.sku], c[C.asin] ?? "", venue, newMin.toFixed(2), newMax.toFixed(2), cost.toFixed(2), REPRICING_MODEL_ID].join("\t"),
  );
  byVenue.set(venue, (byVenue.get(venue) ?? 0) + 1);
  const oldFloor = num(c[C.myFloor]);
  if (oldFloor > newMin) {
    floorDrops++;
    floorDropSum += oldFloor - newMin;
  }
}

const file = "data/channelmax-uncrustables-corrected.txt";
writeFileSync(file, out.join("\r\n"));
console.log(`Wrote ${out.length - 1} SKUs → ${file}`);
console.log(`By venue:`, [...byVenue.entries()].map(([v, n]) => `${v}:${n}`).join("  "));
console.log(`Floors lowered: ${floorDrops} (avg drop $${floorDrops ? (floorDropSum / floorDrops).toFixed(2) : "0"})`);
if (skipped) console.log(`Skipped (no parseable qty): ${skipped}`);
console.log(`\nPreview:`);
console.log(out.slice(0, 6).join("\n"));
