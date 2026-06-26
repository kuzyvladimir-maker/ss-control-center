/**
 * Phase 2.4 Stage 6 — lazy promotion of BundleDraft → MasterBundle +
 * per-channel ChannelSKU rows.
 *
 * Validation operates on ChannelSKU, but the upstream pipeline (Stages
 * 1-5) lives entirely on BundleDraft + GeneratedContent. This helper
 * bridges the two: for every GeneratedContent row that's
 * compliance_status='CAN_PUBLISH' AND main_image_url is set, we
 * materialise a ChannelSKU. Idempotent — re-running on a draft that
 * already has SKUs skips them.
 *
 * Best-effort. If the UPCPool is exhausted for an unassigned slot we
 * skip that channel and report it as a warning to the caller; the
 * orchestrator surfaces this through the API response so the operator
 * can fill the pool and re-run.
 *
 * One MasterBundle per draft. Subsequent SKUs share that MasterBundle.
 */

import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import {
  countDistinctBrands,
  resolveAmazonBrowseNode,
} from "../browse-node-resolver";
import {
  getPricingModel,
  computeListingPriceCents,
  type PricingModel,
} from "../pricing-config";

export interface PromoteOutcome {
  master_bundle_id: string | null;
  /** Channels for which a new ChannelSKU was created in this call. */
  created_channels: string[];
  /** Channels that already had a ChannelSKU and were left alone. */
  existing_channels: string[];
  /** Channels we wanted to promote but couldn't (no UPC available, or
   *  the GeneratedContent row didn't qualify). */
  skipped: Array<{ channel: string; reason: string }>;
}

const SKU_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // exclude I + O for legibility
const SKU_ALNUM = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function pick(alphabet: string, n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

/** Salutem SKU shape XX-XXXX-XXXX. Brand prefix derived from brand name. */
function brandPrefix(brand: string): string {
  const norm = brand.replace(/[^A-Za-z]/g, "").toUpperCase();
  if (norm.startsWith("SALUTEM")) return "SV"; // Salutem Vita
  if (norm.startsWith("STARFIT")) return "SF";
  return pick(SKU_LETTERS, 2);
}

/** Per-channel suffix. Walmart → WL, Amazon variants → A1..A5, etc. */
function channelCode(channel: string): string {
  switch (channel) {
    case "AMAZON_PERSONAL":  return "AP";
    case "AMAZON_SALUTEM":   return "AS";
    case "AMAZON_AMZCOM":    return "AC";
    case "AMAZON_SIRIUS":    return "AX";
    case "AMAZON_RETAILER":  return "AR";
    case "WALMART":          return "WM";
    case "EBAY":             return "EB";
    case "TIKTOK_1":         return "T1";
    case "TIKTOK_2":         return "T2";
    default:                 return "GN";
  }
}

function buildSku(brand: string, channel: string, draftId: string): string {
  // XX (brand) - XXXX (channel + 2 chars from draft) - XXXX (random)
  const head = brandPrefix(brand);
  const cc = channelCode(channel);
  const slug = draftId.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(-2);
  const mid = `${cc}${slug}`.padEnd(4, "X").slice(0, 4);
  const tail = pick(SKU_ALNUM, 4);
  return `${head}-${mid}-${tail}`;
}

async function reserveUpc(draftId: string): Promise<{ id: string; upc: string } | null> {
  // Atomic-ish: pull one AVAILABLE row, claim it. SQLite + Prisma
  // doesn't give us SELECT FOR UPDATE, but the @unique constraint on
  // assigned_to_id provides the race-condition safety net.
  const row = await prisma.uPCPool.findFirst({
    where: { status: "AVAILABLE", assigned_to_id: null },
    orderBy: { acquired_at: "asc" }, // FIFO so oldest pool entries get used
    select: { id: true, upc: true },
  });
  if (!row) return null;
  try {
    await prisma.uPCPool.update({
      where: { id: row.id, status: "AVAILABLE" }, // gated update
      data: {
        status: "RESERVED",
        reserved_for_id: draftId,
        reserved_at: new Date(),
        reserved_until: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    });
    return row;
  } catch {
    return null;
  }
}

async function ensureMasterBundle(
  draftId: string,
  model: PricingModel,
): Promise<string> {
  const draft = await prisma.bundleDraft.findUniqueOrThrow({
    where: { id: draftId },
    select: {
      master_bundle_id: true,
      draft_name: true,
      brand: true,
      category: true,
      composition_type: true,
      pack_count: true,
      draft_components: true,
      generation_job_id: true,
      draft_main_image_url: true,
      draft_cost_cents: true,
      generated_content: {
        select: { main_image_url: true },
      },
    },
  });
  if (draft.master_bundle_id) return draft.master_bundle_id;

  // Pull the first image we generated as the master default.
  const firstImage =
    draft.generated_content.find((g) => g.main_image_url)?.main_image_url ??
    draft.draft_main_image_url ??
    "https://placehold.co/1024x1024/e5e5e5/666666.png?text=pending+main";

  // COGS basis = the bundle's GOODS cost (pack_count × donor unit price),
  // carried on the draft as draft_cost_cents. Earlier this summed the AI
  // generation cost (~1¢) instead, which made the margin validator price
  // against a near-zero basis — wrong. The selling price is then the pricing
  // model applied to this COGS.
  const estimatedCost = draft.draft_cost_cents ?? 0;

  const slugBase = draft.draft_name
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase()
    .slice(0, 60) || "bundle";
  const internalSlug = `${slugBase}-${draftId.slice(-6)}`;

  const created = await prisma.masterBundle.create({
    data: {
      name: draft.draft_name,
      internal_slug: internalSlug,
      brand: draft.brand,
      category: draft.category,
      composition_type: draft.composition_type,
      pack_count: draft.pack_count,
      cost_breakdown: JSON.stringify({
        goods_cents: estimatedCost,
        packaging_cents: 0,
        sourcing_overhead_cents: 0,
      }),
      estimated_cost_cents: estimatedCost,
      suggested_price_cents: computeListingPriceCents(estimatedCost, model),
      packaging_spec: JSON.stringify({}),
      main_image_url: firstImage,
      secondary_images: JSON.stringify([]),
    },
    select: { id: true },
  });

  await prisma.bundleDraft.update({
    where: { id: draftId },
    data: { master_bundle_id: created.id },
  });
  return created.id;
}

/**
 * Materialise ChannelSKU rows from every CAN_PUBLISH+with-image
 * GeneratedContent. Returns what was created vs. what already existed.
 */
export async function promoteDraftToChannelSkus(
  draftId: string,
): Promise<PromoteOutcome> {
  const pricingModel = await getPricingModel();
  const masterBundleId = await ensureMasterBundle(draftId, pricingModel);

  // Auto retail price = pricing model applied to the bundle's COGS. Read the
  // basis straight off the (now-correct) MasterBundle so every SKU prices
  // identically and the margin validator can clear the floor.
  const masterForPrice = await prisma.masterBundle.findUnique({
    where: { id: masterBundleId },
    select: { estimated_cost_cents: true },
  });
  const autoPriceCents = computeListingPriceCents(
    masterForPrice?.estimated_cost_cents ?? 0,
    pricingModel,
  );

  const candidates = await prisma.generatedContent.findMany({
    where: {
      bundle_draft_id: draftId,
      compliance_status: "CAN_PUBLISH",
      main_image_url: { not: null },
    },
  });

  const created: string[] = [];
  const existing: string[] = [];
  const skipped: Array<{ channel: string; reason: string }> = [];

  const draft = await prisma.bundleDraft.findUniqueOrThrow({
    where: { id: draftId },
    select: { brand: true },
  });

  // Browse node depends on the bundle's brand mix, not the channel.
  // Pull the MasterBundle's BundleComponents once and compute the
  // distinct-brand count so resolveAmazonBrowseNode can decide.
  const components = await prisma.bundleComponent.findMany({
    where: { master_bundle_id: masterBundleId },
    select: { manufacturer_brand: true },
  });
  const distinctBrands = countDistinctBrands(
    components.map((c) => ({ brand: c.manufacturer_brand })),
  );

  for (const row of candidates) {
    // Already a ChannelSKU for this MasterBundle × channel?
    const existingSku = await prisma.channelSKU.findFirst({
      where: { master_bundle_id: masterBundleId, channel: row.channel },
      select: { id: true },
    });
    if (existingSku) {
      existing.push(row.channel);
      continue;
    }
    const upcRow = await reserveUpc(draftId);
    if (!upcRow) {
      skipped.push({
        channel: row.channel,
        reason: "UPCPool exhausted — no AVAILABLE rows left",
      });
      continue;
    }
    const sku = buildSku(draft.brand, row.channel, draftId);
    try {
      const skuRow = await prisma.channelSKU.create({
        data: {
          master_bundle_id: masterBundleId,
          channel: row.channel,
          sku,
          upc: upcRow.upc,
          upc_pool_id: upcRow.id,
          title: row.title,
          bullets: row.bullets_json,
          description: row.description,
          attributes: JSON.stringify({}),
          channel_browse_node: resolveAmazonBrowseNode({
            channel: row.channel,
            distinct_brands: distinctBrands,
          }),
          price_cents: autoPriceCents, // auto — pricing model × COGS
          main_image_url: row.main_image_url,
          compliance_status: "CAN_PUBLISH",
          compliance_check_id: row.compliance_check_id,
        } as Prisma.ChannelSKUUncheckedCreateInput,
        select: { id: true },
      });
      // Flip UPCPool → ASSIGNED.
      await prisma.uPCPool.update({
        where: { id: upcRow.id },
        data: {
          status: "ASSIGNED",
          assigned_to_id: skuRow.id,
          reserved_for_id: null,
          reserved_at: null,
          reserved_until: null,
        },
      });
      created.push(row.channel);
    } catch (e) {
      skipped.push({
        channel: row.channel,
        reason: `create failed: ${e instanceof Error ? e.message : String(e)}`,
      });
      // Best-effort: release the UPC reservation so it's reusable.
      await prisma.uPCPool.update({
        where: { id: upcRow.id },
        data: {
          status: "AVAILABLE",
          reserved_for_id: null,
          reserved_at: null,
          reserved_until: null,
        },
      }).catch(() => {});
    }
  }

  return {
    master_bundle_id: masterBundleId,
    created_channels: created,
    existing_channels: existing,
    skipped,
  };
}
