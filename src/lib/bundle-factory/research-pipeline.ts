/**
 * Phase 2.1 Stage 2 — Research pipeline orchestrator.
 *
 * Given a BundleDraft in DRAFT status, this module:
 *   1. Marks GenerationStage(stage=RESEARCH, status=IN_PROGRESS).
 *   2. Wipes any prior ResearchPool rows for the same generation_job_id
 *      (idempotent re-runs).
 *   3. Calls Perplexity (or returns the mock fixture when running in
 *      development with no API key).
 *   4. Calls the R2 image mirror per product (Stage 2.5) so persisted
 *      image URLs live on our infrastructure.
 *   5. Creates ResearchPool rows, resolving source_store_name →
 *      StoreRegistry.id when possible.
 *   6. Updates BundleDraft.status → RESEARCHED.
 *   7. Marks GenerationStage COMPLETED (or FAILED on error) and writes
 *      a ListingLifecycleLog entry.
 *
 * Cost: ~1 Perplexity sonar-pro call (~$0.01) + per-image R2 PUT.
 *
 * Designed for inline execution in a Next.js POST route; if Phase 5+
 * requires concurrency, swap the inline call for a job queue.
 */

import { prisma } from "@/lib/prisma";
import {
  researchProducts,
  MOCK_RESEARCH_RESPONSE,
  type PerplexityResearchProduct,
  type PerplexityResearchResponse,
} from "./perplexity";
import { mirrorImages } from "./r2-image-mirror";
import { logLifecycle } from "./lifecycle-log";
import { OWN_BRANDS } from "./audit/forbidden-brands";

export interface RunResearchInput {
  bundle_draft_id: string;
  trigger?: "manual" | "auto";
  actor?: string;
}

export interface RunResearchResult {
  ok: boolean;
  generation_job_id: string;
  pool_size: number;
  duration_ms: number;
  citations: string[];
  mocked: boolean;
  mirror_summary: {
    total_urls: number;
    uploaded: number;
    failed: number;
  };
  error?: string;
}

export async function runResearch(
  input: RunResearchInput,
): Promise<RunResearchResult> {
  const startMs = Date.now();

  const draft = await prisma.bundleDraft.findUnique({
    where: { id: input.bundle_draft_id },
  });
  if (!draft) throw new Error(`BundleDraft ${input.bundle_draft_id} not found`);
  if (draft.status !== "DRAFT") {
    throw new Error(
      `BundleDraft ${draft.id} is in status ${draft.status}, expected DRAFT`,
    );
  }

  const jobId = draft.generation_job_id;

  await upsertStage(jobId, "RESEARCH", "IN_PROGRESS", {
    started_at: new Date(),
  });

  // Clean slate so re-runs don't accumulate stale rows.
  await prisma.researchPool.deleteMany({ where: { generation_job_id: jobId } });

  try {
    // Pull Tier 1 + Tier 2 store chains for the Perplexity prompt context.
    const stores = await prisma.storeRegistry.findMany({
      where: { is_active: true, tier: { in: ["TIER_1", "TIER_2"] } },
      orderBy: { default_priority: "asc" },
      take: 20,
    });
    const sourcingChains = Array.from(new Set(stores.map((s) => s.chain)));

    const query = buildQueryFromDraft(draft);

    const useMock =
      process.env.NODE_ENV !== "production" && !process.env.PERPLEXITY_API_KEY;
    const result: PerplexityResearchResponse = useMock
      ? MOCK_RESEARCH_RESPONSE
      : await researchProducts({
          query,
          category: draft.category,
          brand_hint: extractBrandHint(draft),
          sourcing_radius_stores: sourcingChains,
          max_products: 25,
        });

    // Resolve `source_store_name` → StoreRegistry.id via chain substring.
    const storeIdByChain = new Map<string, string>();
    for (const s of stores) {
      storeIdByChain.set(s.chain.toLowerCase(), s.id);
    }

    // Mirror images BEFORE persisting — we want the R2 URLs in DB, not
    // the volatile retailer originals. mirror summary is reported back
    // so the UI can flag image-source failures.
    let totalUrls = 0;
    let uploadedCount = 0;
    let failedCount = 0;

    for (const product of result.products) {
      const urls = Array.isArray(product.reference_image_urls)
        ? product.reference_image_urls.filter((u): u is string => typeof u === "string")
        : [];
      if (urls.length === 0) continue;
      totalUrls += urls.length;

      const slug = `draft-${draft.id}-${slugifyProductName(product.product_name)}`;
      const mirrored = await mirrorImages({
        bundle_sku: slug,
        image_urls: urls,
      });

      product.reference_image_urls = mirrored.map((m) => m.r2_url);
      uploadedCount += mirrored.filter((m) => m.uploaded).length;
      failedCount += mirrored.filter((m) => !m.uploaded).length;
    }

    let createdCount = 0;
    for (const product of result.products) {
      try {
        await prisma.researchPool.create({
          data: {
            generation_job_id: jobId,
            research_query: query,
            product_name: product.product_name,
            brand: product.brand,
            manufacturer: product.manufacturer ?? null,
            upc: product.upc ?? null,
            flavors: product.flavors ? JSON.stringify(product.flavors) : null,
            pack_sizes: product.pack_sizes
              ? JSON.stringify(product.pack_sizes)
              : null,
            weight_oz: product.weight_oz ?? null,
            weight_lb:
              typeof product.weight_oz === "number"
                ? product.weight_oz / 16
                : null,
            ingredients: product.ingredients ?? null,
            allergens: product.allergens
              ? JSON.stringify(product.allergens)
              : null,
            storage_temp: product.storage_temp ?? null,
            expiration_days: product.expiration_days ?? null,
            avg_price_cents: product.avg_price_cents ?? null,
            source_store_id: resolveStoreId(
              product.source_store_name,
              storeIdByChain,
            ),
            source_url: product.source_url ?? null,
            reference_image_urls: JSON.stringify(
              product.reference_image_urls ?? [],
            ),
            freshness_score: product.freshness_score ?? null,
            last_seen_in_stock: new Date(),
          },
        });
        createdCount++;
      } catch (e) {
        console.error(
          `[research-pipeline] failed to insert "${product.product_name}":`,
          e,
        );
      }
    }

    await prisma.bundleDraft.update({
      where: { id: draft.id },
      data: { status: "RESEARCHED" },
    });

    const durationMs = Date.now() - startMs;

    await upsertStage(jobId, "RESEARCH", "COMPLETED", {
      completed_at: new Date(),
      duration_ms: durationMs,
      output_snapshot: JSON.stringify({
        pool_size: createdCount,
        citations: result.citations,
        query_used: query,
        mocked: useMock,
        mirror_summary: {
          total_urls: totalUrls,
          uploaded: uploadedCount,
          failed: failedCount,
        },
      }),
    });

    await logLifecycle({
      entity_type: "BundleDraft",
      entity_id: draft.id,
      from_status: "DRAFT",
      to_status: "RESEARCHED",
      reason: `Research completed: ${createdCount} products in ${(durationMs / 1000).toFixed(1)}s`,
      actor: input.actor ?? "system",
      details: {
        pool_size: createdCount,
        trigger: input.trigger ?? "manual",
        mocked: useMock,
      },
    });

    return {
      ok: true,
      generation_job_id: jobId,
      pool_size: createdCount,
      duration_ms: durationMs,
      citations: result.citations,
      mocked: useMock,
      mirror_summary: {
        total_urls: totalUrls,
        uploaded: uploadedCount,
        failed: failedCount,
      },
    };
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    const durationMs = Date.now() - startMs;
    await upsertStage(jobId, "RESEARCH", "FAILED", {
      completed_at: new Date(),
      duration_ms: durationMs,
      error: errMsg,
    });
    return {
      ok: false,
      generation_job_id: jobId,
      pool_size: 0,
      duration_ms: durationMs,
      citations: [],
      mocked: false,
      mirror_summary: { total_urls: 0, uploaded: 0, failed: 0 },
      error: errMsg,
    };
  }
}

function buildQueryFromDraft(draft: {
  draft_name: string;
  brand: string;
  category: string;
  composition_type: string;
  pack_count: number;
}): string {
  const categoryHuman = draft.category.toLowerCase().replace(/_/g, " ");
  const typeHuman = draft.composition_type.toLowerCase().replace(/_/g, " ");
  return `Find retail products for a gift bundle: "${draft.draft_name}". Category: ${categoryHuman}. Composition type: ${typeHuman}. Target pack count: ${draft.pack_count}. Brand context: ${draft.brand}.`;
}

function extractBrandHint(draft: {
  brand: string;
  draft_name: string;
}): string | undefined {
  // Own brands are the listing's house brand — not a search hint. Pass
  // them through only when the user explicitly typed a foreign brand.
  if (OWN_BRANDS.some((own) => own.toLowerCase() === draft.brand.toLowerCase())) {
    return undefined;
  }
  return draft.brand;
}

function resolveStoreId(
  name: string | undefined | null,
  storeIdByChain: Map<string, string>,
): string | null {
  if (!name) return null;
  const lower = name.toLowerCase();
  for (const [chainKey, id] of storeIdByChain) {
    if (lower.includes(chainKey)) return id;
  }
  return null;
}

function slugifyProductName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
}

async function upsertStage(
  jobId: string,
  stage: string,
  status: string,
  extra: Record<string, unknown>,
) {
  const existing = await prisma.generationStage.findFirst({
    where: { generation_job_id: jobId, stage },
  });
  if (existing) {
    await prisma.generationStage.update({
      where: { id: existing.id },
      data: { status, ...extra },
    });
  } else {
    await prisma.generationStage.create({
      data: {
        generation_job_id: jobId,
        stage,
        status,
        started_at: new Date(),
        ...extra,
      },
    });
  }
}

// Type-only re-export so route handlers can import the product type.
export type { PerplexityResearchProduct };
