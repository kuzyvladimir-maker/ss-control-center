// GET /api/economics/skus?store=1&marketplace=amazon
// Per-SKU economics (profit / margin / fee breakdown) for one store + marketplace.
// Read-only transitional endpoint. The response declares itself non-authoritative
// until this consumer is switched to the manifest-bound Product Truth gateway.

import { NextRequest, NextResponse } from "next/server";
import { loadSkuEconomics } from "@/lib/economics/resolve-sku";
import type { Marketplace } from "@/lib/economics/types";

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const storeIndex = Number(sp.get("store") ?? "1");
  const rawMarketplace = sp.get("marketplace") ?? "amazon";
  if (!Number.isSafeInteger(storeIndex) || storeIndex < 1) {
    return NextResponse.json(
      { error: "store must be a positive integer exact account scope" },
      { status: 400 },
    );
  }
  if (rawMarketplace !== "amazon" && rawMarketplace !== "walmart") {
    return NextResponse.json(
      { error: "marketplace must be amazon or walmart" },
      { status: 400 },
    );
  }
  const marketplace: Marketplace = rawMarketplace;

  try {
    const summary = await loadSkuEconomics({ storeIndex, marketplace });
    return NextResponse.json(summary);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
