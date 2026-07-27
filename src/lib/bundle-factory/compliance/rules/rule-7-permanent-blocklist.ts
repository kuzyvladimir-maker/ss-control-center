// Rule 7 — Permanent blocklist (BrandConflict table).
//
// The 5 ASINs that got the RETAILER account banned on 2026-05-17 are
// seeded into `BrandConflict` (Phase 2.0a seed). A match is "foreign
// brand substring appears in title" AND "any one of the product_keywords
// appears in title". Both checks are case-insensitive substring.
//
// We deliberately match against title only — bullets and description
// reference brands legitimately (curated gift basket positioning); the
// title is where the brand-association implication lives.
//
// HARD BLOCK. Vladimir manages the table via the UI (Phase 2.0 Step 4
// "Brand Conflicts" tab) and via `scripts/seed-brand-conflicts.ts`.

import { prisma } from "@/lib/prisma";
import type { ComplianceInput, RuleResult } from "../types";

export async function rulePermanentBlocklist(
  input: ComplianceInput,
): Promise<RuleResult> {
  const title = (input.title || "").toLowerCase();
  if (!title) {
    return { rule_id: "rule-7-permanent-blocklist", passed: true };
  }

  const active = await prisma.brandConflict.findMany({
    where: { status: "active" },
    select: {
      id: true,
      asin: true,
      foreign_brand: true,
      product_keywords: true,
      incident_date: true,
    },
  });

  const matches: Array<{
    conflict_id: string;
    incident_asin: string | null;
    foreign_brand: string;
    matched_keyword: string;
  }> = [];

  for (const conflict of active) {
    const brandLower = (conflict.foreign_brand || "").toLowerCase();
    if (!brandLower || !title.includes(brandLower)) continue;

    let keywords: string[] = [];
    try {
      const parsed = JSON.parse(conflict.product_keywords);
      if (Array.isArray(parsed)) {
        keywords = parsed.filter((k): k is string => typeof k === "string");
      }
    } catch {
      // Malformed JSON — treat as no keywords; brand-only match is not
      // strong enough on its own to block (would over-fire on "Kraft"
      // appearing in legitimate text).
      continue;
    }

    for (const kw of keywords) {
      const kwLower = kw.toLowerCase().trim();
      if (kwLower && title.includes(kwLower)) {
        matches.push({
          conflict_id: conflict.id,
          incident_asin: conflict.asin,
          foreign_brand: conflict.foreign_brand,
          matched_keyword: kw,
        });
        break; // one keyword-match per conflict is enough
      }
    }
  }

  if (matches.length === 0) {
    return {
      rule_id: "rule-7-permanent-blocklist",
      passed: true,
      details: { active_conflicts_checked: active.length },
    };
  }

  return {
    rule_id: "rule-7-permanent-blocklist",
    passed: false,
    reason: "permanent_blocklist_match",
    details: {
      matches,
      active_conflicts_checked: active.length,
    },
  };
}
