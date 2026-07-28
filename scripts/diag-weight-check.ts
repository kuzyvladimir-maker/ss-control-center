/**
 * diag-weight-check.ts — READ ONLY. Diagnose why a Frozen order's rate looks
 * mispriced for its weight. Shows the allocation's stored weight/package, then
 * quotes the new Rate Shopping API (a) with NO parcel (the fallback path) and
 * (b) with an explicit parcel, comparing the FedEx 2Day One Rate price.
 *
 * Run: cd ss-control-center && npx tsx scripts/diag-weight-check.ts <ORDER#> [lbs] [LxWxH]
 */
import "dotenv/config";
import { config as dotenvConfig } from "dotenv";
dotenvConfig({ path: ".env.local" });
import { veeqoFetch, getRatesForShipDate, veeqoDateToLocal } from "../src/lib/veeqo/client";

const ORDER = process.argv[2] || "112-0136653-0992249";
const LBS = Number(process.argv[3] || 32);
const DIMS = (process.argv[4] || "24x13x16").split("x").map(Number);

async function findOrder() {
  for (let p = 1; p <= 12; p++) {
    const os = await veeqoFetch(`/orders?status=awaiting_fulfillment&page_size=100&page=${p}`);
    if (!os || !os.length) break;
    const h = os.find((o: any) => o.number === ORDER);
    if (h) return h;
  }
  return null;
}
function dump(label: string, rates: any[]) {
  console.log(`\n[${label}]`);
  for (const frag of ["2Day® One Rate", "UPS® Ground", "FedEx Home", "Ground Advantage (1"]) {
    const r = rates.find((x) => (x.title || "").toLowerCase().includes(frag.toLowerCase()));
    if (r) console.log(`   ${r.title}: $${r.total_net_charge}  EDD ${veeqoDateToLocal(r.delivery_promise_date)}`);
  }
}

async function main() {
  const order = await findOrder();
  if (!order) { console.error("not found"); process.exit(1); }
  const alloc = order.allocations?.[0];
  console.log(`Order ${ORDER}`);
  console.log(`  allocation.total_weight = ${alloc?.total_weight} ${alloc?.weight_unit}  (= ${(alloc?.total_weight/16).toFixed(1)} lb)`);
  console.log(`  allocation_package = ${JSON.stringify(alloc?.allocation_package && { depth: alloc.allocation_package.depth, width: alloc.allocation_package.width, height: alloc.allocation_package.height, weight: alloc.allocation_package.weight, weight_unit: alloc.allocation_package.weight_unit })}`);
  console.log(`  line_items qty total = ${(order.line_items || []).reduce((s: number, li: any) => s + (li.quantity || 0), 0)}`);

  // (a) fallback: no parcel → uses alloc.total_weight + allocation_package
  const a = await getRatesForShipDate(order, "2026-06-12T16:00:00Z");
  dump(`NO parcel (fallback → alloc weight)`, a.available);

  // (b) explicit correct parcel
  const b = await getRatesForShipDate(order, "2026-06-12T16:00:00Z", {
    weightOz: LBS * 16, lengthIn: DIMS[0], widthIn: DIMS[1], heightIn: DIMS[2],
  });
  dump(`WITH parcel ${LBS}lb ${DIMS.join("x")}`, b.available);
}
main().catch((e) => { console.error(e); process.exit(1); });
