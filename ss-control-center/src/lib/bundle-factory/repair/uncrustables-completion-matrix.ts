import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export const UNCRUSTABLES_COMPLETION_MATRIX_SCHEMA =
  "uncrustables-completion-matrix/v4" as const;

const CHECKPOINT_PLAN_SHA256 =
  "8badb989fc9bc5ee9c7ced63029ef9c8cea01d1b494c5766330709dfcf17c477";

const DEFAULT_SOURCE_SPECS = {
  authoritative_plan: {
    path: "data/repairs/generated/uncrustables-final-164-20260718-v5/URP-20260718T060953141Z-480ed383f696.json",
    file_sha256:
      "15d85932f70871a41b39f33d9290f840e6bbdb50c498964b01fed355a23f4957",
    seal_field: "sha256",
    body_sha256:
      "480ed383f6963ac4983c142085599ee1877e12343a63be55eec4e6d1cecdebe3",
  },
  strict_main: {
    path: "data/audits/uncrustables-live-main-strict-reaudit-20260718-v6.json",
    file_sha256:
      "87d9adf66cc322becccd0eb214e13d073272c3c11405e4bdd15e93c98f08eb4c",
    seal_field: "body_sha256",
    seal_algorithm: "json",
    body_sha256:
      "befae9606c9dca01175c555f181cfcff53bd248aa5060ee2194e3e611739ff8e",
  },
  main_repair_readiness: {
    path: "data/audits/uncrustables-main-repair-readiness-20260718-v6.json",
    file_sha256:
      "1d308f001bcb88656a849b2e5b81073e1f30d96331139c8c8902a9783be0a429",
    body_sha256:
      "e64df30b219a79c9c4d66e41ca4dc238266d8411b45f6fa14900fd7b24509d7f",
  },
  gallery_plan: {
    path: "data/audits/uncrustables-live-gallery-surgical-plan-20260718-v4.json",
    file_sha256:
      "ae345407a4b95232941cdcaa3836fc85ba87ca6d9cf94988f797253d90025469",
    seal_field: "body_sha256",
    body_sha256:
      "1a3f88771d7f3acce217f447fe13d28de570f3c0f50defeadbde817d6eb1586d",
  },
  text_structured_selection: {
    path: "data/repairs/execution-selections/uncrustables-text-structured-162-20260718-v1/URES-20260718T111837966Z-1d8786c0422c.json",
    file_sha256:
      "38b23e7ba328882c2a0617d2b8236b06b9e3632cb5bceac870d3e819d95e641e",
    seal_field: "sha256",
    seal_omit_fields: ["confirmation_token"],
    body_sha256:
      "1d8786c0422c8a663defa81fa95b2871169091a1b46a6c25160dcda57794bfc0",
  },
  live_pricing: {
    path: "data/audits/live-pricing/ULPA-20260718T221726816Z-8096129d8101-75cebdca9037-be7a076ea423.json",
    file_sha256:
      "f72761f27d52cafc8262cfda35ab4185e5ca501209678a3c00c1d75711471759",
    seal_field: "body_sha256",
    body_sha256:
      "be7a076ea4232f5384423c412b625cedf5ac7acb39345fe839d11ddc4a92615a",
  },
  launch_pricing: {
    path: "data/repairs/launch-pricing/manifests-v4-proposal/uncrustables-launch-pricing-20260718T181103000Z-75cebdca9037.json",
    file_sha256:
      "1f41574bde29108050a16ca0980a4fb8206200a4d26314e07d04a09cf0898f9b",
    seal_field: "body_sha256",
    body_sha256:
      "75cebdca90376e85feebd7a5ae910c2f9da0b573f15afe68de095f0c9e191e37",
  },
  channelmax_snapshot: {
    path: "data/audits/channelmax-live-snapshot-20260718T215936Z.json",
    file_sha256:
      "1f5f43122d35b2c422c6d1c92b6b0fc12cec8b1b4518536059250d89c1860427",
    job_id: "cmrqwt8b2000004kzqmf46l0e",
  },
  channelmax_manual_model: {
    path: "data/audits/channelmax-manual-model-discovery-20260718T220023Z.json",
    file_sha256:
      "14124ed5f78d1d407911f02f2844da0ffdf2bb8c82f8ad4c470b262ee6e31815",
    job_id: "cmrqwwemr000004jr0thviclo",
  },
  checkpoints: {
    path: "data/repairs/checkpoints/8badb989fc9bc5ee9c7c",
  },
} as const;

type JsonObject = Record<string, unknown>;

export interface SourceEvidence {
  source_id: string;
  path: string;
  file_sha256: string | null;
  body_sha256: string | null;
  observed_at: string;
  point_in_time: true;
  job_id?: string;
  artifact_count?: number;
  artifact_set_sha256?: string;
  time_semantics?: "OBSERVED_AT" | "DERIVED_FROM_STRICT_AUDIT_NO_RUNTIME_TIMESTAMP";
}

export interface FieldEvidenceRef {
  source_id: string;
  observed_at: string;
  point_in_time: true;
  artifact_path?: string;
  artifact_sha256?: string;
  row_evidence_sha256?: string;
}

export interface UncrustablesCompletionMatrixRow {
  ordinal: number;
  sku: string;
  asin: string;
  catalog: {
    status:
      | "ACTIVE_COHORT_IN_SEALED_PLAN"
      | "BLOCKED_CATALOG_IDENTITY_CONFLICT_8541";
    reason_codes: string[];
    evidence: FieldEvidenceRef;
  };
  main_image: {
    status: "VISUAL_KEEP_PROVENANCE_PENDING" | "REPAIR_REQUIRED";
    decision: "KEEP" | "REPAIR";
    recommendation: string;
    reason_codes: string[];
    source_image_sha256: string;
    evidence: FieldEvidenceRef;
    repair_readiness:
      | "NOT_APPLICABLE_STRICT_KEEP"
      | "REFERENCE_READY_PENDING_EXPLICIT_CONTROLLED_GENERATION"
      | "BLOCKED_AUTHENTICITY_PROVENANCE"
      | "BLOCKED_CATALOG_IDENTITY";
    repair_readiness_blockers: string[];
    repair_readiness_evidence: FieldEvidenceRef;
  };
  gallery: {
    status:
      | "KEEP_NO_WRITE_POINT_IN_TIME"
      | "VERIFIED_POINT_IN_TIME"
      | "REBUILD_NOT_APPLIED";
    planned_action: string;
    desired_secondary_count: number;
    fixed_card_exact_slot_1: boolean;
    fixed_card_wording_evidence_status: "NOT_ESTABLISHED_BY_INPUTS";
    evidence: FieldEvidenceRef;
  };
  text: {
    status: "VERIFIED_POINT_IN_TIME" | "NOT_APPLIED_CATALOG_BLOCKED";
    stable_post_write_reads: number | null;
    evidence: FieldEvidenceRef;
  };
  structured_attributes: {
    status: "VERIFIED_POINT_IN_TIME" | "NOT_APPLIED_CATALOG_BLOCKED";
    stable_post_write_reads: number | null;
    evidence: FieldEvidenceRef;
  };
  amazon_pricing: {
    status: string;
    reconciliation_status: string;
    canonical_base_price: number;
    canonical_floor_price: number;
    canonical_price_basis: "LIVE_AUDIT" | "AUTHORITATIVE_PLAN_FALLBACK";
    observed_effective_price: number | null;
    evidence: FieldEvidenceRef;
  };
  launch_promotion: {
    status:
      | "PROPOSED_NOT_OWNER_APPROVED_OR_APPLIED"
      | "EXCLUDED_CATALOG_IDENTITY_CONFLICT";
    arm: string | null;
    lever: string | null;
    effective_price: number | null;
    discount_percent: number | null;
    start_at: string | null;
    end_at: string | null;
    evidence: FieldEvidenceRef;
  };
  channelmax: {
    status:
      | "LIVE_IDENTITY_MISMATCH"
      | "LIVE_DEFAULT_MODEL_OVERWRITE_RISK"
      | "LIVE_MANUAL_MODEL_BOUNDS_MISMATCH"
      | "LIVE_MANUAL_MODEL_RUNTIME_RULES_UNVERIFIED"
      | "NOT_LIVE_OR_UNRESOLVED";
    repricing_status: string;
    observed_asin: string;
    identity_exact_match: boolean;
    model_id: string | null;
    model_name: string | null;
    canonical_manual_model_id: string;
    desired: {
      price: number;
      floor: number;
      ceiling: number;
    };
    observed: {
      price: number | null;
      floor: number | null;
      ceiling: number | null;
    };
    exact_match: {
      price: boolean;
      floor: boolean;
      ceiling: boolean;
    };
    evidence: FieldEvidenceRef;
  };
  overall: {
    readiness: "NOT_PROVEN_IDEAL";
    primary_blocker: string;
    blocker_codes: string[];
    latest_evidence_at: string;
  };
}

export interface UncrustablesCompletionMatrixSummary {
  total_rows: number;
  proven_ideal_rows: number;
  ready_to_publish_rows: number;
  catalog_status: Record<string, number>;
  main_image_status: Record<string, number>;
  main_repair_readiness: Record<string, number>;
  gallery_status: Record<string, number>;
  text_status: Record<string, number>;
  structured_attributes_status: Record<string, number>;
  amazon_pricing_status: Record<string, number>;
  launch_promotion_status: Record<string, number>;
  channelmax_status: Record<string, number>;
  primary_blockers: Record<string, number>;
  evidence_caveat: string;
}

export interface UncrustablesCompletionMatrix {
  schema_version: typeof UNCRUSTABLES_COMPLETION_MATRIX_SCHEMA;
  immutable: true;
  read_only: true;
  matrix_id: string;
  deterministic_as_of: string;
  source_bundle_sha256: string;
  policy: {
    exact_scope_required: 164;
    external_reads_performed: false;
    external_mutations_performed: false;
    point_in_time_evidence_is_not_current_state_proof: true;
    no_row_ideal_without_all_gates_and_delayed_readback: true;
  };
  sources: SourceEvidence[];
  summary: UncrustablesCompletionMatrixSummary;
  rows: UncrustablesCompletionMatrixRow[];
  output_artifacts: {
    csv_sha256: string;
    summary_markdown_sha256: string;
  };
  body_sha256: string;
}

export interface BuiltUncrustablesCompletionMatrix {
  matrix: UncrustablesCompletionMatrix;
  csv: string;
  summaryMarkdown: string;
}

interface LoadedArtifact {
  path: string;
  fileSha256: string;
  bodySha256: string | null;
  value: JsonObject;
}

interface SelectedCheckpoint {
  actionId: string;
  sku: string;
  createdAt: string;
  path: string;
  sha256: string;
  stableReads: number | null;
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sealRecord(
  value: JsonObject,
  sealField: "sha256" | "body_sha256",
): string {
  const body = { ...value };
  delete body[sealField];
  return sha256(stableJson(body));
}

function isRecord(value: unknown): value is JsonObject {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function mustRecord(value: unknown, label: string): JsonObject {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function mustArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function mustString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function mustNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }
  return value;
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function canonicalInstant(value: unknown, label: string): string {
  const text = mustString(value, label);
  const millis = Date.parse(text);
  if (!Number.isFinite(millis)) {
    throw new Error(`${label} must be an ISO timestamp.`);
  }
  return new Date(millis).toISOString();
}

function exactMoney(left: number | null, right: number): boolean {
  return left != null && Math.abs(left - right) < 0.005;
}

function exactSet(left: Iterable<string>, right: Iterable<string>): boolean {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return stableJson(a) === stableJson(b);
}

function countBy(values: Iterable<string>): Record<string, number> {
  const output: Record<string, number> = {};
  for (const value of values) output[value] = (output[value] ?? 0) + 1;
  return Object.fromEntries(
    Object.entries(output).sort(([left], [right]) => left.localeCompare(right)),
  );
}

async function loadPinnedArtifact(
  repoRoot: string,
  spec: {
    path: string;
    file_sha256: string;
    seal_field?: "sha256" | "body_sha256";
    seal_algorithm?: "stable" | "json";
    seal_omit_fields?: readonly string[];
    body_sha256?: string;
  },
): Promise<LoadedArtifact> {
  const bytes = await readFile(path.join(repoRoot, spec.path));
  const actualFileSha = sha256(bytes);
  if (actualFileSha !== spec.file_sha256) {
    throw new Error(
      `${spec.path} file SHA-256 mismatch: expected ${spec.file_sha256}, got ${actualFileSha}.`,
    );
  }
  const value = mustRecord(JSON.parse(bytes.toString("utf8")), spec.path);
  let bodySha256: string | null = null;
  if (spec.seal_field) {
    const claimed = mustString(value[spec.seal_field], `${spec.path} seal`);
    const body = { ...value };
    delete body[spec.seal_field];
    for (const field of spec.seal_omit_fields ?? []) delete body[field];
    const calculated = sha256(
      spec.seal_algorithm === "json" ? JSON.stringify(body) : stableJson(body),
    );
    if (claimed !== spec.body_sha256 || calculated !== claimed) {
      throw new Error(`${spec.path} internal body seal is invalid.`);
    }
    bodySha256 = claimed;
  }
  return {
    path: spec.path,
    fileSha256: actualFileSha,
    bodySha256,
    value,
  };
}

function checkpointScore(checkpoint: JsonObject): number {
  const detail = isRecord(checkpoint.detail) ? checkpoint.detail : {};
  const stableReads = nullableNumber(detail.stable_post_write_reads) ?? 0;
  const consecutiveReads = nullableNumber(detail.consecutive_stable_reads) ?? 0;
  const checks = Array.isArray(detail.checks) ? detail.checks : [];
  const allChecksPass =
    checks.length > 0 &&
    checks.every((check) => isRecord(check) && check.ok === true);
  return stableReads * 100 + consecutiveReads * 100 + (allChecksPass ? 10 : 0);
}

async function loadVerifiedCheckpoints(
  repoRoot: string,
  selectedActionIds: Set<string>,
): Promise<{
  selected: Map<string, SelectedCheckpoint>;
  media: Map<string, SelectedCheckpoint>;
}> {
  const checkpointDir = DEFAULT_SOURCE_SPECS.checkpoints.path;
  const absoluteDir = path.join(repoRoot, checkpointDir);
  const files = (await readdir(absoluteDir))
    .filter((file) => file.endsWith(".json"))
    .sort();
  const candidates = new Map<
    string,
    Array<{ record: JsonObject; relativePath: string }>
  >();
  const mediaCandidates = new Map<
    string,
    Array<{ record: JsonObject; relativePath: string }>
  >();

  for (const file of files) {
    const relativePath = path.posix.join(checkpointDir, file);
    const raw = mustRecord(
      JSON.parse(await readFile(path.join(absoluteDir, file), "utf8")),
      relativePath,
    );
    if (raw.status !== "VERIFIED") continue;
    const actionId = nullableString(raw.action_id);
    if (!actionId) continue;
    if (
      !selectedActionIds.has(actionId) &&
      !actionId.endsWith(":media")
    ) {
      continue;
    }
    if (raw.plan_sha256 !== CHECKPOINT_PLAN_SHA256) {
      throw new Error(`${relativePath} is bound to an unexpected repair plan.`);
    }
    const claimed = mustString(raw.sha256, `${relativePath} sha256`);
    if (sealRecord(raw, "sha256") !== claimed) {
      throw new Error(`${relativePath} checkpoint seal is invalid.`);
    }
    const target = actionId.endsWith(":media") ? mediaCandidates : candidates;
    const list = target.get(actionId) ?? [];
    list.push({ record: raw, relativePath });
    target.set(actionId, list);
  }

  function select(
    source: Map<string, Array<{ record: JsonObject; relativePath: string }>>,
  ): Map<string, SelectedCheckpoint> {
    return new Map(
      [...source.entries()].map(([actionId, items]) => {
        const sorted = [...items].sort((left, right) => {
          const score = checkpointScore(right.record) - checkpointScore(left.record);
          if (score !== 0) return score;
          return mustString(right.record.created_at, "checkpoint created_at").localeCompare(
            mustString(left.record.created_at, "checkpoint created_at"),
          );
        });
        const winner = sorted[0];
        const detail = isRecord(winner.record.detail) ? winner.record.detail : {};
        const checks = mustArray(detail.checks, `${winner.relativePath} checks`);
        if (
          checks.length === 0 ||
          !checks.every((check) => isRecord(check) && check.ok === true)
        ) {
          throw new Error(`${winner.relativePath} does not prove all checks true.`);
        }
        const stableReads =
          nullableNumber(detail.stable_post_write_reads) ??
          nullableNumber(detail.consecutive_stable_reads);
        const checkpoint: SelectedCheckpoint = {
          actionId,
          sku: mustString(winner.record.sku, `${winner.relativePath} sku`),
          createdAt: canonicalInstant(
            winner.record.created_at,
            `${winner.relativePath} created_at`,
          ),
          path: winner.relativePath,
          sha256: mustString(winner.record.sha256, `${winner.relativePath} sha256`),
          stableReads,
        };
        return [actionId, checkpoint];
      }),
    );
  }

  return { selected: select(candidates), media: select(mediaCandidates) };
}

function evidence(
  sourceId: string,
  observedAt: string,
  extra: Partial<FieldEvidenceRef> = {},
): FieldEvidenceRef {
  return {
    source_id: sourceId,
    observed_at: observedAt,
    point_in_time: true,
    ...extra,
  };
}

function latestInstant(values: Iterable<string>): string {
  const sorted = [...values].sort(
    (left, right) => Date.parse(left) - Date.parse(right),
  );
  const latest = sorted.at(-1);
  if (!latest) throw new Error("At least one evidence timestamp is required.");
  return latest;
}

function csvCell(value: unknown): string {
  const text =
    value == null
      ? ""
      : Array.isArray(value)
        ? value.join("|")
        : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function completionMatrixRowsToCsv(
  rows: readonly UncrustablesCompletionMatrixRow[],
): string {
  const headers = [
    "ordinal",
    "sku",
    "asin",
    "catalog_status",
    "main_status",
    "main_reason_codes",
    "main_repair_readiness",
    "gallery_status",
    "gallery_planned_action",
    "gallery_secondary_count",
    "text_status",
    "structured_status",
    "amazon_pricing_status",
    "amazon_observed_price",
    "canonical_base_price",
    "canonical_floor_price",
    "canonical_price_basis",
    "launch_status",
    "launch_arm",
    "launch_lever",
    "channelmax_status",
    "channelmax_observed_asin",
    "channelmax_identity_exact_match",
    "channelmax_model",
    "channelmax_price",
    "channelmax_floor",
    "channelmax_ceiling",
    "readiness",
    "primary_blocker",
    "blocker_codes",
    "latest_evidence_at",
  ] as const;
  const lines = [headers.join(",")];
  for (const row of rows) {
    lines.push(
      [
        row.ordinal,
        row.sku,
        row.asin,
        row.catalog.status,
        row.main_image.status,
        row.main_image.reason_codes,
        row.main_image.repair_readiness,
        row.gallery.status,
        row.gallery.planned_action,
        row.gallery.desired_secondary_count,
        row.text.status,
        row.structured_attributes.status,
        row.amazon_pricing.status,
        row.amazon_pricing.observed_effective_price,
        row.amazon_pricing.canonical_base_price,
        row.amazon_pricing.canonical_floor_price,
        row.amazon_pricing.canonical_price_basis,
        row.launch_promotion.status,
        row.launch_promotion.arm,
        row.launch_promotion.lever,
        row.channelmax.status,
        row.channelmax.observed_asin,
        row.channelmax.identity_exact_match,
        row.channelmax.model_name,
        row.channelmax.observed.price,
        row.channelmax.observed.floor,
        row.channelmax.observed.ceiling,
        row.overall.readiness,
        row.overall.primary_blocker,
        row.overall.blocker_codes,
        row.overall.latest_evidence_at,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

function summaryTable(
  title: string,
  counts: Record<string, number>,
): string[] {
  return [
    `### ${title}`,
    "",
    "| Status | Rows |",
    "|---|---:|",
    ...Object.entries(counts).map(([status, count]) => `| ${status} | ${count} |`),
    "",
  ];
}

export function renderCompletionMatrixSummary(
  matrix: Pick<
    UncrustablesCompletionMatrix,
    "matrix_id" | "deterministic_as_of" | "summary"
  >,
): string {
  const summary = matrix.summary;
  return [
    `# Amazon Uncrustables completion matrix — ${matrix.matrix_id}`,
    "",
    `Deterministic evidence cutoff: ${matrix.deterministic_as_of}.`,
    "",
    `Rows: ${summary.total_rows}. Proven ideal: ${summary.proven_ideal_rows}. Ready to publish: ${summary.ready_to_publish_rows}.`,
    "",
    summary.evidence_caveat,
    "",
    ...summaryTable("Catalog identity", summary.catalog_status),
    ...summaryTable("MAIN image", summary.main_image_status),
    ...summaryTable("MAIN repair readiness", summary.main_repair_readiness),
    ...summaryTable("Gallery", summary.gallery_status),
    ...summaryTable("Text", summary.text_status),
    ...summaryTable(
      "Structured attributes",
      summary.structured_attributes_status,
    ),
    ...summaryTable("Amazon pricing", summary.amazon_pricing_status),
    ...summaryTable("Launch promotion", summary.launch_promotion_status),
    ...summaryTable("ChannelMAX", summary.channelmax_status),
    ...summaryTable("Primary blocker", summary.primary_blockers),
  ].join("\n");
}

export async function buildDefaultUncrustablesCompletionMatrix(
  repoRoot: string,
): Promise<BuiltUncrustablesCompletionMatrix> {
  const [
    authoritative,
    strictMain,
    mainRepairReadiness,
    galleryPlan,
    selection,
    livePricing,
    launchPricing,
    channelMaxSnapshot,
    channelMaxManualModel,
  ] = await Promise.all([
    loadPinnedArtifact(repoRoot, DEFAULT_SOURCE_SPECS.authoritative_plan),
    loadPinnedArtifact(repoRoot, DEFAULT_SOURCE_SPECS.strict_main),
    loadPinnedArtifact(repoRoot, DEFAULT_SOURCE_SPECS.main_repair_readiness),
    loadPinnedArtifact(repoRoot, DEFAULT_SOURCE_SPECS.gallery_plan),
    loadPinnedArtifact(repoRoot, DEFAULT_SOURCE_SPECS.text_structured_selection),
    loadPinnedArtifact(repoRoot, DEFAULT_SOURCE_SPECS.live_pricing),
    loadPinnedArtifact(repoRoot, DEFAULT_SOURCE_SPECS.launch_pricing),
    loadPinnedArtifact(repoRoot, DEFAULT_SOURCE_SPECS.channelmax_snapshot),
    loadPinnedArtifact(repoRoot, DEFAULT_SOURCE_SPECS.channelmax_manual_model),
  ]);

  const authoritativeEntries = mustArray(
    authoritative.value.entries,
    "authoritative entries",
  ).map((entry, index) => {
    const record = mustRecord(entry, `authoritative entry ${index + 1}`);
    return {
      ordinal: index + 1,
      sku: mustString(record.sku, `authoritative entry ${index + 1} sku`),
      asin: mustString(record.asin, `authoritative entry ${index + 1} asin`),
      actions: mustArray(record.actions, `authoritative entry ${index + 1} actions`),
    };
  });
  if (
    authoritativeEntries.length !== 164 ||
    new Set(authoritativeEntries.map((entry) => entry.sku)).size !== 164 ||
    new Set(authoritativeEntries.map((entry) => entry.asin)).size !== 164
  ) {
    throw new Error("Authoritative plan must contain exactly 164 unique SKU/ASIN rows.");
  }
  const identityBySku = new Map(
    authoritativeEntries.map((entry) => [entry.sku, entry]),
  );

  const exclusionRows = [
    ...mustArray(launchPricing.value.exclusions, "launch exclusions"),
    ...mustArray(
      launchPricing.value.pre_assignment_exclusions,
      "launch pre-assignment exclusions",
    ),
  ].map((entry, index) => {
    const record = mustRecord(entry, `catalog exclusion ${index + 1}`);
    return {
      sku: mustString(record.sku, `catalog exclusion ${index + 1} sku`),
      asin: mustString(record.asin, `catalog exclusion ${index + 1} asin`),
      reason: mustString(record.reason, `catalog exclusion ${index + 1} reason`),
    };
  });
  if (
    exclusionRows.length !== 2 ||
    !exactSet(
      exclusionRows.map((entry) => entry.sku),
      ["TY-AST2-JE9P", "VN-AS1A-D572"],
    ) ||
    exclusionRows.some(
      (entry) =>
        identityBySku.get(entry.sku)?.asin !== entry.asin ||
        entry.reason !== "AMAZON_CATALOG_IDENTITY_CONFLICT_8541",
    )
  ) {
    throw new Error("The exact two reviewed catalog conflicts are not preserved.");
  }
  const exclusionBySku = new Map(exclusionRows.map((entry) => [entry.sku, entry]));
  const activeSkus = authoritativeEntries
    .map((entry) => entry.sku)
    .filter((sku) => !exclusionBySku.has(sku));

  const selectedSkus = mustArray(selection.value.selected_skus, "selected_skus").map(
    (sku, index) => mustString(sku, `selected_skus[${index}]`),
  );
  const selectedActionIds = mustArray(
    selection.value.selected_action_ids,
    "selected_action_ids",
  ).map((action, index) => mustString(action, `selected_action_ids[${index}]`));
  if (
    selectedSkus.length !== 162 ||
    selectedActionIds.length !== 324 ||
    !exactSet(selectedSkus, activeSkus) ||
    !exactSet(
      selectedActionIds,
      activeSkus.flatMap((sku) => [
        `${sku}:text_count`,
        `${sku}:structured_attributes`,
      ]),
    )
  ) {
    throw new Error("Text/structured selection is not the exact active 162 cohort.");
  }

  const checkpointEvidence = await loadVerifiedCheckpoints(
    repoRoot,
    new Set(selectedActionIds),
  );
  if (
    checkpointEvidence.selected.size !== 324 ||
    !exactSet(checkpointEvidence.selected.keys(), selectedActionIds)
  ) {
    throw new Error("Verified text/structured checkpoint set is incomplete.");
  }
  const mediaSkus = [...checkpointEvidence.media.values()].map((item) => item.sku);
  if (!exactSet(mediaSkus, ["AD-AS4H-QXZD", "AZ-ASMY-VEQ2"])) {
    throw new Error("Expected exactly the reviewed AD/AZ gallery checkpoints.");
  }

  const mainRows = indexRows(strictMain.value.rows, "strict MAIN rows", identityBySku);
  const readinessSeal = mustRecord(
    mainRepairReadiness.value.seal,
    "MAIN repair readiness seal",
  );
  const readinessBodySha = mustString(
    readinessSeal.body_sha256,
    "MAIN repair readiness body_sha256",
  );
  const readinessBody = { ...mainRepairReadiness.value };
  delete readinessBody.seal;
  if (
    readinessBodySha !== DEFAULT_SOURCE_SPECS.main_repair_readiness.body_sha256 ||
    sha256(JSON.stringify(readinessBody)) !== readinessBodySha
  ) {
    throw new Error("MAIN repair readiness nested body seal is invalid.");
  }
  const mainReadinessRows = indexSubsetRows(
    mainRepairReadiness.value.rows,
    "MAIN repair readiness rows",
    identityBySku,
  );
  const strictRepairSkus = [...mainRows.entries()]
    .filter(([, row]) => row.decision === "REPAIR")
    .map(([sku]) => sku);
  if (
    mainReadinessRows.size !== 112 ||
    !exactSet(mainReadinessRows.keys(), strictRepairSkus)
  ) {
    throw new Error("MAIN repair readiness must cover the exact strict 112 REPAIR rows.");
  }
  const galleryRows = indexRows(galleryPlan.value.rows, "gallery rows", identityBySku);
  const pricingRows = indexRows(livePricing.value.rows, "pricing rows", identityBySku);
  const channelRows = indexRows(
    channelMaxSnapshot.value.launch_rows,
    "ChannelMAX launch rows",
    identityBySku,
    { allowAsinMismatch: true },
  );

  const launchRows = new Map<string, JsonObject>();
  for (const [index, raw] of mustArray(launchPricing.value.rows, "launch rows").entries()) {
    const row = mustRecord(raw, `launch row ${index + 1}`);
    const sku = mustString(row.sku, `launch row ${index + 1} sku`);
    if (launchRows.has(sku)) throw new Error(`Duplicate launch row for ${sku}.`);
    launchRows.set(sku, row);
  }
  if (
    launchRows.size !== 163 ||
    launchRows.has("VN-AS1A-D572") ||
    !launchRows.has("TY-AST2-JE9P")
  ) {
    throw new Error("Launch proposal must have 163 rows with VN pre-excluded.");
  }

  const mainReviewedAt = canonicalInstant(strictMain.value.reviewed_at, "MAIN reviewed_at");
  const galleryPlanAt = canonicalInstant(
    galleryPlan.value.deterministic_as_of,
    "gallery deterministic_as_of",
  );
  const gallerySource = mustRecord(
    mustRecord(galleryPlan.value.sources, "gallery sources").source_ledger,
    "gallery source ledger",
  );
  const galleryObservedAt = canonicalInstant(
    gallerySource.marketplace_observed_at,
    "gallery marketplace_observed_at",
  );
  const pricingCompletedAt = canonicalInstant(
    livePricing.value.completed_at,
    "pricing completed_at",
  );
  const launchReviewedAt = canonicalInstant(
    launchPricing.value.reviewed_at,
    "launch reviewed_at",
  );
  const selectionCreatedAt = canonicalInstant(
    selection.value.created_at,
    "selection created_at",
  );
  const authoritativeCreatedAt = canonicalInstant(
    authoritative.value.created_at,
    "authoritative created_at",
  );
  const channelCapturedAt = canonicalInstant(
    channelMaxSnapshot.value.captured_at,
    "ChannelMAX captured_at",
  );
  const manualModelCapturedAt = canonicalInstant(
    channelMaxManualModel.value.captured_at,
    "manual model captured_at",
  );
  const manualObservation = mustRecord(
    channelMaxManualModel.value.observation,
    "manual-model observation",
  );
  const manualDiscovery = mustRecord(
    manualObservation.manual_model_discovery,
    "manual-model discovery",
  );
  const canonicalManualModel = mustRecord(
    manualDiscovery.canonical_manual_model,
    "canonical manual model",
  );
  const canonicalManualModelId = mustString(
    canonicalManualModel.id,
    "canonical manual model id",
  );
  const canonicalManualModelName = mustString(
    canonicalManualModel.name,
    "canonical manual model name",
  );
  if (
    canonicalManualModelId !== "59021" ||
    canonicalManualModelName !== "Manual min/max" ||
    manualDiscovery.selected_site_id !== "300" ||
    manualDiscovery.selected_site_name !== "AmznUS [Salutem Solutions]" ||
    channelMaxSnapshot.value.account_id !==
      "channelmax:amznus:salutem-solutions" ||
    channelMaxSnapshot.value.selected_site_id !== "300" ||
    channelMaxSnapshot.value.selected_site_name !== "AmznUS [Salutem Solutions]"
  ) {
    throw new Error("ChannelMAX exact account/site/manual-model evidence is inconsistent.");
  }

  const selectedCheckpointRefs = [...checkpointEvidence.selected.values()].sort(
    (left, right) => left.actionId.localeCompare(right.actionId),
  );
  const mediaCheckpointRefs = [...checkpointEvidence.media.values()].sort(
    (left, right) => left.actionId.localeCompare(right.actionId),
  );
  const checkpointSetSha256 = sha256(stableJson(selectedCheckpointRefs));
  const mediaCheckpointSetSha256 = sha256(stableJson(mediaCheckpointRefs));
  const textStructuredObservedAt = latestInstant(
    selectedCheckpointRefs.map((item) => item.createdAt),
  );
  const galleryVerifiedObservedAt = latestInstant(
    mediaCheckpointRefs.map((item) => item.createdAt),
  );

  const sourceEvidence: SourceEvidence[] = [
    source(authoritative, "authoritative_plan", authoritativeCreatedAt),
    source(strictMain, "strict_main_v6", mainReviewedAt),
    {
      ...source(
        mainRepairReadiness,
        "main_repair_readiness_v6",
        mainReviewedAt,
      ),
      body_sha256: readinessBodySha,
      time_semantics: "DERIVED_FROM_STRICT_AUDIT_NO_RUNTIME_TIMESTAMP",
    },
    source(galleryPlan, "gallery_plan_v4", galleryPlanAt),
    source(selection, "text_structured_selection", selectionCreatedAt),
    {
      source_id: "text_structured_verified_checkpoints",
      path: DEFAULT_SOURCE_SPECS.checkpoints.path,
      file_sha256: null,
      body_sha256: null,
      observed_at: textStructuredObservedAt,
      point_in_time: true,
      artifact_count: selectedCheckpointRefs.length,
      artifact_set_sha256: checkpointSetSha256,
    },
    {
      source_id: "gallery_verified_checkpoints",
      path: DEFAULT_SOURCE_SPECS.checkpoints.path,
      file_sha256: null,
      body_sha256: null,
      observed_at: galleryVerifiedObservedAt,
      point_in_time: true,
      artifact_count: mediaCheckpointRefs.length,
      artifact_set_sha256: mediaCheckpointSetSha256,
    },
    source(livePricing, "amazon_live_pricing", pricingCompletedAt),
    source(launchPricing, "launch_pricing_v4_proposal", launchReviewedAt),
    {
      ...source(channelMaxSnapshot, "channelmax_inventory_snapshot", channelCapturedAt),
      job_id: DEFAULT_SOURCE_SPECS.channelmax_snapshot.job_id,
    },
    {
      ...source(
        channelMaxManualModel,
        "channelmax_manual_model_discovery",
        manualModelCapturedAt,
      ),
      job_id: DEFAULT_SOURCE_SPECS.channelmax_manual_model.job_id,
    },
  ];
  const sourceBundleSha256 = sha256(stableJson(sourceEvidence));
  const deterministicAsOf = latestInstant(
    sourceEvidence.map((item) => item.observed_at),
  );
  const matrixId = `UCM-${deterministicAsOf.replaceAll(/[-:.]/g, "")}-${sourceBundleSha256.slice(0, 12)}`;

  const rows: UncrustablesCompletionMatrixRow[] = authoritativeEntries.map(
    (entry) => {
      const catalogConflict = exclusionBySku.get(entry.sku) ?? null;
      const main = mustRecord(mainRows.get(entry.sku), `${entry.sku} MAIN row`);
      const gallery = mustRecord(galleryRows.get(entry.sku), `${entry.sku} gallery row`);
      const pricing = mustRecord(pricingRows.get(entry.sku), `${entry.sku} pricing row`);
      const channel = mustRecord(channelRows.get(entry.sku), `${entry.sku} ChannelMAX row`);
      const launch = launchRows.get(entry.sku) ?? null;
      const offerAction = entry.actions
        .map((action, index) => mustRecord(action, `${entry.sku} action ${index + 1}`))
        .find((action) => action.kind === "OFFER");
      if (!offerAction) throw new Error(`${entry.sku} has no canonical OFFER action.`);
      const desiredOffer = mustRecord(
        mustRecord(offerAction.desired, `${entry.sku} OFFER desired`).value,
        `${entry.sku} OFFER value`,
      );
      const desiredPrice = mustNumber(
        desiredOffer.consumer_price,
        `${entry.sku} desired price`,
      );
      const desiredFloor = mustNumber(
        desiredOffer.minimum_seller_allowed_price,
        `${entry.sku} desired floor`,
      );
      const desiredCeiling = mustNumber(
        desiredOffer.maximum_seller_allowed_price,
        `${entry.sku} desired ceiling`,
      );

      const mainDecision = mustString(main.decision, `${entry.sku} MAIN decision`);
      if (mainDecision !== "KEEP" && mainDecision !== "REPAIR") {
        throw new Error(`${entry.sku} has unsupported MAIN decision ${mainDecision}.`);
      }
      const mainEvidence = mustRecord(main.evidence, `${entry.sku} MAIN evidence`);
      const mainReasonCodes = mustArray(
        main.reason_codes,
        `${entry.sku} MAIN reason codes`,
      ).map((code, index) => mustString(code, `${entry.sku} MAIN reason ${index}`));
      const mainReadiness = mainReadinessRows.get(entry.sku) ?? null;
      if (
        (mainDecision === "REPAIR" && !mainReadiness) ||
        (mainDecision === "KEEP" && mainReadiness)
      ) {
        throw new Error(`${entry.sku} strict MAIN/readiness membership is inconsistent.`);
      }
      const mainRepairReadiness = mainReadiness
        ? mustString(mainReadiness.readiness, `${entry.sku} MAIN repair readiness`)
        : "NOT_APPLICABLE_STRICT_KEEP";
      if (
        ![
          "NOT_APPLICABLE_STRICT_KEEP",
          "REFERENCE_READY_PENDING_EXPLICIT_CONTROLLED_GENERATION",
          "BLOCKED_AUTHENTICITY_PROVENANCE",
          "BLOCKED_CATALOG_IDENTITY",
        ].includes(mainRepairReadiness)
      ) {
        throw new Error(`${entry.sku} has unsupported MAIN repair readiness.`);
      }
      const mainRepairReadinessBlockers = mainReadiness
        ? mustArray(mainReadiness.blockers, `${entry.sku} MAIN readiness blockers`).map(
            (blocker, index) =>
              mustString(
                mustRecord(
                  blocker,
                  `${entry.sku} MAIN readiness blocker ${index}`,
                ).code,
                `${entry.sku} MAIN readiness blocker ${index} code`,
              ),
          )
        : [];

      const galleryAfter = mustRecord(gallery.after, `${entry.sku} gallery after`);
      const galleryAfterAssets = mustArray(
        galleryAfter.secondary_assets,
        `${entry.sku} gallery after assets`,
      );
      const galleryAction = mustString(gallery.action, `${entry.sku} gallery action`);
      const mediaCheckpoint = checkpointEvidence.media.get(`${entry.sku}:media`) ?? null;
      const galleryStatus =
        mediaCheckpoint != null
          ? ("VERIFIED_POINT_IN_TIME" as const)
          : gallery.write_required === false && galleryAction === "KEEP"
            ? ("KEEP_NO_WRITE_POINT_IN_TIME" as const)
            : ("REBUILD_NOT_APPLIED" as const);
      const galleryEvidence = mediaCheckpoint
        ? evidence("gallery_verified_checkpoints", mediaCheckpoint.createdAt, {
            artifact_path: mediaCheckpoint.path,
            artifact_sha256: mediaCheckpoint.sha256,
          })
        : evidence("gallery_plan_v4", galleryObservedAt, {
            row_evidence_sha256: sha256(stableJson(gallery)),
          });

      const textCheckpoint =
        checkpointEvidence.selected.get(`${entry.sku}:text_count`) ?? null;
      const structuredCheckpoint =
        checkpointEvidence.selected.get(`${entry.sku}:structured_attributes`) ?? null;
      if (
        (catalogConflict == null && (!textCheckpoint || !structuredCheckpoint)) ||
        (catalogConflict != null && (textCheckpoint != null || structuredCheckpoint != null))
      ) {
        throw new Error(`${entry.sku} content checkpoint/catalog status is inconsistent.`);
      }

      const observation = mustRecord(pricing.observation, `${entry.sku} price observation`);
      const reconciliationStatus = mustString(
        pricing.reconciliation_status,
        `${entry.sku} pricing reconciliation`,
      );
      const pricingObservedAt = canonicalInstant(
        observation.observed_at,
        `${entry.sku} pricing observed_at`,
      );
      const auditedCanonicalBase = nullableNumber(pricing.canonical_base_price);
      const auditedCanonicalFloor = nullableNumber(pricing.canonical_floor_price);

      const repriceInfo = mustRecord(channel.reprice_info, `${entry.sku} reprice_info`);
      const observedChannelPrice = nullableNumber(repriceInfo.my_price);
      const observedChannelFloor = nullableNumber(repriceInfo.my_floor);
      const observedChannelCeiling = nullableNumber(repriceInfo.my_ceiling);
      const repricingStatus = mustString(
        channel.repricing_status,
        `${entry.sku} repricing status`,
      );
      const modelId = nullableString(channel.repricing_model_id);
      const modelName = nullableString(channel.repricing_model_name);
      const channelAsin = mustString(channel.asin, `${entry.sku} ChannelMAX asin`);
      const channelIdentityExact = channelAsin === entry.asin;
      const floorMatches = exactMoney(observedChannelFloor, desiredFloor);
      const ceilingMatches = exactMoney(observedChannelCeiling, desiredCeiling);
      const channelStatus =
        !channelIdentityExact
          ? ("LIVE_IDENTITY_MISMATCH" as const)
          : repricingStatus !== "LIVE"
          ? ("NOT_LIVE_OR_UNRESOLVED" as const)
          : modelId === canonicalManualModelId &&
              modelName === canonicalManualModelName
            ? floorMatches && ceilingMatches
              ? ("LIVE_MANUAL_MODEL_RUNTIME_RULES_UNVERIFIED" as const)
              : ("LIVE_MANUAL_MODEL_BOUNDS_MISMATCH" as const)
            : ("LIVE_DEFAULT_MODEL_OVERWRITE_RISK" as const);

      const launchSchedule = launch && isRecord(launch.sale_price_schedule)
        ? launch.sale_price_schedule
        : null;
      const launchStatus = catalogConflict
        ? ("EXCLUDED_CATALOG_IDENTITY_CONFLICT" as const)
        : ("PROPOSED_NOT_OWNER_APPROVED_OR_APPLIED" as const);

      const blockerCodes = new Set<string>();
      if (catalogConflict) blockerCodes.add("CATALOG_IDENTITY_CONFLICT_8541");
      if (mainDecision === "REPAIR") {
        blockerCodes.add("MAIN_IMAGE_REPAIR_REQUIRED");
        if (mainRepairReadiness === "BLOCKED_AUTHENTICITY_PROVENANCE") {
          blockerCodes.add("MAIN_AUTHENTICITY_PROVENANCE_BLOCKED");
        } else if (
          mainRepairReadiness ===
          "REFERENCE_READY_PENDING_EXPLICIT_CONTROLLED_GENERATION"
        ) {
          blockerCodes.add("MAIN_CONTROLLED_GENERATION_NOT_AUTHORIZED_OR_RUN");
        }
      } else blockerCodes.add("MAIN_IMAGE_PROVENANCE_GATE_NOT_ESTABLISHED");
      if (galleryStatus === "REBUILD_NOT_APPLIED") {
        blockerCodes.add("GALLERY_REBUILD_NOT_VERIFIED");
      } else {
        blockerCodes.add("GALLERY_LATEST_READBACK_REQUIRED");
      }
      blockerCodes.add("GALLERY_CARD_WORDING_NOT_ESTABLISHED_BY_INPUTS");
      if (catalogConflict == null) {
        blockerCodes.add("TEXT_LATEST_READBACK_REQUIRED");
        blockerCodes.add("STRUCTURED_ATTRIBUTES_LATEST_READBACK_REQUIRED");
        blockerCodes.add("LAUNCH_PROMOTION_NOT_OWNER_APPROVED_OR_APPLIED");
      }
      if (reconciliationStatus !== "MATCH_EXPECTED") {
        blockerCodes.add(`AMAZON_PRICING_${reconciliationStatus}`);
      } else {
        blockerCodes.add("AMAZON_PRICING_LATEST_READBACK_REQUIRED");
      }
      blockerCodes.add(
        channelStatus === "LIVE_IDENTITY_MISMATCH"
          ? "CHANNELMAX_SKU_ASIN_IDENTITY_MISMATCH"
          : channelStatus === "LIVE_DEFAULT_MODEL_OVERWRITE_RISK"
          ? "CHANNELMAX_DEFAULT_MODEL_OVERWRITE_RISK"
          : channelStatus === "LIVE_MANUAL_MODEL_BOUNDS_MISMATCH"
            ? "CHANNELMAX_MANUAL_MODEL_BOUNDS_MISMATCH"
            : "CHANNELMAX_RUNTIME_RULES_OR_STATE_UNVERIFIED",
      );
      blockerCodes.add("FINAL_DELAYED_READBACK_NOT_COMPLETE");

      const primaryBlocker = catalogConflict
        ? "CATALOG_IDENTITY_CONFLICT_8541"
        : mainRepairReadiness === "BLOCKED_AUTHENTICITY_PROVENANCE"
          ? "MAIN_AUTHENTICITY_PROVENANCE_BLOCKED"
          : mainRepairReadiness ===
              "REFERENCE_READY_PENDING_EXPLICIT_CONTROLLED_GENERATION"
            ? "MAIN_CONTROLLED_GENERATION_NOT_AUTHORIZED_OR_RUN"
          : "MAIN_IMAGE_PROVENANCE_GATE_NOT_ESTABLISHED";
      const rowEvidenceTimes = [
        mainReviewedAt,
        galleryEvidence.observed_at,
        textCheckpoint?.createdAt ?? selectionCreatedAt,
        structuredCheckpoint?.createdAt ?? selectionCreatedAt,
        pricingObservedAt,
        launchReviewedAt,
        channelCapturedAt,
        manualModelCapturedAt,
      ];

      return {
        ordinal: entry.ordinal,
        sku: entry.sku,
        asin: entry.asin,
        catalog: {
          status: catalogConflict
            ? "BLOCKED_CATALOG_IDENTITY_CONFLICT_8541"
            : "ACTIVE_COHORT_IN_SEALED_PLAN",
          reason_codes: catalogConflict ? [catalogConflict.reason] : [],
          evidence: evidence("launch_pricing_v4_proposal", launchReviewedAt),
        },
        main_image: {
          status:
            mainDecision === "KEEP"
              ? "VISUAL_KEEP_PROVENANCE_PENDING"
              : "REPAIR_REQUIRED",
          decision: mainDecision,
          recommendation: mustString(
            main.recommendation,
            `${entry.sku} MAIN recommendation`,
          ),
          reason_codes: mainReasonCodes,
          source_image_sha256: mustString(
            mainEvidence.asset_sha256,
            `${entry.sku} MAIN asset SHA`,
          ),
          evidence: evidence("strict_main_v6", mainReviewedAt, {
            row_evidence_sha256: sha256(stableJson(main)),
          }),
          repair_readiness:
            mainRepairReadiness as UncrustablesCompletionMatrixRow["main_image"]["repair_readiness"],
          repair_readiness_blockers: mainRepairReadinessBlockers,
          repair_readiness_evidence: mainReadiness
            ? evidence("main_repair_readiness_v6", mainReviewedAt, {
                row_evidence_sha256: sha256(stableJson(mainReadiness)),
              })
            : evidence("strict_main_v6", mainReviewedAt),
        },
        gallery: {
          status: galleryStatus,
          planned_action: galleryAction,
          desired_secondary_count: galleryAfterAssets.length,
          fixed_card_exact_slot_1:
            isRecord(galleryAfterAssets[0]) &&
            galleryAfterAssets[0].role === "FIXED_PRICE_THANK_YOU_CARD" &&
            galleryAfterAssets[0].slot_index === 1,
          fixed_card_wording_evidence_status: "NOT_ESTABLISHED_BY_INPUTS",
          evidence: galleryEvidence,
        },
        text: {
          status: textCheckpoint
            ? "VERIFIED_POINT_IN_TIME"
            : "NOT_APPLIED_CATALOG_BLOCKED",
          stable_post_write_reads: textCheckpoint?.stableReads ?? null,
          evidence: textCheckpoint
            ? evidence("text_structured_verified_checkpoints", textCheckpoint.createdAt, {
                artifact_path: textCheckpoint.path,
                artifact_sha256: textCheckpoint.sha256,
              })
            : evidence("text_structured_selection", selectionCreatedAt),
        },
        structured_attributes: {
          status: structuredCheckpoint
            ? "VERIFIED_POINT_IN_TIME"
            : "NOT_APPLIED_CATALOG_BLOCKED",
          stable_post_write_reads: structuredCheckpoint?.stableReads ?? null,
          evidence: structuredCheckpoint
            ? evidence(
                "text_structured_verified_checkpoints",
                structuredCheckpoint.createdAt,
                {
                  artifact_path: structuredCheckpoint.path,
                  artifact_sha256: structuredCheckpoint.sha256,
                },
              )
            : evidence("text_structured_selection", selectionCreatedAt),
        },
        amazon_pricing: {
          status: `${reconciliationStatus}_POINT_IN_TIME`,
          reconciliation_status: reconciliationStatus,
          canonical_base_price: mustNumber(
            auditedCanonicalBase ?? desiredPrice,
            `${entry.sku} canonical base`,
          ),
          canonical_floor_price: mustNumber(
            auditedCanonicalFloor ?? desiredFloor,
            `${entry.sku} canonical floor`,
          ),
          canonical_price_basis:
            auditedCanonicalBase != null && auditedCanonicalFloor != null
              ? "LIVE_AUDIT"
              : "AUTHORITATIVE_PLAN_FALLBACK",
          observed_effective_price: nullableNumber(observation.effective_live_price),
          evidence: evidence("amazon_live_pricing", pricingObservedAt, {
            row_evidence_sha256: sha256(stableJson(pricing)),
          }),
        },
        launch_promotion: {
          status: launchStatus,
          arm: launch ? nullableString(launch.arm) : null,
          lever: launch ? nullableString(launch.lever) : null,
          effective_price: launch ? nullableNumber(launch.effective_price) : null,
          discount_percent: launch ? nullableNumber(launch.discount_percent) : null,
          start_at: launchSchedule
            ? nullableString(launchSchedule.start_at)
            : launchStatus === "PROPOSED_NOT_OWNER_APPROVED_OR_APPLIED"
              ? nullableString(
                  mustRecord(launchPricing.value.scope, "launch scope").start_at,
                )
              : null,
          end_at: launchSchedule
            ? nullableString(launchSchedule.end_at)
            : launchStatus === "PROPOSED_NOT_OWNER_APPROVED_OR_APPLIED"
              ? nullableString(
                  mustRecord(launchPricing.value.scope, "launch scope").end_at,
                )
              : null,
          evidence: evidence("launch_pricing_v4_proposal", launchReviewedAt, {
            row_evidence_sha256: launch ? sha256(stableJson(launch)) : undefined,
          }),
        },
        channelmax: {
          status: channelStatus,
          repricing_status: repricingStatus,
          observed_asin: channelAsin,
          identity_exact_match: channelIdentityExact,
          model_id: modelId,
          model_name: modelName,
          canonical_manual_model_id: canonicalManualModelId,
          desired: {
            price: desiredPrice,
            floor: desiredFloor,
            ceiling: desiredCeiling,
          },
          observed: {
            price: observedChannelPrice,
            floor: observedChannelFloor,
            ceiling: observedChannelCeiling,
          },
          exact_match: {
            price: exactMoney(observedChannelPrice, desiredPrice),
            floor: floorMatches,
            ceiling: ceilingMatches,
          },
          evidence: evidence("channelmax_inventory_snapshot", channelCapturedAt, {
            row_evidence_sha256: sha256(stableJson(channel)),
          }),
        },
        overall: {
          readiness: "NOT_PROVEN_IDEAL",
          primary_blocker: primaryBlocker,
          blocker_codes: [...blockerCodes].sort(),
          latest_evidence_at: latestInstant(rowEvidenceTimes),
        },
      } satisfies UncrustablesCompletionMatrixRow;
    },
  );

  const summary: UncrustablesCompletionMatrixSummary = {
    total_rows: rows.length,
    proven_ideal_rows: 0,
    ready_to_publish_rows: 0,
    catalog_status: countBy(rows.map((row) => row.catalog.status)),
    main_image_status: countBy(rows.map((row) => row.main_image.status)),
    main_repair_readiness: countBy(
      rows.map((row) => row.main_image.repair_readiness),
    ),
    gallery_status: countBy(rows.map((row) => row.gallery.status)),
    text_status: countBy(rows.map((row) => row.text.status)),
    structured_attributes_status: countBy(
      rows.map((row) => row.structured_attributes.status),
    ),
    amazon_pricing_status: countBy(rows.map((row) => row.amazon_pricing.status)),
    launch_promotion_status: countBy(
      rows.map((row) => row.launch_promotion.status),
    ),
    channelmax_status: countBy(rows.map((row) => row.channelmax.status)),
    primary_blockers: countBy(rows.map((row) => row.overall.primary_blocker)),
    evidence_caveat:
      "Every live Amazon or ChannelMAX observation is point-in-time evidence. It does not prove current state after the timestamp. No row is marked ideal until MAIN provenance, gallery wording/readback, current pricing, approved/applied launch promotion, safe ChannelMAX control, and delayed end-to-end readback all pass.",
  };

  const summarySeed = {
    matrix_id: matrixId,
    deterministic_as_of: deterministicAsOf,
    summary,
  };
  const csv = completionMatrixRowsToCsv(rows);
  const summaryMarkdown = renderCompletionMatrixSummary(summarySeed);
  const body: Omit<UncrustablesCompletionMatrix, "body_sha256"> = {
    schema_version: UNCRUSTABLES_COMPLETION_MATRIX_SCHEMA,
    immutable: true,
    read_only: true,
    matrix_id: matrixId,
    deterministic_as_of: deterministicAsOf,
    source_bundle_sha256: sourceBundleSha256,
    policy: {
      exact_scope_required: 164,
      external_reads_performed: false,
      external_mutations_performed: false,
      point_in_time_evidence_is_not_current_state_proof: true,
      no_row_ideal_without_all_gates_and_delayed_readback: true,
    },
    sources: sourceEvidence,
    summary,
    rows,
    output_artifacts: {
      csv_sha256: sha256(csv),
      summary_markdown_sha256: sha256(summaryMarkdown),
    },
  };
  const matrix: UncrustablesCompletionMatrix = {
    ...body,
    body_sha256: sha256(stableJson(body)),
  };
  return { matrix, csv, summaryMarkdown };
}

function source(
  artifact: LoadedArtifact,
  sourceId: string,
  observedAt: string,
): SourceEvidence {
  return {
    source_id: sourceId,
    path: artifact.path,
    file_sha256: artifact.fileSha256,
    body_sha256: artifact.bodySha256,
    observed_at: observedAt,
    point_in_time: true,
  };
}

function indexRows(
  rawRows: unknown,
  label: string,
  identities: Map<string, { sku: string; asin: string }>,
  options: { allowAsinMismatch?: boolean } = {},
): Map<string, JsonObject> {
  const rows = mustArray(rawRows, label);
  const output = new Map<string, JsonObject>();
  for (const [index, raw] of rows.entries()) {
    const row = mustRecord(raw, `${label}[${index}]`);
    const sku = mustString(row.sku, `${label}[${index}].sku`);
    const asin = mustString(row.asin, `${label}[${index}].asin`);
    if (!identities.has(sku) || (!options.allowAsinMismatch && identities.get(sku)?.asin !== asin)) {
      throw new Error(`${label} identity mismatch for ${sku}/${asin}.`);
    }
    if (output.has(sku)) throw new Error(`${label} duplicate SKU ${sku}.`);
    output.set(sku, row);
  }
  if (output.size !== identities.size || !exactSet(output.keys(), identities.keys())) {
    throw new Error(`${label} must cover the exact authoritative 164-SKU scope.`);
  }
  return output;
}

function indexSubsetRows(
  rawRows: unknown,
  label: string,
  identities: Map<string, { sku: string; asin: string }>,
): Map<string, JsonObject> {
  const rows = mustArray(rawRows, label);
  const output = new Map<string, JsonObject>();
  for (const [index, raw] of rows.entries()) {
    const row = mustRecord(raw, `${label}[${index}]`);
    const sku = mustString(row.sku, `${label}[${index}].sku`);
    const asin = mustString(row.asin, `${label}[${index}].asin`);
    if (identities.get(sku)?.asin !== asin) {
      throw new Error(`${label} identity mismatch for ${sku}/${asin}.`);
    }
    if (output.has(sku)) throw new Error(`${label} duplicate SKU ${sku}.`);
    output.set(sku, row);
  }
  return output;
}
