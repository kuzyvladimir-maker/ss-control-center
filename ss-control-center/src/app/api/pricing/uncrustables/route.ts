import { NextRequest, NextResponse } from "next/server";
import {
  syncUncrustables,
  readSnapshot,
  applyReprice,
  PRICING_STORES,
  type RepriceResult,
} from "@/lib/pricing/uncrustables";

// Refreshing pulls the Merchant Listings report (~60-90s).
export const maxDuration = 300;

/**
 * GET  /api/pricing/uncrustables           → cached snapshot
 * GET  /api/pricing/uncrustables?refresh=1 → re-sync from SP-API, then snapshot
 */
export async function GET(request: NextRequest) {
  const refresh = request.nextUrl.searchParams.get("refresh") === "1";
  try {
    const snapshot = refresh
      ? await syncUncrustables()
      : (await readSnapshot()) ?? (await syncUncrustables());
    return NextResponse.json({ ok: true, snapshot });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: (e as Error).message },
      { status: 500 },
    );
  }
}

/**
 * POST /api/pricing/uncrustables
 * body: { items: [{ store, sku, price }], preview?: boolean }
 * Applies a new item price to each SKU. Returns per-SKU results.
 */
export async function POST(request: NextRequest) {
  let body: {
    items?: Array<{ store?: number; sku: string; price: number }>;
    preview?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad JSON" }, { status: 400 });
  }
  const items = body.items ?? [];
  if (!items.length)
    return NextResponse.json({ ok: false, error: "no items" }, { status: 400 });

  const results: RepriceResult[] = [];
  for (const it of items) {
    if (!it.sku || !Number.isFinite(it.price) || it.price <= 0) {
      results.push({ sku: it.sku ?? "?", ok: false, error: "bad item" });
      continue;
    }
    results.push(
      await applyReprice(it.store ?? PRICING_STORES[0], it.sku, it.price, {
        preview: body.preview,
      }),
    );
  }
  // Refresh the snapshot so the UI reflects applied prices (best-effort).
  if (!body.preview) {
    try {
      await syncUncrustables();
    } catch {
      /* non-fatal */
    }
  }
  return NextResponse.json({
    ok: results.every((r) => r.ok),
    applied: results.filter((r) => r.ok).length,
    results,
  });
}
