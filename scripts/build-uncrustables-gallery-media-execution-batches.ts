/**
 * Build the exact immutable MEDIA-only rollout selections for the remaining
 * final-v8 Uncrustables gallery actions. This command is deliberately offline:
 * it reads sealed local plans/checkpoints and writes local selection evidence;
 * it never performs an Amazon GET/PATCH or starts an execution loop.
 *
 *   npx tsx scripts/build-uncrustables-gallery-media-execution-batches.ts \
 *     --created-at=2026-07-18T12:50:00.000Z
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  GALLERY_MEDIA_FORBIDDEN_PATCH_PATHS,
  GALLERY_MEDIA_ONLY_PROFILE,
  readRepairExecutionSelection,
  readRepairPlan,
  repairExecutionSelection,
  sha256,
  stableJson,
  verifyRepairExecutionSelection,
  writeImmutableRepairExecutionSelection,
  type CheckpointEvent,
  type UncrustablesRepairPlan,
} from "@/lib/bundle-factory/repair/uncrustables-surgical";

const APP_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PLAN_PATH =
  "data/repairs/generated/uncrustables-amazon-final-162-20260718-v8/URP-20260718T083203612Z-8badb989fc9b.json";
const PLAN_INTERNAL_SHA256 =
  "8badb989fc9bc5ee9c7ced63029ef9c8cea01d1b494c5766330709dfcf17c477";
const PLAN_FILE_SHA256 =
  "d99a5416fc7f62fd5da8fefed497924ff5757b81ece9b6fbdaf6dd55d8652662";
const PREVIEW_DIRECTORY =
  "data/repairs/checkpoints/final-validation-preview-162-20260718-v8/8badb989fc9bc5ee9c7c";
const AD_VERIFIED_CHECKPOINT =
  "data/repairs/checkpoints/8badb989fc9bc5ee9c7c/20260718T123005688Z-AD-AS4H-QXZD_media-VERIFIED-7f8cb8d8-b998-4bed-9c54-e16fafb34ae5.json";
const DEFAULT_OUTPUT_DIRECTORY =
  "data/repairs/execution-selections/uncrustables-gallery-media-remaining-118-20260718-v1";
const INDEX_SCHEMA =
  "uncrustables-gallery-media-execution-batches/v1" as const;

const ALREADY_VERIFIED_SKU = "AD-AS4H-QXZD";
const BLOCKED_SKUS = ["TY-AST2-JE9P", "VN-AS1A-D572"] as const;
const CANARIES = [
  { label: "canary-az", sku: "AZ-ASMY-VEQ2" },
  { label: "canary-ag", sku: "AG-ASKV-W9EN" },
  { label: "canary-zx", sku: "ZX-ASQU-TKU9" },
] as const;
const GALLERY_PATCH_PATH =
  /^\/attributes\/other_product_image_locator_([1-8])$/;

interface CliOptions {
  createdAt: Date;
  outputDirectory: string;
}

interface MediaActionEvidence {
  sku: string;
  actionId: string;
  replacementPaths: string[];
  deletionPaths: string[];
  allowedPaths: string[];
  expectedByField: Record<string, string | null>;
}

interface CheckpointEvidence {
  path: string;
  file_sha256: string;
  checkpoint_sha256: string;
  event_id: string;
  created_at: string;
  action_id: string;
  sku: string;
  kind: string;
  status: string;
  patch_sha256: string | null;
  patch_paths: string[];
}

interface BatchSpec {
  sequence: number;
  label: string;
  skus: string[];
}

interface BatchRecord {
  sequence: number;
  label: string;
  expected_size: number;
  skus: string[];
  action_ids: string[];
  selection_path: string;
  selection_file_sha256: string;
  selection_sha256: string;
  confirmation_token: string;
  profile: string;
  validation_preview_set_sha256: string;
}

function usage(): string {
  return [
    "Usage: npx tsx scripts/build-uncrustables-gallery-media-execution-batches.ts --created-at=ISO [options]",
    "",
    "  --created-at=ISO       One non-future timestamp sealed into every selection (required).",
    `  --output-dir=PATH      New immutable output directory (default ${DEFAULT_OUTPUT_DIRECTORY}).`,
    "  --help                 Show this help.",
    "",
    "Offline only: no Amazon GET/PATCH, bulk execution, DB mutation, upload, or rollback capture.",
  ].join("\n");
}

function parseArgs(argv: string[]): CliOptions {
  let createdAt: Date | null = null;
  let outputDirectory = DEFAULT_OUTPUT_DIRECTORY;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg.startsWith("--created-at=")) {
      createdAt = new Date(arg.slice("--created-at=".length));
    } else if (arg.startsWith("--output-dir=")) {
      outputDirectory = arg.slice("--output-dir=".length).trim();
    } else {
      throw new Error(`Unknown option: ${arg}\n\n${usage()}`);
    }
  }
  if (!createdAt || !Number.isFinite(createdAt.getTime())) {
    throw new Error("--created-at=ISO is required and must be a valid timestamp.");
  }
  if (createdAt.getTime() > Date.now()) {
    throw new Error("--created-at cannot be in the future.");
  }
  if (!outputDirectory) throw new Error("--output-dir cannot be empty.");
  return { createdAt, outputDirectory };
}

function absolute(repoPath: string): string {
  return path.resolve(APP_ROOT, repoPath);
}

function relativeToApp(file: string): string {
  const relative = path.relative(APP_ROOT, path.resolve(file));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Artifact path escapes app root: ${file}`);
  }
  return relative.split(path.sep).join("/");
}

function fileSha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function stringArray(value: unknown, label: string): string[] {
  assert(
    Array.isArray(value) && value.every((item) => typeof item === "string"),
    `${label} must be a string array.`,
  );
  return value;
}

function checkpointDetail(event: CheckpointEvent): Record<string, unknown> {
  assert(
    event.detail != null &&
      typeof event.detail === "object" &&
      !Array.isArray(event.detail),
    `Checkpoint ${event.event_id} detail must be an object.`,
  );
  return event.detail;
}

async function readSealedCheckpoint(
  repoPath: string,
): Promise<{ event: CheckpointEvent; evidence: CheckpointEvidence }> {
  const bytes = await readFile(absolute(repoPath));
  const event = JSON.parse(bytes.toString("utf8")) as CheckpointEvent;
  assert(
    event.schema_version === "uncrustables-surgical-checkpoint/v1" &&
      event.immutable === true,
    `Invalid checkpoint envelope: ${repoPath}`,
  );
  const { sha256: claimedSha256, ...body } = event;
  assert(
    /^[a-f0-9]{64}$/.test(claimedSha256) &&
      claimedSha256 === sha256(stableJson(body)),
    `Checkpoint seal mismatch: ${repoPath}`,
  );
  const detail = checkpointDetail(event);
  const patchPaths = Array.isArray(detail.patch_paths)
    ? stringArray(detail.patch_paths, `${event.action_id} patch_paths`)
    : [];
  const patchSha256 =
    typeof detail.patch_sha256 === "string" ? detail.patch_sha256 : null;
  return {
    event,
    evidence: {
      path: repoPath,
      file_sha256: fileSha256(bytes),
      checkpoint_sha256: claimedSha256,
      event_id: event.event_id,
      created_at: event.created_at,
      action_id: event.action_id,
      sku: event.sku,
      kind: event.kind,
      status: event.status,
      patch_sha256: patchSha256,
      patch_paths: patchPaths,
    },
  };
}

function collectMediaActions(
  plan: UncrustablesRepairPlan,
): Map<string, MediaActionEvidence> {
  const byAction = new Map<string, MediaActionEvidence>();
  for (const entry of plan.entries) {
    for (const action of entry.actions) {
      if (action.kind !== "MEDIA") continue;
      assert(
        action.desired.kind === "MEDIA",
        `${action.action_id} has a mismatched desired kind.`,
      );
      assert(
        action.desired.value.main_image_url == null &&
          action.desired.value.main_image_sha256 == null,
        `${action.action_id} contains a forbidden MAIN image.`,
      );
      const replacementPaths = action.desired.value.gallery_slots.map(
        ({ slot }) => `/attributes/other_product_image_locator_${slot}`,
      );
      const deletionPaths = (action.desired.value.delete_gallery_slots ?? []).map(
        (slot) => `/attributes/other_product_image_locator_${slot}`,
      );
      const allowedPaths = [...new Set([...replacementPaths, ...deletionPaths])].sort();
      const expectedByField: Record<string, string | null> = {};
      for (const { slot, url } of action.desired.value.gallery_slots) {
        expectedByField[`other_product_image_locator_${slot}`] = url;
      }
      for (const slot of action.desired.value.delete_gallery_slots ?? []) {
        expectedByField[`other_product_image_locator_${slot}`] = null;
      }
      assert(
        replacementPaths.length > 0 &&
          allowedPaths.every((patchPath) => GALLERY_PATCH_PATH.test(patchPath)) &&
          allowedPaths.length === replacementPaths.length + deletionPaths.length,
        `${action.action_id} is not an exact non-overlapping secondary gallery action.`,
      );
      assert(!byAction.has(action.action_id), `Duplicate action ${action.action_id}.`);
      byAction.set(action.action_id, {
        sku: entry.sku,
        actionId: action.action_id,
        replacementPaths: [...replacementPaths].sort(),
        deletionPaths: [...deletionPaths].sort(),
        allowedPaths,
        expectedByField,
      });
    }
  }
  return byAction;
}

async function validatePreviewEvidence(
  planMediaActions: Map<string, MediaActionEvidence>,
): Promise<Map<string, CheckpointEvidence>> {
  const entries = await readdir(absolute(PREVIEW_DIRECTORY), {
    withFileTypes: true,
  });
  const byAction = new Map<string, CheckpointEvidence[]>();
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const repoPath = `${PREVIEW_DIRECTORY}/${entry.name}`;
    const { event, evidence } = await readSealedCheckpoint(repoPath);
    if (event.kind !== "MEDIA") continue;
    assert(
      event.status === "PREVIEW_VALID" &&
        event.plan_sha256 === PLAN_INTERNAL_SHA256,
      `MEDIA checkpoint is not a final-v8 PREVIEW_VALID event: ${repoPath}`,
    );
    const planned = planMediaActions.get(event.action_id);
    assert(planned, `Unexpected MEDIA preview action: ${event.action_id}`);
    assert(
      event.sku === planned.sku && event.action_id === `${event.sku}:media`,
      `MEDIA preview identity mismatch: ${event.action_id}`,
    );
    const detail = checkpointDetail(event);
    const patchPaths = evidence.patch_paths;
    assert(
      typeof detail.patch_sha256 === "string" &&
        /^[a-f0-9]{64}$/.test(detail.patch_sha256) &&
        detail.validation_only === true &&
        detail.status === "VALID" &&
        Array.isArray(detail.issues) &&
        detail.issues.length === 0,
      `MEDIA preview validation evidence is incomplete: ${event.action_id}`,
    );
    assert(
      patchPaths.length > 0 &&
        new Set(patchPaths).size === patchPaths.length &&
        patchPaths.every(
          (patchPath) =>
            GALLERY_PATCH_PATH.test(patchPath) &&
            planned.allowedPaths.includes(patchPath),
        ) &&
        planned.replacementPaths.every((patchPath) =>
          patchPaths.includes(patchPath),
        ),
      `MEDIA preview crossed its exact gallery path boundary: ${event.action_id}`,
    );
    const current = byAction.get(event.action_id) ?? [];
    current.push(evidence);
    byAction.set(event.action_id, current);
  }
  assert(
    byAction.size === planMediaActions.size,
    `Expected ${planMediaActions.size} MEDIA previews, found ${byAction.size}.`,
  );
  const exact = new Map<string, CheckpointEvidence>();
  for (const actionId of [...planMediaActions.keys()].sort()) {
    const evidence = byAction.get(actionId) ?? [];
    assert(
      evidence.length === 1,
      `Expected exactly one MEDIA preview for ${actionId}, found ${evidence.length}.`,
    );
    exact.set(actionId, evidence[0]);
  }
  return exact;
}

async function validateAdVerified(
  planMediaActions: Map<string, MediaActionEvidence>,
): Promise<CheckpointEvidence> {
  const { event, evidence } = await readSealedCheckpoint(AD_VERIFIED_CHECKPOINT);
  const actionId = `${ALREADY_VERIFIED_SKU}:media`;
  const planned = planMediaActions.get(actionId);
  assert(planned, `${actionId} is absent from the final-v8 MEDIA action set.`);
  assert(
    event.plan_sha256 === PLAN_INTERNAL_SHA256 &&
      event.action_id === actionId &&
      event.sku === ALREADY_VERIFIED_SKU &&
      event.kind === "MEDIA" &&
      event.status === "VERIFIED",
    "AD verified checkpoint identity/status mismatch.",
  );
  const detail = checkpointDetail(event);
  const settlementGuard = detail.settlement_guard;
  assert(
    settlementGuard != null &&
      typeof settlementGuard === "object" &&
      !Array.isArray(settlementGuard),
    "AD verified checkpoint lacks settlement_guard.",
  );
  const exactPaths = stringArray(
    (settlementGuard as Record<string, unknown>).exact_action_paths,
    "AD exact_action_paths",
  );
  assert(
    exactPaths.length > 0 &&
      exactPaths.every(
        (patchPath) =>
          GALLERY_PATCH_PATH.test(patchPath) &&
          planned.allowedPaths.includes(patchPath),
      ),
    "AD verified checkpoint crossed the gallery-only boundary.",
  );
  assert(Array.isArray(detail.checks), "AD verified checkpoint lacks checks.");
  for (let slot = 1; slot <= 8; slot++) {
    const field = `other_product_image_locator_${slot}`;
    const check = (detail.checks as unknown[]).find(
      (candidate) =>
        candidate != null &&
        typeof candidate === "object" &&
        !Array.isArray(candidate) &&
        (candidate as Record<string, unknown>).field === field,
    ) as Record<string, unknown> | undefined;
    assert(check && check.ok === true, `AD verified checkpoint lacks ${field}.`);
    assert(
      stableJson(check.expected) === stableJson(check.actual),
      `AD verified checkpoint expected/actual mismatch for ${field}.`,
    );
    assert(
      stableJson(check.expected) ===
        stableJson(planned.expectedByField[field] ?? null),
      `AD verified checkpoint differs from the sealed plan for ${field}.`,
    );
  }
  return {
    ...evidence,
    patch_paths: [...exactPaths].sort(),
    patch_sha256:
      typeof (settlementGuard as Record<string, unknown>).actual_patch_sha256 ===
      "string"
        ? ((settlementGuard as Record<string, unknown>)
            .actual_patch_sha256 as string)
        : null,
  };
}

function buildBatchSpecs(remainingSkus: string[]): BatchSpec[] {
  const remaining = new Set(remainingSkus);
  const specs: BatchSpec[] = CANARIES.map(({ label, sku }, index) => {
    assert(remaining.delete(sku), `Canary ${sku} is absent or duplicated.`);
    return { sequence: index + 1, label, skus: [sku] };
  });
  const ordered = [...remaining].sort();
  const sizes = [5, 10, 20, 20, 20, 20, 20];
  const labels = [
    "five",
    "ten",
    "twenty-01",
    "twenty-02",
    "twenty-03",
    "twenty-04",
    "twenty-05",
  ];
  let offset = 0;
  sizes.forEach((size, index) => {
    const skus = ordered.slice(offset, offset + size);
    assert(skus.length === size, `Batch ${labels[index]} is short.`);
    specs.push({
      sequence: specs.length + 1,
      label: labels[index],
      skus,
    });
    offset += size;
  });
  assert(offset === ordered.length, "Batch partition did not consume every SKU.");
  assert(
    specs.length === 10 &&
      specs.reduce((sum, batch) => sum + batch.skus.length, 0) === 118,
    "Expected 3 canaries + 5 + 10 + 5x20 = 118.",
  );
  const flattened = specs.flatMap((batch) => batch.skus);
  assert(
    new Set(flattened).size === flattened.length &&
      stableJson([...flattened].sort()) === stableJson([...remainingSkus].sort()),
    "Batch selections overlap or do not fully cover the remaining SKU set.",
  );
  return specs;
}

async function writeSha256Sidecar(file: string, digest: string): Promise<string> {
  const sidecar = `${file}.sha256`;
  await writeFile(sidecar, `${digest}  ${path.basename(file)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return sidecar;
}

function checkpointSetSha256(evidence: CheckpointEvidence[]): string {
  return sha256(
    stableJson(
      [...evidence]
        .sort((left, right) => left.action_id.localeCompare(right.action_id))
        .map((item) => ({
          action_id: item.action_id,
          checkpoint_sha256: item.checkpoint_sha256,
          file_sha256: item.file_sha256,
          patch_sha256: item.patch_sha256,
          patch_paths: item.patch_paths,
        })),
    ),
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const planBytes = await readFile(absolute(PLAN_PATH));
  assert(
    fileSha256(planBytes) === PLAN_FILE_SHA256,
    "Pinned final-v8 repair-plan file SHA mismatch.",
  );
  const plan = await readRepairPlan(absolute(PLAN_PATH));
  assert(
    plan.sha256 === PLAN_INTERNAL_SHA256,
    "Pinned final-v8 repair-plan canonical SHA mismatch.",
  );
  const planMediaActions = collectMediaActions(plan);
  assert(
    planMediaActions.size === 119,
    `Expected 119 final-v8 MEDIA actions, found ${planMediaActions.size}.`,
  );
  for (const blockedSku of BLOCKED_SKUS) {
    assert(
      !plan.entries.some((entry) => entry.sku === blockedSku),
      `Blocked SKU ${blockedSku} unexpectedly entered final-v8.`,
    );
  }

  const previewsByAction = await validatePreviewEvidence(planMediaActions);
  const adVerifiedEvidence = await validateAdVerified(planMediaActions);
  const remainingActions = [...planMediaActions.values()]
    .filter((action) => action.sku !== ALREADY_VERIFIED_SKU)
    .sort((left, right) => left.sku.localeCompare(right.sku));
  assert(
    remainingActions.length === 118 &&
      new Set(remainingActions.map((action) => action.sku)).size === 118,
    "Expected 118 unique MEDIA actions after excluding verified AD.",
  );
  const remainingSkus = remainingActions.map((action) => action.sku);
  for (const excludedSku of [ALREADY_VERIFIED_SKU, ...BLOCKED_SKUS]) {
    assert(
      !remainingSkus.includes(excludedSku),
      `Excluded SKU ${excludedSku} entered the execution scope.`,
    );
  }
  const batchSpecs = buildBatchSpecs(remainingSkus);
  const outputDirectory = absolute(options.outputDirectory);
  relativeToApp(outputDirectory);
  await mkdir(outputDirectory, { recursive: true });

  const batchRecords: BatchRecord[] = [];
  for (const batch of batchSpecs) {
    const selection = repairExecutionSelection(plan, {
      sourcePlanPath: PLAN_PATH,
      createdAt: options.createdAt,
      skus: batch.skus,
      actionKinds: ["MEDIA"],
    });
    verifyRepairExecutionSelection(plan, selection);
    assert(
      selection.profile === GALLERY_MEDIA_ONLY_PROFILE &&
        selection.selected_actions === batch.skus.length &&
        selection.selected_skus.length === batch.skus.length &&
        selection.selected_action_ids.every((actionId) =>
          planMediaActions.has(actionId),
        ) &&
        stableJson([...selection.selected_skus].sort()) ===
          stableJson([...batch.skus].sort()) &&
        stableJson(selection.forbidden_patch_paths) ===
          stableJson(GALLERY_MEDIA_FORBIDDEN_PATCH_PATHS),
      `Selection ${batch.label} violated its exact MEDIA-only scope.`,
    );
    const batchDirectory = path.join(
      outputDirectory,
      `batch-${String(batch.sequence).padStart(2, "0")}-${batch.label}`,
    );
    const selectionFile = await writeImmutableRepairExecutionSelection(
      batchDirectory,
      selection,
    );
    const selectionBytes = await readFile(selectionFile);
    const selectionFileSha256 = fileSha256(selectionBytes);
    await writeSha256Sidecar(selectionFile, selectionFileSha256);
    const roundTrip = await readRepairExecutionSelection(selectionFile, plan);
    assert(
      stableJson(roundTrip) === stableJson(selection),
      `Selection round-trip mismatch: ${batch.label}`,
    );
    const batchPreviewEvidence = selection.selected_action_ids.map((actionId) => {
      const evidence = previewsByAction.get(actionId);
      assert(evidence, `Missing preview evidence for ${actionId}.`);
      return evidence;
    });
    batchRecords.push({
      sequence: batch.sequence,
      label: batch.label,
      expected_size: batch.skus.length,
      skus: selection.selected_skus,
      action_ids: selection.selected_action_ids,
      selection_path: relativeToApp(selectionFile),
      selection_file_sha256: selectionFileSha256,
      selection_sha256: selection.sha256,
      confirmation_token: selection.confirmation_token,
      profile: selection.profile,
      validation_preview_set_sha256:
        checkpointSetSha256(batchPreviewEvidence),
    });
  }

  const allSelectedSkus = batchRecords.flatMap((batch) => batch.skus);
  const allSelectedActions = batchRecords.flatMap((batch) => batch.action_ids);
  assert(
    allSelectedSkus.length === 118 &&
      new Set(allSelectedSkus).size === 118 &&
      allSelectedActions.length === 118 &&
      new Set(allSelectedActions).size === 118 &&
      stableJson([...allSelectedSkus].sort()) ===
        stableJson([...remainingSkus].sort()),
    "Written selections overlap or do not fully cover all remaining actions.",
  );
  const remainingPreviewEvidence = allSelectedActions
    .map((actionId) => previewsByAction.get(actionId)!)
    .sort((left, right) => left.action_id.localeCompare(right.action_id));
  const body = {
    schema_version: INDEX_SCHEMA,
    immutable: true as const,
    created_at: options.createdAt.toISOString(),
    external_mutations: {
      amazon_gets: 0,
      amazon_patches: 0,
      bulk_executions: 0,
      database_writes: 0,
      uploads: 0,
      rollback_captures: 0,
    },
    source_plan: {
      path: PLAN_PATH,
      file_sha256: PLAN_FILE_SHA256,
      canonical_sha256: PLAN_INTERNAL_SHA256,
    },
    execution_scope: {
      profile: GALLERY_MEDIA_ONLY_PROFILE,
      requested_action_kinds: ["MEDIA"],
      selected_skus: 118,
      selected_actions: 118,
      allowed_patch_path_pattern:
        "^/attributes/other_product_image_locator_[1-8]$",
      forbidden_patch_paths: GALLERY_MEDIA_FORBIDDEN_PATCH_PATHS,
      main_paths: 0,
      offer_paths: 0,
      text_paths: 0,
      structured_paths: 0,
    },
    exclusions: {
      already_verified: {
        sku: ALREADY_VERIFIED_SKU,
        action_id: `${ALREADY_VERIFIED_SKU}:media`,
        checkpoint: adVerifiedEvidence,
      },
      outside_final_v8: BLOCKED_SKUS.map((sku) => ({
        sku,
        reason: "ABSENT_FROM_PINNED_FINAL_V8_PLAN",
      })),
    },
    validation_previews: {
      directory: PREVIEW_DIRECTORY,
      final_v8_media_events: previewsByAction.size,
      selected_events: remainingPreviewEvidence.length,
      checkpoint_set_sha256: checkpointSetSha256(remainingPreviewEvidence),
      checkpoints: remainingPreviewEvidence,
    },
    rollout: {
      formula: "1 AZ + 1 AG + 1 ZX + 5 + 10 + 5x20",
      batches: batchRecords.length,
      unique_full_coverage: true,
      disjoint: true,
    },
    batches: batchRecords,
  };
  const canonicalSha256 = sha256(stableJson(body));
  const index = { ...body, sha256: canonicalSha256 };
  const indexFile = path.join(
    outputDirectory,
    `UGMEB-${options.createdAt
      .toISOString()
      .replace(/[-:.]/g, "")}-${canonicalSha256.slice(0, 12)}.json`,
  );
  await writeFile(indexFile, `${JSON.stringify(index, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  const indexBytes = await readFile(indexFile);
  const indexFileSha256 = fileSha256(indexBytes);
  const indexSidecar = await writeSha256Sidecar(indexFile, indexFileSha256);

  const roundTripIndex = JSON.parse(indexBytes.toString("utf8")) as typeof index;
  const { sha256: roundTripClaimed, ...roundTripBody } = roundTripIndex;
  assert(
    roundTripClaimed === sha256(stableJson(roundTripBody)) &&
      roundTripClaimed === canonicalSha256,
    "Batch-index round-trip canonical seal mismatch.",
  );
  for (const batch of batchRecords) {
    const selection = await readRepairExecutionSelection(
      absolute(batch.selection_path),
      plan,
    );
    assert(
      selection.sha256 === batch.selection_sha256 &&
        fileSha256(await readFile(absolute(batch.selection_path))) ===
          batch.selection_file_sha256,
      `Final selection seal mismatch: ${batch.label}`,
    );
  }

  console.log(
    JSON.stringify(
      {
        immutable_batch_index: relativeToApp(indexFile),
        index_file_sha256: indexFileSha256,
        index_canonical_sha256: canonicalSha256,
        index_sidecar: relativeToApp(indexSidecar),
        source_plan_canonical_sha256: plan.sha256,
        profile: GALLERY_MEDIA_ONLY_PROFILE,
        selected_skus: allSelectedSkus.length,
        selected_actions: allSelectedActions.length,
        batches: batchRecords.map((batch) => ({
          sequence: batch.sequence,
          label: batch.label,
          size: batch.skus.length,
          selection_path: batch.selection_path,
          selection_sha256: batch.selection_sha256,
        })),
        validation_preview_events: remainingPreviewEvidence.length,
        excluded: [ALREADY_VERIFIED_SKU, ...BLOCKED_SKUS],
        external_mutations: body.external_mutations,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
