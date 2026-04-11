import { NextRequest, NextResponse } from "next/server";
import {
  isGmailOauthConfigured,
  listGmailAccountStatus,
  deleteGmailAccount,
  MAX_GMAIL_STORES,
} from "@/lib/gmail-api";

// GET /api/integrations/gmail
// Returns the per-store Gmail connection status, plus whether the OAuth
// client credentials themselves are configured. The Settings UI uses this
// to render per-store Connect/Disconnect buttons.
export async function GET() {
  try {
    const oauthConfigured = isGmailOauthConfigured();
    const accounts = await listGmailAccountStatus();
    return NextResponse.json({ oauthConfigured, accounts });
  } catch (err) {
    console.error("[integrations/gmail] GET failed:", err);
    return NextResponse.json(
      { error: "Failed to load Gmail status" },
      { status: 500 }
    );
  }
}

// DELETE /api/integrations/gmail?store=N
// Removes a stored Gmail refresh token for the given store. Use this to
// disconnect before reconnecting with a different account.
export async function DELETE(request: NextRequest) {
  try {
    const storeParam = request.nextUrl.searchParams.get("store");
    const storeIndex = parseInt(storeParam || "", 10);
    if (
      !Number.isFinite(storeIndex) ||
      storeIndex < 1 ||
      storeIndex > MAX_GMAIL_STORES
    ) {
      return NextResponse.json(
        { error: "Invalid store index" },
        { status: 400 }
      );
    }
    await deleteGmailAccount(storeIndex);
    return NextResponse.json({ disconnected: true, storeIndex });
  } catch (err) {
    console.error("[integrations/gmail] DELETE failed:", err);
    return NextResponse.json(
      { error: "Failed to disconnect" },
      { status: 500 }
    );
  }
}
