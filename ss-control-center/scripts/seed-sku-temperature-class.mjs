// Seed the initial temperature-class markup (the owner's bulk-approved list,
// source=review) into SkuTemperatureClass on Turso. Idempotent: upserts by sku
// and appends a SkuTemperatureClassChange row only when the class actually
// changes. Run AFTER the table migration:
//   node scripts/seed-sku-temperature-class.mjs            (dry-run, prints plan)
//   node scripts/seed-sku-temperature-class.mjs --apply    (writes)
//
// Data comes from scripts/data/sku-temperature-class-seed.json. The chilled
// list is empty until the owner provides the 27 codes from the review sheet
// (it is private and could not be exported) — the script warns and seeds the
// frozen/dry SKUs it has.

import { createClient } from "@libsql/client";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

function clean(v) {
  if (!v) return v;
  return v.trim().replace(/^['"]|['"]$/g, "");
}

const APPLY = process.argv.includes("--apply");
const here = dirname(fileURLToPath(import.meta.url));
const seed = JSON.parse(
  readFileSync(join(here, "data", "sku-temperature-class-seed.json"), "utf8"),
);

const rows = [
  ...seed.frozen.map((sku) => ({ sku: String(sku), class: "FROZEN" })),
  ...seed.chilled.map((sku) => ({ sku: String(sku), class: "CHILLED" })),
  ...seed.dry.map((sku) => ({ sku: String(sku), class: "DRY" })),
];
const source = seed.source || "review";
const setBy = seed.setBy || "seed";

console.log(
  `Seed plan: ${seed.frozen.length} frozen, ${seed.chilled.length} chilled, ${seed.dry.length} dry (${rows.length} total). source=${source}`,
);
if (seed.chilled.length === 0) {
  console.warn(
    "⚠ chilled list is EMPTY — paste the 27 codes from the review sheet into\n" +
      "  scripts/data/sku-temperature-class-seed.json before the chilled markup lands.",
  );
}
if (!APPLY) {
  console.log("(dry-run — pass --apply to write). Rows:");
  for (const r of rows) console.log(`  ${r.class.padEnd(7)} ${r.sku}`);
  process.exit(0);
}

const url = clean(process.env.TURSO_DATABASE_URL);
const authToken = clean(process.env.TURSO_AUTH_TOKEN);
if (!url || !authToken) {
  console.error("Missing TURSO_DATABASE_URL / TURSO_AUTH_TOKEN");
  process.exit(1);
}
const client = createClient({ url, authToken });
console.log(`→ Target: ${url.split("@")[1] || url}`);

let inserted = 0;
let changed = 0;
let unchanged = 0;
for (const r of rows) {
  const existing = await client.execute({
    sql: `SELECT class FROM "SkuTemperatureClass" WHERE sku = ?`,
    args: [r.sku],
  });
  const prev = existing.rows[0]?.class ?? null;
  if (prev === r.class) {
    unchanged++;
    continue;
  }
  if (prev == null) {
    await client.execute({
      sql: `INSERT INTO "SkuTemperatureClass" ("id","sku","class","source","setBy","updatedAt")
            VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      args: [crypto.randomUUID(), r.sku, r.class, source, setBy],
    });
    inserted++;
  } else {
    await client.execute({
      sql: `UPDATE "SkuTemperatureClass" SET class = ?, source = ?, setBy = ?, updatedAt = CURRENT_TIMESTAMP WHERE sku = ?`,
      args: [r.class, source, setBy, r.sku],
    });
    changed++;
  }
  await client.execute({
    sql: `INSERT INTO "SkuTemperatureClassChange" ("id","sku","fromClass","toClass","source","setBy")
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [crypto.randomUUID(), r.sku, prev, r.class, source, setBy],
  });
}

console.log(
  `✓ seed done: ${inserted} inserted, ${changed} re-classed, ${unchanged} already correct.`,
);
client.close();
