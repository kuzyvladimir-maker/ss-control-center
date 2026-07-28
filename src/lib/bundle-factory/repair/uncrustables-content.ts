/** Deterministic, recipe-grounded repair copy for legacy Uncrustables listings. */

import type { Variant } from "../variation-matrix";

export interface UncrustablesRepairContent {
  title: string;
  bullets: string[];
  description: string;
}

/** Keep the manufacturer's real flavor/sub-line wording while removing retail
 * carton sizes. Recipe quantities always mean individual sandwiches. */
export function uncrustablesFlavorLabel(productName: string): string {
  return productName
    .replace(/smucker[’']?s/gi, "")
    .replace(/uncrustables/gi, "")
    // Remove packaging-only parentheticals before stripping their individual
    // words; otherwise inputs such as "(2 oz, individually wrapped, frozen)"
    // leave malformed fragments like "(2 oz, individually wrapped, )".
    .replace(
      /\([^)]*(?:\d+(?:\.\d+)?\s*(?:oz|ounce(?:s)?)|\d+\s*(?:ct|count)|individually\s+wrapped|frozen)[^)]*\)/gi,
      "",
    )
    .replace(/\bfrozen\b/gi, "")
    .replace(/\bsandwich(?:es)?\b/gi, "")
    .replace(/[-–—]?\s*\d+(?:\.\d+)?\s*oz\s*\/\s*\d+\s*ct\b/gi, "")
    .replace(/[-–—]?\s*\d+\s*ct\s*\/\s*\d+(?:\.\d+)?\s*oz\b/gi, "")
    .replace(/[-–—,;]?\s*\d+\s*(?:ct|count)\b/gi, "")
    .replace(
      /[-–—,;]?\s*\d+(?:\.\d+)?\s*(?:oz|ounce(?:s)?)(?:\s+each)?\b/gi,
      "",
    )
    .replace(/[-–—,;]?\s*\d+\s*(?:pack|pk)\b/gi, "")
    .replace(/\bindividually\s+wrapped\b/gi, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,;])/g, "$1")
    .replace(/([,;])\s*([,;])/g, "$1")
    .replace(/^[\s,;:–—-]+|[\s,;:–—-]+$/g, "")
    .trim();
}

function humanJoin(values: string[]): string {
  if (values.length <= 1) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

function titleFor(labels: string[], total: number): string {
  const single = labels.length === 1
    ? `Smucker's Uncrustables ${labels[0]} Frozen Sandwiches, Individually Wrapped, ${total} Count`
    : `Smucker's Uncrustables Frozen Sandwich Variety Pack, ${humanJoin(labels)}, ${total} Count`;
  if (single.length <= 200) return single;
  return `Smucker's Uncrustables Frozen Sandwich Variety Pack, ${labels.length} Flavors, Individually Wrapped, ${total} Count`;
}

const TITLE_FREQUENCY_EXEMPT_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "by",
  "for",
  "from",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
  "without",
]);

/** Amazon title guidance permits ordinary connector words to repeat, but no
 * substantive word may appear more than twice. */
export function hasExcessiveAmazonTitleWordFrequency(title: string): boolean {
  const counts = new Map<string, number>();
  const words = title.toLowerCase().match(/[a-z0-9]+(?:'[a-z0-9]+)?/g) ?? [];
  for (const word of words) {
    if (TITLE_FREQUENCY_EXEMPT_WORDS.has(word)) continue;
    const next = (counts.get(word) ?? 0) + 1;
    if (next > 2) return true;
    counts.set(word, next);
  }
  return false;
}

function commercialTitleFor(labels: string[], total: number): string {
  const enumerated = labels.length === 1
    ? `Smucker's Uncrustables ${labels[0]} Frozen Sandwiches, Individually Wrapped, ${total} Count`
    : `Smucker's Uncrustables Frozen Sandwich Variety Pack, ${humanJoin(labels)}, ${total} Count`;
  if (
    enumerated.length <= 200 &&
    !hasExcessiveAmazonTitleWordFrequency(enumerated)
  ) {
    return enumerated;
  }
  const fallback =
    `Smucker's Uncrustables Frozen Sandwich Variety Pack, ${labels.length} Flavors, Individually Wrapped, ${total} Count`;
  if (hasExcessiveAmazonTitleWordFrequency(fallback)) {
    throw new Error("Commercial fallback title exceeds Amazon word-frequency policy");
  }
  return fallback;
}

/**
 * Render conservative copy from the exact selected recipe. It intentionally
 * avoids retail-carton multiplication, shipping promises, transient promotion,
 * and nutrition/storage claims that are not common to every component.
 */
export function renderUncrustablesRepairContent(input: {
  variant: Variant;
  total: number;
}): UncrustablesRepairContent {
  const components = input.variant.composition;
  if (components.length === 0) throw new Error("Uncrustables recipe is empty");
  const recipeTotal = components.reduce((sum, component) => sum + component.qty, 0);
  if (recipeTotal !== input.total) {
    throw new Error(`Recipe total ${recipeTotal} does not equal intended count ${input.total}`);
  }
  const rows = components.map((component) => ({
    qty: component.qty,
    label: uncrustablesFlavorLabel(component.product_name),
  }));
  if (rows.some((row) => !row.label)) throw new Error("Recipe has an empty flavor label");
  const labels = rows.map((row) => row.label);
  const allocation = rows.map((row) => `${row.qty} ${row.label}`).join("; ");

  const title = titleFor(labels, input.total);
  const bullets = [
    `CONTENTS: ${input.total} individually wrapped frozen sandwiches total: ${allocation}.`,
    `COUNT BASIS: The stated ${input.total} Count refers to ${input.total} individual sandwiches, not retail cartons.`,
    `PRODUCT IDENTITY: Genuine Smucker's Uncrustables sandwiches in the original individual manufacturer wrappers; the assortment contains only the flavors stated above.`,
    "STORAGE: Keep frozen until ready to use and follow the thawing and handling directions printed on each original wrapper.",
    "LABEL INFORMATION: Review the original wrappers for the current ingredients, allergen statements, nutrition facts, and preparation directions before use.",
  ];
  const description = [
    `This listing contains ${input.total} individual Smucker's Uncrustables frozen sandwiches: ${allocation}. The quantity refers to individual sandwiches and is not multiplied by the count printed on a retail carton.`,
    "Each sandwich remains in its original individual manufacturer wrapper. Keep frozen until ready to use and follow the handling directions on the wrapper.",
    "Ingredients, allergen statements, nutrition facts, and preparation directions can vary by flavor or manufacturer update. Review each original wrapper before use.",
  ].join("\n\n");
  return { title, bullets, description };
}

/**
 * Commercially complete version used by the all-row factual repair.
 *
 * In addition to exact recipe/count identity, it states the physical cold-pack
 * components that are common to this owner-approved Uncrustables program. It
 * deliberately makes no per-piece weight, nutrition, ingredient, allergen,
 * thaw-time, shelf-life, temperature, delivery, or affiliation claim.
 *
 * This remains an Uncrustables own-brand passthrough listing, not a Salutem
 * gift set, so a gift/curator disclaimer would be inaccurate and is omitted.
 */
export function renderUncrustablesCommercialRepairContent(input: {
  variant: Variant;
  total: number;
}): UncrustablesRepairContent {
  const components = input.variant.composition;
  if (components.length === 0) throw new Error("Uncrustables recipe is empty");
  const recipeTotal = components.reduce((sum, component) => sum + component.qty, 0);
  if (recipeTotal !== input.total) {
    throw new Error(`Recipe total ${recipeTotal} does not equal intended count ${input.total}`);
  }

  const rows = components.map((component) => ({
    qty: component.qty,
    label: uncrustablesFlavorLabel(component.product_name),
  }));
  if (rows.some((row) => !row.label)) throw new Error("Recipe has an empty flavor label");
  const labels = rows.map((row) => row.label);
  const allocation = rows.map((row) => `${row.qty} ${row.label}`).join("; ");
  const title = commercialTitleFor(labels, input.total);
  const bullets = [
    `Exact assortment: ${input.total} individually wrapped frozen sandwiches total: ${allocation}.`,
    `Cold-pack components: An insulated foam cooler and frozen gel packs accompany the sandwiches; the stated ${input.total} Count refers only to individual sandwiches.`,
    "Original wrappers: Every sandwich remains sealed in its original individual manufacturer wrapper, and the assortment contains only the varieties stated above.",
    "Storage and handling: Keep the sandwiches frozen until ready to use and follow the thawing and handling directions printed on each original wrapper.",
    "Label details: Review the original wrappers for the current ingredients, allergen statements, nutrition facts, and preparation directions before use.",
  ];
  const description = [
    `This listing contains ${input.total} individual Smucker's Uncrustables frozen sandwiches: ${allocation}. The stated quantity counts individual sandwiches and is not multiplied by a retail-carton count.`,
    `An insulated foam cooler and frozen gel packs accompany the sandwiches as cold-pack components. They are not included in the stated ${input.total} sandwich count.`,
    "Every sandwich remains sealed in its original individual manufacturer wrapper. Keep the sandwiches frozen until ready to use and follow the thawing and handling directions printed on each wrapper.",
    "Ingredients, allergen statements, nutrition facts, and preparation directions can vary by variety or manufacturer update. Review each original wrapper before use.",
  ].join("\n\n");
  return { title, bullets, description };
}
