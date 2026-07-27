/**
 * GET /api/bundle-factory/marketplace-rules
 *     ?channel=AMAZON_SALUTEM|WALMART|...
 *     ?category=FROZEN_GROCERY|SHELF_STABLE|... (null-category rules
 *                                                 include unless excluded)
 *     ?key=title.max_length (substring match)
 *     ?current_only=true (default) — exclude superseded rules
 *
 * Read-only in Phase 1. Source-of-truth lives in
 * docs/marketplace-rules/*.md; this is just the hot-path DB cache.
 */

import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  badRequest,
  withErrorHandler,
} from "@/lib/bundle-factory/api-utils";
import {
  PRODUCT_CATEGORIES,
  SALES_CHANNELS,
  isOneOf,
} from "@/lib/bundle-factory/enums";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(
  "marketplace-rules",
  async (request: Request) => {
    const { searchParams } = new URL(request.url);
    const channel = searchParams.get("channel");
    const category = searchParams.get("category");
    const keyContains = searchParams.get("key");
    const currentOnly = searchParams.get("current_only") !== "false";

    if (channel && !isOneOf(SALES_CHANNELS, channel)) {
      return badRequest(`Invalid channel. Allowed: ${SALES_CHANNELS.join(", ")}`);
    }
    if (category && !isOneOf(PRODUCT_CATEGORIES, category)) {
      return badRequest(
        `Invalid category. Allowed: ${PRODUCT_CATEGORIES.join(", ")}`
      );
    }

    const where: Record<string, unknown> = {};
    if (channel) where.channel = channel;
    if (category) {
      // Either: rule is for the explicit category, OR rule is global
      // (category = null) and therefore applies to all categories.
      where.OR = [{ category }, { category: null }];
    }
    if (keyContains) where.rule_key = { contains: keyContains };
    if (currentOnly) where.is_current = true;

    const rules = await prisma.marketplaceRule.findMany({
      where,
      orderBy: [{ channel: "asc" }, { rule_key: "asc" }],
    });

    // Convenience: parse rule_value JSON so callers don't have to.
    const enriched = rules.map((r) => ({
      ...r,
      rule_value_parsed: safeParse(r.rule_value),
    }));

    return NextResponse.json({ rules: enriched, total: enriched.length });
  }
);

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
