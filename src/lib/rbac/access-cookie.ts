/**
 * Signed "access" cookie — a compact, tamper-proof snapshot of the user's
 * RBAC context (role + granted modules) that the Edge `proxy.ts` can read
 * WITHOUT a database round-trip.
 *
 * Format:  `${base64url(JSON payload)}.${sha256hex(payload + NEXTAUTH_SECRET)}`
 *
 * The signature uses the same `sha256(value + secret)` scheme as the session
 * token (src/lib/auth.ts) so the proxy can re-verify it with Web Crypto.
 *
 * This is an OPTIMISTIC gate only (per Next's guidance — proxy shouldn't be
 * the sole authorization layer). It can go stale for up to one navigation
 * after an admin edits a role; the authoritative checks are the per-route
 * `requireModuleAccess` server guard and the client AccessGuard, both of
 * which read fresh state from the DB / `/api/auth/me`. The cookie is
 * refreshed on every `/api/auth/me` call, so it self-heals quickly.
 */

import { createHash } from "crypto";

export const ACCESS_COOKIE = "sscc-access";
export const ACCESS_COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // seconds (matches session)

export interface AccessCookiePayload {
  /** user id */
  u: string;
  /** role key */
  r: string;
  /** granted module keys */
  m: string[];
}

function b64url(s: string): string {
  return Buffer.from(s, "utf8").toString("base64url");
}

/**
 * Build the signed cookie value, or `null` if signing isn't possible
 * (missing secret) — callers should simply skip setting the cookie then.
 */
export function buildAccessCookieValue(p: AccessCookiePayload): string | null {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) return null;
  const payload = b64url(JSON.stringify(p));
  const sig = createHash("sha256")
    .update(payload + secret)
    .digest("hex");
  return `${payload}.${sig}`;
}

/** Standard cookie options for setting the access cookie on a response. */
export const accessCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  maxAge: ACCESS_COOKIE_MAX_AGE,
};

/**
 * Verify + decode the signed access cookie, or `null` if it's absent or
 * tampered with. Used by the proxy (src/proxy.ts) to gate page navigations
 * without a DB lookup. Uses the same node-crypto SHA-256 scheme as the
 * session token so it runs in the same proxy environment as
 * `verifySessionToken`.
 */
export function parseAccessCookie(
  value: string | undefined
): { role: string; modules: string[] } | null {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret || !value) return null;
  const dot = value.lastIndexOf(".");
  if (dot === -1) return null;
  const payload = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const expected = createHash("sha256")
    .update(payload + secret)
    .digest("hex");
  if (expected !== sig) return null;
  try {
    const obj = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const role = typeof obj.r === "string" ? obj.r : "";
    const modules = Array.isArray(obj.m)
      ? obj.m.filter((x: unknown): x is string => typeof x === "string")
      : [];
    if (!role) return null;
    return { role, modules };
  } catch {
    return null;
  }
}
