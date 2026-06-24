/**
 * GET /api/walmart/compliance-removals
 *
 * Machine-readable list of listings Walmart pulled for an Item-Compliance /
 * Trust-&-Safety violation (Prohibited Products etc.) — the same items the
 * Seller Center "Health & Compliance → Item compliance" task + T&S "Download
 * Reports" button show, but via the API.
 *
 * Live read off GET /v3/items?publishedStatus=UNPUBLISHED, classified by the
 * per-item `unpublishedReasons` text. See src/lib/walmart/compliance-removals.ts
 * for why this is the right endpoint (Insights unpublished/items is 403 without
 * a registered consumer channel; its counts feed never lists T&S).
 *
 * Query params:
 *   storeIndex  (default 1 = STARFITSTORE / Sirius Trading)
 *   includeAll  ("1"/"true" → return every unpublished class, not just violations)
 *   format      ("csv" → text/csv download; default JSON)
 */

import { NextRequest, NextResponse } from "next/server";
import { WalmartClient } from "@/lib/walmart/client";
import { getComplianceRemovals, type RemovedItem } from "@/lib/walmart/compliance-removals";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

function toCsv(rows: RemovedItem[]): string {
  const cols: Array<keyof RemovedItem> = [
    "sku",
    "itemId",
    "upc",
    "gtin",
    "productName",
    "productType",
    "price",
    "currency",
    "publishedStatus",
    "lifecycleStatus",
    "classification",
    "reason",
    "reasonUrl",
  ];
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = cols.join(",");
  const body = rows.map((r) => cols.map((c) => esc(r[c])).join(",")).join("\n");
  return `${head}\n${body}\n`;
}

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const storeIndex = Number(sp.get("storeIndex") ?? 1);
  const includeAll = ["1", "true", "yes"].includes((sp.get("includeAll") ?? "").toLowerCase());
  const format = (sp.get("format") ?? "json").toLowerCase();

  let client: WalmartClient;
  try {
    client = new WalmartClient(storeIndex);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }

  try {
    const result = await getComplianceRemovals(client, { includeAll });

    if (format === "csv") {
      return new NextResponse(toCsv(result.removals), {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="walmart-compliance-removals-store${storeIndex}.csv"`,
        },
      });
    }

    return NextResponse.json({
      ...result,
      violationCount: result.removals.filter(
        (r) => r.classification === "TRUST_SAFETY_FLAG" || r.classification === "COMPLIANCE"
      ).length,
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 502 });
  }
}
