import { NextRequest, NextResponse } from "next/server";
import {
  syncAllStores,
  syncStoreHealth,
} from "@/lib/amazon-sp-api/account-health-sync";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const storeIndex = body.storeIndex;

    if (storeIndex) {
      const result = await syncStoreHealth(storeIndex);
      return NextResponse.json(result);
    }

    const results = await syncAllStores();
    return NextResponse.json({ results });
  } catch (error) {
    console.error("Sync error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Sync failed" },
      { status: 500 }
    );
  }
}
