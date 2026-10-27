import { prisma } from "@/lib/prisma";
import { roundMoney } from "./treasury";

export class IncomeError extends Error {}
export interface IncomeInput { action: "manual" | "draw"; amount: number; fromFundId?: string; note: string; depositDate: string; requestId: string }

export async function recordPersonalIncome(input: IncomeInput) {
  const amount = roundMoney(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new IncomeError("Enter a positive amount");
  const externalId = `personal:${input.requestId}`;
  const source = input.action === "draw" ? "owner_draw" : "manual";
  // Stable payload permits a network retry but rejects reusing the key for a
  // different transfer. Stored with its paired payout, inside the transaction.
  const payload = JSON.stringify({ ...input, amount });
  const requestKey = `finance:income:${input.requestId}`;
  return prisma.$transaction(async (tx) => {
    const previous = await tx.payout.findUnique({ where: { payout_dedup: { marketplace: "personal", externalId } } });
    if (previous) {
      const receipt = await tx.setting.findUnique({ where: { key: requestKey } });
      if (receipt?.value !== payload) throw new IncomeError("Request ID already used for different income");
      return { payout: previous, replayed: true };
    }
    if (input.action === "draw") {
      const debit = await tx.fund.updateMany({ where: { id: input.fromFundId ?? "", scope: "business", group: "FREE", active: true, balance: { gte: amount } }, data: { balance: { decrement: amount } } });
      if (debit.count !== 1) throw new IncomeError("Choose an active business FREE fund with sufficient balance");
      await tx.fundEntry.create({ data: { fundId: input.fromFundId!, type: "owner_draw", amount: -amount, description: `Owner draw → personal [${externalId}]${input.note ? `: ${input.note}` : ""}`, status: "applied" } });
    }
    const payout = await tx.payout.create({ data: { scope: "personal", marketplace: "personal", externalId, netAmount: amount, depositDate: input.depositDate, source, entity: input.note || null } });
    await tx.setting.create({ data: { key: requestKey, value: payload } });
    return { payout, replayed: false };
  }, { maxWait: 10_000, timeout: 30_000 });
}
