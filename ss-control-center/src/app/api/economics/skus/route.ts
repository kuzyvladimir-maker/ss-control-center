// GET /api/economics/skus?store=1&marketplace=amazon
// Per-SKU economics (profit / margin / fee breakdown) for one store + marketplace.
// Read-only: assembled from cached sources, never writes prices.

import { NextRequest, NextResponse } from "next/server";
import { loadSkuEconomics } from "@/lib/economics/resolve-sku";
import type { Marketplace } from "@/lib/economics/types";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const storeIndex = Number(sp.get("store") ?? "1") || 1;
  const marketplace: Marketplace = sp.get("marketplace") === "walmart" ? "walmart" : "amazon";

  try {
    const summary = await loadSkuEconomics({ storeIndex, marketplace });
    return NextResponse.json(summary);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
