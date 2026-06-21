/**
 * Server-side auth helpers for API routes.
 *
 * Reads the `sscc-session` cookie, validates the signature, and (when
 * needed) looks the user up in the DB so the route can act on
 * .role / .username / .id.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { verifySession } from "@/lib/auth";
import { ADMIN_ROLE, canAccessModule, parseModules } from "@/lib/rbac/access";
import { GRANTABLE_MODULE_KEYS } from "@/lib/rbac/modules";
import {
  ACCESS_COOKIE,
  accessCookieOptions,
  buildAccessCookieValue,
} from "@/lib/rbac/access-cookie";

export interface AuthedUser {
  id: string;
  username: string;
  displayName: string | null;
  role: string;
}

/** AuthedUser plus the resolved RBAC context (which modules they may open). */
export interface AuthedUserWithAccess extends AuthedUser {
  /** True for the built-in `admin` role (sees everything). */
  isAdmin: boolean;
  /** Module keys this user may open. Admin → every grantable module. */
  modules: string[];
}

// Synthetic identity for requests authenticated with the SSCC_API_TOKEN.
// External clients (OpenClaw, automation, scripts) carry no DB user but
// must still pass `requireAuth` / `requireAdmin` checks to use admin-only
// endpoints. We give them admin-equivalent rights and a recognisable
// username so audit logs can distinguish them from real users.
const API_TOKEN_USER: AuthedUser = {
  id: "system:api-token",
  username: "api@sscc.system",
  displayName: "API Token (external)",
  role: "admin",
};

function isApiTokenRequest(request: NextRequest): boolean {
  const expected = process.env.SSCC_API_TOKEN;
  if (!expected) return false;
  const bearer = request.headers.get("Authorization")?.replace("Bearer ", "");
  return bearer === expected;
}

export async function getCurrentUser(
  request: NextRequest
): Promise<AuthedUser | null> {
  // External API clients (Bearer SSCC_API_TOKEN) get admin identity
  if (isApiTokenRequest(request)) return API_TOKEN_USER;

  const token = request.cookies.get("sscc-session")?.value;
  if (!token) return null;
  const session = verifySession(token);
  if (!session) return null;

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { id: true, username: true, displayName: true, role: true },
  });
  return user;
}

/**
 * Returns either an authed user or a NextResponse to send back. Use as:
 *
 *   const auth = await requireAdmin(request);
 *   if (auth instanceof NextResponse) return auth;
 *   const user = auth;
 */
export async function requireAdmin(
  request: NextRequest
): Promise<AuthedUser | NextResponse> {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  if (user.role !== "admin") {
    return NextResponse.json(
      { error: "Admin permission required" },
      { status: 403 }
    );
  }
  return user;
}

export async function requireAuth(
  request: NextRequest
): Promise<AuthedUser | NextResponse> {
  const user = await getCurrentUser(request);
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  return user;
}

/**
 * Like getCurrentUser, but also resolves the user's RBAC context — the set
 * of modules their role may open. Admin sees every grantable module; any
 * other role reads its `modules` list from the Role table (empty if the role
 * row is missing, e.g. it was deleted while a session was live).
 */
export async function getCurrentUserWithAccess(
  request: NextRequest
): Promise<AuthedUserWithAccess | null> {
  const user = await getCurrentUser(request);
  if (!user) return null;

  if (user.role === ADMIN_ROLE) {
    return { ...user, isAdmin: true, modules: GRANTABLE_MODULE_KEYS };
  }

  const role = await prisma.role.findUnique({
    where: { key: user.role },
    select: { modules: true },
  });
  return {
    ...user,
    isAdmin: false,
    modules: role ? parseModules(role.modules) : [],
  };
}

/** Resolve the module keys a role key may open (admin → all grantable). */
export async function resolveModulesForRole(role: string): Promise<string[]> {
  if (role === ADMIN_ROLE) return GRANTABLE_MODULE_KEYS;
  const row = await prisma.role.findUnique({
    where: { key: role },
    select: { modules: true },
  });
  return row ? parseModules(row.modules) : [];
}

/**
 * Stamp the signed `sscc-access` cookie onto a response so the Edge proxy can
 * gate routes without a DB lookup. Call this anywhere a session is (re)issued
 * — login and invite-accept — so the gate is correct on the very first
 * navigation. `/api/auth/me` refreshes it thereafter.
 */
export async function attachAccessCookie(
  response: NextResponse,
  user: { id: string; role: string }
): Promise<void> {
  const modules = await resolveModulesForRole(user.role);
  const value = buildAccessCookieValue({ u: user.id, r: user.role, m: modules });
  if (value) response.cookies.set(ACCESS_COOKIE, value, accessCookieOptions);
}

/**
 * Guard an endpoint behind a specific module permission. Use as:
 *
 *   const auth = await requireModuleAccess(request, "finance");
 *   if (auth instanceof NextResponse) return auth;
 *   const user = auth; // has .modules / .isAdmin
 *
 * Returns 401 when not signed in, 403 when the role lacks the module.
 */
export async function requireModuleAccess(
  request: NextRequest,
  moduleKey: string
): Promise<AuthedUserWithAccess | NextResponse> {
  const user = await getCurrentUserWithAccess(request);
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  if (!canAccessModule({ role: user.role, modules: user.modules }, moduleKey)) {
    return NextResponse.json(
      { error: "Module access required" },
      { status: 403 }
    );
  }
  return user;
}
