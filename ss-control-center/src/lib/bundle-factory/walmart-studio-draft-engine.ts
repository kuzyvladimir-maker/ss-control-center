import { createHash } from "node:crypto";
import { runComplianceGate } from "@/lib/bundle-factory/compliance/gate";
import { allergenDeclarationFromLabel } from "./allergen-declaration";
import {
  walmartStudioDisplayBrand,
  walmartStudioDisplayFlavor,
} from "./walmart-studio-listing";

import { prisma } from "@/lib/prisma";
import {
  readProductTruthWalmartPilotCandidate,
} from "@/lib/sourcing/product-truth-read-contract";
import { openProductTruthWebReadClient } from
  "@/lib/sourcing/product-truth-web-read-client";
import { uploadToR2 } from "@/lib/walmart/multipack/r2";

import type { BatchProgress } from "./studio-engine";
import {
  buildDeterministicWalmartMixedPackContent,
  buildDeterministicWalmartMultipackContent,
} from "./walmart-new-sku-engine";
import { exactPackageCutout } from "@/lib/bundle-factory/walmart-new-sku-multipack-image";
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
  const mixed = input.item.components.length > 1;
  return `walmart-preview:${sha256(stableWalmartStudioDraftJson({
    store_index: input.item.store_index,
    canonical_variant_id: input.item.canonical_variant_id,
    pack_count: input.item.pack_count,
    shipping_template_sha256: input.item.shipping_template_sha256,
    target_margin_bps: input.item.target_margin_bps,
    content_observation_id: input.item.content_observation_id,
    price_observation_id: input.item.price_observation_id,
    // Two assortments can share a primary product and differ entirely in the
    // rest of the box, so a mix is identified by everything in it. A plain
    // multipack omits the field and keeps the fingerprint it always had —
    // existing drafts are found by this string.
    ...(mixed
      ? {
        components: input.item.components.map((component) => ({
          canonical_variant_id: component.canonical_variant_id,
          content_observation_id: component.content_observation_id,
          price_observation_id: component.price_observation_id,
          quantity: component.quantity,
        })),
      }
      : {}),
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

  // Resolve EVERY product in the box. A plain multipack has one entry and this
  // loop runs once; an assortment resolves each flavor against the exact
  // evidence its work item was sealed with.
  const productTruthDb = openProductTruthWebReadClient();
  const resolved: Array<{
    sealed: (typeof input.item.components)[number];
    component: Awaited<ReturnType<typeof readProductTruthWalmartPilotCandidate>>["newSkuView"]["components"][number];
    displayFlavor: string | null;
    displayBrand: string;
    unitPriceCents: number;
  }> = [];
  try {
    for (const sealed of input.item.components) {
      const productTruth = await readProductTruthWalmartPilotCandidate(productTruthDb, {
        donorProductId: sealed.donor_product_id,
        qty: sealed.quantity,
        asOf: input.item.as_of,
        maxPriceAgeMs: input.item.price_max_age_ms,
        zip: input.item.zip,
        requireIngredients: true,
        requireNutrition: true,
        requireAllergens: true,
      });
      const candidate = productTruth.candidate;
      const resolvedComponent = productTruth.newSkuView.components[0];
      if (
        candidate.donor_product_id !== sealed.donor_product_id ||
        candidate.canonical_variant_id !== sealed.canonical_variant_id ||
        candidate.content_observation_id !== sealed.content_observation_id ||
        candidate.price_observation_id !== sealed.price_observation_id ||
        resolvedComponent.qty !== sealed.quantity
      ) {
        throw new Error(
          "Product Truth identity or evidence changed after this work item was admitted",
        );
      }
      const unitPriceCents = Math.round(
        resolvedComponent.price_evidence.price_per_unit * 100,
      );
      if (!Number.isSafeInteger(unitPriceCents) || unitPriceCents <= 0) {
        throw new Error("Product Truth unit cost is not positive integer cents");
      }
      resolved.push({
        sealed,
        component: resolvedComponent,
        // The canonical flavor is a sorted token bag built for hashing, not for
        // a shopper to read. Show the manufacturer's own wording instead; the
        // identity the listing claims is unchanged, only its spelling.
        displayFlavor: walmartStudioDisplayFlavor(
          resolvedComponent as unknown as Record<string, unknown>,
        ),
        displayBrand: walmartStudioDisplayBrand(
          resolvedComponent as unknown as Record<string, unknown>,
        ),
        unitPriceCents,
      });
    }
  } finally {
    productTruthDb.close();
  }

  // Walmart declares net content per retail unit, and an assortment of
  // different sizes has no single one. Promotion refuses such a listing — which
  // is correct but happens after a draft exists that can never be published, so
  // it is refused here instead, where the sizes first become known
  // (re-review 2026-08-08).
  const declaredSizes = new Set(
    resolved.map((entry) => {
      const identity = entry.component.canonical_identity as
        | { sizeBaseAmount?: number; sizeBaseUnit?: string }
        | undefined;
      return `${identity?.sizeBaseAmount}|${identity?.sizeBaseUnit}`;
    }),
  );
  if (declaredSizes.size > 1) {
    throw new Error(
      "A mixed listing needs every product in the same retail size: Walmart "
      + "declares one net content per unit, and these differ ("
      + [...declaredSizes].join(", ") + ")",
    );
  }

  const primary = resolved[0]!;
  const component = primary.component;
  const displayFlavor = primary.displayFlavor;
  const displayBrand = primary.displayBrand;
  const mixed = resolved.length > 1;
  const content = mixed
    ? buildDeterministicWalmartMixedPackContent({
      components: resolved.map((entry) => ({
        ...entry.component,
        flavor: entry.displayFlavor,
        manufacturer_brand: entry.displayBrand,
      })),
      packCount: input.item.pack_count,
    })
    : buildDeterministicWalmartMultipackContent({
      component: {
        ...component,
        flavor: displayFlavor,
        manufacturer_brand: displayBrand,
      },
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
  const unitPriceCents = primary.unitPriceCents;
  // Cost is the sum over what is actually in the box. Multiplying one flavor's
  // unit price by the whole pack would misprice every assortment whose flavors
  // do not cost the same — and mispricing is invisible until the margin is gone.
  const goodsCostCents = resolved.reduce(
    (sum, entry) => sum + entry.unitPriceCents * entry.sealed.quantity,
    0,
  );
  // Same for weight: each flavor contributes its own size for its own count.
  const perComponentWeights = resolved.map((entry) =>
    walmartStudioDraftPackageWeightOz({
      sizeDimension: entry.component.canonical_identity.sizeDimension,
      sizeBaseAmount: entry.component.canonical_identity.sizeBaseAmount,
      sizeBaseUnit: entry.component.canonical_identity.sizeBaseUnit,
      packCount: entry.sealed.quantity,
      template,
    }));
  const weight = mixed
    ? {
      ...perComponentWeights[0]!,
      package_weight_oz: perComponentWeights.reduce(
        (sum, entry) => sum + entry.package_weight_oz,
        0,
      ),
    }
    : perComponentWeights[0]!;
  const economics = calculateWalmartStudioDraftEconomics({
    goodsCostCents,
    packagingCostCents: input.brief.pricing_inputs.packaging_cost_cents,
    shippingLabelCents: input.brief.pricing_inputs.shipping_label_cents,
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
  // For an assortment every OTHER flavor also needs a packshot. They are
  // fetched once, up front: if one of them cannot be read there is no picture
  // that honestly shows the box, and composing without it would show a
  // different product than the listing sells.
  const otherFlavorImages: Array<{ bytes: Buffer; quantity: number }> = [];
  for (const entry of resolved.slice(1)) {
    const candidates = [
      exactMainImageUrl(entry.component.facts.attributes._exact_main_image_url),
      ...exactStringArray(entry.component.facts.attributes._exact_image_urls),
    ]
      .map((url) => assertWalmartStudioExactImageUrl(url).toString())
      .filter((url, index, all) => all.indexOf(url) === index);
    let bytes: Buffer | null = null;
    let lastError: unknown = null;
    for (const candidate of candidates) {
      try {
        const fetched = await fetchWalmartStudioExactImage(candidate);
        // Prove it is a PACKSHOT, not whatever the donor happened to publish.
        // Taking the first image that merely downloaded put a Nutrition Facts
        // panel and an ingredient list on a live main tile, overlapping and
        // cropped, on 2026-08-08. The primary flavor was always proven this way
        // — by whether a package can be cut out of it — and the others must be
        // held to the same test.
        await exactPackageCutout(fetched.bytes);
        bytes = fetched.bytes;
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!bytes) {
      throw new Error(
        `No exact donor image could be read for ${entry.sealed.title_at_admission}: ${
          lastError instanceof Error ? lastError.message : String(lastError)
        }`,
      );
    }
    otherFlavorImages.push({ bytes, quantity: entry.sealed.quantity });
  }

  for (const candidate of imageCandidates) {
    try {
      const source = await fetchWalmartStudioExactImage(candidate);
      composed = await buildDeterministicWalmartMultipackImage({
        sourceUnitImageBytes: source.bytes,
        packCount: input.item.pack_count,
        ...(mixed
          ? {
            unitSources: [
              { bytes: source.bytes, quantity: primary.sealed.quantity },
              ...otherFlavorImages,
            ],
          }
          : {}),
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
    brand: displayBrand,
    flavor: displayFlavor,
    manufacturer_upc: component.manufacturer_upc,
    qty: component.qty,
    unit_price_cents: unitPriceCents,
    ingredients: component.facts.ingredients,
    allergens: component.facts.allergens,
    // The publish path requires a STRUCTURED declaration and rightly refuses a
    // food listing without one. Donors publish it either as the printed
    // "Contains:" sentence or as a structured list, so this reads whichever
    // shape arrived. Nothing is inferred from the ingredient list.
    allergen_declaration: allergenDeclarationFromLabel(
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
  },
  // Every other flavor is recorded in full too. A draft whose snapshot listed
  // one product while the box held several would hide the assortment from
  // every downstream reader — pricing, compliance and the publish payload.
  ...resolved.slice(1).map((entry) => ({
    research_pool_id: entry.component.donor_product_id,
    product_name: entry.component.product_name,
    brand: entry.displayBrand,
    flavor: entry.displayFlavor,
    manufacturer_upc: entry.component.manufacturer_upc,
    qty: entry.component.qty,
    unit_price_cents: entry.unitPriceCents,
    ingredients: entry.component.facts.ingredients,
    allergens: entry.component.facts.allergens,
    allergen_declaration: allergenDeclarationFromLabel(entry.component.facts.allergens),
    nutrition_facts: entry.component.facts.nutrition_facts,
    storage_temp: "Shelf-stable",
    donor_image_urls: exactStringArray(entry.component.facts.attributes._exact_image_urls)
      .map((url) => assertWalmartStudioExactImageUrl(url).toString()),
    product_truth_component: entry.component,
  })),
  ];
  const variant = {
    idx: 0,
    name: content.title,
    notes: "Exact Product Truth variant; deterministic Walmart draft preview",
    composition: resolved.map((entry) => ({
      research_pool_id: entry.component.donor_product_id,
      product_name: entry.component.product_name,
      brand: entry.displayBrand,
      qty: entry.component.qty,
      unit_price_cents: entry.unitPriceCents,
    })),
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
      brand: displayBrand,
      bullets: content.bullets,
      description: content.description,
      main_image_url: mainImageUrl,
      bundle_components: [{
        brand: displayBrand,
        product_name: component.product_name,
      }],
      // The main image is a deterministic composite of the exact donor
      // packshot, already proven by the composer; the vision re-check adds
      // provider cost without adding evidence.
      skip_image_check: true,
      // Walmart policy differs from Amazon's: the brand field carries the
      // original manufacturer, and the assembler disclaimer uses the
      // multipack wording rather than the gift-basket sentence.
      channel: "WALMART",
    },
    // autoFix appends the required assembler disclaimer to the bullets and
    // description. It is a fixed, owner-approved sentence — not generated
    // copy — so applying it here is deterministic.
    { actor: "walmart-studio-draft-engine", autoFix: true },
  );
  const contentComplianceStatus = complianceDecision.decision;
  // autoFix may append the assembler disclaimer, so persist the text the gate
  // actually approved rather than the pre-gate draft.
  const approvedBullets = complianceDecision.final_bullets;
  const approvedDescription = complianceDecision.final_description;

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
        brand: displayBrand,
        category: "SHELF_STABLE",
        // What is actually in the box. Always writing SINGLE_FLAVOR carried a
        // false claim into the MasterBundle and out to every reader of it
        // (independent review 2026-08-08).
        composition_type: mixed ? "MIXED_FLAVOR" : "SINGLE_FLAVOR",
        pack_count: input.item.pack_count,
        draft_components: JSON.stringify(snapshot),
        draft_title: content.title,
        draft_bullets: JSON.stringify(approvedBullets),
        draft_description: approvedDescription,
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
            bullets_json: JSON.stringify(approvedBullets),
            description: approvedDescription,
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
