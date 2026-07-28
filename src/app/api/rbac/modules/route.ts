/**
 * GET /api/rbac/modules — the list of grantable modules (key + label) the
 * Roles UI renders as permission checkboxes. Admin only.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-server";
import { GRANTABLE_MODULES } from "@/lib/rbac/modules";

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  return NextResponse.json({
    items: GRANTABLE_MODULES.map((m) => ({ key: m.key, label: m.label })),
  });
}
