// Sweep: find SKUs that our log says are RETIRED (open WalmartListingRetirement
// row, never rolled back) but that Walmart still shows live stock for — the
// fingerprint of a pre-multi-node-fix retire that only zeroed the default ship
// node and left stock selling from another warehouse.
//
//   npx tsx scripts/walmart-retire-residual-sweep.ts          (report only)
//   npx tsx scripts/walmart-retire-residual-sweep.ts --apply  (re-zero all nodes)

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

import { createClient } from "@libsql/client";
import { getWalmartClient } from "../src/lib/walmart/client";
import {
  readInventoryAcrossNodes,
  setInventoryAllNodes,
  verifyInventoryAllNodes,
} from "../src/lib/walmart/inventory";

const STORE_INDEX = 1;

async function main() {
  const apply = process.argv.includes("--apply");
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  // Distinct SKUs with an OPEN (not-rolled-back) retirement, newest first.
  const rows = await db.execute(
    "SELECT sku, MAX(retiredAt) AS retiredAt, MAX(productTitle) AS title FROM WalmartListingRetirement WHERE storeIndex=1 AND rolledBackAt IS NULL GROUP BY sku ORDER BY retiredAt DESC",
  );
  const skus = (rows.rows as any[]).map((r) => ({
    sku: String(r.sku),
    retiredAt: String(r.retiredAt ?? ""),
    title: String(r.title ?? ""),
  }));
  console.log(`Checking ${skus.length} open-retirement SKUs for residual live stock…\n`);

  const stillLive: Array<{ sku: string; total: number; retiredAt: string; title: string }> = [];

  const client = getWalmartClient(STORE_INDEX);
  for (const { sku, retiredAt, title } of skus) {
    const inv = await readInventoryAcrossNodes(client, STORE_INDEX, sku);
    if (inv.totalQty > 0) {
      const nodeStr = inv.nodes.filter((n) => (n.qty ?? 0) > 0).map((n) => `${n.shipNode}=${n.qty}`).join(", ");
      stillLive.push({ sku, total: inv.totalQty, retiredAt, title });
      console.log(`LIVE  ${sku}  total=${inv.totalQty}  [${nodeStr}]  retired ${retiredAt.slice(0, 10)}  ${title.slice(0, 50)}`);

      if (apply) {
        const writes = await setInventoryAllNodes(client, STORE_INDEX, sku, 0);
        const after = await verifyInventoryAllNodes(client, STORE_INDEX, sku, 0);
        const ok = writes.every((w) => w.ok) && after.totalQty === 0;
        console.log(`      → re-zeroed: ${ok ? "✅ total=0" : `⚠️ residual=${after.totalQty}`}`);
      }
    }
  }

  console.log(
    `\n${stillLive.length}/${skus.length} marked-retired SKUs still have live stock${apply ? " (re-zeroed)" : " (report only — re-run with --apply to fix)"}.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
