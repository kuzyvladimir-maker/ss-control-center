import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { hashPassword, createSessionToken } from "@/lib/auth";

export async function POST(request: NextRequest) {
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
    secure: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });

  return response;
}
