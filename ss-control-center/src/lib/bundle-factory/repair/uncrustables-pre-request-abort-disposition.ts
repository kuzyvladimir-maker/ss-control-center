import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  PRE_REQUEST_ABORT_DISPOSITION_SCHEMA,
  PRE_REQUEST_ABORT_TERMINAL_STATUS,
  preRequestAbortDispositionConfirmationToken,
  preRequestAbortDispositionDigest,
  preRequestAbortFenceReleaseConfirmationToken,
  verifyPreRequestAbortDispositionProposal,
  type PreRequestAbortDispositionProposal,
} from "./uncrustables-pre-request-abort-disposition-contract";
import {
  CANONICAL_UNCRUSTABLES_AMAZON_COORDINATION_DIR,
  CANONICAL_UNCRUSTABLES_FORWARD_CHECKPOINT_ROOT,
  CHECKPOINT_SCHEMA,
  EXACT_PATH_SETTLEMENT_GUARD,
  ImmutableCheckpointStore,
  MAIN_MEDIA_ONLY_PROFILE,
  UNCRUSTABLES_APP_ROOT,
  readRepairExecutionSelection,
  readRepairPlan,
  sha256,
  stableJson,
  type CheckpointEvent,
} from "./uncrustables-surgical";

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function record(value: unknown, label: string): UnknownRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }
  return value;
}

async function readJsonBytes(file: string): Promise<{
  path: string;
  bytes: Buffer;
  value: unknown;
}> {
  const resolved = path.resolve(file);
  const bytes = await readFile(resolved);
  return { path: resolved, bytes, value: JSON.parse(bytes.toString("utf8")) };
}

function validateCheckpointEvent(
  value: unknown,
  expectedPlanSha: string,
): CheckpointEvent {
  const event = value as CheckpointEvent;
  const { sha256: claimed, ...body } = event;
  if (
    event.schema_version !== CHECKPOINT_SCHEMA ||
    event.immutable !== true ||
    event.plan_sha256 !== expectedPlanSha ||
    claimed !== sha256(stableJson(body))
  ) {
    throw new Error("Invalid/tampered checkpoint evidence event.");
  }
  return event;
}

export interface BuildPreRequestAbortDispositionInput {
  planPath: string;
  executionSelectionPath: string;
  armedCheckpointPath: string;
  failedCheckpointPath: string;
  recoveryCheckpointPath: string;
  checkpointRoot?: string;
  coordinationDir?: string;
  createdAt?: Date;
}

/** Offline-only planner for a synchronous beforeRequest abort. Eligibility is
 * deliberately narrow: one MAIN action, exact historical legacy guard error,
 * no SUBMITTED event, and a latest 3/3 stable BEFORE recovery. */
export async function buildPreRequestAbortDispositionProposal(
  input: BuildPreRequestAbortDispositionInput,
): Promise<PreRequestAbortDispositionProposal> {
  const planPath = path.resolve(input.planPath);
  const selectionPath = path.resolve(input.executionSelectionPath);
  const checkpointRoot = path.resolve(
    input.checkpointRoot ?? CANONICAL_UNCRUSTABLES_FORWARD_CHECKPOINT_ROOT,
  );
  const coordinationDir = path.resolve(
    input.coordinationDir ?? CANONICAL_UNCRUSTABLES_AMAZON_COORDINATION_DIR,
  );
  const plan = await readRepairPlan(planPath);
  const selection = await readRepairExecutionSelection(selectionPath, plan);
  if (
    selection.profile !== MAIN_MEDIA_ONLY_PROFILE ||
    selection.selected_action_ids.length !== 1 ||
    selection.selected_skus.length !== 1
  ) {
    throw new Error("Abort disposition requires one exact MAIN_MEDIA_ONLY_V1 action.");
  }
  if (selection.source_plan.path) {
    const selectedPlanPath = path.isAbsolute(selection.source_plan.path)
      ? path.resolve(selection.source_plan.path)
      : path.resolve(UNCRUSTABLES_APP_ROOT, selection.source_plan.path);
    if (selectedPlanPath !== planPath) {
      throw new Error("Execution selection source plan path does not match --plan.");
    }
  }
  const actionId = selection.selected_action_ids[0];
  const entry = plan.entries.find((candidate) =>
    candidate.actions.some((action) => action.action_id === actionId)
  );
  const action = entry?.actions.find((candidate) => candidate.action_id === actionId);
  if (
    !entry ||
    !action ||
    entry.sku !== selection.selected_skus[0] ||
    action.kind !== "MEDIA" ||
    action.desired.kind !== "MEDIA" ||
    !action.desired.value.main_image_url ||
    action.desired.value.gallery_slots.length !== 0 ||
    (action.desired.value.delete_gallery_slots?.length ?? 0) !== 0
  ) {
    throw new Error("Sealed plan/selection does not contain one exact MAIN action.");
  }

  const store = new ImmutableCheckpointStore(
    checkpointRoot,
    plan.sha256,
    coordinationDir,
  );
  const pending = await store.pendingSubmissions();
  const submission = pending.get(actionId);
  if (
    pending.size !== 1 ||
    !submission ||
    submission.source_status !== "SUBMISSION_ARMED" ||
    submission.sku !== entry.sku ||
    submission.kind !== "MEDIA"
  ) {
    throw new Error("Canonical journal does not contain one exact armed MAIN action.");
  }

  const journalDir = path.join(checkpointRoot, plan.sha256.slice(0, 20));
  const sources = await Promise.all([
    readJsonBytes(input.armedCheckpointPath),
    readJsonBytes(input.failedCheckpointPath),
    readJsonBytes(input.recoveryCheckpointPath),
  ]);
  if (sources.some((source) => path.dirname(source.path) !== journalDir)) {
    throw new Error("All abort evidence must come from the canonical plan journal.");
  }
  const [armedSource, failedSource, recoverySource] = sources;
  const armedEvent = validateCheckpointEvent(armedSource.value, plan.sha256);
  const failedEvent = validateCheckpointEvent(failedSource.value, plan.sha256);
  const recoveryEvent = validateCheckpointEvent(recoverySource.value, plan.sha256);

  const names = (await readdir(journalDir))
    .filter((name) => name.endsWith(".json"))
    .sort();
  const journal = await Promise.all(
    names.map(async (name) => {
      const file = path.join(journalDir, name);
      const source = await readJsonBytes(file);
      return {
        name,
        path: file,
        event: validateCheckpointEvent(source.value, plan.sha256),
      };
    }),
  );
  const actionEvents = journal
    .filter(({ event }) => event.action_id === actionId)
    .sort(
      (left, right) =>
        left.event.created_at.localeCompare(right.event.created_at) ||
        left.name.localeCompare(right.name),
    );
  const armedIndex = actionEvents.findIndex(
    ({ event }) => event.event_id === armedEvent.event_id,
  );
  const failedIndex = actionEvents.findIndex(
    ({ event }) => event.event_id === failedEvent.event_id,
  );
  const latest = actionEvents.at(-1);
  if (
    armedIndex < 0 ||
    failedIndex !== armedIndex + 1 ||
    !latest ||
    latest.event.event_id !== recoveryEvent.event_id ||
    actionEvents
      .slice(armedIndex + 1)
      .some(({ event }) => event.status === "SUBMITTED")
  ) {
    throw new Error(
      "Abort journal must have exact ARMED→FAILED no-submit lineage and latest recovery evidence.",
    );
  }

  const armedDetail = record(armedEvent.detail, "Armed detail");
  const settlementGuard = record(
    armedDetail.settlement_guard,
    "Armed settlement guard",
  );
  const exactPaths = settlementGuard.exact_action_paths;
  if (
    armedEvent.status !== "SUBMISSION_ARMED" ||
    armedEvent.event_id !== submission.submitted_event_id ||
    armedEvent.action_id !== actionId ||
    armedEvent.sku !== entry.sku ||
    armedEvent.kind !== "MEDIA" ||
    armedDetail.launch_execution_authorization_body_sha256 != null ||
    settlementGuard.schema_version !== EXACT_PATH_SETTLEMENT_GUARD ||
    !Array.isArray(exactPaths) ||
    stableJson(exactPaths) !==
      stableJson(["/attributes/main_product_image_locator"])
  ) {
    throw new Error("Armed event is not the exact non-OFFER MAIN submission guard.");
  }
  const actualPatchSha = stringValue(
    settlementGuard.actual_patch_sha256,
    "actual_patch_sha256",
  );
  const beforePathStateSha = stringValue(
    settlementGuard.before_path_state_sha256,
    "before_path_state_sha256",
  );

  const failedDetail = record(failedEvent.detail, "FAILED detail");
  const exactLegacyError =
    `Physical Amazon account does not match launch authorization for ${actionId}. No Amazon call was made.`;
  if (
    failedEvent.status !== "FAILED" ||
    failedEvent.action_id !== actionId ||
    failedEvent.sku !== entry.sku ||
    failedEvent.kind !== "MEDIA" ||
    failedDetail.error !== exactLegacyError
  ) {
    throw new Error("FAILED event is not the exact synchronous legacy guard abort.");
  }

  const recoveryDetail = record(recoveryEvent.detail, "Recovery detail");
  if (
    recoveryEvent.status !== "SETTLEMENT_UNRESOLVED" ||
    recoveryEvent.action_id !== actionId ||
    recoveryEvent.sku !== entry.sku ||
    recoveryEvent.kind !== "MEDIA" ||
    recoveryDetail.recovery !== true ||
    recoveryDetail.trigger !== "PENDING_SETTLE_ONLY" ||
    recoveryDetail.submitted_event_id !== armedEvent.event_id ||
    recoveryDetail.selection_sha256 !== selection.sha256 ||
    numberValue(recoveryDetail.polling_reads, "polling_reads") < 3 ||
    recoveryDetail.read_errors !== 0 ||
    numberValue(
      recoveryDetail.consecutive_stable_reads,
      "consecutive_stable_reads",
    ) < 3 ||
    recoveryDetail.last_classification !== "BEFORE" ||
    recoveryDetail.last_path_state_sha256 !== beforePathStateSha ||
    recoveryDetail.remains_pending !== true ||
    recoveryDetail.automatic_resubmission_authorized !== false
  ) {
    throw new Error("Latest recovery is not exact 3/3 stable BEFORE evidence.");
  }

  const fenceSource = await readJsonBytes(
    path.join(coordinationDir, "pending-mutation-fence.json"),
  );
  const fence = record(fenceSource.value, "Pending mutation fence");
  const createdAt = input.createdAt ?? new Date();
  if (!Number.isFinite(createdAt.getTime())) {
    throw new Error("Disposition createdAt is invalid.");
  }
  const body: Omit<
    PreRequestAbortDispositionProposal,
    "sha256" | "confirmation_token"
  > = {
    schema_version: PRE_REQUEST_ABORT_DISPOSITION_SCHEMA,
    immutable: true,
    created_at: createdAt.toISOString(),
    disposition: "SYNC_PRE_REQUEST_GUARD_ABORT_PROVEN_NO_AMAZON_PATCH",
    marketplace: "AmazonUS",
    plan: { path: planPath, sha256: plan.sha256 },
    selection: {
      path: selectionPath,
      sha256: selection.sha256,
      profile: MAIN_MEDIA_ONLY_PROFILE,
      selected_action_ids: [actionId],
    },
    action: {
      action_id: actionId,
      sku: entry.sku,
      asin: entry.asin,
      store_index: entry.store_index,
      kind: "MEDIA",
      exact_action_paths: ["/attributes/main_product_image_locator"],
      actual_patch_sha256: actualPatchSha,
    },
    armed: {
      path: armedSource.path,
      file_sha256: sha256(armedSource.bytes),
      event_id: armedEvent.event_id,
      event_sha256: armedEvent.sha256,
      created_at: armedEvent.created_at,
      source_status: "SUBMISSION_ARMED",
      settlement_guard_schema: EXACT_PATH_SETTLEMENT_GUARD,
      before_path_state_sha256: beforePathStateSha,
    },
    failed: {
      path: failedSource.path,
      file_sha256: sha256(failedSource.bytes),
      event_id: failedEvent.event_id,
      event_sha256: failedEvent.sha256,
      created_at: failedEvent.created_at,
      source_status: "FAILED",
      guard_error_code: "LEGACY_NON_OFFER_LAUNCH_AUTH_CALLBACK_REJECTION",
      error: exactLegacyError,
      amazon_request_performed: false,
    },
    recovery: {
      path: recoverySource.path,
      file_sha256: sha256(recoverySource.bytes),
      event_id: recoveryEvent.event_id,
      event_sha256: recoveryEvent.sha256,
      created_at: recoveryEvent.created_at,
      source_status: "SETTLEMENT_UNRESOLVED",
      armed_event_id: armedEvent.event_id,
      selection_sha256: selection.sha256,
      polling_reads: numberValue(recoveryDetail.polling_reads, "polling_reads"),
      read_errors: 0,
      consecutive_stable_reads: numberValue(
        recoveryDetail.consecutive_stable_reads,
        "consecutive_stable_reads",
      ),
      last_classification: "BEFORE",
      last_path_state_sha256: beforePathStateSha,
      remains_pending: true,
      automatic_resubmission_authorized: false,
    },
    fence: {
      path: fenceSource.path,
      file_sha256: sha256(fenceSource.bytes),
      schema_version: fence.schema_version as
        "uncrustables-amazon-pending-mutation-fence/v1",
      repair_plan_sha256: stringValue(
        fence.repair_plan_sha256,
        "Fence repair plan SHA",
      ),
      claimed_at: stringValue(fence.claimed_at, "Fence claimed_at"),
      purpose: stringValue(fence.purpose, "Fence purpose"),
    },
    guarantees: {
      amazon_calls_performed_by_disposition: 0,
      channelmax_calls_performed_by_disposition: 0,
      historical_amazon_patch_performed: false,
      automatic_resubmission_authorized: false,
      fence_release_authorized: false,
      terminalizes_only_armed_event_id: armedEvent.event_id,
      terminal_status_is_verified: false,
    },
  };
  const digest = preRequestAbortDispositionDigest(body);
  const proposal: PreRequestAbortDispositionProposal = {
    ...body,
    sha256: digest,
    confirmation_token: preRequestAbortDispositionConfirmationToken(digest),
  };
  verifyPreRequestAbortDispositionProposal(proposal);
  return proposal;
}

export async function writePreRequestAbortDispositionProposal(
  outputDir: string,
  proposal: PreRequestAbortDispositionProposal,
): Promise<string> {
  verifyPreRequestAbortDispositionProposal(proposal);
  const resolved = path.resolve(outputDir);
  await stat(path.dirname(resolved));
  await mkdir(resolved, { recursive: false });
  const file = path.join(
    resolved,
    `UPRADP-${proposal.created_at.replace(/[-:.]/g, "")}-${proposal.sha256.slice(0, 12)}.json`,
  );
  await writeFile(file, `${JSON.stringify(proposal, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return file;
}

export async function readPreRequestAbortDispositionProposal(
  file: string,
): Promise<PreRequestAbortDispositionProposal> {
  const proposal = JSON.parse(
    await readFile(path.resolve(file), "utf8"),
  ) as PreRequestAbortDispositionProposal;
  verifyPreRequestAbortDispositionProposal(proposal);
  return proposal;
}

export async function applyPreRequestAbortDisposition(input: {
  proposalPath: string;
  confirmation: string;
}): Promise<{ event: CheckpointEvent; fence_preserved: true }> {
  const proposal = await readPreRequestAbortDispositionProposal(
    input.proposalPath,
  );
  if (input.confirmation !== proposal.confirmation_token) {
    throw new Error("Pre-request abort disposition confirmation mismatch.");
  }
  const checkpointRoot = path.dirname(path.dirname(proposal.recovery.path));
  const coordinationDir = path.dirname(proposal.fence.path);
  const store = new ImmutableCheckpointStore(
    checkpointRoot,
    proposal.plan.sha256,
    coordinationDir,
  );
  const releaseLease = await store.acquireExecutionLease(
    `PRE_REQUEST_ABORT_DISPOSITION:${proposal.action.action_id}`,
  );
  try {
    const rebuilt = await buildPreRequestAbortDispositionProposal({
      planPath: proposal.plan.path,
      executionSelectionPath: proposal.selection.path,
      armedCheckpointPath: proposal.armed.path,
      failedCheckpointPath: proposal.failed.path,
      recoveryCheckpointPath: proposal.recovery.path,
      checkpointRoot,
      coordinationDir,
      createdAt: new Date(proposal.created_at),
    });
    if (stableJson(rebuilt) !== stableJson(proposal)) {
      throw new Error("Abort evidence changed after the proposal was built.");
    }
    const event = await store.dispositionPreRequestAbort({
      proposal,
      confirmation: input.confirmation,
    });
    return { event, fence_preserved: true };
  } finally {
    await releaseLease();
  }
}

export async function releasePreRequestAbortDispositionFence(input: {
  proposalPath: string;
  confirmation: string;
}): Promise<{
  armed_event: CheckpointEvent;
  released_event: CheckpointEvent;
  fence_released: true;
}> {
  const proposal = await readPreRequestAbortDispositionProposal(
    input.proposalPath,
  );
  const expectedConfirmation = preRequestAbortFenceReleaseConfirmationToken(
    proposal.sha256,
  );
  if (input.confirmation !== expectedConfirmation) {
    throw new Error("Pre-request abort fence release confirmation mismatch.");
  }
  const checkpointRoot = path.dirname(path.dirname(proposal.recovery.path));
  const coordinationDir = path.dirname(proposal.fence.path);
  const store = new ImmutableCheckpointStore(
    checkpointRoot,
    proposal.plan.sha256,
    coordinationDir,
  );
  const releaseLease = await store.acquireExecutionLease(
    `PRE_REQUEST_ABORT_FENCE_RELEASE:${proposal.action.action_id}`,
  );
  try {
    const fenceBytes = await readFile(proposal.fence.path);
    if (sha256(fenceBytes) !== proposal.fence.file_sha256) {
      throw new Error("Pending mutation fence changed before explicit release.");
    }
    if ((await store.pendingSubmissions()).size !== 0) {
      throw new Error("Pending Amazon submissions remain; fence release is forbidden.");
    }
    if ((await store.verifiedActionIds()).has(proposal.action.action_id)) {
      throw new Error("Abort disposition was incorrectly classified as VERIFIED.");
    }
    if (await store.hasGlobalPendingSubmissions()) {
      throw new Error("Another canonical Amazon mutation journal is still pending.");
    }
    const journalDir = path.join(checkpointRoot, proposal.plan.sha256.slice(0, 20));
    const events = await Promise.all(
      (await readdir(journalDir))
        .filter((name) => name.endsWith(".json"))
        .map(async (name) =>
          JSON.parse(await readFile(path.join(journalDir, name), "utf8")) as CheckpointEvent
        ),
    );
    const terminal = events.find(
      (event) =>
        event.status === PRE_REQUEST_ABORT_TERMINAL_STATUS &&
        event.action_id === proposal.action.action_id &&
        isRecord(event.detail.proposal) &&
        event.detail.proposal.sha256 === proposal.sha256,
    );
    if (!terminal) {
      throw new Error("Journal has no terminal event bound to this exact proposal.");
    }
    const armedEvent = await store.append({
      action_id: proposal.action.action_id,
      sku: proposal.action.sku,
      kind: "MEDIA",
      status: "FENCE_RELEASE_ARMED",
      detail: {
        disposition_type: PRE_REQUEST_ABORT_TERMINAL_STATUS,
        disposition_proposal_sha256: proposal.sha256,
        disposition_terminal_event_id: terminal.event_id,
        fence_path: proposal.fence.path,
        fence_file_sha256: proposal.fence.file_sha256,
        explicit_confirmation: expectedConfirmation,
        global_pending_submissions: 0,
        amazon_calls_performed: 0,
        channelmax_calls_performed: 0,
      },
    });
    await store.releasePendingMutationFence();
    const releasedEvent = await store.append({
      action_id: proposal.action.action_id,
      sku: proposal.action.sku,
      kind: "MEDIA",
      status: "FENCE_RELEASED",
      detail: {
        disposition_type: PRE_REQUEST_ABORT_TERMINAL_STATUS,
        disposition_proposal_sha256: proposal.sha256,
        disposition_terminal_event_id: terminal.event_id,
        armed_event_id: armedEvent.event_id,
        released_fence_file_sha256: proposal.fence.file_sha256,
        amazon_calls_performed: 0,
        channelmax_calls_performed: 0,
      },
    });
    return {
      armed_event: armedEvent,
      released_event: releasedEvent,
      fence_released: true,
    };
  } finally {
    await releaseLease();
  }
}
