import { NextRequest, NextResponse } from "next/server";

export function middleware(request: NextRequest) {
  // Protect /api/external/* routes with Bearer token
  if (request.nextUrl.pathname.startsWith("/api/external")) {
    const token = request.headers
      .get("Authorization")
      ?.replace("Bearer ", "");
    if (token !== process.env.SSCC_API_TOKEN) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }
  return NextResponse.next();
}

export const config = {
  matcher: "/api/external/:path*",
};
