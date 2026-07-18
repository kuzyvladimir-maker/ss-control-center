/**
 * Offline authenticity gate for generated Uncrustables MAIN images.
 *
 * This module deliberately does not fetch an image, call a model, query Prisma,
 * or write an audit artifact. It verifies an already-reviewed evidence bundle:
 *
 *  - the recipe names a reviewed flavor and an exact presentation mode/size;
 *  - every visually observed package resolves to exact reviewed brand art;
 *  - every required recipe flavor/presentation is present and no extra one is;
 *  - foreign, fictional, or unknown items fail closed;
 *  - registry sources, the generated MAIN, and its generation manifest have
 *    immutable evidence locators plus SHA-256 digests;
 *  - a human visual approval is SHA-sealed and bound to the exact image,
 *    recipe, registry, and structured visual observation.
 *
 * OCR text is intentionally not an input to the decision. OCR or a vision
 * model may help a human prepare the structured observation, but only an exact
 * registry art match plus the bound human checklist can pass this gate.
 */

import { createHash } from "node:crypto";

export const UNCRUSTABLES_AUTHENTICITY_REGISTRY_SCHEMA =
  "uncrustables-authenticity-registry/v1" as const;
export const UNCRUSTABLES_MAIN_AUTHENTICITY_SUBJECT_SCHEMA =
  "uncrustables-main-authenticity-subject/v1" as const;
export const UNCRUSTABLES_MAIN_VISUAL_APPROVAL_SCHEMA =
  "uncrustables-main-visual-approval/v1" as const;
export const UNCRUSTABLES_MAIN_AUTHENTICITY_VALIDATOR_ID =
  "validator-uncrustables-main-authenticity" as const;

export type UncrustablesPackMode = "retail-carton" | "individual-wrapper";

export type AuthenticityEvidenceKind =
  | "retailer-product-page"
  | "retailer-source-image"
  | "manufacturer-source"
  | "reviewed-artifact"
  | "generated-main"
  | "generation-manifest";

/** A locator identifies the bytes; SHA-256 pins the exact reviewed version. */
export interface AuthenticityEvidence {
  kind: AuthenticityEvidenceKind;
  locator: string;
  sha256: string;
}

export interface ReviewedUncrustablesArt {
  /** Stable opaque id for one exact real-world package design. */
  art_id: string;
  pack_mode: UncrustablesPackMode;
  /** Carton count printed on the reviewed carton; wrappers are always 1. */
  retail_pack_size: number;
  market: "US";
  /** Exact marks a reviewer may see on this package design. */
  brand_marks: string[];
  evidence: AuthenticityEvidence[];
}

export interface ReviewedUncrustablesFlavor {
  flavor_id: string;
  display_name: string;
  /** Exact reviewed catalog/recipe labels. Matching is punctuation-insensitive,
   * not fuzzy: a made-up near-match must remain unknown. */
  aliases: string[];
  art: ReviewedUncrustablesArt[];
}

export interface UncrustablesAuthenticityRegistryBody {
  schema_version: typeof UNCRUSTABLES_AUTHENTICITY_REGISTRY_SCHEMA;
  immutable: true;
  registry_id: string;
  reviewed_at: string;
  reviewed_by: string;
  review_method: "human-visual-with-source-evidence";
  brand: {
    product_brand: "Uncrustables";
    owner: string;
    market: "US";
    allowed_marks: string[];
  };
  flavors: ReviewedUncrustablesFlavor[];
}

export interface UncrustablesAuthenticityRegistry
  extends UncrustablesAuthenticityRegistryBody {
  /** Digest of the complete registry body, excluding this field. */
  sha256: string;
}

export interface UncrustablesRecipePresentation {
  /** flavor_id or one exact reviewed alias from the registry. */
  flavor: string;
  quantity: number;
  expected_pack_mode: UncrustablesPackMode;
  expected_retail_pack_size: number;
}

export interface UncrustablesMainRecipe {
  recipe_id: string;
  components: UncrustablesRecipePresentation[];
}

export type VisualItemClassification =
  | "reviewed-real-uncrustables"
  | "foreign-product"
  | "fictional-or-unknown-product";

/**
 * One record per visually distinct package design in MAIN (not OCR output and
 * not necessarily one record per repeated physical carton/wrapper).
 */
export interface UncrustablesVisualPackageObservation {
  observation_id: string;
  flavor: string;
  art_id: string;
  pack_mode: UncrustablesPackMode;
  retail_pack_size: number;
  /** Exact number of physical cartons/wrappers of this design visible in MAIN. */
  visible_package_count: number;
  brand_marks: string[];
  classification: VisualItemClassification;
  /** Must exactly match locator+hash pairs on the resolved registry art. */
  reference_evidence: AuthenticityEvidence[];
}

export interface UncrustablesMainVisualObservation {
  observer: string;
  observed_at: string;
  method: "human-visual" | "human-visual-with-model-assist";
  items: UncrustablesVisualPackageObservation[];
  /** Explicit lists make a positive empty review distinguishable from omission. */
  foreign_items: string[];
  fictional_or_unknown_items: string[];
  notes?: string;
}

export interface HumanVisualApprovalChecklist {
  image_opened_and_compared_to_registry_evidence: true;
  all_required_flavors_present: true;
  only_reviewed_brand_art_present: true;
  pack_modes_and_sizes_match_recipe: true;
  no_foreign_or_fictional_items: true;
}

export interface UncrustablesMainVisualApprovalBody {
  schema_version: typeof UNCRUSTABLES_MAIN_VISUAL_APPROVAL_SCHEMA;
  immutable: true;
  approval_id: string;
  /** Portable locator where the signed-off record is retained. */
  approval_locator: string;
  reviewer: string;
  reviewed_at: string;
  review_method: "human-visual" | "human-visual-with-model-assist";
  decision: "APPROVED" | "REJECTED";
  /** Digest returned by uncrustablesMainReviewSubjectSha256(). */
  subject_sha256: string;
  checklist: HumanVisualApprovalChecklist;
  notes?: string;
}

export interface UncrustablesMainVisualApproval
  extends UncrustablesMainVisualApprovalBody {
  /** Digest of the approval body, excluding this field. */
  sha256: string;
}

export interface UncrustablesMainAuthenticityInput {
  sku: string;
  image: AuthenticityEvidence;
  generation_manifest: AuthenticityEvidence;
  recipe: UncrustablesMainRecipe;
  registry: UncrustablesAuthenticityRegistry;
  visual_observation: UncrustablesMainVisualObservation;
  human_approval?: UncrustablesMainVisualApproval | null;
}

export type UncrustablesAuthenticityFailureCode =
  | "REGISTRY_INVALID"
  | "IMAGE_EVIDENCE_INVALID"
  | "GENERATION_MANIFEST_EVIDENCE_INVALID"
  | "RECIPE_INVALID"
  | "VISUAL_OBSERVATION_INVALID"
  | "UNKNOWN_FLAVOR"
  | "UNKNOWN_PACK_MODE"
  | "UNKNOWN_PACK_SIZE"
  | "PRODUCT_COUNT_MISMATCH"
  | "UNKNOWN_BRAND_ART"
  | "BRAND_ART_EVIDENCE_MISMATCH"
  | "MISSING_REQUIRED_FLAVOR"
  | "UNEXPECTED_FLAVOR"
  | "FOREIGN_ITEM"
  | "FICTIONAL_ITEM"
  | "FOREIGN_BRAND_MARK"
  | "HUMAN_APPROVAL_REQUIRED"
  | "HUMAN_APPROVAL_INVALID"
  | "HUMAN_APPROVAL_STALE"
  | "HUMAN_APPROVAL_REJECTED";

export interface UncrustablesAuthenticityFinding {
  code: UncrustablesAuthenticityFailureCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface UncrustablesMainAuthenticityResult {
  validator_id: typeof UNCRUSTABLES_MAIN_AUTHENTICITY_VALIDATOR_ID;
  pass: boolean;
  verified: boolean;
  decision: "CAN_USE_MAIN" | "BLOCKED";
  hard_fails: UncrustablesAuthenticityFinding[];
  warnings: string[];
  registry_sha256: string;
  subject_sha256: string;
  approval_sha256?: string;
  observed: {
    required_presentations: string[];
    observed_presentations: string[];
    required_flavor_ids: string[];
    observed_flavor_ids: string[];
    required_package_counts: Record<string, number>;
    observed_package_counts: Record<string, number>;
  };
  cost_cents: 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Stable JSON used by every seal in this module. */
export function uncrustablesAuthenticityStableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => uncrustablesAuthenticityStableJson(item)).join(",")}]`;
  }
  if (!isRecord(value)) return JSON.stringify(value);
  return `{${Object.keys(value)
    .sort()
    .filter((key) => value[key] !== undefined)
    .map(
      (key) =>
        `${JSON.stringify(key)}:${uncrustablesAuthenticityStableJson(value[key])}`,
    )
    .join(",")}}`;
}

export function uncrustablesAuthenticitySha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function digestObject(value: unknown): string {
  return uncrustablesAuthenticitySha256(
    uncrustablesAuthenticityStableJson(value),
  );
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isIsoTimestamp(value: unknown): value is string {
  return (
    nonEmpty(value) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isPackMode(value: unknown): value is UncrustablesPackMode {
  return value === "retail-carton" || value === "individual-wrapper";
}

/**
 * Evidence may live on HTTPS or in a content-addressed local artifact. The
 * function validates locator shape only; the caller that loads bytes must also
 * verify the declared digest before constructing gate input.
 */
function isEvidenceLocator(value: unknown): value is string {
  if (!nonEmpty(value) || /[\u0000-\u001f]/.test(value)) return false;
  const trimmed = value.trim();
  if (/^https:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      return Boolean(parsed.hostname) && !parsed.username && !parsed.password;
    } catch {
      return false;
    }
  }
  if (/^artifact:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      return Boolean(parsed.hostname || parsed.pathname);
    } catch {
      return false;
    }
  }
  // Existing offline audit artifacts are represented by absolute paths or
  // portable repo-relative data/... paths, optionally with a JSON pointer.
  return (
    trimmed.startsWith("/") ||
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.startsWith("data/")
  );
}

function evidenceProblem(
  evidence: unknown,
  expectedKind?: AuthenticityEvidenceKind,
): string | null {
  if (!isRecord(evidence)) return "evidence is not an object";
  if (expectedKind && evidence.kind !== expectedKind) {
    return `evidence kind must be ${expectedKind}`;
  }
  if (!nonEmpty(evidence.kind)) return "evidence kind is missing";
  if (!isEvidenceLocator(evidence.locator)) return "evidence locator is invalid";
  if (!isSha256(evidence.sha256)) return "evidence SHA-256 is invalid";
  return null;
}

function normalizeLabel(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/&/g, " and ")
    .replace(/[®™]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function presentationKey(
  flavorId: string,
  packMode: UncrustablesPackMode,
  retailPackSize: number,
): string {
  return `${flavorId}|${packMode}|${retailPackSize}`;
}

function evidenceKey(evidence: AuthenticityEvidence): string {
  return `${evidence.locator.trim()}|${evidence.sha256.toLowerCase()}`;
}

export function sealUncrustablesAuthenticityRegistry(
  body: UncrustablesAuthenticityRegistryBody,
): UncrustablesAuthenticityRegistry {
  return { ...body, sha256: digestObject(body) };
}

export function sealUncrustablesMainVisualApproval(
  body: UncrustablesMainVisualApprovalBody,
): UncrustablesMainVisualApproval {
  return { ...body, sha256: digestObject(body) };
}

/** Throws on any structural, evidence, duplicate-id, or seal defect. */
export function verifyUncrustablesAuthenticityRegistry(
  registry: UncrustablesAuthenticityRegistry,
): void {
  if (
    registry.schema_version !== UNCRUSTABLES_AUTHENTICITY_REGISTRY_SCHEMA ||
    registry.immutable !== true
  ) {
    throw new Error("Registry is not an immutable supported v1 registry.");
  }
  const { sha256: claimed, ...body } = registry;
  if (!isSha256(claimed) || claimed.toLowerCase() !== digestObject(body)) {
    throw new Error("Registry SHA-256 seal does not match its body.");
  }
  if (
    !nonEmpty(registry.registry_id) ||
    !nonEmpty(registry.reviewed_by) ||
    !isIsoTimestamp(registry.reviewed_at) ||
    registry.review_method !== "human-visual-with-source-evidence"
  ) {
    throw new Error("Registry is missing a valid human source-evidence review.");
  }
  if (
    registry.brand?.product_brand !== "Uncrustables" ||
    registry.brand.market !== "US" ||
    !nonEmpty(registry.brand.owner) ||
    !Array.isArray(registry.brand.allowed_marks) ||
    registry.brand.allowed_marks.length < 2 ||
    registry.brand.allowed_marks.some((mark) => !nonEmpty(mark))
  ) {
    throw new Error("Registry brand identity is incomplete or not US Uncrustables.");
  }
  const allowedMarks = new Set(
    registry.brand.allowed_marks.map((mark) => normalizeLabel(mark)),
  );
  if (!allowedMarks.has("uncrustables") || !allowedMarks.has("smucker s")) {
    throw new Error("Registry must explicitly allow Uncrustables and Smucker's marks.");
  }
  if (!Array.isArray(registry.flavors) || registry.flavors.length === 0) {
    throw new Error("Registry has no reviewed flavors.");
  }

  const flavorIds = new Set<string>();
  const aliases = new Map<string, string>();
  const artIds = new Set<string>();
  const modes = new Set<UncrustablesPackMode>();
  for (const flavor of registry.flavors) {
    if (
      !nonEmpty(flavor.flavor_id) ||
      normalizeLabel(flavor.flavor_id).replace(/ /g, "-") !== flavor.flavor_id ||
      !nonEmpty(flavor.display_name) ||
      !Array.isArray(flavor.aliases) ||
      !Array.isArray(flavor.art) ||
      flavor.art.length === 0
    ) {
      throw new Error("Registry contains an invalid flavor record.");
    }
    if (flavorIds.has(flavor.flavor_id)) {
      throw new Error(`Duplicate registry flavor_id: ${flavor.flavor_id}.`);
    }
    flavorIds.add(flavor.flavor_id);
    const flavorLabels = [flavor.flavor_id, flavor.display_name, ...flavor.aliases];
    for (const label of flavorLabels) {
      if (!nonEmpty(label)) throw new Error(`Blank alias on ${flavor.flavor_id}.`);
      const normalized = normalizeLabel(label);
      const existing = aliases.get(normalized);
      if (existing && existing !== flavor.flavor_id) {
        throw new Error(
          `Registry alias ${JSON.stringify(label)} is ambiguous between ${existing} and ${flavor.flavor_id}.`,
        );
      }
      aliases.set(normalized, flavor.flavor_id);
    }
    for (const art of flavor.art) {
      if (!nonEmpty(art.art_id) || artIds.has(art.art_id)) {
        throw new Error(`Invalid or duplicate registry art_id: ${art.art_id}.`);
      }
      artIds.add(art.art_id);
      if (!isPackMode(art.pack_mode) || art.market !== "US") {
        throw new Error(`Invalid pack mode/market on ${art.art_id}.`);
      }
      modes.add(art.pack_mode);
      if (
        !Number.isInteger(art.retail_pack_size) ||
        art.retail_pack_size < 1 ||
        (art.pack_mode === "individual-wrapper" && art.retail_pack_size !== 1) ||
        (art.pack_mode === "retail-carton" && art.retail_pack_size < 2)
      ) {
        throw new Error(`Invalid reviewed pack size on ${art.art_id}.`);
      }
      if (
        !Array.isArray(art.brand_marks) ||
        art.brand_marks.length === 0 ||
        art.brand_marks.some((mark) => !nonEmpty(mark))
      ) {
        throw new Error(`Registry art ${art.art_id} has no reviewed brand marks.`);
      }
      const artMarks = art.brand_marks.map((mark) => normalizeLabel(mark));
      if (
        !artMarks.includes("uncrustables") ||
        artMarks.some((mark) => !allowedMarks.has(mark))
      ) {
        throw new Error(`Registry art ${art.art_id} contains unapproved brand marks.`);
      }
      if (!Array.isArray(art.evidence) || art.evidence.length === 0) {
        throw new Error(`Registry art ${art.art_id} has no evidence.`);
      }
      const seenEvidence = new Set<string>();
      for (const evidence of art.evidence) {
        const problem = evidenceProblem(evidence);
        if (problem) throw new Error(`Registry art ${art.art_id}: ${problem}.`);
        if (
          ![
            "retailer-product-page",
            "retailer-source-image",
            "manufacturer-source",
            "reviewed-artifact",
          ].includes(evidence.kind)
        ) {
          throw new Error(`Registry art ${art.art_id} uses non-source evidence.`);
        }
        const key = evidenceKey(evidence);
        if (seenEvidence.has(key)) {
          throw new Error(`Registry art ${art.art_id} repeats the same evidence.`);
        }
        seenEvidence.add(key);
      }
    }
  }
  // The source of truth must model both types explicitly. A flavor may support
  // only one mode; an unsupported mode then fails closed for that flavor.
  if (!modes.has("retail-carton") || !modes.has("individual-wrapper")) {
    throw new Error(
      "Registry must contain reviewed retail-carton and individual-wrapper art.",
    );
  }
}

interface RegistryIndex {
  flavorsById: Map<string, ReviewedUncrustablesFlavor>;
  flavorIdByLabel: Map<string, string>;
  artById: Map<string, { flavor_id: string; art: ReviewedUncrustablesArt }>;
  allowedMarks: Set<string>;
}

function indexRegistry(registry: UncrustablesAuthenticityRegistry): RegistryIndex {
  const flavorsById = new Map<string, ReviewedUncrustablesFlavor>();
  const flavorIdByLabel = new Map<string, string>();
  const artById = new Map<
    string,
    { flavor_id: string; art: ReviewedUncrustablesArt }
  >();
  for (const flavor of registry.flavors) {
    flavorsById.set(flavor.flavor_id, flavor);
    for (const label of [flavor.flavor_id, flavor.display_name, ...flavor.aliases]) {
      flavorIdByLabel.set(normalizeLabel(label), flavor.flavor_id);
    }
    for (const art of flavor.art) {
      artById.set(art.art_id, { flavor_id: flavor.flavor_id, art });
    }
  }
  return {
    flavorsById,
    flavorIdByLabel,
    artById,
    allowedMarks: new Set(
      registry.brand.allowed_marks.map((mark) => normalizeLabel(mark)),
    ),
  };
}

function resolveFlavor(index: RegistryIndex, value: string): string | null {
  return index.flavorIdByLabel.get(normalizeLabel(value)) ?? null;
}

/**
 * Resolve only an exact reviewed label. This deliberately re-verifies the
 * registry seal and never applies fuzzy flavor matching.
 */
export function resolveReviewedUncrustablesFlavorId(
  registry: UncrustablesAuthenticityRegistry,
  label: string,
): string | null {
  verifyUncrustablesAuthenticityRegistry(registry);
  return resolveFlavor(indexRegistry(registry), label);
}

export interface ResolvedReviewedUncrustablesPackageArt {
  flavor_id: string;
  pack_mode: UncrustablesPackMode;
  retail_pack_size: number;
  art_id: string;
  evidence: AuthenticityEvidence[];
}

/**
 * Resolve a label and presentation to one exact reviewed package design.
 * An unsupported or ambiguous mode returns null: carton evidence can never
 * authorize an individual wrapper (or vice versa).
 */
export function resolveReviewedUncrustablesPackageArt(
  registry: UncrustablesAuthenticityRegistry,
  label: string,
  packMode: UncrustablesPackMode,
): ResolvedReviewedUncrustablesPackageArt | null {
  verifyUncrustablesAuthenticityRegistry(registry);
  const index = indexRegistry(registry);
  const flavorId = resolveFlavor(index, label);
  if (!flavorId) return null;
  const matches = index.flavorsById
    .get(flavorId)!
    .art.filter((art) => art.pack_mode === packMode);
  if (matches.length !== 1) return null;
  const art = matches[0];
  return {
    flavor_id: flavorId,
    pack_mode: art.pack_mode,
    retail_pack_size: art.retail_pack_size,
    art_id: art.art_id,
    evidence: art.evidence,
  };
}

type ReviewSubjectInput = Omit<
  UncrustablesMainAuthenticityInput,
  "human_approval"
>;

/**
 * The exact immutable subject a reviewer approves. This digest changes when
 * any image/manifest hash, recipe field, registry byte, or observation changes.
 */
export function uncrustablesMainReviewSubjectSha256(
  input: ReviewSubjectInput | UncrustablesMainAuthenticityInput,
): string {
  const subject = {
    schema_version: UNCRUSTABLES_MAIN_AUTHENTICITY_SUBJECT_SCHEMA,
    sku: input.sku,
    image: input.image,
    generation_manifest: input.generation_manifest,
    recipe: input.recipe,
    registry_sha256: isRecord(input.registry) ? input.registry.sha256 : null,
    visual_observation: input.visual_observation,
  };
  return digestObject(subject);
}

function finding(
  code: UncrustablesAuthenticityFailureCode,
  message: string,
  details?: Record<string, unknown>,
): UncrustablesAuthenticityFinding {
  return details ? { code, message, details } : { code, message };
}

function addFindingOnce(
  out: UncrustablesAuthenticityFinding[],
  next: UncrustablesAuthenticityFinding,
): void {
  const key = `${next.code}|${next.message}|${digestObject(next.details ?? null)}`;
  if (
    !out.some(
      (current) =>
        `${current.code}|${current.message}|${digestObject(current.details ?? null)}` === key,
    )
  ) {
    out.push(next);
  }
}

function compareTimes(left: string, right: string): number {
  return Date.parse(left) - Date.parse(right);
}

/** Pure, synchronous, fail-closed authenticity decision. */
export function evaluateUncrustablesMainAuthenticity(
  input: UncrustablesMainAuthenticityInput,
): UncrustablesMainAuthenticityResult {
  const hardFails: UncrustablesAuthenticityFinding[] = [];
  const warnings: string[] = [];
  const requiredPresentations = new Set<string>();
  const observedPresentations = new Set<string>();
  const requiredFlavorIds = new Set<string>();
  const observedFlavorIds = new Set<string>();
  const requiredPackageCounts = new Map<string, number>();
  const observedPackageCounts = new Map<string, number>();
  const subjectSha256 = uncrustablesMainReviewSubjectSha256(input);

  let index: RegistryIndex | null = null;
  try {
    verifyUncrustablesAuthenticityRegistry(input.registry);
    index = indexRegistry(input.registry);
  } catch (error) {
    hardFails.push(
      finding(
        "REGISTRY_INVALID",
        error instanceof Error ? error.message : String(error),
      ),
    );
  }

  const imageProblem = evidenceProblem(input.image, "generated-main");
  if (imageProblem) {
    hardFails.push(finding("IMAGE_EVIDENCE_INVALID", imageProblem));
  }
  const manifestProblem = evidenceProblem(
    input.generation_manifest,
    "generation-manifest",
  );
  if (manifestProblem) {
    hardFails.push(
      finding("GENERATION_MANIFEST_EVIDENCE_INVALID", manifestProblem),
    );
  }
  if (!nonEmpty(input.sku)) {
    hardFails.push(finding("RECIPE_INVALID", "SKU is missing."));
  }
  if (
    !isRecord(input.recipe) ||
    !nonEmpty(input.recipe.recipe_id) ||
    !Array.isArray(input.recipe.components) ||
    input.recipe.components.length === 0
  ) {
    hardFails.push(
      finding("RECIPE_INVALID", "Recipe id/components are missing."),
    );
  } else if (index) {
    for (const [componentIndex, component] of input.recipe.components.entries()) {
      if (
        !isRecord(component) ||
        !nonEmpty(component.flavor) ||
        !Number.isInteger(component.quantity) ||
        component.quantity < 1 ||
        !isPackMode(component.expected_pack_mode) ||
        !Number.isInteger(component.expected_retail_pack_size) ||
        component.expected_retail_pack_size < 1
      ) {
        hardFails.push(
          finding("RECIPE_INVALID", `Recipe component ${componentIndex} is invalid.`),
        );
        continue;
      }
      const flavorId = resolveFlavor(index, component.flavor);
      if (!flavorId) {
        hardFails.push(
          finding("UNKNOWN_FLAVOR", `Recipe flavor is not reviewed: ${component.flavor}.`, {
            component_index: componentIndex,
            flavor: component.flavor,
          }),
        );
        continue;
      }
      requiredFlavorIds.add(flavorId);
      const flavor = index.flavorsById.get(flavorId)!;
      const modeArt = flavor.art.filter(
        (art) => art.pack_mode === component.expected_pack_mode,
      );
      if (modeArt.length === 0) {
        hardFails.push(
          finding(
            "UNKNOWN_PACK_MODE",
            `${flavorId} has no reviewed ${component.expected_pack_mode} art.`,
            { component_index: componentIndex, flavor_id: flavorId },
          ),
        );
        continue;
      }
      if (
        !modeArt.some(
          (art) => art.retail_pack_size === component.expected_retail_pack_size,
        )
      ) {
        hardFails.push(
          finding(
            "UNKNOWN_PACK_SIZE",
            `${flavorId} ${component.expected_pack_mode} size ${component.expected_retail_pack_size} is not reviewed.`,
            {
              component_index: componentIndex,
              flavor_id: flavorId,
              reviewed_sizes: modeArt.map((art) => art.retail_pack_size),
            },
          ),
        );
        continue;
      }
      if (component.quantity % component.expected_retail_pack_size !== 0) {
        hardFails.push(
          finding(
            "RECIPE_INVALID",
            `${flavorId} quantity ${component.quantity} cannot be represented exactly by reviewed ${component.expected_retail_pack_size}-unit ${component.expected_pack_mode} packages.`,
            { component_index: componentIndex, flavor_id: flavorId },
          ),
        );
        continue;
      }
      const key = presentationKey(
        flavorId,
        component.expected_pack_mode,
        component.expected_retail_pack_size,
      );
      requiredPresentations.add(key);
      requiredPackageCounts.set(
        key,
        (requiredPackageCounts.get(key) ?? 0) +
          component.quantity / component.expected_retail_pack_size,
      );
    }
  }

  const observation = input.visual_observation;
  const observationIsValid =
    isRecord(observation) &&
    nonEmpty(observation.observer) &&
    isIsoTimestamp(observation.observed_at) &&
    (observation.method === "human-visual" ||
      observation.method === "human-visual-with-model-assist") &&
    Array.isArray(observation.items) &&
    observation.items.length > 0 &&
    Array.isArray(observation.foreign_items) &&
    observation.foreign_items.every((item) => nonEmpty(item)) &&
    Array.isArray(observation.fictional_or_unknown_items) &&
    observation.fictional_or_unknown_items.every((item) => nonEmpty(item));
  if (!observationIsValid) {
    hardFails.push(
      finding(
        "VISUAL_OBSERVATION_INVALID",
        "A complete human visual observation is required; OCR-only input is not accepted.",
      ),
    );
  } else {
    if (observation.method === "human-visual-with-model-assist") {
      warnings.push(
        "Model assistance was used; the bound human approval remains authoritative.",
      );
    }
    if (observation.foreign_items.length > 0) {
      hardFails.push(
        finding("FOREIGN_ITEM", "Visual review found foreign items.", {
          items: observation.foreign_items,
        }),
      );
    }
    if (observation.fictional_or_unknown_items.length > 0) {
      hardFails.push(
        finding("FICTIONAL_ITEM", "Visual review found fictional or unknown items.", {
          items: observation.fictional_or_unknown_items,
        }),
      );
    }
    if (index) {
      const observationIds = new Set<string>();
      for (const [itemIndex, item] of observation.items.entries()) {
        if (
          !isRecord(item) ||
          !nonEmpty(item.observation_id) ||
          !nonEmpty(item.flavor) ||
          !nonEmpty(item.art_id) ||
          !isPackMode(item.pack_mode) ||
          !Number.isInteger(item.retail_pack_size) ||
          item.retail_pack_size < 1 ||
          !Number.isInteger(item.visible_package_count) ||
          item.visible_package_count < 1 ||
          !Array.isArray(item.brand_marks) ||
          item.brand_marks.length === 0 ||
          item.brand_marks.some((mark) => !nonEmpty(mark)) ||
          !Array.isArray(item.reference_evidence) ||
          item.reference_evidence.length === 0
        ) {
          hardFails.push(
            finding(
              "VISUAL_OBSERVATION_INVALID",
              `Visual package observation ${itemIndex} is incomplete.`,
            ),
          );
          continue;
        }
        if (observationIds.has(item.observation_id)) {
          hardFails.push(
            finding(
              "VISUAL_OBSERVATION_INVALID",
              `Duplicate observation_id: ${item.observation_id}.`,
            ),
          );
        }
        observationIds.add(item.observation_id);
        if (item.classification === "foreign-product") {
          hardFails.push(
            finding("FOREIGN_ITEM", `Foreign product observed in ${item.observation_id}.`),
          );
        } else if (item.classification === "fictional-or-unknown-product") {
          hardFails.push(
            finding(
              "FICTIONAL_ITEM",
              `Fictional/unknown product observed in ${item.observation_id}.`,
            ),
          );
        } else if (item.classification !== "reviewed-real-uncrustables") {
          hardFails.push(
            finding(
              "VISUAL_OBSERVATION_INVALID",
              `Unknown classification in ${item.observation_id}.`,
            ),
          );
        }

        const flavorId = resolveFlavor(index, item.flavor);
        if (!flavorId) {
          hardFails.push(
            finding("UNKNOWN_FLAVOR", `Observed flavor is not reviewed: ${item.flavor}.`, {
              observation_id: item.observation_id,
            }),
          );
          continue;
        }
        observedFlavorIds.add(flavorId);
        const key = presentationKey(
          flavorId,
          item.pack_mode,
          item.retail_pack_size,
        );
        observedPresentations.add(key);
        observedPackageCounts.set(
          key,
          (observedPackageCounts.get(key) ?? 0) + item.visible_package_count,
        );

        const resolvedArt = index.artById.get(item.art_id);
        if (!resolvedArt || resolvedArt.flavor_id !== flavorId) {
          hardFails.push(
            finding(
              "UNKNOWN_BRAND_ART",
              `Art ${item.art_id} is not reviewed for ${flavorId}.`,
              { observation_id: item.observation_id },
            ),
          );
          continue;
        }
        if (resolvedArt.art.pack_mode !== item.pack_mode) {
          hardFails.push(
            finding(
              "UNKNOWN_PACK_MODE",
              `Art ${item.art_id} is ${resolvedArt.art.pack_mode}, not ${item.pack_mode}.`,
              { observation_id: item.observation_id },
            ),
          );
        }
        if (resolvedArt.art.retail_pack_size !== item.retail_pack_size) {
          hardFails.push(
            finding(
              "UNKNOWN_PACK_SIZE",
              `Art ${item.art_id} has reviewed size ${resolvedArt.art.retail_pack_size}, not ${item.retail_pack_size}.`,
              { observation_id: item.observation_id },
            ),
          );
        }

        const artMarks = new Set(
          resolvedArt.art.brand_marks.map((mark) => normalizeLabel(mark)),
        );
        const observedMarks = new Set(
          item.brand_marks.map((mark) => normalizeLabel(mark)),
        );
        const foreignMarks = item.brand_marks.filter((mark) => {
          const normalized = normalizeLabel(mark);
          return !artMarks.has(normalized) || !index!.allowedMarks.has(normalized);
        });
        if (foreignMarks.length > 0) {
          hardFails.push(
            finding(
              "FOREIGN_BRAND_MARK",
              `Unreviewed brand mark(s) on ${item.observation_id}: ${foreignMarks.join(", ")}.`,
              { observation_id: item.observation_id, brand_marks: foreignMarks },
            ),
          );
        }
        const missingMarks = [...artMarks].filter(
          (mark) => !observedMarks.has(mark),
        );
        if (missingMarks.length > 0) {
          hardFails.push(
            finding(
              "UNKNOWN_BRAND_ART",
              `Required reviewed mark(s) are missing on ${item.observation_id}: ${missingMarks.join(", ")}.`,
              { observation_id: item.observation_id, missing_brand_marks: missingMarks },
            ),
          );
        }

        const reviewedEvidence = new Set(
          resolvedArt.art.evidence.map((evidence) => evidenceKey(evidence)),
        );
        const validReference = item.reference_evidence.every((evidence) => {
          if (evidenceProblem(evidence)) return false;
          return reviewedEvidence.has(evidenceKey(evidence));
        });
        if (!validReference) {
          hardFails.push(
            finding(
              "BRAND_ART_EVIDENCE_MISMATCH",
              `Observation ${item.observation_id} is not tied to exact registry evidence.`,
            ),
          );
        }
      }
    }
  }

  for (const key of requiredPresentations) {
    if (!observedPresentations.has(key)) {
      addFindingOnce(
        hardFails,
        finding("MISSING_REQUIRED_FLAVOR", `Required recipe presentation is missing: ${key}.`),
      );
    }
    const requiredCount = requiredPackageCounts.get(key) ?? 0;
    const observedCount = observedPackageCounts.get(key) ?? 0;
    if (requiredCount !== observedCount) {
      addFindingOnce(
        hardFails,
        finding(
          "PRODUCT_COUNT_MISMATCH",
          `Visible package count for ${key} is ${observedCount}; recipe requires ${requiredCount}.`,
          { presentation: key, required_count: requiredCount, observed_count: observedCount },
        ),
      );
    }
  }
  for (const key of observedPresentations) {
    if (!requiredPresentations.has(key)) {
      addFindingOnce(
        hardFails,
        finding("UNEXPECTED_FLAVOR", `Unexpected flavor/presentation is visible: ${key}.`),
      );
    }
  }

  const approval = input.human_approval;
  let approvalValid = false;
  if (!approval) {
    hardFails.push(
      finding(
        "HUMAN_APPROVAL_REQUIRED",
        "Generated MAIN remains blocked until a human visually approves the exact review subject.",
      ),
    );
  } else {
    const { sha256: approvalClaim, ...approvalBody } = approval;
    const approvalStructureValid =
      approval.schema_version === UNCRUSTABLES_MAIN_VISUAL_APPROVAL_SCHEMA &&
      approval.immutable === true &&
      nonEmpty(approval.approval_id) &&
      isEvidenceLocator(approval.approval_locator) &&
      nonEmpty(approval.reviewer) &&
      isIsoTimestamp(approval.reviewed_at) &&
      (approval.review_method === "human-visual" ||
        approval.review_method === "human-visual-with-model-assist") &&
      (approval.decision === "APPROVED" || approval.decision === "REJECTED") &&
      isSha256(approval.subject_sha256) &&
      isSha256(approvalClaim) &&
      approvalClaim.toLowerCase() === digestObject(approvalBody) &&
      isRecord(approval.checklist) &&
      approval.checklist.image_opened_and_compared_to_registry_evidence === true &&
      approval.checklist.all_required_flavors_present === true &&
      approval.checklist.only_reviewed_brand_art_present === true &&
      approval.checklist.pack_modes_and_sizes_match_recipe === true &&
      approval.checklist.no_foreign_or_fictional_items === true;
    if (!approvalStructureValid) {
      hardFails.push(
        finding(
          "HUMAN_APPROVAL_INVALID",
          "Human approval is malformed, unsealed, or has an incomplete checklist.",
        ),
      );
    } else if (approval.decision !== "APPROVED") {
      hardFails.push(
        finding("HUMAN_APPROVAL_REJECTED", "Human reviewer rejected this MAIN."),
      );
    } else if (approval.subject_sha256.toLowerCase() !== subjectSha256) {
      hardFails.push(
        finding(
          "HUMAN_APPROVAL_STALE",
          "Human approval is bound to a different image, recipe, registry, or observation.",
        ),
      );
    } else if (
      observationIsValid &&
      compareTimes(approval.reviewed_at, observation.observed_at) < 0
    ) {
      hardFails.push(
        finding(
          "HUMAN_APPROVAL_STALE",
          "Human approval predates the visual observation.",
        ),
      );
    } else {
      approvalValid = true;
    }
  }

  const pass = hardFails.length === 0 && approvalValid;
  return {
    validator_id: UNCRUSTABLES_MAIN_AUTHENTICITY_VALIDATOR_ID,
    pass,
    verified: pass,
    decision: pass ? "CAN_USE_MAIN" : "BLOCKED",
    hard_fails: hardFails,
    warnings,
    registry_sha256:
      isRecord(input.registry) && typeof input.registry.sha256 === "string"
        ? input.registry.sha256
        : "",
    subject_sha256: subjectSha256,
    ...(approval ? { approval_sha256: approval.sha256 } : {}),
    observed: {
      required_presentations: [...requiredPresentations].sort(),
      observed_presentations: [...observedPresentations].sort(),
      required_flavor_ids: [...requiredFlavorIds].sort(),
      observed_flavor_ids: [...observedFlavorIds].sort(),
      required_package_counts: Object.fromEntries(
        [...requiredPackageCounts.entries()].sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
      observed_package_counts: Object.fromEntries(
        [...observedPackageCounts.entries()].sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    },
    cost_cents: 0,
  };
}
