// One-off Turso migration: indexes for the shipped-package fallback.
// Idempotent — safe to re-run.
//   node --env-file=.env scripts/turso-migrate-shipping-package-history-indexes.mjs
//
// WHY. When an order's SKU has no weight/box in the catalog, the shipping plan
// looks for a label we already bought for the same SKU or the same listing
// title (src/lib/shipping/package-history.ts). ShippingPlanItem is >120k rows;
// without these indexes every such lookup is a full scan on every plan load.
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
  ["ShippingPlanItem", "sku", "ShippingPlanItem_sku_idx"],
  ["ShippingPlanItem", "product", "ShippingPlanItem_product_idx"],
];

for (const [table, column, name] of indexes) {
  await client.execute(
    `CREATE INDEX IF NOT EXISTS "${name}" ON "${table}"("${column}")`,
  );
  console.log(`  + ${name}`);
}

console.log("✓ shipping package-history indexes ready");
client.close();
