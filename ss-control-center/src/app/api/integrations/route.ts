import { NextResponse } from "next/server";
import { getStoreCredentials } from "@/lib/amazon-sp-api/auth";
import { getWalmartStoreStatus } from "@/lib/walmart";

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

  // Google Sheets
  integrations.push({
    name: "Google Sheets",
    // Google Sheets read access requires BOTH the sheet ID and an API key —
    // the lib/google-sheets.ts loader throws without GOOGLE_SHEETS_API_KEY.
    status:
      process.env.GOOGLE_SHEETS_ID && process.env.GOOGLE_SHEETS_API_KEY
        ? "connected"
        : "not_configured",
    detail:
      process.env.GOOGLE_SHEETS_ID && process.env.GOOGLE_SHEETS_API_KEY
        ? "SKU Database connected"
        : !process.env.GOOGLE_SHEETS_ID
          ? "Add GOOGLE_SHEETS_ID to .env"
          : "Add GOOGLE_SHEETS_API_KEY to .env (sheet ID set, key missing)",
  });

  // Google Drive
  integrations.push({
    name: "Google Drive",
    status: process.env.GOOGLE_DRIVE_ROOT_FOLDER ? "connected" : "not_configured",
    detail: process.env.GOOGLE_DRIVE_ROOT_FOLDER ? "Labels folder configured" : "Add GOOGLE_DRIVE_ROOT_FOLDER to .env",
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
