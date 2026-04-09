import { NextResponse } from "next/server";
import { getStoreCredentials } from "@/lib/amazon-sp-api/auth";

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
    status: process.env.GOOGLE_SHEETS_ID ? "connected" : "not_configured",
    detail: process.env.GOOGLE_SHEETS_ID ? "SKU Database connected" : "Add GOOGLE_SHEETS_ID to .env",
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

  // Walmart
  integrations.push({
    name: "Walmart API",
    status: "not_configured",
    detail: "Not configured yet",
  });

  return NextResponse.json({ integrations });
}
