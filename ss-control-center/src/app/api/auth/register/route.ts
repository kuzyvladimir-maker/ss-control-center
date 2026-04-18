import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hashPassword, createSessionToken } from "@/lib/auth";

async function isRegistrationEnabled() {
  if (process.env.SSCC_ALLOW_REGISTRATION === "true") {
    return true;
  }

  const userCount = await prisma.user.count();
  return userCount === 0;
}

export async function GET() {
  const enabled = await isRegistrationEnabled();
  return NextResponse.json({
    enabled,
    reason: enabled
      ? null
      : "Registration is disabled after the initial bootstrap user is created.",
  });
}

export async function POST(request: NextRequest) {
  if (!(await isRegistrationEnabled())) {
    return NextResponse.json(
      {
        error:
          "Registration is disabled. Sign in with an existing account or re-enable it via SSCC_ALLOW_REGISTRATION=true.",
      },
      { status: 403 }
    );
  }

  const { username, password, displayName } = await request.json();

  if (!username || !password) {
    return NextResponse.json(
      { error: "Username and password are required" },
      { status: 400 }
    );
  }

  if (password.length < 6) {
    return NextResponse.json(
      { error: "Password must be at least 6 characters" },
      { status: 400 }
    );
  }

  const normalizedUsername = username.toLowerCase().trim();

  // Check if user already exists
  const existing = await prisma.user.findUnique({
    where: { username: normalizedUsername },
  });

  if (existing) {
    return NextResponse.json(
      { error: "Username already taken" },
      { status: 409 }
    );
  }

  // Create user
  const user = await prisma.user.create({
    data: {
      username: normalizedUsername,
      passwordHash: hashPassword(password),
      displayName: displayName || username,
    },
  });

  // Auto-login after registration
  const token = createSessionToken();
  const response = NextResponse.json({
    ok: true,
    user: { username: user.username, displayName: user.displayName },
  });

  response.cookies.set("sscc-session", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });

  return response;
}
