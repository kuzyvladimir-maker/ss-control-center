import { NextRequest, NextResponse } from "next/server";

import { requireModuleAccess } from "@/lib/auth-server";
import {
  WALMART_STUDIO_DEFAULT_PACKAGING_COST_CENTS,
  WALMART_STUDIO_DEFAULT_SHIPPING_LABEL_CENTS,
  WALMART_STUDIO_REFERRAL_FEE_BPS,
} from "@/lib/bundle-factory/walmart-studio-draft-economics";
import {
  WALMART_STUDIO_DRAFT_BRIEF_SCHEMA,
  WalmartStudioDraftContractError,
  buildWalmartStudioDraftWorkItems,
} from "@/lib/bundle-factory/walmart-studio-draft-contract";
import {
  parseWalmartDurableBuildPreparationBrief,
  prepareWalmartDurableBuildCollection,
} from "@/lib/bundle-factory/walmart-durable-build";
import {
  parseWalmartShippingTemplateDetails,
  parseWalmartShippingTemplateList,
} from "@/lib/bundle-factory/walmart-shipping-templates";
import { prisma } from "@/lib/prisma";
import {
  diagnoseProductTruthWalmartPilotRequest,
} from "@/lib/sourcing/product-truth-read-contract";
import {
  readProductTruthWalmartCollectionStatus,
} from "@/lib/sourcing/product-truth-web-control-admission";
import {
  loadProductTruthWebControlRuntime,
} from "@/lib/sourcing/product-truth-web-control-runtime";
import { openProductTruthWebReadClient } from
  "@/lib/sourcing/product-truth-web-read-client";
import { getWalmartClient, getWalmartStoreStatus } from "@/lib/walmart";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireModuleAccess(request, "bundle-factory");
  if (auth instanceof NextResponse) return auth;
  const { id } = await context.params;
  const job = await prisma.generationJob.findUnique({
    where: { id },
    include: { work_items: { orderBy: { spec_index: "asc" } } },
  });
  if (!job || (!auth.isAdmin && job.user_id !== auth.id)) {
    return NextResponse.json({ error: "Walmart build not found" }, { status: 404 });
  }
  let rawBrief: unknown;
  try {
    rawBrief = JSON.parse(job.brief);
  } catch {
    return NextResponse.json({ error: "Walmart build brief is invalid" }, { status: 409 });
  }
  if (
    rawBrief && typeof rawBrief === "object" && !Array.isArray(rawBrief)
    && (rawBrief as Record<string, unknown>).workflow
      === "CANONICAL_WALMART_NEW_SKU"
  ) {
    return NextResponse.json({ ok: true, build_id: id, phase: "DRAFTS" });
  }
  const brief = parseWalmartDurableBuildPreparationBrief(rawBrief);
  const runtime = loadProductTruthWebControlRuntime();
  if (runtime.status === "OFF") {
    return NextResponse.json(
      { error: "Product Truth control is not active" },
      { status: 503 },
    );
  }
  const collection = await readProductTruthWalmartCollectionStatus({
    batchId: brief.product_truth_collection.batch_id,
    requestedByUserId: job.user_id ?? undefined,
    runtime,
  });
  if (collection.status !== "SUCCEEDED" && collection.status !== "FAILED") {
    return NextResponse.json(
      {
        error: collection.status === "AMBIGUOUS"
          ? "Product Truth has an ambiguous provider outcome; automatic replacement is forbidden"
          : "Product Truth collection is not complete",
        collection_status: collection.status,
      },
      { status: 409 },
    );
  }

  const storeIndex = brief.walmart_shipping.store_index;
  const selectedTemplate = brief.walmart_shipping.template;
  const account = getWalmartStoreStatus(storeIndex);
  if (!account.configured) {
    return NextResponse.json(
      { error: "The selected Walmart account is no longer configured" },
      { status: 409 },
    );
  }
  const client = getWalmartClient(storeIndex);
  const [listResponse, detailResponse] = await Promise.all([
    client.requestRaw("GET", "/settings/shipping/templates", {
      noRetryOn429: true,
    }),
    client.requestRaw(
      "GET",
      `/settings/shipping/templates/${selectedTemplate.id}`,
      { noRetryOn429: true },
    ),
  ]);
  if (
    !listResponse.ok || listResponse.status !== 200
    || !detailResponse.ok || detailResponse.status !== 200
  ) {
    return NextResponse.json(
      { error: "Walmart could not reconfirm the selected shipping template" },
      { status: 409 },
    );
  }
  const list = parseWalmartShippingTemplateList(listResponse.body);
  const template = parseWalmartShippingTemplateDetails(detailResponse.body);
  const listed = list.find((entry) => entry.id === template.id);
  if (
    !listed
    || listed.status !== "ACTIVE"
    || template.status !== "ACTIVE"
    || template.id !== selectedTemplate.id
    || template.template_sha256 !== selectedTemplate.template_sha256
  ) {
    return NextResponse.json(
      { error: "The selected Walmart shipping template changed" },
      { status: 409 },
    );
  }

  const productTruthDb = openProductTruthWebReadClient();
  let diagnostic;
  try {
    diagnostic = await diagnoseProductTruthWalmartPilotRequest(productTruthDb, {
      query: brief.prompt,
      asOf: new Date().toISOString(),
      requireIngredients: true,
      requireNutrition: true,
      requireAllergens: true,
      limit: Math.max(20, Math.min(500, brief.listing_count * 4)),
    });
  } finally {
    productTruthDb.close();
  }
  const targetMarginBps = Math.round(brief.target_margin_pct * 100);
  let workItems;
  try {
    workItems = buildWalmartStudioDraftWorkItems({
      candidates: diagnostic.candidates,
      listingCount: brief.listing_count,
      packCount: brief.pack_count,
      storeIndex,
      shippingTemplateId: template.id,
      shippingTemplateSha256: template.template_sha256,
      targetMarginBps,
      asOf: diagnostic.as_of,
      priceMaxAgeMs: diagnostic.price_max_age_ms,
      zip: diagnostic.zip,
    });
  } catch (error) {
    if (
      !(error instanceof WalmartStudioDraftContractError)
      || !error.code.startsWith("INSUFFICIENT_")
    ) {
      throw error;
    }
    if (brief.product_truth_collection.attempts.length >= 5) {
      return NextResponse.json(
        {
          error:
            "This durable build exhausted five distinct Product Truth collection attempts without finding enough exact products.",
          code: "WALMART_PRODUCT_TRUTH_CANDIDATES_EXHAUSTED",
          ready_variants: diagnostic.ready_variants,
          requested_variants: brief.listing_count,
        },
        { status: 409 },
      );
    }
    const requestedAt = new Date().toISOString();
    const replacementDb = openProductTruthWebReadClient();
    let replacement;
    try {
      replacement = await prepareWalmartDurableBuildCollection({
        db: replacementDb,
        diagnostic,
        runtime,
        requestedByUserId: job.user_id ?? auth.id,
        requestedAt,
        prompt: brief.prompt,
        listingCount: brief.listing_count,
        packCount: brief.pack_count,
        excludedDonorProductIds:
          brief.product_truth_collection.attempts.flatMap(
            (attempt) => attempt.donor_product_ids,
          ),
      });
    } catch (replacementError) {
      return NextResponse.json(
        {
          error: replacementError instanceof Error
            ? replacementError.message
            : "No safe replacement Product Truth candidate is available",
          code: "WALMART_PRODUCT_TRUTH_REPLACEMENT_UNAVAILABLE",
          ready_variants: diagnostic.ready_variants,
          requested_variants: brief.listing_count,
        },
        { status: 409 },
      );
    } finally {
      replacementDb.close();
    }
    const replacementAttempt = {
      batch_id: replacement.batch.batchId,
      requested_at: requestedAt,
      admitted_jobs: replacement.status.jobs.length,
      donor_product_ids: replacement.batch.jobs.map(
        (entry) => entry.target.donorProductId,
      ),
    };
    const replacementBrief = {
      ...brief,
      product_truth_collection: {
        batch_id: replacementAttempt.batch_id,
        requested_at: requestedAt,
        admitted_jobs: replacementAttempt.admitted_jobs,
        attempts: [
          ...brief.product_truth_collection.attempts,
          replacementAttempt,
        ],
      },
    };
    const replaced = await prisma.generationJob.updateMany({
      where: {
        id,
        current_stage: "WALMART_PRODUCT_TRUTH",
        brief: job.brief,
      },
      data: {
        brief: JSON.stringify(replacementBrief),
        notes: JSON.stringify({
          progress: {
            status: "PENDING",
            phase: "product_truth_replacement",
            step:
              `The unavailable source was replaced inside this build; ${replacement.status.jobs.length} new exact-product plan(s) are preparing.`,
            total: brief.listing_count,
            done: diagnostic.ready_variants,
            failed: 0,
            done_flag: false,
          },
        }),
      },
    });
    if (replaced.count !== 1) {
      return NextResponse.json(
        {
          error: "This Walmart build advanced in another request; refresh its permanent URL",
          code: "WALMART_BUILD_ALREADY_ADVANCED",
        },
        { status: 409 },
      );
    }
    return NextResponse.json(
      {
        ok: true,
        build_id: id,
        phase: "PRODUCT_TRUTH_REPLACEMENT",
        product_truth_batch_id: replacement.batch.batchId,
      },
      { status: 202 },
    );
  }
  const finalBrief = {
    studio_version: 6,
    workflow: "CANONICAL_WALMART_NEW_SKU",
    draft_schema_version: WALMART_STUDIO_DRAFT_BRIEF_SCHEMA,
    source: "prompt",
    prompt: brief.prompt,
    channel: "WALMART",
    listing_count: brief.listing_count,
    pack_count: brief.pack_count,
    execution_work_items: workItems,
    target_margin_pct: brief.target_margin_pct,
    photo_strategy: "reuse-donor",
    walmart_shipping: {
      store_index: storeIndex,
      account_name: account.storeName,
      selected_at: brief.walmart_shipping.selected_at,
      template,
    },
    product_truth_admission: {
      as_of: diagnostic.as_of,
      price_max_age_ms: diagnostic.price_max_age_ms,
      zip: diagnostic.zip,
      matched_variants: diagnostic.matched_variants,
      ready_variants: diagnostic.ready_variants,
      collection_batch_id: brief.product_truth_collection.batch_id,
    },
    pricing_inputs: {
      packaging_cost_cents: WALMART_STUDIO_DEFAULT_PACKAGING_COST_CENTS,
      shipping_label_cents: WALMART_STUDIO_DEFAULT_SHIPPING_LABEL_CENTS,
      referral_fee_bps: WALMART_STUDIO_REFERRAL_FEE_BPS,
      target_margin_bps: targetMarginBps,
    },
    operator_contract: {
      engine: "walmart-studio-draft-engine",
      marketplace_mutation_authorized: false,
      upc_reservation_authorized: false,
      next_step:
        "Create donor-bound internal drafts for owner review. UPC reservation, certification and Walmart publication remain separate gates.",
    },
  };
  await prisma.$transaction(async (tx) => {
    const current = await tx.generationJob.findUnique({
      where: { id },
      include: { work_items: true },
    });
    if (!current) throw new Error("Walmart build disappeared during finalization");
    const currentBrief = JSON.parse(current.brief) as Record<string, unknown>;
    if (currentBrief.workflow === "CANONICAL_WALMART_NEW_SKU") return;
    if (current.current_stage !== "WALMART_PRODUCT_TRUTH") {
      throw new Error("Walmart build is not in Product Truth preparation");
    }
    if (current.work_items.length > 0) {
      throw new Error("Provisional Walmart build already has draft work items");
    }
    await tx.generationJob.update({
      where: { id },
      data: {
        brief: JSON.stringify(finalBrief),
        current_stage: "WALMART_DRAFT_QUEUE",
        status: "PENDING",
        bundles_target: brief.listing_count,
        notes: JSON.stringify({
          progress: {
            status: "PENDING",
            phase: "queued",
            step:
              `${brief.listing_count} exact Product Truth variants queued for Walmart draft generation.`,
            total: brief.listing_count,
            done: 0,
            failed: 0,
            done_flag: false,
          },
        }),
      },
    });
    await tx.generationWorkItem.createMany({
      data: workItems.map((item) => ({
        generation_job_id: id,
        spec_index: item.spec_index,
        spec_json: JSON.stringify(item),
        fingerprint: item.work_item_sha256,
      })),
    });
  });
  return NextResponse.json({ ok: true, build_id: id, phase: "DRAFTS" });
}
