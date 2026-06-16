/**
 * READ-ONLY. Find all Uncrustables listings across stores via the Merchant
 * Listings report (GET_MERCHANT_LISTINGS_ALL_DATA — includes active AND
 * inactive/suppressed listings), read current price, compute target price from
 * our validated model, and print a reprice proposal table. Writes a CSV.
 *
 * Target ITEM price = landed cost × 1.5, where
 *   landed = Total×$1 (product) + packaging(cooler) + real label(cooler).
 * 1.5 reproduces the item prices of listings that actually sell (~67% net markup);
 * customer pays shipping (≈ label) on top → ~2× landed total.
 * See docs/wiki/uncrustables-pricing-model.md.
 *
 * Run: npx tsx scripts/uncrustables-reprice-proposal.ts
 * NOTHING is changed. Applying prices is a separate explicit step.
 */
import "dotenv/config";
import { writeFileSync } from "node:fs";
import { requestAndWaitForReport } from "@/lib/amazon-sp-api/reports";

const STORES = ["store1", "store2", "store3"];
const PKG: Record<string, number> = { S: 7.5, M: 10.9, L: 14.1, XL: 18.9 };
// S/M/XL = direct calibrated averages (large samples). L = weight-interpolated
// (~18lb) from the S/M/XL regression label≈$3.9+$2.36/lb, because direct L
// orders are too sparse (n≈11-18) and their raw avg ($22) is implausibly low.
const LABEL: Record<string, number> = { S: 20, M: 32, L: 45, XL: 60 };
const TARGET_MULT = 1.5;

function cooler(total: number): "S" | "M" | "L" | "XL" {
  if (total <= 30) return "S";
  if (total <= 60) return "M";
  if (total <= 72) return "L";
  return "XL";
}

function parseTotal(title: string): number {
  const t = title.toLowerCase();
  const totalMatch = t.match(/total\s*(\d{1,3})/);
  if (totalMatch) return Number(totalMatch[1]);
  const hits: number[] = [];
  let m: RegExpExecArray | null;
  const kw = /(\d{1,3})\s*(?:count|ct\b|pieces|pcs|pack|sandwich|units)/g;
  while ((m = kw.exec(t))) hits.push(Number(m[1]));
  const plausible = hits.filter((n) => n >= 2 && n <= 200);
  if (plausible.length) return Math.max(...plausible);
  const all = [...t.matchAll(/\b(\d{1,3})\b/g)]
    .map((x) => Number(x[1]))
    .filter((n) => n >= 4 && n <= 200);
  return all.length ? Math.max(...all) : -1;
}

type Row = {
  store: string;
  sku: string;
  asin: string;
  title: string;
  total: number;
  cooler: string;
  landed: number;
  target: number;
  current: number | null;
  status: string;
  fc: string;
};

function parseReport(store: string, tsv: string): Row[] {
  const lines = tsv.split(/\r?\n/).filter((l) => l.length);
  if (!lines.length) return [];
  const header = lines[0].split("\t").map((h) => h.trim().toLowerCase());
  const idx = (name: string) => header.indexOf(name);
  const iName = idx("item-name");
  const iSku = idx("seller-sku");
  const iPrice = idx("price");
  const iAsin = idx("asin1");
  const iStatus = idx("status");
  const iFc = idx("fulfillment-channel");
  const rows: Row[] = [];
  for (const line of lines.slice(1)) {
    const c = line.split("\t");
    const title = c[iName] ?? "";
    if (!/uncrustable/i.test(title)) continue;
    const total = parseTotal(title);
    const cz = cooler(total > 0 ? total : 1);
    const landed = (total > 0 ? total : 0) + PKG[cz] + LABEL[cz];
    const priceRaw = Number(c[iPrice]);
    rows.push({
      store,
      sku: c[iSku] ?? "?",
      asin: c[iAsin] ?? "?",
      title,
      total,
      cooler: cz,
      landed,
      target: total > 0 ? Math.round(landed * TARGET_MULT * 100) / 100 : NaN,
      current: Number.isFinite(priceRaw) && priceRaw > 0 ? priceRaw : null,
      status: iStatus >= 0 ? c[iStatus] ?? "" : "",
      fc: iFc >= 0 ? c[iFc] ?? "" : "",
    });
  }
  return rows;
}

const f = (n: number | null) =>
  n == null || !Number.isFinite(n) ? "—" : `$${n.toFixed(2)}`;

async function main() {
  const all: Row[] = [];
  for (const store of STORES) {
    try {
      console.error(`[${store}] requesting Merchant Listings report …`);
      const tsv = await requestAndWaitForReport(
        store,
        "GET_MERCHANT_LISTINGS_ALL_DATA",
        1,
        8 * 60 * 1000,
      );
      const rows = parseReport(store, tsv);
      console.error(`[${store}] ${rows.length} uncrustable listings`);
      all.push(...rows);
    } catch (e: any) {
      console.error(`[${store}] FAILED: ${e?.message}`);
    }
  }

  const withDelta = all
    .map((r) => ({
      ...r,
      deltaPct:
        r.current && Number.isFinite(r.target)
          ? Math.round(((r.current - r.target) / r.target) * 100)
          : null,
    }))
    .sort((a, b) => (b.deltaPct ?? -999) - (a.deltaPct ?? -999));

  console.log(`\n=== UNCRUSTABLES REPRICE PROPOSAL ===`);
  console.log(`Listings found: ${all.length}\n`);
  console.log(
    "store | total | clr | current | target×1.5 | Δ% | flag | status | sku | title",
  );
  for (const r of withDelta) {
    const flag =
      r.deltaPct == null
        ? "?"
        : r.deltaPct > 20
          ? "OVERPRICED"
          : r.deltaPct < -20
            ? "underpriced"
            : "ok";
    console.log(
      `${r.store} | ${r.total} | ${r.cooler} | ${f(r.current)} | ${f(r.target)} | ${r.deltaPct ?? "—"} | ${flag} | ${r.status} | ${r.sku} | ${r.title.slice(0, 50)}`,
    );
  }

  const header =
    "store,sku,asin,total,cooler,landed,current_item_price,target_item_price,delta_pct,status,fulfillment,title";
  const csv = [
    header,
    ...withDelta.map((r) =>
      [
        r.store,
        r.sku,
        r.asin,
        r.total,
        r.cooler,
        r.landed.toFixed(2),
        r.current ?? "",
        Number.isFinite(r.target) ? r.target.toFixed(2) : "",
        r.deltaPct ?? "",
        r.status,
        r.fc,
        `"${(r.title ?? "").replace(/"/g, "'")}"`,
      ].join(","),
    ),
  ].join("\n");
  writeFileSync("data/uncrustables-reprice-proposal.csv", csv);
  console.log(`\nCSV: data/uncrustables-reprice-proposal.csv`);

  const over = withDelta.filter((r) => (r.deltaPct ?? 0) > 20).length;
  const under = withDelta.filter((r) => (r.deltaPct ?? 0) < -20).length;
  const noPrice = withDelta.filter((r) => r.current == null).length;
  console.log(
    `Summary: ${over} OVERPRICED (>20% above target), ${under} underpriced, ${noPrice} no-price(inactive), ${all.length - over - under - noPrice} ~ok`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
