// SKU → fee category resolution.
//
// Almost everything we sell is a food bundle, so the default is "grocery_food".
// Exceptions are stored as Setting rows ("economics:category:<sku>") rather than
// a dedicated table — only the handful of non-food SKUs need an entry.

import { prisma } from "@/lib/prisma";
import type { FeeCategory } from "./types";

export const DEFAULT_CATEGORY: FeeCategory = "grocery_food";

const VALID = new Set<FeeCategory>([
  "grocery_food",
  "health_personal_care",
  "beauty",
  "home_kitchen",
  "pet",
  "other",
]);

const settingKey = (sku: string) => `economics:category:${sku}`;

function coerce(value: string | null | undefined): FeeCategory {
  return value && VALID.has(value as FeeCategory) ? (value as FeeCategory) : DEFAULT_CATEGORY;
}

/** Resolve one SKU's fee category (Setting override → default). */
export async function resolveSkuCategory(sku: string): Promise<FeeCategory> {
  const row = await prisma.setting.findUnique({ where: { key: settingKey(sku) } });
  return coerce(row?.value);
}

/** Batch version — one query for many SKUs. SKUs without an override map to the
 *  default, so the returned map always has an entry for every input SKU. */
export async function resolveSkuCategories(
  skus: string[],
): Promise<Map<string, FeeCategory>> {
  const out = new Map<string, FeeCategory>();
  for (const sku of skus) out.set(sku, DEFAULT_CATEGORY);
  if (skus.length === 0) return out;

  const rows = await prisma.setting.findMany({
    where: { key: { in: skus.map(settingKey) } },
  });
  for (const r of rows) {
    const sku = r.key.slice("economics:category:".length);
    out.set(sku, coerce(r.value));
  }
  return out;
}
