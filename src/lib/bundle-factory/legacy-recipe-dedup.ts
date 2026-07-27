import { createHash } from "node:crypto";

export const LEGACY_RECIPE_ALIAS_SCHEMA =
  "bundle-factory-recipe-alias/v1" as const;
export const LEGACY_RECIPE_DEDUP_PLAN_SCHEMA =
  "bundle-factory-legacy-recipe-dedup-plan/v1" as const;

type UnknownRecord = Record<string, unknown>;

export interface RecipeAliasComponentInput {
  product_name: string;
  qty: number;
}

export interface RecipeAliasInput {
  brand: string;
  composition_type: string;
  unit_count: number;
  components: RecipeAliasComponentInput[];
}

export interface RecipeAliasIdentity {
  schema_version: typeof LEGACY_RECIPE_ALIAS_SCHEMA;
  brand: string;
  composition_type: string;
  unit_count: number;
  components: Array<{
    product_name: string;
    qty: number;
  }>;
}

export interface LegacyRecipeDraftCandidate {
  id: string;
  generation_job_id: string;
  brand: string;
  composition_type: string;
  pack_count: number;
  recipe_fingerprint: string | null;
  draft_components: string | unknown[];
  created_at?: Date | string | null;
  variation_matrix?: {
    variants_json: string | unknown[];
    selected_variant_idx: number | null;
  } | null;
}

export type LegacyRecipeAliasResolution =
  | {
      status: "CLEAR";
      recipe_alias_fingerprint: string;
      canonical: null;
      duplicate_siblings: [];
      blockers: [];
    }
  | {
      status: "MATCH";
      recipe_alias_fingerprint: string;
      canonical: LegacyRecipeDraftCandidate;
      duplicate_siblings: LegacyRecipeDraftCandidate[];
      blockers: [];
    }
  | {
      status: "BLOCKED";
      recipe_alias_fingerprint: string;
      canonical: null;
      duplicate_siblings: [];
      blockers: string[];
    };

export interface LegacyRecipeDedupLedgerLike {
  schema_version?: unknown;
  audit_id?: unknown;
  completed_at?: unknown;
  complete?: unknown;
  immutable?: unknown;
  external_mutations?: unknown;
  rows?: unknown;
}

export interface LegacyRecipeDedupPlanMember {
  sku: string;
  asin: string;
  draft_id: string;
  draft_name: string;
  draft_status: string;
  generation_job_id: string;
  master_bundle_id: string;
  channel_sku_id: string;
  published_at: string | null;
}

export interface LegacyRecipeDedupReservation {
  recipe_alias_fingerprint: string;
  composition_signature: string;
  identity: RecipeAliasIdentity;
  canonical: LegacyRecipeDedupPlanMember & {
    selection_reason: "EARLIEST_LIVE_PUBLICATION_THEN_DRAFT_ID";
  };
  duplicate_siblings: LegacyRecipeDedupPlanMember[];
  recommended_update: {
    entity: "BundleDraft";
    id: string;
    field: "recipe_fingerprint";
    expected_current_value: null;
    desired_value: string;
  };
}

export interface LegacyRecipeDedupPlan {
  schema_version: typeof LEGACY_RECIPE_DEDUP_PLAN_SCHEMA;
  immutable: true;
  read_only: true;
  external_mutations: false;
  plan_id: string;
  created_at: string;
  source_ledger: {
    path: string;
    schema_version: string;
    audit_id: string;
    sha256: string;
    bytes: number;
  };
  expectations: {
    live_rows: number | null;
    unique_recipes: number | null;
    duplicate_groups: number | null;
  };
  summary: {
    ledger_rows: number;
    live_rows: number;
    unique_recipes: number;
    duplicate_groups: number;
    duplicate_rows: number;
    duplicate_siblings: number;
    canonical_reservations: number;
    proposed_field_updates: number;
    apply_authorized: false;
    blockers: number;
  };
  policy: {
    recipe_identity: typeof LEGACY_RECIPE_ALIAS_SCHEMA;
    canonical_selection: "EARLIEST_LIVE_PUBLICATION_THEN_DRAFT_ID";
    canonical_action: "RESERVE_EXACT_ALIAS_FINGERPRINT";
    duplicate_sibling_action: "KEEP_EXPLICIT_AND_LEAVE_FINGERPRINT_NULL";
    live_listing_action: "PRESERVE_ALL_EXISTING_SKUS_AND_ASINS";
    destructive_actions: false;
  };
  apply_gate: {
    authorized: false;
    reason: string;
    required_future_guards: string[];
  };
  reservations: LegacyRecipeDedupReservation[];
  duplicate_pairs: Array<{
    recipe_alias_fingerprint: string;
    composition_signature: string;
    canonical: LegacyRecipeDedupPlanMember;
    duplicate_sibling: LegacyRecipeDedupPlanMember;
    recommendation: "PRESERVE_BOTH_LISTINGS_RESERVE_CANONICAL_ONLY";
  }>;
  blockers: string[];
  sha256: string;
}

function record(value: unknown): UnknownRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function requiredPositiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function nullableIso(value: unknown, label: string): string | null {
  if (value == null || value === "") return null;
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error(`${label} is invalid.`);
    return value.toISOString();
  }
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO date or null.`);
  }
  return new Date(value).toISOString();
}

export function normalizeRecipeAliasText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

function normalizedComponents(
  components: RecipeAliasComponentInput[],
  unitCount: number,
): RecipeAliasIdentity["components"] {
  if (!Array.isArray(components) || components.length === 0) {
    throw new Error("recipe components must be a non-empty array.");
  }
  const normalized = components.map((component, index) => ({
    product_name: normalizeRecipeAliasText(
      requiredString(component?.product_name, `components[${index}].product_name`),
    ),
    qty: requiredPositiveInteger(component?.qty, `components[${index}].qty`),
  }));
  const identities = new Set<string>();
  for (const component of normalized) {
    if (identities.has(component.product_name)) {
      throw new Error(
        `recipe contains duplicate component identity "${component.product_name}"; ` +
          "aggregate it before deduplication.",
      );
    }
    identities.add(component.product_name);
  }
  const sum = normalized.reduce((total, component) => total + component.qty, 0);
  if (sum !== unitCount) {
    throw new Error(`recipe component quantity sum ${sum} does not equal unit_count ${unitCount}.`);
  }
  return normalized.sort((left, right) =>
    left.product_name.localeCompare(right.product_name) || left.qty - right.qty,
  );
}

export function buildRecipeAliasIdentity(input: RecipeAliasInput): RecipeAliasIdentity {
  const unitCount = requiredPositiveInteger(input.unit_count, "unit_count");
  return {
    schema_version: LEGACY_RECIPE_ALIAS_SCHEMA,
    brand: normalizeRecipeAliasText(requiredString(input.brand, "brand")),
    composition_type: requiredString(
      input.composition_type,
      "composition_type",
    ).toUpperCase(),
    unit_count: unitCount,
    components: normalizedComponents(input.components, unitCount),
  };
}

export function stableLegacyRecipeJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableLegacyRecipeJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const row = value as UnknownRecord;
    return `{${Object.keys(row)
      .sort()
      .filter((key) => row[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableLegacyRecipeJson(row[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function legacyRecipeSha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function legacyRecipeAliasFingerprint(input: RecipeAliasInput): string {
  return legacyRecipeSha256(stableLegacyRecipeJson(buildRecipeAliasIdentity(input)));
}

export function recipeCompositionSignature(input: RecipeAliasInput): string {
  return buildRecipeAliasIdentity(input).components
    .map((component) => `${component.product_name}:${component.qty}`)
    .join("|");
}

function parseJsonArray(value: string | unknown[], label: string): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") throw new Error(`${label} must be JSON array text.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${label} must decode to an array.`);
  return parsed;
}

function componentsFromUnknown(value: unknown[], label: string): RecipeAliasComponentInput[] {
  return value.map((item, index) => {
    const component = record(item);
    if (!component) throw new Error(`${label}[${index}] must be an object.`);
    return {
      product_name: requiredString(
        component.product_name,
        `${label}[${index}].product_name`,
      ),
      qty: requiredPositiveInteger(component.qty, `${label}[${index}].qty`),
    };
  });
}

function selectedVariantComponents(candidate: LegacyRecipeDraftCandidate): unknown[] | null {
  const matrix = candidate.variation_matrix;
  if (!matrix || matrix.selected_variant_idx == null) return null;
  if (!Number.isInteger(matrix.selected_variant_idx) || matrix.selected_variant_idx < 0) {
    throw new Error(`${candidate.id}.variation_matrix.selected_variant_idx is invalid.`);
  }
  const variants = parseJsonArray(
    matrix.variants_json,
    `${candidate.id}.variation_matrix.variants_json`,
  );
  const selected =
    variants.find(
      (value) => Number(record(value)?.idx) === matrix.selected_variant_idx,
    ) ??
    variants[matrix.selected_variant_idx];
  const selectedRecord = record(selected);
  if (!selectedRecord) {
    throw new Error(`${candidate.id} selected variation is missing.`);
  }
  if (!Array.isArray(selectedRecord.composition) || selectedRecord.composition.length === 0) {
    throw new Error(`${candidate.id} selected variation has no composition.`);
  }
  return selectedRecord.composition;
}

export function legacyDraftRecipeAliasInput(
  candidate: LegacyRecipeDraftCandidate,
): RecipeAliasInput {
  requiredString(candidate.id, "candidate.id");
  requiredString(candidate.generation_job_id, `${candidate.id}.generation_job_id`);
  const selected = selectedVariantComponents(candidate);
  const rawComponents =
    selected ?? parseJsonArray(candidate.draft_components, `${candidate.id}.draft_components`);
  return {
    brand: requiredString(candidate.brand, `${candidate.id}.brand`),
    composition_type: requiredString(
      candidate.composition_type,
      `${candidate.id}.composition_type`,
    ),
    unit_count: requiredPositiveInteger(candidate.pack_count, `${candidate.id}.pack_count`),
    components: componentsFromUnknown(rawComponents, `${candidate.id}.components`),
  };
}

function candidateTime(candidate: LegacyRecipeDraftCandidate): number {
  if (candidate.created_at == null) return Number.POSITIVE_INFINITY;
  const iso = nullableIso(candidate.created_at, `${candidate.id}.created_at`);
  return iso == null ? Number.POSITIVE_INFINITY : Date.parse(iso);
}

/**
 * Compare a proposed exact product recipe with coarse legacy candidates. Any
 * unreadable candidate blocks creation: silently skipping a malformed old row
 * could mint a duplicate ASIN. The caller should cap the coarse query and pass
 * `candidateLimit + 1` rows so an unexpectedly large cohort also fails closed.
 */
export function resolveLegacyRecipeAlias(
  desired: RecipeAliasInput,
  candidates: LegacyRecipeDraftCandidate[],
  candidateLimit = 500,
): LegacyRecipeAliasResolution {
  const desiredFingerprint = legacyRecipeAliasFingerprint(desired);
  const blockers: string[] = [];
  if (candidates.length > candidateLimit) {
    blockers.push(
      `Legacy candidate query exceeded the reviewed limit ${candidateLimit}; got at least ${candidates.length}.`,
    );
  }
  const seenIds = new Set<string>();
  const matches: LegacyRecipeDraftCandidate[] = [];
  for (const candidate of candidates.slice(0, candidateLimit)) {
    if (seenIds.has(candidate.id)) {
      blockers.push(`Legacy candidate ${candidate.id} was returned more than once.`);
      continue;
    }
    seenIds.add(candidate.id);
    try {
      candidateTime(candidate);
      if (legacyRecipeAliasFingerprint(legacyDraftRecipeAliasInput(candidate)) === desiredFingerprint) {
        matches.push(candidate);
      }
    } catch (error) {
      blockers.push(
        `${candidate.id || "unknown legacy draft"}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  if (blockers.length) {
    return {
      status: "BLOCKED",
      recipe_alias_fingerprint: desiredFingerprint,
      canonical: null,
      duplicate_siblings: [],
      blockers: [...new Set(blockers)].sort(),
    };
  }
  if (!matches.length) {
    return {
      status: "CLEAR",
      recipe_alias_fingerprint: desiredFingerprint,
      canonical: null,
      duplicate_siblings: [],
      blockers: [],
    };
  }
  matches.sort((left, right) => {
    const leftReserved = left.recipe_fingerprint === desiredFingerprint ? 0 : 1;
    const rightReserved = right.recipe_fingerprint === desiredFingerprint ? 0 : 1;
    return (
      leftReserved - rightReserved ||
      candidateTime(left) - candidateTime(right) ||
      left.id.localeCompare(right.id)
    );
  });
  return {
    status: "MATCH",
    recipe_alias_fingerprint: desiredFingerprint,
    canonical: matches[0],
    duplicate_siblings: matches.slice(1),
    blockers: [],
  };
}

function ledgerMember(row: UnknownRecord, index: number): {
  member: LegacyRecipeDedupPlanMember;
  composition_signature: string;
  identity: RecipeAliasIdentity;
  recipe_alias_fingerprint: string;
} {
  const label = `rows[${index}]`;
  const live = record(row.live);
  const db = record(row.db);
  const draft = record(db?.draft);
  const master = record(db?.master);
  const channelSku = record(db?.channel_sku);
  const canonical = record(row.canonical);
  if (live?.fetched !== true) throw new Error(`${label} is not a live fetched row.`);
  const sku = requiredString(row.sku, `${label}.sku`);
  const asin = requiredString(row.asin, `${label}.asin`);
  if (requiredString(live.asin, `${label}.live.asin`) !== asin) {
    throw new Error(`${sku}: row ASIN differs from the live ASIN.`);
  }
  const componentsRaw = canonical?.components;
  if (!Array.isArray(componentsRaw)) throw new Error(`${sku}: canonical.components is missing.`);
  // recipe_fingerprint belongs to BundleDraft, so its unit count must come
  // from that draft rather than a potentially stale linked MasterBundle. The
  // selected canonical component sum must independently prove the same count.
  const draftPackCount = requiredPositiveInteger(
    draft?.pack_count,
    `${sku}.draft.pack_count`,
  );
  const input: RecipeAliasInput = {
    brand: requiredString(draft?.brand, `${sku}.draft.brand`),
    composition_type: requiredString(
      draft?.composition_type,
      `${sku}.draft.composition_type`,
    ),
    unit_count: draftPackCount,
    components: componentsFromUnknown(componentsRaw, `${sku}.canonical.components`),
  };
  const identity = buildRecipeAliasIdentity(input);
  const compositionSignature = recipeCompositionSignature(input);
  if (
    requiredString(
      canonical?.composition_signature,
      `${sku}.canonical.composition_signature`,
    ) !== compositionSignature
  ) {
    throw new Error(`${sku}: sealed composition signature does not match its components.`);
  }
  if (canonical?.component_qty_sum !== identity.unit_count) {
    throw new Error(`${sku}: canonical component sum does not equal BundleDraft.pack_count.`);
  }
  return {
    member: {
      sku,
      asin,
      draft_id: requiredString(draft?.id, `${sku}.draft.id`),
      draft_name: requiredString(draft?.name, `${sku}.draft.name`),
      draft_status: requiredString(draft?.status, `${sku}.draft.status`),
      generation_job_id: requiredString(
        draft?.generation_job_id,
        `${sku}.draft.generation_job_id`,
      ),
      master_bundle_id: requiredString(master?.id, `${sku}.master.id`),
      channel_sku_id: requiredString(channelSku?.id, `${sku}.channel_sku.id`),
      published_at: nullableIso(channelSku?.published_at, `${sku}.published_at`),
    },
    composition_signature: compositionSignature,
    identity,
    recipe_alias_fingerprint: legacyRecipeSha256(stableLegacyRecipeJson(identity)),
  };
}

function compareCanonicalMembers(
  left: LegacyRecipeDedupPlanMember,
  right: LegacyRecipeDedupPlanMember,
): number {
  const leftTime = left.published_at == null ? Number.POSITIVE_INFINITY : Date.parse(left.published_at);
  const rightTime = right.published_at == null ? Number.POSITIVE_INFINITY : Date.parse(right.published_at);
  return leftTime - rightTime || left.draft_id.localeCompare(right.draft_id);
}

function assertUnique(label: string, values: string[]): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} contains duplicates.`);
  }
}

export function buildLegacyRecipeDedupPlan(input: {
  ledger: LegacyRecipeDedupLedgerLike;
  ledgerBytes: Buffer;
  ledgerPath: string;
  expectedLedgerSha256?: string;
  expectedLiveRows?: number;
  expectedUniqueRecipes?: number;
  expectedDuplicateGroups?: number;
}): LegacyRecipeDedupPlan {
  const ledgerSha = legacyRecipeSha256(input.ledgerBytes);
  if (input.expectedLedgerSha256 && input.expectedLedgerSha256 !== ledgerSha) {
    throw new Error(
      `Ledger SHA-256 mismatch: expected ${input.expectedLedgerSha256}, got ${ledgerSha}.`,
    );
  }
  const ledger = input.ledger;
  if (
    ledger.complete !== true ||
    ledger.immutable !== true ||
    ledger.external_mutations !== false
  ) {
    throw new Error(
      "Legacy dedup planning requires complete=true, immutable=true, external_mutations=false.",
    );
  }
  const schemaVersion = requiredString(ledger.schema_version, "ledger.schema_version");
  if (!schemaVersion.startsWith("uncrustables-ledger/")) {
    throw new Error(`Unsupported ledger schema ${schemaVersion}.`);
  }
  const auditId = requiredString(ledger.audit_id, "ledger.audit_id");
  const createdAt = nullableIso(ledger.completed_at, "ledger.completed_at");
  if (!createdAt) throw new Error("ledger.completed_at is required.");
  if (!Array.isArray(ledger.rows)) throw new Error("ledger.rows must be an array.");

  const parsedRows = (ledger.rows as unknown[]).map((value, index) => {
    const row = record(value);
    if (!row) throw new Error(`rows[${index}] must be an object.`);
    const live = record(row.live);
    if (!live || typeof live.fetched !== "boolean") {
      throw new Error(`rows[${index}].live.fetched must be boolean.`);
    }
    return row;
  });
  const liveRows = parsedRows
    .filter((row) => record(row.live)?.fetched === true)
    .map(ledgerMember);
  assertUnique("live SKU set", liveRows.map((row) => row.member.sku));
  assertUnique("live ASIN set", liveRows.map((row) => row.member.asin));
  assertUnique("live draft set", liveRows.map((row) => row.member.draft_id));
  assertUnique("live master set", liveRows.map((row) => row.member.master_bundle_id));
  assertUnique("live ChannelSKU set", liveRows.map((row) => row.member.channel_sku_id));

  const groups = new Map<string, typeof liveRows>();
  for (const row of liveRows) {
    const existing = groups.get(row.composition_signature) ?? [];
    existing.push(row);
    groups.set(row.composition_signature, existing);
  }
  const reservations: LegacyRecipeDedupReservation[] = [];
  for (const [signature, members] of groups) {
    const fingerprints = new Set(members.map((row) => row.recipe_alias_fingerprint));
    if (fingerprints.size !== 1) {
      throw new Error(`Composition signature ${signature} maps to multiple alias fingerprints.`);
    }
    const identities = new Set(members.map((row) => stableLegacyRecipeJson(row.identity)));
    if (identities.size !== 1) {
      throw new Error(`Composition signature ${signature} maps to multiple recipe identities.`);
    }
    const sorted = members.map((row) => row.member).sort(compareCanonicalMembers);
    const fingerprint = members[0].recipe_alias_fingerprint;
    reservations.push({
      recipe_alias_fingerprint: fingerprint,
      composition_signature: signature,
      identity: members[0].identity,
      canonical: {
        ...sorted[0],
        selection_reason: "EARLIEST_LIVE_PUBLICATION_THEN_DRAFT_ID",
      },
      duplicate_siblings: sorted.slice(1),
      recommended_update: {
        entity: "BundleDraft",
        id: sorted[0].draft_id,
        field: "recipe_fingerprint",
        expected_current_value: null,
        desired_value: fingerprint,
      },
    });
  }
  reservations.sort((left, right) =>
    left.composition_signature.localeCompare(right.composition_signature),
  );
  assertUnique(
    "recipe alias fingerprints",
    reservations.map((reservation) => reservation.recipe_alias_fingerprint),
  );

  const duplicateGroups = reservations.filter(
    (reservation) => reservation.duplicate_siblings.length > 0,
  );
  const duplicateRows = duplicateGroups.reduce(
    (total, reservation) => total + 1 + reservation.duplicate_siblings.length,
    0,
  );
  const duplicateSiblings = duplicateGroups.reduce(
    (total, reservation) => total + reservation.duplicate_siblings.length,
    0,
  );
  const assertExpected = (label: string, expected: number | undefined, actual: number) => {
    if (expected != null && expected !== actual) {
      throw new Error(`${label} expectation failed: expected ${expected}, got ${actual}.`);
    }
  };
  assertExpected("live_rows", input.expectedLiveRows, liveRows.length);
  assertExpected("unique_recipes", input.expectedUniqueRecipes, reservations.length);
  assertExpected("duplicate_groups", input.expectedDuplicateGroups, duplicateGroups.length);

  const duplicatePairs = duplicateGroups.flatMap((reservation) =>
    reservation.duplicate_siblings.map((sibling) => ({
      recipe_alias_fingerprint: reservation.recipe_alias_fingerprint,
      composition_signature: reservation.composition_signature,
      canonical: {
        sku: reservation.canonical.sku,
        asin: reservation.canonical.asin,
        draft_id: reservation.canonical.draft_id,
        draft_name: reservation.canonical.draft_name,
        draft_status: reservation.canonical.draft_status,
        generation_job_id: reservation.canonical.generation_job_id,
        master_bundle_id: reservation.canonical.master_bundle_id,
        channel_sku_id: reservation.canonical.channel_sku_id,
        published_at: reservation.canonical.published_at,
      },
      duplicate_sibling: sibling,
      recommendation: "PRESERVE_BOTH_LISTINGS_RESERVE_CANONICAL_ONLY" as const,
    })),
  );

  const body: Omit<LegacyRecipeDedupPlan, "sha256"> = {
    schema_version: LEGACY_RECIPE_DEDUP_PLAN_SCHEMA,
    immutable: true,
    read_only: true,
    external_mutations: false,
    plan_id: `LRDP-${auditId}-${ledgerSha.slice(0, 12)}`,
    created_at: createdAt,
    source_ledger: {
      path: input.ledgerPath,
      schema_version: schemaVersion,
      audit_id: auditId,
      sha256: ledgerSha,
      bytes: input.ledgerBytes.length,
    },
    expectations: {
      live_rows: input.expectedLiveRows ?? null,
      unique_recipes: input.expectedUniqueRecipes ?? null,
      duplicate_groups: input.expectedDuplicateGroups ?? null,
    },
    summary: {
      ledger_rows: ledger.rows.length,
      live_rows: liveRows.length,
      unique_recipes: reservations.length,
      duplicate_groups: duplicateGroups.length,
      duplicate_rows: duplicateRows,
      duplicate_siblings: duplicateSiblings,
      canonical_reservations: reservations.length,
      proposed_field_updates: reservations.length,
      apply_authorized: false,
      blockers: 0,
    },
    policy: {
      recipe_identity: LEGACY_RECIPE_ALIAS_SCHEMA,
      canonical_selection: "EARLIEST_LIVE_PUBLICATION_THEN_DRAFT_ID",
      canonical_action: "RESERVE_EXACT_ALIAS_FINGERPRINT",
      duplicate_sibling_action: "KEEP_EXPLICIT_AND_LEAVE_FINGERPRINT_NULL",
      live_listing_action: "PRESERVE_ALL_EXISTING_SKUS_AND_ASINS",
      destructive_actions: false,
    },
    apply_gate: {
      authorized: false,
      reason:
        "The ledger does not seal BundleDraft.recipe_fingerprint, updated_at, or the raw selected-variation bytes. This artifact is an exact read-only recommendation, not write authority.",
      required_future_guards: [
        "Fetch all planned BundleDraft rows and selected VariationMatrix rows in one fresh read-only snapshot.",
        "Require every canonical recipe_fingerprint to be NULL and every duplicate sibling to remain explicit.",
        "Recompute each recipe alias fingerprint from the selected variation, falling back to draft_components only when no variation is selected.",
        "Seal full-row optimistic digests and the unique-index definition before any transaction.",
        "In one transaction update exactly one canonical draft per recipe, re-read all guarded rows, and roll back on any count or digest drift.",
        "Never delete, merge, unpublish, relink, or alter a BundleDraft, MasterBundle, ChannelSKU, SKU, UPC, or ASIN.",
      ],
    },
    reservations,
    duplicate_pairs: duplicatePairs,
    blockers: [],
  };
  return { ...body, sha256: legacyRecipeSha256(stableLegacyRecipeJson(body)) };
}

export function verifyLegacyRecipeDedupPlan(plan: LegacyRecipeDedupPlan): void {
  if (
    plan.schema_version !== LEGACY_RECIPE_DEDUP_PLAN_SCHEMA ||
    plan.immutable !== true ||
    plan.read_only !== true ||
    plan.external_mutations !== false ||
    plan.apply_gate.authorized !== false ||
    plan.summary.apply_authorized !== false ||
    plan.policy.destructive_actions !== false ||
    plan.policy.recipe_identity !== LEGACY_RECIPE_ALIAS_SCHEMA ||
    plan.policy.canonical_selection !== "EARLIEST_LIVE_PUBLICATION_THEN_DRAFT_ID" ||
    plan.policy.canonical_action !== "RESERVE_EXACT_ALIAS_FINGERPRINT" ||
    plan.policy.duplicate_sibling_action !==
      "KEEP_EXPLICIT_AND_LEAVE_FINGERPRINT_NULL" ||
    plan.policy.live_listing_action !== "PRESERVE_ALL_EXISTING_SKUS_AND_ASINS"
  ) {
    throw new Error("Legacy recipe dedup plan safety envelope is invalid.");
  }
  if (
    !/^[a-f0-9]{64}$/.test(plan.sha256) ||
    !/^[a-f0-9]{64}$/.test(plan.source_ledger.sha256) ||
    !Number.isInteger(plan.source_ledger.bytes) ||
    plan.source_ledger.bytes <= 0 ||
    !plan.apply_gate.reason.trim() ||
    plan.apply_gate.required_future_guards.length < 1
  ) {
    throw new Error("Legacy recipe dedup plan seal metadata is invalid.");
  }
  const body = { ...plan } as UnknownRecord;
  delete body.sha256;
  if (legacyRecipeSha256(stableLegacyRecipeJson(body)) !== plan.sha256) {
    throw new Error("Legacy recipe dedup plan SHA-256 is invalid.");
  }
  assertUnique(
    "plan recipe alias fingerprints",
    plan.reservations.map((reservation) => reservation.recipe_alias_fingerprint),
  );
  const memberIds: string[] = [];
  const memberSkus: string[] = [];
  const memberAsins: string[] = [];
  const memberMasters: string[] = [];
  const memberChannelSkus: string[] = [];
  let duplicateGroups = 0;
  let duplicateRows = 0;
  let duplicateSiblings = 0;
  const expectedPairKeys = new Set<string>();
  for (const reservation of plan.reservations) {
    const recomputed = legacyRecipeSha256(stableLegacyRecipeJson(reservation.identity));
    const identityInput: RecipeAliasInput = {
      brand: reservation.identity.brand,
      composition_type: reservation.identity.composition_type,
      unit_count: reservation.identity.unit_count,
      components: reservation.identity.components,
    };
    if (
      recomputed !== reservation.recipe_alias_fingerprint ||
      recipeCompositionSignature(identityInput) !== reservation.composition_signature ||
      reservation.canonical.selection_reason !==
        "EARLIEST_LIVE_PUBLICATION_THEN_DRAFT_ID" ||
      reservation.recommended_update.entity !== "BundleDraft" ||
      reservation.recommended_update.field !== "recipe_fingerprint" ||
      reservation.recommended_update.id !== reservation.canonical.draft_id ||
      reservation.recommended_update.desired_value !== reservation.recipe_alias_fingerprint ||
      reservation.recommended_update.expected_current_value !== null
    ) {
      throw new Error(`Reservation ${reservation.recipe_alias_fingerprint} is inconsistent.`);
    }
    const members: LegacyRecipeDedupPlanMember[] = [
      reservation.canonical,
      ...reservation.duplicate_siblings,
    ];
    if (reservation.duplicate_siblings.length) {
      duplicateGroups += 1;
      duplicateRows += members.length;
      duplicateSiblings += reservation.duplicate_siblings.length;
    }
    for (const member of members) {
      for (const [label, value] of Object.entries({
        sku: member.sku,
        asin: member.asin,
        draft_id: member.draft_id,
        draft_name: member.draft_name,
        draft_status: member.draft_status,
        generation_job_id: member.generation_job_id,
        master_bundle_id: member.master_bundle_id,
        channel_sku_id: member.channel_sku_id,
      })) {
        requiredString(value, `${reservation.recipe_alias_fingerprint}.${label}`);
      }
      nullableIso(member.published_at, `${member.sku}.published_at`);
      memberIds.push(member.draft_id);
      memberSkus.push(member.sku);
      memberAsins.push(member.asin);
      memberMasters.push(member.master_bundle_id);
      memberChannelSkus.push(member.channel_sku_id);
    }
    for (const sibling of reservation.duplicate_siblings) {
      expectedPairKeys.add(
        `${reservation.recipe_alias_fingerprint}\u0000${sibling.draft_id}`,
      );
    }
  }
  assertUnique("plan draft membership", memberIds);
  assertUnique("plan SKU membership", memberSkus);
  assertUnique("plan ASIN membership", memberAsins);
  assertUnique("plan MasterBundle membership", memberMasters);
  assertUnique("plan ChannelSKU membership", memberChannelSkus);

  const actualPairKeys = plan.duplicate_pairs.map((pair) => {
    if (pair.recommendation !== "PRESERVE_BOTH_LISTINGS_RESERVE_CANONICAL_ONLY") {
      throw new Error("Legacy duplicate pair has an unsafe recommendation.");
    }
    const reservation = plan.reservations.find(
      (entry) => entry.recipe_alias_fingerprint === pair.recipe_alias_fingerprint,
    );
    if (
      !reservation ||
      pair.composition_signature !== reservation.composition_signature ||
      stableLegacyRecipeJson(pair.canonical) !==
        stableLegacyRecipeJson({
          sku: reservation.canonical.sku,
          asin: reservation.canonical.asin,
          draft_id: reservation.canonical.draft_id,
          draft_name: reservation.canonical.draft_name,
          draft_status: reservation.canonical.draft_status,
          generation_job_id: reservation.canonical.generation_job_id,
          master_bundle_id: reservation.canonical.master_bundle_id,
          channel_sku_id: reservation.canonical.channel_sku_id,
          published_at: reservation.canonical.published_at,
        }) ||
      !reservation.duplicate_siblings.some(
        (sibling) =>
          stableLegacyRecipeJson(sibling) === stableLegacyRecipeJson(pair.duplicate_sibling),
      )
    ) {
      throw new Error("Legacy duplicate pair does not match its reservation.");
    }
    return `${pair.recipe_alias_fingerprint}\u0000${pair.duplicate_sibling.draft_id}`;
  });
  assertUnique("plan duplicate pairs", actualPairKeys);
  if (
    actualPairKeys.length !== expectedPairKeys.size ||
    actualPairKeys.some((key) => !expectedPairKeys.has(key))
  ) {
    throw new Error("Legacy duplicate pair coverage is incomplete.");
  }

  if (
    plan.summary.ledger_rows < memberIds.length ||
    plan.summary.live_rows !== memberIds.length ||
    plan.summary.unique_recipes !== plan.reservations.length ||
    plan.summary.duplicate_groups !== duplicateGroups ||
    plan.summary.duplicate_rows !== duplicateRows ||
    plan.summary.duplicate_siblings !== duplicateSiblings ||
    plan.summary.duplicate_siblings !== plan.duplicate_pairs.length ||
    plan.summary.canonical_reservations !== plan.reservations.length ||
    plan.summary.proposed_field_updates !== plan.reservations.length ||
    plan.summary.blockers !== plan.blockers.length ||
    (plan.expectations.live_rows != null &&
      plan.expectations.live_rows !== plan.summary.live_rows) ||
    (plan.expectations.unique_recipes != null &&
      plan.expectations.unique_recipes !== plan.summary.unique_recipes) ||
    (plan.expectations.duplicate_groups != null &&
      plan.expectations.duplicate_groups !== plan.summary.duplicate_groups)
  ) {
    throw new Error("Legacy recipe dedup plan summary does not match its entries.");
  }
}
