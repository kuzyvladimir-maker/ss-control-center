import { NextResponse } from "next/server";

import { getWalmartStoreStatus } from "@/lib/walmart";

export const dynamic = "force-dynamic";

export async function GET() {
  const accounts = [];
  for (let storeIndex = 1; storeIndex <= 5; storeIndex += 1) {
    const status = getWalmartStoreStatus(storeIndex);
    if (!status.configured) continue;
    accounts.push({
      store_index: storeIndex,
      name: status.storeName,
    });
  }
  return NextResponse.json(
    { accounts },
    { headers: { "Cache-Control": "no-store" } },
  );
}
