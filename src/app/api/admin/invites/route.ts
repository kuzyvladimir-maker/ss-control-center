/**
 * GET  /api/admin/invites             — list pending + accepted invites (admin)
 * POST /api/admin/invites             — create a new invite (admin)
 *   body: { email: string, role?: "admin" | "member", expiresInDays?: number }
 *
 * The created invite returns the full URL the recipient must visit to set
 * their password, and the POST tries to EMAIL that link to the recipient
 * through a connected Gmail account (the inviting admin's mailbox if it's
 * connected, otherwise the first connected mailbox). Email is best-effort:
 * the invite + link are always created and returned even if the send fails,
 * so the admin can still copy the link manually. The response carries
 * `emailSent` / `emailTo` / `emailError` so the UI can say which happened.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateInviteToken } from "@/lib/auth";
import { requireAdmin } from "@/lib/auth-server";
import {
  getConnectedGmailAccounts,
  getGmailAccountByEmail,
  sendGmailMessage,
} from "@/lib/gmail-api";

const DEFAULT_EXPIRY_DAYS = 7;

/**
 * Try to email the invite link to the recipient. Best-effort: returns a
 * result object instead of throwing, so a failed send never blocks invite
 * creation. Prefers the inviting admin's own connected mailbox (so the
 * message comes "from" them); falls back to the first connected Gmail
 * account. If no mailbox is connected, returns sent:false with a reason.
 */
async function sendInviteEmail(opts: {
  to: string;
  link: string;
  roleLabel: string;
  inviterName: string;
  adminEmail: string;
  expiresAt: Date;
}): Promise<{ sent: boolean; from?: string; error?: string }> {
  try {
    // Cheap path first (no Google call): the admin's stored mailbox.
    const byAdmin = opts.adminEmail.includes("@")
      ? await getGmailAccountByEmail(opts.adminEmail)
      : null;
    const sender = byAdmin ?? (await getConnectedGmailAccounts())[0] ?? null;
    if (!sender) {
      return { sent: false, error: "no Gmail account is connected" };
    }

    const expiryStr = opts.expiresAt.toLocaleDateString("ru-RU", {
      day: "2-digit",
      month: "long",
      year: "numeric",
    });
    const body = `Здравствуйте!

${opts.inviterName} приглашает вас в Salutem Command Center.
Роль: ${opts.roleLabel}.

Чтобы создать пароль и войти, перейдите по ссылке:
${opts.link}

Ссылка действительна до ${expiryStr}.
Если вы не ожидали это приглашение, просто проигнорируйте письмо.`;

    await sendGmailMessage(sender.refreshToken, {
      to: opts.to,
      subject: "Приглашение в Salutem Command Center",
      body,
      fromEmail: sender.email,
    });
    return { sent: true, from: sender.email };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Gmail send failed";
    // A 403 almost always means the connected token predates the gmail.send
    // scope — surface a clear hint so the admin knows how to fix it.
    const hint = /insufficient|scope|permission|403/i.test(msg)
      ? " — re-connect the mailbox in Settings → Gmail to grant send permission."
      : "";
    console.error("[invites] email send failed:", msg);
    return { sent: false, error: msg + hint };
  }
}

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

  // Accept any existing role key (admin or a custom/member role). Unknown or
  // missing → default to "member".
  let role = "member";
  if (body.role === "admin") {
    role = "admin";
  } else if (body.role) {
    const exists = await prisma.role.findUnique({
      where: { key: body.role },
      select: { key: true },
    });
    if (exists) role = body.role;
  }
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

  const link = inviteUrl(request, invite.token);

  // Human-readable role for the email ("Warehouse Worker", not
  // "warehuse-worker"). Falls back to the key if there's no Role row.
  const roleRow = await prisma.role
    .findUnique({ where: { key: role }, select: { name: true } })
    .catch(() => null);
  const roleLabel =
    roleRow?.name ?? (role === "admin" ? "Administrator" : role);

  // Best-effort email — never blocks the invite. The link is already created
  // above, so even an email failure leaves a usable copy-link in the UI.
  const emailResult = await sendInviteEmail({
    to: invite.email,
    link,
    roleLabel,
    inviterName: adminUser.displayName || adminUser.username,
    adminEmail: adminUser.username,
    expiresAt: invite.expiresAt,
  });

  return NextResponse.json({
    ok: true,
    id: invite.id,
    email: invite.email,
    role: invite.role,
    expiresAt: invite.expiresAt,
    link,
    emailSent: emailResult.sent,
    emailTo: emailResult.sent ? invite.email : null,
    emailFrom: emailResult.from ?? null,
    emailError: emailResult.error ?? null,
  });
}
