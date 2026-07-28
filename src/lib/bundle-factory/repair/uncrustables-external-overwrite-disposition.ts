import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  EXTERNAL_OVERWRITE_DISPOSITION_SCHEMA,
  externalOverwriteDispositionConfirmationToken,
  externalOverwriteDispositionDigest,
  externalOverwriteFenceReleaseConfirmationToken,
  verifyExternalOverwriteDispositionProposal,
  type ExternalOverwriteDispositionProposal,
} from "./uncrustables-external-overwrite-disposition-contract";
import {
  CANONICAL_UNCRUSTABLES_AMAZON_COORDINATION_DIR,
  CANONICAL_UNCRUSTABLES_FORWARD_CHECKPOINT_ROOT,
  CHECKPOINT_SCHEMA,
  ImmutableCheckpointStore,
  UNCRUSTABLES_APP_ROOT,
  readRepairExecutionSelection,
  readRepairPlan,
  sha256,
  stableJson,
  type CheckpointEvent,
} from "./uncrustables-surgical";

type UnknownRecord = Record<string, unknown>;

const EXACT_QX_SKU = "QX-AS89-H8YC";
const EXACT_QX_ASIN = "B0H82RQ226";
const EXACT_QX_ACTION_ID = `${EXACT_QX_SKU}:offer`;
const CANONICAL_QX_CHANNELMAX_POSTWRITE = path.join(
  UNCRUSTABLES_APP_ROOT,
  "data/repairs/rollback/channelmax-qx-fence-recovery-20260719/postwrite.json",
);

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

function validateCheckpointEvent(value: unknown, expectedPlanSha: string): CheckpointEvent {
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

export interface BuildExternalOverwriteDispositionInput {
  planPath: string;
  executionSelectionPath: string;
  settlementCheckpointPath: string;
  channelmaxPostwritePath: string;
  checkpointRoot?: string;
  coordinationDir?: string;
  createdAt?: Date;
}

/** Build a zero-network proposal. It proves exact journal lineage, requires the
 * provided settlement checkpoint to be the latest event for QX, and requires
 * all three Amazon NON_DESIRED reads to have happened after the exact
 * ChannelMAX canonical postwrite. */
export async function buildExternalOverwriteDispositionProposal(
  input: BuildExternalOverwriteDispositionInput,
): Promise<ExternalOverwriteDispositionProposal> {
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
  const selectedActionId = selection.selected_action_ids[0];
  if (
    selection.profile !== "OFFER_ONLY_V1" ||
    selection.selected_action_ids.length !== 1 ||
    selection.selected_skus.length !== 1 ||
    selectedActionId !== EXACT_QX_ACTION_ID ||
    selection.selected_skus[0] !== EXACT_QX_SKU
  ) {
    throw new Error("Disposition is restricted to the exact one-row QX OFFER selection.");
  }
  if (selection.source_plan.path) {
    const selectedPlanPath = path.isAbsolute(selection.source_plan.path)
      ? path.resolve(selection.source_plan.path)
      : path.resolve(UNCRUSTABLES_APP_ROOT, selection.source_plan.path);
    if (selectedPlanPath !== planPath) {
      // Existing selections store an app-root-relative path. A mismatched path
      // is not accepted even when the embedded plan SHA happens to match.
      throw new Error("Execution selection source plan path does not match --plan.");
    }
  }

  const entry = plan.entries.find((candidate) =>
    candidate.actions.some((action) => action.action_id === selectedActionId)
  );
  const action = entry?.actions.find(
    (candidate) => candidate.action_id === selectedActionId,
  );
  if (
    !entry ||
    !action ||
    entry.sku !== EXACT_QX_SKU ||
    entry.asin !== EXACT_QX_ASIN ||
    action.kind !== "OFFER" ||
    action.desired.kind !== "OFFER"
  ) {
    throw new Error("Sealed plan does not contain the exact QX OFFER action.");
  }
  const desiredRaw = action.desired.value;
  const desiredOffer = {
    currency: "USD" as const,
    consumer_price: numberValue(desiredRaw.consumer_price, "consumer_price"),
    business_price: numberValue(desiredRaw.business_price, "business_price"),
    minimum_seller_allowed_price: numberValue(
      desiredRaw.minimum_seller_allowed_price,
      "minimum_seller_allowed_price",
    ),
    maximum_seller_allowed_price: numberValue(
      desiredRaw.maximum_seller_allowed_price,
      "maximum_seller_allowed_price",
    ),
  };
  if (
    desiredRaw.currency !== "USD" ||
    desiredRaw.discounted_price_absent !== true ||
    desiredRaw.list_price_absent !== true
  ) {
    throw new Error("QX disposition expects the sealed regular-price/no-sale OFFER action.");
  }

  const store = new ImmutableCheckpointStore(
    checkpointRoot,
    plan.sha256,
    coordinationDir,
  );
  const pending = await store.pendingSubmissions();
  const submission = pending.get(selectedActionId);
  if (
    pending.size !== 1 ||
    !submission ||
    submission.source_status !== "SUBMITTED" ||
    submission.sku !== EXACT_QX_SKU ||
    submission.kind !== "OFFER" ||
    submission.detail.status !== "ACCEPTED" ||
    typeof submission.detail.submission_id !== "string" ||
    !submission.detail.submission_id
  ) {
    throw new Error("Canonical journal does not contain one exact accepted QX submission.");
  }

  const journalDir = path.join(checkpointRoot, plan.sha256.slice(0, 20));
  const settlementSource = await readJsonBytes(input.settlementCheckpointPath);
  if (path.dirname(settlementSource.path) !== journalDir) {
    throw new Error("Settlement evidence must come from the canonical plan journal.");
  }
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
        fileSha256: sha256(source.bytes),
      };
    }),
  );
  const actionEvents = journal
    .filter(({ event }) => event.action_id === selectedActionId)
    .sort(
      (left, right) =>
        left.event.created_at.localeCompare(right.event.created_at) ||
        left.name.localeCompare(right.name),
    );
  const latestActionEvent = actionEvents.at(-1);
  if (!latestActionEvent || latestActionEvent.path !== settlementSource.path) {
    throw new Error(
      "Provided settlement checkpoint is not the latest immutable QX action event.",
    );
  }
  const settlementEvent = validateCheckpointEvent(
    settlementSource.value,
    plan.sha256,
  );
  const settlementDetail = record(
    settlementEvent.detail,
    "Settlement checkpoint detail",
  );
  if (
    settlementEvent.status !== "SETTLEMENT_UNRESOLVED" ||
    settlementEvent.action_id !== selectedActionId ||
    settlementEvent.sku !== EXACT_QX_SKU ||
    settlementEvent.kind !== "OFFER" ||
    settlementDetail.recovery !== true ||
    settlementDetail.trigger !== "PENDING_SETTLE_ONLY" ||
    settlementDetail.submitted_event_id !== submission.submitted_event_id ||
    settlementDetail.selection_sha256 !== selection.sha256 ||
    settlementDetail.polling_reads !== 3 ||
    settlementDetail.read_errors !== 0 ||
    settlementDetail.consecutive_stable_reads !== 3 ||
    settlementDetail.last_classification !== "NON_DESIRED" ||
    settlementDetail.remains_pending !== true ||
    settlementDetail.automatic_resubmission_authorized !== false
  ) {
    throw new Error(
      "Latest QX settlement is not exact 3/3 stable NON_DESIRED evidence.",
    );
  }
  const submittedEvent = journal.find(
    ({ event }) => event.event_id === submission.submitted_event_id,
  );
  if (!submittedEvent || submittedEvent.event.status !== "SUBMITTED") {
    throw new Error("Accepted QX submitted event is absent from the canonical journal.");
  }

  const channelmaxSource = await readJsonBytes(input.channelmaxPostwritePath);
  if (
    checkpointRoot ===
      path.resolve(CANONICAL_UNCRUSTABLES_FORWARD_CHECKPOINT_ROOT) &&
    coordinationDir ===
      path.resolve(CANONICAL_UNCRUSTABLES_AMAZON_COORDINATION_DIR) &&
    channelmaxSource.path !== path.resolve(CANONICAL_QX_CHANNELMAX_POSTWRITE)
  ) {
    throw new Error(
      "Live QX disposition requires the canonical ChannelMAX postwrite path.",
    );
  }
  const channelmaxRaw = record(
    channelmaxSource.value,
    "ChannelMAX postwrite evidence",
  );
  const fenceSource = await readJsonBytes(
    path.join(coordinationDir, "pending-mutation-fence.json"),
  );
  const fenceRaw = record(fenceSource.value, "Pending mutation fence");
  const createdAt = input.createdAt ?? new Date();
  if (!Number.isFinite(createdAt.getTime())) {
    throw new Error("Disposition createdAt is invalid.");
  }

  const body: Omit<
    ExternalOverwriteDispositionProposal,
    "sha256" | "confirmation_token"
  > = {
    schema_version: EXTERNAL_OVERWRITE_DISPOSITION_SCHEMA,
    immutable: true,
    created_at: createdAt.toISOString(),
    disposition: "ACCEPTED_OFFER_EXTERNALLY_OVERWRITTEN_BY_CHANNELMAX",
    marketplace: "AmazonUS",
    plan: { path: planPath, sha256: plan.sha256 },
    selection: {
      path: selectionPath,
      sha256: selection.sha256,
      profile: "OFFER_ONLY_V1",
      selected_action_ids: [selectedActionId],
    },
    action: {
      action_id: selectedActionId,
      sku: entry.sku,
      asin: entry.asin,
      store_index: entry.store_index,
      kind: "OFFER",
      desired_offer: desiredOffer,
      desired_offer_sha256: sha256(stableJson(desiredOffer)),
    },
    pending_submission: {
      event_id: submission.submitted_event_id,
      event_sha256: submittedEvent.event.sha256,
      created_at: submittedEvent.event.created_at,
      source_status: "SUBMITTED",
      amazon_status: "ACCEPTED",
      amazon_submission_id: stringValue(
        submission.detail.submission_id,
        "Amazon submission ID",
      ),
    },
    settlement: {
      path: settlementSource.path,
      file_sha256: sha256(settlementSource.bytes),
      event_id: settlementEvent.event_id,
      event_sha256: settlementEvent.sha256,
      created_at: settlementEvent.created_at,
      submitted_event_id: submission.submitted_event_id,
      selection_sha256: selection.sha256,
      polling_reads: numberValue(settlementDetail.polling_reads, "polling_reads"),
      read_errors: 0,
      consecutive_stable_reads: numberValue(
        settlementDetail.consecutive_stable_reads,
        "consecutive_stable_reads",
      ),
      last_classification: "NON_DESIRED",
      last_path_state_sha256: stringValue(
        settlementDetail.last_path_state_sha256,
        "last_path_state_sha256",
      ),
      remains_pending: true,
      automatic_resubmission_authorized: false,
    },
    channelmax_postwrite: {
      path: channelmaxSource.path,
      file_sha256: sha256(channelmaxSource.bytes),
      ...(channelmaxRaw as Omit<
        ExternalOverwriteDispositionProposal["channelmax_postwrite"],
        "path" | "file_sha256"
      >),
    },
    fence: {
      path: fenceSource.path,
      file_sha256: sha256(fenceSource.bytes),
      schema_version: fenceRaw.schema_version as
        "uncrustables-amazon-pending-mutation-fence/v1",
      repair_plan_sha256: stringValue(
        fenceRaw.repair_plan_sha256,
        "Fence repair plan SHA",
      ),
      claimed_at: stringValue(fenceRaw.claimed_at, "Fence claimed_at"),
      purpose: stringValue(fenceRaw.purpose, "Fence purpose"),
    },
    guarantees: {
      amazon_calls_performed: 0,
      channelmax_calls_performed: 0,
      automatic_resubmission_authorized: false,
      fence_release_authorized: false,
      terminalizes_only_submitted_event_id: submission.submitted_event_id,
    },
  };
  const digest = externalOverwriteDispositionDigest(body);
  const proposal: ExternalOverwriteDispositionProposal = {
    ...body,
    sha256: digest,
    confirmation_token: externalOverwriteDispositionConfirmationToken(digest),
  };
  verifyExternalOverwriteDispositionProposal(proposal);
  return proposal;
}

export async function writeExternalOverwriteDispositionProposal(
  outputDir: string,
  proposal: ExternalOverwriteDispositionProposal,
): Promise<string> {
  verifyExternalOverwriteDispositionProposal(proposal);
  const resolved = path.resolve(outputDir);
  await stat(path.dirname(resolved));
  await mkdir(resolved, { recursive: false });
  const file = path.join(
    resolved,
    `UEDP-${proposal.created_at.replace(/[-:.]/g, "")}-${proposal.sha256.slice(0, 12)}.json`,
  );
  await writeFile(file, `${JSON.stringify(proposal, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return file;
}

export async function readExternalOverwriteDispositionProposal(
  file: string,
): Promise<ExternalOverwriteDispositionProposal> {
  const proposal = JSON.parse(
    await readFile(path.resolve(file), "utf8"),
  ) as ExternalOverwriteDispositionProposal;
  verifyExternalOverwriteDispositionProposal(proposal);
  return proposal;
}

/** Append only the terminal disposition checkpoint. The marketplace fence is
 * intentionally preserved byte-for-byte and no marketplace/browser gateway is
 * imported or invoked by this workflow. */
export async function applyExternalOverwriteDisposition(input: {
  proposalPath: string;
  confirmation: string;
}): Promise<{ event: CheckpointEvent; fence_preserved: true }> {
  const proposal = await readExternalOverwriteDispositionProposal(
    input.proposalPath,
  );
  if (input.confirmation !== proposal.confirmation_token) {
    throw new Error("External-overwrite disposition confirmation mismatch.");
  }
  const store = new ImmutableCheckpointStore(
    path.dirname(path.dirname(proposal.settlement.path)),
    proposal.plan.sha256,
    path.dirname(proposal.fence.path),
  );
  const releaseLease = await store.acquireExecutionLease(
    `EXTERNAL_OVERWRITE_DISPOSITION:${proposal.action.action_id}`,
  );
  try {
    const rebuilt = await buildExternalOverwriteDispositionProposal({
      planPath: proposal.plan.path,
      executionSelectionPath: proposal.selection.path,
      settlementCheckpointPath: proposal.settlement.path,
      channelmaxPostwritePath: proposal.channelmax_postwrite.path,
      checkpointRoot: path.dirname(path.dirname(proposal.settlement.path)),
      coordinationDir: path.dirname(proposal.fence.path),
      createdAt: new Date(proposal.created_at),
    });
    if (stableJson(rebuilt) !== stableJson(proposal)) {
      throw new Error(
        "Disposition evidence changed after the immutable proposal was built.",
      );
    }
    const event = await store.dispositionExternallyOverwrittenOffer({
      proposal,
      confirmation: input.confirmation,
    });
    return { event, fence_preserved: true };
  } finally {
    await releaseLease();
  }
}

/** Explicit second gate for deleting the now-obsolete process-global fence.
 * A FENCE_RELEASE_ARMED event is persisted before unlink so even a crash in
 * the delete/receipt window leaves immutable operator intent. */
export async function releaseExternalOverwriteDispositionFence(input: {
  proposalPath: string;
  confirmation: string;
}): Promise<{
  armed_event: CheckpointEvent;
  released_event: CheckpointEvent;
  fence_released: true;
}> {
  const proposal = await readExternalOverwriteDispositionProposal(
    input.proposalPath,
  );
  const expectedConfirmation = externalOverwriteFenceReleaseConfirmationToken(
    proposal.sha256,
  );
  if (input.confirmation !== expectedConfirmation) {
    throw new Error("External-overwrite fence release confirmation mismatch.");
  }
  const checkpointRoot = path.dirname(path.dirname(proposal.settlement.path));
  const coordinationDir = path.dirname(proposal.fence.path);
  const store = new ImmutableCheckpointStore(
    checkpointRoot,
    proposal.plan.sha256,
    coordinationDir,
  );
  const releaseLease = await store.acquireExecutionLease(
    `EXTERNAL_OVERWRITE_FENCE_RELEASE:${proposal.action.action_id}`,
  );
  try {
    const fenceBytes = await readFile(proposal.fence.path);
    if (sha256(fenceBytes) !== proposal.fence.file_sha256) {
      throw new Error("Pending mutation fence changed before explicit release.");
    }
    if ((await store.pendingSubmissions()).size !== 0) {
      throw new Error("Pending Amazon submissions remain; fence release is forbidden.");
    }
    if (!(await store.verifiedActionIds()).has(proposal.action.action_id)) {
      throw new Error("Exact external-overwrite terminal checkpoint is absent.");
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
        event.status === "DISPOSITIONED_EXTERNAL_OVERWRITE" &&
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
      kind: "OFFER",
      status: "FENCE_RELEASE_ARMED",
      detail: {
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
      kind: "OFFER",
      status: "FENCE_RELEASED",
      detail: {
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
