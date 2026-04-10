import { NextRequest, NextResponse } from "next/server";
import { exchangeCodeForTokens, getGmailProfile } from "@/lib/gmail-api";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  if (!code) {
    return NextResponse.redirect(
      new URL("/settings?gmail=error&reason=no_code", request.url)
    );
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    const refreshToken = tokens.refresh_token;
    if (!refreshToken) {
      return NextResponse.redirect(
        new URL(
          "/settings?gmail=error&reason=no_refresh_token",
          request.url
        )
      );
    }

    const email = await getGmailProfile(refreshToken);

    const params = new URLSearchParams({
      gmail: "success",
      email,
      token: refreshToken,
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
