// One-off Turso migration: add the dual-date columns to
// ShippingPlanItem (labelDate + physicalShipDate). Implements
// the schema half of MASTER_PROMPT v3.3 §0.1.
//
// The legacy `actualShipDay` column stays — readers fall back to
// it during the migration window. New writes will populate all
// three columns; we'll drop actualShipDay in a follow-up once
// every code path reads physicalShipDate.
//
// Idempotent — safe to re-run.

import { createClient } from "@libsql/client";

function clean(v) {
  if (!v) return v;
  return v.trim().replace(/^['"]|['"]$/g, "");
}

const url = clean(process.env.TURSO_DATABASE_URL);
const authToken = clean(process.env.TURSO_AUTH_TOKEN);
if (!url || !authToken) {
  console.error("Missing TURSO_DATABASE_URL / TURSO_AUTH_TOKEN");
  process.exit(1);
}

const client = createClient({ url, authToken });
console.log(`→ Target: ${url.split("@")[1] || url}`);

async function addColumnIfMissing(table, column, ddl) {
  const info = await client.execute(`PRAGMA table_info("${table}")`);
  if (info.rows.some((r) => r.name === column)) {
    console.log(`  · ${table}.${column} already exists`);
    return;
  }
  await client.execute(`ALTER TABLE "${table}" ADD COLUMN ${ddl}`);
  console.log(`  + added ${table}.${column}`);
}

console.log("Adding dual-date columns to ShippingPlanItem…");
await addColumnIfMissing(
  "ShippingPlanItem",
  "labelDate",
  `"labelDate" TEXT`
);
await addColumnIfMissing(
  "ShippingPlanItem",
  "physicalShipDate",
  `"physicalShipDate" TEXT`
);

// Backfill: for existing rows, copy actualShipDay into both new
// columns so reads against the new fields don't return null on
// already-bought labels.
const backfill = await client.execute(
  `UPDATE ShippingPlanItem
   SET labelDate = COALESCE(labelDate, actualShipDay),
       physicalShipDate = COALESCE(physicalShipDate, actualShipDay)
   WHERE actualShipDay IS NOT NULL
     AND (labelDate IS NULL OR physicalShipDate IS NULL)`
);
console.log(
  `  + backfilled ${backfill.rowsAffected ?? "?"} rows from actualShipDay`
);

console.log("Done.");
