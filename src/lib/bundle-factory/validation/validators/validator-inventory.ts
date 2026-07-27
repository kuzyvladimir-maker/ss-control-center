/**
 * Phase 2.4 Stage 6 — Validator 12: Inventory presence.
 *
 * For each bundle component, ask Veeqo "do we have stock for the
 * product with this UPC?". If Veeqo is reachable AND the lookup
 * succeeds, derive sellable BUNDLES as min(floor(component stock / recipe qty)).
 * Missing UPC, unreachable Veeqo, or no catalogue match is an ERROR: unknown
 * inventory must never become an invented marketplace quantity.
 *
 * Veeqo has no native "search by UPC" endpoint in our client. We use
 * /products?query=<upc> which surfaces matching products; on success
 * we read one inventory level per returned product. Veeqo may expose the same
 * stock at product, variant, and stock-entry levels; those representations are
 * alternatives, not additive, so summing all three would inflate availability.
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
    let observed = false;
    for (const p of list) {
      const variantLevels = (p.product_variants ?? [])
        .map((variant) => variant.sellable_stock_level)
        .filter((value): value is number => typeof value === "number");
      const entryLevels = (p.stock_entries ?? [])
        .map((entry) => entry.sellable_stock_level)
        .filter((value): value is number => typeof value === "number");

      if (variantLevels.length > 0) {
        total += variantLevels.reduce((sum, value) => sum + value, 0);
        observed = true;
      } else if (entryLevels.length > 0) {
        total += entryLevels.reduce((sum, value) => sum + value, 0);
        observed = true;
      } else if (typeof p.sellable_stock_level === "number") {
        total += p.sellable_stock_level;
        observed = true;
      }
    }
    return observed ? total : null;
  } catch {
    return null;
  }
}

export interface InventoryComponent {
  manufacturer_upc: string | null;
  qty: number;
}

export interface BundleInventoryResult {
  available_quantity: number | null;
  missing_upcs: number;
  inconclusive_upcs: string[];
  out_of_stock_upcs: string[];
  component_stock: Array<{ upc: string; stock: number; required_per_bundle: number }>;
}

export async function deriveBundleInventory(
  components: InventoryComponent[],
  stockLookup: (upc: string) => Promise<number | null> = lookupStock,
): Promise<BundleInventoryResult> {
  const requiredByUpc = new Map<string, number>();
  let missingUpcs = 0;
  for (const component of components) {
    const upc = component.manufacturer_upc?.trim();
    if (!upc || !Number.isInteger(component.qty) || component.qty <= 0) {
      missingUpcs += 1;
      continue;
    }
    requiredByUpc.set(upc, (requiredByUpc.get(upc) ?? 0) + component.qty);
  }
  const upcs = Array.from(requiredByUpc.keys());
  const stocks = await Promise.all(upcs.map((upc) => stockLookup(upc)));
  const inconclusive: string[] = [];
  const outOfStock: string[] = [];
  const componentStock: BundleInventoryResult["component_stock"] = [];
  let available = Number.POSITIVE_INFINITY;
  for (let i = 0; i < upcs.length; i++) {
    const upc = upcs[i];
    const stock = stocks[i];
    const required = requiredByUpc.get(upc)!;
    if (stock == null) {
      inconclusive.push(upc);
      continue;
    }
    const normalizedStock = Math.max(0, Math.floor(stock));
    componentStock.push({ upc, stock: normalizedStock, required_per_bundle: required });
    const bundles = Math.floor(normalizedStock / required);
    available = Math.min(available, bundles);
    if (bundles <= 0) outOfStock.push(upc);
  }
  const conclusive =
    missingUpcs === 0 &&
    upcs.length > 0 &&
    inconclusive.length === 0 &&
    Number.isFinite(available);
  return {
    available_quantity: conclusive ? available : null,
    missing_upcs: missingUpcs,
    inconclusive_upcs: inconclusive,
    out_of_stock_upcs: outOfStock,
    component_stock: componentStock,
  };
}

export const validatorInventory: ValidatorFn = async ({ bundle_components }) => {
  if (bundle_components.length === 0) {
    return {
      validator_id: "validator-inventory",
      passed: false,
      severity: "error",
      message: "Bundle has no components — inventory cannot be derived.",
    };
  }

  const result = await deriveBundleInventory(bundle_components);
  if (result.missing_upcs > 0) {
    return {
      validator_id: "validator-inventory",
      passed: false,
      severity: "error",
      message: `${result.missing_upcs} recipe component(s) have no valid manufacturer UPC — inventory cannot be derived.`,
      details: { ...result },
    };
  }
  if (result.out_of_stock_upcs.length > 0 || result.available_quantity === 0) {
    return {
      validator_id: "validator-inventory",
      passed: false,
      severity: "error",
      message: `Insufficient component stock to assemble one bundle: ${result.out_of_stock_upcs.join(", ")}.`,
      details: { ...result },
    };
  }
  if (result.inconclusive_upcs.length > 0 || result.available_quantity == null) {
    return {
      validator_id: "validator-inventory",
      passed: false,
      severity: "error",
      message: `Veeqo inventory is unknown for ${result.inconclusive_upcs.length} component UPC(s); publication is fail-closed.`,
      details: { ...result },
    };
  }
  return {
    validator_id: "validator-inventory",
    passed: true,
    details: {
      ...result,
      checked: result.component_stock.length,
      all_in_stock: true,
      bundle_available_quantity: result.available_quantity,
    },
  };
};
