import {
  assertBaseOfferPreservePlan,
  assertBaseOfferPreserveSelection,
  sha256,
  stableJson,
  type BaseOfferPreservePlan,
  type BaseOfferPreserveSelection,
} from "./uncrustables-base-offer-preserve";

export const SAFE_BASE_OFFER_CHANNELMAX_MANUAL_SCHEMA =
  "uncrustables-channelmax-safe-base-offer-manual-assignment/v1" as const;

export const SAFE_BASE_OFFER_CHANNELMAX_MODEL = {
  id: "59021",
  name: "Manual min/max",
} as const;

export const SAFE_BASE_OFFER_CHANNELMAX_COLUMNS = [
  "SKU",
  "ASIN",
  "SellingVenue",
  "MinSellingPrice",
  "MaxSellingPrice",
  "RepricingModelID",
] as const;

export const SAFE_BASE_OFFER_IDENTITY_HOLDS = [
  "SZ-ASPI-JFAT",
  "TY-AST2-JE9P",
  "VN-AS1A-D572",
] as const;

export const SAFE_BASE_OFFER_CHANNELMAX_PINNED_SOURCES = {
  plan: {
    path:
      "data/repairs/base-offer-preserve/" +
      "uncrustables-base-offer-preserve-20260719-v3/base-offer-preserve-plan.json",
    file_sha256:
      "0157e88f64af71a033b3ac25fd24272f927e88346fe475b2a32092c5798ffa36",
  },
  full_selection: {
    path:
      "data/repairs/base-offer-preserve/" +
      "uncrustables-base-offer-preserve-20260719-v3/base-offer-preserve-selection.json",
    file_sha256:
      "38244eb283d54df5e593a7ef609d459f012c755b1af802277562615beaf3c56d",
  },
  price_matrix: {
    path:
      "data/audits/uncrustables-fresh-amazon-price-matrix-20260719-v2/" +
      "uncrustables-fresh-amazon-price-matrix-20260719-v2.json",
    file_sha256:
      "572abc5428750408da6f776db6c73821372e789da1ee32d8aa05b267082b189a",
  },
  channelmax_prewrite: {
    path:
      "data/repairs/rollback/" +
      "channelmax-canonical-164-20260719T024515583Z-6a2e9b3211b4/prewrite.json",
    file_sha256:
      "ad5481a12b1543f5508e37723844f0c78077d8991d3cb24d49818fc6a4f31da7",
  },
  channelmax_postwrite: {
    path:
      "data/repairs/rollback/" +
      "channelmax-canonical-164-20260719T024515583Z-6a2e9b3211b4/postwrite.json",
    file_sha256:
      "94a4da2aad82caba9d127bd19fdf61490ff992b6e934ec8b38fd26dc94de6bc2",
  },
  manual_model_discovery: {
    path: "data/audits/channelmax-manual-model-discovery-20260718T220023Z.json",
    file_sha256:
      "14124ed5f78d1d407911f02f2844da0ffdf2bb8c82f8ad4c470b262ee6e31815",
  },
} as const;

type JsonObject = Record<string, unknown>;

export interface SafeBaseOfferSource<T = unknown> {
  path: string;
  bytes: Buffer;
  value: T;
}

export interface SafeBaseOfferChannelMaxRow {
  ordinal: number;
  action_id: string;
  sku: string;
  asin: string;
  base_price: number;
  minimum_selling_price: number;
  maximum_selling_price: number;
  channelmax_evidence: string;
  channelmax_confirmed_at: string;
  target_repricing_model_id: typeof SAFE_BASE_OFFER_CHANNELMAX_MODEL.id;
  target_repricing_model_name: typeof SAFE_BASE_OFFER_CHANNELMAX_MODEL.name;
}

export interface SafeBaseOfferChannelMaxManualManifest {
  schema_version: typeof SAFE_BASE_OFFER_CHANNELMAX_MANUAL_SCHEMA;
  immutable: true;
  offline_only: true;
  execution_authorized: false;
  uploaded: false;
  external_mutations: 0;
  created_at: string;
  sources: {
    plan: ArtifactBinding;
    full_selection: ArtifactBinding;
    price_matrix: ArtifactBinding;
    channelmax_prewrite: ArtifactBinding;
    channelmax_postwrite: ArtifactBinding;
    manual_model_discovery: ArtifactBinding;
  };
  account: {
    host: "selling.channelmax.net";
    seller_id: string;
    site_id: 300;
    site_name: "AmznUS [Salutem Solutions]";
    account_id: "channelmax:amznus:salutem-solutions";
  };
  scope: {
    cohort_rows: 164;
    safe_assignment_rows: 161;
    identity_hold_rows: 3;
    exact_plan_scope: true;
    exact_selection_scope: true;
    no_extra_or_missing_skus: true;
  };
  identity_holds: Array<{
    sku: (typeof SAFE_BASE_OFFER_IDENTITY_HOLDS)[number];
    amazon_asin: string;
    channelmax_asin: string;
    reason_codes: string[];
  }>;
  manual_model: {
    id: typeof SAFE_BASE_OFFER_CHANNELMAX_MODEL.id;
    name: typeof SAFE_BASE_OFFER_CHANNELMAX_MODEL.name;
    runtime_rules_must_be_verified_after_upload: ["44a", "44b"];
  };
  authorities: {
    channelmax_bounds_are_guardrails_only: true;
    base_price_writer: "AMAZON_SP_API";
    sale_price_writer: "AMAZON_SP_API";
    channelmax_repricing_must_be_skipped: true;
  };
  columns: typeof SAFE_BASE_OFFER_CHANNELMAX_COLUMNS;
  rows: SafeBaseOfferChannelMaxRow[];
  tsv_file: string;
  tsv_sha256: string;
  post_upload_gate: {
    exact_161_row_readback_required: true;
    model_id_and_name_readback_required: true;
    rule_44a_skip_repricing_required: true;
    rule_44b_skip_repricing_required: true;
    amazon_is_only_base_and_sale_price_writer: true;
    minimum_dwell_after_upload_ms: 3_900_000;
    fresh_verification_max_age_ms: 900_000;
    this_artifact_does_not_authorize_upload: true;
  };
  body_sha256: string;
}

interface ArtifactBinding {
  path: string;
  file_sha256: string;
  schema_version: string;
  body_sha256: string | null;
  captured_at: string | null;
}

export interface BuildSafeBaseOfferChannelMaxManualInput {
  plan: SafeBaseOfferSource<BaseOfferPreservePlan>;
  fullSelection: SafeBaseOfferSource<BaseOfferPreserveSelection>;
  priceMatrix: SafeBaseOfferSource;
  channelMaxPrewrite: SafeBaseOfferSource;
  channelMaxPostwrite: SafeBaseOfferSource;
  manualModelDiscovery: SafeBaseOfferSource;
  createdAt: Date;
}

function isRecord(value: unknown): value is JsonObject {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown, label: string): JsonObject {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }
  return value;
}

function canonicalInstant(value: unknown, label: string): string {
  const raw = string(value, label);
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== raw) {
    throw new Error(`${label} must be a canonical ISO timestamp.`);
  }
  return raw;
}

function exactMoney(actual: unknown, expected: number, label: string): void {
  const value = number(actual, label);
  if (Math.round(value * 100) !== Math.round(expected * 100)) {
    throw new Error(`${label} does not match the exact base-offer target.`);
  }
}

function bodySha(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const candidate = value.body_sha256 ?? value.sha256;
  return typeof candidate === "string" && /^[a-f0-9]{64}$/.test(candidate)
    ? candidate
    : null;
}

function sourceBinding(
  source: SafeBaseOfferSource,
  pinned: { path: string; file_sha256: string },
  label: string,
): ArtifactBinding {
  if (source.path !== pinned.path || sha256(source.bytes) !== pinned.file_sha256) {
    throw new Error(`${label} is not the exact pinned canonical source.`);
  }
  const parsed = JSON.parse(source.bytes.toString("utf8")) as unknown;
  if (stableJson(parsed) !== stableJson(source.value)) {
    throw new Error(`${label} object differs from its exact file bytes.`);
  }
  const value = record(source.value, label);
  return {
    path: source.path,
    file_sha256: pinned.file_sha256,
    schema_version: string(value.schema_version, `${label} schema_version`),
    body_sha256: bodySha(value),
    captured_at:
      typeof value.confirmed_at === "string"
        ? canonicalInstant(value.confirmed_at, `${label} confirmed_at`)
        : typeof value.captured_at === "string"
          ? canonicalInstant(value.captured_at, `${label} captured_at`)
          : typeof value.generated_at === "string"
            ? canonicalInstant(value.generated_at, `${label} generated_at`)
            : null,
  };
}

function uniqueBy(
  values: unknown[],
  field: string,
  label: string,
): Map<string, JsonObject> {
  const result = new Map<string, JsonObject>();
  for (const [index, raw] of values.entries()) {
    const row = record(raw, `${label}[${index}]`);
    const key = string(row[field], `${label}[${index}].${field}`);
    if (result.has(key)) throw new Error(`${label} repeats ${field} ${key}.`);
    result.set(key, row);
  }
  return result;
}

function exactStringSet(actual: string[], expected: readonly string[], label: string): void {
  if (
    stableJson([...new Set(actual)].sort()) !==
    stableJson([...expected].sort())
  ) {
    throw new Error(`${label} is not the exact required set.`);
  }
}

function assertCanonicalChannelMaxEvidence(input: {
  plan: BaseOfferPreservePlan;
  selection: BaseOfferPreserveSelection;
  matrix: JsonObject;
  prewrite: JsonObject;
  postwrite: JsonObject;
  discovery: JsonObject;
}): {
  account: SafeBaseOfferChannelMaxManualManifest["account"];
  holds: SafeBaseOfferChannelMaxManualManifest["identity_holds"];
  rows: SafeBaseOfferChannelMaxRow[];
} {
  const safeSkus = input.plan.entries.map((entry) => entry.sku);
  const holdSkus = input.plan.holds.map((hold) => hold.sku);
  exactStringSet(holdSkus, SAFE_BASE_OFFER_IDENTITY_HOLDS, "Base-offer identity holds");
  exactStringSet(
    input.selection.excluded_identity_holds,
    SAFE_BASE_OFFER_IDENTITY_HOLDS,
    "Base-offer selection identity holds",
  );
  if (safeSkus.length !== 161 || new Set(safeSkus).size !== 161) {
    throw new Error("Base-offer safe scope must contain exactly 161 unique SKUs.");
  }

  if (
    input.matrix.schema_version !== "uncrustables-fresh-amazon-price-matrix/v1" ||
    record(input.matrix.scope, "price matrix scope").output_rows !== 164 ||
    record(input.matrix.summary, "price matrix summary").channelmax == null
  ) {
    throw new Error("Fresh price matrix is not the exact 164-row canonical source.");
  }
  const matrixChannelMax = record(
    record(input.matrix.summary, "price matrix summary").channelmax,
    "price matrix ChannelMAX summary",
  );
  if (
    matrixChannelMax.canonical_confirmed_rows !== 161 ||
    matrixChannelMax.identity_hold_rows !== 3 ||
    matrixChannelMax.final_candidate_mismatches !== 0
  ) {
    throw new Error("Price matrix does not prove exact 161-row ChannelMAX canon.");
  }
  const matrixRows = uniqueBy(array(input.matrix.rows, "price matrix rows"), "sku", "price matrix rows");
  if (matrixRows.size !== 164) throw new Error("Price matrix must contain 164 unique SKUs.");

  if (
    input.prewrite.schema_version !== "channelmax-uncrustables-canonical-prewrite/v1" ||
    input.prewrite.mutation_status !== "READY_FOR_APPLY"
  ) {
    throw new Error("ChannelMAX canonical prewrite evidence is invalid.");
  }
  const preSummary = record(input.prewrite.summary, "ChannelMAX prewrite summary");
  const preAccount = record(input.prewrite.account, "ChannelMAX prewrite account");
  const preGuardrails = record(input.prewrite.guardrails, "ChannelMAX prewrite guardrails");
  if (
    preSummary.cohort_rows !== 164 ||
    preSummary.candidate_rows !== 152 ||
    preSummary.already_canonical_rows !== 9 ||
    preSummary.identity_hold_rows !== 3 ||
    preGuardrails.amazon_mutations !== 0 ||
    preGuardrails.repricing_model_payload_fields !== 0 ||
    preGuardrails.compare_and_set_before_every_wave !== true ||
    preGuardrails.independent_readback_after_every_wave !== true
  ) {
    throw new Error("ChannelMAX prewrite scope/guardrails are incomplete.");
  }

  if (input.postwrite.schema_version !== "channelmax-uncrustables-canonical-postwrite/v1") {
    throw new Error("ChannelMAX canonical postwrite schema is invalid.");
  }
  const postSummary = record(input.postwrite.summary, "ChannelMAX postwrite summary");
  if (
    postSummary.result !== "PASS" ||
    postSummary.cohort_rows !== 164 ||
    postSummary.updated_rows !== 152 ||
    postSummary.already_canonical_before !== 9 ||
    postSummary.identity_hold_rows !== 3 ||
    postSummary.final_candidate_mismatches !== 0 ||
    postSummary.amazon_mutations !== 0 ||
    postSummary.repricing_model_changes !== 0 ||
    postSummary.wave_count !== 13
  ) {
    throw new Error("ChannelMAX postwrite is not the exact canonical PASS evidence.");
  }
  const postPrewrite = record(input.postwrite.prewrite, "ChannelMAX postwrite prewrite binding");
  if (
    postPrewrite.sha256 !==
      SAFE_BASE_OFFER_CHANNELMAX_PINNED_SOURCES.channelmax_prewrite.file_sha256
  ) {
    throw new Error("ChannelMAX postwrite is not bound to the pinned prewrite bytes.");
  }
  const directRows = array(input.postwrite.waves, "ChannelMAX postwrite waves").flatMap(
    (raw, index) => array(record(raw, `ChannelMAX wave ${index + 1}`).rows, `ChannelMAX wave ${index + 1} rows`),
  );
  const directBySku = uniqueBy(directRows, "sku", "ChannelMAX direct postwrite rows");
  if (directBySku.size !== 152) {
    throw new Error("ChannelMAX postwrite must contain exactly 152 direct row readbacks.");
  }

  const preHolds = uniqueBy(
    array(input.prewrite.identity_holds, "ChannelMAX prewrite holds"),
    "sku",
    "ChannelMAX prewrite holds",
  );
  const postHolds = uniqueBy(
    array(input.postwrite.identity_holds, "ChannelMAX postwrite holds"),
    "sku",
    "ChannelMAX postwrite holds",
  );
  exactStringSet([...preHolds.keys()], SAFE_BASE_OFFER_IDENTITY_HOLDS, "ChannelMAX prewrite holds");
  exactStringSet([...postHolds.keys()], SAFE_BASE_OFFER_IDENTITY_HOLDS, "ChannelMAX postwrite holds");
  const holds = input.plan.holds.map((hold) => {
    const channelHold = postHolds.get(hold.sku);
    if (!channelHold) throw new Error(`ChannelMAX hold ${hold.sku} is missing.`);
    return {
      sku: hold.sku as (typeof SAFE_BASE_OFFER_IDENTITY_HOLDS)[number],
      amazon_asin: hold.asin,
      channelmax_asin: string(channelHold.asin, `${hold.sku} ChannelMAX hold ASIN`),
      reason_codes: [...hold.reason_codes],
    };
  });

  if (input.discovery.schema_version !== "channelmax-manual-model-discovery/v1") {
    throw new Error("ChannelMAX Manual model discovery schema is invalid.");
  }
  const observation = record(input.discovery.observation, "Manual model discovery observation");
  const discovery = record(observation.manual_model_discovery, "Manual model discovery");
  const canonicalModel = record(discovery.canonical_manual_model, "canonical Manual model");
  if (
    observation.account_id !== "channelmax:amznus:salutem-solutions" ||
    observation.expected_active_rows !== 164 ||
    observation.operation !== "DISCOVER_MANUAL_MODEL" ||
    canonicalModel.id !== SAFE_BASE_OFFER_CHANNELMAX_MODEL.id ||
    canonicalModel.name !== SAFE_BASE_OFFER_CHANNELMAX_MODEL.name ||
    discovery.selected_site_id !== "300" ||
    discovery.selected_site_name !== "AmznUS [Salutem Solutions]"
  ) {
    throw new Error("ChannelMAX Manual model 59021 discovery is not exact.");
  }

  const planBySku = new Map(input.plan.entries.map((entry) => [entry.sku, entry]));
  for (const sku of directBySku.keys()) {
    if (!planBySku.has(sku)) {
      throw new Error(`ChannelMAX postwrite contains unsafe/extra SKU ${sku}.`);
    }
  }
  const rows = input.plan.entries.map((entry) => {
    const matrixRow = matrixRows.get(entry.sku);
    if (!matrixRow) throw new Error(`Price matrix lacks safe SKU ${entry.sku}.`);
    if (matrixRow.asin !== entry.asin) {
      throw new Error(`Price matrix identity drifted for ${entry.sku}.`);
    }
    const identity = record(matrixRow.identity, `${entry.sku} identity`);
    const target = record(matrixRow.target, `${entry.sku} target`);
    const channelmax = record(matrixRow.channelmax, `${entry.sku} ChannelMAX`);
    if (
      identity.status !== "EXACT_SCOPE_MATCH" ||
      identity.amazon_asin_matches_target !== true ||
      channelmax.status !== "CANONICAL_CONFIRMED"
    ) {
      throw new Error(`${entry.sku} is not exact/canonical in the fresh matrix.`);
    }
    exactMoney(target.regular_base, entry.target.regular_base, `${entry.sku} target base`);
    exactMoney(target.minimum, entry.target.minimum, `${entry.sku} target minimum`);
    exactMoney(target.maximum, entry.target.maximum, `${entry.sku} target maximum`);
    exactMoney(channelmax.price, entry.target.regular_base, `${entry.sku} ChannelMAX base`);
    exactMoney(channelmax.minimum, entry.target.minimum, `${entry.sku} ChannelMAX minimum`);
    exactMoney(channelmax.maximum, entry.target.maximum, `${entry.sku} ChannelMAX maximum`);
    const evidence = string(channelmax.evidence, `${entry.sku} ChannelMAX evidence`);
    const confirmedAt = canonicalInstant(
      channelmax.confirmed_at,
      `${entry.sku} ChannelMAX confirmed_at`,
    );
    const direct = directBySku.get(entry.sku);
    if (evidence === "MASS_WAVE_INDEPENDENT_READBACK") {
      if (!direct || direct.asin !== entry.asin || direct.write !== "SUCCESS") {
        throw new Error(`${entry.sku} lacks its exact mass postwrite readback.`);
      }
      exactMoney(direct.price, entry.target.regular_base, `${entry.sku} postwrite base`);
      exactMoney(direct.minimum_price, entry.target.minimum, `${entry.sku} postwrite minimum`);
      exactMoney(direct.maximum_price, entry.target.maximum, `${entry.sku} postwrite maximum`);
    } else if (direct) {
      throw new Error(`${entry.sku} has conflicting direct/earlier canonical evidence.`);
    }
    return {
      ordinal: entry.ordinal,
      action_id: entry.action_id,
      sku: entry.sku,
      asin: entry.asin,
      base_price: entry.target.regular_base,
      minimum_selling_price: entry.target.minimum,
      maximum_selling_price: entry.target.maximum,
      channelmax_evidence: evidence,
      channelmax_confirmed_at: confirmedAt,
      target_repricing_model_id: SAFE_BASE_OFFER_CHANNELMAX_MODEL.id,
      target_repricing_model_name: SAFE_BASE_OFFER_CHANNELMAX_MODEL.name,
    };
  });
  exactStringSet(rows.map((row) => row.sku), safeSkus, "Manual assignment safe rows");

  if (
    preAccount.host !== "selling.channelmax.net" ||
    !/^[A-Z0-9]+$/.test(string(preAccount.seller_id, "ChannelMAX seller_id")) ||
    preAccount.site_id !== 300 ||
    preAccount.site_name !== "AmznUS [Salutem Solutions]"
  ) {
    throw new Error("ChannelMAX account/site evidence is not exact.");
  }
  return {
    account: {
      host: "selling.channelmax.net",
      seller_id: preAccount.seller_id as string,
      site_id: 300,
      site_name: "AmznUS [Salutem Solutions]",
      account_id: "channelmax:amznus:salutem-solutions",
    },
    holds,
    rows,
  };
}

function manifestBody(
  manifest: SafeBaseOfferChannelMaxManualManifest,
): Omit<SafeBaseOfferChannelMaxManualManifest, "body_sha256"> {
  const body = { ...manifest } as Partial<SafeBaseOfferChannelMaxManualManifest>;
  delete body.body_sha256;
  return body as Omit<SafeBaseOfferChannelMaxManualManifest, "body_sha256">;
}

function expectedTsv(rows: SafeBaseOfferChannelMaxRow[]): string {
  const lines = [SAFE_BASE_OFFER_CHANNELMAX_COLUMNS.join("\t")];
  for (const row of rows) {
    lines.push(
      [
        row.sku,
        row.asin,
        "AmazonUS",
        row.minimum_selling_price.toFixed(2),
        row.maximum_selling_price.toFixed(2),
        SAFE_BASE_OFFER_CHANNELMAX_MODEL.id,
      ].join("\t"),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

export function buildSafeBaseOfferChannelMaxManualAssignment(
  input: BuildSafeBaseOfferChannelMaxManualInput,
): { tsv: string; manifest: SafeBaseOfferChannelMaxManualManifest } {
  assertBaseOfferPreservePlan(input.plan.value);
  assertBaseOfferPreserveSelection(input.plan.value, input.fullSelection.value);
  if (!Number.isFinite(input.createdAt.getTime())) {
    throw new Error("Manual assignment createdAt is invalid.");
  }
  const sources = {
    plan: sourceBinding(input.plan, SAFE_BASE_OFFER_CHANNELMAX_PINNED_SOURCES.plan, "base-offer plan"),
    full_selection: sourceBinding(
      input.fullSelection,
      SAFE_BASE_OFFER_CHANNELMAX_PINNED_SOURCES.full_selection,
      "base-offer full selection",
    ),
    price_matrix: sourceBinding(
      input.priceMatrix,
      SAFE_BASE_OFFER_CHANNELMAX_PINNED_SOURCES.price_matrix,
      "fresh price matrix",
    ),
    channelmax_prewrite: sourceBinding(
      input.channelMaxPrewrite,
      SAFE_BASE_OFFER_CHANNELMAX_PINNED_SOURCES.channelmax_prewrite,
      "ChannelMAX prewrite",
    ),
    channelmax_postwrite: sourceBinding(
      input.channelMaxPostwrite,
      SAFE_BASE_OFFER_CHANNELMAX_PINNED_SOURCES.channelmax_postwrite,
      "ChannelMAX postwrite",
    ),
    manual_model_discovery: sourceBinding(
      input.manualModelDiscovery,
      SAFE_BASE_OFFER_CHANNELMAX_PINNED_SOURCES.manual_model_discovery,
      "Manual model discovery",
    ),
  };
  if (
    sources.plan.body_sha256 !== input.plan.value.body_sha256 ||
    sources.full_selection.body_sha256 !== input.fullSelection.value.body_sha256 ||
    sources.price_matrix.body_sha256 !== input.plan.value.sources.price_matrix.embedded_body_sha256 ||
    sources.channelmax_postwrite.file_sha256 !==
      input.plan.value.sources.channelmax_postwrite.file_sha256
  ) {
    throw new Error("Pinned sources are not exact bindings of FINAL base-offer v3.");
  }
  const evidence = assertCanonicalChannelMaxEvidence({
    plan: input.plan.value,
    selection: input.fullSelection.value,
    matrix: record(input.priceMatrix.value, "fresh price matrix"),
    prewrite: record(input.channelMaxPrewrite.value, "ChannelMAX prewrite"),
    postwrite: record(input.channelMaxPostwrite.value, "ChannelMAX postwrite"),
    discovery: record(input.manualModelDiscovery.value, "Manual model discovery"),
  });
  const tsv = expectedTsv(evidence.rows);
  const createdAt = input.createdAt.toISOString();
  const tsvFile = `uncrustables-channelmax-safe-manual-161-${createdAt.replace(/[-:.]/g, "")}-${sha256(tsv).slice(0, 12)}.txt`;
  const body: Omit<SafeBaseOfferChannelMaxManualManifest, "body_sha256"> = {
    schema_version: SAFE_BASE_OFFER_CHANNELMAX_MANUAL_SCHEMA,
    immutable: true,
    offline_only: true,
    execution_authorized: false,
    uploaded: false,
    external_mutations: 0,
    created_at: createdAt,
    sources,
    account: evidence.account,
    scope: {
      cohort_rows: 164,
      safe_assignment_rows: 161,
      identity_hold_rows: 3,
      exact_plan_scope: true,
      exact_selection_scope: true,
      no_extra_or_missing_skus: true,
    },
    identity_holds: evidence.holds,
    manual_model: {
      id: SAFE_BASE_OFFER_CHANNELMAX_MODEL.id,
      name: SAFE_BASE_OFFER_CHANNELMAX_MODEL.name,
      runtime_rules_must_be_verified_after_upload: ["44a", "44b"],
    },
    authorities: {
      channelmax_bounds_are_guardrails_only: true,
      base_price_writer: "AMAZON_SP_API",
      sale_price_writer: "AMAZON_SP_API",
      channelmax_repricing_must_be_skipped: true,
    },
    columns: SAFE_BASE_OFFER_CHANNELMAX_COLUMNS,
    rows: evidence.rows,
    tsv_file: tsvFile,
    tsv_sha256: sha256(tsv),
    post_upload_gate: {
      exact_161_row_readback_required: true,
      model_id_and_name_readback_required: true,
      rule_44a_skip_repricing_required: true,
      rule_44b_skip_repricing_required: true,
      amazon_is_only_base_and_sale_price_writer: true,
      minimum_dwell_after_upload_ms: 3_900_000,
      fresh_verification_max_age_ms: 900_000,
      this_artifact_does_not_authorize_upload: true,
    },
  };
  const manifest = {
    ...body,
    body_sha256: sha256(stableJson(body)),
  };
  verifySafeBaseOfferChannelMaxManualAssignment(manifest, tsv);
  return { tsv, manifest };
}

export function verifySafeBaseOfferChannelMaxManualAssignment(
  raw: unknown,
  tsv: string,
): SafeBaseOfferChannelMaxManualManifest {
  const manifest = record(raw, "safe ChannelMAX Manual manifest") as unknown as SafeBaseOfferChannelMaxManualManifest;
  if (
    manifest.schema_version !== SAFE_BASE_OFFER_CHANNELMAX_MANUAL_SCHEMA ||
    manifest.immutable !== true ||
    manifest.offline_only !== true ||
    manifest.execution_authorized !== false ||
    manifest.uploaded !== false ||
    manifest.external_mutations !== 0 ||
    manifest.scope?.cohort_rows !== 164 ||
    manifest.scope.safe_assignment_rows !== 161 ||
    manifest.scope.identity_hold_rows !== 3 ||
    !manifest.scope.exact_plan_scope ||
    !manifest.scope.exact_selection_scope ||
    !manifest.scope.no_extra_or_missing_skus ||
    manifest.rows?.length !== 161 ||
    manifest.manual_model?.id !== SAFE_BASE_OFFER_CHANNELMAX_MODEL.id ||
    manifest.manual_model.name !== SAFE_BASE_OFFER_CHANNELMAX_MODEL.name ||
    stableJson(manifest.columns) !== stableJson(SAFE_BASE_OFFER_CHANNELMAX_COLUMNS) ||
    manifest.tsv_sha256 !== sha256(tsv) ||
    manifest.body_sha256 !== sha256(stableJson(manifestBody(manifest)))
  ) {
    throw new Error("Safe ChannelMAX Manual assignment manifest is invalid or weakened.");
  }
  exactStringSet(
    manifest.identity_holds.map((hold) => hold.sku),
    SAFE_BASE_OFFER_IDENTITY_HOLDS,
    "Manual manifest identity holds",
  );
  const rowSkus = manifest.rows.map((row) => row.sku);
  if (
    new Set(rowSkus).size !== 161 ||
    rowSkus.some((sku) =>
      (SAFE_BASE_OFFER_IDENTITY_HOLDS as readonly string[]).includes(sku),
    ) ||
    manifest.rows.some(
      (row) =>
        row.target_repricing_model_id !== SAFE_BASE_OFFER_CHANNELMAX_MODEL.id ||
        row.target_repricing_model_name !== SAFE_BASE_OFFER_CHANNELMAX_MODEL.name,
    ) ||
    tsv !== expectedTsv(manifest.rows)
  ) {
    throw new Error("Safe ChannelMAX Manual TSV scope/content is invalid.");
  }
  if (
    !manifest.post_upload_gate.exact_161_row_readback_required ||
    !manifest.post_upload_gate.model_id_and_name_readback_required ||
    !manifest.post_upload_gate.rule_44a_skip_repricing_required ||
    !manifest.post_upload_gate.rule_44b_skip_repricing_required ||
    !manifest.post_upload_gate.amazon_is_only_base_and_sale_price_writer ||
    manifest.post_upload_gate.minimum_dwell_after_upload_ms !== 3_900_000 ||
    manifest.post_upload_gate.fresh_verification_max_age_ms !== 900_000 ||
    !manifest.post_upload_gate.this_artifact_does_not_authorize_upload
  ) {
    throw new Error("Safe ChannelMAX Manual post-upload gate is incomplete.");
  }
  return manifest;
}
