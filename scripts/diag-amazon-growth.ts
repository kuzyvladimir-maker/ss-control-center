// Diagnostic: probe the data sources for the future "Amazon Grow" module LIVE
// against our selling accounts (store1 = Salutem, store3 = AMZ Commerce). Amazon
// has NO native Listing Quality Score (unlike Walmart Insights), so we must
// derive one. This script confirms which signals are actually available to us:
//
//   1. Listings Items API  (includedData=summaries,issues,offers) — per-SKU
//      status (BUYABLE/DISCOVERABLE), issues list, fulfillment availability.
//   2. GET_MERCHANTS_LISTINGS_FYP_REPORT — "Fix Your Products" / suppressed
//      listings bulk report (reason + how-to-fix per SKU).
//   3. GET_SALES_AND_TRAFFIC_REPORT — per-ASIN sessions/page-views/buy-box%/
//      unit-session-% (conversion). Available to ALL sellers, no Brand Registry.
//   4. GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT — search visibility.
//      Brand-Registry-gated; success here CONFIRMS our Brand Registry access.
//   5. Catalog Items API 2022-04-01 — content completeness signals for one ASIN.
//
// Read-only except report REQUESTS (POST /reports) — those are harmless.
//
//   npx tsx scripts/diag-amazon-growth.ts            # store1 + store3
//   npx tsx scripts/diag-amazon-growth.ts 1          # just store1

import "dotenv/config";
import { spApiGet, MARKETPLACE_ID } from "@/lib/amazon-sp-api/client";
import { getMerchantToken } from "@/lib/amazon-sp-api/sellers";
import { listSkus } from "@/lib/amazon-sp-api/listings";
import { getCachedAccessToken } from "@/lib/amazon-sp-api/auth";

const SP_ENDPOINT =
  process.env.AMAZON_SP_ENDPOINT || "https://sellingpartnerapi-na.amazon.com";

const line = (c = "─") => console.log(c.repeat(72));

// ─── Flexible report runner (createReport hardcodes dates; some report types
//     reject them and others need reportOptions, so we roll our own here) ──────
interface ReportProbeOpts {
  reportType: string;
  withDates?: boolean;
  daysBack?: number;
  reportOptions?: Record<string, string>;
  maxWaitMs?: number;
}

async function probeReport(storeId: string, o: ReportProbeOpts) {
  const token = await getCachedAccessToken(storeId);
  const body: Record<string, unknown> = {
    reportType: o.reportType,
    marketplaceIds: [MARKETPLACE_ID],
  };
  if (o.withDates) {
    const days = o.daysBack ?? 30;
    body.dataEndTime = new Date(Date.now() - 2 * 864e5).toISOString();
    body.dataStartTime = new Date(Date.now() - (days + 2) * 864e5).toISOString();
  }
  if (o.reportOptions) body.reportOptions = o.reportOptions;

  const createRes = await fetch(`${SP_ENDPOINT}/reports/2021-06-30/reports`, {
    method: "POST",
    headers: { "x-amz-access-token": token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const createTxt = await createRes.text();
  if (!createRes.ok) {
    return { ok: false as const, stage: "create", status: createRes.status, msg: createTxt };
  }
  const reportId = JSON.parse(createTxt).reportId as string;
  console.log(`    requested reportId=${reportId}, polling…`);

  const maxWait = o.maxWaitMs ?? 90_000;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    await new Promise((r) => setTimeout(r, 12_000));
    const stRes = await fetch(`${SP_ENDPOINT}/reports/2021-06-30/reports/${reportId}`, {
      headers: { "x-amz-access-token": await getCachedAccessToken(storeId) },
    });
    const st = await stRes.json();
    const status = st.processingStatus as string;
    if (status === "DONE") {
      const docRes = await fetch(
        `${SP_ENDPOINT}/reports/2021-06-30/documents/${st.reportDocumentId}`,
        { headers: { "x-amz-access-token": await getCachedAccessToken(storeId) } },
      );
      const doc = await docRes.json();
      const dlRes = await fetch(doc.url);
      const buf = Buffer.from(await dlRes.arrayBuffer());
      let text: string;
      if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
        const { gunzipSync } = await import("node:zlib");
        text = gunzipSync(buf).toString("utf-8");
      } else {
        text = buf.toString("utf-8");
      }
      return { ok: true as const, status, text };
    }
    if (status === "FATAL" || status === "CANCELLED") {
      return { ok: false as const, stage: "process", status, msg: status };
    }
    console.log(`      …${status}`);
  }
  return { ok: false as const, stage: "timeout", status: "TIMEOUT", msg: `>${maxWait}ms` };
}

// ─── Probes ──────────────────────────────────────────────────────────────────
async function probeListingsIssues(storeIndex: number, sellerId: string) {
  line();
  console.log(`[1] Listings Items API — issues + status (store${storeIndex})`);
  const resp = await listSkus(storeIndex, sellerId, {
    pageSize: 20,
    includedData: ["summaries", "issues", "offers"],
  });
  console.log(`    numberOfResults (account total est.): ${resp.numberOfResults}`);
  console.log(`    fetched first page: ${resp.items.length} items`);

  let withIssues = 0;
  const statusCount: Record<string, number> = {};
  const severityCount: Record<string, number> = {};
  let sampleIssue: unknown = null;
  let sampleSummary: unknown = null;

  for (const item of resp.items) {
    const it = item as Record<string, any>;
    const issues = (it.issues as any[]) ?? [];
    if (issues.length) {
      withIssues++;
      if (!sampleIssue) sampleIssue = issues[0];
      for (const iss of issues) {
        const sev = iss.severity ?? "UNKNOWN";
        severityCount[sev] = (severityCount[sev] ?? 0) + 1;
      }
    }
    const summary = (it.summaries as any[])?.[0];
    if (summary) {
      if (!sampleSummary) sampleSummary = summary;
      const statuses: string[] = summary.status ?? [];
      for (const s of statuses) statusCount[s] = (statusCount[s] ?? 0) + 1;
    }
  }
  console.log(`    items with issues (this page): ${withIssues}/${resp.items.length}`);
  console.log(`    status tally:`, statusCount);
  console.log(`    issue severity tally:`, severityCount);
  if (sampleSummary) console.log(`    sample summary:`, JSON.stringify(sampleSummary, null, 2));
  if (sampleIssue) console.log(`    sample issue:`, JSON.stringify(sampleIssue, null, 2));

  // Return a sample ASIN/SKU for the catalog probe.
  const firstSummary = (resp.items[0] as any)?.summaries?.[0];
  return { asin: firstSummary?.asin as string | undefined, sku: resp.items[0]?.sku };
}

function reportShape(text: string, label: string) {
  const lines = text.split("\n").filter((l) => l.trim());
  console.log(`    ${label}: ${lines.length} line(s)`);
  if (lines.length) {
    console.log(`    columns: ${lines[0].slice(0, 400)}`);
    if (lines[1]) console.log(`    sample row: ${lines[1].slice(0, 400)}`);
  }
}

async function probeFyp(storeIndex: number) {
  line();
  console.log(`[2] GET_MERCHANTS_LISTINGS_FYP_REPORT — suppressed listings (store${storeIndex})`);
  const r = await probeReport(`store${storeIndex}`, {
    reportType: "GET_MERCHANTS_LISTINGS_FYP_REPORT",
  });
  if (r.ok) reportShape(r.text, "FYP rows");
  else console.log(`    ✗ ${r.stage} ${r.status}: ${String(r.msg).slice(0, 300)}`);
}

async function probeSalesTraffic(storeIndex: number) {
  line();
  console.log(`[3] GET_SALES_AND_TRAFFIC_REPORT — per-ASIN conversion (store${storeIndex})`);
  const r = await probeReport(`store${storeIndex}`, {
    reportType: "GET_SALES_AND_TRAFFIC_REPORT",
    withDates: true,
    daysBack: 30,
    reportOptions: { dateGranularity: "DAY", asinGranularity: "CHILD" },
  });
  if (r.ok) {
    const j = (() => { try { return JSON.parse(r.text); } catch { return null; } })();
    if (j) {
      const byAsin = j.salesAndTrafficByAsin ?? [];
      console.log(`    JSON report. salesAndTrafficByAsin entries: ${byAsin.length}`);
      if (byAsin[0]) console.log(`    sample ASIN entry:`, JSON.stringify(byAsin[0], null, 2).slice(0, 800));
    } else {
      reportShape(r.text, "S&T rows");
    }
  } else {
    console.log(`    ✗ ${r.stage} ${r.status}: ${String(r.msg).slice(0, 300)}`);
  }
}

async function probeBrandAnalytics(storeIndex: number) {
  line();
  console.log(`[4] GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT (store${storeIndex})`);
  console.log(`    (success here CONFIRMS Brand Registry data access)`);
  const r = await probeReport(`store${storeIndex}`, {
    reportType: "GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT",
    reportOptions: { reportPeriod: "WEEK" },
    withDates: true,
    daysBack: 14,
    maxWaitMs: 300_000,
  });
  if (r.ok) {
    console.log(`    ✓ Brand Analytics ACCESSIBLE`);
    reportShape(r.text, "SQP rows");
  } else {
    console.log(`    ✗ ${r.stage} ${r.status}: ${String(r.msg).slice(0, 300)}`);
    console.log(`    (if 403/access-denied → Brand Registry not granting this report)`);
  }
}

async function probeCatalog(storeIndex: number, asin?: string) {
  line();
  console.log(`[5] Catalog Items API 2022-04-01 — content completeness (store${storeIndex})`);
  if (!asin) {
    console.log(`    no sample ASIN from listings probe — skipping`);
    return;
  }
  try {
    const resp = await spApiGet(`/catalog/2022-04-01/items/${encodeURIComponent(asin)}`, {
      storeId: `store${storeIndex}`,
      params: {
        marketplaceIds: MARKETPLACE_ID,
        includedData: "attributes,images,productTypes,summaries,relationships",
      },
    });
    const r = resp as Record<string, any>;
    console.log(`    asin ${asin}:`);
    console.log(`      productTypes:`, JSON.stringify(r.productTypes ?? []));
    const imgGroups = r.images?.[0]?.images ?? [];
    console.log(`      images: ${imgGroups.length} variant(s)`);
    console.log(`      attribute keys: ${Object.keys(r.attributes ?? {}).length}`);
    const summ = r.summaries?.[0] ?? {};
    console.log(`      summary fields:`, Object.keys(summ).join(", "));
  } catch (e) {
    console.log(`    ✗ catalog probe failed: ${(e as Error).message.slice(0, 300)}`);
  }
}

async function runStore(storeIndex: number) {
  console.log("\n");
  line("═");
  console.log(`STORE${storeIndex}`);
  line("═");

  let sellerId: string;
  try {
    sellerId = await getMerchantToken(storeIndex);
    console.log(`sellerId (US): ${sellerId}`);
  } catch (e) {
    console.log(`✗ cannot resolve sellerId: ${(e as Error).message}`);
    return;
  }

  let sample: { asin?: string; sku?: string } = {};
  try {
    sample = await probeListingsIssues(storeIndex, sellerId);
  } catch (e) {
    console.log(`✗ listings probe failed: ${(e as Error).message}`);
  }

  await probeFyp(storeIndex).catch((e) => console.log(`✗ FYP: ${e.message}`));
  await probeSalesTraffic(storeIndex).catch((e) => console.log(`✗ S&T: ${e.message}`));
  await probeBrandAnalytics(storeIndex).catch((e) => console.log(`✗ BA: ${e.message}`));
  await probeCatalog(storeIndex, sample.asin).catch((e) => console.log(`✗ catalog: ${e.message}`));
}

async function main() {
  const arg = process.argv[2];
  const stores = arg ? [Number(arg)] : [1, 3];
  console.log(`Amazon Grow data-source probe · marketplace ${MARKETPLACE_ID} · stores ${stores.join(", ")}`);
  for (const s of stores) await runStore(s);
  console.log("\nDone.");
  process.exit(0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
