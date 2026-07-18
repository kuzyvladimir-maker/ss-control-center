import { createHash } from "node:crypto";

import {
  CHANNELMAX_BOUND_ACCOUNT_ID,
  CHANNELMAX_SELECTED_CHANNEL_MARKER,
} from "./browser-worker";
import { sha256Json } from "./contracts";

export const CHANNELMAX_UNCRUSTABLES_MUTATION_PREFLIGHT_SCHEMA =
  "channelmax-uncrustables-mutation-preflight/v1" as const;

export const CHANNELMAX_UNCRUSTABLES_PRODUCTION_BINDING = {
  account_id: CHANNELMAX_BOUND_ACCOUNT_ID,
  selected_site_id: "300",
  selected_site_name: CHANNELMAX_SELECTED_CHANNEL_MARKER,
  active_launch_rows: 164,
  target_rows: 162,
  manual_model: { id: "59021", name: "Manual min/max" },
  source_plan: {
    id: "URP-20260718T162541078Z",
    body_sha256:
      "2af6e0a671b7bab6c035c4693bb83867618ded7a0ac5837abea0286ed96c6010",
    file_sha256:
      "5ca0ff37abed701253a5a735b7d4ba90dc980569d1503deadb73bd1a91514bf6",
  },
  assignment_manifest: {
    file:
      "URP-20260718T162541078Z-2af6e0a671b7-channelmax.manifest.json",
    file_sha256:
      "f638512282c659b79ffe9a9d54141b7b41f079e8dadf37ecc9868e1b1af6bf23",
    body_sha256:
      "9045de19fa2331b4cccf6e0013751244ae9708f5e67863148c1edd5e9dd4dded",
  },
  assignment_tsv: {
    file: "URP-20260718T162541078Z-2af6e0a671b7-channelmax.txt",
    sha256:
      "6c10921e468a4d45201cc5cf2960800b15ff6ef263018a9ad31bb585ec902a20",
    byte_size: 7_605,
  },
  prewrite_snapshot: {
    sha256:
      "1f5f43122d35b2c422c6d1c92b6b0fc12cec8b1b4518536059250d89c1860427",
    byte_size: 77_802,
  },
  manual_model_discovery: {
    sha256:
      "14124ed5f78d1d407911f02f2844da0ffdf2bb8c82f8ad4c470b262ee6e31815",
    byte_size: 687,
  },
  excluded_rows: [
    {
      sku: "TY-AST2-JE9P",
      asin: "B0H84WQRXB",
      reason: "AMAZON_CATALOG_CONFLICT_8541",
    },
    {
      sku: "VN-AS1A-D572",
      asin: "B0H82PKK18",
      reason: "AMAZON_CATALOG_CONFLICT_8541",
    },
  ],
  live_identity_mismatch: {
    sku: "SZ-ASPI-JFAT",
    desired_asin: "B0H776M5B5",
    observed_channelmax_asin: "B0H75VN18Z",
  },
  canary: { sku: "VC-ASV1-378P", asin: "B0H786L5MW" },
} as const;

const TSV_COLUMNS = [
  "SKU",
  "ASIN",
  "SellingVenue",
  "MinSellingPrice",
  "MaxSellingPrice",
] as const;

type JsonRecord = Record<string, unknown>;
type ArtifactBytes = Buffer | Uint8Array | string;

export type ChannelMaxUncrustablesPreflightErrorCode =
  | "INVALID_ARTIFACT"
  | "ARTIFACT_HASH_MISMATCH"
  | "SOURCE_PLAN_MISMATCH"
  | "ASSIGNMENT_MANIFEST_MISMATCH"
  | "ASSIGNMENT_ROW_MISMATCH"
  | "DUPLICATE_IDENTITY"
  | "SELLING_VENUE_MISMATCH"
  | "ACCOUNT_MISMATCH"
  | "SITE_MISMATCH"
  | "MANUAL_MODEL_MISMATCH"
  | "LIVE_BASELINE_MISMATCH"
  | "EXCLUSION_MISMATCH"
  | "ROLLBACK_INCOMPLETE"
  | "MUTATION_EXECUTION_BLOCKED";

export class ChannelMaxUncrustablesPreflightError extends Error {
  constructor(
    public readonly code: ChannelMaxUncrustablesPreflightErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ChannelMaxUncrustablesPreflightError";
  }
}

export interface ChannelMaxUncrustablesMutationPreflightInput {
  sourcePlanBytes: ArtifactBytes;
  assignmentManifestBytes: ArtifactBytes;
  assignmentTsvBytes: ArtifactBytes;
  inventorySnapshotBytes: ArtifactBytes;
  manualModelDiscoveryBytes: ArtifactBytes;
}

export interface ChannelMaxUncrustablesMutationDiff {
  sku: string;
  asin: string;
  observed_channelmax_asin: string;
  identity_match: boolean;
  before: {
    model_id: string | null;
    model_name: "Default" | "Manual min/max";
    minimum_price: number;
    maximum_price: number;
  };
  desired: {
    model_id: "59021";
    model_name: "Manual min/max";
    minimum_price: number;
    maximum_price: number;
  };
  changes: {
    model: boolean;
    minimum_price: boolean;
    maximum_price: boolean;
  };
}

export interface ChannelMaxUncrustablesMutationPreflight {
  schema_version: typeof CHANNELMAX_UNCRUSTABLES_MUTATION_PREFLIGHT_SCHEMA;
  immutable: true;
  mode: "OFFLINE_FAIL_CLOSED";
  binding: {
    account_id: typeof CHANNELMAX_BOUND_ACCOUNT_ID;
    selected_site_id: "300";
    selected_site_name: typeof CHANNELMAX_SELECTED_CHANNEL_MARKER;
    manual_model: { id: "59021"; name: "Manual min/max" };
  };
  sources: {
    source_plan_file_sha256: string;
    source_plan_body_sha256: string;
    assignment_manifest_file_sha256: string;
    assignment_manifest_body_sha256: string;
    assignment_tsv_sha256: string;
    assignment_tsv_byte_size: number;
    prewrite_snapshot_sha256: string;
    prewrite_snapshot_byte_size: number;
    manual_model_discovery_sha256: string;
    manual_model_discovery_byte_size: number;
  };
  cohort: {
    live_rows: 164;
    target_rows: 162;
    excluded_rows: Array<{ sku: string; asin: string; reason: string }>;
    identity_mismatches: Array<{
      sku: string;
      desired_asin: string;
      observed_channelmax_asin: string;
    }>;
    live_model_distribution: {
      default: 162;
      manual_min_max: 2;
    };
    target_before_model_distribution: {
      default: 161;
      manual_min_max: 1;
    };
  };
  diff_summary: {
    rows: 162;
    model_changes: 161;
    bounds_changes: 162;
    identity_mismatches: 1;
    noops: 0;
  };
  diffs: ChannelMaxUncrustablesMutationDiff[];
  canary: {
    sku: "VC-ASV1-378P";
    asin: "B0H786L5MW";
    rationale: "ONLY_TARGET_ROW_ALREADY_ON_CANONICAL_MANUAL_MODEL";
    assignment_tsv: string;
    assignment_sha256: string;
    before_minimum_price: number;
    before_maximum_price: number;
    desired_minimum_price: number;
    desired_maximum_price: number;
    mutation_execution_allowed: false;
  };
  rollback: {
    prewrite_snapshot_sha256: string;
    bounds_captured_rows: 162;
    manual_model_restore_rows: 1;
    default_model_restore_rows: 161;
    default_model_restore_mechanism: null;
    default_model_restore_status: "UNPROVEN";
    exact_previous_states: Array<{
      sku: string;
      asin: string;
      model_id: string | null;
      model_name: "Default" | "Manual min/max";
      minimum_price: number;
      maximum_price: number;
    }>;
    complete: false;
  };
  required_sequence: readonly [
    "OWNER_STEP_UP_APPROVAL_BOUND_TO_ALL_HASHES",
    "ONE_ROW_CANARY",
    "VERIFY_UPLOAD_TASK_AND_EXACT_ROW_COUNTS",
    "POST_UPLOAD_CHANNELMAX_EXPORT",
    "DELAYED_AMAZON_READBACK_AND_HOLD",
    "EXPAND_TO_162_ONLY_AFTER_RECONCILED_CANARY",
  ];
  ambiguity_policy: "TERMINAL_NO_AUTOMATIC_RETRY";
  blockers: Array<{
    code:
      | "DEFAULT_MODEL_RESTORE_UNPROVEN"
      | "ROLLBACK_ARTIFACT_UNVERIFIED"
      | "CHANNELMAX_SKU_ASIN_IDENTITY_MISMATCH"
      | "FINITE_MUTATION_EXECUTOR_ABSENT"
      | "PRODUCTION_MUTATION_RELEASE_GATE_DISABLED";
    affected_rows: number;
    detail: string;
  }>;
  mutation_execution_allowed: false;
  sha256: string;
}

interface AssignmentRow {
  sku: string;
  asin: string;
  venue: "AmazonUS";
  minimum: number;
  maximum: number;
  raw: string;
}

interface SnapshotRow {
  sku: string;
  asin: string;
  modelId: string | null;
  modelName: "Default" | "Manual min/max";
  minimum: number;
  maximum: number;
}

function fail(
  code: ChannelMaxUncrustablesPreflightErrorCode,
  message: string,
): never {
  throw new ChannelMaxUncrustablesPreflightError(code, message);
}

function bytes(value: ArtifactBytes): Buffer {
  return typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
}

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function record(value: unknown, label: string): JsonRecord {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return fail("INVALID_ARTIFACT", `${label} must be an object.`);
  }
  return value as JsonRecord;
}

function parseJson(value: Buffer, label: string): JsonRecord {
  try {
    return record(JSON.parse(value.toString("utf8")), label);
  } catch (error) {
    if (error instanceof ChannelMaxUncrustablesPreflightError) throw error;
    return fail("INVALID_ARTIFACT", `${label} is not valid JSON.`);
  }
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    return fail("INVALID_ARTIFACT", `${label} must be a non-empty string.`);
  }
  return value;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    return fail("INVALID_ARTIFACT", `${label} must be an array.`);
  }
  return value;
}

function finiteMoney(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fail("INVALID_ARTIFACT", `${label} must be a positive finite number.`);
  }
  return Math.round(value * 100) / 100;
}

function assertCanonicalInstant(value: unknown, label: string): void {
  const text = string(value, label);
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== text) {
    fail("INVALID_ARTIFACT", `${label} must be a canonical UTC timestamp.`);
  }
}

function assertExactHash(
  actualBytes: Buffer,
  expectedSha256: string,
  expectedByteSize: number | null,
  label: string,
): void {
  const actualSha256 = digest(actualBytes);
  if (
    actualSha256 !== expectedSha256 ||
    (expectedByteSize != null && actualBytes.byteLength !== expectedByteSize)
  ) {
    fail(
      "ARTIFACT_HASH_MISMATCH",
      `${label} bytes do not match the pinned SHA-256/size binding.`,
    );
  }
}

function parseAssignmentTsv(tsvBytes: Buffer): AssignmentRow[] {
  const text = tsvBytes.toString("utf8");
  if (
    !text.endsWith("\r\n") ||
    text.replaceAll("\r\n", "").includes("\n") ||
    text.replaceAll("\r\n", "").includes("\r")
  ) {
    fail("INVALID_ARTIFACT", "Assignment TSV must use exact CRLF line endings.");
  }
  const lines = text.slice(0, -2).split("\r\n");
  if (lines.shift() !== TSV_COLUMNS.join("\t")) {
    fail("INVALID_ARTIFACT", "Assignment TSV header is not the exact five-column contract.");
  }
  if (lines.length !== CHANNELMAX_UNCRUSTABLES_PRODUCTION_BINDING.target_rows) {
    fail("ASSIGNMENT_ROW_MISMATCH", "Assignment TSV must contain exactly 162 rows.");
  }

  const seenSkus = new Set<string>();
  const seenAsins = new Set<string>();
  const rows = lines.map((line, index): AssignmentRow => {
    const fields = line.split("\t");
    if (fields.length !== TSV_COLUMNS.length) {
      fail("INVALID_ARTIFACT", `Assignment row ${index + 1} must have five fields.`);
    }
    const [sku, asin, venue, minimumText, maximumText] = fields as [
      string,
      string,
      string,
      string,
      string,
    ];
    if (!/^[A-Z0-9][A-Z0-9-]{5,31}$/.test(sku) || !/^[A-Z0-9]{10}$/.test(asin)) {
      fail("INVALID_ARTIFACT", `Assignment row ${index + 1} has an invalid SKU/ASIN.`);
    }
    if (seenSkus.has(sku) || seenAsins.has(asin)) {
      fail("DUPLICATE_IDENTITY", `Assignment row ${index + 1} duplicates a SKU or ASIN.`);
    }
    seenSkus.add(sku);
    seenAsins.add(asin);
    if (venue !== "AmazonUS") {
      fail("SELLING_VENUE_MISMATCH", `Assignment row ${index + 1} is not AmazonUS.`);
    }
    if (!/^(?:0|[1-9]\d*)\.\d{2}$/.test(minimumText) || !/^(?:0|[1-9]\d*)\.\d{2}$/.test(maximumText)) {
      fail("INVALID_ARTIFACT", `Assignment row ${index + 1} has non-canonical money.`);
    }
    const minimum = Number(minimumText);
    const maximum = Number(maximumText);
    if (minimum <= 0 || maximum <= 0 || minimum > maximum) {
      fail("INVALID_ARTIFACT", `Assignment row ${index + 1} has invalid bounds.`);
    }
    return { sku, asin, venue: "AmazonUS", minimum, maximum, raw: line };
  });
  const sorted = [...rows].sort((left, right) => left.sku.localeCompare(right.sku));
  if (rows.some((row, index) => row.sku !== sorted[index]?.sku)) {
    fail("ASSIGNMENT_ROW_MISMATCH", "Assignment TSV rows must be sorted by exact SKU.");
  }
  return rows;
}

function verifyPlanAndAssignment(
  plan: JsonRecord,
  manifest: JsonRecord,
  rows: AssignmentRow[],
): void {
  if (plan.schema_version !== "uncrustables-surgical-repair/v2" || plan.immutable !== true) {
    fail("SOURCE_PLAN_MISMATCH", "Source plan is not the immutable v2 repair plan.");
  }
  const { sha256: claimedPlanSha256, ...planBody } = plan;
  if (
    claimedPlanSha256 !== CHANNELMAX_UNCRUSTABLES_PRODUCTION_BINDING.source_plan.body_sha256 ||
    sha256Json(planBody) !== claimedPlanSha256 ||
    plan.plan_id !== CHANNELMAX_UNCRUSTABLES_PRODUCTION_BINDING.source_plan.id
  ) {
    fail("SOURCE_PLAN_MISMATCH", "Source plan identity or internal SHA-256 is invalid.");
  }
  const scope = record(plan.scope, "source plan scope");
  const requestedSkus = array(scope.requested_skus, "source plan requested_skus").map(
    (value, index) => string(value, `source plan requested_skus[${index}]`),
  );
  const entries = array(plan.entries, "source plan entries");
  if (
    requestedSkus.length !== rows.length ||
    entries.length !== rows.length ||
    scope.entries !== rows.length ||
    scope.blocked !== 0 ||
    array(plan.blockers, "source plan blockers").length !== 0
  ) {
    fail("SOURCE_PLAN_MISMATCH", "Source plan does not contain the exact unblocked 162-row cohort.");
  }
  if (new Set(requestedSkus).size !== requestedSkus.length) {
    fail("DUPLICATE_IDENTITY", "Source plan requested_skus contains duplicates.");
  }

  const assignmentBySku = new Map(rows.map((row) => [row.sku, row]));
  if (requestedSkus.some((sku) => !assignmentBySku.has(sku))) {
    fail("ASSIGNMENT_ROW_MISMATCH", "Assignment TSV cohort differs from source plan requested_skus.");
  }
  const planSkus = new Set<string>();
  const planAsins = new Set<string>();
  for (const [index, rawEntry] of entries.entries()) {
    const entry = record(rawEntry, `source plan entries[${index}]`);
    const sku = string(entry.sku, `source plan entries[${index}].sku`);
    const asin = string(entry.asin, `source plan entries[${index}].asin`);
    if (planSkus.has(sku) || planAsins.has(asin)) {
      fail("DUPLICATE_IDENTITY", "Source plan contains duplicate SKU/ASIN identities.");
    }
    planSkus.add(sku);
    planAsins.add(asin);
    const assignment = assignmentBySku.get(sku);
    if (!assignment || assignment.asin !== asin) {
      fail("ASSIGNMENT_ROW_MISMATCH", `Assignment identity differs from source plan for ${sku}.`);
    }
    const offers = array(entry.actions, `source plan ${sku} actions`).filter((rawAction) => {
      const action = record(rawAction, `source plan ${sku} action`);
      const desired = record(action.desired, `source plan ${sku} action desired`);
      return desired.kind === "OFFER";
    });
    if (offers.length !== 1) {
      fail("SOURCE_PLAN_MISMATCH", `Source plan must contain exactly one OFFER for ${sku}.`);
    }
    const action = record(offers[0], `source plan ${sku} OFFER`);
    const desired = record(action.desired, `source plan ${sku} OFFER desired`);
    const offer = record(desired.value, `source plan ${sku} OFFER value`);
    if (
      finiteMoney(offer.minimum_seller_allowed_price, `${sku} minimum`) !== assignment.minimum ||
      finiteMoney(offer.maximum_seller_allowed_price, `${sku} maximum`) !== assignment.maximum
    ) {
      fail("ASSIGNMENT_ROW_MISMATCH", `Assignment bounds differ from sealed OFFER for ${sku}.`);
    }
  }

  if (
    manifest.schema_version !== "uncrustables-channelmax-artifact/v1" ||
    manifest.immutable !== true ||
    manifest.uploaded !== false ||
    manifest.source_plan_id !== CHANNELMAX_UNCRUSTABLES_PRODUCTION_BINDING.source_plan.id ||
    manifest.source_plan_sha256 !== CHANNELMAX_UNCRUSTABLES_PRODUCTION_BINDING.source_plan.body_sha256 ||
    manifest.selling_venue !== "AmazonUS" ||
    JSON.stringify(manifest.columns) !== JSON.stringify(TSV_COLUMNS) ||
    manifest.rows !== rows.length ||
    manifest.tsv_file !== CHANNELMAX_UNCRUSTABLES_PRODUCTION_BINDING.assignment_tsv.file ||
    manifest.tsv_sha256 !== CHANNELMAX_UNCRUSTABLES_PRODUCTION_BINDING.assignment_tsv.sha256
  ) {
    fail("ASSIGNMENT_MANIFEST_MISMATCH", "Assignment manifest is invalid or not bound to sealed v10.");
  }
  assertCanonicalInstant(manifest.created_at, "assignment manifest created_at");
  const { sha256: claimedManifestSha256, ...manifestBody } = manifest;
  if (
    claimedManifestSha256 !==
      CHANNELMAX_UNCRUSTABLES_PRODUCTION_BINDING.assignment_manifest.body_sha256 ||
    sha256Json(manifestBody) !== claimedManifestSha256
  ) {
    fail("ASSIGNMENT_MANIFEST_MISMATCH", "Assignment manifest internal SHA-256 is invalid.");
  }
}

function parseSnapshot(snapshot: JsonRecord): SnapshotRow[] {
  if (snapshot.schema_version !== "channelmax-inventory-snapshot/v1") {
    fail("LIVE_BASELINE_MISMATCH", "Prewrite snapshot schema is unsupported.");
  }
  assertCanonicalInstant(snapshot.captured_at, "prewrite snapshot captured_at");
  if (snapshot.account_id !== CHANNELMAX_UNCRUSTABLES_PRODUCTION_BINDING.account_id) {
    fail("ACCOUNT_MISMATCH", "Prewrite snapshot belongs to a different ChannelMAX account.");
  }
  if (
    snapshot.selected_site_id !== CHANNELMAX_UNCRUSTABLES_PRODUCTION_BINDING.selected_site_id ||
    snapshot.selected_site_name !== CHANNELMAX_UNCRUSTABLES_PRODUCTION_BINDING.selected_site_name
  ) {
    fail("SITE_MISMATCH", "Prewrite snapshot belongs to a different ChannelMAX selected site.");
  }
  const query = record(snapshot.query_scope, "prewrite snapshot query_scope");
  if (
    snapshot.expected_active_rows !== CHANNELMAX_UNCRUSTABLES_PRODUCTION_BINDING.active_launch_rows ||
    snapshot.requested_include_inactive !== false ||
    query.active_skus_only !== true ||
    query.title_contains !== "Uncrustables" ||
    query.view_type !== "REPRICING" ||
    query.page !== 1 ||
    query.size !== 600
  ) {
    fail("LIVE_BASELINE_MISMATCH", "Prewrite snapshot query scope is not the exact live launch scope.");
  }
  const launchRows = array(snapshot.launch_rows, "prewrite snapshot launch_rows");
  if (launchRows.length !== CHANNELMAX_UNCRUSTABLES_PRODUCTION_BINDING.active_launch_rows) {
    fail("LIVE_BASELINE_MISMATCH", "Prewrite snapshot must contain exactly 164 launch rows.");
  }
  const seenSkus = new Set<string>();
  const seenAsins = new Set<string>();
  const parsed = launchRows.map((rawRow, index): SnapshotRow => {
    const row = record(rawRow, `prewrite snapshot launch_rows[${index}]`);
    const sku = string(row.sku, `prewrite snapshot launch_rows[${index}].sku`);
    const asin = string(row.asin, `prewrite snapshot launch_rows[${index}].asin`);
    if (seenSkus.has(sku) || seenAsins.has(asin)) {
      fail("DUPLICATE_IDENTITY", "Prewrite snapshot contains duplicate SKU/ASIN identities.");
    }
    seenSkus.add(sku);
    seenAsins.add(asin);
    const modelId = row.repricing_model_id;
    const modelName = row.repricing_model_name;
    if (
      !(
        (modelId === null && modelName === "Default") ||
        (modelId === "59021" && modelName === "Manual min/max")
      )
    ) {
      fail("LIVE_BASELINE_MISMATCH", `Unexpected repricing model on ${sku}.`);
    }
    if (row.repricing_status !== "LIVE" || row.discontinued !== false) {
      fail("LIVE_BASELINE_MISMATCH", `Snapshot row ${sku} is not active/LIVE.`);
    }
    const repriceInfo = record(row.reprice_info, `prewrite snapshot ${sku} reprice_info`);
    const minimum = finiteMoney(repriceInfo.my_floor, `${sku} observed floor`);
    const maximum = finiteMoney(repriceInfo.my_ceiling, `${sku} observed ceiling`);
    if (minimum > maximum) {
      fail("LIVE_BASELINE_MISMATCH", `Snapshot row ${sku} has inverted bounds.`);
    }
    return {
      sku,
      asin,
      modelId: modelId as string | null,
      modelName: modelName as "Default" | "Manual min/max",
      minimum,
      maximum,
    };
  });
  const defaultRows = parsed.filter((row) => row.modelId === null).length;
  const manualRows = parsed.filter((row) => row.modelId === "59021").length;
  if (defaultRows !== 162 || manualRows !== 2) {
    fail("LIVE_BASELINE_MISMATCH", "Live model distribution drifted from 162 Default / 2 Manual.");
  }
  return parsed;
}

function verifyDiscovery(discovery: JsonRecord): void {
  if (discovery.schema_version !== "channelmax-manual-model-discovery/v1") {
    fail("MANUAL_MODEL_MISMATCH", "Manual-model discovery schema is unsupported.");
  }
  assertCanonicalInstant(discovery.captured_at, "manual-model discovery captured_at");
  const observation = record(discovery.observation, "manual-model discovery observation");
  if (observation.account_id !== CHANNELMAX_UNCRUSTABLES_PRODUCTION_BINDING.account_id) {
    fail("ACCOUNT_MISMATCH", "Manual-model discovery belongs to a different account.");
  }
  if (
    observation.operation !== "DISCOVER_MANUAL_MODEL" ||
    observation.expected_active_rows !== CHANNELMAX_UNCRUSTABLES_PRODUCTION_BINDING.active_launch_rows
  ) {
    fail("MANUAL_MODEL_MISMATCH", "Manual-model discovery operation/scope is invalid.");
  }
  const found = record(observation.manual_model_discovery, "manual-model discovery result");
  if (
    found.selected_site_id !== CHANNELMAX_UNCRUSTABLES_PRODUCTION_BINDING.selected_site_id ||
    found.selected_site_name !== CHANNELMAX_UNCRUSTABLES_PRODUCTION_BINDING.selected_site_name
  ) {
    fail("SITE_MISMATCH", "Manual-model discovery belongs to a different selected site.");
  }
  const canonical = record(found.canonical_manual_model, "canonical manual model");
  const models = array(found.models, "manual-model discovery models").map((value, index) => {
    const model = record(value, `manual-model discovery models[${index}]`);
    return { id: string(model.id, `models[${index}].id`), name: string(model.name, `models[${index}].name`) };
  });
  if (
    canonical.id !== CHANNELMAX_UNCRUSTABLES_PRODUCTION_BINDING.manual_model.id ||
    canonical.name !== CHANNELMAX_UNCRUSTABLES_PRODUCTION_BINDING.manual_model.name ||
    models.filter(
      (model) =>
        model.id === CHANNELMAX_UNCRUSTABLES_PRODUCTION_BINDING.manual_model.id &&
        model.name === CHANNELMAX_UNCRUSTABLES_PRODUCTION_BINDING.manual_model.name,
    ).length !== 1 ||
    new Set(models.map((model) => model.id)).size !== models.length
  ) {
    fail("MANUAL_MODEL_MISMATCH", "Canonical Manual min/max model 59021 was not uniquely discovered.");
  }
}

export function buildChannelMaxUncrustablesMutationPreflight(
  input: ChannelMaxUncrustablesMutationPreflightInput,
): ChannelMaxUncrustablesMutationPreflight {
  const sourcePlanBytes = bytes(input.sourcePlanBytes);
  const assignmentManifestBytes = bytes(input.assignmentManifestBytes);
  const assignmentTsvBytes = bytes(input.assignmentTsvBytes);
  const inventorySnapshotBytes = bytes(input.inventorySnapshotBytes);
  const manualModelDiscoveryBytes = bytes(input.manualModelDiscoveryBytes);

  const sourcePlan = parseJson(sourcePlanBytes, "source plan");
  const assignmentManifest = parseJson(assignmentManifestBytes, "assignment manifest");
  const snapshot = parseJson(inventorySnapshotBytes, "prewrite inventory snapshot");
  const discovery = parseJson(manualModelDiscoveryBytes, "manual-model discovery");
  const assignmentRows = parseAssignmentTsv(assignmentTsvBytes);

  verifyPlanAndAssignment(sourcePlan, assignmentManifest, assignmentRows);
  const snapshotRows = parseSnapshot(snapshot);
  verifyDiscovery(discovery);

  const assignmentBySku = new Map(assignmentRows.map((row) => [row.sku, row]));
  const snapshotBySku = new Map(snapshotRows.map((row) => [row.sku, row]));
  const excluded = snapshotRows
    .filter((row) => !assignmentBySku.has(row.sku))
    .sort((left, right) => left.sku.localeCompare(right.sku));
  const expectedExcluded = [...CHANNELMAX_UNCRUSTABLES_PRODUCTION_BINDING.excluded_rows].sort(
    (left, right) => left.sku.localeCompare(right.sku),
  );
  if (
    excluded.length !== expectedExcluded.length ||
    excluded.some(
      (row, index) =>
        row.sku !== expectedExcluded[index]?.sku || row.asin !== expectedExcluded[index]?.asin,
    )
  ) {
    fail("EXCLUSION_MISMATCH", "Exact TY/VN exclusion identities do not match the 164-to-162 cohort diff.");
  }

  const diffs = assignmentRows.map((desired): ChannelMaxUncrustablesMutationDiff => {
    const before = snapshotBySku.get(desired.sku);
    if (!before) {
      return fail("ASSIGNMENT_ROW_MISMATCH", `Prewrite snapshot identity is missing for ${desired.sku}.`);
    }
    const knownIdentityMismatch =
      CHANNELMAX_UNCRUSTABLES_PRODUCTION_BINDING.live_identity_mismatch;
    if (
      before.asin !== desired.asin &&
      !(
        desired.sku === knownIdentityMismatch.sku &&
        desired.asin === knownIdentityMismatch.desired_asin &&
        before.asin === knownIdentityMismatch.observed_channelmax_asin
      )
    ) {
      return fail(
        "ASSIGNMENT_ROW_MISMATCH",
        `Unexpected prewrite snapshot ASIN mismatch for ${desired.sku}.`,
      );
    }
    return {
      sku: desired.sku,
      asin: desired.asin,
      observed_channelmax_asin: before.asin,
      identity_match: before.asin === desired.asin,
      before: {
        model_id: before.modelId,
        model_name: before.modelName,
        minimum_price: before.minimum,
        maximum_price: before.maximum,
      },
      desired: {
        model_id: "59021",
        model_name: "Manual min/max",
        minimum_price: desired.minimum,
        maximum_price: desired.maximum,
      },
      changes: {
        model: before.modelId !== "59021" || before.modelName !== "Manual min/max",
        minimum_price: before.minimum !== desired.minimum,
        maximum_price: before.maximum !== desired.maximum,
      },
    };
  });
  const targetDefault = diffs.filter((row) => row.before.model_id === null).length;
  const targetManual = diffs.filter((row) => row.before.model_id === "59021").length;
  if (targetDefault !== 161 || targetManual !== 1) {
    fail("LIVE_BASELINE_MISMATCH", "Target cohort drifted from 161 Default / 1 Manual before-state.");
  }
  const modelChanges = diffs.filter((row) => row.changes.model).length;
  const boundsChanges = diffs.filter(
    (row) => row.changes.minimum_price || row.changes.maximum_price,
  ).length;
  const identityMismatches = diffs.filter((row) => !row.identity_match);
  const noops = diffs.filter(
    (row) =>
      !row.changes.model && !row.changes.minimum_price && !row.changes.maximum_price,
  ).length;
  const expectedIdentityMismatch =
    CHANNELMAX_UNCRUSTABLES_PRODUCTION_BINDING.live_identity_mismatch;
  if (
    modelChanges !== 161 ||
    boundsChanges !== 162 ||
    noops !== 0 ||
    identityMismatches.length !== 1 ||
    identityMismatches[0]?.sku !== expectedIdentityMismatch.sku ||
    identityMismatches[0]?.asin !== expectedIdentityMismatch.desired_asin ||
    identityMismatches[0]?.observed_channelmax_asin !==
      expectedIdentityMismatch.observed_channelmax_asin
  ) {
    fail("LIVE_BASELINE_MISMATCH", "Per-SKU diff summary drifted from the pinned baseline.");
  }

  const canaryBinding = CHANNELMAX_UNCRUSTABLES_PRODUCTION_BINDING.canary;
  const canaryDesired = assignmentBySku.get(canaryBinding.sku);
  const canaryBefore = snapshotBySku.get(canaryBinding.sku);
  if (
    !canaryDesired ||
    !canaryBefore ||
    canaryDesired.asin !== canaryBinding.asin ||
    canaryBefore.asin !== canaryBinding.asin ||
    canaryBefore.modelId !== "59021" ||
    canaryBefore.modelName !== "Manual min/max"
  ) {
    fail("LIVE_BASELINE_MISMATCH", "Exact same-model canary is absent or no longer rollback-compatible.");
  }
  const canaryTsv = `${TSV_COLUMNS.join("\t")}\r\n${canaryDesired.raw}\r\n`;

  assertExactHash(
    sourcePlanBytes,
    CHANNELMAX_UNCRUSTABLES_PRODUCTION_BINDING.source_plan.file_sha256,
    null,
    "Source plan",
  );
  assertExactHash(
    assignmentManifestBytes,
    CHANNELMAX_UNCRUSTABLES_PRODUCTION_BINDING.assignment_manifest.file_sha256,
    null,
    "Assignment manifest",
  );
  assertExactHash(
    assignmentTsvBytes,
    CHANNELMAX_UNCRUSTABLES_PRODUCTION_BINDING.assignment_tsv.sha256,
    CHANNELMAX_UNCRUSTABLES_PRODUCTION_BINDING.assignment_tsv.byte_size,
    "Assignment TSV",
  );
  assertExactHash(
    inventorySnapshotBytes,
    CHANNELMAX_UNCRUSTABLES_PRODUCTION_BINDING.prewrite_snapshot.sha256,
    CHANNELMAX_UNCRUSTABLES_PRODUCTION_BINDING.prewrite_snapshot.byte_size,
    "Prewrite snapshot",
  );
  assertExactHash(
    manualModelDiscoveryBytes,
    CHANNELMAX_UNCRUSTABLES_PRODUCTION_BINDING.manual_model_discovery.sha256,
    CHANNELMAX_UNCRUSTABLES_PRODUCTION_BINDING.manual_model_discovery.byte_size,
    "Manual-model discovery",
  );

  const body: Omit<ChannelMaxUncrustablesMutationPreflight, "sha256"> = {
    schema_version: CHANNELMAX_UNCRUSTABLES_MUTATION_PREFLIGHT_SCHEMA,
    immutable: true,
    mode: "OFFLINE_FAIL_CLOSED",
    binding: {
      account_id: CHANNELMAX_BOUND_ACCOUNT_ID,
      selected_site_id: "300",
      selected_site_name: CHANNELMAX_SELECTED_CHANNEL_MARKER,
      manual_model: { id: "59021", name: "Manual min/max" },
    },
    sources: {
      source_plan_file_sha256: digest(sourcePlanBytes),
      source_plan_body_sha256: String(sourcePlan.sha256),
      assignment_manifest_file_sha256: digest(assignmentManifestBytes),
      assignment_manifest_body_sha256: String(assignmentManifest.sha256),
      assignment_tsv_sha256: digest(assignmentTsvBytes),
      assignment_tsv_byte_size: assignmentTsvBytes.byteLength,
      prewrite_snapshot_sha256: digest(inventorySnapshotBytes),
      prewrite_snapshot_byte_size: inventorySnapshotBytes.byteLength,
      manual_model_discovery_sha256: digest(manualModelDiscoveryBytes),
      manual_model_discovery_byte_size: manualModelDiscoveryBytes.byteLength,
    },
    cohort: {
      live_rows: 164,
      target_rows: 162,
      excluded_rows: expectedExcluded.map((row) => ({ ...row })),
      identity_mismatches: [
        { ...CHANNELMAX_UNCRUSTABLES_PRODUCTION_BINDING.live_identity_mismatch },
      ],
      live_model_distribution: { default: 162, manual_min_max: 2 },
      target_before_model_distribution: { default: 161, manual_min_max: 1 },
    },
    diff_summary: {
      rows: 162,
      model_changes: 161,
      bounds_changes: 162,
      identity_mismatches: 1,
      noops: 0,
    },
    diffs,
    canary: {
      sku: "VC-ASV1-378P",
      asin: "B0H786L5MW",
      rationale: "ONLY_TARGET_ROW_ALREADY_ON_CANONICAL_MANUAL_MODEL",
      assignment_tsv: canaryTsv,
      assignment_sha256: digest(Buffer.from(canaryTsv, "utf8")),
      before_minimum_price: canaryBefore.minimum,
      before_maximum_price: canaryBefore.maximum,
      desired_minimum_price: canaryDesired.minimum,
      desired_maximum_price: canaryDesired.maximum,
      mutation_execution_allowed: false,
    },
    rollback: {
      prewrite_snapshot_sha256: digest(inventorySnapshotBytes),
      bounds_captured_rows: 162,
      manual_model_restore_rows: 1,
      default_model_restore_rows: 161,
      default_model_restore_mechanism: null,
      default_model_restore_status: "UNPROVEN",
      exact_previous_states: diffs.map((row) => ({
        sku: row.sku,
        asin: row.observed_channelmax_asin,
        model_id: row.before.model_id,
        model_name: row.before.model_name,
        minimum_price: row.before.minimum_price,
        maximum_price: row.before.maximum_price,
      })),
      complete: false,
    },
    required_sequence: [
      "OWNER_STEP_UP_APPROVAL_BOUND_TO_ALL_HASHES",
      "ONE_ROW_CANARY",
      "VERIFY_UPLOAD_TASK_AND_EXACT_ROW_COUNTS",
      "POST_UPLOAD_CHANNELMAX_EXPORT",
      "DELAYED_AMAZON_READBACK_AND_HOLD",
      "EXPAND_TO_162_ONLY_AFTER_RECONCILED_CANARY",
    ],
    ambiguity_policy: "TERMINAL_NO_AUTOMATIC_RETRY",
    blockers: [
      {
        code: "DEFAULT_MODEL_RESTORE_UNPROVEN",
        affected_rows: 161,
        detail:
          "The current upload contract can assign numeric model 59021 but has no tested finite action that restores ChannelMAX Default (null model).",
      },
      {
        code: "ROLLBACK_ARTIFACT_UNVERIFIED",
        affected_rows: 162,
        detail:
          "Old bounds are captured, but no independently verified exact rollback artifact can restore both prior bounds and the 161 Default / 1 Manual model distribution.",
      },
      {
        code: "CHANNELMAX_SKU_ASIN_IDENTITY_MISMATCH",
        affected_rows: 1,
        detail:
          "Sealed v10 targets SZ-ASPI-JFAT / B0H776M5B5, while the exact live ChannelMAX row for that SKU reports B0H75VN18Z; an exact 162-row upload is unsafe.",
      },
      {
        code: "FINITE_MUTATION_EXECUTOR_ABSENT",
        affected_rows: 162,
        detail:
          "The installed iMac worker intentionally supports read-only snapshot/model-discovery operations only.",
      },
      {
        code: "PRODUCTION_MUTATION_RELEASE_GATE_DISABLED",
        affected_rows: 162,
        detail:
          "The SSCC production mutation release gate remains hard-disabled.",
      },
    ],
    mutation_execution_allowed: false,
  };
  return { ...body, sha256: sha256Json(body) };
}

/**
 * Deliberately cannot authorize a mutation. The exact preflight is useful for
 * audit/diff/rollback design, but the unresolved Default-model round trip is a
 * terminal production blocker until reviewed code replaces this fail-closed
 * assertion.
 */
export function assertChannelMaxUncrustablesMutationMayExecute(
  preflight: ChannelMaxUncrustablesMutationPreflight,
): never {
  if (preflight.rollback.complete !== false || preflight.mutation_execution_allowed !== false) {
    fail("ROLLBACK_INCOMPLETE", "A weakened preflight attempted to bypass the rollback gate.");
  }
  fail(
    "MUTATION_EXECUTION_BLOCKED",
    `ChannelMAX mutation is blocked: ${preflight.blockers.map((blocker) => blocker.code).join(", ")}.`,
  );
}
