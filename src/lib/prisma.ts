import { PrismaClient } from "@/generated/prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { resolve } from "path";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

// Some deploy platforms (incl. Vercel) return env values wrapped in literal
// quote characters in certain runtime paths. Strip wrapping quotes/whitespace
// before handing URLs to `new URL()` inside the libsql adapter.
function cleanEnv(value: string | undefined): string | undefined {
  if (!value) return value;
  return value.trim().replace(/^['"]|['"]$/g, "");
}

function createPrismaClient() {
  // Production (Vercel/Turso): use remote libsql URL + auth token
  // Otherwise prefer DATABASE_URL so runtime and Prisma CLI point to the
  // same database in development.
  const tursoUrl = cleanEnv(process.env.TURSO_DATABASE_URL);
  const tursoToken = cleanEnv(process.env.TURSO_AUTH_TOKEN);
  const databaseUrl = cleanEnv(process.env.DATABASE_URL);

  if (tursoUrl && tursoToken) {
    const adapter = new PrismaLibSql({ url: tursoUrl, authToken: tursoToken });
    return new PrismaClient({ adapter });
  }

  if (databaseUrl) {
    const adapter = new PrismaLibSql({ url: databaseUrl });
    return new PrismaClient({ adapter });
  }

  const dbPath = resolve(process.cwd(), "dev.db");
  const adapter = new PrismaLibSql({ url: `file:${dbPath}` });
  return new PrismaClient({ adapter });
}

if (!globalForPrisma.prisma) {
  globalForPrisma.prisma = createPrismaClient();
}

export const prisma = globalForPrisma.prisma;
