import { NextResponse } from "next/server";
import { getStoreCredentials } from "@/lib/amazon-sp-api/auth";
import { getWalmartStoreStatus } from "@/lib/walmart";
import { getDriveStatus } from "@/lib/google-drive";

export async function GET() {
  const integrations = [];

  // Amazon SP-API stores
  const connectedStores: string[] = [];
  for (let i = 1; i <= 5; i++) {
    if (getStoreCredentials(i)) {
      connectedStores.push(process.env[`STORE${i}_NAME`] || `Store ${i}`);
    }
  }
  integrations.push({
    name: "Amazon SP-API",
    status: connectedStores.length > 0 ? "connected" : "not_configured",
    detail: connectedStores.length > 0
      ? `${connectedStores.length} store${connectedStores.length > 1 ? "s" : ""}: ${connectedStores.join(", ")}`
      : "Add AMAZON_SP_REFRESH_TOKEN_STORE1 to .env",
  });

  // Veeqo
  integrations.push({
    name: "Veeqo",
    status: process.env.VEEQO_API_KEY ? "connected" : "not_configured",
    detail: process.env.VEEQO_API_KEY ? "API key configured" : "Add VEEQO_API_KEY to .env",
  });

  // Sellbrite
  integrations.push({
    name: "Sellbrite",
    status: process.env.SELLBRITE_ACCOUNT_TOKEN ? "connected" : "not_configured",
    detail: process.env.SELLBRITE_ACCOUNT_TOKEN ? "Credentials configured" : "Add credentials to .env",
  });

  // SKU Database — internal Prisma table since the 2026-05-12 Google Sheets
  // migration. Always "connected" as long as the app's DB is reachable;
  // dedicated /api/sku endpoint covers actual data reads.
  integrations.push({
    name: "SKU Database",
    status: "connected",
    detail: "Internal DB (migrated from Google Sheets 2026-05-12)",
  });

  // Google Drive
  const drive = getDriveStatus();
  integrations.push({
    name: "Google Drive",
    status: drive.configured ? "connected" : "not_configured",
    detail: drive.configured
      ? "Labels folder and service account configured"
      : drive.reason ?? "Add Google Drive env vars",
  });

  // Telegram
  integrations.push({
    name: "Telegram Bot",
    status: process.env.TELEGRAM_BOT_TOKEN ? "connected" : "not_configured",
    detail: process.env.TELEGRAM_BOT_TOKEN ? "Notifications active" : "Add TELEGRAM_BOT_TOKEN to .env",
  });

  // Claude AI
  integrations.push({
    name: "Claude AI",
    status: process.env.ANTHROPIC_API_KEY ? "connected" : "not_configured",
    detail: process.env.ANTHROPIC_API_KEY ? "CS Analysis active" : "Add ANTHROPIC_API_KEY to .env",
  });

  // Walmart — scan up to 5 store slots, list the configured ones.
  const walmartConfigured: string[] = [];
  for (let i = 1; i <= 5; i++) {
    const s = getWalmartStoreStatus(i);
    if (s.configured) walmartConfigured.push(s.storeName);
  }
  integrations.push({
    name: "Walmart API",
    status: walmartConfigured.length > 0 ? "connected" : "not_configured",
    detail:
      walmartConfigured.length > 0
        ? `${walmartConfigured.length} store(s): ${walmartConfigured.join(", ")}`
        : "Add WALMART_CLIENT_ID_STORE{n}, WALMART_CLIENT_SECRET_STORE{n}, WALMART_STORE{n}_SELLER_ID to .env",
  });

  return NextResponse.json({ integrations });
}
