/**
 * GET /api/auth/me — current user (or 401 when not signed in).
 * Used by client UIs to render conditional admin controls.
 */

import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth-server";

export async function GET(request: NextRequest) {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  return NextResponse.json({ user });
}
