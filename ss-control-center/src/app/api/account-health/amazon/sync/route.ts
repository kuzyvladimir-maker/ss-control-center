import { NextRequest, NextResponse } from "next/server";
import { syncStoreHealth } from "@/lib/amazon-sp-api/account-health-sync";
import { getStoreCredentials } from "@/lib/amazon-sp-api/auth";

// POST /api/account-health/amazon/sync
// Body (optional): { storeIndexes?: number[] } — when omitted, syncs every
// store that has SP-API credentials configured.
export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const requested: number[] | undefined = Array.isArray(body?.storeIndexes)
    ? body.storeIndexes
    : undefined;
  const indexes = (requested ?? [1, 2, 3, 4, 5]).filter((i) =>
    getStoreCredentials(i)
  );

  const results = [];
  for (const idx of indexes) {
    try {
      results.push(await syncStoreHealth(idx));
    } catch (err) {
      results.push({
        success: false,
        storeIndex: idx,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return NextResponse.json({ results });
}
