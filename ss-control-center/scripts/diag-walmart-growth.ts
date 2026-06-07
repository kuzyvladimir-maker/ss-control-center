// Diagnostic: probe Walmart Marketplace "Grow Sales" endpoints LIVE against our
// store, none of which are wired into SS-CC yet. Goal — see what the API will
// actually return for OUR account so we can decide what growth tooling to build.
//
// Read-only. The only writes are report REQUESTS (POST /reports/reportRequests),
// which just queue a report on Walmart's side — they don't touch prices,
// promos, inventory, or listings.
//
//   npx tsx scripts/diag-walmart-growth.ts
//
// Covers:
//   1. Listing Quality Score   (seller-level headline + 5 components)
//   2. Item Listing Quality    (per-item issues, first page)
//   3. Unpublished items count  (revenue-leak detector)
//   4. Buy Box report request   (where we win/lose the buy box + by how much)
//   5. Item Performance request (traffic vs conversion per SKU)
//
// For (1)-(3) we try several path/shape variants because Walmart's Insights
// surface mixes acronyms and camelCase and we don't have definitive docs for
// every one — same defensive approach as src/lib/walmart/seller-performance.ts.
import "dotenv/config";
import { getWalmartClient } from "@/lib/walmart/client";

const STORE = 1;

type Raw = { status: number; ok: boolean; body: unknown; correlationId: string };

function preview(body: unknown, max = 1400): string {
  if (body == null) return "(empty)";
  if (typeof body === "string") return body.slice(0, max);
  try {
    return JSON.stringify(body, null, 2).slice(0, max);
  } catch {
    return String(body).slice(0, max);
  }
}

/** Try a list of GET path candidates, stop on first non-404. */
async function probeGet(
  label: string,
  candidates: Array<{ path: string; params?: Record<string, string | number | boolean> }>
): Promise<Raw | null> {
  const client = getWalmartClient(STORE);
  console.log(`\n${"=".repeat(78)}\n## ${label}\n${"=".repeat(78)}`);
  for (const c of candidates) {
    try {
      const res = await client.requestRaw("GET", c.path, { params: c.params });
      console.log(`GET /v3${c.path} ${JSON.stringify(c.params ?? {})} → ${res.status}`);
      if (res.status === 404) continue;
      console.log(preview(res.body));
      return res;
    } catch (e) {
      console.log(`GET /v3${c.path} → THREW: ${(e as Error).message.slice(0, 160)}`);
    }
  }
  console.log("  (all candidates 404'd — endpoint not exposed under these paths)");
  return null;
}

/** Try a list of POST path candidates with a body. */
async function probePost(
  label: string,
  candidates: Array<{ path: string; params?: Record<string, string | number | boolean>; body?: unknown }>
): Promise<Raw | null> {
  const client = getWalmartClient(STORE);
  console.log(`\n${"=".repeat(78)}\n## ${label}\n${"=".repeat(78)}`);
  for (const c of candidates) {
    try {
      const res = await client.requestRaw("POST", c.path, { params: c.params, body: c.body });
      console.log(`POST /v3${c.path} ${JSON.stringify(c.params ?? {})} → ${res.status}`);
      if (res.status === 404) continue;
      console.log(preview(res.body));
      return res;
    } catch (e) {
      console.log(`POST /v3${c.path} → THREW: ${(e as Error).message.slice(0, 160)}`);
    }
  }
  console.log("  (all candidates 404'd — endpoint not exposed under these paths)");
  return null;
}

async function main() {
  const status = getWalmartClient(STORE);
  console.log(`Store ${STORE}: ${status.credentials.storeName} (seller ${status.credentials.sellerId})`);

  // ── 1. Seller Listing Quality Score — the headline "Grow Sales" number ──
  await probeGet("1. Listing Quality Score (seller-level)", [
    { path: "/insights/items/listingQuality/score", params: { wfsFlag: false } },
    { path: "/insights/items/listingQuality/score" },
    { path: "/insights/items/listingQuality/score", params: { viewTrendingItems: true } },
  ]);

  // ── 2. Item-level Listing Quality details — what to fix per SKU ──
  await probePost("2. Item Listing Quality details (first page)", [
    { path: "/insights/items/listingQuality/items", params: { limit: 20 }, body: {} },
    { path: "/insights/items/listingQuality/items", params: { limit: 20 }, body: { query: {}, filters: [] } },
  ]);

  // categories carrying quality issues (helps prioritise)
  await probeGet("2b. Categories with listing-quality issues", [
    { path: "/insights/items/listingQuality/categories" },
    { path: "/insights/items/listingQuality/category" },
  ]);

  // ── 3. Unpublished items — items that COULD sell but aren't live ──
  await probeGet("3. Unpublished items count (revenue leaks)", [
    { path: "/insights/items/unpublished/count" },
    { path: "/insights/items/unpublished/counts" },
    { path: "/insights/unpublished/count" },
  ]);

  // ── 4 & 5. Async reports — request + poll briefly. Generation takes
  // 15-45 min, so if not READY we just print the requestId to fetch later.
  for (const reportType of ["BUYBOX", "ITEM_PERFORMANCE"] as const) {
    console.log(`\n${"=".repeat(78)}\n## ${reportType === "BUYBOX" ? "4" : "5"}. ${reportType} report\n${"=".repeat(78)}`);
    const client = getWalmartClient(STORE);
    let requestId: string | null = null;
    try {
      const req = await client.requestRaw("POST", "/reports/reportRequests", {
        params: { reportType, reportVersion: "v1" },
        // reportRequests demands Content-Type: application/json even with no
        // payload. Our client only sets it when a body is present, so force it.
        body: {},
        headers: { "Content-Type": "application/json" },
      });
      console.log(`POST /v3/reports/reportRequests?reportType=${reportType} → ${req.status}`);
      console.log(preview(req.body, 600));
      const b = req.body as { requestId?: string; requestID?: string } | undefined;
      requestId = b?.requestId ?? b?.requestID ?? null;
    } catch (e) {
      console.log(`  request THREW: ${(e as Error).message.slice(0, 200)}`);
      continue;
    }
    if (!requestId) {
      console.log("  no requestId returned — see body above");
      continue;
    }
    // poll a few times (don't block forever)
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 4000));
      const st = await client.requestRaw("GET", `/reports/reportRequests/${requestId}`);
      const sb = st.body as { requestStatus?: string; status?: string } | undefined;
      const s = sb?.requestStatus ?? sb?.status ?? "?";
      console.log(`  status[${i + 1}] = ${s}`);
      if (s === "READY") {
        const dl = await client.requestRaw("GET", "/reports/downloadReport", { params: { requestId } });
        console.log("  download response:", preview(dl.body, 400));
        break;
      }
    }
    console.log(`  → requestId=${requestId} (fetch later if not READY)`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
