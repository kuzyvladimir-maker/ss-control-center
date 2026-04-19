/**
 * PATCH  /api/admin/users/{id}  body: { role?: "admin" | "member" }
 * DELETE /api/admin/users/{id}                — remove a user
 *
 * Guard rails:
 *   - You cannot delete or demote yourself (avoid lock-out).
 *   - You cannot remove the last admin.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-server";

export async function PATCH(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;
  const { id } = await ctx.params;

  let body: { role?: string } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (body.role !== "admin" && body.role !== "member") {
    return NextResponse.json(
      { error: "role must be 'admin' or 'member'" },
      { status: 400 }
    );
  }

  if (id === auth.id && body.role !== auth.role) {
    return NextResponse.json(
      { error: "You cannot change your own role" },
      { status: 400 }
    );
  }

  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  if (target.role === "admin" && body.role === "member") {
    const remainingAdmins = await prisma.user.count({
      where: { role: "admin", id: { not: id } },
    });
    if (remainingAdmins === 0) {
      return NextResponse.json(
        { error: "Cannot demote the last remaining admin" },
        { status: 400 }
      );
    }
  }

  const updated = await prisma.user.update({
    where: { id },
    data: { role: body.role },
    select: { id: true, username: true, role: true },
  });
  return NextResponse.json({ ok: true, user: updated });
}

export async function DELETE(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;
  const { id } = await ctx.params;

  if (id === auth.id) {
    return NextResponse.json(
      { error: "You cannot delete your own account" },
      { status: 400 }
    );
  }

  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) {
    return NextResponse.json({ error: "User not found" }, { status: 404 });
  }

  if (target.role === "admin") {
    const remainingAdmins = await prisma.user.count({
      where: { role: "admin", id: { not: id } },
    });
    if (remainingAdmins === 0) {
      return NextResponse.json(
        { error: "Cannot delete the last remaining admin" },
        { status: 400 }
      );
    }
  }

  await prisma.user.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
