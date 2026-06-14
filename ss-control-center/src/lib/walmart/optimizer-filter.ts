// Shared filter builder for the Listing Optimizer (used by the candidates route
// and the AI-analyst route). Translates the Builder's query params into SQL over
// the catalog-base query: FROM WalmartCatalogItem w LEFT JOIN
// WalmartListingQualityItem q LEFT JOIN WalmartSkuPerf perf.

// Words that signal a mixed/variety bundle (quantity-confusion fix doesn't apply).
export const BUNDLE_WORDS = ["bundle", "variety pack", "variety", "assorted", "sampler", "gift"];

export function buildFilter(p: URLSearchParams) {
  const packMin = Number(p.get("packMin") ?? 2);
  const packMax = Number(p.get("packMax") ?? 99);
  const lqMin = p.get("lqMin") != null ? Number(p.get("lqMin")) : null;
  const lqMax = p.get("lqMax") != null ? Number(p.get("lqMax")) : null;
  const contentMax = p.get("contentMax") != null ? Number(p.get("contentMax")) : null;
  const hasIssues = p.get("hasIssues") === "1";
  const excludeBundles = p.get("excludeBundles") !== "0";
  const packExpr = `COALESCE((SELECT unitsInListing FROM SkuShippingData WHERE sku=w.sku LIMIT 1),(SELECT packSize FROM SkuCost WHERE sku=w.sku LIMIT 1),w.titlePackCount,1)`;
  const where: string[] = ["w.storeIndex=?"];
  const args: any[] = [];
  where.push(`${packExpr} BETWEEN ? AND ?`); args.push(packMin, packMax);
  if (lqMin != null && lqMin > 0) { where.push(`q.lqScore >= ?`); args.push(lqMin); }
  if (lqMax != null && lqMax < 100) { where.push(`q.lqScore <= ?`); args.push(lqMax); }
  if (contentMax != null && contentMax < 100) { where.push(`q.contentScore <= ?`); args.push(contentMax); }
  if (hasIssues) where.push(`COALESCE(q.issueCount,0) > 0`);
  if (p.get("oos") === "1") where.push(`q.isInStock = 0`); // out-of-stock only (null = unknown, excluded)
  if (excludeBundles) for (const bw of BUNDLE_WORDS) { where.push(`LOWER(COALESCE(w.title,'')) NOT LIKE ?`); args.push(`%${bw}%`); }
  where.push(`w.sku NOT IN (SELECT sku FROM WalmartListingRemediation WHERE ok=1)`);
  where.push(`w.sku NOT IN (SELECT sku FROM WalmartRemediationQueue WHERE status IN ('queued','running'))`);

  const periodRaw = Number(p.get("period") ?? 30);
  const period = [30, 90, 180].includes(periodRaw) ? periodRaw : 30;
  const S = `COALESCE(perf.sales${period},0)`, U = `COALESCE(perf.units${period},0)`, O = `COALESCE(perf.orders${period},0)`, R = `COALESCE(perf.returns${period},0)`;
  const VIEWS = `COALESCE(q.pageViews30d,0)`;
  const num = (k: string) => (p.get(k) != null && p.get(k) !== "" ? Number(p.get(k)) : null);
  const rng = (k: string, expr: string, max: number) => {
    const lo = num("min" + k), hi = num("max" + k);
    if (lo != null && lo > 0) where.push(`${expr} >= ${lo}`);
    if (hi != null && hi < max) where.push(`${expr} <= ${hi}`);
  };
  rng("Sales", S, 1000);
  rng("Units", U, 50);
  rng("Reviews", "COALESCE(q.ratingCount,0)", 50);
  rng("ReturnPct", `(${R}*100.0/NULLIF(${U},0))`, 100);
  const maxConvPct = num("maxConvPct"); if (maxConvPct != null && maxConvPct < 100) where.push(`(${U}*100.0/NULLIF(${VIEWS},0)) <= ${maxConvPct}`);

  const health = p.get("health");
  const HEALTH_SQL: Record<string, string> = {
    winner: `${U} > 0`,
    leaky: `${U} = 0 AND ${VIEWS} >= 20`,
    "high-return": `${U} >= 3 AND (${R}*1.0/NULLIF(${U},0)) >= 0.15`,
    dead: `${VIEWS} = 0 AND COALESCE(q.ratingCount,0) = 0`,
    new: `${U} = 0 AND ${VIEWS} < 20 AND (${VIEWS} > 0 OR COALESCE(q.ratingCount,0) > 0)`,
  };
  if (health && HEALTH_SQL[health]) where.push(`(${HEALTH_SQL[health]})`);

  const status = p.get("status");
  const STATUS_SQL: Record<string, string> = { published: "PUBLISHED", unpublished: "UNPUBLISHED", error: "SYSTEM_PROBLEM" };
  if (status && STATUS_SQL[status]) where.push(`w.publishedStatus = '${STATUS_SQL[status]}'`);

  const sortKey = p.get("sort") || "views";
  const SORTS: Record<string, string> = {
    sales: `${S} DESC`, units: `${U} DESC`, views: `${VIEWS} DESC`,
    conv: `(${U}*1.0/NULLIF(${VIEWS},0)) DESC`, reviews: `COALESCE(q.ratingCount,0) DESC`,
    returnRate: `(${R}*1.0/NULLIF(${U},0)) DESC`, lq: `q.lqScore ASC`,
  };
  const sortSql = SORTS[sortKey] || SORTS.views;
  return { whereSql: where.join(" AND "), args, packExpr, period, S, U, O, R, VIEWS, sortSql };
}

export const OPTIMIZER_JOIN = `LEFT JOIN WalmartListingQualityItem q ON q.sku=w.sku AND q.storeIndex=w.storeIndex
                LEFT JOIN WalmartSkuPerf perf ON perf.sku=w.sku AND perf.storeIndex=w.storeIndex`;
