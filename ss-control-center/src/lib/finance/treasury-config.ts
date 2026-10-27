import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { resolveTreasury, TREASURY_KEY } from "./treasury";

export async function getTreasuryConfig(db: Pick<Prisma.TransactionClient, "setting"> = prisma) {
  const rows = await db.setting.findMany({ where: { key: { in: [TREASURY_KEY, "finance:reserve:manualPct", "finance:taxRatePct"] } } });
  const stored = rows.find((r) => r.key === TREASURY_KEY);
  const legacy = rows.find((r) => r.key === "finance:reserve:manualPct");
  const tax = rows.find((r) => r.key === "finance:taxRatePct");
  const taxValue = tax ? Number(tax.value) : null;
  return {
    ...resolveTreasury(stored?.value ?? null, legacy?.value ?? null),
    taxRatePct: taxValue != null && Number.isFinite(taxValue) && taxValue >= 0 ? taxValue : 1.5,
  };
}
