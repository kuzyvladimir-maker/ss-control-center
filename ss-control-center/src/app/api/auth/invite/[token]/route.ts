/**
 * GET  /api/auth/invite/{token}      — validate an invite (used by /invite/{token} page)
 * POST /api/auth/invite/{token}      — accept invite + set password
 *   body: { password: string, displayName?: string }
 *
 * Both endpoints are public (no session required) — they are the entry
 * point for new users. They are rate-limit-free for now; the random
 * 32-byte token is unguessable so brute force isn't a real risk.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createSessionToken, hashPassword } from "@/lib/auth";

async function findValidInvite(token: string) {
  const invite = await prisma.invite.findUnique({ where: { token } });
  if (!invite) return { invite: null, error: "Invite not found" };
  if (invite.acceptedAt) return { invite, error: "Invite already used" };
  if (invite.revokedAt) return { invite, error: "Invite was revoked" };
  if (invite.expiresAt < new Date()) {
    return { invite, error: "Invite has expired" };
  }
  return { invite, error: null };
}

export async function GET(
  _request: NextRequest,
  ctx: { params: Promise<{ token: string }> }
) {
  const { token } = await ctx.params;
  const { invite, error } = await findValidInvite(token);
  if (error || !invite) {
    return NextResponse.json(
      { ok: false, error: error || "Invalid invite" },
      { status: 404 }
    );
  }
  return NextResponse.json({
    ok: true,
    email: invite.email,
    role: invite.role,
    expiresAt: invite.expiresAt,
  });
}

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ token: string }> }
) {
  const { token } = await ctx.params;

  let body: { password?: string; displayName?: string } = {};
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const password = body.password ?? "";
  const displayName = body.displayName?.trim() || undefined;

  if (password.length < 8) {
    return NextResponse.json(
      { error: "Password must be at least 8 characters" },
      { status: 400 }
    );
  }

  const { invite, error } = await findValidInvite(token);
  if (error || !invite) {
    return NextResponse.json(
      { error: error || "Invalid invite" },
      { status: 400 }
    );
  }

  // Make sure no one created an account with this email between issue and accept
  const existing = await prisma.user.findUnique({
    where: { username: invite.email },
  });
  if (existing) {
    return NextResponse.json(
      { error: "An account with this email already exists" },
      { status: 409 }
    );
  }

  const user = await prisma.user.create({
    data: {
      username: invite.email,
      passwordHash: hashPassword(password),
      displayName: displayName || invite.email,
      role: invite.role,
    },
  });

  await prisma.invite.update({
    where: { id: invite.id },
    data: { acceptedAt: new Date(), acceptedByUserId: user.id },
  });

  // Auto-login: set the same session cookie /api/auth/login would.
  const sessionToken = createSessionToken(user.id);
  const response = NextResponse.json({
    ok: true,
    user: {
      username: user.username,
      displayName: user.displayName,
      role: user.role,
    },
  });
  response.cookies.set("sscc-session", sessionToken, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return response;
}
