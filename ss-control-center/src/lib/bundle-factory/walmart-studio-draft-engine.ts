import { createHash } from "node:crypto";
import { runComplianceGate } from "@/lib/bundle-factory/compliance/gate";
import { allergenDeclarationFromLabelText } from "./allergen-declaration";

import { prisma } from "@/lib/prisma";
import {
  readProductTruthWalmartPilotCandidate,
} from "@/lib/sourcing/product-truth-read-contract";
import { openProductTruthWebReadClient } from
  "@/lib/sourcing/product-truth-web-read-client";
import { uploadToR2 } from "@/lib/walmart/multipack/r2";

import type { BatchProgress } from "./studio-engine";
import {
  buildDeterministicWalmartMultipackContent,
} from "./walmart-new-sku-engine";
import { buildDeterministicWalmartMultipackImage } from
  "./walmart-new-sku-multipack-image";
import {
  assertWalmartShippingTemplateDetailsIntegrity,
} from "./walmart-shipping-templates";
import {
  calculateWalmartStudioDraftEconomics,
  walmartStudioDraftPackageWeightOz,
} from "./walmart-studio-draft-economics";
import {
  parseWalmartStudioDraftBrief,
  parseWalmartStudioDraftWorkItem,
  stableWalmartStudioDraftJson,
  type WalmartStudioDraftBrief,
  type WalmartStudioDraftWorkItem,
} from "./walmart-studio-draft-contract";

const MAX_WORK_ATTEMPTS = 3;
const STALE_LOCK_MS = 10 * 60_000;
const MAX_SOURCE_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_SOURCE_IMAGE_REDIRECTS = 4;
const ALLOWED_EXACT_IMAGE_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
]);
const ALLOWED_EXACT_IMAGE_HOST_SUFFIXES = [
  ".walmartimages.com",
  ".scene7.com",
  ".salsify.com",
  ".campbells.com",
  ".campbellsoupcompany.com",
  ".targetimg1.com",
  ".r2.dev",
];

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.trim().length > 0,
      ).map((entry) => entry.trim())
    : [];
}

function exactMainImageUrl(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Product Truth exact main image is missing");
  }
  return value.trim();
}

export function assertWalmartStudioExactImageUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Exact donor image must use an unauthenticated HTTPS URL");
  }
  const hostname = url.hostname.toLowerCase();
  if (
    !ALLOWED_EXACT_IMAGE_HOST_SUFFIXES.some(
      (suffix) => hostname === suffix.slice(1) || hostname.endsWith(suffix),
    )
  ) {
    throw new Error(`Exact donor image host is not approved: ${hostname}`);
  }
  return url;
}

function highResolutionExactImageUrl(raw: string): URL {
  const url = assertWalmartStudioExactImageUrl(raw);
  if (url.hostname.toLowerCase().endsWith(".walmartimages.com")) {
    url.search = "";
  }
  return url;
}

export async function fetchWalmartStudioExactImage(
  raw: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ bytes: Buffer; fetched_url: string; content_type: string }> {
  let requested = highResolutionExactImageUrl(raw);
  let response: Response | null = null;
  for (let redirectCount = 0; redirectCount <= MAX_SOURCE_IMAGE_REDIRECTS; redirectCount += 1) {
    response = await fetchImpl(requested, {
      redirect: "manual",
      signal: AbortSignal.timeout(25_000),
      headers: {
        "user-agent": "SS-Command-Center-Walmart-Draft/1.0",
      },
    });
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get("location");
    if (!location || redirectCount === MAX_SOURCE_IMAGE_REDIRECTS) {
      throw new Error("Exact donor image redirect chain is invalid or too long");
    }
    requested = assertWalmartStudioExactImageUrl(
      new URL(location, requested).toString(),
    );
  }
  if (!response) throw new Error("Exact donor image did not return a response");
  if (!response.ok) {
    throw new Error(
      `Exact donor image GET returned ${response.status} for ${requested.hostname}`,
    );
  }
  if (response.url) assertWalmartStudioExactImageUrl(response.url);
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim()
    ?? "";
  if (!ALLOWED_EXACT_IMAGE_CONTENT_TYPES.has(contentType)) {
    throw new Error(`Exact donor asset is not an image (${contentType || "unknown"})`);
  }
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > MAX_SOURCE_IMAGE_BYTES) {
    throw new Error("Exact donor image exceeds the 25 MiB limit");
  }
  if (!response.body) throw new Error("Exact donor image response has no body");
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_SOURCE_IMAGE_BYTES) {
      await reader.cancel();
      throw new Error("Exact donor image exceeds the 25 MiB limit");
    }
    chunks.push(Buffer.from(value));
  }
  const bytes = Buffer.concat(chunks, totalBytes);
  if (bytes.length === 0) {
    throw new Error("Exact donor image is empty or exceeds the 25 MiB limit");
  }
  return {
    bytes,
    fetched_url: response.url || requested.toString(),
    content_type: contentType,
  };
}

function draftRecipeFingerprint(input: {
  item: WalmartStudioDraftWorkItem;
}): string {
  return `walmart-preview:${sha256(stableWalmartStudioDraftJson({
    store_index: input.item.store_index,
    canonical_variant_id: input.item.canonical_variant_id,
    pack_count: input.item.pack_count,
    shipping_template_sha256: input.item.shipping_template_sha256,
    target_margin_bps: input.item.target_margin_bps,
    content_observation_id: input.item.content_observation_id,
    price_observation_id: input.item.price_observation_id,
  }))}`;
}

function notes(progress: BatchProgress): string {
  return JSON.stringify({ progress });
}

function terminalProgress(input: {
  succeeded: number;
  failed: number;
  total: number;
}): BatchProgress {
  const complete = input.failed === 0 && input.succeeded === input.total;
  return {
    status: complete ? "COMPLETED" : "FAILED",
    phase: complete ? "done" : "error",
    step: complete
      ? `Ready for review — ${input.succeeded}/${input.total} Walmart drafts created`
      : `Incomplete — ${input.succeeded}/${input.total} drafts created, ${input.failed} failed`,
    total: input.total,
    done: input.succeeded + input.failed,
    failed: input.failed,
    done_flag: true,
  };
}

async function existingCompleteDraft(
  recipeFingerprint: string,
): Promise<{ id: string; draft_title: string | null } | null> {
  return prisma.bundleDraft.findFirst({
    where: {
      recipe_fingerprint: recipeFingerprint,
      status: "GENERATED",
      draft_main_image_url: { not: null },
      generated_content: { some: { channel: "WALMART" } },
    },
    select: { id: true, draft_title: true },
  });
}

async function buildOneDraft(input: {
  jobId: string;
  brief: WalmartStudioDraftBrief;
  item: WalmartStudioDraftWorkItem;
}): Promise<{ draftId: string; title: string }> {
  const recipeFingerprint = draftRecipeFingerprint({ item: input.item });
  const existing = await existingCompleteDraft(recipeFingerprint);
  if (existing) {
    return {
      draftId: existing.id,
      title: existing.draft_title ?? input.item.title_at_admission,
    };
  }

  const productTruthDb = openProductTruthWebReadClient();
  let productTruth;
  try {
    productTruth = await readProductTruthWalmartPilotCandidate(productTruthDb, {
      donorProductId: input.item.donor_product_id,
      qty: input.item.pack_count,
      asOf: input.item.as_of,
      maxPriceAgeMs: input.item.price_max_age_ms,
      zip: input.item.zip,
      requireIngredients: true,
      requireNutrition: true,
      requireAllergens: true,
    });
  } finally {
    productTruthDb.close();
  }
  const candidate = productTruth.candidate;
  const component = productTruth.newSkuView.components[0];
  if (
    candidate.donor_product_id !== input.item.donor_product_id ||
    candidate.canonical_variant_id !== input.item.canonical_variant_id ||
    candidate.content_observation_id !== input.item.content_observation_id ||
    candidate.price_observation_id !== input.item.price_observation_id ||
    component.qty !== input.item.pack_count
  ) {
    throw new Error(
      "Product Truth identity or evidence changed after this work item was admitted",
    );
  }
  const content = buildDeterministicWalmartMultipackContent({
    component,
    packCount: input.item.pack_count,
  });
  const template = assertWalmartShippingTemplateDetailsIntegrity(
    input.brief.walmart_shipping.template,
  );
  if (
    template.id !== input.item.shipping_template_id ||
    template.template_sha256 !== input.item.shipping_template_sha256
  ) {
    throw new Error("The selected shipping template differs from the sealed work item");
  }
  const unitPriceCents = Math.round(
    component.price_evidence.price_per_unit * 100,
  );
  if (!Number.isSafeInteger(unitPriceCents) || unitPriceCents <= 0) {
    throw new Error("Product Truth unit cost is not positive integer cents");
  }
  const goodsCostCents = unitPriceCents * input.item.pack_count;
  const weight = walmartStudioDraftPackageWeightOz({
    sizeDimension: component.canonical_identity.sizeDimension,
    sizeBaseAmount: component.canonical_identity.sizeBaseAmount,
    sizeBaseUnit: component.canonical_identity.sizeBaseUnit,
    packCount: input.item.pack_count,
    template,
  });
  const economics = calculateWalmartStudioDraftEconomics({
    goodsCostCents,
    packagingCostCents: input.brief.pricing_inputs.packaging_cost_cents,
    shippingLabelCents: input.brief.pricing_inputs.shipping_label_cents,
    targetMarginBps: input.item.target_margin_bps,
    packageWeightOz: weight.package_weight_oz,
    template,
  });
  // The recorded "main" image is not always the packshot: some donors record a
  // video still or a lifestyle frame, which has no removable white canvas and
  // cannot become a Pack-of-N composite. Every candidate here is an exact,
  // verified image of the SAME product from the SAME observation, so trying the
  // gallery in order is a source choice, never a product substitution — and the
  // composer itself still proves each candidate is a true packshot.
  const imageCandidates = [
    exactMainImageUrl(component.facts.attributes._exact_main_image_url),
    ...exactStringArray(component.facts.attributes._exact_image_urls),
  ]
    .map((url) => assertWalmartStudioExactImageUrl(url).toString())
    .filter((url, index, all) => all.indexOf(url) === index);
  let sourceMainImageUrl = imageCandidates[0]!;
  let sourceFetchedUrl = sourceMainImageUrl;
  let composed: Awaited<ReturnType<typeof buildDeterministicWalmartMultipackImage>>
    | null = null;
  let lastImageError: unknown = null;
  for (const candidate of imageCandidates) {
    try {
      const source = await fetchWalmartStudioExactImage(candidate);
      composed = await buildDeterministicWalmartMultipackImage({
        sourceUnitImageBytes: source.bytes,
        packCount: input.item.pack_count,
      });
      sourceMainImageUrl = candidate;
      sourceFetchedUrl = source.fetched_url;
      break;
    } catch (error) {
      lastImageError = error;
    }
  }
  if (!composed) {
    throw new Error(
      `No exact donor image could become a Pack-of-${input.item.pack_count} main image: ${
        lastImageError instanceof Error ? lastImageError.message : String(lastImageError)
      }`,
    );
  }
  if (composed.represented_unit_count !== input.item.pack_count) {
    throw new Error("The composed main image does not represent the requested count");
  }
  const mainImageUrl = await uploadToR2(
    composed.bytes,
    `walmart-new-sku/draft-main/${composed.output_sha256}.png`,
    "image/png",
  );
  const exactImages = exactStringArray(
    component.facts.attributes._exact_image_urls,
  ).map((url) => assertWalmartStudioExactImageUrl(url).toString());
  const secondaryImages = exactImages.filter(
    (url) => url !== sourceMainImageUrl,
  );
  const worstScenario = [...economics.scenarios].sort(
    (left, right) =>
      left.contribution_margin_bps - right.contribution_margin_bps,
  )[0]!;
  const snapshot = [{
    research_pool_id: component.donor_product_id,
    product_name: component.product_name,
    brand: component.manufacturer_brand,
    flavor: component.flavor,
    manufacturer_upc: component.manufacturer_upc,
    qty: component.qty,
    unit_price_cents: unitPriceCents,
    ingredients: component.facts.ingredients,
    allergens: component.facts.allergens,
    // The publish path requires a STRUCTURED declaration, not the free-text
    // label line, and rightly refuses a food listing without one. Both come
    // from the same verified manufacturer text on the package; this only
    // parses it into the shape the Walmart/Amazon writers consume. Nothing is
    // inferred from the ingredient list.
    allergen_declaration: allergenDeclarationFromLabelText(
      component.facts.allergens,
    ),
    nutrition_facts: component.facts.nutrition_facts,
    storage_temp: "Shelf-stable",
    donor_image_urls: exactImages,
    product_truth_component: component,
    walmart_preview: {
      schema_version: "bundle-factory.walmart-preview-evidence/1.0.0",
      work_item_sha256: input.item.work_item_sha256,
      publication_ready: false,
      marketplace_mutated: false,
      upc_reserved: false,
      shipping_weight_basis: weight.basis,
      economics,
      image: {
        exact_source_url: sourceMainImageUrl,
        fetched_url: sourceFetchedUrl,
        source_asset_sha256: composed.source_asset_sha256,
        output_sha256: composed.output_sha256,
        represented_unit_count: composed.represented_unit_count,
        construction_method: composed.construction_method,
      },
    },
  }];
  const variant = {
    idx: 0,
    name: content.title,
    notes: "Exact Product Truth variant; deterministic Walmart draft preview",
    composition: [{
      research_pool_id: component.donor_product_id,
      product_name: component.product_name,
      brand: component.manufacturer_brand,
      qty: component.qty,
      unit_price_cents: unitPriceCents,
    }],
    cost_cents: goodsCostCents,
    suggested_price_cents: economics.item_price_cents,
    margin_cents: worstScenario.contribution_profit_cents,
    margin_pct: worstScenario.contribution_margin_bps / 10_000,
    feasibility_score: 100,
  };
  const approvalNotes = JSON.stringify({
    workflow: "CANONICAL_WALMART_NEW_SKU_DRAFT",
    publication_ready: false,
    marketplace_mutated: false,
    upc_reserved: false,
    next_gate:
      "Owner reviews this draft before UPC reservation, certification, or Walmart publication.",
    work_item_sha256: input.item.work_item_sha256,
    economics,
  });

  // Content is born checked. The publish path only promotes CAN_PUBLISH
  // content, so a draft written as PENDING was a listing nobody could ever
  // publish. The gate runs on exactly the bytes generated above; a failure is
  // recorded as BLOCKED with its reasons rather than silently passed.
  const complianceDecision = await runComplianceGate(
    {
      title: content.title,
      brand: component.manufacturer_brand,
      bullets: content.bullets,
      description: content.description,
      main_image_url: mainImageUrl,
      bundle_components: [{
        brand: component.manufacturer_brand,
        product_name: component.product_name,
      }],
      // The main image is a deterministic composite of the exact donor
      // packshot, already proven by the composer; the vision re-check adds
      // provider cost without adding evidence.
      skip_image_check: true,
    },
    { actor: "walmart-studio-draft-engine" },
  );
  const contentComplianceStatus = complianceDecision.decision;

  const created = await prisma.$transaction(async (tx) => {
    const raced = await tx.bundleDraft.findUnique({
      where: { recipe_fingerprint: recipeFingerprint },
      select: { id: true, draft_title: true },
    });
    if (raced) return raced;
    return tx.bundleDraft.create({
      data: {
        generation_job_id: input.jobId,
        draft_name: content.title,
        brand: component.manufacturer_brand,
        category: "SHELF_STABLE",
        composition_type: "SINGLE_FLAVOR",
        pack_count: input.item.pack_count,
        draft_components: JSON.stringify(snapshot),
        draft_title: content.title,
        draft_bullets: JSON.stringify(content.bullets),
        draft_description: content.description,
        draft_main_image_url: mainImageUrl,
        draft_secondary_images: JSON.stringify(secondaryImages),
        image_generated_at: new Date(),
        draft_cost_cents: goodsCostCents,
        draft_suggested_price_cents: economics.item_price_cents,
        status: "GENERATED",
        approval_notes: approvalNotes,
        recipe_fingerprint: recipeFingerprint,
        target_channels: JSON.stringify(["WALMART"]),
        compliance_status: "PENDING",
        variation_matrix: {
          create: {
            variants_json: JSON.stringify([variant]),
            selected_variant_idx: 0,
            selected_at: new Date(),
          },
        },
        generated_content: {
          create: {
            channel: "WALMART",
            template: "walmart-deterministic-product-truth-draft",
            title: content.title,
            bullets_json: JSON.stringify(content.bullets),
            description: content.description,
            compliance_status: contentComplianceStatus,
            main_image_url: mainImageUrl,
            image_generated_at: new Date(),
          },
        },
      },
      select: { id: true, draft_title: true },
    });
  });
  return { draftId: created.id, title: created.draft_title ?? content.title };
}

export interface WalmartStudioDraftEngineDependencies {
  buildDraft?: typeof buildOneDraft;
  now?: () => Date;
}

/** Advances one durable donor-bound draft item. This path performs Product
 * Truth reads, deterministic image composition, R2 upload and internal draft
 * writes only. It has no Walmart client and cannot reserve a UPC. */
export async function tickWalmartStudioDraftBatch(
  batchId: string,
  dependencies: WalmartStudioDraftEngineDependencies = {},
): Promise<BatchProgress> {
  const now = dependencies.now ?? (() => new Date());
  const buildDraft = dependencies.buildDraft ?? buildOneDraft;
  const job = await prisma.generationJob.findUnique({
    where: { id: batchId },
    include: { work_items: { orderBy: { spec_index: "asc" } } },
  });
  if (!job) {
    return {
      status: "FAILED",
      phase: "error",
      step: "Batch not found",
      total: 0,
      done: 0,
      failed: 0,
      done_flag: true,
    };
  }
  let brief: WalmartStudioDraftBrief;
  try {
    brief = parseWalmartStudioDraftBrief(JSON.parse(job.brief));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const progress: BatchProgress = {
      status: "FAILED",
      phase: "error",
      step: `Walmart draft request is invalid: ${message}`,
      total: job.bundles_target,
      done: 0,
      failed: job.bundles_target,
      done_flag: true,
    };
    await prisma.generationJob.update({
      where: { id: batchId },
      data: {
        status: "FAILED",
        current_stage: "FAILED",
        bundles_error: job.bundles_target,
        completed_at: now(),
        notes: notes(progress),
      },
    });
    return progress;
  }
  if (job.work_items.length !== brief.execution_work_items.length) {
    const progress: BatchProgress = {
      status: "FAILED",
      phase: "error",
      step: "Durable Walmart work-item rows do not match the sealed request",
      total: brief.listing_count,
      done: 0,
      failed: brief.listing_count,
      done_flag: true,
    };
    await prisma.generationJob.update({
      where: { id: batchId },
      data: {
        status: "FAILED",
        current_stage: "FAILED",
        bundles_error: brief.listing_count,
        completed_at: now(),
        notes: notes(progress),
      },
    });
    return progress;
  }
  try {
    for (const row of job.work_items) {
      const parsed = parseWalmartStudioDraftWorkItem(JSON.parse(row.spec_json));
      const expected = brief.execution_work_items[row.spec_index];
      if (
        !expected ||
        parsed.work_item_sha256 !== expected.work_item_sha256 ||
        row.fingerprint !== expected.work_item_sha256 ||
        !["PENDING", "RUNNING", "SUCCEEDED", "FAILED"].includes(row.status)
      ) {
        throw new Error(
          `GenerationWorkItem ${row.id} differs from the sealed Walmart request`,
        );
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const progress: BatchProgress = {
      status: "FAILED",
      phase: "error",
      step: `Walmart draft queue integrity failed: ${message}`,
      total: brief.listing_count,
      done: 0,
      failed: brief.listing_count,
      done_flag: true,
    };
    await prisma.generationJob.update({
      where: { id: batchId },
      data: {
        status: "FAILED",
        current_stage: "FAILED",
        bundles_error: brief.listing_count,
        completed_at: now(),
        notes: notes(progress),
      },
    });
    return progress;
  }

  const succeeded = job.work_items.filter((row) => row.status === "SUCCEEDED").length;
  const failed = job.work_items.filter((row) => row.status === "FAILED").length;
  const terminalCount = succeeded + failed;
  if (terminalCount === brief.listing_count) {
    const progress = terminalProgress({
      succeeded,
      failed,
      total: brief.listing_count,
    });
    if (!job.completed_at || job.status !== progress.status) {
      await prisma.generationJob.update({
        where: { id: batchId },
        data: {
          status: progress.status,
          current_stage: progress.status === "COMPLETED" ? "DRAFT_REVIEW" : "FAILED",
          bundles_generated: succeeded,
          bundles_error: failed,
          completed_at: now(),
          notes: notes(progress),
        },
      });
    }
    return progress;
  }

  const clock = now();
  const staleBefore = new Date(clock.getTime() - STALE_LOCK_MS);
  const candidate = job.work_items.find(
    (row) =>
      row.status === "PENDING" ||
      (row.status === "RUNNING" &&
        (row.locked_at == null || row.locked_at < staleBefore)),
  );
  if (!candidate) {
    return {
      status: "RUNNING",
      phase: "building",
      step: `Building Walmart drafts… ${terminalCount}/${brief.listing_count}`,
      total: brief.listing_count,
      done: terminalCount,
      failed,
      done_flag: false,
    };
  }
  const claimedAt = clock;
  const claim = await prisma.generationWorkItem.updateMany({
    where: {
      id: candidate.id,
      status: candidate.status,
      ...(candidate.status === "RUNNING"
        ? { locked_at: candidate.locked_at }
        : {}),
    },
    data: {
      status: "RUNNING",
      locked_at: claimedAt,
      attempts: { increment: 1 },
    },
  });
  if (claim.count === 0) {
    return {
      status: "RUNNING",
      phase: "building",
      step: `Another request is building the next Walmart draft… ${terminalCount}/${brief.listing_count}`,
      total: brief.listing_count,
      done: terminalCount,
      failed,
      done_flag: false,
    };
  }
  await prisma.generationJob.update({
    where: { id: batchId },
    data: { status: "IN_PROGRESS", current_stage: "WALMART_DRAFT_GENERATION" },
  });

  const item = brief.execution_work_items[candidate.spec_index]!;
  const attempt = candidate.attempts + 1;
  let outcome: "SUCCEEDED" | "FAILED" | "RETRY" = "FAILED";
  let draftId: string | null = candidate.bundle_draft_id;
  let title = item.title_at_admission;
  let lastError: string | null = null;
  try {
    const built = await buildDraft({ jobId: batchId, brief, item });
    draftId = built.draftId;
    title = built.title;
    outcome = "SUCCEEDED";
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    outcome = attempt < MAX_WORK_ATTEMPTS ? "RETRY" : "FAILED";
  }
  await prisma.generationWorkItem.update({
    where: { id: candidate.id },
    data: {
      status: outcome === "RETRY" ? "PENDING" : outcome,
      locked_at: null,
      last_error: lastError,
      ...(draftId ? { bundle_draft_id: draftId } : {}),
    },
  });
  const completedNow = outcome === "RETRY" ? 0 : 1;
  const failedNow = outcome === "FAILED" ? 1 : 0;
  const progress: BatchProgress = {
    status: "RUNNING",
    phase: "building",
    step: outcome === "RETRY"
      ? `Retrying ${title} (${attempt}/${MAX_WORK_ATTEMPTS}): ${lastError}`
      : outcome === "SUCCEEDED"
        ? `Created ${terminalCount + 1}/${brief.listing_count}: ${title}`
        : `Failed ${terminalCount + 1}/${brief.listing_count}: ${title}`,
    total: brief.listing_count,
    done: terminalCount + completedNow,
    failed: failed + failedNow,
    done_flag: false,
  };
  await prisma.generationJob.update({
    where: { id: batchId },
    data: {
      bundles_generated: succeeded + (outcome === "SUCCEEDED" ? 1 : 0),
      bundles_error: failed + failedNow,
      notes: notes(progress),
    },
  });
  return progress;
}
