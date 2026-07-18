/**
 * POST /api/bundle-factory/pricing/preview
 *   Body: { brand, unit_count, cogs_cents, weight_lb, category,
 *           model: Partial<PricingModel> }
 *
 * Live recompute for the draft-detail pricing calculator. Takes the bundle's
 * cost basis + the operator's IN-PROGRESS model edits and returns the full
 * cost-buildup result WITHOUT persisting anything. This keeps the modal's live
 * numbers on the SAME formula as promote-draft (computeListingPrice) so there is
 * one source of truth — no client-side duplicate. Saving is a separate call to
 * POST /api/bundle-factory/pricing.
 */

import { NextResponse } from "next/server";
import { readJson, withErrorHandler } from "@/lib/bundle-factory/api-utils";
import {
  getPricingModel,
  type PricingModel,
} from "@/lib/bundle-factory/pricing-config";
import { computeListingPrice } from "@/lib/bundle-factory/listing-pricing";

export const dynamic = "force-dynamic";

interface Body {
  cogs_cents?: unknown;
  weight_lb?: unknown;
  category?: unknown;
  brand?: unknown;
  unit_count?: unknown;
  model?: Partial<PricingModel> & Record<string, unknown>;
}

function n(v: unknown, fallback: number): number {
  const x = typeof v === "number" ? v : Number(v);
  return Number.isFinite(x) ? x : fallback;
}

export const POST = withErrorHandler(
  "bundle-factory/pricing/preview[POST]",
  async (request: Request) => {
    const body = (await readJson<Body>(request)) ?? {};

    // Start from the persisted model, then apply the in-progress edits so the
    // preview reflects exactly what the operator sees before saving.
    const base = await getPricingModel();
    const m = body.model ?? {};
    const model: PricingModel = {
      mode:
        m.mode === "markup" ? "markup" : m.mode === "roi" ? "roi" : m.mode === "margin" ? "margin" : base.mode,
      markup: Math.max(1, n(m.markup, base.markup)),
      target_margin_pct: Math.min(0.94, Math.max(0, n(m.target_margin_pct, base.target_margin_pct))),
      target_roi_pct: Math.max(0, n(m.target_roi_pct, base.target_roi_pct)),
      min_price_cents: Math.max(0, Math.round(n(m.min_price_cents, base.min_price_cents))),
      fba_fee_cents: Math.max(0, Math.round(n(m.fba_fee_cents, base.fba_fee_cents))),
      closing_fee_cents: Math.max(0, Math.round(n(m.closing_fee_cents, base.closing_fee_cents))),
      own_shipping_cents: Math.max(0, Math.round(n(m.own_shipping_cents, base.own_shipping_cents))),
      referral_pct_override:
        m.referral_pct_override == null || m.referral_pct_override === ("" as unknown)
          ? base.referral_pct_override
          : Math.min(0.94, Math.max(0, n(m.referral_pct_override, base.referral_pct_override ?? 0.15))),
      shipping_in_price:
        typeof m.shipping_in_price === "boolean" ? m.shipping_in_price : base.shipping_in_price,
    };

    const result = computeListingPrice(
      {
        brand: typeof body.brand === "string" ? body.brand : null,
        cogs_cents: Math.max(0, Math.round(n(body.cogs_cents, 0))),
        weight_lb:
          body.weight_lb == null ? null : Math.max(0, n(body.weight_lb, 0)) || null,
        category: typeof body.category === "string" ? body.category : null,
        unit_count:
          body.unit_count == null
            ? null
            : Math.max(0, Math.round(n(body.unit_count, 0))) || null,
      },
      model,
    );

    return NextResponse.json({ ok: true, result, model });
  },
);
