import { NextResponse } from "next/server";
import { getStoreCredentials } from "@/lib/amazon-sp-api/auth";

// GET /api/amazon/stores/status
// Lightweight per-store status check — DOES NOT call SP-API. Just reports
// which stores have credentials in .env and their display names. Used by the
// Settings UI to populate the SP-API panel on page load without hitting
// Amazon's rate limits. For a real connection test use
// GET /api/amazon/stores (which pings /sellers/v1/marketplaceParticipations).
export async function GET() {
  const stores = [];
  for (let i = 1; i <= 5; i++) {
    const creds = getStoreCredentials(i);
    const name = process.env[`STORE${i}_NAME`] || `Store ${i}`;
    stores.push({
      index: i,
      name,
      configured: !!creds,
    });
  }
  return NextResponse.json({ stores });
}
