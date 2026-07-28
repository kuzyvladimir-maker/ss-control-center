/**
 * POST /api/auth/logout — clear the session cookie.
 */

import { NextResponse } from "next/server";
import { ACCESS_COOKIE } from "@/lib/rbac/access-cookie";

export function POST() {
  const response = NextResponse.json({ ok: true });
  const clear = {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: 0,
  };
  response.cookies.set("sscc-session", "", clear);
  response.cookies.set(ACCESS_COOKIE, "", clear);
  return response;
}
