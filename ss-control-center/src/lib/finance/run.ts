// Fund distribution run — ties the pieces together.
//
// Pool = sum of UNDISTRIBUTED payouts (cash basis). Reserve rate from Setting.
// distributeFunds() (pure) decides where the money goes; this orchestrator
// persists it: FinancePlanRun + FundAllocation rows, bumps Fund.balance, and
// marks the consumed payouts distributed. preview=true computes without writing.

import { prisma } from "@/lib/prisma";
import { distributeFunds } from "./distribute";
import { getReserveRate } from "./reserve-rate";
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

async function loadActiveFunds(): Promise<FundConfig[]> {
  const rows = await prisma.fund.findMany({ where: { active: true } });
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
}): Promise<RunResult> {
  const preview = opts.preview ?? true;
  const runDate = opts.runDate ?? new Date().toISOString().slice(0, 10);

  const [funds, reserve, payouts] = await Promise.all([
    loadActiveFunds(),
    getReserveRate(),
    prisma.payout.findMany({ where: { distributed: false } }),
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
    await prisma.fundAllocation.create({
      data: { fundId: a.fundId, runId: run.id, amount: a.amount, date: runDate },
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
