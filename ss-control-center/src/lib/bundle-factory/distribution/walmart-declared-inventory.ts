/**
 * Put the declared quantity on every ship node once a listing is live.
 *
 * The MP_ITEM feed carries inventory for exactly ONE fulfillment center — the
 * one named in offer_handoff. The account has three ship nodes, and the owner's
 * instruction (2026-08-02) is 50 units on every one of them, because the
 * business is buy-to-order: the number is a published availability figure, not
 * a claim about shelves. Without this step a new listing would show stock in
 * one warehouse and nothing in the other two.
 *
 * Scope is deliberately narrow. It runs only for a Walmart SKU this factory
 * just published, only on the transition to LIVE, and only with the quantity
 * that SKU already declared in its own attributes. It never touches an
 * existing catalogue item's stock.
 */

import {
  WALMART_STUDIO_DECLARED_INVENTORY_UNITS,
  isWalmartStudioLane,
} from "@/lib/bundle-factory/walmart-studio-listing";
import { getWalmartClient } from "@/lib/walmart/client";
import {
  readInventoryAcrossNodes,
  setInventoryAllNodes,
} from "@/lib/walmart/inventory";

export interface WalmartDeclaredInventoryReport {
  sku: string;
  declared_quantity: number;
  nodes_written: number;
  nodes_failed: string[];
  verified_total: number | null;
  ok: boolean;
  skipped_reason?: string;
}

/** The quantity this SKU published as its offer handoff. */
export function declaredQuantityFromAttributes(
  attributes: string | null | undefined,
): number | null {
  if (!attributes) return null;
  try {
    const parsed = JSON.parse(attributes) as {
      walmart?: { offer_handoff?: { quantity?: unknown } };
    };
    const quantity = Number(parsed.walmart?.offer_handoff?.quantity);
    return Number.isInteger(quantity) && quantity > 0 ? quantity : null;
  } catch {
    return null;
  }
}

export async function syncWalmartDeclaredInventory(
  sku: { sku: string; attributes: string | null },
  options: { storeIndex?: number } = {},
): Promise<WalmartDeclaredInventoryReport> {
  const base: WalmartDeclaredInventoryReport = {
    sku: sku.sku,
    declared_quantity: 0,
    nodes_written: 0,
    nodes_failed: [],
    verified_total: null,
    ok: false,
  };
  // Only listings this lane built declare their own availability; anything
  // else keeps whatever inventory policy already governs it.
  if (!isWalmartStudioLane(sku.attributes)) {
    return { ...base, ok: true, skipped_reason: "not_a_studio_listing" };
  }
  const declared = declaredQuantityFromAttributes(sku.attributes)
    ?? WALMART_STUDIO_DECLARED_INVENTORY_UNITS;
  const storeIndex = options.storeIndex ?? 1;
  const client = getWalmartClient(storeIndex);

  const writes = await setInventoryAllNodes(client, storeIndex, sku.sku, declared);
  const failed = writes.filter((write) => !write.ok);
  // Walmart applies inventory asynchronously, so this read is evidence of what
  // it accepted, not proof of the final state; the number is recorded either
  // way so a shortfall is visible instead of assumed away.
  let verifiedTotal: number | null = null;
  try {
    const readback = await readInventoryAcrossNodes(client, storeIndex, sku.sku);
    verifiedTotal = readback.totalQty;
  } catch {
    verifiedTotal = null;
  }

  return {
    sku: sku.sku,
    declared_quantity: declared,
    nodes_written: writes.length - failed.length,
    nodes_failed: failed.map((write) => write.shipNode),
    verified_total: verifiedTotal,
    ok: failed.length === 0 && writes.length > 0,
  };
}
