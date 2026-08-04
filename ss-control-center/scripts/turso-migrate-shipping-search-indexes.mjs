// One-off Turso migration: indexes for the Shipping Labels archive search.
// Idempotent — safe to re-run.
//   node --env-file=.env scripts/turso-migrate-shipping-search-indexes.mjs
//
// WHY. /api/shipping/search answers "find me that order by its tracking
// number / order number, whatever its status". Without these indexes every
// such lookup is a full scan of ShippingPlanItem — >120k rows — which costs
// ~500ms when Turso has the pages cached and 14s when it doesn't. The
// numbers an operator pastes are EXACT values, so an indexed equality
// lookup answers them instantly whether the cache is warm or stone cold.
//
// The route still falls back to a LIKE scan for partially-typed
// identifiers; these indexes just make the common paste-the-number case
// cost nothing.
import { createClient } from "@libsql/client";

const clean = (v) => (v ? v.trim().replace(/^['"]|['"]$/g, "") : v);
const url = clean(process.env.TURSO_DATABASE_URL);
const authToken = clean(process.env.TURSO_AUTH_TOKEN);
if (!url || !authToken) {
  console.error("Missing TURSO_DATABASE_URL / TURSO_AUTH_TOKEN");
  process.exit(1);
}
const client = createClient({ url, authToken });
console.log(`→ ${url.split("@")[1] || url}`);

const indexes = [
  ["ShippingPlanItem", "orderNumber", "ShippingPlanItem_orderNumber_idx"],
  ["ShippingPlanItem", "trackingNumber", "ShippingPlanItem_trackingNumber_idx"],
  ["WalmartLabelPurchase", "trackingNumber", "WalmartLabelPurchase_trackingNumber_idx"],
  ["MergeGroup", "trackingNumber", "MergeGroup_trackingNumber_idx"],
];

for (const [table, column, name] of indexes) {
  await client.execute(
    `CREATE INDEX IF NOT EXISTS "${name}" ON "${table}"("${column}")`,
  );
  console.log(`  + ${name}`);
}

console.log("✓ shipping search indexes ready");
client.close();
