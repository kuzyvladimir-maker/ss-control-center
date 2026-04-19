#!/usr/bin/env tsx
/**
 * Walmart smoke test — validates auth and 4 read-only endpoints.
 * Run from repo root: npx tsx scripts/walmart-smoke-test.ts
 *
 * Loads .env via dotenv, then exercises:
 *   1. Token endpoint (auth)
 *   2. /v3/orders (last 30 days, limit 5)
 *   3. /v3/returns (last 30 days, limit 5)
 *   4. /v3/report/reconreport/availableReconFiles
 */

import "dotenv/config";

import { WalmartClient, WalmartApiError } from "../src/lib/walmart/client";
import { WalmartOrdersApi } from "../src/lib/walmart/orders";
import { WalmartReturnsApi } from "../src/lib/walmart/returns";
import { WalmartReportsApi } from "../src/lib/walmart/reports";

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

function describeError(err: unknown): string {
  if (err instanceof WalmartApiError) {
    const body = JSON.stringify(err.errorBody).slice(0, 400);
    return `${err.message}\n     body: ${body}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

async function main() {
  console.log("=== Walmart Smoke Test ===");
  console.log("Store: WALMART_STORE1_NAME =", process.env.WALMART_STORE1_NAME);

  const client = new WalmartClient(1);

  // 1. Auth
  console.log("\n[1/4] Auth — POST /v3/token...");
  try {
    const token = await client.getAccessToken();
    console.log(
      `  ✅ Token obtained (length ${token.accessToken.length}), expires at ${token.expiresAt.toISOString()}`
    );
  } catch (err) {
    console.log(`  ❌ Auth failed: ${describeError(err)}`);
    return;
  }

  // 2. Orders
  console.log("\n[2/4] GET /v3/orders (last 30d, limit 5)...");
  const orders = new WalmartOrdersApi(client);
  try {
    const page = await orders.getAllOrders({
      createdStartDate: isoDaysAgo(30),
      limit: 5,
    });
    console.log(
      `  ✅ Got ${page.orders.length} orders (totalCount=${page.totalCount}, nextCursor=${page.nextCursor ? "yes" : "no"})`
    );
    page.orders.slice(0, 3).forEach((o) => {
      console.log(
        `     - PO ${o.purchaseOrderId} | ${o.status} | $${o.orderTotal} | ${o.orderLines.length} line(s)`
      );
    });
  } catch (err) {
    console.log(`  ❌ Orders failed: ${describeError(err)}`);
  }

  // 3. Returns
  console.log("\n[3/4] GET /v3/returns (last 30d, limit 5)...");
  const returns = new WalmartReturnsApi(client);
  try {
    const raw = await client.request<unknown>("GET", "/returns", {
      params: {
        returnCreationStartDate: isoDaysAgo(30),
        returnCreationEndDate: new Date().toISOString(),
        limit: 2,
      },
    });
    console.log(`  raw keys: ${Object.keys(raw as object).join(", ")}`);
    console.log(`  raw sample: ${JSON.stringify(raw).slice(0, 500)}`);
    const rp = await returns.getAllReturns({
      returnCreationStartDate: isoDaysAgo(30),
      returnCreationEndDate: new Date().toISOString(),
      limit: 5,
    });
    console.log(`  ✅ Got ${rp.returns.length} returns (totalCount=${rp.totalCount})`);
    rp.returns.slice(0, 3).forEach((r) => {
      console.log(`     - return ${r.returnOrderId} | ${r.status} | ${r.returnLines.length} line(s)`);
    });
  } catch (err) {
    console.log(`  ❌ Returns failed: ${describeError(err)}`);
  }

  // 4. Recon report dates — also dump raw shape for debugging
  console.log("\n[4/4] GET /v3/report/reconreport/availableReconFiles...");
  const reports = new WalmartReportsApi(client);
  try {
    const raw = await client.request<unknown>(
      "GET",
      "/report/reconreport/availableReconFiles"
    );
    console.log(`  raw shape: ${JSON.stringify(raw).slice(0, 400)}`);
    const dates = await reports.getAvailableReconReportDates();
    console.log(`  ✅ Got ${dates.length} available recon dates`);
    if (dates.length > 0) {
      console.log(`     latest: ${dates[0]} | oldest: ${dates[dates.length - 1]}`);
    }
  } catch (err) {
    console.log(`  ❌ Reports failed: ${describeError(err)}`);
  }

  console.log("\n=== Smoke test done ===");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
