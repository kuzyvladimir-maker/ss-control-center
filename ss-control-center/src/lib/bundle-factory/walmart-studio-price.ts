/**
 * The price a Walmart studio listing sells at.
 *
 * Promotion used to fall back to the Amazon cost model whenever a draft carried
 * no sealed studio economics — cooler bands, FBA fees, a marketplace this
 * listing never touches. That model priced the Campbell's Pack-of-6 at $37.68
 * against the owner's rule of $43.10, and it did so silently on every publish,
 * so repricing the draft by hand was undone the next time it went out.
 *
 * The price is therefore solved here, from the same inputs the build used: the
 * goods, the packaging, the shipping label, and the exact shipping template
 * sealed into the work item — targeting return on invested capital, which is
 * the owner's rule (see docs/wiki/walmart-studio-pricing-roi.md).
 */

import { prisma } from "@/lib/prisma";
import { getWalmartClient } from "@/lib/walmart/client";
import {
  calculateWalmartStudioDraftEconomics,
  WALMART_STUDIO_DEFAULT_PACKAGING_COST_CENTS,
  WALMART_STUDIO_DEFAULT_SHIPPING_LABEL_CENTS,
} from "./walmart-studio-draft-economics";
import {
  parseWalmartShippingTemplateDetails,
  type WalmartShippingTemplateDetails,
} from "./walmart-shipping-templates";

/** Templates change rarely and the same one prices a whole batch. */
const TEMPLATE_TTL_MS = 10 * 60 * 1000;
const templateCache = new Map<
  string,
  { at: number; value: WalmartShippingTemplateDetails }
>();

async function shippingTemplate(
  templateId: string,
  now: number,
): Promise<WalmartShippingTemplateDetails> {
  const hit = templateCache.get(templateId);
  if (hit && now - hit.at < TEMPLATE_TTL_MS) return hit.value;
  const raw = await getWalmartClient(1).requestRaw(
    "GET",
    `/settings/shipping/templates/${templateId}`,
    {},
  );
  const value = parseWalmartShippingTemplateDetails(raw.body);
  templateCache.set(templateId, { at: now, value });
  return value;
}

export interface WalmartStudioPriceInput {
  draftId: string;
  goodsCostCents: number;
  packageWeightOz: number;
}

/**
 * Solve the listing price for this draft, or return null when this is not a
 * studio draft with a sealed shipping template — in which case the caller keeps
 * whatever pricing it would otherwise use.
 */
export async function walmartStudioRoiPriceCents(
  input: WalmartStudioPriceInput,
): Promise<number | null> {
  const workItem = await prisma.generationWorkItem.findFirst({
    where: { bundle_draft_id: input.draftId },
    orderBy: { created_at: "desc" },
    select: { spec_json: true, generation_job: { select: { brief: true } } },
  });
  if (!workItem?.spec_json) return null;

  let templateId = "";
  try {
    const spec = JSON.parse(workItem.spec_json) as { shipping_template_id?: unknown };
    templateId = typeof spec.shipping_template_id === "string"
      ? spec.shipping_template_id.trim()
      : "";
  } catch {
    return null;
  }
  if (!templateId) return null;

  let packagingCostCents = WALMART_STUDIO_DEFAULT_PACKAGING_COST_CENTS;
  let shippingLabelCents = WALMART_STUDIO_DEFAULT_SHIPPING_LABEL_CENTS;
  try {
    const brief = JSON.parse(workItem.generation_job?.brief ?? "{}") as {
      pricing_inputs?: { packaging_cost_cents?: number; shipping_label_cents?: number };
    };
    if (Number.isSafeInteger(brief.pricing_inputs?.packaging_cost_cents)) {
      packagingCostCents = brief.pricing_inputs!.packaging_cost_cents!;
    }
    if (Number.isSafeInteger(brief.pricing_inputs?.shipping_label_cents)) {
      shippingLabelCents = brief.pricing_inputs!.shipping_label_cents!;
    }
  } catch {
    // Defaults are the documented studio inputs; a malformed brief is not a
    // reason to price with someone else's cost model.
  }

  const template = await shippingTemplate(templateId, Date.now());
  const economics = calculateWalmartStudioDraftEconomics({
    goodsCostCents: input.goodsCostCents,
    packagingCostCents,
    shippingLabelCents,
    packageWeightOz: input.packageWeightOz,
    template,
  });
  return economics.item_price_cents;
}
