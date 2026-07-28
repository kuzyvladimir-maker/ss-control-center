/**
 * Phase 7 Stage 2 (donor path) — seed the ResearchPool from the Reference
 * Catalog instead of Perplexity.
 *
 * The Phase 2.1 research pipeline (`research-pipeline.ts`) fills ResearchPool
 * from a live Perplexity sonar-pro call. Phase 7 builds NEW gift-set listings
 * from products we already harvested into the Donor / Reference Catalog
 * (DonorProduct + DonorOffer, ~990 rows across 5 retailer nets). This module
 * is the donor-sourced twin of `runResearch`: same ResearchPool shape, same
 * R2 image mirror, same lifecycle bookkeeping — only the data source differs.
 *
 * Given a BundleDraft in DRAFT status and a hand-picked set of DonorProduct
 * ids, it:
 *   1. Marks GenerationStage(stage=RESEARCH, status=IN_PROGRESS).
 *   2. Wipes any prior ResearchPool rows for the same generation_job_id
 *      (idempotent re-runs — identical to runResearch).
 *   3. Loads the selected DonorProduct rows (+ their offers).
 *   4. Mirrors each donor's photos to R2 so persisted URLs live on our
 *      infrastructure (the donor `imageUrls` point at volatile retailer CDNs).
 *   5. Creates one ResearchPool row per donor, deriving the COGS basis
 *      (`avg_price_cents`) from the cheapest clean first-party DIRECT offer —
 *      this is the real procurement cost the ≥20% margin floor checks against.
 *   6. Updates BundleDraft.status → RESEARCHED.
 *   7. Marks GenerationStage COMPLETED (or FAILED on error) + lifecycle log.
 *
 * Cost: $0 of model spend (no Perplexity) + per-image R2 PUT.
 *
 * IMPORTANT — pricing: this module derives `avg_price_cents` as the *cost*
 * basis only (what WE pay to source the item). It never sets the *selling*
 * price. Per the Phase 7 rule, the selling price comes from the economics
 * module (≥20% margin) and is written to `draft_suggested_price_cents`
 * externally — never invented here or by the variation matrix's markup.
 */

import { prisma } from "@/lib/prisma";
import { mirrorImages } from "./r2-image-mirror";
import { logLifecycle } from "./lifecycle-log";

export interface SeedPoolFromDonorsInput {
  bundle_draft_id: string;
  /** DonorProduct ids hand-picked from the Reference Catalog. */
  donor_product_ids: string[];
  trigger?: "manual" | "auto";
  actor?: string;
}

export interface SeedPoolFromDonorsResult {
  ok: boolean;
  generation_job_id: string;
  /** How many donor ids the caller asked for. */
  donors_requested: number;
  /** How many of those resolved to a real DonorProduct row. */
  donors_found: number;
  /** How many ResearchPool rows were created. */
  pool_size: number;
  duration_ms: number;
  mirror_summary: {
    total_urls: number;
    uploaded: number;
    failed: number;
  };
  error?: string;
}

// A DonorProduct row with its offers eager-loaded.
type DonorWithOffers = Awaited<
  ReturnType<typeof loadDonors>
>[number];

async function loadDonors(ids: string[]) {
  return prisma.donorProduct.findMany({
    where: { id: { in: ids } },
    include: { offers: true },
  });
}

export async function seedPoolFromDonors(
  input: SeedPoolFromDonorsInput,
): Promise<SeedPoolFromDonorsResult> {
  const startMs = Date.now();

  const draft = await prisma.bundleDraft.findUnique({
    where: { id: input.bundle_draft_id },
  });
  if (!draft) {
    throw new Error(`BundleDraft ${input.bundle_draft_id} not found`);
  }
  if (draft.status !== "DRAFT") {
    throw new Error(
      `BundleDraft ${draft.id} is in status ${draft.status}, expected DRAFT`,
    );
  }

  const requestedIds = Array.from(new Set(input.donor_product_ids));
  if (requestedIds.length === 0) {
    throw new Error("donor_product_ids must contain at least one id");
  }

  const jobId = draft.generation_job_id;

  await upsertStage(jobId, "RESEARCH", "IN_PROGRESS", {
    started_at: new Date(),
  });

  // Clean slate so re-runs don't accumulate stale rows (mirrors runResearch).
  await prisma.researchPool.deleteMany({ where: { generation_job_id: jobId } });

  try {
    // Resolve retailer name → StoreRegistry.id via chain substring, same as
    // the Perplexity path. Tier 1 + Tier 2 covers our buy-zone retailers.
    const stores = await prisma.storeRegistry.findMany({
      where: { is_active: true, tier: { in: ["TIER_1", "TIER_2"] } },
      orderBy: { default_priority: "asc" },
      take: 30,
    });
    const storeIdByChain = new Map<string, string>();
    for (const s of stores) {
      storeIdByChain.set(s.chain.toLowerCase(), s.id);
    }

    const donors = await loadDonors(requestedIds);

    const researchQuery = `Donor-sourced bundle "${draft.draft_name}" — ${donors.length} reference products from the Reference Catalog.`;

    let totalUrls = 0;
    let uploadedCount = 0;
    let failedCount = 0;
    let createdCount = 0;

    for (const donor of donors) {
      // Donor images: mainImageUrl first, then the JSON imageUrls array.
      const donorUrls = collectDonorImageUrls(donor);
      let mirroredUrls: string[] = [];

      if (donorUrls.length > 0) {
        totalUrls += donorUrls.length;
        const slug = `donor-${draft.id}-${slugify(donorDisplayName(donor))}`;
        const mirrored = await mirrorImages({
          bundle_sku: slug,
          image_urls: donorUrls,
        });
        mirroredUrls = mirrored.map((m) => m.r2_url);
        uploadedCount += mirrored.filter((m) => m.uploaded).length;
        failedCount += mirrored.filter((m) => !m.uploaded).length;
      }

      const cogsCents = deriveCogsCents(donor);
      const sourceStoreId = resolveStoreId(
        bestRetailerName(donor),
        storeIdByChain,
      );

      try {
        await prisma.researchPool.create({
          data: {
            generation_job_id: jobId,
            research_query: researchQuery,
            product_name: donorDisplayName(donor),
            brand: donor.brand ?? "Unknown",
            manufacturer: donor.brand ?? null,
            upc: donor.upc ?? donor.gtin ?? null,
            flavors: donor.flavor ? JSON.stringify([donor.flavor]) : null,
            pack_sizes: derivePackSizes(donor),
            weight_oz: deriveWeightOz(donor),
            weight_lb: weightLbFromOz(deriveWeightOz(donor)),
            ingredients: donor.ingredients ?? null,
            allergens: null,
            nutrition: donor.nutritionFacts ?? null,
            storage_temp: storageTempFromCategory(donor.category),
            expiration_days: null,
            avg_price_cents: cogsCents,
            source_store_id: sourceStoreId,
            source_url: bestOfferUrl(donor),
            reference_image_urls: JSON.stringify(mirroredUrls),
            freshness_score: deriveFreshness(donor),
            last_seen_in_stock: new Date(),
          },
        });
        createdCount++;
      } catch (e) {
        console.error(
          `[donor-pool] failed to insert donor "${donorDisplayName(donor)}" (${donor.id}):`,
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
        source: "donor-catalog",
        pool_size: createdCount,
        donors_requested: requestedIds.length,
        donors_found: donors.length,
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
      reason: `Donor-seeded research: ${createdCount} products from Reference Catalog in ${(durationMs / 1000).toFixed(1)}s`,
      actor: input.actor ?? "system",
      details: {
        source: "donor-catalog",
        pool_size: createdCount,
        donors_requested: requestedIds.length,
        donors_found: donors.length,
        trigger: input.trigger ?? "manual",
      },
    });

    return {
      ok: true,
      generation_job_id: jobId,
      donors_requested: requestedIds.length,
      donors_found: donors.length,
      pool_size: createdCount,
      duration_ms: durationMs,
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
      donors_requested: requestedIds.length,
      donors_found: 0,
      pool_size: 0,
      duration_ms: durationMs,
      mirror_summary: { total_urls: 0, uploaded: 0, failed: 0 },
      error: errMsg,
    };
  }
}

// ── Donor → ResearchPool mapping helpers ────────────────────────────────────

/** Human label for a donor product, used as ResearchPool.product_name. */
function donorDisplayName(donor: DonorWithOffers): string {
  if (donor.title && donor.title.trim()) return donor.title.trim();
  const parts = [donor.brand, donor.productLine, donor.flavor, donor.size]
    .map((p) => (p ?? "").trim())
    .filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : `Donor ${donor.id}`;
}

/** mainImageUrl first, then any extra URLs from the JSON imageUrls array. */
function collectDonorImageUrls(donor: DonorWithOffers): string[] {
  const out: string[] = [];
  if (donor.mainImageUrl && donor.mainImageUrl.trim()) {
    out.push(donor.mainImageUrl.trim());
  }
  if (donor.imageUrls) {
    try {
      const parsed = JSON.parse(donor.imageUrls);
      if (Array.isArray(parsed)) {
        for (const u of parsed) {
          if (typeof u === "string" && u.trim() && !out.includes(u.trim())) {
            out.push(u.trim());
          }
        }
      }
    } catch {
      // imageUrls wasn't valid JSON — ignore, we already have mainImageUrl.
    }
  }
  return out;
}

/**
 * COGS basis in cents — the cheapest clean first-party DIRECT per-unit price.
 * Precedence: first-party direct pricePerUnit → any first-party price →
 * denormalized bestPrice. Instacart offers (`via='instacart'`, ≈ +15% markup)
 * are skipped for the cost basis so the margin floor is honest.
 */
function deriveCogsCents(donor: DonorWithOffers): number | null {
  const candidates: number[] = [];

  for (const offer of donor.offers) {
    const firstPartyDirect = offer.isFirstParty && offer.via === "direct";
    if (!firstPartyDirect) continue;
    const perUnit = offer.pricePerUnit ?? offer.price;
    if (typeof perUnit === "number" && perUnit > 0) candidates.push(perUnit);
  }

  if (candidates.length === 0) {
    // Fall back to any first-party offer (allow non-direct), still excluding
    // nothing worse than the denormalized rollup below.
    for (const offer of donor.offers) {
      if (!offer.isFirstParty) continue;
      const perUnit = offer.pricePerUnit ?? offer.price;
      if (typeof perUnit === "number" && perUnit > 0) candidates.push(perUnit);
    }
  }

  if (candidates.length === 0 && typeof donor.bestPrice === "number" && donor.bestPrice > 0) {
    candidates.push(donor.bestPrice);
  }

  if (candidates.length === 0) return null;
  const cheapestDollars = Math.min(...candidates);
  return Math.round(cheapestDollars * 100);
}

/** Retailer name of the cheapest first-party offer, for store resolution. */
function bestRetailerName(donor: DonorWithOffers): string | null {
  let best: { price: number; retailer: string } | null = null;
  for (const offer of donor.offers) {
    if (!offer.isFirstParty) continue;
    const perUnit = offer.pricePerUnit ?? offer.price;
    if (typeof perUnit !== "number" || perUnit <= 0) continue;
    if (!best || perUnit < best.price) {
      best = { price: perUnit, retailer: offer.retailer };
    }
  }
  return best?.retailer ?? donor.bestRetailer ?? null;
}

/** Product URL of the cheapest first-party offer, if any. */
function bestOfferUrl(donor: DonorWithOffers): string | null {
  let best: { price: number; url: string | null } | null = null;
  for (const offer of donor.offers) {
    if (!offer.isFirstParty) continue;
    const perUnit = offer.pricePerUnit ?? offer.price;
    if (typeof perUnit !== "number" || perUnit <= 0) continue;
    if (!best || perUnit < best.price) {
      best = { price: perUnit, url: offer.productUrl ?? null };
    }
  }
  return best?.url ?? null;
}

/** Distinct multipack sizes seen across offers, as a JSON array string. */
function derivePackSizes(donor: DonorWithOffers): string | null {
  const sizes = new Set<number>();
  for (const offer of donor.offers) {
    if (typeof offer.packSizeSeen === "number" && offer.packSizeSeen > 0) {
      sizes.add(offer.packSizeSeen);
    }
  }
  return sizes.size > 0 ? JSON.stringify(Array.from(sizes).sort((a, b) => a - b)) : null;
}

/** Normalize donor unit (oz/lb/floz/count) to ounces; null when not a weight. */
function deriveWeightOz(donor: DonorWithOffers): number | null {
  if (typeof donor.unitAmount !== "number" || donor.unitAmount <= 0) return null;
  switch ((donor.unitMeasure ?? "").toLowerCase()) {
    case "oz":
    case "floz":
      return donor.unitAmount;
    case "lb":
      return donor.unitAmount * 16;
    default:
      return null; // "count" and unknowns are not a weight
  }
}

function weightLbFromOz(oz: number | null): number | null {
  return typeof oz === "number" ? oz / 16 : null;
}

/** Map our Dry/Frozen/Refrigerated category to a storage-temp hint. */
function storageTempFromCategory(category: string | null): string | null {
  switch ((category ?? "").toLowerCase()) {
    case "frozen":
      return "frozen";
    case "refrigerated":
      return "refrigerated";
    case "dry":
      return "ambient";
    default:
      return null;
  }
}

/**
 * 0–100 freshness, matched to the scale the variation matrix sorts on.
 * Prefer the identify confidence; otherwise lean on in-stock signal.
 */
function deriveFreshness(donor: DonorWithOffers): number {
  if (typeof donor.confidence === "number") {
    return Math.round(Math.max(0, Math.min(1, donor.confidence)) * 100);
  }
  const anyInStock = donor.offers.some((o) => o.inStock === true);
  return anyInStock ? 80 : 50;
}

/** Resolve a retailer name to StoreRegistry.id via chain substring match. */
function resolveStoreId(
  name: string | undefined | null,
  storeIdByChain: Map<string, string>,
): string | null {
  if (!name) return null;
  const lower = name.toLowerCase();
  for (const [chainKey, id] of storeIdByChain) {
    if (lower.includes(chainKey) || chainKey.includes(lower)) return id;
  }
  return null;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
}

// upsertStage mirrors the helper in research-pipeline.ts (same GenerationStage
// bookkeeping). Kept local so the donor path has no import cycle on the
// Perplexity pipeline.
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
