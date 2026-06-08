/**
 * Walmart Growth — diagnosis engine ("the doctor").
 *
 * Turns the raw scanned data (Listing Quality score + per-item issues + Buy Box
 * + live shipping templates) into a RANKED, plain-language list of problems,
 * each with: what's wrong, why it hurts sales, how many items, the fix, and an
 * ACTION the operator can run (auto / semi-auto / manual / gated). This is the
 * brain behind the Action Center — not a data dump, but "here's your #1 problem
 * and here's the button to fix it".
 *
 * Pure analysis over data we already store + a couple of cheap live reads
 * (shipping templates). No writes.
 */

import type { PrismaClient } from "@/generated/prisma/client";
import type { WalmartClient } from "./client";

export type Severity = "critical" | "high" | "medium" | "low";
/** auto = one click runs it fully; semi = preview then apply; manual = needs a
 *  human/ops decision; gated = blocked on a dependency (e.g. COGS). */
export type ActionKind = "auto" | "semi" | "manual" | "gated";

export interface GrowthAction {
  kind: ActionKind;
  label: string;
  /** API route the button calls (for auto/semi). */
  endpoint?: string;
  /** UI filter to jump the worklist to the affected items. */
  jumpFilter?: string;
  note?: string;
}

export interface GrowthDiagnosis {
  id: string;
  severity: Severity;
  title: string;
  /** What's wrong, plainly. */
  problem: string;
  /** Why it costs sales (Walmart growth knowledge). */
  why: string;
  itemsAffected: number | null;
  /** Short metric badge, e.g. "Shipping 14.9/100". */
  metric?: string;
  recommendation: string;
  action: GrowthAction;
}

export interface GrowthDiagnosisResult {
  generatedAt: string;
  sellerScore: number | null;
  headline: string;
  diagnoses: GrowthDiagnosis[];
  shipping: { maxTransitDays: number | null; templateCount: number; hasFastTemplate: boolean } | null;
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export async function diagnoseWalmartGrowth(
  prisma: PrismaClient,
  client: WalmartClient,
  storeIndex: number
): Promise<GrowthDiagnosisResult> {
  const snap = await prisma.walmartListingQualitySnapshot.findFirst({
    where: { storeIndex },
    orderBy: { capturedAt: "desc" },
  });

  const base = { storeIndex };
  const [
    outOfStockWithTraffic,
    noFastShip,
    noReviews,
    trafficNoConversion,
    lowContent,
    bbTotal,
    bbLosing,
    bbGap,
  ] = await Promise.all([
    prisma.walmartListingQualityItem.count({ where: { ...base, isInStock: false, pageViews30d: { gt: 0 } } }),
    prisma.walmartListingQualityItem.count({ where: { ...base, isFastAndFreeShipping: false } }),
    prisma.walmartListingQualityItem.count({ where: { ...base, ratingCount: 0 } }),
    prisma.walmartListingQualityItem.count({
      where: { ...base, pageViews30d: { gt: 0 }, OR: [{ conversionRate30d: 0 }, { conversionRate30d: null }] },
    }),
    prisma.walmartListingQualityItem.count({ where: { ...base, contentScore: { lt: 85 } } }),
    prisma.walmartBuyBoxItem.count({ where: base }),
    prisma.walmartBuyBoxItem.count({ where: { ...base, isWinner: false } }),
    prisma.walmartBuyBoxItem.aggregate({ where: { ...base, isWinner: false, priceGap: { gt: 0 } }, _sum: { priceGap: true } }),
  ]);

  // Cheap live read: shipping templates → max declared transit time.
  const shipping = await getShippingSummary(client).catch(() => null);

  const d: GrowthDiagnosis[] = [];

  // ── Shipping speed ──
  const shipScore = snap?.shippingScore ?? null;
  if ((shipScore != null && shipScore < 40) || noFastShip > 0) {
    const transit = shipping?.maxTransitDays;
    d.push({
      id: "shipping-speed",
      severity: "critical",
      title: "No fast-shipping tag on the catalog",
      problem:
        `${noFastShip.toLocaleString()} items carry no "fast & free" tag` +
        (transit ? `; shipping templates declare up to ${transit}-day transit.` : "."),
      why: "Walmart ranks fast/2-day offers far higher and a fast tag lifts conversion. With multi-day declared transit, items never qualify — this is the single biggest drag on the whole catalog.",
      itemsAffected: noFastShip,
      metric: shipScore != null ? `Shipping ${shipScore.toFixed(0)}/100` : undefined,
      recommendation:
        "Enroll in Walmart's Two-Day program and assign faster shipping templates to items you can genuinely ship in ≤2-3 days (dry/ambient first; WFS for eligible SKUs). Don't fake transit — late delivery is penalized.",
      action: {
        kind: "manual",
        label: "Review shipping strategy",
        note: "Editable via PUT /v3/settings/shipping/templates, but it's a real delivery-promise decision.",
      },
    });
  }

  // ── Content gaps (AUTO-FIXABLE) ──
  if (lowContent > 0) {
    d.push({
      id: "content-gaps",
      severity: "high",
      title: "Fixable content gaps (missing attributes, spelling, titles)",
      problem: `${lowContent.toLocaleString()} items have content deductions — missing required attributes (e.g. nutrition label, manufacturer, material), spelling errors, or title-format issues.`,
      why: "Content & Discoverability drives search match and is the most directly fixable lever. Walmart's API tells us the exact missing field per item, so these can be auto-corrected (brand-voice-compliant) and pushed back.",
      itemsAffected: lowContent,
      metric: snap?.contentScore != null ? `Content ${snap.contentScore.toFixed(0)}/100` : undefined,
      recommendation: "Auto-generate compliant fixes (no emojis/promo words, curator disclaimer kept) and submit via the Items feed. Preview each before applying.",
      action: {
        kind: "semi",
        label: "See per-item fixes",
        jumpFilter: "content",
        note: "One-click auto-write (Claude-generated, brand-voice-compliant → Items feed) is the next increment; per-SKU fixes are already listed in the worklist.",
      },
    });
  }

  // ── Out of stock with traffic ──
  if (outOfStockWithTraffic > 0) {
    d.push({
      id: "oos-traffic",
      severity: "high",
      title: "Out-of-stock items that still get traffic",
      problem: `${outOfStockWithTraffic.toLocaleString()} items are out of stock but shoppers still land on them — guaranteed lost sales.`,
      why: "An OOS listing can't convert and quietly drags the 'published & in stock' score. Either restock the ones worth selling or retire the dead ones to focus the catalog.",
      itemsAffected: outOfStockWithTraffic,
      recommendation: "Restock sellable items; retire chronically-dead ones (we can zero them across all ship nodes in one click).",
      action: { kind: "manual", label: "Review OOS items", jumpFilter: "outOfStock" },
    });
  }

  // ── Buy Box ──
  if (bbTotal > 0 && bbLosing > 0) {
    const gap = bbGap._sum.priceGap ?? 0;
    d.push({
      id: "buybox-loss",
      severity: "high",
      title: "Losing the Buy Box",
      problem: `${bbLosing.toLocaleString()} items lose the Buy Box; closing the price gap on the ones we're above would cost ~$${gap.toFixed(2)} total across the catalog.`,
      why: "On a shared listing the Buy Box offer is the one that sells. If we don't hold it, our traffic converts for someone else — the direct cause of 'traffic but no sale'.",
      itemsAffected: bbLosing,
      recommendation: "Reprice to win the Buy Box where margin allows — needs reliable per-SKU cost (COGS) to protect a ≥20% margin. Pricing module is blocked on the COGS work.",
      action: { kind: "gated", label: "Pricing (needs COGS)", note: "Waiting on the parallel COGS module before writing prices." },
    });
  } else if (trafficNoConversion > 0) {
    // Buy Box report not in yet, but we can still flag the symptom from LQ.
    d.push({
      id: "traffic-no-sale",
      severity: "high",
      title: "Traffic but no sales",
      problem: `${trafficNoConversion.toLocaleString()} items get views but convert near zero.`,
      why: "Usually a Buy Box loss or uncompetitive price. The Buy Box report (generating) will pinpoint each; until then, check stock + price competitiveness.",
      itemsAffected: trafficNoConversion,
      recommendation: "Wait for the Buy Box report to localize the cause, then reprice/restock the high-traffic offenders first.",
      action: { kind: "manual", label: "Review traffic-no-sale", jumpFilter: "trafficNoConversion" },
    });
  }

  // ── Reviews ──
  if (noReviews > 0) {
    d.push({
      id: "no-reviews",
      severity: "medium",
      title: "Almost no reviews",
      problem: `${noReviews.toLocaleString()} items have zero ratings.`,
      why: "Ratings & Reviews is a heavy ranking + trust factor. New offers without reviews convert poorly.",
      itemsAffected: noReviews,
      metric: snap?.ratingReviewScore != null ? `Reviews ${snap.ratingReviewScore.toFixed(0)}/100` : undefined,
      recommendation: "Enroll eligible items in Walmart's Review Accelerator / first-review program (Seller Center). Not exposed via API.",
      action: { kind: "manual", label: "Review Accelerator (Seller Center)" },
    });
  }

  d.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (b.itemsAffected ?? 0) - (a.itemsAffected ?? 0));

  const top = d[0];
  const headline = top
    ? `Top priority: ${top.title.toLowerCase()} (${top.itemsAffected?.toLocaleString() ?? "?"} items).`
    : "No major issues detected.";

  return {
    generatedAt: new Date().toISOString(),
    sellerScore: snap?.listingQuality ?? null,
    headline,
    diagnoses: d,
    shipping,
  };
}

/** Read shipping templates and summarize the worst declared transit time. */
async function getShippingSummary(
  client: WalmartClient
): Promise<{ maxTransitDays: number | null; templateCount: number; hasFastTemplate: boolean }> {
  const res = await client.requestRaw("GET", "/settings/shipping/templates");
  const body = res.body as { shippingTemplates?: Array<{ id: string }> } | undefined;
  const templates = body?.shippingTemplates ?? [];
  let maxTransit = 0;
  let minTransit = Infinity;
  // Sample the first few templates' details for transit times (cheap).
  for (const t of templates.slice(0, 3)) {
    try {
      const det = (await client.requestRaw("GET", `/settings/shipping/templates/${t.id}`)).body as {
        shippingMethods?: Array<{ configurations?: Array<{ transitTime?: number }> }>;
      };
      for (const m of det.shippingMethods ?? []) {
        for (const c of m.configurations ?? []) {
          if (typeof c.transitTime === "number") {
            maxTransit = Math.max(maxTransit, c.transitTime);
            minTransit = Math.min(minTransit, c.transitTime);
          }
        }
      }
    } catch {
      /* skip template on error */
    }
  }
  return {
    maxTransitDays: maxTransit || null,
    templateCount: templates.length,
    hasFastTemplate: minTransit !== Infinity && minTransit <= 3,
  };
}
