import { NextRequest, NextResponse } from "next/server";
import { verifySessionToken } from "@/lib/auth";

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Protect /api/external/* with Bearer token (existing logic)
  if (pathname.startsWith("/api/external")) {
    const token = request.headers
      .get("Authorization")
      ?.replace("Bearer ", "");
    if (token !== process.env.SSCC_API_TOKEN) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.next();
  }

  // Allow login page and auth API without auth
  if (
    pathname === "/login" ||
    pathname === "/api/auth/login" ||
    pathname === "/api/auth/register"
  ) {
    return NextResponse.next();
  }

  // Allow static assets
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname.endsWith(".ico") ||
    pathname.endsWith(".png") ||
    pathname.endsWith(".svg")
  ) {
    return NextResponse.next();
  }

  // Check session cookie
  const sessionToken = request.cookies.get("sscc-session")?.value;
  if (!sessionToken || !verifySessionToken(sessionToken)) {
    // Redirect to login for pages, return 401 for API routes
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    // Match all paths except static files
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
