/**
 * Create the initial admin user in the production Turso database.
 *
 * Usage:
 *   npx tsx scripts/create-admin.ts <username> [displayName]
 *
 * Writes directly via @libsql/client (bypasses Prisma so the script works
 * even when the generated Prisma client is stale on this machine). Reads
 * TURSO_DATABASE_URL + TURSO_AUTH_TOKEN from .env.
 *
 * The generated password is printed to stdout ONCE — copy it before closing
 * the terminal. Same hashing scheme as src/lib/auth.ts (SHA-256 + salt).
 */

import { createClient } from "@libsql/client";
import { randomBytes, createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

// Minimal .env loader to avoid pulling in dotenv as a build dependency.
function loadEnv() {
  const envPath = path.resolve(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) throw new Error(".env not found at " + envPath);
  const content = fs.readFileSync(envPath, "utf8");
  for (const line of content.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
    }
  }
}

// Same algorithm as src/lib/auth.ts → hashPassword.
function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = createHash("sha256").update(salt + password).digest("hex");
  return `${salt}:${hash}`;
}

function generatePassword(): string {
  // 16 chars, alpha+digits+specials, no quotes/backslashes/spaces.
  const alphabet =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789!@#$%^&*";
  const bytes = randomBytes(16);
  let out = "";
  for (let i = 0; i < 16; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

function generateCuid(): string {
  // Simple cuid-like id; the schema only needs it to be unique. Format
  // matches Prisma's default (length-25 alphanumeric).
  return "c" + Date.now().toString(36) + randomBytes(8).toString("hex");
}

async function main() {
  loadEnv();

  const username = (process.argv[2] || "").toLowerCase().trim();
  const displayName = process.argv[3] || username;

  if (!username) {
    console.error("Usage: npx tsx scripts/create-admin.ts <username> [displayName]");
    process.exit(1);
  }

  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) {
    throw new Error("TURSO_DATABASE_URL / TURSO_AUTH_TOKEN not set in .env");
  }

  const db = createClient({ url, authToken });

  const existing = await db.execute({
    sql: "SELECT id FROM User WHERE username = ?",
    args: [username],
  });
  if (existing.rows.length > 0) {
    console.error(
      `User '${username}' already exists. Use scripts/reset-password.ts to set a new password.`
    );
    process.exit(2);
  }

  const newPassword = generatePassword();
  const passwordHash = hashPassword(newPassword);
  const id = generateCuid();
  const now = new Date().toISOString();

  await db.execute({
    sql: "INSERT INTO User (id, username, passwordHash, displayName, createdAt) VALUES (?, ?, ?, ?, ?)",
    args: [id, username, passwordHash, displayName, now],
  });

  console.log("\n========== ADMIN CREATED ==========");
  console.log(`User:        ${username}`);
  console.log(`DisplayName: ${displayName}`);
  console.log(`Password:    ${newPassword}`);
  console.log("===================================");
  console.log("\n⚠️  Save this password now — it will not be shown again.");
  console.log("⚠️  Stored in production Turso. Sign in at https://salutemsolutions.info/login");
}

main().catch((e) => {
  console.error("❌ Failed:", e);
  process.exit(1);
});
