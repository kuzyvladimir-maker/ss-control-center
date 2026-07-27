/**
 * Amazon Growth — Learning Store (experiment engine, Phase 3).
 *
 * Aggregates the control-adjusted (diff-in-diff) outcomes of past changes into
 * generalizable rules: "change-type X on category Y moved conversion by Z pp over
 * n measured changes". The advisor reads these so proven levers get prioritized and
 * dead ones get demoted — the engine learns from what actually worked and applies
 * it to similar listings.
 *
 * Only measured, control-adjusted changes count (didConfidence ≠ insufficient).
 */

import type { PrismaClient } from "@/generated/prisma/client";

export interface Learning {
  changeType: string;
  category: string; // productType, or "all"
  n: number;
  avgLiftConvPp: number; // mean control-adjusted conversion lift (pp)
  avgLiftRevPerDay: number; // mean control-adjusted revenue/day lift ($)
  usefulShare: number; // 0-1 fraction graded useful
  confidence: "weak" | "solid"; // solid = enough n at medium+ confidence
}

const CONF_RANK: Record<string, number> = { insufficient: 0, low: 1, medium: 2, high: 3 };

export async function computeLearnings(prisma: PrismaClient, storeIndex: number): Promise<Learning[]> {
  const rows = await prisma.amazonChangeLog.findMany({
    where: { storeIndex, didMeasuredAt: { not: null }, didConfidence: { not: "insufficient" } },
    select: { sku: true, changeType: true, didConfidence: true, didLiftConvPp: true, didLiftRevPerDay: true, outcome: true },
  });
  if (rows.length === 0) return [];

  // sku → productType (category) from the mirror.
  const skus = [...new Set(rows.map((r) => r.sku))];
  const items = await prisma.amazonListingHealthItem.findMany({
    where: { storeIndex, sku: { in: skus } },
    select: { sku: true, productType: true },
  });
  const ptBySku = new Map(items.map((i) => [i.sku, i.productType ?? "unknown"]));

  interface Acc { n: number; conv: number; rev: number; useful: number; strong: number }
  const groups = new Map<string, Acc & { changeType: string; category: string }>();
  const bump = (changeType: string, category: string, r: (typeof rows)[number]) => {
    const key = `${changeType}|${category}`;
    const g = groups.get(key) ?? { changeType, category, n: 0, conv: 0, rev: 0, useful: 0, strong: 0 };
    g.n++;
    g.conv += r.didLiftConvPp ?? 0;
    g.rev += r.didLiftRevPerDay ?? 0;
    if (r.outcome === "useful") g.useful++;
    if ((CONF_RANK[r.didConfidence ?? ""] ?? 0) >= 2) g.strong++;
    groups.set(key, g);
  };

  for (const r of rows) {
    const pt = ptBySku.get(r.sku) ?? "unknown";
    bump(r.changeType, pt, r); // per-category
    bump(r.changeType, "all", r); // and the cross-category rollup
  }

  return [...groups.values()]
    .map((g) => ({
      changeType: g.changeType,
      category: g.category,
      n: g.n,
      avgLiftConvPp: Math.round((g.conv / g.n) * 10) / 10,
      avgLiftRevPerDay: Math.round((g.rev / g.n) * 100) / 100,
      usefulShare: Math.round((g.useful / g.n) * 100) / 100,
      confidence: (g.strong >= 5 ? "solid" : "weak") as Learning["confidence"],
    }))
    .sort((a, b) => b.n - a.n);
}

/** Short prompt snippet of proven levers relevant to a category (+ global), so
 *  the advisor prioritizes what actually worked. Empty string until data accrues. */
export async function summarizeForAdvisor(
  prisma: PrismaClient, storeIndex: number, productType: string | null,
): Promise<string> {
  const learnings = await computeLearnings(prisma, storeIndex);
  if (learnings.length === 0) return "";
  const relevant = learnings
    .filter((l) => l.n >= 3 && (l.category === "all" || l.category === (productType ?? "")))
    .slice(0, 8);
  if (relevant.length === 0) return "";
  const lines = relevant.map((l) => {
    const sign = l.avgLiftConvPp > 0 ? "+" : "";
    const where = l.category === "all" ? "catalog-wide" : l.category;
    return `- ${l.changeType} (${where}): avg ${sign}${l.avgLiftConvPp}pp conversion, ${Math.round(l.usefulShare * 100)}% useful over n=${l.n} (${l.confidence})`;
  });
  return `Proven levers measured on this catalog (control-adjusted; prefer the ones with positive lift + solid confidence, avoid the negative ones):\n${lines.join("\n")}`;
}
