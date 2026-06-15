// Diagnostic + retire for the "Arnold Potato Buns" SKUs that stayed live
// after an old (pre-multi-node) retire. Uses the SAME production helpers the
// retire-listing/execute route uses, so whatever this proves is what the app
// does.
//
//   npx tsx scripts/diag-retire-arnold-buns.ts          (read-only diagnostic)
//   npx tsx scripts/diag-retire-arnold-buns.ts --apply  (PUT amount=0 all nodes)

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });

import { getWalmartClient } from "../src/lib/walmart/client";
import {
  getKnownShipNodes,
  readInventoryAcrossNodes,
  setInventoryAllNodes,
  verifyInventoryAllNodes,
  invalidateShipNodeCache,
} from "../src/lib/walmart/inventory";

const STORE_INDEX = 1;
const SKUS = [
  "FaisalX-1283",
  "FaisalX-1284",
  "FaisalX-1285",
  "FaisalX-1286",
  "FaisalX-1287",
  "FaisalX-1288",
];

async function main() {
  const apply = process.argv.includes("--apply");
  const client = getWalmartClient(STORE_INDEX);

  invalidateShipNodeCache(STORE_INDEX);
  const nodes = await getKnownShipNodes(client, STORE_INDEX);
  console.log(`\nDiscovered ${nodes.length} ship node(s):`, nodes.length ? nodes : "(none — would fall back to default-node only!)");

  for (const sku of SKUS) {
    const before = await readInventoryAcrossNodes(client, STORE_INDEX, sku);
    const perNode = before.nodes.map((n) => `${n.shipNode}=${n.qty}`).join(", ");
    console.log(`\n${sku}: total=${before.totalQty}  [${perNode}]`);

    if (!apply) continue;

    const writes = await setInventoryAllNodes(client, STORE_INDEX, sku, 0);
    console.log(`  PUT 0 → ${writes.map((w) => `${w.shipNode}:${w.ok ? "ok" : "FAIL(" + w.error + ")"}`).join(", ")}`);

    const after = await verifyInventoryAllNodes(client, STORE_INDEX, sku, 0);
    const afterNode = after.nodes.map((n) => `${n.shipNode}=${n.qty}`).join(", ");
    console.log(`  verified after ${after.attempts} attempt(s): total=${after.totalQty}  [${afterNode}]  ${after.totalQty === 0 ? "✅ retired" : "⚠️ residual stock"}`);
  }

  console.log(apply ? "\ndone (applied)" : "\ndone (read-only — re-run with --apply to zero)");
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
