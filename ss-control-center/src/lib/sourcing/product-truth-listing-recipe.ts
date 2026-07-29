import { createHash } from "node:crypto";

import type { Client, InStatement, Row } from "@libsql/client";

import {
  CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256,
  CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256,
  CANONICAL_PRODUCT_MATCHER_VERSION,
} from "./canonical-product-match-provenance";
import {
  productTruthOperationalSha256,
  renderProductTruthOperationalJson,
} from "./product-truth-operational-run-contract";
import {
  assertProductTruthEvidenceSchema,
  assertProductTruthListingScopeSchema,
} from "./product-truth-schema-gate";

export const PRODUCT_TRUTH_LISTING_RECIPE_VERSION =
  "product-truth-listing-recipe/1.0.0" as const;

export type ProductTruthListingRecipeSourceKind =
  | "TARGETED_WALMART_EVIDENCE"
  | "LEGACY_BRIDGE"
  | "CANONICAL_COST_GRAPH";

export interface ProductTruthListingRecipeCandidateComponent {
  componentIndex: number;
  quantity: number;
  product: string;
  flavor: string | null;
  size: string | null;
  targetCanonicalVariantId: string;
  donorProductId: string;
  variantDecisionId: string;
  sourceComponentId: string | null;
  sourceEvidence: unknown;
}

export interface ProductTruthListingRecipeCandidate {
  listingKey: string;
  manifestSha256: string;
  sourceKind: ProductTruthListingRecipeSourceKind;
  sourceArtifactSha256: string;
  effectiveAt: string;
  createdAt: string;
  runId: string | null;
  approvalId: string | null;
  components: readonly ProductTruthListingRecipeCandidateComponent[];
}

export interface ProductTruthListingRecipeComponentRow {
  id: string;
  componentKey: string;
  listingRecipeId: string;
  componentIndex: number;
  quantity: number;
  product: string;
  flavor: string | null;
  size: string | null;
  targetCanonicalVariantId: string;
  donorProductId: string;
  variantDecisionId: string;
  sourceComponentId: string | null;
  evidenceHash: string;
  evidenceJson: string;
  createdAt: string;
}

export interface ProductTruthListingRecipeRow {
  id: string;
  recipeKey: string;
  listingKey: string;
  recipeVersion: typeof PRODUCT_TRUTH_LISTING_RECIPE_VERSION;
  recipeHash: string;
  componentCount: number;
  sourceKind: ProductTruthListingRecipeSourceKind;
  sourceArtifactSha256: string;
  manifestSha256: string;
  evidenceHash: string;
  evidenceJson: string;
  effectiveAt: string;
  runId: string | null;
  approvalId: string | null;
  createdAt: string;
}

export interface ProductTruthListingRecipeMaterialization {
  recipe: ProductTruthListingRecipeRow;
  components: ProductTruthListingRecipeComponentRow[];
}

export interface ProductTruthListingRecipeMaterializationResult {
  status: "APPLIED" | "ALREADY_APPLIED";
  recipeId: string;
  recipeKey: string;
  recipeHash: string;
  listingKey: string;
  componentCount: number;
}

export interface ProductTruthListingRecipeStructure {
  listingKey: string;
  components: readonly {
    componentIndex: number;
    quantity: number;
    targetCanonicalVariantId: string;
  }[];
}

export class ProductTruthListingRecipeError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(`${code}: ${message}`, options);
    this.name = "ProductTruthListingRecipeError";
    this.code = code;
  }
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new ProductTruthListingRecipeError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function exactText(value: unknown, label: string, maximum = 500): string {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.length > maximum
  ) {
    fail("LISTING_RECIPE_INPUT_INVALID", `${label} must be 1-${maximum} exact characters`);
  }
  return value;
}

function nullableText(value: unknown, label: string, maximum = 500): string | null {
  if (value === null) return null;
  return exactText(value, label, maximum);
}

function exactSha(value: unknown, label: string): string {
  const text = exactText(value, label, 64);
  if (!/^[a-f0-9]{64}$/.test(text)) {
    fail("LISTING_RECIPE_INPUT_INVALID", `${label} must be a lowercase SHA-256`);
  }
  return text;
}

function safeId(value: unknown, label: string): string {
  const text = exactText(value, label, 500);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text)) {
    fail("LISTING_RECIPE_INPUT_INVALID", `${label} contains unsafe characters`);
  }
  return text;
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    fail("LISTING_RECIPE_INPUT_INVALID", `${label} must be a positive safe integer`);
  }
  return Number(value);
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    fail("LISTING_RECIPE_INPUT_INVALID", `${label} must be a non-negative safe integer`);
  }
  return Number(value);
}

function canonicalInstant(value: unknown, label: string): string {
  const text = exactText(value, label, 80);
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(text)) {
    fail("LISTING_RECIPE_INPUT_INVALID", `${label} must include a timezone`);
  }
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) {
    fail("LISTING_RECIPE_INPUT_INVALID", `${label} must be a valid timestamp`);
  }
  return new Date(timestamp).toISOString();
}

function sha256Text(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function scalar(value: unknown): unknown {
  return typeof value === "bigint" ? Number(value) : value;
}

function assertEquivalent(
  actual: Row,
  expected: Record<string, unknown>,
  code: string,
): void {
  const mismatches = Object.entries(expected)
    .filter(([key, value]) => !Object.is(scalar(actual[key]), scalar(value)))
    .map(([key]) => key);
  if (mismatches.length) fail(code, mismatches.join(","));
}

function normalizedCandidate(
  input: ProductTruthListingRecipeCandidate,
): ProductTruthListingRecipeCandidate {
  const listingKey = safeId(input.listingKey, "listingKey");
  const manifestSha256 = exactSha(input.manifestSha256, "manifestSha256");
  const sourceArtifactSha256 = exactSha(
    input.sourceArtifactSha256,
    "sourceArtifactSha256",
  );
  if (
    input.sourceKind !== "TARGETED_WALMART_EVIDENCE"
    && input.sourceKind !== "LEGACY_BRIDGE"
    && input.sourceKind !== "CANONICAL_COST_GRAPH"
  ) {
    fail("LISTING_RECIPE_INPUT_INVALID", "sourceKind is unsupported");
  }
  const effectiveAt = canonicalInstant(input.effectiveAt, "effectiveAt");
  const createdAt = canonicalInstant(input.createdAt, "createdAt");
  if (Date.parse(effectiveAt) > Date.parse(createdAt)) {
    fail("LISTING_RECIPE_INPUT_INVALID", "effectiveAt must not exceed createdAt");
  }
  const runId = input.runId === null ? null : safeId(input.runId, "runId");
  const approvalId =
    input.approvalId === null ? null : safeId(input.approvalId, "approvalId");
  if ((runId === null) !== (approvalId === null)) {
    fail(
      "LISTING_RECIPE_INPUT_INVALID",
      "runId and approvalId must either both be present or both be null",
    );
  }
  if (!Array.isArray(input.components) || input.components.length < 1) {
    fail("LISTING_RECIPE_INPUT_INVALID", "components must be non-empty");
  }
  if (input.components.some((component) => component.sourceEvidence === undefined)) {
    fail("LISTING_RECIPE_INPUT_INVALID", "component sourceEvidence is required");
  }
  const components = input.components
    .map((component, ordinal) => ({
      componentIndex: nonNegativeInteger(
        component.componentIndex,
        `components[${ordinal}].componentIndex`,
      ),
      quantity: positiveInteger(component.quantity, `components[${ordinal}].quantity`),
      product: exactText(component.product, `components[${ordinal}].product`),
      flavor: nullableText(component.flavor, `components[${ordinal}].flavor`),
      size: nullableText(component.size, `components[${ordinal}].size`),
      targetCanonicalVariantId: safeId(
        component.targetCanonicalVariantId,
        `components[${ordinal}].targetCanonicalVariantId`,
      ),
      donorProductId: safeId(
        component.donorProductId,
        `components[${ordinal}].donorProductId`,
      ),
      variantDecisionId: safeId(
        component.variantDecisionId,
        `components[${ordinal}].variantDecisionId`,
      ),
      sourceComponentId: component.sourceComponentId === null
        ? null
        : safeId(component.sourceComponentId, `components[${ordinal}].sourceComponentId`),
      sourceEvidence: component.sourceEvidence,
    }))
    .sort((left, right) => left.componentIndex - right.componentIndex);
  components.forEach((component, index) => {
    if (component.componentIndex !== index) {
      fail(
        "LISTING_RECIPE_INPUT_INVALID",
        "component indexes must be unique and contiguous from zero",
      );
    }
  });
  return {
    listingKey,
    manifestSha256,
    sourceKind: input.sourceKind,
    sourceArtifactSha256,
    effectiveAt,
    createdAt,
    runId,
    approvalId,
    components,
  };
}

export function productTruthListingRecipeStructuralHash(
  rawInput: ProductTruthListingRecipeStructure,
): string {
  const listingKey = safeId(rawInput.listingKey, "listingKey");
  if (!Array.isArray(rawInput.components) || rawInput.components.length < 1) {
    fail("LISTING_RECIPE_INPUT_INVALID", "components must be non-empty");
  }
  const components = rawInput.components.map((component, ordinal) => ({
    componentIndex: nonNegativeInteger(
      component.componentIndex,
      `components[${ordinal}].componentIndex`,
    ),
    quantity: positiveInteger(
      component.quantity,
      `components[${ordinal}].quantity`,
    ),
    targetCanonicalVariantId: safeId(
      component.targetCanonicalVariantId,
      `components[${ordinal}].targetCanonicalVariantId`,
    ),
  })).sort((left, right) => left.componentIndex - right.componentIndex);
  components.forEach((component, index) => {
    if (component.componentIndex !== index) {
      fail(
        "LISTING_RECIPE_INPUT_INVALID",
        "component indexes must be unique and contiguous from zero",
      );
    }
  });
  return productTruthOperationalSha256({
    schemaVersion: PRODUCT_TRUTH_LISTING_RECIPE_VERSION,
    listingKey,
    components,
  });
}

export function buildProductTruthListingRecipeMaterialization(
  rawInput: ProductTruthListingRecipeCandidate,
): ProductTruthListingRecipeMaterialization {
  const input = normalizedCandidate(rawInput);
  const recipeHash = productTruthListingRecipeStructuralHash({
    listingKey: input.listingKey,
    components: input.components.map((component) => ({
      componentIndex: component.componentIndex,
      quantity: component.quantity,
      targetCanonicalVariantId: component.targetCanonicalVariantId,
    })),
  });
  const componentPayloads = input.components.map((component) => {
    const sourceEvidenceSha256 = productTruthOperationalSha256(
      component.sourceEvidence,
    );
    const evidence = {
      schemaVersion: "product-truth-listing-recipe-component-evidence/1.0.0",
      listingKey: input.listingKey,
      componentIndex: component.componentIndex,
      quantity: component.quantity,
      product: component.product,
      flavor: component.flavor,
      size: component.size,
      targetCanonicalVariantId: component.targetCanonicalVariantId,
      donorProductId: component.donorProductId,
      variantDecisionId: component.variantDecisionId,
      sourceComponentId: component.sourceComponentId,
      sourceEvidenceSha256,
      sourceEvidence: component.sourceEvidence,
    };
    const evidenceJson = renderProductTruthOperationalJson(evidence);
    return {
      component,
      evidence,
      evidenceJson,
      evidenceHash: sha256Text(evidenceJson),
    };
  });
  const headerEvidence = {
    schemaVersion: PRODUCT_TRUTH_LISTING_RECIPE_VERSION,
    listingKey: input.listingKey,
    recipeHash,
    manifestSha256: input.manifestSha256,
    sourceKind: input.sourceKind,
    sourceArtifactSha256: input.sourceArtifactSha256,
    effectiveAt: input.effectiveAt,
    components: componentPayloads.map(({ component, evidenceHash }) => ({
      componentIndex: component.componentIndex,
      quantity: component.quantity,
      product: component.product,
      flavor: component.flavor,
      size: component.size,
      targetCanonicalVariantId: component.targetCanonicalVariantId,
      donorProductId: component.donorProductId,
      variantDecisionId: component.variantDecisionId,
      sourceComponentId: component.sourceComponentId,
      componentEvidenceHash: evidenceHash,
    })),
  };
  const evidenceJson = renderProductTruthOperationalJson(headerEvidence);
  const evidenceHash = sha256Text(evidenceJson);
  const recipeKey = productTruthOperationalSha256({
    version: PRODUCT_TRUTH_LISTING_RECIPE_VERSION,
    listingKey: input.listingKey,
    recipeHash,
    sourceArtifactSha256: input.sourceArtifactSha256,
    evidenceHash,
  });
  const recipeId = `ptr:${recipeKey}`;
  const recipe: ProductTruthListingRecipeRow = {
    id: recipeId,
    recipeKey,
    listingKey: input.listingKey,
    recipeVersion: PRODUCT_TRUTH_LISTING_RECIPE_VERSION,
    recipeHash,
    componentCount: componentPayloads.length,
    sourceKind: input.sourceKind,
    sourceArtifactSha256: input.sourceArtifactSha256,
    manifestSha256: input.manifestSha256,
    evidenceHash,
    evidenceJson,
    effectiveAt: input.effectiveAt,
    runId: input.runId,
    approvalId: input.approvalId,
    createdAt: input.createdAt,
  };
  const components = componentPayloads.map(
    ({ component, evidenceHash: componentEvidenceHash, evidenceJson: componentEvidenceJson }) => {
      const componentKey = productTruthOperationalSha256({
        version: "product-truth-listing-recipe-component/1.0.0",
        recipeKey,
        componentIndex: component.componentIndex,
        componentEvidenceHash,
      });
      return {
        id: `ptrc:${componentKey}`,
        componentKey,
        listingRecipeId: recipeId,
        componentIndex: component.componentIndex,
        quantity: component.quantity,
        product: component.product,
        flavor: component.flavor,
        size: component.size,
        targetCanonicalVariantId: component.targetCanonicalVariantId,
        donorProductId: component.donorProductId,
        variantDecisionId: component.variantDecisionId,
        sourceComponentId: component.sourceComponentId,
        evidenceHash: componentEvidenceHash,
        evidenceJson: componentEvidenceJson,
        createdAt: input.createdAt,
      } satisfies ProductTruthListingRecipeComponentRow;
    },
  );
  return { recipe, components };
}

function componentInsert(row: ProductTruthListingRecipeComponentRow): InStatement {
  return {
    sql: `INSERT INTO ProductTruthListingRecipeComponent (
      id,componentKey,listingRecipeId,componentIndex,quantity,product,flavor,size,
      targetCanonicalVariantId,donorProductId,variantDecisionId,sourceComponentId,
      evidenceHash,evidenceJson,createdAt
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      row.id, row.componentKey, row.listingRecipeId, row.componentIndex,
      row.quantity, row.product, row.flavor, row.size,
      row.targetCanonicalVariantId, row.donorProductId, row.variantDecisionId,
      row.sourceComponentId, row.evidenceHash, row.evidenceJson, row.createdAt,
    ],
  };
}

function recipeInsert(row: ProductTruthListingRecipeRow): InStatement {
  return {
    sql: `INSERT INTO ProductTruthListingRecipe (
      id,recipeKey,listingKey,recipeVersion,recipeHash,componentCount,sourceKind,
      sourceArtifactSha256,manifestSha256,evidenceHash,evidenceJson,effectiveAt,
      runId,approvalId,createdAt
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    args: [
      row.id, row.recipeKey, row.listingKey, row.recipeVersion, row.recipeHash,
      row.componentCount, row.sourceKind, row.sourceArtifactSha256,
      row.manifestSha256, row.evidenceHash, row.evidenceJson, row.effectiveAt,
      row.runId, row.approvalId, row.createdAt,
    ],
  };
}

async function assertSourceGraph(
  db: Client,
  materialization: ProductTruthListingRecipeMaterialization,
): Promise<void> {
  const scope = (await db.execute({
    sql: `SELECT listingKey,manifestSha256,registrationKind
          FROM ProductTruthListingScope WHERE listingKey=?`,
    args: [materialization.recipe.listingKey],
  })).rows[0];
  if (
    !scope
    || scope.manifestSha256 !== materialization.recipe.manifestSha256
    || scope.registrationKind !== "AUTHORITATIVE_PHASE1_MANIFEST"
  ) {
    fail(
      "LISTING_RECIPE_SCOPE_INVALID",
      materialization.recipe.listingKey,
    );
  }
  for (const component of materialization.components) {
    const row = (await db.execute({
      sql: `SELECT decision.id,decision.donorProductId,decision.canonicalVariantId,
                   decision.decisionStatus,decision.matcherVersion,
                   decision.matcherImplementationSha256,
                   decision.matcherReleaseSha256,donor.identityStatus
            FROM DonorProductVariantDecision decision
            JOIN DonorProduct donor ON donor.id=decision.donorProductId
            JOIN CanonicalProductVariant variant
              ON variant.id=decision.canonicalVariantId
            WHERE decision.id=?`,
      args: [component.variantDecisionId],
    })).rows[0];
    if (
      !row
      || row.donorProductId !== component.donorProductId
      || row.canonicalVariantId !== component.targetCanonicalVariantId
      || row.decisionStatus !== "exact_confirmed"
      || row.identityStatus !== "exact_confirmed"
      || row.matcherVersion !== CANONICAL_PRODUCT_MATCHER_VERSION
      || row.matcherImplementationSha256 !== CANONICAL_PRODUCT_MATCHER_SOURCE_SHA256
      || row.matcherReleaseSha256 !== CANONICAL_PRODUCT_MATCHER_RELEASE_SHA256
    ) {
      fail(
        "LISTING_RECIPE_EXACT_IDENTITY_INVALID",
        `${materialization.recipe.listingKey}:${component.componentIndex}`,
      );
    }
  }
}

async function existingMaterialization(
  db: Client,
  materialization: ProductTruthListingRecipeMaterialization,
): Promise<boolean> {
  const rows = (await db.execute({
    sql: `SELECT * FROM ProductTruthListingRecipe WHERE id=? OR recipeKey=?`,
    args: [materialization.recipe.id, materialization.recipe.recipeKey],
  })).rows;
  if (!rows.length) return false;
  if (rows.length !== 1) {
    fail("LISTING_RECIPE_IDEMPOTENCY_CONFLICT", "multiple recipe rows");
  }
  assertEquivalent(
    rows[0],
    materialization.recipe as unknown as Record<string, unknown>,
    "LISTING_RECIPE_IDEMPOTENCY_CONFLICT",
  );
  const components = (await db.execute({
    sql: `SELECT * FROM ProductTruthListingRecipeComponent
          WHERE listingRecipeId=? ORDER BY componentIndex`,
    args: [materialization.recipe.id],
  })).rows;
  if (components.length !== materialization.components.length) {
    fail("LISTING_RECIPE_COMPONENT_CONFLICT", "component count differs");
  }
  materialization.components.forEach((expected, index) => {
    assertEquivalent(
      components[index],
      expected as unknown as Record<string, unknown>,
      "LISTING_RECIPE_COMPONENT_CONFLICT",
    );
  });
  return true;
}

export async function materializeProductTruthListingRecipe(
  db: Client,
  candidate: ProductTruthListingRecipeCandidate,
): Promise<ProductTruthListingRecipeMaterializationResult> {
  await assertProductTruthEvidenceSchema(db);
  await assertProductTruthListingScopeSchema(db);
  const materialization = buildProductTruthListingRecipeMaterialization(candidate);
  await assertSourceGraph(db, materialization);
  if (await existingMaterialization(db, materialization)) {
    return {
      status: "ALREADY_APPLIED",
      recipeId: materialization.recipe.id,
      recipeKey: materialization.recipe.recipeKey,
      recipeHash: materialization.recipe.recipeHash,
      listingKey: materialization.recipe.listingKey,
      componentCount: materialization.recipe.componentCount,
    };
  }
  for (const component of materialization.components) {
    const collision = (await db.execute({
      sql: `SELECT id FROM ProductTruthListingRecipeComponent
            WHERE id=? OR componentKey=?
               OR (listingRecipeId=? AND componentIndex=?)
            LIMIT 1`,
      args: [
        component.id,
        component.componentKey,
        component.listingRecipeId,
        component.componentIndex,
      ],
    })).rows;
    if (collision.length) {
      fail(
        "LISTING_RECIPE_COMPONENT_ORPHAN_CONFLICT",
        `${materialization.recipe.listingKey}:${component.componentIndex}`,
      );
    }
  }
  try {
    await db.batch([
      ...materialization.components.map(componentInsert),
      recipeInsert(materialization.recipe),
    ], "write");
  } catch (error) {
    fail(
      "LISTING_RECIPE_WRITE_FAILED",
      materialization.recipe.listingKey,
      error,
    );
  }
  if (!(await existingMaterialization(db, materialization))) {
    fail(
      "LISTING_RECIPE_POSTCONDITION_FAILED",
      materialization.recipe.listingKey,
    );
  }
  return {
    status: "APPLIED",
    recipeId: materialization.recipe.id,
    recipeKey: materialization.recipe.recipeKey,
    recipeHash: materialization.recipe.recipeHash,
    listingKey: materialization.recipe.listingKey,
    componentCount: materialization.recipe.componentCount,
  };
}
