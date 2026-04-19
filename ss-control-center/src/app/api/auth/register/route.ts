/**
 * Self-serve registration is disabled. New users join only via an Invite
 * issued by an existing admin (see /api/admin/invites and
 * /api/auth/invite/[token]).
 *
 * GET reports `enabled: false` so the login page can hide the Sign Up tab.
 * POST is intentionally rejected; the endpoint is kept so external callers
 * get a clear error instead of a 404.
 */

import { NextResponse } from "next/server";

export function GET() {
  return NextResponse.json({
    enabled: false,
    reason: "Registration is invite-only. Ask an admin to send you an invite.",
  });
}

export function POST() {
  return NextResponse.json(
    {
      error:
        "Self-serve registration is disabled. Ask an admin to send you an invite.",
    },
    { status: 403 }
  );
}
