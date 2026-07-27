import { NextRequest, NextResponse } from "next/server";
import {
  exchangeCodeForTokens,
  getGmailProfile,
  saveGmailAccount,
  MAX_GMAIL_STORES,
} from "@/lib/gmail-api";

// GET /api/auth/gmail/callback?code=...&state=store=N
// Exchanges the OAuth code for a refresh token, fetches the Gmail profile
// email, and stores both in the Setting table under the requested store
// index. No .env editing or server restart needed.
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state") || "";

  if (!code) {
    return NextResponse.redirect(
      new URL("/settings?gmail=error&reason=no_code", request.url)
    );
  }

  // Recover the store index from `state` — format is "store=N".
  const storeMatch = state.match(/store=(\d+)/);
  const storeIndex = storeMatch ? parseInt(storeMatch[1], 10) : 1;
  if (
    !Number.isFinite(storeIndex) ||
    storeIndex < 1 ||
    storeIndex > MAX_GMAIL_STORES
  ) {
    return NextResponse.redirect(
      new URL(
        `/settings?gmail=error&reason=${encodeURIComponent(
          "Invalid store index in OAuth state"
        )}`,
        request.url
      )
    );
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    const refreshToken = tokens.refresh_token;
    if (!refreshToken) {
      // Google only issues a refresh token on the first consent. If the user
      // already granted access, revoke it in Google Account → Security →
      // Third-party access, then try again (our auth URL uses prompt=consent
      // to minimise this, but it can still happen).
      return NextResponse.redirect(
        new URL(
          "/settings?gmail=error&reason=no_refresh_token",
          request.url
        )
      );
    }

    const email = await getGmailProfile(refreshToken);
    await saveGmailAccount(storeIndex, refreshToken, email);

    const params = new URLSearchParams({
      gmail: "success",
      email,
      store: String(storeIndex),
    });
    return NextResponse.redirect(
      new URL(`/settings?${params.toString()}`, request.url)
    );
  } catch (error) {
    return NextResponse.redirect(
      new URL(
        `/settings?gmail=error&reason=${encodeURIComponent(
          error instanceof Error ? error.message : "OAuth failed"
        )}`,
        request.url
      )
    );
  }
}
