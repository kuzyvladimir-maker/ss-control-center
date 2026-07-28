import { createHash, randomBytes, timingSafeEqual } from "crypto";

// --- Session tokens ---
// Format: "sscc:{userId}:{issuedAtMs}:{nonceHex}:{hmacHex}"
// The signature covers everything before the last colon.

const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface SessionPayload {
  userId: string;
  issuedAt: number;
}

export function createSessionToken(userId: string): string {
  const secret = process.env.NEXTAUTH_SECRET!;
  const payload = `sscc:${userId}:${Date.now()}:${randomBytes(8).toString("hex")}`;
  const hash = createHash("sha256")
    .update(payload + secret)
    .digest("hex");
  return `${payload}:${hash}`;
}

/**
 * Returns the validated payload (userId + issuedAt) if the token is good,
 * else null.
 */
export function verifySession(token: string): SessionPayload | null {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret || !token) return null;

  const lastColon = token.lastIndexOf(":");
  if (lastColon === -1) return null;

  const payload = token.slice(0, lastColon);
  const providedHash = token.slice(lastColon + 1);
  const parts = payload.split(":");

  if (parts.length !== 4 || parts[0] !== "sscc") return null;

  const userId = parts[1];
  const issuedAt = Number(parts[2]);
  if (!userId || !Number.isFinite(issuedAt)) return null;
  if (Date.now() - issuedAt > SESSION_MAX_AGE_MS) return null;

  const expectedHash = createHash("sha256")
    .update(payload + secret)
    .digest("hex");

  try {
    const ok = timingSafeEqual(
      Buffer.from(providedHash, "hex"),
      Buffer.from(expectedHash, "hex")
    );
    if (!ok) return null;
  } catch {
    return null;
  }

  return { userId, issuedAt };
}

/** Backwards-compatible boolean check for the proxy/middleware layer. */
export function verifySessionToken(token: string): boolean {
  return verifySession(token) !== null;
}

// --- Password hashing (SHA-256 + salt) ---

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = createHash("sha256")
    .update(salt + password)
    .digest("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, storedHash] = stored.split(":");
  if (!salt || !storedHash) return false;

  const hash = createHash("sha256")
    .update(salt + password)
    .digest("hex");

  try {
    return timingSafeEqual(
      Buffer.from(hash, "hex"),
      Buffer.from(storedHash, "hex")
    );
  } catch {
    return false;
  }
}

// --- Invite tokens (URL-safe, unguessable) ---

export function generateInviteToken(): string {
  return randomBytes(32).toString("base64url");
}
