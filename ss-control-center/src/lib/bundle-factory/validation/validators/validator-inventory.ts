/**
 * Phase 2.4 Stage 6 — Validator 12: Inventory presence.
 *
 * For each bundle component, ask Veeqo "do we have stock for the
 * product with this UPC?". If Veeqo is reachable AND the lookup
 * succeeds AND total available stock is zero, fail as an ERROR. If
 * Veeqo is unreachable OR the product isn't found in Veeqo (data not
 * yet imported), surface as WARNING (NEEDS_REVIEW) — we don't want a
 * flaky operational dependency to block the entire pipeline.
 *
 * Veeqo has no native "search by UPC" endpoint in our client. We use
 * /products?query=<upc> which surfaces matching products; on success
 * we sum sellable_stock_level across all stock entries.
 */

import { veeqoFetch } from "@/lib/veeqo/client";
import type { ValidatorFn } from "../types";

interface VeeqoProductLite {
  id?: number;
  sellable_stock_level?: number | null;
  stock_entries?: Array<{ sellable_stock_level?: number | null }>;
  product_variants?: Array<{ sellable_stock_level?: number | null }>;
}

async function lookupStock(upc: string): Promise<number | null> {
  // null = inconclusive (Veeqo error, or no match in catalogue)
  if (!upc) return null;
  try {
    const res = (await veeqoFetch(
      `/products?query=${encodeURIComponent(upc)}&page_size=5`,
    )) as VeeqoProductLite[] | { products?: VeeqoProductLite[] } | null;
    if (!res) return null;
    const list: VeeqoProductLite[] = Array.isArray(res)
      ? res
      : Array.isArray(res.products)
        ? res.products
        : [];
    if (list.length === 0) return null;
    let total = 0;
    for (const p of list) {
      if (typeof p.sellable_stock_level === "number") {
        total += p.sellable_stock_level;
      }
      for (const v of p.product_variants ?? []) {
        if (typeof v.sellable_stock_level === "number") {
          total += v.sellable_stock_level;
        }
      }
      for (const s of p.stock_entries ?? []) {
        if (typeof s.sellable_stock_level === "number") {
          total += s.sellable_stock_level;
        }
      }
    }
    return total;
  } catch {
    return null;
  }
}

export const validatorInventory: ValidatorFn = async ({ bundle_components }) => {
  if (bundle_components.length === 0) {
    return {
      validator_id: "validator-inventory",
      passed: false,
      severity: "warning",
      message: "Bundle has no components — inventory check skipped.",
    };
  }

  const upcsToCheck = bundle_components
    .map((c) => c.manufacturer_upc)
    .filter((u): u is string => typeof u === "string" && u.length > 0);

  if (upcsToCheck.length === 0) {
    return {
      validator_id: "validator-inventory",
      passed: false,
      severity: "warning",
      message: "No manufacturer_upc on any bundle component — cannot query Veeqo. Manually verify stock.",
    };
  }

  const checks = await Promise.all(upcsToCheck.map((u) => lookupStock(u)));

  const outOfStock: string[] = [];
  const inconclusive: string[] = [];
  for (let i = 0; i < upcsToCheck.length; i++) {
    const upc = upcsToCheck[i];
    const stock = checks[i];
    if (stock === null) {
      inconclusive.push(upc);
    } else if (stock <= 0) {
      outOfStock.push(upc);
    }
  }

  if (outOfStock.length > 0) {
    return {
      validator_id: "validator-inventory",
      passed: false,
      severity: "error",
      message: `Out-of-stock components (Veeqo sellable_stock_level=0): ${outOfStock.join(", ")}.`,
      details: { out_of_stock_upcs: outOfStock, inconclusive_upcs: inconclusive },
    };
  }
  if (inconclusive.length > 0) {
    return {
      validator_id: "validator-inventory",
      passed: false,
      severity: "warning",
      message: `Veeqo returned no data for ${inconclusive.length}/${upcsToCheck.length} component UPCs. Manually verify stock.`,
      details: { inconclusive_upcs: inconclusive },
    };
  }
  return {
    validator_id: "validator-inventory",
    passed: true,
    details: { checked: upcsToCheck.length, all_in_stock: true },
  };
};
