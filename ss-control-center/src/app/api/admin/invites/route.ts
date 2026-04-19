/**
 * GET  /api/admin/invites             — list pending + accepted invites (admin)
 * POST /api/admin/invites             — create a new invite (admin)
 *   body: { email: string, role?: "admin" | "member", expiresInDays?: number }
 *
 * The created invite returns the full URL the recipient must visit to set
 * their password. Email delivery isn't wired yet — for now the admin
 * copy-pastes the link out of the response (or out of the Settings UI).
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateInviteToken } from "@/lib/auth";
import { requireAdmin } from "@/lib/auth-server";

const DEFAULT_EXPIRY_DAYS = 7;

function inviteUrl(request: NextRequest, token: string): string {
  // Honour the forwarded host/proto on Vercel so the link points at the
  // public hostname (salutemsolutions.info), not the Vercel preview URL.
  const proto =
    request.headers.get("x-forwarded-proto") ||
    new URL(request.url).protocol.replace(":", "") ||
    "https";
  const host =
    request.headers.get("x-forwarded-host") ||
    request.headers.get("host") ||
    "salutemsolutions.info";
  return `${proto}://${host}/invite/${token}`;
}

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;

  const invites = await prisma.invite.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  const items = invites.map((i) => ({
    id: i.id,
    email: i.email,
    role: i.role,
    createdAt: i.createdAt,
    expiresAt: i.expiresAt,
    acceptedAt: i.acceptedAt,
    revokedAt: i.revokedAt,
    status: i.acceptedAt
      ? "accepted"
      : i.revokedAt
        ? "revoked"
        : i.expiresAt < new Date()
          ? "expired"
          : "pending",
    link: inviteUrl(request, i.token),
  }));

  return NextResponse.json({ items });
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (auth instanceof NextResponse) return auth;
  const adminUser = auth;

  let body: { email?: string; role?: string; expiresInDays?: number } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const email = body.email?.toLowerCase().trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Valid email required" }, { status: 400 });
  }

  const role = body.role === "admin" ? "admin" : "member";
  const days = Math.max(1, Math.min(30, body.expiresInDays ?? DEFAULT_EXPIRY_DAYS));

  // Reject if a user with this email/username already exists
  const existingUser = await prisma.user.findUnique({ where: { username: email } });
  if (existingUser) {
    return NextResponse.json(
      { error: `User '${email}' already exists` },
      { status: 409 }
    );
  }

  // Revoke any prior pending invites for this email so there's only ever
  // one active link.
  await prisma.invite.updateMany({
    where: {
      email,
      acceptedAt: null,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    data: { revokedAt: new Date() },
  });

  const invite = await prisma.invite.create({
    data: {
      email,
      token: generateInviteToken(),
      role,
      createdById: adminUser.id,
      expiresAt: new Date(Date.now() + days * 86400 * 1000),
    },
  });

  return NextResponse.json({
    ok: true,
    id: invite.id,
    email: invite.email,
    role: invite.role,
    expiresAt: invite.expiresAt,
    link: inviteUrl(request, invite.token),
  });
}
