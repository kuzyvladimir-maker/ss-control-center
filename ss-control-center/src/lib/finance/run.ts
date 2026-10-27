import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { distributeFunds } from "./distribute";
import { getTreasuryConfig } from "./treasury-config";
import { personalFromFree, roundMoney, TREASURY_KEY, type TreasuryConfig } from "./treasury";
import type { Scope } from "./scope";
import type { FundConfig, DistributionResult } from "./types";

export interface RunResult {
  preview: boolean;
  distribution: DistributionResult;
  reserveMethod: "manual" | "auto";
  reserveFellBack: boolean;
  payoutCount: number;
  runId?: string;
  runDate: string;
  treasury: (TreasuryConfig & { transfer: ReturnType<typeof personalFromFree> }) | null;
}

/** Preview has no writes. Commit claims payouts, credits business funds, debits
 * FREE and creates personal income in ONE transaction. Replaying a completed
 * run sees no undistributed payouts; concurrent claims cannot double-credit. */
export async function runDistribution(opts: {
  preview?: boolean; runDate?: string; source?: "manual" | "cron"; scope?: Scope;
}): Promise<RunResult> {
  const preview = opts.preview ?? true;
  const scope = opts.scope ?? "business";
  const runDate = opts.runDate ?? new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
  const execute = async (db: Prisma.TransactionClient): Promise<RunResult> => {
    // Acquire SQLite's writer reservation before reading the snapshot. Two
    // deferred read transactions must not deadlock when both upgrade to writes.
    // No setting value changes, including when the new setting is still absent.
    if (!preview) await db.$executeRaw`UPDATE "Setting" SET "value" = "value" WHERE "key" = ${TREASURY_KEY}`;
    const funds = await db.fund.findMany({ where: { active: true, scope }, orderBy: [{ priority: "asc" }, { id: "asc" }] });
    const config = scope === "business" ? await getTreasuryConfig(db) : null;
    if (config && config.grossMargin.rate == null) throw new Error("Set the temporary gross margin before distributing; Economics is not connected");
    const payouts = await db.payout.findMany({ where: { distributed: false, scope } });
    const totalIn = roundMoney(payouts.reduce((sum, p) => sum + p.netAmount, 0));
    if (totalIn < 0) throw new Error("Pending payouts are negative; reconcile them before distributing");
    const distribution = distributeFunds(totalIn, config ? 1 - config.grossMargin.rate! : 0, funds as FundConfig[]);
    const freeFund = funds.find((f) => f.group === "FREE");
    const transfer = personalFromFree(distribution, config?.personalShare ?? null, freeFund?.balance ?? 0);
    const base: RunResult = {
      preview, distribution, payoutCount: payouts.length, runDate,
      reserveMethod: config?.grossMargin.source === "economics" ? "auto" : "manual", reserveFellBack: false,
      treasury: config ? { ...config, transfer } : null,
    };
    if (preview || payouts.length === 0) return base;
    if (distribution.reserve > 0 && !funds.some((f) => f.group === "RESERVE")) throw new Error("Active restock reserve fund required");
    if (distribution.free > 0 && !freeFund) throw new Error("Active FREE fund required");
    const claimed = await db.payout.updateMany({ where: { id: { in: payouts.map((p) => p.id) }, distributed: false, scope }, data: { distributed: true } });
    if (claimed.count !== payouts.length) throw new Error("Payouts changed during distribution; reload the preview");
    const run = await db.financePlanRun.create({ data: {
      scope, runDate, totalIn, totalReserved: distribution.reserve,
      totalDistributed: roundMoney(totalIn - (config ? transfer.freeRetained : distribution.free)),
      reserveRateUsed: distribution.reserveRate, payoutCount: payouts.length, source: opts.source ?? "manual",
      notes: config ? JSON.stringify({ treasury: { ...config, transfer }, payoutIds: payouts.map((p) => p.id) }) : null,
    } });
    for (const a of distribution.allocations) {
      if (a.amount <= 0) continue;
      await db.fundEntry.create({ data: { fundId: a.fundId, type: "allocation", amount: a.amount, description: `Distribution ${runDate}`, status: "applied", runId: run.id } });
      await db.fund.update({ where: { id: a.fundId }, data: { balance: { increment: a.amount } } });
    }
    if (config && transfer.amount > 0 && freeFund) {
      const debit = await db.fund.updateMany({ where: { id: freeFund.id, balance: { gte: transfer.amount } }, data: { balance: { decrement: transfer.amount } } });
      if (debit.count !== 1) throw new Error("FREE balance is insufficient");
      await db.fundEntry.create({ data: { fundId: freeFund.id, type: "owner_draw", amount: -transfer.amount, description: `Treasury → personal (${transfer.share! * 100}% of new FREE)`, status: "applied", runId: run.id } });
      await db.payout.create({ data: { scope: "personal", marketplace: "personal", externalId: `treasury:${run.id}`, netAmount: transfer.amount, depositDate: runDate, source: "treasury_free_share", entity: "Owner household" } });
    }
    return { ...base, runId: run.id };
  };
  return preview ? execute(prisma) : prisma.$transaction(execute, { maxWait: 10_000, timeout: 60_000 });
}
