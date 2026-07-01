/**
 * GET  /api/bundle-factory/pricing  → the active pricing model
 * POST /api/bundle-factory/pricing  → update the GLOBAL pricing model
 *      Body: { markup?: number; min_price_cents?: number }
 *
 * The factory prices every listing automatically from the bundle's goods cost
 * (COGS): `price = max(min_price, ceil(cogs × markup))` (see pricing-config.ts).
 * Vladimir configures that ONE model here; there is no per-listing manual price.
 *
 * The draft-detail price modal calls this so the operator can see the formula
 * and, if they want, adjust the markup / floor. A change here re-prices every
 * listing on its next compute — it is a global knob, labelled as such in the UI.
 */

import { NextResponse } from "next/server";
import { readJson, badRequest, withErrorHandler } from "@/lib/bundle-factory/api-utils";
import { prisma } from "@/lib/prisma";
import {
  getPricingModel,
  PRICING_MARKUP_SETTING_KEY,
  PRICING_MIN_PRICE_SETTING_KEY,
} from "@/lib/bundle-factory/pricing-config";

export const dynamic = "force-dynamic";

interface Body {
  markup?: unknown;
  min_price_cents?: unknown;
}

export const GET = withErrorHandler("bundle-factory/pricing[GET]", async () => {
  const model = await getPricingModel();
  return NextResponse.json({ ok: true, model });
});

export const POST = withErrorHandler(
  "bundle-factory/pricing[POST]",
  async (request: Request) => {
    const body = (await readJson<Body>(request)) ?? {};

    // markup — a plain multiple ≥ 1 (below 1 would price under cost).
    let markup: number | undefined;
    if (body.markup != null) {
      const n =
        typeof body.markup === "number" ? body.markup : Number(body.markup);
      if (!Number.isFinite(n) || n < 1 || n > 100) {
        return badRequest("markup must be a number between 1 and 100 (e.g. 3 = 3×).");
      }
      markup = Math.round(n * 1000) / 1000;
    }

    // min price floor — cents ≥ 0.
    let minPriceCents: number | undefined;
    if (body.min_price_cents != null) {
      const n =
        typeof body.min_price_cents === "number"
          ? body.min_price_cents
          : Number(body.min_price_cents);
      if (!Number.isFinite(n) || n < 0 || n > 100_000_00) {
        return badRequest("min_price_cents must be a non-negative number of cents.");
      }
      minPriceCents = Math.round(n);
    }

    if (markup === undefined && minPriceCents === undefined) {
      return badRequest("provide markup and/or min_price_cents.");
    }

    if (markup !== undefined) {
      await prisma.setting.upsert({
        where: { key: PRICING_MARKUP_SETTING_KEY },
        create: { key: PRICING_MARKUP_SETTING_KEY, value: String(markup) },
        update: { value: String(markup) },
      });
    }
    if (minPriceCents !== undefined) {
      await prisma.setting.upsert({
        where: { key: PRICING_MIN_PRICE_SETTING_KEY },
        create: {
          key: PRICING_MIN_PRICE_SETTING_KEY,
          value: String(minPriceCents),
        },
        update: { value: String(minPriceCents) },
      });
    }

    const model = await getPricingModel();
    return NextResponse.json({ ok: true, model });
  },
);
