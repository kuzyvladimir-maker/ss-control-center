import {
  GALLERY_MEDIA_FORBIDDEN_PATCH_PATHS,
  GALLERY_MEDIA_ONLY_PROFILE,
  sha256,
  stableJson,
} from "./uncrustables-surgical";

export const MINIMAL_GALLERY_HELD_SELECTION_SCHEMA =
  "uncrustables-minimal-gallery-held-selection/v1" as const;
export const MINIMAL_GALLERY_RELEASE_BUNDLE_SCHEMA =
  "uncrustables-minimal-gallery-release-bundle/v1" as const;

const GALLERY_PATH = /^\/attributes\/other_product_image_locator_([1-8])$/;
const SHA256 = /^[a-f0-9]{64}$/;
const EXACT_ALLOWED_PATCH_PATHS = [
  "/attributes/other_product_image_locator_1",
  "/attributes/other_product_image_locator_2",
  "/attributes/other_product_image_locator_3",
  "/attributes/other_product_image_locator_4",
  "/attributes/other_product_image_locator_5",
  "/attributes/other_product_image_locator_7",
] as const;
const EXACT_CAS_SCOPE = {
  "SZ-ASPI-JFAT": {
    asin: "B0H776M5B5",
    paths: EXACT_ALLOWED_PATCH_PATHS.slice(1, 5),
  },
  "UA-ASAO-RE7Q": {
    asin: "B0H784LMG6",
    paths: [EXACT_ALLOWED_PATCH_PATHS[0], EXACT_ALLOWED_PATCH_PATHS[5]],
  },
  "VC-ASV1-378P": {
    asin: "B0H786L5MW",
    paths: [EXACT_ALLOWED_PATCH_PATHS[0], EXACT_ALLOWED_PATCH_PATHS[5]],
  },
} as const;

type UnknownRecord = Record<string, unknown>;

export interface MinimalGalleryCasPath {
  path: string;
  before: {
    present: boolean;
    value?: unknown;
    sha256: string;
  };
  desired_url: string;
}

export interface MinimalGalleryCasRow {
  sku: string;
  asin: string;
  store_index: 1;
  listing_sha256: string;
  touched_paths: MinimalGalleryCasPath[];
  cas_sha256: string;
}

export interface MinimalGalleryHeldSelection {
  schema_version: typeof MINIMAL_GALLERY_HELD_SELECTION_SCHEMA;
  immutable: true;
  created_at: string;
  execution_authorized: false;
  confirmation_token: null;
  confirmation_token_emitted: false;
  profile: typeof GALLERY_MEDIA_ONLY_PROFILE;
  source_plan: {
    path: string;
    sha256: string;
  };
  selected_skus: ["SZ-ASPI-JFAT"];
  selected_action_ids: ["SZ-ASPI-JFAT:media"];
  selected_actions: 1;
  allowed_patch_paths: string[];
  forbidden_patch_paths: string[];
  current_cas: MinimalGalleryCasRow;
  identity_hold: {
    evidence_path: string;
    evidence_file_sha256: string;
    status: "HOLD_IDENTITY";
    amazon_asin: "B0H776M5B5";
    channelmax_asin: string;
    reason_codes: string[];
  };
  would_be_standard_selection_sha256: string;
  release_requirements: string[];
  sha256: string;
}

export interface MinimalGalleryReleaseBundle {
  schema_version: typeof MINIMAL_GALLERY_RELEASE_BUNDLE_SCHEMA;
  immutable: true;
  created_at: string;
  offline_only: true;
  external_mutations: {
    amazon_gets: 0;
    amazon_patches: 0;
    database_writes: 0;
    uploads: 0;
    channelmax_writes: 0;
  };
  source_artifacts: Record<string, {
    path: string;
    file_sha256: string;
    canonical_sha256?: string;
  }>;
  repair_plan: {
    path: string;
    file_sha256: string;
    canonical_sha256: string;
    entries: 3;
    actions: 3;
    action_kinds: ["MEDIA"];
  };
  safety_boundary: {
    profile: typeof GALLERY_MEDIA_ONLY_PROFILE;
    allowed_patch_path_pattern: string;
    allowed_patch_paths: string[];
    forbidden_patch_paths: string[];
    main_actions: 0;
    text_actions: 0;
    structured_actions: 0;
    offer_actions: 0;
  };
  current_cas: {
    source_snapshot_path: string;
    source_snapshot_file_sha256: string;
    source_snapshot_canonical_sha256: string;
    apply_eligible_for_this_plan: false;
    reason: string;
    rows: MinimalGalleryCasRow[];
    rows_sha256: string;
  };
  fresh_rollback_prerequisite: {
    status: "REQUIRED_NOT_PRESENT";
    exact_scope: 164;
    capture_mode: "LIVE_SP_API";
    source_ledger_sha256: string;
    reviewed_manifest_sha256: string;
    selected_canary_selection_sha256: string;
    maximum_age_minutes_before_first_write: number;
    full_image_binary_evidence_required: true;
    selection_scoped_rollback_required: true;
    exact_capture_command: string;
  };
  canary: {
    execution_authorized_now: false;
    authorization_blocker: "FRESH_164_SELECTION_SCOPED_ROLLBACK_NOT_PRESENT";
    skus: ["UA-ASAO-RE7Q", "VC-ASV1-378P"];
    action_ids: ["UA-ASAO-RE7Q:media", "VC-ASV1-378P:media"];
    selection_path: string;
    selection_file_sha256: string;
    selection_sha256: string;
    confirmation_token: string;
    required_sequence: string[];
  };
  held_sz: {
    execution_authorized: false;
    selection_path: string;
    selection_file_sha256: string;
    selection_sha256: string;
    release_requires_new_standard_selection: true;
  };
  sha256: string;
}

function isRecord(value: unknown): value is UnknownRecord {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function verifySeal(value: UnknownRecord, label: string): void {
  const claimed = value.sha256;
  assert(typeof claimed === "string" && SHA256.test(claimed), `${label} has no SHA-256 seal.`);
  const body = { ...value };
  delete body.sha256;
  assert(claimed === sha256(stableJson(body)), `${label} SHA-256 seal mismatch.`);
}

export function sealMinimalGalleryArtifact<T extends UnknownRecord>(
  body: T,
): T & { sha256: string } {
  return { ...body, sha256: sha256(stableJson(body)) };
}

export function verifyMinimalGalleryCasRow(row: MinimalGalleryCasRow): void {
  assert(
    row.store_index === 1 &&
      Boolean(row.sku) &&
      Boolean(row.asin) &&
      SHA256.test(row.listing_sha256) &&
      row.touched_paths.length > 0,
    `Invalid minimal-gallery CAS identity for ${row.sku || "<missing>"}.`,
  );
  const paths = row.touched_paths.map((item) => item.path);
  assert(
    new Set(paths).size === paths.length && paths.every((item) => GALLERY_PATH.test(item)),
    `CAS paths crossed the gallery boundary for ${row.sku}.`,
  );
  for (const item of row.touched_paths) {
    assert(
      SHA256.test(item.before.sha256) &&
        typeof item.before.present === "boolean" &&
        (item.before.present
          ? Object.hasOwn(item.before, "value")
          : !Object.hasOwn(item.before, "value")) &&
        typeof item.desired_url === "string" &&
        item.desired_url.startsWith("https://"),
      `Invalid CAS path state for ${row.sku} ${item.path}.`,
    );
    const expectedBefore = item.before.present
      ? { present: true, value: item.before.value }
      : { present: false };
    assert(
      item.before.sha256 === sha256(stableJson(expectedBefore)),
      `CAS before-state SHA mismatch for ${row.sku} ${item.path}.`,
    );
  }
  const { cas_sha256: claimed, ...body } = row;
  assert(
    SHA256.test(claimed) && claimed === sha256(stableJson(body)),
    `CAS row seal mismatch for ${row.sku}.`,
  );
}

export function verifyMinimalGalleryHeldSelection(
  value: MinimalGalleryHeldSelection,
): void {
  assert(isRecord(value), "Held gallery selection must be an object.");
  verifySeal(value as unknown as UnknownRecord, "Held gallery selection");
  assert(
    value.schema_version === MINIMAL_GALLERY_HELD_SELECTION_SCHEMA &&
      value.immutable === true &&
      value.execution_authorized === false &&
      value.confirmation_token === null &&
      value.confirmation_token_emitted === false &&
      value.profile === GALLERY_MEDIA_ONLY_PROFILE &&
      Number.isFinite(Date.parse(value.created_at)),
    "Held SZ selection envelope is invalid or executable.",
  );
  assert(
    stableJson(value.selected_skus) === stableJson(["SZ-ASPI-JFAT"]) &&
      stableJson(value.selected_action_ids) === stableJson(["SZ-ASPI-JFAT:media"]) &&
      value.selected_actions === 1,
    "Held SZ selection scope is not exact.",
  );
  assert(
    value.allowed_patch_paths.length === 4 &&
      stableJson(value.allowed_patch_paths) ===
        stableJson([
          "/attributes/other_product_image_locator_2",
          "/attributes/other_product_image_locator_3",
          "/attributes/other_product_image_locator_4",
          "/attributes/other_product_image_locator_5",
        ]) &&
      stableJson(value.forbidden_patch_paths) ===
        stableJson(GALLERY_MEDIA_FORBIDDEN_PATCH_PATHS) &&
      value.allowed_patch_paths.every(
        (patchPath) =>
          GALLERY_PATH.test(patchPath) &&
          !value.forbidden_patch_paths.includes(patchPath),
      ),
    "Held SZ selection crossed its exact gallery-only boundary.",
  );
  assert(
    value.identity_hold.status === "HOLD_IDENTITY" &&
      value.identity_hold.amazon_asin === "B0H776M5B5" &&
      value.identity_hold.channelmax_asin === "B0H75VN18Z" &&
      value.identity_hold.reason_codes.includes("CHANNELMAX_IDENTITY_MISMATCH") &&
      SHA256.test(value.identity_hold.evidence_file_sha256) &&
      SHA256.test(value.would_be_standard_selection_sha256) &&
      value.release_requirements.length > 0,
    "Held SZ selection is not bound to the exact identity blocker.",
  );
  verifyMinimalGalleryCasRow(value.current_cas);
}

export function verifyMinimalGalleryReleaseBundle(
  value: MinimalGalleryReleaseBundle,
): void {
  assert(isRecord(value), "Minimal gallery release bundle must be an object.");
  verifySeal(value as unknown as UnknownRecord, "Minimal gallery release bundle");
  assert(
    value.schema_version === MINIMAL_GALLERY_RELEASE_BUNDLE_SCHEMA &&
      value.immutable === true &&
      value.offline_only === true &&
      Number.isFinite(Date.parse(value.created_at)) &&
      stableJson(value.external_mutations) ===
        stableJson({
          amazon_gets: 0,
          amazon_patches: 0,
          database_writes: 0,
          uploads: 0,
          channelmax_writes: 0,
        }),
    "Minimal gallery release bundle envelope is invalid.",
  );
  assert(
    value.repair_plan.entries === 3 &&
      value.repair_plan.actions === 3 &&
      stableJson(value.repair_plan.action_kinds) === stableJson(["MEDIA"]) &&
      SHA256.test(value.repair_plan.file_sha256) &&
      SHA256.test(value.repair_plan.canonical_sha256),
    "Minimal gallery release plan scope is not exactly three MEDIA actions.",
  );
  assert(
    value.safety_boundary.profile === GALLERY_MEDIA_ONLY_PROFILE &&
      value.safety_boundary.allowed_patch_path_pattern ===
        "^/attributes/other_product_image_locator_[1-8]$" &&
      stableJson(value.safety_boundary.allowed_patch_paths) ===
        stableJson(EXACT_ALLOWED_PATCH_PATHS) &&
      stableJson(value.safety_boundary.forbidden_patch_paths) ===
        stableJson(GALLERY_MEDIA_FORBIDDEN_PATCH_PATHS) &&
      value.safety_boundary.allowed_patch_paths.every(
        (patchPath) =>
          GALLERY_PATH.test(patchPath) &&
          !value.safety_boundary.forbidden_patch_paths.includes(patchPath),
      ) &&
      value.safety_boundary.main_actions === 0 &&
      value.safety_boundary.text_actions === 0 &&
      value.safety_boundary.structured_actions === 0 &&
      value.safety_boundary.offer_actions === 0,
    "Minimal gallery release safety boundary was weakened.",
  );
  assert(
    value.current_cas.apply_eligible_for_this_plan === false &&
      value.current_cas.rows.length === 3 &&
      stableJson(value.current_cas.rows.map((row) => row.sku)) ===
        stableJson(Object.keys(EXACT_CAS_SCOPE)),
    "Current CAS evidence must cover exactly three rows without authorizing apply.",
  );
  for (const row of value.current_cas.rows) {
    verifyMinimalGalleryCasRow(row);
    const exact = EXACT_CAS_SCOPE[row.sku as keyof typeof EXACT_CAS_SCOPE];
    assert(
      exact != null &&
        row.asin === exact.asin &&
        stableJson(row.touched_paths.map((item) => item.path)) ===
          stableJson(exact.paths),
      `Current CAS evidence is not the exact expected scope for ${row.sku}.`,
    );
  }
  assert(
    value.current_cas.rows_sha256 === sha256(stableJson(value.current_cas.rows)),
    "Current CAS row-set SHA mismatch.",
  );
  assert(
    value.fresh_rollback_prerequisite.status === "REQUIRED_NOT_PRESENT" &&
      value.fresh_rollback_prerequisite.exact_scope === 164 &&
      value.fresh_rollback_prerequisite.capture_mode === "LIVE_SP_API" &&
      value.fresh_rollback_prerequisite.full_image_binary_evidence_required === true &&
      value.fresh_rollback_prerequisite.selection_scoped_rollback_required === true &&
      value.fresh_rollback_prerequisite.maximum_age_minutes_before_first_write > 0 &&
      value.fresh_rollback_prerequisite.maximum_age_minutes_before_first_write <= 60 &&
      SHA256.test(value.fresh_rollback_prerequisite.source_ledger_sha256) &&
      SHA256.test(value.fresh_rollback_prerequisite.reviewed_manifest_sha256) &&
      SHA256.test(value.fresh_rollback_prerequisite.selected_canary_selection_sha256) &&
      value.fresh_rollback_prerequisite.source_ledger_sha256 ===
        value.source_artifacts.source_ledger.file_sha256 &&
      value.fresh_rollback_prerequisite.reviewed_manifest_sha256 ===
        value.source_artifacts.reviewed_manifest.file_sha256 &&
      value.fresh_rollback_prerequisite.selected_canary_selection_sha256 ===
        value.canary.selection_sha256,
    "Fresh exact 164-row rollback prerequisite is missing or weakened.",
  );
  assert(
    value.canary.execution_authorized_now === false &&
      value.canary.authorization_blocker ===
        "FRESH_164_SELECTION_SCOPED_ROLLBACK_NOT_PRESENT" &&
      stableJson(value.canary.skus) ===
        stableJson(["UA-ASAO-RE7Q", "VC-ASV1-378P"]) &&
      stableJson(value.canary.action_ids) ===
        stableJson(["UA-ASAO-RE7Q:media", "VC-ASV1-378P:media"]) &&
      SHA256.test(value.canary.selection_file_sha256) &&
      SHA256.test(value.canary.selection_sha256) &&
      value.canary.required_sequence.some((step) => step.includes("VALIDATION_PREVIEW")) &&
      value.canary.required_sequence.some((step) => step.includes("immediate readback")) &&
      value.canary.required_sequence.some((step) => step.includes("delayed readback")),
    "Canary release contract is not fail-closed.",
  );
  assert(
    value.held_sz.execution_authorized === false &&
      value.held_sz.release_requires_new_standard_selection === true &&
      SHA256.test(value.held_sz.selection_file_sha256) &&
      SHA256.test(value.held_sz.selection_sha256),
    "SZ held selection was accidentally authorized.",
  );
}
