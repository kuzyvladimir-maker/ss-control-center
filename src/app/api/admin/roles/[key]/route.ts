/**
 * PATCH  /api/admin/roles/{key}   — update a role's name and/or modules (admin)
 *   body: { name?: string, modules?: string[] }
 * DELETE /api/admin/roles/{key}   — delete a custom role (admin)
 *
 * Guard rails:
 *   - System roles (admin/member) can't be renamed or deleted.
 *   - The `admin` role's module list is ignored (it sees everything) — we
 *     reject attempts to edit it to avoid confusion.
 *   - A role can't be deleted while users still hold it (reassign first).
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-server";
import { ADMIN_ROLE, parseModules } from "@/lib/rbac/access";
import { sanitizeModules } from "../route";

export async function PATCH(
  request: NextRequest,
  ctx: { params: Promise<{ key: string }> }
) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;
  const { key } = await ctx.params;

  const role = await prisma.role.findUnique({ where: { key } });
  if (!role) {
    return NextResponse.json({ error: "Role not found" }, { status: 404 });
  }
  if (key === ADMIN_ROLE) {
    return NextResponse.json(
      { error: "The admin role always has full access and can't be edited" },
      { status: 400 }
    );
  }

  let body: { name?: string; modules?: unknown } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const data: { name?: string; modules?: string } = {};

  if (body.name !== undefined) {
    if (role.isSystem) {
      return NextResponse.json(
        { error: "System roles can't be renamed" },
        { status: 400 }
      );
    }
    const name = body.name.trim();
    if (!name) {
      return NextResponse.json({ error: "Name can't be empty" }, { status: 400 });
    }
    data.name = name;
  }

  if (body.modules !== undefined) {
    data.modules = JSON.stringify(sanitizeModules(body.modules));
  }

  if (Object.keys(data).length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 });
  }

  const updated = await prisma.role.update({ where: { key }, data });
  return NextResponse.json({
    ok: true,
    role: {
      key: updated.key,
      name: updated.name,
      modules: parseModules(updated.modules),
      isSystem: updated.isSystem,
    },
  });
}

export async function DELETE(
  request: NextRequest,
  ctx: { params: Promise<{ key: string }> }
) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;
  const { key } = await ctx.params;

  const role = await prisma.role.findUnique({ where: { key } });
  if (!role) {
    return NextResponse.json({ error: "Role not found" }, { status: 404 });
  }
  if (role.isSystem) {
    return NextResponse.json(
      { error: "Built-in roles can't be deleted" },
      { status: 400 }
    );
  }

  const holders = await prisma.user.count({ where: { role: key } });
  if (holders > 0) {
    return NextResponse.json(
      {
        error: `${holders} user(s) still have this role. Reassign them before deleting.`,
      },
      { status: 409 }
    );
  }

  // Revoke any pending invites that would have assigned this now-deleted role.
  await prisma.invite.updateMany({
    where: { role: key, acceptedAt: null, revokedAt: null },
    data: { revokedAt: new Date() },
  });

  await prisma.role.delete({ where: { key } });
  return NextResponse.json({ ok: true });
}
