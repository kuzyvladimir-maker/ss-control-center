/**
 * Server-side auth helpers for API routes.
 *
 * Reads the `sscc-session` cookie, validates the signature, and (when
 * needed) looks the user up in the DB so the route can act on
 * .role / .username / .id.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifySession } from "@/lib/auth";

export interface AuthedUser {
  id: string;
  username: string;
  displayName: string | null;
  role: string;
}

// Synthetic identity for requests authenticated with the SSCC_API_TOKEN.
// External clients (OpenClaw, automation, scripts) carry no DB user but
// must still pass `requireAuth` / `requireAdmin` checks to use admin-only
// endpoints. We give them admin-equivalent rights and a recognisable
// username so audit logs can distinguish them from real users.
const API_TOKEN_USER: AuthedUser = {
  id: "system:api-token",
  username: "api@sscc.system",
  displayName: "API Token (external)",
  role: "admin",
};

function isApiTokenRequest(request: NextRequest): boolean {
  const expected = process.env.SSCC_API_TOKEN;
  if (!expected) return false;
  const bearer = request.headers.get("Authorization")?.replace("Bearer ", "");
  return bearer === expected;
}

export async function getCurrentUser(
  request: NextRequest
): Promise<AuthedUser | null> {
  // External API clients (Bearer SSCC_API_TOKEN) get admin identity
  if (isApiTokenRequest(request)) return API_TOKEN_USER;

  const token = request.cookies.get("sscc-session")?.value;
  if (!token) return null;
  const session = verifySession(token);
  if (!session) return null;

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { id: true, username: true, displayName: true, role: true },
  });
  return user;
}

/**
 * Returns either an authed user or a NextResponse to send back. Use as:
 *
 *   const auth = await requireAdmin(request);
 *   if (auth instanceof NextResponse) return auth;
 *   const user = auth;
 */
export async function requireAdmin(
  request: NextRequest
): Promise<AuthedUser | NextResponse> {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  if (user.role !== "admin") {
    return NextResponse.json(
      { error: "Admin permission required" },
      { status: 403 }
    );
  }
  return user;
}

export async function requireAuth(
  request: NextRequest
): Promise<AuthedUser | NextResponse> {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  return user;
}
