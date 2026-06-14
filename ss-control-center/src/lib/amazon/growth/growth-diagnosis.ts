/**
 * Amazon Growth — diagnosis engine ("the doctor").
 *
 * Turns the computed Listing Health data (status, issues, suppression,
 * conversion, buy-box) into a RANKED, plain-language list of problems: what's
 * wrong, why it costs sales, how many listings, the fix, and an action the
 * operator can run. Pure analysis over the DB mirror — no writes.
 *
 * Mirror of Walmart's growth-diagnosis. Severity + action kinds are the same
 * vocabulary so the Action Center UI is shared in spirit.
 */

import type { PrismaClient } from "@/generated/prisma/client";

export type Severity = "critical" | "high" | "medium" | "low";
export type ActionKind = "auto" | "semi" | "manual" | "gated";

export interface GrowthAction {
  kind: ActionKind;
  label: string;
  endpoint?: string;
  jumpFilter?: string; // dashboard FilterId: suppressed | hasErrors | lowScore | notBuyable
  note?: string;
}

export interface GrowthDiagnosis {
  id: string;
  severity: Severity;
  title: string;
  problem: string;
  why: string;
  itemsAffected: number | null;
  metric?: string;
  recommendation: string;
  action: GrowthAction;
}

export interface GrowthDiagnosisResult {
  generatedAt: string;
  storeIndex: number;
  sellerScore: number | null;
  headline: string;
  diagnoses: GrowthDiagnosis[];
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

export async function diagnoseAmazonGrowth(
  prisma: PrismaClient,
  storeIndex: number,
): Promise<GrowthDiagnosisResult> {
  const snap = await prisma.amazonListingHealthSnapshot.findFirst({
    where: { storeIndex },
    orderBy: { capturedAt: "desc" },
  });

  const base = { storeIndex };
  const [
    suppressed,
    hasErrors,
    notBuyable,
    lowCompliance,
    trafficNoConversion,
    lowBuyBox,
    totalErrors,
  ] = await Promise.all([
    prisma.amazonListingHealthItem.count({ where: { ...base, isSuppressed: true } }),
    prisma.amazonListingHealthItem.count({ where: { ...base, errorIssueCount: { gt: 0 } } }),
    prisma.amazonListingHealthItem.count({ where: { ...base, isBuyable: false } }),
    prisma.amazonListingHealthItem.count({ where: { ...base, complianceScore: { lt: 85 } } }),
    prisma.amazonListingHealthItem.count({
      where: { ...base, sessions30d: { gte: 10 }, unitsOrdered30d: 0 },
    }),
    prisma.amazonListingHealthItem.count({
      where: { ...base, buyBoxPercentage: { lt: 90, not: null } },
    }),
    prisma.amazonListingHealthItem.aggregate({ where: base, _sum: { errorIssueCount: true } }),
  ]);

  const d: GrowthDiagnosis[] = [];

  // ── Search-suppressed (CRITICAL) ──
  if (suppressed > 0) {
    d.push({
      id: "suppressed",
      severity: "critical",
      title: "Search-suppressed listings",
      problem: `${suppressed.toLocaleString()} listings are search-suppressed — live but invisible in Amazon search.`,
      why: "A suppressed listing earns zero organic traffic and can't be found by shoppers. Usually a single missing required attribute (e.g. unit_count) — the highest-ROI fix on the catalog.",
      itemsAffected: suppressed,
      recommendation:
        "Open each suppressed listing's reason (from the FYP report) and supply the missing required attribute. Where we have the real value, the Optimizer can patch it; missing structural data waits on the sourcing harvest.",
      action: { kind: "semi", label: "Review suppressed", jumpFilter: "suppressed" },
    });
  }

  // ── ERROR-issue backlog (HIGH, partly auto-fixable) ──
  if (hasErrors > 0) {
    d.push({
      id: "issue-backlog",
      severity: "high",
      title: "Listing-issue backlog",
      problem: `${hasErrors.toLocaleString()} listings carry Amazon ERROR issues (${(totalErrors._sum.errorIssueCount ?? 0).toLocaleString()} errors total) — duplicate keywords, invalid/missing attributes, format problems.`,
      why: "Issues degrade or suppress listings and block the quality bar Amazon needs to feature an offer. Many are deterministic auto-fixes (e.g. dedupe a duplicated attribute) we can patch safely.",
      itemsAffected: hasErrors,
      metric: snap?.issuesScore != null ? `Issues ${snap.issuesScore.toFixed(0)}/100` : undefined,
      recommendation:
        "Run the Optimizer on the auto-fixable classes (duplicate attributes, emoji/promo scrub, disclaimer) with preview→apply. Structural data gaps route to harvest.",
      action: { kind: "semi", label: "See per-listing issues", jumpFilter: "hasErrors" },
    });
  }

  // ── Brand-voice / compliance (MEDIUM, auto-fixable) ──
  if (lowCompliance > 0) {
    d.push({
      id: "compliance",
      severity: "medium",
      title: "Brand-voice violations in titles",
      problem: `${lowCompliance.toLocaleString()} listings have promotional adjectives or emojis in the title (e.g. "premium", "ultimate").`,
      why: "Subjective/promotional claims violate Amazon policy (PDP code 99300) and our brand voice, and can trigger flags. They're a clean, deterministic scrub.",
      itemsAffected: lowCompliance,
      metric: snap?.complianceScore != null ? `Compliance ${snap.complianceScore.toFixed(0)}/100` : undefined,
      recommendation: "Scrub promo words/emojis from titles + bullets (brand-voice-compliant) and patch back. Preview each first.",
      action: { kind: "semi", label: "Review brand-voice fixes", jumpFilter: "lowScore" },
    });
  }

  // ── Traffic but no conversion (HIGH) ──
  if (trafficNoConversion > 0) {
    d.push({
      id: "traffic-no-sale",
      severity: "high",
      title: "Traffic but no sales",
      problem: `${trafficNoConversion.toLocaleString()} listings get real traffic (≥10 sessions) but convert zero units.`,
      why: "Views without sales point to a featured-offer loss, an uncompetitive price, weak content, or no reviews. These are existing demand we're failing to capture.",
      itemsAffected: trafficNoConversion,
      metric: snap?.conversionScore != null ? `Conversion ${snap.conversionScore.toFixed(0)}/100` : undefined,
      recommendation: "Check buy-box % and price on the highest-traffic offenders first; improve content/images where the offer is fine.",
      action: { kind: "manual", label: "Review traffic-no-sale" },
    });
  }

  // ── Losing the featured offer (MEDIUM, gated on pricing) ──
  if (lowBuyBox > 0) {
    d.push({
      id: "buybox",
      severity: "medium",
      title: "Losing the Featured Offer (Buy Box)",
      problem: `${lowBuyBox.toLocaleString()} listings hold the Featured Offer <90% of the time.`,
      why: "On a shared listing the Featured Offer is the one that sells; if we don't hold it our traffic converts for someone else.",
      itemsAffected: lowBuyBox,
      metric: snap?.buyBoxScore != null ? `Buy Box ${snap.buyBoxScore.toFixed(0)}/100` : undefined,
      recommendation: "Reprice to win where margin allows — needs reliable per-SKU COGS to protect ≥20% margin. Pricing is blocked on the parallel COGS work.",
      action: { kind: "gated", label: "Pricing (needs COGS)", note: "Waiting on the COGS module before writing prices." },
    });
  }

  // ── Not buyable (LOW, operational) ──
  if (notBuyable > 0) {
    d.push({
      id: "not-buyable",
      severity: "low",
      title: "Inactive (not buyable) listings",
      problem: `${notBuyable.toLocaleString()} listings are not buyable (no live offer / out of stock).`,
      why: "An inactive listing can't sell. Either restock the ones worth selling or retire dead SKUs to focus the catalog.",
      itemsAffected: notBuyable,
      recommendation: "Restock sellable items; retire chronically-dead ones.",
      action: { kind: "manual", label: "Review inactive", jumpFilter: "notBuyable" },
    });
  }

  d.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      (b.itemsAffected ?? 0) - (a.itemsAffected ?? 0),
  );

  const top = d[0];
  const headline = top
    ? `Top priority: ${top.title.toLowerCase()} (${top.itemsAffected?.toLocaleString() ?? "?"} listings).`
    : "No major issues detected.";

  return {
    generatedAt: new Date().toISOString(),
    storeIndex,
    sellerScore: snap?.healthScore ?? null,
    headline,
    diagnoses: d,
  };
}
