/**
 * UPC burn-on-reject loop (Bundle Factory · Amazon).
 *
 * The SpeedyBarcode pool is only verified free against OUR Veeqo — it can't
 * prove a barcode is globally free on Amazon (GS1 codes get resold; the truth
 * is the marketplace's own publish response). So the pipeline self-cleans:
 *
 *   reserve → publish → poll →
 *     • success            → keep the barcode (UPCPool stays ASSIGNED)
 *     • "code already used" → BURN this barcode, take the next AVAILABLE one,
 *                             DELETE the tainted Amazon contribution, re-publish
 *     • any other error     → leave the barcode alone (not a UPC problem)
 *
 * Proven necessary 2026-07-01: barcode 742259000034 passed a Catalog-API
 * pre-check ("free") yet the real PUT returned Amazon error 8541
 * (standard_product_id conflicts with ASIN B0H75VN18Z). Pre-checking is
 * unreliable; only the publish response is authoritative.
 *
 * A plain PUT that swaps the UPC on an already-collided SKU does NOT clear the
 * collision — Amazon keeps the original contribution's issue. So a heal step
 * DELETEs the listing before re-creating it on the fresh barcode.
 */

import { prisma } from "@/lib/prisma";
import type { ChannelSKU } from "@/generated/prisma/client";

import { spApiDelete, MARKETPLACE_ID } from "@/lib/amazon-sp-api/client";
import { getMerchantToken } from "@/lib/amazon-sp-api/sellers";
import { logLifecycle } from "@/lib/bundle-factory/lifecycle-log";
import { submitToAmazon } from "./amazon-publish";

export interface Issue {
  code?: string;
  message?: string;
  severity?: string;
}

/** Amazon issue codes that specifically mean "this product identifier is
 *  already registered to another ASIN" (barcode collision). */
const UPC_CONFLICT_CODES = new Set([
  "8541", // "standard_product_id conflicts with the ASIN in the catalog"
  "100980", // barcode already linked to an existing product
  "90059", // duplicate product identifier
]);

/** True if ANY issue looks like a barcode/GTIN collision (vs. a brand-gating,
 *  attribute, or image problem — those must NOT burn the barcode). Matches by
 *  code first, then a conservative message scan. */
export function isUpcConflictIssue(issues: Issue[] | null | undefined): boolean {
  if (!issues || issues.length === 0) return false;
  return issues.some((i) => {
    const code = String(i.code ?? "").trim();
    if (UPC_CONFLICT_CODES.has(code)) return true;
    const msg = (i.message ?? "").toLowerCase();
    if (!msg) return false;
    return (
      /standard_product_id\s+conflicts/.test(msg) ||
      /conflicts?\s+with\s+(an?\s+|the\s+)?asin/.test(msg) ||
      /more than one asin matching/.test(msg) ||
      /(already)\s+(been\s+)?(used|registered|linked|assigned|associated)/.test(msg) ||
      /(upc|ean|gtin|barcode|product id(?:entifier)?)\b.*\b(already|conflict|in use|another|exist)/.test(msg) ||
      /matching product .* found in the .* catalog/.test(msg)
    );
  });
}

export interface ReBarcodeResult {
  ok: boolean;
  old_upc: string;
  new_upc?: string;
  reason?: string;
}

/**
 * Burn the SKU's current barcode and attach the next AVAILABLE pool barcode.
 * Returns ok:false with reason="pool_exhausted" when no AVAILABLE row remains.
 *
 * Order is chosen to respect the 1:1 @unique links (UPCPool.assigned_to_id and
 * ChannelSKU.upc_pool_id): detach+burn the old row first, then claim+attach the
 * new row.
 */
export async function reBarcodeSku(
  skuId: string,
  burnReason: string,
): Promise<ReBarcodeResult> {
  const sku = await prisma.channelSKU.findUnique({
    where: { id: skuId },
    select: { id: true, upc: true, upc_pool_id: true },
  });
  if (!sku) return { ok: false, old_upc: "", reason: "sku_not_found" };
  const oldUpc = sku.upc;

  // 1) Burn + detach the current pool row (if it's a managed pool barcode).
  if (sku.upc_pool_id) {
    await prisma.uPCPool.update({
      where: { id: sku.upc_pool_id },
      data: {
        status: "BURNED",
        assigned_to_id: null,
        reserved_for_id: null,
        reserved_at: null,
        reserved_until: null,
        notes: `BURNED ${new Date().toISOString()}: ${burnReason} (was on SKU ${sku.id})`,
      },
    });
  }

  // 2) Claim the next AVAILABLE barcode, FIFO by acquired_at (stable order).
  const next = await prisma.uPCPool.findFirst({
    where: { status: "AVAILABLE", assigned_to_id: null },
    orderBy: { acquired_at: "asc" },
    select: { id: true, upc: true },
  });
  if (!next) {
    // Detach the SKU from the burned row so it isn't left pointing at a
    // BURNED barcode; caller decides what to do with an unbarcoded SKU.
    await prisma.channelSKU
      .update({ where: { id: skuId }, data: { upc_pool_id: null } })
      .catch(() => {});
    return { ok: false, old_upc: oldUpc, reason: "pool_exhausted" };
  }

  // 3) Attach the new barcode to the SKU and reset its distribution state so the
  //    pipeline re-publishes it as a fresh submission.
  await prisma.channelSKU.update({
    where: { id: skuId },
    data: {
      upc: next.upc,
      upc_pool_id: next.id,
      listing_status: "PENDING",
      submission_id: null,
      distribution_errors: null,
    },
  });
  await prisma.uPCPool.update({
    where: { id: next.id },
    data: {
      status: "ASSIGNED",
      assigned_to_id: skuId,
      reserved_for_id: null,
      reserved_at: null,
      reserved_until: null,
    },
  });

  await logLifecycle({
    entity_type: "ChannelSKU",
    entity_id: skuId,
    from_status: "SUBMITTED",
    to_status: "PENDING",
    reason: `UPC burned (${burnReason}) — re-barcoded ${oldUpc} → ${next.upc}`,
    actor: "upc-burn",
    details: { old_upc: oldUpc, new_upc: next.upc },
  }).catch(() => {});

  return { ok: true, old_upc: oldUpc, new_upc: next.upc };
}

/**
 * DELETE a listing contribution on Amazon so it can be re-created fresh on a new
 * barcode. Best-effort — a 404/NOT_FOUND is fine (nothing to delete).
 */
export async function deleteAmazonListing(
  sku: Pick<ChannelSKU, "sku">,
  storeIndex: number,
): Promise<{ ok: boolean; error?: string }> {
  let sellerId: string;
  try {
    sellerId = await getMerchantToken(storeIndex);
  } catch (e) {
    return { ok: false, error: `sellerId: ${e instanceof Error ? e.message : String(e)}` };
  }
  const path = `/listings/2021-08-01/items/${encodeURIComponent(sellerId)}/${encodeURIComponent(sku.sku)}`;
  try {
    await spApiDelete(path, {
      storeId: `store${storeIndex}`,
      params: { marketplaceIds: MARKETPLACE_ID },
    });
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // A missing listing is a non-error for our purposes.
    if (/404|not.?found/i.test(msg)) return { ok: true };
    return { ok: false, error: msg };
  }
}

export interface HealResult {
  healed: boolean;
  old_upc?: string;
  new_upc?: string;
  republished: boolean;
  submission_id?: string | null;
  amazon_status?: string | null;
  reason?: string;
}

/**
 * One heal iteration for a barcode-collided Amazon SKU:
 *   DELETE the tainted contribution → burn old UPC + attach next AVAILABLE →
 *   re-PUT on the fresh barcode.
 *
 * Returns healed:false when the pool is exhausted (nothing left to try) or the
 * delete/re-barcode failed. republished reflects whether the fresh PUT was
 * accepted; the caller polls again for the terminal result.
 */
export async function healUpcConflict(
  sku: ChannelSKU,
  opts: { storeIndex: number; brand?: string | null; productType: string },
): Promise<HealResult> {
  // 1) Remove the collided contribution (fresh PUT with a new UPC won't clear it).
  const del = await deleteAmazonListing(sku, opts.storeIndex);
  if (!del.ok) {
    return { healed: false, republished: false, reason: `delete_failed: ${del.error}` };
  }

  // 2) Burn the colliding barcode, claim the next AVAILABLE one.
  const rb = await reBarcodeSku(sku.id, "Amazon barcode collision (UPC already registered)");
  if (!rb.ok) {
    return {
      healed: false,
      old_upc: rb.old_upc,
      republished: false,
      reason: rb.reason ?? "rebarcode_failed",
    };
  }

  // 3) Re-publish on the fresh barcode (reload the SKU to pick up the new UPC).
  const fresh = await prisma.channelSKU.findUnique({ where: { id: sku.id } });
  if (!fresh) {
    return { healed: true, old_upc: rb.old_upc, new_upc: rb.new_upc, republished: false, reason: "sku_vanished" };
  }
  const r = await submitToAmazon({
    sku: fresh,
    storeIndex: opts.storeIndex,
    productType: opts.productType,
    brand: opts.brand,
    dryRun: false,
    validatePreviewFirst: false,
  });
  await prisma.channelSKU
    .update({
      where: { id: sku.id },
      data: {
        listing_status: r.ok ? "SUBMITTED" : "FAILED",
        submission_id: r.submission_id ?? undefined,
        submitted_at: r.ok ? new Date() : undefined,
        distribution_attempt_count: { increment: 1 },
        last_status_check_at: new Date(),
        distribution_errors: r.issues.length ? JSON.stringify(r.issues) : null,
      },
    })
    .catch(() => {});

  return {
    healed: true,
    old_upc: rb.old_upc,
    new_upc: rb.new_upc,
    republished: r.ok,
    submission_id: r.submission_id,
    amazon_status: r.amazon_status,
    reason: r.ok ? undefined : r.error ?? "republish_rejected",
  };
}
