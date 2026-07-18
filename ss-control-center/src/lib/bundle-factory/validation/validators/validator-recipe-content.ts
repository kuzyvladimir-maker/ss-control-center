/** Deterministic recipe ↔ listing-content fidelity gate. */

import { parseTotal } from "@/lib/pricing/cost-model";
import { isOwnBrandPassthrough } from "../../own-brand";
import type { ValidatorFn } from "../types";

const FLAVOR_STOP = new Set([
  "smucker", "smuckers", "uncrustables", "frozen", "sandwich",
  "sandwiches", "flavor", "flavored", "spread", "jam", "jelly", "and",
]);

function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/&/g, " and ")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 3 && !FLAVOR_STOP.has(token));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function numberOfItems(attributes: string): number | null {
  try {
    const attrs = JSON.parse(attributes) as Record<string, unknown>;
    const rows = attrs.number_of_items;
    if (!Array.isArray(rows) || !rows[0] || typeof rows[0] !== "object") return null;
    const value = Number((rows[0] as { value?: unknown }).value);
    return Number.isInteger(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export const validatorRecipeContent: ValidatorFn = async ({
  sku,
  master_bundle,
  bundle_components,
  draft_brand,
}) => {
  if (!master_bundle || bundle_components.length === 0) {
    return {
      validator_id: "validator-recipe-content",
      passed: false,
      severity: "error",
      message: "Canonical bundle recipe is missing.",
    };
  }
  const recipeTotal = bundle_components.reduce(
    (sum, component) => sum + component.qty,
    0,
  );
  const failures: string[] = [];
  if (recipeTotal !== master_bundle.pack_count) {
    failures.push(`component total ${recipeTotal} != pack_count ${master_bundle.pack_count}`);
  }
  const titleTotal = parseTotal(sku.title);
  if (titleTotal !== master_bundle.pack_count) {
    failures.push(`title total ${titleTotal} != pack_count ${master_bundle.pack_count}`);
  }
  const structuredCount = numberOfItems(sku.attributes);
  if (structuredCount !== master_bundle.pack_count) {
    failures.push(
      `number_of_items ${structuredCount ?? "missing"} != pack_count ${master_bundle.pack_count}`,
    );
  }

  let bullets: string[] = [];
  try {
    const parsed = JSON.parse(sku.bullets) as unknown;
    if (Array.isArray(parsed)) {
      bullets = parsed.filter((value): value is string => typeof value === "string");
    }
  } catch {
    failures.push("bullets JSON is malformed");
  }
  const content = [sku.title, ...bullets, sku.description].join(" ").toLowerCase();
  const totalClaims = [
    ...content.matchAll(/\btotal\s+(?:of\s+)?(\d{1,3})\b/gi),
    ...content.matchAll(/\b(\d{1,3})\s+(?:sandwiches|pieces|units)\s+in\s+total\b/gi),
  ].map((match) => Number(match[1]));
  if (totalClaims.some((claim) => claim !== master_bundle.pack_count)) {
    failures.push(
      `content states contradictory total(s): ${totalClaims.join(", ")}`,
    );
  }
  for (const component of bundle_components) {
    const flavor = component.flavor?.trim();
    if (!flavor) {
      failures.push(`component "${component.product_name}" has no canonical flavor`);
      continue;
    }
    const expectedTokens = tokens(flavor);
    if (expectedTokens.length > 0 && !expectedTokens.every((token) => content.includes(token))) {
      failures.push(`content omits flavor "${flavor}"`);
    }
    if (bundle_components.length > 1 && expectedTokens.length > 0) {
      const flavorPattern = expectedTokens.map(escapeRegExp).join(".{0,20}");
      const qty = String(component.qty);
      const allocationPresent =
        new RegExp(`\\b${qty}\\b.{0,80}${flavorPattern}`, "i").test(content) ||
        new RegExp(`${flavorPattern}.{0,80}\\b${qty}\\b`, "i").test(content);
      if (!allocationPresent) {
        failures.push(`content does not state ${component.qty} pieces for "${flavor}"`);
      }
    }
  }
  if (
    isOwnBrandPassthrough(draft_brand) &&
    /\b(?:box|boxes|case|cases)\b/i.test(content)
  ) {
    failures.push("own-brand content describes retail boxes/cases instead of individual pieces");
  }
  if (
    /\b\d{1,3}\s*(?:ct|count).{0,30}\bpack of\s*\d{1,3}\b/i.test(sku.title) ||
    /\bpack of\s*\d{1,3}.{0,30}\b\d{1,3}\s*(?:ct|count)\b/i.test(sku.title)
  ) {
    failures.push("title multiplies a retail pack count by a pack-of count");
  }

  if (failures.length > 0) {
    return {
      validator_id: "validator-recipe-content",
      passed: false,
      severity: "error",
      message: `Recipe/content mismatch: ${failures.join("; ")}.`,
      details: {
        recipe_total: recipeTotal,
        pack_count: master_bundle.pack_count,
        title_total: titleTotal,
        number_of_items: structuredCount,
        failures,
      },
    };
  }
  return {
    validator_id: "validator-recipe-content",
    passed: true,
    details: {
      recipe_total: recipeTotal,
      pack_count: master_bundle.pack_count,
      flavor_count: bundle_components.length,
    },
  };
};
