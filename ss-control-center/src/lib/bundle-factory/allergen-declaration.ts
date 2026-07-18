/**
 * Structured manufacturer-label allergen declarations.
 *
 * `contains` and `may_contain` are deliberately separate: a precautionary
 * "may contain" statement must survive recipe persistence, but it must never
 * be promoted into Amazon's positive `allergen_information` declaration.
 */

export interface AllergenDeclaration {
  contains: string[];
  may_contain: string[];
}

const AMAZON_ALLERGEN_BY_LABEL = new Map<string, string>([
  ["milk", "milk"],
  ["egg", "eggs"],
  ["eggs", "eggs"],
  ["fish", "fish"],
  ["crustacean", "crustacean"],
  ["crustacean shellfish", "crustacean"],
  ["shellfish", "crustacean"],
  // Amazon's live FOOD/GROCERY/PASTRY PTD has an exact positive `hazelnut`
  // token. Precautionary Hazelnut is different: there is no
  // `hazelnut_may_contain`, so that projection is handled as the broader
  // `tree_nuts_may_contain` by the sealed live-repair policy.
  ["hazelnut", "hazelnut"],
  ["tree nut", "tree_nuts"],
  ["tree nuts", "tree_nuts"],
  ["tree_nuts", "tree_nuts"],
  ["peanut", "peanuts"],
  ["peanuts", "peanuts"],
  ["wheat", "wheat"],
  ["soy", "soy"],
  ["soybean", "soy"],
  ["soybeans", "soy"],
  ["sesame", "sesame_seeds"],
  ["sesame seed", "sesame_seeds"],
  ["sesame seeds", "sesame_seeds"],
  ["sesame_seeds", "sesame_seeds"],
]);

const AMAZON_MAY_CONTAIN_BY_POSITIVE = new Map<string, string>([
  ["milk", "milk_may_contain"],
  ["eggs", "egg_may_contain"],
  ["fish", "fish_may_contain"],
  ["crustacean", "crustaceans_may_contain"],
  ["hazelnut", "tree_nuts_may_contain"],
  ["tree_nuts", "tree_nuts_may_contain"],
  ["peanuts", "peanuts_may_contain"],
  ["wheat", "wheat_may_contain"],
  ["soy", "soy_may_contain"],
  ["sesame_seeds", "sesame_may_contain"],
]);

function cleanLabels(values: unknown, label: string): string[] {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array`);
  const output: string[] = [];
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`${label}[${index}] must be a non-empty string`);
    }
    const cleaned = value.trim();
    const key = cleaned.toLowerCase();
    if (seen.has(key)) throw new Error(`${label} must not contain duplicates`);
    seen.add(key);
    output.push(cleaned);
  }
  return output;
}

/** Validate and clone an explicit declaration without changing label wording. */
export function normalizeAllergenDeclaration(
  value: unknown,
  label = "allergen_declaration",
): AllergenDeclaration {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const input = value as Record<string, unknown>;
  return {
    contains: cleanLabels(input.contains, `${label}.contains`),
    may_contain: cleanLabels(input.may_contain, `${label}.may_contain`),
  };
}

/**
 * Convert only the positive `contains` declaration to Amazon enum tokens.
 * Ingredient keyword inference is intentionally absent from this function.
 */
export function amazonAllergensFromDeclaration(
  declaration: AllergenDeclaration,
): string[] {
  const output: string[] = [];
  for (const label of declaration.contains) {
    const token = AMAZON_ALLERGEN_BY_LABEL.get(label.trim().toLowerCase());
    if (!token) {
      throw new Error(`Unsupported contained allergen label: ${JSON.stringify(label)}`);
    }
    if (!output.includes(token)) output.push(token);
  }
  return output;
}

/** Exact positive token for one authoritative manufacturer-label allergen. */
export function amazonContainedAllergenToken(label: string): string {
  const [token] = amazonAllergensFromDeclaration({
    contains: [label],
    may_contain: [],
  });
  return token;
}

/** Exact precautionary token from the live FOOD/GROCERY/PASTRY enum. The
 * mapping is intentionally contextual: positive Hazelnut is `hazelnut`, while
 * precautionary Hazelnut must use broader `tree_nuts_may_contain`. */
export function amazonMayContainAllergenToken(label: string): string {
  const positive = amazonContainedAllergenToken(label);
  const token = AMAZON_MAY_CONTAIN_BY_POSITIVE.get(positive);
  if (!token) {
    throw new Error(
      `Unsupported precautionary allergen label: ${JSON.stringify(label)}`,
    );
  }
  return token;
}

/** Family key used only to subtract a precautionary declaration when another
 * included component positively contains the same allergen family. */
export function amazonAllergenFamily(label: string): string {
  const positive = amazonContainedAllergenToken(label);
  return positive === "hazelnut" || positive === "tree_nuts"
    ? "tree_nuts"
    : positive;
}

/** Stable persisted representation for BundleComponent.allergens. */
export function serializeAllergenDeclaration(
  declaration: AllergenDeclaration,
): string {
  return JSON.stringify(normalizeAllergenDeclaration(declaration));
}

/**
 * Parse only the reviewed structured schema. Legacy JSON arrays have no
 * contains-vs-may-contain distinction or provenance and may have been produced
 * by the retired ingredient keyword scanner, so publisher paths reject them.
 */
export function parseStoredAllergenDeclaration(
  value: string | null | undefined,
): AllergenDeclaration | null {
  if (!value?.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  try {
    if (Array.isArray(parsed)) return null;
    return normalizeAllergenDeclaration(parsed, "stored_allergens");
  } catch {
    return null;
  }
}

/**
 * Shared bridge for promotion and live reconciliation: read persisted
 * BundleComponent declarations and return the exact union of positive Amazon
 * tokens. Missing/malformed component data fails closed.
 */
export function amazonAllergensFromStoredDeclarations(
  values: Array<string | null | undefined>,
): string[] {
  const output = new Set<string>();
  for (const [index, value] of values.entries()) {
    const declaration = parseStoredAllergenDeclaration(value);
    if (!declaration) {
      throw new Error(`component[${index}] has no structured allergen declaration`);
    }
    for (const token of amazonAllergensFromDeclaration(declaration)) {
      output.add(token);
    }
  }
  return Array.from(output);
}
