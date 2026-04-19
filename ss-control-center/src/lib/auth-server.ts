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

export async function getCurrentUser(
  request: NextRequest
): Promise<AuthedUser | null> {
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
