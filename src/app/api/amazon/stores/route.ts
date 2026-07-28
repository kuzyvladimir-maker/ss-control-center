import { NextResponse } from "next/server";
import { getStoreCredentials } from "@/lib/amazon-sp-api/auth";
import { spApiGet } from "@/lib/amazon-sp-api/client";
import { getWalmartStoreStatus } from "@/lib/walmart";

export async function GET() {
  const stores = [];

  for (let i = 1; i <= 5; i++) {
    const creds = getStoreCredentials(i);
    const envName = process.env[`STORE${i}_NAME`] || `Store ${i}`;

    if (!creds) {
      stores.push({
        index: i,
        configured: false,
        channel: "Amazon",
        name: envName,
      });
      continue;
    }

    try {
      const data = await spApiGet(
        "/sellers/v1/marketplaceParticipations",
        { storeId: `store${i}` }
      );
      const participations = data.payload || [];
      const usMp = participations.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (p: any) => p.marketplace?.id === "ATVPDKIKX0DER"
      );

      stores.push({
        index: i,
        configured: true,
        channel: "Amazon",
        name: envName,
        marketplace: usMp?.marketplace?.name || "United States",
        sellerId: usMp?.participation?.sellerId,
      });
    } catch (error) {
      stores.push({
        index: i,
        configured: true,
        channel: "Amazon",
        name: envName,
        error: error instanceof Error ? error.message : "Connection error",
      });
    }
  }

  // Walmart — show the real env-driven status so the UI doesn't pretend
  // Walmart is a stub when credentials are actually in place.
  const walmartStatus = getWalmartStoreStatus(1);
  stores.push({
    index: 6,
    configured: walmartStatus.configured,
    channel: "Walmart",
    name: walmartStatus.storeName,
    comingSoon: !walmartStatus.configured,
  });

  return NextResponse.json({ stores });
}
