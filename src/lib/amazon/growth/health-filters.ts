/**
 * Shared catalog-pool filters over AmazonListingHealthItem.
 *
 * Both the deterministic Bulk fix and the bulk AI-advisor build the same "filter
 * → pool" from these helpers, so the two stages narrow the catalog identically.
 */

import type { Prisma } from "@/generated/prisma/client";

export interface HealthFilter {
  q?: string;
  suppressed?: boolean;
  hasErrors?: boolean;
  notBuyable?: boolean;
  noBuyBox?: boolean;
  oppMin?: number; // opportunity ≥
  healthMax?: number; // health ≤
  sessMin?: number; // sessions (traffic) ≥
  errMin?: number; // error issues ≥
  convMin?: number; // conversion % range
  convMax?: number;
  bbMin?: number; // buy-box % range
  bbMax?: number;
  retMin?: number; // return % range
  retMax?: number;
  revMin?: number; // sales $ (revenue, 30d) range
  revMax?: number;
  unitsMin?: number; // units sold (30d) range
  unitsMax?: number;
  health?: string; // bucket chip: winner|leaky|high-return|dead|suppressed
  status?: string; // chip: buyable|notBuyable|error
}

// Range slider maxima — keep in sync with the UI so "at max" means "no cap".
export const REV_MAX = 2000; // $ sales (revenue) range ceiling
export const UNITS_MAX = 100; // units-sold range ceiling

// Health bucket → the WHERE that defines it (used by the Health chips).
function bucketWhere(b: string): Prisma.AmazonListingHealthItemWhereInput | null {
  switch (b) {
    case "suppressed":
      return { isSuppressed: true };
    case "winner":
      return { isSuppressed: false, sessions30d: { gte: 10 }, unitSessionPct: { gte: 0.1 } };
    case "leaky":
      return {
        isSuppressed: false,
        sessions30d: { gte: 10 },
        OR: [{ unitSessionPct: null }, { unitSessionPct: { lt: 0.1 } }],
      };
    case "high-return":
      return { returnRate: { gte: 0.15 }, unitsOrdered30d: { gte: 3 } };
    case "dead":
      return { isSuppressed: false, sessions30d: { lt: 10 } };
    default:
      return null;
  }
}

export function buildHealthWhere(storeIndex: number, f: HealthFilter): Prisma.AmazonListingHealthItemWhereInput {
  const and: Prisma.AmazonListingHealthItemWhereInput[] = [];
  if (f.suppressed) and.push({ isSuppressed: true });
  if (f.hasErrors) and.push({ errorIssueCount: { gt: 0 } });
  if (f.notBuyable) and.push({ isBuyable: false });
  if (f.noBuyBox) and.push({ buyBoxPercentage: { lt: 90 } });
  if (typeof f.oppMin === "number" && f.oppMin > 0) and.push({ opportunityScore: { gte: f.oppMin } });
  if (typeof f.healthMax === "number" && f.healthMax < 100) and.push({ healthScore: { lte: f.healthMax } });
  if (typeof f.sessMin === "number" && f.sessMin > 0) and.push({ sessions30d: { gte: f.sessMin } });
  if (typeof f.errMin === "number" && f.errMin > 0) and.push({ errorIssueCount: { gte: f.errMin } });
  if (typeof f.convMin === "number" && f.convMin > 0) and.push({ unitSessionPct: { gte: f.convMin / 100 } });
  if (typeof f.convMax === "number" && f.convMax < 100) and.push({ unitSessionPct: { lte: f.convMax / 100 } });
  if (typeof f.bbMin === "number" && f.bbMin > 0) and.push({ buyBoxPercentage: { gte: f.bbMin } });
  if (typeof f.bbMax === "number" && f.bbMax < 100) and.push({ buyBoxPercentage: { lte: f.bbMax } });
  if (typeof f.retMin === "number" && f.retMin > 0) and.push({ returnRate: { gte: f.retMin / 100 } });
  if (typeof f.retMax === "number" && f.retMax < 100) and.push({ returnRate: { lte: f.retMax / 100 } });
  if (typeof f.revMin === "number" && f.revMin > 0) and.push({ revenue30d: { gte: f.revMin } });
  if (typeof f.revMax === "number" && f.revMax < REV_MAX) and.push({ revenue30d: { lte: f.revMax } });
  if (typeof f.unitsMin === "number" && f.unitsMin > 0) and.push({ unitsOrdered30d: { gte: f.unitsMin } });
  if (typeof f.unitsMax === "number" && f.unitsMax < UNITS_MAX) and.push({ unitsOrdered30d: { lte: f.unitsMax } });

  if (f.health) {
    const w = bucketWhere(f.health);
    if (w) and.push(w);
  }
  if (f.status === "buyable") and.push({ isBuyable: true });
  else if (f.status === "notBuyable") and.push({ isBuyable: false });
  else if (f.status === "error") and.push({ errorIssueCount: { gt: 0 } });

  if (f.q && f.q.trim()) {
    and.push({ OR: [{ itemName: { contains: f.q.trim() } }, { sku: { contains: f.q.trim() } }, { asin: { contains: f.q.trim() } }] });
  }
  return { storeIndex, ...(and.length ? { AND: and } : {}) };
}

export function healthFilterFromParams(sp: URLSearchParams): HealthFilter {
  const num = (k: string) => (sp.get(k) != null && sp.get(k) !== "" ? Number(sp.get(k)) : undefined);
  return {
    q: sp.get("q") ?? undefined,
    suppressed: sp.get("suppressed") === "1",
    hasErrors: sp.get("hasErrors") === "1",
    notBuyable: sp.get("notBuyable") === "1",
    noBuyBox: sp.get("noBuyBox") === "1",
    oppMin: num("oppMin"),
    healthMax: num("healthMax"),
    sessMin: num("sessMin"),
    errMin: num("errMin"),
    convMin: num("convMin"),
    convMax: num("convMax"),
    bbMin: num("bbMin"),
    bbMax: num("bbMax"),
    retMin: num("retMin"),
    retMax: num("retMax"),
    revMin: num("revMin"),
    revMax: num("revMax"),
    unitsMin: num("unitsMin"),
    unitsMax: num("unitsMax"),
    health: sp.get("health") ?? undefined,
    status: sp.get("status") ?? undefined,
  };
}

// Sort key → Prisma orderBy. SQLite sorts NULLs as lowest, so `desc` pushes
// unenriched rows to the bottom (what we want for opportunity/revenue/etc).
export const HEALTH_SORTS: Record<string, Prisma.AmazonListingHealthItemOrderByWithRelationInput> = {
  opportunity: { opportunityScore: "desc" },
  revenue: { revenue30d: "desc" },
  traffic: { sessions30d: "desc" },
  units: { unitsOrdered30d: "desc" },
  conversion: { unitSessionPct: "desc" },
  buybox: { buyBoxPercentage: "desc" },
  returns: { returnRate: "desc" },
  worstHealth: { healthScore: "asc" },
  mostErrors: { errorIssueCount: "desc" },
};

// Display-only health bucket (matches bucketWhere semantics).
export function bucketOf(c: {
  isSuppressed: boolean;
  sessions30d: number | null;
  unitSessionPct: number | null;
  returnRate: number | null;
  unitsOrdered30d: number | null;
}): string {
  if (c.isSuppressed) return "suppressed";
  if ((c.returnRate ?? 0) >= 0.15 && (c.unitsOrdered30d ?? 0) >= 3) return "high-return";
  if (c.sessions30d == null) return "new";
  if (c.sessions30d < 10) return "dead";
  if ((c.unitSessionPct ?? 0) >= 0.1) return "winner";
  return "leaky";
}
