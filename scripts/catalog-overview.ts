/**
 * Phase 1 seed: whole-catalog overview from the ChannelMAX inventory export.
 * Read-only. Shows scale of the catalog and the COGS gap (how many SKUs have no cost).
 *
 * Run: npx tsx scripts/catalog-overview.ts [exportPath]
 */
import { readFileSync } from "node:fs";

const path =
  process.argv[2] ?? "data/cmax_salutem_InventoryDownload_20260615_225846.txt";
const lines = readFileSync(path, "latin1").split(/\r?\n/).filter((l) => l.length);
const header = lines[0].split("\t").map((h) => h.trim());
const ix = (n: string) => header.indexOf(n);
const C = {
  cost: ix("PurchaseCost"),
  folder: ix("FolderName"),
  model: ix("RepricingModelName"),
  brand: ix("Manufacturer"),
  selling: ix("IsSelling"),
  comp: ix("CompetitorCount"),
  rank: ix("SalesRank"),
  name: ix("ItemName"),
  min: ix("MinSellingPrice"),
};
const num = (s: string | undefined) => {
  const n = Number((s ?? "").trim());
  return Number.isFinite(n) ? n : 0;
};
const top = (m: Map<string, number>, k = 12) =>
  [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);

const data = lines.slice(1).map((l) => l.split("\t"));
const N = data.length;
const byFolder = new Map<string, number>();
const byModel = new Map<string, number>();
const byBrand = new Map<string, number>();
let withCost = 0,
  withMin = 0,
  selling = 0,
  uncontested = 0,
  hasRank = 0;
for (const c of data) {
  byFolder.set(c[C.folder] || "(none)", (byFolder.get(c[C.folder] || "(none)") ?? 0) + 1);
  byModel.set(c[C.model] || "(none)", (byModel.get(c[C.model] || "(none)") ?? 0) + 1);
  const b = (c[C.brand] || "(none)").trim() || "(none)";
  byBrand.set(b, (byBrand.get(b) ?? 0) + 1);
  if (num(c[C.cost]) > 0) withCost++;
  if (num(c[C.min]) > 0) withMin++;
  if ((c[C.selling] || "").toUpperCase() === "Y") selling++;
  if (num(c[C.comp]) === 0) uncontested++;
  if (num(c[C.rank]) > 0) hasRank++;
}

console.log(`=== CATALOG OVERVIEW (ChannelMAX export) ===`);
console.log(`Total SKUs: ${N}\n`);
console.log(`COGS coverage: PurchaseCost set on ${withCost}/${N} (${((withCost / N) * 100).toFixed(1)}%) → GAP = ${N - withCost}`);
console.log(`Repricing floor (Min) set on ${withMin}/${N} (${((withMin / N) * 100).toFixed(1)}%)`);
console.log(`Currently selling: ${selling}/${N} (${((selling / N) * 100).toFixed(1)}%)`);
console.log(`Uncontested (0 competitors): ${uncontested}/${N}`);
console.log(`Has Amazon SalesRank: ${hasRank}/${N}`);
console.log(`\n=== by venue/folder (top) ===`);
for (const [k, v] of top(byFolder)) console.log(`  ${k}: ${v}`);
console.log(`\n=== by repricing model ===`);
for (const [k, v] of top(byModel)) console.log(`  ${k}: ${v}`);
console.log(`\n=== top brands (Manufacturer) ===`);
for (const [k, v] of top(byBrand, 15)) console.log(`  ${k}: ${v}`);
