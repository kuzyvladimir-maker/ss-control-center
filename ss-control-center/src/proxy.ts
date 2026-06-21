import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken } from "@/lib/auth";
import { parseAccessCookie } from "@/lib/rbac/access-cookie";
import { canAccessPath } from "@/lib/rbac/access";

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // ── 1. API key auth (Authorization: Bearer SSCC_API_TOKEN) ──────────
  // Accepted on ALL /api/* routes so external clients (OpenClaw agent,
  // automation scripts, etc.) can hit any endpoint with a single token.
  // The token grants admin-equivalent permissions — `getCurrentUser` in
  // src/lib/auth-server.ts synthesises a system admin identity for
  // role-gated routes.
  if (pathname.startsWith("/api/")) {
    const sscToken = process.env.SSCC_API_TOKEN;
    const jackieToken = process.env.JACKIE_API_TOKEN;
    const bearer = request.headers
      .get("Authorization")
      ?.replace("Bearer ", "");
    if (bearer && (
      (sscToken && bearer === sscToken) ||
      (jackieToken && bearer === jackieToken)
    )) {
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

  // Temporary debug endpoints (read-only Veeqo introspection) — public
  // while we trace the procurement <-> Veeqo tag-sync issue. Will be
  // removed once verified.
  if (pathname.startsWith("/api/debug/")) {
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

  // ── 2. Session gate ────────────────────────────────────────────────
  // No valid session ⇒ 401 for APIs, redirect to /login for pages. This is
  // what makes the Control Center invite-only: accounts only come from
  // invite links, and nothing is reachable without one.
  const sessionToken = request.cookies.get("sscc-session")?.value;
  if (!sessionToken || !verifySessionToken(sessionToken)) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // ── 3. RBAC module gate (pages only, optimistic) ───────────────────
  // The user is authenticated. For page navigations, redirect to
  // /no-access if their role (read from the signed `sscc-access` cookie,
  // set at login and refreshed by /api/auth/me) can't open this module.
  //
  // Scoped to pages: per-module API authorization is enforced on the
  // server via requireModuleAccess so machine clients (token auth above)
  // and crons aren't affected. The cookie may lag a role edit by one
  // navigation; the server guard + client AccessGuard are authoritative.
  if (!pathname.startsWith("/api/") && pathname !== "/no-access") {
    const access = parseAccessCookie(request.cookies.get("sscc-access")?.value);
    if (access && !canAccessPath(access, pathname)) {
      const url = request.nextUrl.clone();
      url.pathname = "/no-access";
      url.search = `from=${encodeURIComponent(pathname)}`;
      return NextResponse.redirect(url);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
