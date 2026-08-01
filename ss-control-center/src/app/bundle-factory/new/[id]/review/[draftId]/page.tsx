import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { PageHead } from "@/components/kit";
import { prisma } from "@/lib/prisma";

import {
  WalmartBuyerPreview,
  type WalmartBuyerPreviewData,
} from "./WalmartBuyerPreview";

export const dynamic = "force-dynamic";

interface EconomicsSnapshot {
  item_price_cents: number;
  minimum_customer_shipping_charge_cents: number;
  maximum_customer_shipping_charge_cents: number;
  minimum_customer_total_cents: number;
  maximum_customer_total_cents: number;
  target_margin_bps: number;
  shipping_template_name: string;
}

interface ComponentSnapshot {
  product_name?: string;
  donor_image_urls?: unknown;
  product_truth_component?: {
    product_name?: string;
    content_observation_id?: string;
    facts?: {
      ingredients?: string | null;
      allergens?: unknown;
      nutrition_facts?: unknown;
      attributes?: {
        _exact_image_urls?: unknown;
      };
    };
  };
}

function parseJson<T>(value: string | null | undefined): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
      ).map((entry) => entry.trim())
    : [];
}

function positiveCents(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function exactEconomics(value: string | null): EconomicsSnapshot | null {
  const parsed = parseJson<{ economics?: Partial<EconomicsSnapshot> }>(value);
  const economics = parsed?.economics;
  if (!economics) return null;
  const itemPrice = positiveCents(economics.item_price_cents);
  const minShipping = positiveCents(
    economics.minimum_customer_shipping_charge_cents,
  );
  const maxShipping = positiveCents(
    economics.maximum_customer_shipping_charge_cents,
  );
  const minTotal = positiveCents(economics.minimum_customer_total_cents);
  const maxTotal = positiveCents(economics.maximum_customer_total_cents);
  if (
    itemPrice === null || minShipping === null || maxShipping === null ||
    minTotal === null || maxTotal === null ||
    !Number.isSafeInteger(economics.target_margin_bps) ||
    typeof economics.shipping_template_name !== "string" ||
    !economics.shipping_template_name.trim()
  ) {
    return null;
  }
  return {
    item_price_cents: itemPrice,
    minimum_customer_shipping_charge_cents: minShipping,
    maximum_customer_shipping_charge_cents: maxShipping,
    minimum_customer_total_cents: minTotal,
    maximum_customer_total_cents: maxTotal,
    target_margin_bps: Number(economics.target_margin_bps),
    shipping_template_name: economics.shipping_template_name,
  };
}

export default async function WalmartDraftBuyerPreviewPage({
  params,
}: {
  params: Promise<{ id: string; draftId: string }>;
}) {
  const { id, draftId } = await params;
  const workItem = await prisma.generationWorkItem.findFirst({
    where: {
      generation_job_id: id,
      bundle_draft_id: draftId,
      status: "SUCCEEDED",
    },
    include: {
      generation_job: true,
      bundle_draft: {
        include: {
          generated_content: {
            where: { channel: "WALMART" },
            orderBy: { created_at: "asc" },
          },
        },
      },
    },
  });
  const draft = workItem?.bundle_draft;
  if (!workItem || !draft) notFound();
  const brief = parseJson<{ workflow?: string }>(workItem.generation_job.brief);
  if (brief?.workflow !== "CANONICAL_WALMART_NEW_SKU") notFound();
  const content = draft.generated_content[0];
  const economics = exactEconomics(draft.approval_notes);
  const components = parseJson<ComponentSnapshot[]>(draft.draft_components);
  const snapshot = components?.[0];
  const truth = snapshot?.product_truth_component;
  if (!content || !economics || !snapshot || !truth?.content_observation_id) {
    notFound();
  }

  const images: string[] = [];
  const seen = new Set<string>();
  const addImage = (value: unknown) => {
    if (typeof value !== "string" || !value.trim() || seen.has(value.trim())) return;
    seen.add(value.trim());
    images.push(value.trim());
  };
  addImage(draft.draft_main_image_url);
  for (const image of stringArray(snapshot.donor_image_urls)) addImage(image);
  for (const image of stringArray(truth.facts?.attributes?._exact_image_urls)) {
    addImage(image);
  }
  for (const image of stringArray(parseJson(draft.draft_secondary_images))) {
    addImage(image);
  }
  if (images.length === 0) notFound();

  const data: WalmartBuyerPreviewData = {
    title: content.title,
    brand: draft.brand,
    packCount: draft.pack_count,
    images,
    bullets: parseJson<string[]>(content.bullets_json) ?? [],
    description: content.description,
    itemPriceCents: economics.item_price_cents,
    buyerShippingMinimumCents:
      economics.minimum_customer_shipping_charge_cents,
    buyerShippingMaximumCents:
      economics.maximum_customer_shipping_charge_cents,
    customerTotalMinimumCents: economics.minimum_customer_total_cents,
    customerTotalMaximumCents: economics.maximum_customer_total_cents,
    shippingTemplateName: economics.shipping_template_name,
    targetMarginBps: economics.target_margin_bps,
    ingredients: truth.facts?.ingredients ?? null,
    allergens: truth.facts?.allergens ?? null,
    nutritionFacts: truth.facts?.nutrition_facts ?? null,
    category: draft.category === "SHELF_STABLE"
      ? "Shelf-stable food"
      : draft.category.replaceAll("_", " ").toLowerCase(),
    sourceTitle: truth.product_name ?? snapshot.product_name ?? draft.draft_name,
    sourceObservationId: truth.content_observation_id,
  };

  return (
    <>
      <PageHead
        title="Walmart buyer preview"
        subtitle={
          <span>
            Exact Product Truth draft · Pack of {draft.pack_count} · internal review only
          </span>
        }
      />
      <Link
        href={`/bundle-factory/new/${id}/review`}
        className="mb-4 inline-flex items-center gap-1 text-[12px] text-ink-3 hover:text-ink"
      >
        <ArrowLeft size={14} strokeWidth={1.8} /> Back to all Walmart drafts
      </Link>
      <WalmartBuyerPreview data={data} />
    </>
  );
}
