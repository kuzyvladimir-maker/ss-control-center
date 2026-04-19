/**
 * GET /api/admin/users — list all users (admin only).
 * Used by the Settings → Users page to render the existing accounts.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-server";

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const users = await prisma.user.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      username: true,
      displayName: true,
      role: true,
      createdAt: true,
    },
  });

  return NextResponse.json({ items: users });
}
