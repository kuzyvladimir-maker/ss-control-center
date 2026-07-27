// Risk scoring for a single audited listing.
//
// Five additive rules, each contributing a penalty (no rule contributes
// negative — there is no "trust score"). Cumulative score is capped at
// 100 and bucketed:
//   ≥80 BLOCKED   (matches the incident pattern, take immediate action)
//   50–79 WARNING (partial match, recommended remediation)
//   20–49 LOW_RISK (minor issues, e.g. disclaimer missing)
//   0–19 COMPLIANT (no action needed)
//
// Vision check (rule 5) is skipped when score has already reached 80,
// since the listing is BLOCKED regardless and the ~$0.01–0.02 Sonnet
// call is wasted. This is the main cost-control lever — a 1k-listing
// scan with say 5% already-BLOCKED costs ~$10 instead of ~$15.

import { prisma } from "@/lib/prisma";
import {
  FOREIGN_BRAND_NAMES,
  OWN_BRANDS,
  GIFT_BASKET_EXCEPTION_NODES,
} from "./forbidden-brands";
import {
  detectForeignLogosInImage,
  type VisionCheckResult,
} from "./vision-check";

export type RiskCategory = "BLOCKED" | "WARNING" | "LOW_RISK" | "COMPLIANT";

export interface RiskResult {
  score: number;
  category: RiskCategory;
  reasons: string[];
  detected_brands: string[];
  detected_logos: string[];
  vision_cost_cents: number;
  vision_error?: string;
}

function categorise(score: number): RiskCategory {
  if (score >= 80) return "BLOCKED";
  if (score >= 50) return "WARNING";
  if (score >= 20) return "LOW_RISK";
  return "COMPLIANT";
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`);
}

/** Match a foreign brand as a whole word (case-insensitive). Falls back
 *  to a substring match for names ending with punctuation like
 *  "Oh Snap!" where \b would refuse to fire on the trailing exclamation. */
function brandAppears(brand: string, text: string): boolean {
  const escaped = escapeRegex(brand);
  // `\b` requires a word boundary on both sides. If the brand ends with
  // a non-word character (! ' etc), the right side is checked manually.
  const endsWithWordChar = /\w$/.test(brand);
  const re = endsWithWordChar
    ? new RegExp(`\\b${escaped}\\b`, "i")
    : new RegExp(`\\b${escaped}(?=\\s|$|[^\\w])`, "i");
  return re.test(text);
}

function hasDisclaimer(bullets: string[], description: string): boolean {
  const allText = bullets.join(" ") + " " + description;
  // Three acceptable disclaimer shapes (per gift-set-policy.md):
  //   "Salutem Solutions LLC … curates/assembles…"
  //   "curated by Salutem"
  //   "assembled by Salutem Solutions"
  // We match the strongest two patterns; the second is a weaker catch-all.
  return (
    /salutem solutions llc.{0,200}(curates|assembles|assembled)/i.test(
      allText,
    ) ||
    /curated.{0,100}by salutem/i.test(allText) ||
    /assembled by salutem solutions/i.test(allText)
  );
}

export interface ScoreOptions {
  /** When provided, skip the live Vision API call and use these logos
   *  as Rule 5's input. Used by scripts/rescore-audit-scan.ts to
   *  re-evaluate stored detections through new filters without paying
   *  for Vision again. `vision_cost_cents` stays at 0 in that path. */
  precomputedLogos?: {
    has_foreign_logos: boolean;
    detected_logos: string[];
  };
}

/**
 * Run all 5 rules against a stored ListingAuditResult and persist the
 * computed score + category back to the row. Returns the RiskResult so
 * callers (e.g. the scan orchestrator) can aggregate counters without
 * re-querying.
 */
export async function scoreAuditResult(
  resultId: string,
  opts: ScoreOptions = {},
): Promise<RiskResult> {
  const result = await prisma.listingAuditResult.findUniqueOrThrow({
    where: { id: resultId },
  });

  let score = 0;
  const reasons: string[] = [];
  const detected_brands: string[] = [];
  let detected_logos: string[] = [];
  let vision_cost_cents = 0;
  let vision_error: string | undefined;

  // ── Rule 1: Permanent blocklist match (by ASIN) ──
  // The 5 blocked-on-2026-05-17 ASINs are guaranteed BLOCKED here even
  // before we look at any text — Amazon already proved the case.
  const blocklistMatch = await prisma.brandConflict.findFirst({
    where: { asin: result.asin, status: "active" },
  });
  if (blocklistMatch) {
    score += 80;
    reasons.push(
      `Matches permanent blocklist (incident ${blocklistMatch.incident_date
        .toISOString()
        .slice(0, 10)}): ${blocklistMatch.foreign_brand}`,
    );
  }

  // ── Rule 2: Foreign brand in title under an own brand ──
  // Only fires when the seller is Salutem Vita / Starfit — third-party
  // resellers selling Kraft as Kraft are not our concern.
  const lowerOwn = result.brand.toLowerCase();
  const isOwnBrand = OWN_BRANDS.some((b) => lowerOwn.includes(b.toLowerCase()));
  if (isOwnBrand) {
    for (const fb of FOREIGN_BRAND_NAMES) {
      if (brandAppears(fb, result.title)) {
        score += 40;
        detected_brands.push(fb);
        reasons.push(
          `Foreign brand "${fb}" in title under own brand "${result.brand}"`,
        );
        // First match contributes the full 40, additional brands stack
        // by +10 each — multi-brand violations are progressively worse.
        for (const fb2 of FOREIGN_BRAND_NAMES) {
          if (fb2 === fb) continue;
          if (
            brandAppears(fb2, result.title) &&
            !detected_brands.includes(fb2)
          ) {
            score += 10;
            detected_brands.push(fb2);
            reasons.push(`Additional foreign brand "${fb2}" in title`);
          }
        }
        break;
      }
    }
  }

  // ── Rule 3: Missing disclaimer ──
  // Even when no foreign brand is in the title, a Salutem Vita listing
  // is expected to carry a "curated/assembled by Salutem Solutions LLC"
  // line per gift-set-policy.md. Missing is a soft signal (+15).
  const bullets: string[] = (() => {
    try {
      const parsed = JSON.parse(result.original_bullets);
      return Array.isArray(parsed) ? parsed.filter((b) => typeof b === "string") : [];
    } catch {
      return [];
    }
  })();
  if (isOwnBrand && !hasDisclaimer(bullets, result.original_description)) {
    score += 15;
    reasons.push("Missing curator/assembler disclaimer");
  }

  // ── Rule 4: Foreign brands present + wrong category ──
  // Multi-brand under Gift Basket Exception node is allowed; outside
  // those nodes it's a meaningful escalation (+30).
  if (
    detected_brands.length > 0 &&
    result.browse_node &&
    !GIFT_BASKET_EXCEPTION_NODES.includes(
      result.browse_node as (typeof GIFT_BASKET_EXCEPTION_NODES)[number],
    )
  ) {
    score += 30;
    reasons.push(
      `Foreign brands present but browse node "${result.browse_node}" is not Gift Basket Exception`,
    );
  }

  // ── Rule 5: Image vision check ──
  // Skip when we already crossed BLOCKED to save API spend. Failure of
  // the vision call doesn't down-rank the listing — error captured for
  // the scan run record. When `opts.precomputedLogos` is passed, we
  // use that instead of calling Vision (offline re-scoring path).
  let visionResult: VisionCheckResult | null = null;
  if (score < 80 && (result.main_image_url || opts.precomputedLogos)) {
    if (opts.precomputedLogos) {
      visionResult = {
        has_foreign_logos: opts.precomputedLogos.has_foreign_logos,
        detected_logos: opts.precomputedLogos.detected_logos,
        cost_cents: 0,
      };
    } else {
      visionResult = await detectForeignLogosInImage(
        result.main_image_url!,
        result.brand,
      );
    }
    vision_cost_cents = visionResult.cost_cents;
    if (visionResult.error) vision_error = visionResult.error;
    if (visionResult.has_foreign_logos) {
      score += 35;
      detected_logos = visionResult.detected_logos;
      reasons.push(
        `Foreign logos detected in main image: ${visionResult.detected_logos.join(
          ", ",
        )}`,
      );
    }
  }

  score = Math.min(score, 100);
  const category = categorise(score);

  // Preserve the historical vision_cost_cents value when re-scoring with
  // precomputedLogos — the spend really happened during the original
  // scan; we just don't pay for it again. Live (non-precomputed) path
  // writes the freshly-observed cost as before.
  const persistedVisionCost = opts.precomputedLogos
    ? result.vision_cost_cents
    : vision_cost_cents;

  await prisma.listingAuditResult.update({
    where: { id: resultId },
    data: {
      risk_score: score,
      risk_category: category,
      risk_reasons: JSON.stringify(reasons),
      detected_brands: detected_brands.length
        ? JSON.stringify(detected_brands)
        : null,
      detected_logos: detected_logos.length
        ? JSON.stringify(detected_logos)
        : null,
      vision_cost_cents: persistedVisionCost,
    },
  });

  return {
    score,
    category,
    reasons,
    detected_brands,
    detected_logos,
    vision_cost_cents,
    vision_error,
  };
}
