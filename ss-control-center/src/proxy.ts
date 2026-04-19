import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken } from "@/lib/auth";

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // ── 1. API key auth (Authorization: Bearer SSCC_API_TOKEN) ──────────
  // Accepted on ALL /api/* routes so external clients (OpenClaw agent,
  // automation scripts, etc.) can hit any endpoint with a single token.
  // The token grants admin-equivalent permissions — `getCurrentUser` in
  // src/lib/auth-server.ts synthesises a system admin identity for
  // role-gated routes.
  if (pathname.startsWith("/api/")) {
    const expectedToken = process.env.SSCC_API_TOKEN;
    const bearer = request.headers
      .get("Authorization")
      ?.replace("Bearer ", "");
    if (expectedToken && bearer === expectedToken) {
      return NextResponse.next();
    }
  }

  // Legacy /api/external — previously the only place that accepted the
  // Bearer token. Keep its hard 401 for back-compat (an unauthenticated
  // call must NOT fall through to the cookie check below).
  if (pathname.startsWith("/api/external")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (
    pathname === "/login" ||
    pathname === "/api/auth/login" ||
    pathname === "/api/auth/register"
  ) {
    return NextResponse.next();
  }

  // Public invite-accept routes
  if (
    pathname.startsWith("/invite/") ||
    pathname.startsWith("/api/auth/invite/")
  ) {
    return NextResponse.next();
  }

  // Vercel cron jobs bypass the session check; the route itself validates
  // the CRON_SECRET bearer token, so outside callers can't spoof it.
  if (pathname.startsWith("/api/cron/")) {
    return NextResponse.next();
  }

  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname.endsWith(".ico") ||
    pathname.endsWith(".png") ||
    pathname.endsWith(".svg")
  ) {
    return NextResponse.next();
  }

  const sessionToken = request.cookies.get("sscc-session")?.value;
  if (!sessionToken || !verifySessionToken(sessionToken)) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
