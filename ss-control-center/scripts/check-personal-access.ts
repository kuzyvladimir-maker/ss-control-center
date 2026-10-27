// Route-level regression checks with a fake DB. Never connects to Turso.
// node --import tsx scripts/check-personal-access.ts
import assert from "node:assert/strict";
import { NextRequest, type NextResponse } from "next/server";
import { createSessionToken } from "../src/lib/auth";
import { buildAccessCookieValue } from "../src/lib/rbac/access-cookie";

async function main() {
  process.env.NEXTAUTH_SECRET = "personal-finance-local-test-only";
  process.env.SSCC_API_TOKEN = "personal-finance-local-api-test-only";
  delete process.env.JACKIE_API_TOKEN;
  let user: { id: string; role: string; username: string; displayName: null } | null = { id: "test", role: "staff", username: "test", displayName: null };
  let reads = 0;
  const model = { findMany: async () => { reads++; return []; } };
  const fake = new Proxy({ user: { findUnique: async () => user } }, {
    get(target, key) {
      if (key === "user") return target.user;
      if (["creditCard", "debt", "obligationEvent", "personalAsset", "recurringExpense", "payout"].includes(String(key))) return model;
      throw new Error(`Unexpected database access: ${String(key)}`);
    },
  });
  Object.assign(globalThis, { prisma: fake, prismaPool: [fake], prismaReports: fake, prismaBulk: fake });
  const routes = [
    await import("../src/app/api/personal/registry/route"),
    await import("../src/app/api/personal/calendar/route"),
    await import("../src/app/api/personal/cards/route"),
    await import("../src/app/api/personal/cards/[id]/route"),
    await import("../src/app/api/personal/income/route"),
  ];
  const methods = ["GET", "POST", "PATCH", "DELETE"] as const;
  const session = createSessionToken("test");
  // Missing access cookie and a stale signed admin cookie must both be denied
  // when the current database role is staff.
  const stale = buildAccessCookieValue({ u: "test", r: "admin", m: [] });
  type Handler = (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<NextResponse>;
  let checks = 0;
  for (const route of routes) for (const method of methods) {
    const handler = (route as unknown as Record<string, Handler>)[method];
    if (!handler) continue;
    for (const [cookie, status] of [["", 401], [`sscc-session=${session}`, 403], [`sscc-session=${session}; sscc-access=${stale}`, 403]] as const) {
      const r = await handler(new NextRequest("http://localhost/api/personal/test", { method, headers: { cookie } }), { params: Promise.resolve({ id: "test" }) });
      assert.equal(r.status, status, `${method}: unauthorized request must stop before data access`);
      checks++;
    }
  }
  assert.equal(reads, 0);
  const registry = routes[0] as typeof import("../src/app/api/personal/registry/route");
  user = null;
  assert.equal((await registry.GET(new NextRequest("http://localhost/api/personal/registry", { headers: { cookie: `sscc-session=${session}` } }))).status, 401);
  user = { id: "test", role: "admin", username: "owner", displayName: null };
  assert.equal((await registry.GET(new NextRequest("http://localhost/api/personal/registry", { headers: { cookie: `sscc-session=${session}` } }))).status, 200);
  const before = reads;
  for (const body of [
    { type: "card", currentBalance: "" }, { type: "card", currentBalance: "bad" },
    { type: "asset", value: null }, { type: "asset", value: "Infinity" },
    { type: "debt", balance: -1 }, { type: "debt", apr: -1 },
    { type: "event", date: "2026-02-30" }, { type: "debt", dueDay: 40 },
  ]) {
    const r = await registry.PATCH(new NextRequest("http://localhost/api/personal/registry", { method: "PATCH", headers: { authorization: `Bearer ${process.env.SSCC_API_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ id: "test", ...body }) }));
    assert.equal(r.status, 400, JSON.stringify(body));
    checks++;
  }
  assert.equal(reads, before, "invalid inputs must not read/write financial data");
  const { proxy } = await import("../src/proxy");
  const noAccess = new NextRequest("http://localhost/api/finance/funds?scope=personal", { headers: { cookie: `sscc-session=${session}` } });
  assert.equal(proxy(noAccess).status, 403, "shared personal-scope endpoints fail closed without access cookie");
  console.log(`PASS: ${checks} unauthorized/invalid requests blocked; owner read allowed; no production DB used`);
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
