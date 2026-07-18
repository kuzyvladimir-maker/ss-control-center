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
  PRICING_MODE_SETTING_KEY,
  PRICING_TARGET_MARGIN_SETTING_KEY,
  PRICING_TARGET_ROI_SETTING_KEY,
  PRICING_FBA_FEE_SETTING_KEY,
  PRICING_CLOSING_FEE_SETTING_KEY,
  PRICING_OWN_SHIPPING_SETTING_KEY,
  PRICING_REFERRAL_PCT_SETTING_KEY,
  PRICING_SHIPPING_IN_PRICE_SETTING_KEY,
} from "@/lib/bundle-factory/pricing-config";

export const dynamic = "force-dynamic";

interface Body {
  mode?: unknown;
  markup?: unknown;
  target_margin_pct?: unknown;
  target_roi_pct?: unknown;
  min_price_cents?: unknown;
  fba_fee_cents?: unknown;
  closing_fee_cents?: unknown;
  own_shipping_cents?: unknown;
  referral_pct?: unknown;
  shipping_in_price?: unknown;
}

export const GET = withErrorHandler("bundle-factory/pricing[GET]", async () => {
  const model = await getPricingModel();
  return NextResponse.json({ ok: true, model });
});

export const POST = withErrorHandler(
  "bundle-factory/pricing[POST]",
  async (request: Request) => {
    const body = (await readJson<Body>(request)) ?? {};

    const writes: Array<{ key: string; value: string }> = [];

    // mode — all modes supported by the canonical pricing calculator.
    if (body.mode != null) {
      if (body.mode !== "margin" && body.mode !== "markup" && body.mode !== "roi") {
        return badRequest('mode must be "margin", "markup", or "roi".');
      }
      writes.push({ key: PRICING_MODE_SETTING_KEY, value: body.mode });
    }

    // markup — a plain multiple ≥ 1 (below 1 would price under cost).
    if (body.markup != null) {
      const n = num(body.markup);
      if (!Number.isFinite(n) || n < 1 || n > 100) {
        return badRequest("markup must be a number between 1 and 100 (e.g. 3 = 3×).");
      }
      writes.push({ key: PRICING_MARKUP_SETTING_KEY, value: String(Math.round(n * 1000) / 1000) });
    }

    // target margin — a fraction in [0, 0.95).
    if (body.target_margin_pct != null) {
      const n = num(body.target_margin_pct);
      if (!Number.isFinite(n) || n < 0 || n >= 0.95) {
        return badRequest("target_margin_pct must be a fraction between 0 and 0.95 (e.g. 0.35 = 35%).");
      }
      writes.push({ key: PRICING_TARGET_MARGIN_SETTING_KEY, value: String(Math.round(n * 10000) / 10000) });
    }

    if (body.target_roi_pct != null) {
      const n = num(body.target_roi_pct);
      if (!Number.isFinite(n) || n < 0 || n >= 0.95) {
        return badRequest("target_roi_pct must be a fraction between 0 and 0.95 (e.g. 0.70 = 70%).");
      }
      writes.push({ key: PRICING_TARGET_ROI_SETTING_KEY, value: String(Math.round(n * 10000) / 10000) });
    }

    // referral override — a fraction in [0, 0.95); empty string clears it.
    if (body.referral_pct === null || body.referral_pct === "") {
      writes.push({ key: PRICING_REFERRAL_PCT_SETTING_KEY, value: "" });
    } else if (body.referral_pct != null) {
      const n = num(body.referral_pct);
      if (!Number.isFinite(n) || n < 0 || n >= 0.95) {
        return badRequest("referral_pct must be a fraction between 0 and 0.95 (e.g. 0.15 = 15%).");
      }
      writes.push({ key: PRICING_REFERRAL_PCT_SETTING_KEY, value: String(Math.round(n * 10000) / 10000) });
    }

    if (body.shipping_in_price != null) {
      if (typeof body.shipping_in_price !== "boolean") {
        return badRequest("shipping_in_price must be a boolean.");
      }
      writes.push({
        key: PRICING_SHIPPING_IN_PRICE_SETTING_KEY,
        value: String(body.shipping_in_price),
      });
    }

    // cents fields — non-negative.
    for (const [field, key] of [
      ["min_price_cents", PRICING_MIN_PRICE_SETTING_KEY],
      ["fba_fee_cents", PRICING_FBA_FEE_SETTING_KEY],
      ["closing_fee_cents", PRICING_CLOSING_FEE_SETTING_KEY],
      ["own_shipping_cents", PRICING_OWN_SHIPPING_SETTING_KEY],
    ] as const) {
      const raw = (body as Record<string, unknown>)[field];
      if (raw == null) continue;
      const n = num(raw);
      if (!Number.isFinite(n) || n < 0 || n > 100_000_00) {
        return badRequest(`${field} must be a non-negative number of cents.`);
      }
      writes.push({ key, value: String(Math.round(n)) });
    }

    if (writes.length === 0) {
      return badRequest("provide at least one pricing field to update.");
    }

    await prisma.$transaction(
      writes.map((w) => prisma.setting.upsert({
        where: { key: w.key },
        create: { key: w.key, value: w.value },
        update: { value: w.value },
      })),
    );

    const model = await getPricingModel();
    return NextResponse.json({ ok: true, model });
  },
);

function num(v: unknown): number {
  return typeof v === "number" ? v : Number(v);
}
