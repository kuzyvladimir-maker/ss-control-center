// Fund distribution run — ties the pieces together.
//
// Pool = sum of UNDISTRIBUTED payouts (cash basis). Reserve rate from Setting.
// distributeFunds() (pure) decides where the money goes; this orchestrator
// persists it: FinancePlanRun + FundAllocation rows, bumps Fund.balance, and
// marks the consumed payouts distributed. preview=true computes without writing.

import { prisma } from "@/lib/prisma";
import { distributeFunds } from "./distribute";
import { getReserveRate } from "./reserve-rate";
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
}

async function loadActiveFunds(scope: Scope): Promise<FundConfig[]> {
  const rows = await prisma.fund.findMany({ where: { active: true, scope } });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    group: r.group as FundConfig["group"],
    allocationType: r.allocationType as FundConfig["allocationType"],
    value: r.value,
    priority: r.priority,
    cap: r.cap,
    active: r.active,
  }));
}

export async function runDistribution(opts: {
  preview?: boolean;
  runDate?: string; // ISO date (caller stamps; scripts can't use Date.now in workflows but routes can)
  source?: "manual" | "cron";
  scope?: Scope; // business (default) | personal
}): Promise<RunResult> {
  const preview = opts.preview ?? true;
  const scope: Scope = opts.scope ?? "business";
  const runDate = opts.runDate ?? new Date().toISOString().slice(0, 10);

  // Personal has NO restock reserve — taxes are reserved in the business pool (one
  // owner across all entities → one tax). All personal income flows into envelopes.
  const [funds, reserve, payouts] = await Promise.all([
    loadActiveFunds(scope),
    scope === "personal"
      ? Promise.resolve({ rate: 0, method: "manual" as const, fellBackToManual: false })
      : getReserveRate(),
    prisma.payout.findMany({ where: { distributed: false, scope } }),
  ]);

  const totalIn = payouts.reduce((s, p) => s + (p.netAmount ?? 0), 0);
  const distribution = distributeFunds(totalIn, reserve.rate, funds);

  const base: RunResult = {
    preview,
    distribution,
    reserveMethod: reserve.method,
    reserveFellBack: reserve.fellBackToManual,
    payoutCount: payouts.length,
    runDate,
  };

  if (preview || payouts.length === 0) return base;

  // Commit: run record + allocations + balances + mark payouts.
  const run = await prisma.financePlanRun.create({
    data: {
      scope,
      runDate,
      totalIn: distribution.totalIn,
      totalReserved: distribution.reserve,
      totalDistributed: Math.round((distribution.totalIn - distribution.free) * 100) / 100,
      reserveRateUsed: distribution.reserveRate,
      payoutCount: payouts.length,
      source: opts.source ?? "manual",
    },
  });

  for (const a of distribution.allocations) {
    if (a.amount <= 0) continue;
    await prisma.fundEntry.create({
      data: {
        fundId: a.fundId, type: "allocation", amount: a.amount,
        description: `Distribution ${runDate}`, status: "applied", runId: run.id,
      },
    });
    await prisma.fund.update({
      where: { id: a.fundId },
      data: { balance: { increment: a.amount } },
    });
  }

  await prisma.payout.updateMany({
    where: { id: { in: payouts.map((p) => p.id) } },
    data: { distributed: true },
  });

  return { ...base, runId: run.id };
}
