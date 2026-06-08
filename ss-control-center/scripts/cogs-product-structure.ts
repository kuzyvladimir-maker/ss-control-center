// COGS product-structure extractor (Phase: SKU unit-economics).
//
// Reads the Sellerboard "Summary_Cost_of_Goods_Sold" export and, per SKU,
// derives the bits unit-economics needs that the raw export does NOT give us:
//
//   • packSize    — how many physical units the listing ships (2pck, 12 ct,
//                   "Pack of 4", "8 Franks", "12 x 1.5 oz" → 12, ...)
//   • variety     — whether the listing is a flavor/variety BUNDLE (same
//                   product, several flavors), e.g. "Variety Pack", "4 Flavors",
//                   Campbell's/Chunky "4 flavors x 2 each".
//   • flavorCount / perFlavorQty — when an "N x M" / "N flavors" pattern is
//                   present, our best guess at #flavors and units-per-flavor.
//   • costPerUnit — Cost / packSize, the real per-unit COGS once we know the pack.
//
// WHY: Vladimir's rule — "правильно определять товар мало; надо определять с
// количеством единиц в листинге, паками 3/5/10 и бандлами по вкусам". Price +
// shipping must be set from TRUE per-unit cost at >=20% margin, and that needs
// the pack size, not just the title. See memory: project_sku_unit_economics.
//
// Read-only. Parses a local CSV, writes a clean JSON next to it. Touches no API.
//
//   npx tsx scripts/cogs-product-structure.ts
//
// Output:
//   - console report: detection coverage + sample tables (good / variety / misses)
//   - docs/cogs-product-structure.json: enriched rows for the next step

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

// The export lives in the repo's docs/ folder (one level up from ss-control-center).
const CSV_PATH = resolve(
  __dirname,
  "../../docs/Summary_Cost_of_Goods_Sold_(2026_06_07_11_42_27_152).csv"
);
const OUT_PATH = resolve(__dirname, "../../docs/cogs-product-structure.json");

// ── Minimal quote-aware CSV parser (Sellerboard uses ';' as the delimiter and
//    wraps every field in double quotes; titles can contain ';' inside quotes). ──
function parseCsv(text: string, delim = ";"): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  // Strip UTF-8 BOM if present.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'; // escaped quote
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delim) {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (c === "\r") {
      // ignore; handled by \n
    } else {
      field += c;
    }
  }
  // last field / row (file may not end in newline)
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

// ── Pack-size extraction ──────────────────────────────────────────────────────
// Words that denote countable physical units in grocery/CPG titles.
const UNIT_WORDS =
  "pack|packs|pck|pk|count|ct|cnt|pcs|pieces|piece|rolls|roll|cans|can|jars|jar|" +
  "bottles|bottle|bags|bag|boxes|box|pouches|pouch|bars|bar|sticks|stick|" +
  "sachets|sachet|servings|serving|tubes|tube|units|unit|pods|pkts|packets|packet|" +
  "wipes|tablets|capsules|caps|gummies|franks|links|patties|fillets|cups|cup";

// Variety / flavor-bundle signals.
const VARIETY_RE =
  /\b(variety|assorted|assortment|sampler|mixed flavors?|multi-?flavor|variety pack|flavou?r variety)\b/i;
const FLAVORS_RE = /(\d+)\s*(?:different\s+)?flavou?rs?\b/i;

interface PackGuess {
  packSize: number | null;
  // confidence: how sure we are this is the count of sellable units
  source: string | null; // which pattern matched (for auditing)
}

function extractPackSize(titleRaw: string): PackGuess {
  const title = titleRaw.toLowerCase();

  // Highest confidence: explicit "pack/set/case/box of N".
  let m = title.match(/\b(?:pack|set|case|box|bundle|lot)\s+of\s+(\d+)\b/);
  if (m) return { packSize: +m[1], source: `…of ${m[1]}` };

  // "N <unitword>"  e.g. "12 count", "2pck", "8 franks", "24 pouches".
  const nUnit = new RegExp(`\\b(\\d+)\\s*[- ]?(?:${UNIT_WORDS})\\b`);
  m = title.match(nUnit);
  if (m) return { packSize: +m[1], source: `${m[1]} ${m[0].replace(/\d+\s*[- ]?/, "")}` };

  // "<unitword> of N"  e.g. "count of 12".
  const unitOfN = new RegExp(`\\b(?:${UNIT_WORDS})\\s+of\\s+(\\d+)\\b`);
  m = title.match(unitOfN);
  if (m) return { packSize: +m[1], source: `…of ${m[1]}` };

  // "N x M ..." — ambiguous: could be (N flavors x M units) or (N units x size).
  // We treat the PRODUCT N*M as total units ONLY when M is a small count, not a
  // size like "1.5 oz". Caller refines via the variety signal.
  m = title.match(/\b(\d+)\s*[x×]\s*(\d+)\b(?!\s*(?:oz|g|kg|ml|l|lb|fl|inch|in|cm|mm|"))/);
  if (m) {
    const a = +m[1];
    const b = +m[2];
    // small * small => likely flavors * per-flavor qty (a bundle)
    if (a <= 12 && b <= 24) return { packSize: a * b, source: `${a}x${b}` };
  }

  // Trailing "Npk" / "Npck" with no space, e.g. SKU-ish "...4pk".
  m = title.match(/\b(\d+)\s*p(?:ck|k)\b/);
  if (m) return { packSize: +m[1], source: `${m[1]}pk` };

  return { packSize: null, source: null };
}

// SKU sometimes encodes the pack as a suffix, e.g. "-2PK", "_4PACK", "X6".
function packFromSku(sku: string): number | null {
  const m = sku
    .toUpperCase()
    .match(/(?:[-_ ]|^)(\d+)\s*(?:PK|PCK|PACK|CT|COUNT|X)\b/);
  if (m) return +m[1];
  const m2 = sku.toUpperCase().match(/X(\d+)\b/);
  if (m2) return +m2[1];
  return null;
}

// ── Variety / flavor-bundle detection ─────────────────────────────────────────
interface VarietyGuess {
  isVariety: boolean;
  flavorCount: number | null;
  perFlavorQty: number | null;
  signal: string | null;
}

function extractVariety(titleRaw: string, packSize: number | null): VarietyGuess {
  const title = titleRaw;

  const flavM = title.match(FLAVORS_RE);
  const nxm = title.match(/\b(\d+)\s*[x×]\s*(\d+)\b/);
  const hasVarietyWord = VARIETY_RE.test(title);

  if (flavM) {
    const flavorCount = +flavM[1];
    // if pack known, per-flavor = pack / flavors when it divides cleanly
    const per =
      packSize && flavorCount && packSize % flavorCount === 0
        ? packSize / flavorCount
        : null;
    return {
      isVariety: true,
      flavorCount,
      perFlavorQty: per,
      signal: `${flavorCount} flavors`,
    };
  }

  if (nxm && hasVarietyWord) {
    return {
      isVariety: true,
      flavorCount: +nxm[1],
      perFlavorQty: +nxm[2],
      signal: `${nxm[1]}x${nxm[2]} + variety word`,
    };
  }

  if (hasVarietyWord) {
    return { isVariety: true, flavorCount: null, perFlavorQty: null, signal: "variety word" };
  }

  return { isVariety: false, flavorCount: null, perFlavorQty: null, signal: null };
}

// ── Main ──────────────────────────────────────────────────────────────────────
const raw = readFileSync(CSV_PATH, "utf8");
const rows = parseCsv(raw);
const header = rows[0];
const idx = (name: string) => header.indexOf(name);
const iAsin = idx("ASIN");
const iSku = idx("SKU");
const iTitle = idx("Title");
const iCost = idx("Cost");
const iShip = idx("ShippingCostPerOrder");
const iMkt = idx("Marketplace");

interface EnrichedRow {
  asin: string;
  sku: string;
  title: string;
  cost: number | null;
  shippingCostPerOrder: number | null;
  marketplace: string;
  packSize: number | null;
  packSource: string | null;
  costPerUnit: number | null;
  isVariety: boolean;
  flavorCount: number | null;
  perFlavorQty: number | null;
  varietySignal: string | null;
}

const out: EnrichedRow[] = [];
for (let r = 1; r < rows.length; r++) {
  const row = rows[r];
  if (!row || row.length < header.length) continue;
  const costStr = (row[iCost] ?? "").trim();
  const cost = costStr === "" ? null : Number(costStr.replace(",", "."));
  // We only care about products that have a COGS recorded (the active set).
  if (cost === null || Number.isNaN(cost)) continue;

  const title = (row[iTitle] ?? "").trim();
  const sku = (row[iSku] ?? "").trim();

  let { packSize, source } = extractPackSize(title);
  if (packSize === null) {
    const fromSku = packFromSku(sku);
    if (fromSku) {
      packSize = fromSku;
      source = `sku:${fromSku}`;
    }
  }

  const variety = extractVariety(title, packSize);
  const shipStr = (row[iShip] ?? "").trim();
  const ship = shipStr === "" ? null : Number(shipStr.replace(",", "."));

  out.push({
    asin: (row[iAsin] ?? "").trim(),
    sku,
    title,
    cost,
    shippingCostPerOrder: ship,
    marketplace: (row[iMkt] ?? "").trim(),
    packSize,
    packSource: source,
    costPerUnit: packSize && packSize > 0 ? +(cost / packSize).toFixed(4) : cost,
    isVariety: variety.isVariety,
    flavorCount: variety.flavorCount,
    perFlavorQty: variety.perFlavorQty,
    varietySignal: variety.signal,
  });
}

// ── Report ──────────────────────────────────────────────────────────────────
const total = out.length;
const withPack = out.filter((o) => o.packSize !== null);
const single = out.filter((o) => o.packSize === 1);
const multi = out.filter((o) => (o.packSize ?? 0) > 1);
const variety = out.filter((o) => o.isVariety);
const noPack = out.filter((o) => o.packSize === null);

const pct = (n: number) => `${((n / total) * 100).toFixed(1)}%`;

console.log("\n========== COGS PRODUCT-STRUCTURE REPORT ==========");
console.log(`Rows with a recorded COGS:       ${total}`);
console.log(`  pack size detected:            ${withPack.length}  (${pct(withPack.length)})`);
console.log(`    └ multi-unit (>1):           ${multi.length}`);
console.log(`    └ single-unit (=1):          ${single.length}`);
console.log(`  flavor/variety bundle flagged: ${variety.length}  (${pct(variety.length)})`);
console.log(`  NO pack size (needs review):   ${noPack.length}  (${pct(noPack.length)})`);

const showCols = (o: EnrichedRow) =>
  `  $${String(o.cost).padEnd(6)} pack=${String(o.packSize ?? "?").padEnd(4)} /u=$${String(
    o.costPerUnit
  ).padEnd(8)} [${o.packSource ?? "-"}]  ${o.title.slice(0, 70)}`;

console.log("\n--- SAMPLE: multi-unit packs detected (first 12) ---");
multi.slice(0, 12).forEach((o) => console.log(showCols(o)));

console.log("\n--- SAMPLE: flavor/variety bundles flagged (first 10) ---");
variety
  .slice(0, 10)
  .forEach((o) =>
    console.log(
      `  flavors=${o.flavorCount ?? "?"} perFlavor=${o.perFlavorQty ?? "?"} [${o.varietySignal}]  ${o.title.slice(
        0,
        72
      )}`
    )
  );

console.log("\n--- SAMPLE: NO pack detected — likely true singles OR misses (first 15) ---");
noPack.slice(0, 15).forEach((o) => console.log(`  $${o.cost}  ${o.title.slice(0, 80)}`));

writeFileSync(OUT_PATH, JSON.stringify(out, null, 2), "utf8");
console.log(`\nWrote ${out.length} enriched rows → ${OUT_PATH}`);
console.log("===================================================\n");
