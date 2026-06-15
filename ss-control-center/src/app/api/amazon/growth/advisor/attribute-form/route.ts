/**
 * GET /api/amazon/growth/advisor/attribute-form?storeIndex&sku&attribute
 *
 * Returns the editable form for a set-attribute action: the value field + the
 * allowed enum values for each sub-field (e.g. unit_count.type ∈ Count/Fl Oz/
 * Ounce; item_weight.unit ∈ grams/pounds/…), plus the listing's current value so
 * the UI can pre-fill. Lets the operator pick a SCHEMA-VALID value before writing.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getMerchantToken } from "@/lib/amazon-sp-api/sellers";
import { getListing } from "@/lib/amazon-sp-api/listings";
import { MARKETPLACE_ID } from "@/lib/amazon-sp-api/client";
import { getAttributeForm } from "@/lib/amazon/growth/product-type-definitions";

export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const storeIndex = Number(sp.get("storeIndex") ?? 1);
  const sku = (sp.get("sku") ?? "").trim();
  const attribute = (sp.get("attribute") ?? "").trim();
  if (!sku || !attribute) return NextResponse.json({ ok: false, error: "sku and attribute required" }, { status: 400 });

  try {
    const sellerId = await getMerchantToken(storeIndex);
    // productType + current value from the live listing.
    const listing = await getListing(storeIndex, sellerId, sku);
    const summary = listing.summaries?.find((s) => s.marketplaceId === MARKETPLACE_ID) ?? listing.summaries?.[0];
    const productType = summary?.productType;
    if (!productType) return NextResponse.json({ ok: false, error: "no productType" }, { status: 422 });

    const form = await getAttributeForm(storeIndex, productType, attribute);
    if (!form) return NextResponse.json({ ok: false, error: "attribute not in schema" }, { status: 404 });

    // Current value (to pre-fill the operator's choice).
    const attrs = (listing.attributes ?? {}) as Record<string, Array<Record<string, unknown>> | undefined>;
    const cur = attrs[attribute]?.[0] ?? null;
    const currentValue = cur?.[form.valueField ?? "value"];
    const currentSub: Record<string, string> = {};
    for (const ef of form.enumFields) {
      const raw = cur?.[ef.name];
      const v = ef.nested ? (raw as { value?: string } | undefined)?.value : (raw as string | undefined);
      if (typeof v === "string") currentSub[ef.name] = v;
    }

    return NextResponse.json({
      ok: true,
      productType,
      form,
      current: { value: currentValue ?? null, sub: currentSub },
    });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 502 });
  }
}
