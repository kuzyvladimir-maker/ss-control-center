import { PrismaClient } from "@/generated/prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { resolve } from "path";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient;
  prismaPool?: PrismaClient[];
  prismaReports?: PrismaClient;
  prismaBulk?: PrismaClient;
};

// Some deploy platforms (incl. Vercel) return env values wrapped in literal
// quote characters in certain runtime paths. Strip wrapping quotes/whitespace
// before handing URLs to `new URL()` inside the libsql adapter.
function cleanEnv(value: string | undefined): string | undefined {
  if (!value) return value;
  return value.trim().replace(/^['"]|['"]$/g, "");
}

// ── Turso over HTTP with a hard timeout (2026-10-26) ───────────────────────
// A `libsql://` URL makes @libsql/client hold one long-lived WebSocket. On
// Vercel an instance is frozen between requests, the socket dies silently and
// the next query waits forever — while holding the adapter mutex (see the pool
// note below), so every later query on that client hangs as well. /shipping
// requests sat 120–280 s that way, constantly during Turso's us-east-1
// "elevated timeouts" incident. HTTP is one request per query / stream step
// (what Turso recommends for serverless), and every request gets a deadline,
// so a dead call fails and frees the client instead of wedging it.
const TURSO_FETCH_TIMEOUT_MS = Math.max(
  5_000,
  Number(process.env.TURSO_FETCH_TIMEOUT_MS) || 30_000,
);

// libsql's HTTP client passes a cross-fetch (node-fetch) Request, which the
// platform fetch can't take as-is — rebuild it so the timeout signal rides along.
async function tursoFetch(input: unknown, init?: RequestInit): Promise<Response> {
  const signal = AbortSignal.timeout(TURSO_FETCH_TIMEOUT_MS);
  if (typeof input === "string" || input instanceof URL) {
    return fetch(input, { ...init, signal });
  }
  const req = input as {
    url: string;
    method: string;
    headers: Iterable<[string, string]>;
    arrayBuffer(): Promise<ArrayBuffer>;
  };
  const body =
    req.method === "GET" || req.method === "HEAD"
      ? undefined
      : await req.arrayBuffer();
  return fetch(req.url, {
    method: req.method,
    headers: [...req.headers],
    body,
    signal,
  });
}

function createPrismaClient() {
  // Production (Vercel/Turso): use remote libsql URL + auth token
  // Otherwise prefer DATABASE_URL so runtime and Prisma CLI point to the
  // same database in development.
  const tursoUrl = cleanEnv(process.env.TURSO_DATABASE_URL);
  const tursoToken = cleanEnv(process.env.TURSO_AUTH_TOKEN);
  const databaseUrl = cleanEnv(process.env.DATABASE_URL);

  if (tursoUrl && tursoToken) {
    const adapter = new PrismaLibSql({
      url: tursoUrl.replace(/^libsql:\/\//, "https://"),
      authToken: tursoToken,
      fetch: tursoFetch,
    });
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

// ── Separate clients for heavy read-only reports (2026-10-26) ──────────────
// /api/dashboard/summary fires ~29 counts/aggregates, several of them full
// scans; on a cold Turso cache they took 25–65 s in a row and held a client of
// the pool above that long, so /shipping's 50 ms queries landing on it waited
// too. Reports get their own clients: their slowness stays theirs. Rotated per
// property access (not per slice) so one Promise.all of independent reads is
// spread over all of them. Not for transactions — array $transaction elements
// could land on different clients here.
function rotatingPool(size: number): PrismaClient {
  const clients = Array.from({ length: size }, () => createPrismaClient());
  let next = 0;
  return new Proxy(clients[0], {
    get(_target, prop) {
      const client = clients[next++ % clients.length];
      const value = Reflect.get(client, prop, client);
      return typeof value === "function" ? value.bind(client) : value;
    },
  }) as PrismaClient;
}

globalForPrisma.prismaReports ??= rotatingPool(4);
export const prismaReports = globalForPrisma.prismaReports;

// Same idea for bursts of independent single-statement WRITES (the plan's
// draft rows). During Turso's write stalls (2026-10-26: one INSERT 11–21 s or
// a 502) eleven inserts in a row on one main-pool client blew every deadline
// and held that client, so /shipping reads queued behind them. Parallel on
// their own clients, a stall costs one wait, and the main pool stays free.
globalForPrisma.prismaBulk ??= rotatingPool(8);
export const prismaBulk = globalForPrisma.prismaBulk;
