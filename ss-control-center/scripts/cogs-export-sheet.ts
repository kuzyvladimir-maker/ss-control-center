// Export the enriched pilot SKUs to a Google Sheet that MIRRORS our DB structure,
// so Vladimir can eyeball how well the engine enriched the database.
// Three tabs = three tables: Catalog+Identity (SkuShippingData), RetailPrice (every
// offer, multi-offer per SKU, with the gate verdict), SkuCost (the chosen COGS).
// Main product photo rendered in-cell via =IMAGE() so the harvested image is visible.
//
//   npx tsx scripts/cogs-export-sheet.ts            # default = 13 pilot SKUs
//   npx tsx scripts/cogs-export-sheet.ts SKU ...    # explicit SKUs
//
// Falls back to a Drive CSV→Sheet conversion if the OAuth token lacks Sheets scope.

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });
import { createClient } from "@libsql/client";
import { google } from "googleapis";

const DEFAULT_POOL = [
  "FaisalX-1241", "FaisalX-1229", "RizwanX-4597", "RizwanX-2168", "RizwanX-199",
  "FaisalX-1646", "FaisalX-1215", "FaisalX-1121", "FaisalX-1142", "FaisalX-1268",
  "FaisalX-3743", "FaisalX-1244", "RizwanX-3877",
];
const SKUS = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const POOL = SKUS.length ? SKUS : DEFAULT_POOL;

const g = (v: any) => (v === null || v === undefined ? "" : v);
const imgFormula = (urls: string) => {
  try { const a = JSON.parse(urls || "[]"); return a[0] ? `=IMAGE("${a[0]}")` : ""; } catch { return ""; }
};

(async () => {
  const db = createClient({ url: process.env.TURSO_DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN! });
  const ph = POOL.map(() => "?").join(",");

  // --- Tab 1: Catalog + brain identity (SkuShippingData) ---
  const ssd = await db.execute({
    sql: `SELECT sku, productTitle, marketplace, category, length, width, height, weight, weightFedex,
                 upc, upcSource, unitsInListing, baseUnitDesc, productIdentity
          FROM SkuShippingData WHERE sku IN (${ph}) ORDER BY sku`,
    args: POOL,
  });
  // Dims (length/width/height/weightFedex) intentionally dropped from the COGS view:
  // they're a SHIPPING concern (and our DB values are placeholders), not COGS. Weight
  // is kept because the frozen ice-cost calc needs the product weight.
  const catHeader = [
    "sku", "productTitle", "marketplace", "category", "weight",
    "upc", "upcSource", "unitsInListing", "baseUnitDesc",
    "id.brand", "id.product_line", "id.flavor", "id.size", "id.container", "id.is_bundle", "id.confidence", "id.notes",
  ];
  const catRows = [catHeader, ...ssd.rows.map((r: any) => {
    let id: any = {}; try { id = r.productIdentity ? JSON.parse(r.productIdentity) : {}; } catch { /* */ }
    return [
      g(r.sku), g(r.productTitle), g(r.marketplace), g(r.category), g(r.weight),
      g(r.upc), g(r.upcSource), g(r.unitsInListing), g(r.baseUnitDesc),
      g(id.brand), g(id.product_line), g(id.flavor), g(id.size), g(id.container_type), g(id.is_bundle),
      g(id.confidence), g(id.notes),
    ];
  })];

  // --- Tab 2: RetailPrice — every offer (multi-offer per SKU) + gate verdict + photo ---
  const rp = await db.execute({
    sql: `SELECT sku, retailer, retailerProductId, price, currency, inStock, productUrl, title, description,
                 keyFeatures, imageUrls, packSizeSeen, isBaseUnit, unitMismatch, sourceApi, matchMethod,
                 confidence, fetchedAt
          FROM RetailPrice WHERE sku IN (${ph}) ORDER BY sku, price`,
    args: POOL,
  });
  const rpHeader = [
    "sku", "retailer", "retailerProductId", "price", "currency", "inStock", "photo", "title", "description",
    "keyFeatures", "imageUrls", "packSizeSeen", "isBaseUnit", "unitMismatch", "sourceApi",
    "matchMethod (verdict)", "confidence", "fetchedAt", "productUrl",
  ];
  const rpRows = [rpHeader, ...rp.rows.map((r: any) => [
    g(r.sku), g(r.retailer), g(r.retailerProductId), g(r.price), g(r.currency),
    r.inStock === null ? "" : r.inStock ? "yes" : "no", imgFormula(r.imageUrls as string), g(r.title),
    String(g(r.description)).slice(0, 500), String(g(r.keyFeatures)).slice(0, 500),
    String(g(r.imageUrls)).slice(0, 500), g(r.packSizeSeen), r.isBaseUnit ? "yes" : "no",
    r.unitMismatch ? "yes" : "no", g(r.sourceApi), g(r.matchMethod), g(r.confidence), g(r.fetchedAt), g(r.productUrl),
  ])];

  // --- Tab 3: SkuCost — the chosen COGS ---
  const sc = await db.execute({
    sql: `SELECT sku, effectiveDate, productCost, packagingCost, iceCost, totalCost, costPerUnit, packSize,
                 includesPackaging, currency, source, confidence, needsReview, notes
          FROM SkuCost WHERE sku IN (${ph}) ORDER BY sku, effectiveDate`,
    args: POOL,
  });
  const scHeader = [
    "sku", "effectiveDate", "productCost", "packagingCost", "iceCost", "totalCost", "costPerUnit", "packSize",
    "includesPackaging", "currency", "source", "confidence", "needsReview", "notes",
  ];
  const scRows = [scHeader, ...sc.rows.map((r: any) => [
    g(r.sku), g(r.effectiveDate), g(r.productCost), g(r.packagingCost), g(r.iceCost), g(r.totalCost),
    g(r.costPerUnit), g(r.packSize), r.includesPackaging ? "yes" : "no", g(r.currency), g(r.source),
    g(r.confidence), r.needsReview ? "yes" : "no", g(r.notes),
  ])];

  console.log(`Catalog rows ${catRows.length - 1}, RetailPrice offers ${rpRows.length - 1}, SkuCost ${scRows.length - 1}`);

  // --- create the spreadsheet (Sheets API; fall back to Drive CSV on scope error) ---
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_OAUTH_CLIENT_ID,
    process.env.GOOGLE_OAUTH_CLIENT_SECRET
  );
  auth.setCredentials({ refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN });
  const title = `COGS Engine — Pilot Enrichment (${POOL.length} SKU) ${new Date().toISOString().slice(0, 10)}`;
  const sheets = google.sheets({ version: "v4", auth });
  const drive = google.drive({ version: "v3", auth });

  try {
    const created = await sheets.spreadsheets.create({
      requestBody: {
        properties: { title },
        sheets: [
          { properties: { title: "1. Каталог + Опознание" } },
          { properties: { title: "2. Цены (все офферы)" } },
          { properties: { title: "3. COGS (SkuCost)" } },
        ],
      },
    });
    const id = created.data.spreadsheetId!;
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: id,
      requestBody: {
        valueInputOption: "USER_ENTERED",
        data: [
          { range: "1. Каталог + Опознание!A1", values: catRows },
          { range: "2. Цены (все офферы)!A1", values: rpRows },
          { range: "3. COGS (SkuCost)!A1", values: scRows },
        ],
      },
    });
    try {
      await drive.permissions.create({ fileId: id, requestBody: { role: "reader", type: "anyone" } });
    } catch { /* sharing optional; owner can open regardless */ }
    console.log(`\n✅ Google Sheet created:\n   https://docs.google.com/spreadsheets/d/${id}`);
  } catch (e: any) {
    console.error(`\n⚠️ Sheets API failed (${String(e.message).slice(0, 120)}).`);
    console.error("   Likely the OAuth token lacks the Sheets/Drive scope. Falling back is possible via Drive CSV,");
    console.error("   but printing data here so nothing is lost. (Tell me to wire the Drive-CSV fallback if needed.)");
    process.exitCode = 2;
  }
})();
