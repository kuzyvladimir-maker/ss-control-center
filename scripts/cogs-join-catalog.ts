// Step 0 (COGS unit-economics): JOIN our product catalog (SkuShippingData) with
// the Sellerboard COGS export, by SKU, to see real coverage — how many of OUR
// SKUs immediately get a true cost. Includes ALL matches (Amazon + Walmart,
// Frozen + Dry) for reference, per Vladimir 2026-06-07.
//
// Read-only. Reads SkuShippingData from prod Turso (most complete) and the local
// Sellerboard CSV. Writes a joined report to docs/cogs-coverage.json.
//
//   (env must be loaded so TURSO_* are set)
//   set -a; . ./.env; . ./.env.local; set +a; npx tsx scripts/cogs-join-catalog.ts

import { createClient } from "@libsql/client";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const CSV_PATH = resolve(
  __dirname,
  "../../docs/Summary_Cost_of_Goods_Sold_(2026_06_07_11_42_27_152).csv"
);
const ENRICH_PATH = resolve(__dirname, "../../docs/cogs-product-structure.json");
const OUT_PATH = resolve(__dirname, "../../docs/cogs-coverage.json");

// ── quote-aware CSV parser (';' delimiter) ──
function parseCsv(text: string, delim = ";"): string[][] {
  const rows: string[][] = [];
  let field = "", row: string[] = [], inQ = false;
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === delim) { row.push(field); field = ""; }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (ch !== "\r") field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const norm = (s: string) => (s ?? "").trim().toUpperCase();

(async () => {
  // ── 1. Sellerboard CSV → map by SKU (keep latest cost period per SKU) ──
  const rows = parseCsv(readFileSync(CSV_PATH, "utf8"));
  const h = rows[0];
  const ci = {
    asin: h.indexOf("ASIN"), sku: h.indexOf("SKU"), title: h.indexOf("Title"),
    date: h.indexOf("CostPeriodStartDate"), cost: h.indexOf("Cost"),
    ship: h.indexOf("ShippingCostPerOrder"),
  };
  interface SbRow { asin: string; sku: string; title: string; date: string; cost: number | null; periods: number; }
  const sb = new Map<string, SbRow>();
  let sbTotal = 0;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length < h.length) continue;
    sbTotal++;
    const key = norm(row[ci.sku]);
    if (!key) continue;
    const costStr = (row[ci.cost] ?? "").trim();
    const cost = costStr === "" ? null : Number(costStr.replace(",", "."));
    const date = (row[ci.date] ?? "").trim();
    const prev = sb.get(key);
    const cand: SbRow = {
      asin: (row[ci.asin] ?? "").trim(), sku: (row[ci.sku] ?? "").trim(),
      title: (row[ci.title] ?? "").trim(), date,
      cost: cost !== null && !Number.isNaN(cost) ? cost : null,
      periods: (prev?.periods ?? 0) + 1,
    };
    // keep the row with the latest date that has a cost; else any latest
    if (!prev) sb.set(key, cand);
    else {
      cand.periods = prev.periods + 1;
      const better =
        (cand.cost !== null && (prev.cost === null || cand.date > prev.date)) ||
        (cand.cost === null && prev.cost === null && cand.date > prev.date);
      sb.set(key, better ? cand : { ...prev, periods: cand.periods });
    }
  }

  // ── 2. enrichment (packSize / costPerUnit / variety) by SKU ──
  const enrich = new Map<string, any>();
  if (existsSync(ENRICH_PATH)) {
    for (const e of JSON.parse(readFileSync(ENRICH_PATH, "utf8"))) enrich.set(norm(e.sku), e);
  }

  // ── 3. our catalog from prod Turso ──
  const c = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN! });
  const res = await c.execute(
    "SELECT sku, productTitle, category, marketplace, weight FROM SkuShippingData"
  );
  const ours = res.rows as any[];

  // ── 4. join ──
  interface JoinRow {
    sku: string; ourTitle: string | null; category: string | null; marketplace: string | null;
    weight: number | null; matched: boolean; cost: number | null; costDate: string | null;
    costPeriods: number | null; packSize: number | null; costPerUnit: number | null;
    isVariety: boolean | null; sbAsin: string | null;
  }
  const joined: JoinRow[] = [];
  const matchedKeys = new Set<string>();
  for (const o of ours) {
    const key = norm(o.sku);
    const m = sb.get(key);
    if (m) matchedKeys.add(key);
    const e = enrich.get(key);
    joined.push({
      sku: o.sku, ourTitle: o.productTitle ?? null, category: o.category ?? null,
      marketplace: o.marketplace ?? null, weight: o.weight ?? null,
      matched: !!m, cost: m?.cost ?? null, costDate: m?.date ?? null,
      costPeriods: m?.periods ?? null, packSize: e?.packSize ?? null,
      costPerUnit: e?.costPerUnit ?? null, isVariety: e?.isVariety ?? null,
      sbAsin: m?.asin ?? null,
    });
  }

  // ── 5. report ──
  const N = joined.length;
  const matched = joined.filter((j) => j.matched);
  const withCost = matched.filter((j) => j.cost !== null);
  const pct = (n: number) => `${((n / N) * 100).toFixed(1)}%`;
  const byCat = (cat: string, arr: JoinRow[]) => arr.filter((j) => (j.category ?? "(null)") === cat);

  console.log("\n================ COGS COVERAGE — our catalog × Sellerboard ================");
  console.log(`Our catalog SKUs (Turso):        ${N}   (Dry ${byCat("Dry", joined).length} / Frozen ${byCat("Frozen", joined).length} / other ${N - byCat("Dry", joined).length - byCat("Frozen", joined).length})`);
  console.log(`Sellerboard rows total:          ${sbTotal}  (unique SKUs ${sb.size})`);
  console.log(`\nMATCHED (our SKU found in Sellerboard): ${matched.length}  (${pct(matched.length)})`);
  console.log(`  └ with a Cost value (COGS ready):    ${withCost.length}  (${pct(withCost.length)})`);
  console.log(`      • Dry   : ${byCat("Dry", withCost).length}  ← can seed cost DIRECTLY (no pkg/ice)`);
  console.log(`      • Frozen: ${byCat("Frozen", withCost).length}  ← cost incl pkg+ice; source bare cost later`);
  console.log(`  └ matched but NO cost in Sellerboard: ${matched.length - withCost.length}`);
  console.log(`NOT matched (need sourcing):           ${N - matched.length}  (${pct(N - matched.length)})`);

  // marketplace split of cost-ready
  const mk = new Map<string, number>();
  for (const j of withCost) mk.set(j.marketplace ?? "(null)", (mk.get(j.marketplace ?? "(null)") ?? 0) + 1);
  console.log(`\nCOGS-ready by marketplace:`);
  for (const [k, v] of [...mk.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(10)} ${v}`);

  // SKUs with multiple cost periods (dated history present)
  const multiPeriod = matched.filter((j) => (j.costPeriods ?? 0) > 1).length;
  console.log(`\nMatched SKUs with >1 cost period (dated history): ${multiPeriod}`);

  // Sellerboard SKUs NOT in our catalog (reference only)
  const extra = [...sb.keys()].filter((k) => !matchedKeys.has(k)).length;
  console.log(`Sellerboard SKUs NOT in our catalog (reference): ${extra}`);

  console.log("\n--- SAMPLE: Dry, COGS-ready (first 10) ---");
  byCat("Dry", withCost).slice(0, 10).forEach((j) =>
    console.log(`  $${String(j.cost).padEnd(6)} pack=${String(j.packSize ?? "?").padEnd(3)} /u=$${String(j.costPerUnit ?? "?").padEnd(7)} ${j.marketplace} | ${(j.ourTitle ?? "").slice(0, 55)}`)
  );
  console.log("\n--- SAMPLE: Frozen, COGS-ready (first 8) ---");
  byCat("Frozen", withCost).slice(0, 8).forEach((j) =>
    console.log(`  $${String(j.cost).padEnd(6)} pack=${String(j.packSize ?? "?").padEnd(3)} ${j.marketplace} | ${(j.ourTitle ?? "").slice(0, 55)}`)
  );
  console.log("\n--- SAMPLE: NOT matched, need sourcing (first 10) ---");
  joined.filter((j) => !j.matched).slice(0, 10).forEach((j) =>
    console.log(`  [${j.category ?? "?"}|${j.marketplace ?? "?"}] ${j.sku}  ${(j.ourTitle ?? "").slice(0, 55)}`)
  );

  writeFileSync(OUT_PATH, JSON.stringify(joined, null, 2), "utf8");
  console.log(`\nWrote ${joined.length} joined rows → ${OUT_PATH}`);
  console.log("==========================================================================\n");
})();
