/**
 * GET /api/auth/me — current user (or 401 when not signed in).
 *
 * Returns the user plus their resolved RBAC context (`modules` + `isAdmin`)
 * so client UIs can render the right nav and conditional controls. Also
 * refreshes the signed `sscc-access` cookie the Edge proxy reads, so
 * permission changes propagate within one navigation.
 */

import { NextRequest, NextResponse } from "next/server";
import { getCurrentUserWithAccess } from "@/lib/auth-server";
import {
  ACCESS_COOKIE,
  accessCookieOptions,
  buildAccessCookieValue,
} from "@/lib/rbac/access-cookie";

export async function GET(request: NextRequest) {
  const user = await getCurrentUserWithAccess(request);
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const res = NextResponse.json({ user });

  const value = buildAccessCookieValue({
    u: user.id,
    r: user.role,
    m: user.modules,
  });
  if (value) {
    res.cookies.set(ACCESS_COOKIE, value, accessCookieOptions);
  }

  return res;
}
