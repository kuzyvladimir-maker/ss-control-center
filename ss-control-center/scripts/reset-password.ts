/**
 * Reset the password of an existing Control Center user.
 *
 * Usage:
 *   npx tsx scripts/reset-password.ts <username> [newPassword]
 *
 * If newPassword is omitted, a random 16-char one is generated and
 * printed to stdout ONCE.
 *
 * Writes directly to Turso via @libsql/client — works regardless of
 * generated Prisma client state. Reads TURSO_DATABASE_URL +
 * TURSO_AUTH_TOKEN from .env.
 */

import { createClient } from "@libsql/client";
import { randomBytes, createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

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

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = createHash("sha256").update(salt + password).digest("hex");
  return `${salt}:${hash}`;
}

function generatePassword(): string {
  const alphabet =
    "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const bytes = randomBytes(16);
  let out = "";
  for (let i = 0; i < 16; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

async function main() {
  loadEnv();

  const username = (process.argv[2] || "").toLowerCase().trim();
  const explicitPassword = process.argv[3];

  if (!username) {
    console.error("Usage: npx tsx scripts/reset-password.ts <username> [newPassword]");
    process.exit(1);
  }

  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) {
    throw new Error("TURSO_DATABASE_URL / TURSO_AUTH_TOKEN not set in .env");
  }

  const db = createClient({ url, authToken });

  const existing = await db.execute({
    sql: "SELECT id, username FROM User WHERE username = ?",
    args: [username],
  });
  if (existing.rows.length === 0) {
    console.error(`User '${username}' not found. Existing users:`);
    const all = await db.execute("SELECT username FROM User");
    for (const r of all.rows) console.error(`  - ${r.username}`);
    process.exit(2);
  }

  const newPassword = explicitPassword || generatePassword();
  const newHash = hashPassword(newPassword);

  await db.execute({
    sql: "UPDATE User SET passwordHash = ? WHERE username = ?",
    args: [newHash, username],
  });

  console.log("\n========== PASSWORD RESET ==========");
  console.log(`User:     ${username}`);
  console.log(`Password: ${newPassword}`);
  console.log("====================================");
  console.log("\n⚠️  Sign in at https://salutemsolutions.info/login");
}

main().catch((e) => {
  console.error("❌ Failed:", e);
  process.exit(1);
});
