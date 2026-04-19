/**
 * DELETE /api/admin/invites/{id} — revoke a pending invite (admin only).
 *
 * We don't hard-delete; just set revokedAt. The token then fails the
 * /api/auth/invite/{token} check.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-server";

export async function DELETE(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;
  const { id } = await ctx.params;

  const invite = await prisma.invite.findUnique({ where: { id } });
  if (!invite) {
    return NextResponse.json({ error: "Invite not found" }, { status: 404 });
  }
  if (invite.acceptedAt) {
    return NextResponse.json(
      { error: "Invite already accepted; cannot revoke" },
      { status: 409 }
    );
  }

  await prisma.invite.update({
    where: { id },
    data: { revokedAt: new Date() },
  });

  return NextResponse.json({ ok: true });
}
