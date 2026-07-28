// Roll up per-SKU sales / units / returns from our WalmartOrder history into
// WalmartSkuPerf (30/90/180-day windows). Walmart's listing-quality API returns
// empty GMV for us, so OUR orders are the reliable source. Re-run on a cron.
//
//   npx tsx scripts/walmart-sales-rollup.ts

import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv({ path: ".env" });
import { createClient } from "@libsql/client";

const db = createClient({ url: process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL!, authToken: process.env.TURSO_AUTH_TOKEN });

interface Bucket { units: number; sales: number; orders: number; returns: number; }
const zero = (): Bucket => ({ units: 0, sales: 0, orders: 0, returns: 0 });

function lineItemPrice(line: any): number {
  const charges = line?.charges?.charge || line?.charges || [];
  for (const c of Array.isArray(charges) ? charges : []) if (c?.chargeName === "ItemPrice" || c?.chargeType === "PRODUCT") return Number(c?.chargeAmount?.amount) || 0;
  return 0;
}
function isReturned(line: any): boolean {
  if (line?.refund && (line.refund.refundCharges || line.refund.refundId)) return true;
  const sts = line?.orderLineStatuses?.orderLineStatus || [];
  for (const s of Array.isArray(sts) ? sts : []) if (/refund|return/i.test(s?.status || "")) return true;
  return false;
}

async function main() {
  const now = Date.now();
  const D = 86400000;
  const rows = await db.execute(`SELECT orderDate, rawData, storeIndex FROM WalmartOrder WHERE rawData IS NOT NULL AND rawData != ''`);
  // sku -> {30,90,180}
  const acc = new Map<string, { storeIndex: number; w: Record<number, Bucket> }>();
  let parsed = 0;
  for (const r of rows.rows as any[]) {
    let j: any; try { j = JSON.parse(r.rawData); } catch { continue; }
    const ageDays = (now - new Date(r.orderDate).getTime()) / D;
    const lines = j?.orderLines?.orderLine || j?.orderLines || [];
    for (const line of Array.isArray(lines) ? lines : []) {
      const sku = line?.item?.sku || line?.sku; if (!sku) continue;
      const qty = Number(line?.orderLineQuantity?.amount) || 1;
      const price = lineItemPrice(line);
      const ret = isReturned(line);
      if (!acc.has(sku)) acc.set(sku, { storeIndex: Number(r.storeIndex) || 1, w: { 30: zero(), 90: zero(), 180: zero() } });
      const e = acc.get(sku)!;
      for (const win of [30, 90, 180]) {
        if (ageDays <= win) { const b = e.w[win]; b.units += qty; b.sales += price; b.orders += 1; if (ret) b.returns += qty; }
      }
    }
    parsed++;
  }
  let written = 0;
  for (const [sku, e] of acc) {
    await db.execute({
      sql: `INSERT INTO WalmartSkuPerf (sku, storeIndex, units30, sales30, orders30, returns30, units90, sales90, orders90, returns90, units180, sales180, orders180, returns180, computedAt)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
            ON CONFLICT(storeIndex, sku) DO UPDATE SET units30=excluded.units30, sales30=excluded.sales30, orders30=excluded.orders30, returns30=excluded.returns30,
              units90=excluded.units90, sales90=excluded.sales90, orders90=excluded.orders90, returns90=excluded.returns90,
              units180=excluded.units180, sales180=excluded.sales180, orders180=excluded.orders180, returns180=excluded.returns180, computedAt=CURRENT_TIMESTAMP`,
      args: [sku, e.storeIndex, e.w[30].units, round(e.w[30].sales), e.w[30].orders, e.w[30].returns, e.w[90].units, round(e.w[90].sales), e.w[90].orders, e.w[90].returns, e.w[180].units, round(e.w[180].sales), e.w[180].orders, e.w[180].returns],
    });
    written++;
  }
  console.log(`parsed ${parsed} orders · ${written} SKUs rolled up`);
}
function round(n: number) { return Math.round(n * 100) / 100; }
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
