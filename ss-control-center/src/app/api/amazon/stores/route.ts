import { NextResponse } from "next/server";
import { getStoreCredentials } from "@/lib/amazon-sp-api/auth";
import { spApiGet } from "@/lib/amazon-sp-api/client";

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

  // Walmart placeholder
  stores.push({
    index: 6,
    configured: false,
    channel: "Walmart",
    name: "Walmart",
    comingSoon: true,
  });

  return NextResponse.json({ stores });
}
