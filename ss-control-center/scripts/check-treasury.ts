// Real SQLite transaction tests in a disposable local DB. Never uses Turso.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { resolveTreasury, personalFromFree, TREASURY_KEY } from "../src/lib/finance/treasury";
import { distributeFunds } from "../src/lib/finance/distribute";

async function main() {
  const dir = await mkdtemp(join(tmpdir(), "sscc-treasury-test-"));
  delete process.env.TURSO_DATABASE_URL; delete process.env.TURSO_AUTH_TOKEN;
  const db = new PrismaClient({ adapter: new PrismaLibSql({ url: `file:${join(dir, "test.db")}` }) });
  const second = new PrismaClient({ adapter: new PrismaLibSql({ url: `file:${join(dir, "test.db")}` }) });
  let transactionIndex = 0;
  const pooled = new Proxy(db, { get(target, key) {
    const client = key === "$transaction" && transactionIndex++ % 2 === 1 ? second : target;
    const value = Reflect.get(client, key, client);
    return typeof value === "function" ? value.bind(client) : value;
  } });
  Object.assign(globalThis, { prisma: pooled, prismaPool: [db, second], prismaReports: db, prismaBulk: db });
  try {
    for (const sql of [
      `CREATE TABLE Setting (id TEXT PRIMARY KEY, key TEXT NOT NULL UNIQUE, value TEXT NOT NULL)`,
      `CREATE TABLE Fund (id TEXT PRIMARY KEY, scope TEXT DEFAULT 'business', name TEXT, "group" TEXT, allocationType TEXT DEFAULT 'percent', value REAL DEFAULT 0, priority INTEGER DEFAULT 100, cap REAL, balance REAL DEFAULT 0, active BOOLEAN DEFAULT true, isSystem BOOLEAN DEFAULT false, notes TEXT, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME NOT NULL)`,
      `CREATE TABLE Payout (id TEXT PRIMARY KEY, scope TEXT DEFAULT 'business', marketplace TEXT, storeIndex INTEGER, entity TEXT, externalId TEXT, periodStart TEXT, periodEnd TEXT, depositDate TEXT, grossSales REAL, feesTotal REAL, netAmount REAL, currency TEXT DEFAULT 'USD', distributed BOOLEAN DEFAULT false, source TEXT DEFAULT 'settlement', createdAt DATETIME DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME NOT NULL, UNIQUE(marketplace, externalId))`,
      `CREATE TABLE FundEntry (id TEXT PRIMARY KEY, fundId TEXT, type TEXT, amount REAL, description TEXT, status TEXT DEFAULT 'applied', dueDate TEXT, runId TEXT, expenseId TEXT, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME NOT NULL)`,
      `CREATE TABLE FinancePlanRun (id TEXT PRIMARY KEY, scope TEXT DEFAULT 'business', runDate TEXT, periodStart TEXT, periodEnd TEXT, totalIn REAL DEFAULT 0, totalReserved REAL DEFAULT 0, totalDistributed REAL DEFAULT 0, reserveRateUsed REAL DEFAULT 0, payoutCount INTEGER DEFAULT 0, source TEXT DEFAULT 'manual', notes TEXT, createdAt DATETIME DEFAULT CURRENT_TIMESTAMP)`,
    ]) await db.$executeRawUnsafe(sql);
    const { runDistribution } = await import("../src/lib/finance/run");
    const { recordPersonalIncome } = await import("../src/lib/finance/personal-income");
    assert.equal(resolveTreasury(null, null).grossMargin.rate, null);
    assert.equal(resolveTreasury(null, "0").grossMargin.rate, 1);
    assert.equal(resolveTreasury(null, "1").grossMargin.rate, 0);
    assert.equal(resolveTreasury(null, "0.5").grossMargin.rate, 0.5);
    assert.equal(resolveTreasury(null, "0.5").personalShare, null);
    assert.equal(resolveTreasury(JSON.stringify({ grossMargin: { source: "economics", rate: 0.8 }, personalShare: 0.2 }), null).grossMargin.rate, null);
    await db.setting.create({ data: { key: "finance:reserve:manualPct", value: "0.5" } });
    for (const f of [
      { id: "reserve", name: "Restock", group: "RESERVE", priority: 0 },
      { id: "capped", name: "Capped", group: "FP1", value: 50, cap: 100, priority: 1 },
      { id: "bills", name: "Bills", group: "FP2", allocationType: "absolute", value: 50, priority: 2 },
      { id: "free", name: "Free", group: "FREE", priority: 99 },
    ]) await db.fund.create({ data: f });
    await db.payout.create({ data: { marketplace: "amazon", externalId: "fixture-1", netAmount: 1000 } });
    const beforePreview = await db.payout.findMany();
    const preview = await runDistribution({ preview: true });
    assert.equal(preview.distribution.free, 350);
    assert.equal(preview.treasury?.transfer.amount, 0);
    assert.deepEqual(await db.payout.findMany(), beforePreview);
    assert.equal(await db.financePlanRun.count(), 0);
    assert.equal(await db.fundEntry.count(), 0);
    await db.setting.create({ data: { key: TREASURY_KEY, value: JSON.stringify({ grossMargin: { source: "constant", rate: 0.5 }, personalShare: 0.4 }) } });
    // A late failure after all business allocations must roll back the claim,
    // balances, run and ledger too — not leave personal income missing.
    await db.$executeRawUnsafe(`CREATE TRIGGER fail_personal BEFORE INSERT ON Payout WHEN NEW.source = 'treasury_free_share' BEGIN SELECT RAISE(ABORT, 'injected failure'); END`);
    await assert.rejects(runDistribution({ preview: false }));
    assert.equal(await db.financePlanRun.count(), 0);
    assert.equal(await db.fundEntry.count(), 0);
    assert.equal((await db.fund.findUniqueOrThrow({ where: { id: "free" } })).balance, 0);
    assert.equal((await db.payout.findUniqueOrThrow({ where: { payout_dedup: { marketplace: "amazon", externalId: "fixture-1" } } })).distributed, false);
    await db.$executeRawUnsafe(`DROP TRIGGER fail_personal`);
    const commits = await Promise.allSettled([runDistribution({ preview: false }), runDistribution({ preview: false })]);
    assert.equal(commits.filter((r) => r.status === "fulfilled" && r.value.runId).length, 1);
    // SQLite may serialize the two writers or reject one with BUSY. A retry
    // after either outcome must see the already-claimed payout.
    assert.equal((await runDistribution({ preview: false })).runId, undefined);
    assert.equal(await db.financePlanRun.count(), 1);
    const personal = await db.payout.findMany({ where: { scope: "personal" } });
    assert.equal(personal.length, 1); assert.equal(personal[0].netAmount, 140);
    assert.equal((await db.fund.findUniqueOrThrow({ where: { id: "free" } })).balance, 210);
    const sum = (await db.fund.findMany()).reduce((s, f) => s + f.balance, 0) + personal[0].netAmount;
    assert.equal(sum, 1000, "cash conserved across both pools");
    assert.equal(await db.fundEntry.count({ where: { type: "owner_draw" } }), 1);
    const run = await db.financePlanRun.findFirstOrThrow();
    assert.equal(JSON.parse(run.notes!).treasury.grossMargin.source, "constant");
    await db.fund.create({ data: { id: "pfree", scope: "personal", name: "Personal free", group: "FREE" } });
    const personalRun = await runDistribution({ preview: false, scope: "personal" });
    assert.equal(personalRun.distribution.reserve, 0); assert.equal(personalRun.distribution.totalIn, 140);
    assert.equal((await db.fund.findUniqueOrThrow({ where: { id: "pfree" } })).balance, 140);
    // Manual draw: sufficient FREE only, retry-safe, no independent ledger undo.
    const input = { action: "draw" as const, amount: 25, fromFundId: "free", note: "fixture", depositDate: "2026-10-27", requestId: "local-fixture-request-1" };
    const draws = await Promise.allSettled([recordPersonalIncome(input), recordPersonalIncome(input)]);
    assert.equal(draws.filter((r) => r.status === "fulfilled" && !r.value.replayed).length, 1);
    const retry = await recordPersonalIncome(input);
    assert.equal(retry.replayed, true);
    assert.equal((await db.fund.findUniqueOrThrow({ where: { id: "free" } })).balance, 185);
    await assert.rejects(recordPersonalIncome({ ...input, amount: 26 }));
    await assert.rejects(recordPersonalIncome({ ...input, requestId: "local-fixture-request-2", amount: 200 }));
    await assert.rejects(recordPersonalIncome({ ...input, requestId: "local-fixture-request-3", fromFundId: "reserve" }));
    assert.equal((await db.fund.findUniqueOrThrow({ where: { id: "free" } })).balance, 185);
    const small = distributeFunds(10.01, 0.5, []);
    assert.equal(personalFromFree(small, 0.3333).amount, 1.67);
    assert.equal(personalFromFree(preview.distribution, 1, -300).amount, 50);
    assert.equal(personalFromFree(preview.distribution, 1, -400).amount, 0);
    assert.equal(personalFromFree(preview.distribution, 0).amount, 0);
    console.log("PASS: grossMargin compatibility, unknown/zero rates, waterfall caps, preview no writes, rollback, repeated/concurrent runs over independent connections, cross-pool conservation, personal reserve=0, retry-safe draws, insufficient funds and rounding");
  } finally { await db.$disconnect(); await second.$disconnect(); await rm(dir, { recursive: true, force: true }); }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
