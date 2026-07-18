/**
 * Pure, fail-closed helpers for the reviewed Uncrustables donor repair.
 *
 * The reviewed manifest is intentionally data, not executable code.  These
 * helpers validate its closed scope, project missing donor facts for dry-runs,
 * and rewrite only the selected VariationMatrix component IDs covered by an
 * explicit alias.  Database writes live in the guarded CLI.
 */

import { createHash } from "node:crypto";

import { normalizeAllergenDeclaration } from "./allergen-declaration";
import type { RepairDonor } from "./recipe-repair";
import type { Variant, VariantComponent } from "./variation-matrix";

export const DONOR_ENRICHMENT_SCHEMA_VERSION =
  "bundle-factory.uncrustables-donor-enrichment/v2";
export const UNCRUSTABLES_DONOR_MANIFEST_PATH =
  "data/repairs/uncrustables-donor-enrichment-20260717.json";

// Updated only after the reviewed JSON is finalized. Both CLIs verify this
// digest before using the manifest, so an unnoticed edit fails closed.
export const UNCRUSTABLES_DONOR_MANIFEST_SHA256 =
  "999348227982c169477ad13fb806ddba42fb15cb68397308e4289a9cbbcee9f9";

export type ManifestEvidence =
  | {
      kind: "manufacturer_product_page" | "target_label_page";
      url: string;
      retrieved_at: string;
      locator: string;
    }
  | {
      kind: "catalog_snapshot";
      url: null;
      source_field: "DonorProduct.upc";
      retrieved_at: string;
      locator: string;
    };

export interface CatalogUpcSnapshot {
  action: "fill_if_missing" | "verify_exact_no_write";
  value: string | null;
  checksum_valid: boolean | null;
}

export interface CatalogIngredientsSnapshot {
  action: "fill_if_missing" | "replace_exact" | "verify_exact_no_write";
  value: string | null;
  sha256: string | null;
}

export interface CatalogTargetOfferSnapshot {
  retailer: "target";
  retailer_product_id: string;
  product_url: string;
  fetched_at: string;
}

export interface DonorEnrichmentEntry {
  donor_id: string;
  expected_title: string;
  catalog_snapshot: {
    upc: CatalogUpcSnapshot;
    ingredients: CatalogIngredientsSnapshot;
    target_offer: CatalogTargetOfferSnapshot | null;
  };
  reviewed: {
    upc: string;
    ingredients: string;
    allergens: {
      contains: string[];
      may_contain: string[];
    };
    ingredients_source: ManifestEvidence;
    upc_source: ManifestEvidence;
  };
}

export interface SelectedDonorAlias {
  from_donor_id: string;
  expected_selected_product_name: string;
  to_donor_id: string;
  expected_occurrences: 3;
  targets: Array<{
    variation_matrix_id: string;
    bundle_draft_id: string;
    selected_variant_idx: number;
    expected_variant_idx: number;
    expected_qty: number;
    expected_occurrences: 1;
    pre_variants_sha256: string;
    post_variants_sha256: string;
  }>;
  reason: string;
}

export interface DonorEnrichmentManifest {
  schema_version: typeof DONOR_ENRICHMENT_SCHEMA_VERSION;
  immutable: true;
  brand: "Uncrustables";
  reviewed_at: string;
  ledger: {
    path: string;
    sha256: string;
  };
  selected_donor_ids: string[];
  donors: DonorEnrichmentEntry[];
  aliases: SelectedDonorAlias[];
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return string(value, label);
}

function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const result = value.map((item, index) => string(item, `${label}[${index}]`));
  if (new Set(result).size !== result.length) {
    throw new Error(`${label} must not contain duplicates`);
  }
  return result;
}

function isoDate(value: unknown, label: string): string {
  const result = string(value, label);
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?$/.test(result)) {
    throw new Error(`${label} must be an ISO UTC date or calendar date`);
  }
  return result;
}

function httpsUrl(value: unknown, label: string): string {
  const result = string(value, label);
  let parsed: URL;
  try {
    parsed = new URL(result);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (parsed.protocol !== "https:") throw new Error(`${label} must use https`);
  return result;
}

function uuid(value: unknown, label: string): string {
  const result = string(value, label);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(result)) {
    throw new Error(`${label} must be a UUID`);
  }
  return result;
}

function sha256(value: unknown, label: string): string {
  const result = string(value, label);
  if (!/^[0-9a-f]{64}$/.test(result)) throw new Error(`${label} must be a SHA-256 hex digest`);
  return result;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return Number(value);
}

function positiveInteger(value: unknown, label: string): number {
  const result = nonNegativeInteger(value, label);
  if (result === 0) throw new Error(`${label} must be positive`);
  return result;
}

export function textSha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Validate the final check digit for GTIN-12/13/14. */
export function hasValidGtinCheckDigit(value: string): boolean {
  if (!/^\d{12,14}$/.test(value)) return false;
  const digits = value.split("").map(Number);
  const check = digits.pop()!;
  let sum = 0;
  for (let index = digits.length - 1, weight = 3; index >= 0; index -= 1) {
    sum += digits[index] * weight;
    weight = weight === 3 ? 1 : 3;
  }
  return (10 - (sum % 10)) % 10 === check;
}

function upc(value: unknown, label: string): string {
  const result = string(value, label);
  if (!/^\d{12,14}$/.test(result)) throw new Error(`${label} must be a 12-14 digit UPC/GTIN`);
  if (!hasValidGtinCheckDigit(result)) {
    throw new Error(`${label} has an invalid GTIN check digit`);
  }
  return result;
}

function evidence(value: unknown, label: string): ManifestEvidence {
  const input = record(value, label);
  const kind = string(input.kind, `${label}.kind`);
  if (kind === "catalog_snapshot") {
    if (input.url !== null) throw new Error(`${label}.url must be null for catalog_snapshot`);
    if (input.source_field !== "DonorProduct.upc") {
      throw new Error(`${label}.source_field must be DonorProduct.upc`);
    }
    return {
      kind,
      url: null,
      source_field: "DonorProduct.upc",
      retrieved_at: isoDate(input.retrieved_at, `${label}.retrieved_at`),
      locator: string(input.locator, `${label}.locator`),
    };
  }
  if (kind !== "manufacturer_product_page" && kind !== "target_label_page") {
    throw new Error(`${label}.kind is unsupported`);
  }
  return {
    kind,
    url: httpsUrl(input.url, `${label}.url`),
    retrieved_at: isoDate(input.retrieved_at, `${label}.retrieved_at`),
    locator: string(input.locator, `${label}.locator`),
  };
}

function upcSnapshot(value: unknown, label: string): CatalogUpcSnapshot {
  const input = record(value, label);
  const action = string(input.action, `${label}.action`);
  if (action !== "fill_if_missing" && action !== "verify_exact_no_write") {
    throw new Error(`${label}.action is unsupported`);
  }
  const current = input.value === null ? null : upc(input.value, `${label}.value`);
  const checksumValid = input.checksum_valid;
  if (current === null) {
    if (action !== "fill_if_missing") {
      throw new Error(`${label} null value requires fill_if_missing`);
    }
    if (checksumValid !== null) throw new Error(`${label}.checksum_valid must be null`);
  } else {
    if (action !== "verify_exact_no_write") {
      throw new Error(`${label} populated value must be verify_exact_no_write`);
    }
    if (checksumValid !== true || !hasValidGtinCheckDigit(current)) {
      throw new Error(`${label}.checksum_valid must truthfully be true`);
    }
  }
  return { action, value: current, checksum_valid: checksumValid as boolean | null };
}

function ingredientsSnapshot(
  value: unknown,
  label: string,
): CatalogIngredientsSnapshot {
  const input = record(value, label);
  const action = string(input.action, `${label}.action`);
  if (
    action !== "fill_if_missing" &&
    action !== "replace_exact" &&
    action !== "verify_exact_no_write"
  ) {
    throw new Error(`${label}.action is unsupported`);
  }
  const current = nullableString(input.value, `${label}.value`);
  const currentSha = input.sha256 === null ? null : sha256(input.sha256, `${label}.sha256`);
  if (action === "fill_if_missing") {
    if (current !== null || currentSha !== null) {
      throw new Error(`${label} fill_if_missing requires null value and digest`);
    }
  } else {
    if (current === null || currentSha === null) {
      throw new Error(`${label} ${action} requires exact value and digest`);
    }
    const actual = textSha256(current);
    if (actual !== currentSha) {
      throw new Error(`${label}.sha256 does not match the exact UTF-8 value`);
    }
  }
  return { action, value: current, sha256: currentSha };
}

function targetOffer(
  value: unknown,
  label: string,
): CatalogTargetOfferSnapshot | null {
  if (value === null) return null;
  const input = record(value, label);
  if (input.retailer !== "target") throw new Error(`${label}.retailer must be target`);
  return {
    retailer: "target",
    retailer_product_id: string(
      input.retailer_product_id,
      `${label}.retailer_product_id`,
    ),
    product_url: httpsUrl(input.product_url, `${label}.product_url`),
    fetched_at: isoDate(input.fetched_at, `${label}.fetched_at`),
  };
}

function donorEntry(value: unknown, index: number): DonorEnrichmentEntry {
  const label = `donors[${index}]`;
  const input = record(value, label);
  const snapshot = record(input.catalog_snapshot, `${label}.catalog_snapshot`);
  const reviewed = record(input.reviewed, `${label}.reviewed`);
  const allergens = normalizeAllergenDeclaration(
    reviewed.allergens,
    `${label}.reviewed.allergens`,
  );
  const entry: DonorEnrichmentEntry = {
    donor_id: uuid(input.donor_id, `${label}.donor_id`),
    expected_title: string(input.expected_title, `${label}.expected_title`),
    catalog_snapshot: {
      upc: upcSnapshot(snapshot.upc, `${label}.catalog_snapshot.upc`),
      ingredients: ingredientsSnapshot(
        snapshot.ingredients,
        `${label}.catalog_snapshot.ingredients`,
      ),
      target_offer: targetOffer(
        snapshot.target_offer,
        `${label}.catalog_snapshot.target_offer`,
      ),
    },
    reviewed: {
      upc: upc(reviewed.upc, `${label}.reviewed.upc`),
      ingredients: string(reviewed.ingredients, `${label}.reviewed.ingredients`),
      allergens,
      ingredients_source: evidence(
        reviewed.ingredients_source,
        `${label}.reviewed.ingredients_source`,
      ),
      upc_source: evidence(reviewed.upc_source, `${label}.reviewed.upc_source`),
    },
  };
  if (
    entry.catalog_snapshot.upc.value &&
    entry.catalog_snapshot.upc.value !== entry.reviewed.upc
  ) {
    throw new Error(`${label} reviewed UPC differs from the catalog snapshot`);
  }
  if (
    entry.catalog_snapshot.ingredients.action === "verify_exact_no_write" &&
    entry.catalog_snapshot.ingredients.value !== entry.reviewed.ingredients
  ) {
    throw new Error(
      `${label} verify_exact_no_write ingredients must equal reviewed ingredients`,
    );
  }
  if (
    entry.reviewed.upc_source.kind === "catalog_snapshot" &&
    entry.catalog_snapshot.upc.action !== "verify_exact_no_write"
  ) {
    throw new Error(`${label} catalog_snapshot UPC provenance cannot authorize a write`);
  }
  if (entry.reviewed.allergens.contains.length === 0) {
    throw new Error(`${label} must list at least one contained allergen`);
  }
  return entry;
}

function alias(value: unknown, index: number): SelectedDonorAlias {
  const label = `aliases[${index}]`;
  const input = record(value, label);
  if (input.expected_occurrences !== 3) {
    throw new Error(`${label}.expected_occurrences must be exactly 3`);
  }
  if (!Array.isArray(input.targets) || input.targets.length !== 3) {
    throw new Error(`${label}.targets must pin exactly 3 matrix rows`);
  }
  const targets = input.targets.map((value, targetIndex) => {
    const targetLabel = `${label}.targets[${targetIndex}]`;
    const target = record(value, targetLabel);
    if (target.expected_occurrences !== 1) {
      throw new Error(`${targetLabel}.expected_occurrences must be exactly 1`);
    }
    return {
      variation_matrix_id: string(
        target.variation_matrix_id,
        `${targetLabel}.variation_matrix_id`,
      ),
      bundle_draft_id: string(
        target.bundle_draft_id,
        `${targetLabel}.bundle_draft_id`,
      ),
      selected_variant_idx: nonNegativeInteger(
        target.selected_variant_idx,
        `${targetLabel}.selected_variant_idx`,
      ),
      expected_variant_idx: nonNegativeInteger(
        target.expected_variant_idx,
        `${targetLabel}.expected_variant_idx`,
      ),
      expected_qty: positiveInteger(target.expected_qty, `${targetLabel}.expected_qty`),
      expected_occurrences: 1 as const,
      pre_variants_sha256: sha256(
        target.pre_variants_sha256,
        `${targetLabel}.pre_variants_sha256`,
      ),
      post_variants_sha256: sha256(
        target.post_variants_sha256,
        `${targetLabel}.post_variants_sha256`,
      ),
    };
  });
  if (
    new Set(targets.map((target) => target.variation_matrix_id)).size !==
      targets.length ||
    new Set(targets.map((target) => target.bundle_draft_id)).size !== targets.length
  ) {
    throw new Error(`${label}.targets must have unique matrix and draft IDs`);
  }
  return {
    from_donor_id: uuid(input.from_donor_id, `${label}.from_donor_id`),
    expected_selected_product_name: string(
      input.expected_selected_product_name,
      `${label}.expected_selected_product_name`,
    ),
    to_donor_id: uuid(input.to_donor_id, `${label}.to_donor_id`),
    expected_occurrences: 3,
    targets,
    reason: string(input.reason, `${label}.reason`),
  };
}

/** Parse and validate the complete, deliberately closed 16-donor repair set. */
export function parseDonorEnrichmentManifest(
  value: unknown,
): DonorEnrichmentManifest {
  const input = record(value, "manifest");
  if (input.schema_version !== DONOR_ENRICHMENT_SCHEMA_VERSION) {
    throw new Error(`Unsupported manifest schema: ${String(input.schema_version)}`);
  }
  if (input.immutable !== true) throw new Error("manifest.immutable must be true");
  if (input.brand !== "Uncrustables") throw new Error("manifest.brand must be Uncrustables");
  const ledger = record(input.ledger, "manifest.ledger");
  const selectedDonorIds = stringArray(
    input.selected_donor_ids,
    "manifest.selected_donor_ids",
  ).map((id, index) => uuid(id, `manifest.selected_donor_ids[${index}]`));
  if (selectedDonorIds.length !== 16) {
    throw new Error("manifest must name exactly 16 ledger-selected donor IDs");
  }
  if (!Array.isArray(input.donors) || input.donors.length !== 16) {
    throw new Error("manifest must contain exactly 16 extant reviewed donors");
  }
  if (!Array.isArray(input.aliases) || input.aliases.length !== 1) {
    throw new Error("manifest must contain exactly one reviewed legacy alias");
  }
  const donors = input.donors.map(donorEntry);
  const aliases = input.aliases.map(alias);
  const donorIds = donors.map((entry) => entry.donor_id);
  if (new Set(donorIds).size !== donorIds.length) {
    throw new Error("manifest donor IDs must be unique");
  }
  const oldIds = new Set(aliases.map((entry) => entry.from_donor_id));
  const replacementIds = new Set(aliases.map((entry) => entry.to_donor_id));
  for (const oldId of oldIds) {
    if (!selectedDonorIds.includes(oldId)) {
      throw new Error(`alias source ${oldId} is not ledger-selected`);
    }
    if (donorIds.includes(oldId)) {
      throw new Error(`deleted alias source ${oldId} must not be an extant donor entry`);
    }
  }
  for (const replacementId of replacementIds) {
    if (!donorIds.includes(replacementId)) {
      throw new Error(`alias replacement ${replacementId} lacks a donor entry`);
    }
    if (selectedDonorIds.includes(replacementId)) {
      throw new Error(`alias replacement ${replacementId} must be outside the old selected set`);
    }
  }
  const expectedExtant = selectedDonorIds.filter((id) => !oldIds.has(id));
  const manifestExtant = donorIds.filter((id) => !replacementIds.has(id));
  if (
    expectedExtant.length !== manifestExtant.length ||
    expectedExtant.some((id) => !manifestExtant.includes(id))
  ) {
    throw new Error("manifest donors do not exactly cover the extant selected donor set");
  }
  return {
    schema_version: DONOR_ENRICHMENT_SCHEMA_VERSION,
    immutable: true,
    brand: "Uncrustables",
    reviewed_at: isoDate(input.reviewed_at, "manifest.reviewed_at"),
    ledger: {
      path: string(ledger.path, "manifest.ledger.path"),
      sha256: sha256(ledger.sha256, "manifest.ledger.sha256"),
    },
    selected_donor_ids: selectedDonorIds,
    donors,
    aliases,
  };
}

export function donorManifestMap(
  manifest: DonorEnrichmentManifest,
): Map<string, DonorEnrichmentEntry> {
  return new Map(manifest.donors.map((entry) => [entry.donor_id, entry]));
}

/**
 * Project only manifest-authorized facts. A nonblank ingredient value can be
 * replaced only when both its exact UTF-8 value and digest match the immutable
 * snapshot. Any other drift throws instead of preserving unreviewed content.
 */
export function projectDonorEnrichment<
  T extends Pick<RepairDonor, "id" | "upc" | "ingredients">,
>(
  donor: T,
  manifest: DonorEnrichmentManifest,
): T & { allergenDeclaration?: RepairDonor["allergenDeclaration"] } {
  const entry = donorManifestMap(manifest).get(donor.id);
  if (!entry) return donor;
  const currentUpc = donor.upc ?? null;
  const upcSnapshot = entry.catalog_snapshot.upc;
  let projectedUpc = currentUpc;
  if (currentUpc !== entry.reviewed.upc) {
    if (currentUpc !== upcSnapshot.value) {
      throw new Error(
        `${donor.id}: UPC does not match reviewed value or exact catalog snapshot`,
      );
    }
    if (upcSnapshot.action === "fill_if_missing") {
      projectedUpc = entry.reviewed.upc;
    }
  }

  const currentIngredients = donor.ingredients ?? null;
  const ingredientsSnapshot = entry.catalog_snapshot.ingredients;
  let projectedIngredients = currentIngredients;
  if (currentIngredients !== entry.reviewed.ingredients) {
    if (currentIngredients !== ingredientsSnapshot.value) {
      throw new Error(
        `${donor.id}: ingredients do not match reviewed value or exact catalog snapshot`,
      );
    }
    if (
      currentIngredients !== null &&
      textSha256(currentIngredients) !== ingredientsSnapshot.sha256
    ) {
      throw new Error(`${donor.id}: exact ingredients snapshot digest mismatch`);
    }
    if (
      ingredientsSnapshot.action === "fill_if_missing" ||
      ingredientsSnapshot.action === "replace_exact"
    ) {
      projectedIngredients = entry.reviewed.ingredients;
    }
  }
  return {
    ...donor,
    upc: projectedUpc,
    ingredients: projectedIngredients,
    allergenDeclaration: normalizeAllergenDeclaration(entry.reviewed.allergens),
  };
}

function rewriteComposition(
  composition: VariantComponent[],
  manifest: DonorEnrichmentManifest,
): { composition: VariantComponent[]; replacements: number } {
  let replacements = 0;
  const result = composition.map((component) => {
    const reviewedAlias = manifest.aliases.find(
      (entry) => entry.from_donor_id === component.research_pool_id,
    );
    if (!reviewedAlias) return component;
    if (component.product_name !== reviewedAlias.expected_selected_product_name) {
      throw new Error(
        `alias title mismatch for ${reviewedAlias.from_donor_id}: expected ` +
          `${JSON.stringify(reviewedAlias.expected_selected_product_name)}, got ` +
          `${JSON.stringify(component.product_name)}`,
      );
    }
    if (
      composition.some(
        (candidate) => candidate !== component &&
          candidate.research_pool_id === reviewedAlias.to_donor_id,
      )
    ) {
      throw new Error(
        `alias replacement ${reviewedAlias.to_donor_id} already exists in selected composition`,
      );
    }
    replacements += 1;
    return { ...component, research_pool_id: reviewedAlias.to_donor_id };
  });
  return { composition: result, replacements };
}

/** Project aliases into an already-selected variant without mutating input. */
export function projectSelectedVariantAliases(
  variant: Variant | null,
  manifest: DonorEnrichmentManifest,
): { variant: Variant | null; replacements: number } {
  if (!variant) return { variant: null, replacements: 0 };
  const rewritten = rewriteComposition(variant.composition, manifest);
  return {
    variant: rewritten.replacements > 0
      ? { ...variant, composition: rewritten.composition }
      : variant,
    replacements: rewritten.replacements,
  };
}

/** Rewrite only the selected variant inside persisted variants_json. */
export function rewriteSelectedVariantAliases(input: {
  variantsJson: string;
  selectedVariantIdx: number | null;
  manifest: DonorEnrichmentManifest;
}): { variantsJson: string; replacements: number } {
  if (input.selectedVariantIdx == null) {
    return { variantsJson: input.variantsJson, replacements: 0 };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.variantsJson);
  } catch {
    throw new Error("VariationMatrix variants_json is malformed");
  }
  if (!Array.isArray(parsed)) throw new Error("VariationMatrix variants_json must be an array");
  const selectedPosition = parsed.findIndex(
    (value) => value && typeof value === "object" &&
      (value as Record<string, unknown>).idx === input.selectedVariantIdx,
  );
  const position = selectedPosition >= 0 ? selectedPosition : input.selectedVariantIdx;
  const selected = parsed[position];
  if (!selected || typeof selected !== "object" || Array.isArray(selected)) {
    throw new Error("selected VariationMatrix variant is missing or malformed");
  }
  const selectedRecord = selected as Record<string, unknown>;
  if (!Array.isArray(selectedRecord.composition)) {
    throw new Error("selected VariationMatrix composition is missing or malformed");
  }
  const rewritten = rewriteComposition(
    selectedRecord.composition as VariantComponent[],
    input.manifest,
  );
  if (rewritten.replacements === 0) {
    return { variantsJson: input.variantsJson, replacements: 0 };
  }
  parsed[position] = { ...selectedRecord, composition: rewritten.composition };
  return {
    variantsJson: JSON.stringify(parsed),
    replacements: rewritten.replacements,
  };
}
