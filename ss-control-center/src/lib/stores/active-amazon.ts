import { prisma } from "@/lib/prisma";

/**
 * Amazon store indexes (1..5) whose Store row is active. Crons that loop
 * over SP-API credentials use this to skip accounts the owner has marked
 * inactive (blocked by Amazon — as of 2026-10-18 only store1 / Salutem
 * Solutions is live), instead of logging a 403 for each of them every run.
 */
export async function activeAmazonStoreIndexes(): Promise<Set<number>> {
  const rows = await prisma.store.findMany({
    where: { channel: "Amazon", active: true, storeIndex: { not: null } },
    select: { storeIndex: true },
  });
  return new Set(rows.map((r) => r.storeIndex as number));
}
