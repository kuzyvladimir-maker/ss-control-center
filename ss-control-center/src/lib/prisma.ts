import { PrismaClient } from "@/generated/prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { resolve } from "path";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient;
  prismaPool?: PrismaClient[];
};

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

// ── Why a pool (2026-10-26) ────────────────────────────────────────────────
// @prisma/adapter-libsql runs EVERY query of a client through one mutex
// (performIO / transactions acquire the same lock). On Vercel one function
// instance serves many requests at once, so with a single client every query
// of every request queued behind every other: a 40 ms "SELECT stores" waited
// 39 s behind the 7 s SKU-table pull and the plan's per-order queries, and
// /shipping hit the 300 s function limit. Several clients = several locks, so
// independent requests stop waiting on each other.
//
// The client is chosen once per SYNCHRONOUS slice of code (rotated on the next
// microtask), not per property access. That keeps array transactions atomic —
// `prisma.$transaction([prisma.a.update(…), prisma.b.create(…)])` is built in
// one slice, so every element lands on the same client (verified: all array
// transactions in src/ build their array inline). Interactive transactions use
// their `tx` and are unaffected.
const POOL_SIZE = Math.max(
  1,
  Math.min(8, Number(process.env.PRISMA_POOL_SIZE) || 4),
);

if (!globalForPrisma.prismaPool) {
  globalForPrisma.prismaPool = Array.from({ length: POOL_SIZE }, () =>
    createPrismaClient(),
  );
}
const pool = globalForPrisma.prismaPool;
let rr = 0;
let current: PrismaClient | null = null;

function clientForThisSlice(): PrismaClient {
  if (!current) {
    current = pool[rr++ % pool.length];
    queueMicrotask(() => {
      current = null;
    });
  }
  return current;
}

if (!globalForPrisma.prisma) {
  globalForPrisma.prisma = new Proxy(pool[0], {
    get(_target, prop) {
      const client = clientForThisSlice();
      const value = Reflect.get(client, prop, client);
      return typeof value === "function" ? value.bind(client) : value;
    },
  }) as PrismaClient;
}

export const prisma = globalForPrisma.prisma;
