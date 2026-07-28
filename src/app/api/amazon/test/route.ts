import { NextResponse } from "next/server";
import { getCachedAccessToken, getStoreCredentials } from "@/lib/amazon-sp-api/auth";
import { spApiGet } from "@/lib/amazon-sp-api/client";

export async function GET() {
  const results: Array<{
    store: number;
    status: "ok" | "error" | "not_configured";
    message: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    details?: any;
  }> = [];

  for (let i = 1; i <= 5; i++) {
    const creds = getStoreCredentials(i);

    if (!creds) {
      results.push({
        store: i,
        status: "not_configured",
        message: `Add AMAZON_SP_REFRESH_TOKEN_STORE${i} to .env`,
      });
      continue;
    }

    try {
      // Step 1: Get access token via per-store credentials
      const accessToken = await getCachedAccessToken(`store${i}`);

      // Step 2: Call Marketplace Participations endpoint
      const data = await spApiGet(
        "/sellers/v1/marketplaceParticipations",
        { storeId: `store${i}` }
      );

      const participations = data.payload || [];
      const marketplaces = participations
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((p: any) => p.isParticipating)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((p: any) => p.marketplace?.name || p.marketplace?.id)
        .join(", ") || "Connected (no marketplace names returned)";

      results.push({
        store: i,
        status: "ok",
        message: "Connected successfully",
        details: {
          marketplaces,
          tokenPreview: accessToken.substring(0, 20) + "...",
          participationsCount: participations.length,
        },
      });
    } catch (error) {
      results.push({
        store: i,
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const configured = results.filter((r) => r.status !== "not_configured");
  const connected = configured.filter((r) => r.status === "ok");

  return NextResponse.json({
    summary: {
      configured: configured.length,
      connected: connected.length,
      failed: configured.length - connected.length,
    },
    stores: results,
    timestamp: new Date().toISOString(),
  });
}
