/**
 * Analyse the ChannelMAX inventory export (data/cmax_salutem_InventoryDownload_*.txt)
 * for the Uncrustables subset: which repricing model/folder, competition, selling
 * status, and ChannelMAX's stored cost/floor/ceiling vs our cost model.
 *
 * Run: npx tsx scripts/cmax-inventory-analysis.ts [path]
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { priceFor } from "@/lib/pricing/cost-model";

const path =
  process.argv[2] ?? "data/cmax_salutem_InventoryDownload_20260615_225846.txt";

const raw = readFileSync(path, "latin1"); // CMax export is cp1252-ish
const lines = raw.split(/\r?\n/).filter((l) => l.length);
const header = lines[0].split("\t").map((h) => h.trim());
const ix = (name: string) => header.indexOf(name);

const C = {
  sku: ix("SKU"),
  asin: ix("ASIN"),
  name: ix("ItemName"),
  amazonPrice: ix("AmazonPrice"),
  myPrice: ix("MyPrice"),
  min: ix("MinSellingPrice"),
  max: ix("MaxSellingPrice"),
  myFloor: ix("MyFloor"),
  myCeiling: ix("MyCeiling"),
  cost: ix("PurchaseCost"),
  commission: ix("CommissionAmt"),
  ship: ix("ActualShippingCost"),
  weight: ix("ItemWight"),
  model: ix("RepricingModelName"),
  folder: ix("FolderName"),
  comp: ix("CompetitorCount"),
  selling: ix("IsSelling"),
  bbox: ix("IGotBuybox"),
  rank: ix("SalesRank"),
  map: ix("MAP"),
};

const num = (s: string | undefined) => {
  const n = Number((s ?? "").trim());
  return Number.isFinite(n) ? n : null;
};

type Row = Record<string, string>;
const rows: Row[] = [];
for (const line of lines.slice(1)) {
  const c = line.split("\t");
  const name = c[C.name] ?? "";
  if (!/uncrustable/i.test(name)) continue;
  rows.push(c as unknown as Row & string[] as any);
}

const get = (c: any, i: number) => (c as string[])[i];

console.log(`Total rows in export: ${lines.length - 1}`);
console.log(`Uncrustable rows: ${rows.length}\n`);

// 1) by repricing model
const byModel = new Map<string, number>();
const byFolder = new Map<string, number>();
let comp0 = 0,
  compN = 0,
  selling = 0,
  gotBB = 0,
  hasRank = 0,
  hasCost = 0,
  hasMap = 0;
for (const c of rows) {
  const model = get(c, C.model) || "(none)";
  byModel.set(model, (byModel.get(model) ?? 0) + 1);
  const folder = get(c, C.folder) || "(none)";
  byFolder.set(folder, (byFolder.get(folder) ?? 0) + 1);
  const comp = num(get(c, C.comp));
  if (comp === 0) comp0++;
  else if (comp != null && comp > 0) compN++;
  if ((get(c, C.selling) || "").toUpperCase() === "Y") selling++;
  if ((get(c, C.bbox) || "").toUpperCase() === "Y") gotBB++;
  const rank = num(get(c, C.rank));
  if (rank && rank > 0) hasRank++;
  const cost = num(get(c, C.cost));
  if (cost && cost > 0) hasCost++;
  const map = num(get(c, C.map));
  if (map && map > 0) hasMap++;
}

console.log("=== by RepricingModel ===");
for (const [m, n] of [...byModel.entries()].sort((a, b) => b[1] - a[1]))
  console.log(`  ${m}: ${n}`);
console.log("\n=== by Folder ===");
for (const [f, n] of [...byFolder.entries()].sort((a, b) => b[1] - a[1]))
  console.log(`  ${f}: ${n}`);

console.log(`\n=== signals ===`);
console.log(`  competitors: 0 → ${comp0},  >0 → ${compN}`);
console.log(`  IsSelling=Y: ${selling}`);
console.log(`  IGotBuybox=Y: ${gotBB}`);
console.log(`  has SalesRank: ${hasRank}`);
console.log(`  has PurchaseCost set: ${hasCost}`);
console.log(`  has MAP set: ${hasMap}`);

// 2) Floor inflation: MyFloor vs MinSellingPrice; and CMax cost vs our landed
console.log(`\n=== floor/cost check (first 12 with our model comparison) ===`);
console.log(
  "qty | min(file) | MyFloor | max(file) | MyCeiling | CMaxCost | ourLanded | ourTarget | model",
);
let shown = 0;
for (const c of rows) {
  const name = get(c, C.name);
  const p = priceFor(name);
  if (!p) continue;
  if (shown++ >= 12) break;
  console.log(
    `  ${p.total} | ${get(c, C.min)} | ${get(c, C.myFloor)} | ${get(c, C.max)} | ${get(c, C.myCeiling)} | ${get(c, C.cost)} | ${p.landed} | ${p.target} | ${get(c, C.model)}`,
  );
}

// 3) aggregate: avg MyFloor vs Min, to detect inflation
let infl = 0,
  inflCount = 0;
for (const c of rows) {
  const min = num(get(c, C.min));
  const floor = num(get(c, C.myFloor));
  if (min && floor && min > 0) {
    infl += floor / min;
    inflCount++;
  }
}
if (inflCount)
  console.log(
    `\nAvg MyFloor / MinSellingPrice = ${(infl / inflCount).toFixed(3)} (>1 means CMax inflates floor above our Min)`,
  );
