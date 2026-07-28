import { NextRequest, NextResponse } from "next/server";
import { getAuthUrl, MAX_GMAIL_STORES } from "@/lib/gmail-api";

// GET /api/auth/gmail?store=N
// Redirects the browser to Google's consent screen. The store index is
// carried through OAuth via the `state` param and recovered in the callback,
// so a single app registration can connect multiple Gmail accounts under
// different store slots.
export async function GET(request: NextRequest) {
  const storeParam = request.nextUrl.searchParams.get("store") || "1";
  const storeIndex = parseInt(storeParam, 10);

  if (
    !Number.isFinite(storeIndex) ||
    storeIndex < 1 ||
    storeIndex > MAX_GMAIL_STORES
  ) {
    return NextResponse.redirect(
      new URL(
        `/settings?gmail=error&reason=${encodeURIComponent(
          `Invalid store index "${storeParam}" (must be 1–${MAX_GMAIL_STORES})`
        )}`,
        request.url
      )
    );
  }

  try {
    const url = getAuthUrl(`store=${storeIndex}`);
    return NextResponse.redirect(url);
  } catch (error) {
    return NextResponse.redirect(
      new URL(
        `/settings?gmail=error&reason=${encodeURIComponent(
          error instanceof Error ? error.message : "OAuth not configured"
        )}`,
        request.url
      )
    );
  }
}
