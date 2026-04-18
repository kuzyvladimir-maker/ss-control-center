import { createHash, randomBytes, timingSafeEqual } from "crypto";

// --- Session tokens ---

const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function createSessionToken(): string {
  const secret = process.env.NEXTAUTH_SECRET!;
  const payload = `sscc:${Date.now()}:${randomBytes(8).toString("hex")}`;
  const hash = createHash("sha256")
    .update(payload + secret)
    .digest("hex");
  return `${payload}:${hash}`;
}

export function verifySessionToken(token: string): boolean {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret || !token) return false;

  const lastColon = token.lastIndexOf(":");
  if (lastColon === -1) return false;

  const payload = token.slice(0, lastColon);
  const providedHash = token.slice(lastColon + 1);
  const payloadParts = payload.split(":");
  const issuedAt = Number(payloadParts[1]);

  if (
    payloadParts.length !== 3 ||
    payloadParts[0] !== "sscc" ||
    !Number.isFinite(issuedAt)
  ) {
    return false;
  }

  if (Date.now() - issuedAt > SESSION_MAX_AGE_MS) {
    return false;
  }

  const expectedHash = createHash("sha256")
    .update(payload + secret)
    .digest("hex");

  // Timing-safe comparison to prevent timing attacks
  try {
    return timingSafeEqual(
      Buffer.from(providedHash, "hex"),
      Buffer.from(expectedHash, "hex")
    );
  } catch {
    return false;
  }
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
