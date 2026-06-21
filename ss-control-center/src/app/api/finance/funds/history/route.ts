// Per-fund daily balance series (for the Funds tab mini-charts) + grand total.
//   GET ?days=30 → { funds:[{id,name,group,balance,series:number[]}], total, days }

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function GET(req: NextRequest) {
  const days = Math.min(90, Math.max(7, Number(req.nextUrl.searchParams.get("days") ?? "30") || 30));

  const funds = await prisma.fund.findMany({ orderBy: { priority: "asc" } });
  const entries = await prisma.fundEntry.findMany({
    where: { status: "applied" },
    orderBy: { createdAt: "asc" },
    select: { fundId: true, amount: true, createdAt: true },
  });

  // Day axis: last `days` UTC days ending today.
  const axis: string[] = [];
  const base = new Date();
  for (let k = days - 1; k >= 0; k--) {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() - k);
    axis.push(d.toISOString().slice(0, 10));
  }
  const startDay = axis[0];
  const entryDay = (c: Date) => c.toISOString().slice(0, 10);

  const byFund = new Map<string, { amount: number; day: string }[]>();
  for (const e of entries) {
    const a = byFund.get(e.fundId) ?? [];
    a.push({ amount: e.amount, day: entryDay(e.createdAt) });
    byFund.set(e.fundId, a);
  }

  const out = funds.map((f) => {
    const evs = byFund.get(f.id) ?? [];
    let cum = 0, i = 0;
    while (i < evs.length && evs[i].day < startDay) { cum += evs[i].amount; i++; }
    const series: number[] = [];
    for (const day of axis) {
      while (i < evs.length && evs[i].day <= day) { cum += evs[i].amount; i++; }
      series.push(round2(cum));
    }
    return { id: f.id, name: f.name, group: f.group, allocationType: f.allocationType, value: f.value, priority: f.priority, active: f.active, balance: f.balance, series };
  });

  const total = round2(funds.reduce((s, f) => s + f.balance, 0));
  return NextResponse.json({ funds: out, total, days });
}
