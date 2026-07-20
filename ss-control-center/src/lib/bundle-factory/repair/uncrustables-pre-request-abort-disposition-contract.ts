import { createHash } from "node:crypto";

export const PRE_REQUEST_ABORT_DISPOSITION_SCHEMA =
  "uncrustables-amazon-pre-request-abort-disposition/v1" as const;
export const PRE_REQUEST_ABORT_TERMINAL_DETAIL_SCHEMA =
  "uncrustables-amazon-pre-request-abort-terminal-detail/v1" as const;
export const PRE_REQUEST_ABORT_TERMINAL_STATUS =
  "DISPOSITIONED_PRE_REQUEST_ABORT" as const;

const SHA256_RE = /^[a-f0-9]{64}$/;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function stableJson(value: unknown): string {
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertSha(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_RE.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256.`);
  }
}

function finiteDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function assertRecord(value: unknown, label: string): UnknownRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return value;
}

export interface PreRequestAbortDispositionProposal {
  schema_version: typeof PRE_REQUEST_ABORT_DISPOSITION_SCHEMA;
  immutable: true;
  created_at: string;
  disposition: "SYNC_PRE_REQUEST_GUARD_ABORT_PROVEN_NO_AMAZON_PATCH";
  marketplace: "AmazonUS";
  plan: { path: string; sha256: string };
  selection: {
    path: string;
    sha256: string;
    profile: "MAIN_MEDIA_ONLY_V1";
    selected_action_ids: [string];
  };
  action: {
    action_id: string;
    sku: string;
    asin: string;
    store_index: number;
    kind: "MEDIA";
    exact_action_paths: ["/attributes/main_product_image_locator"];
    actual_patch_sha256: string;
  };
  armed: {
    path: string;
    file_sha256: string;
    event_id: string;
    event_sha256: string;
    created_at: string;
    source_status: "SUBMISSION_ARMED";
    settlement_guard_schema: "EXACT_ACTION_PATHS_V1";
    before_path_state_sha256: string;
  };
  failed: {
    path: string;
    file_sha256: string;
    event_id: string;
    event_sha256: string;
    created_at: string;
    source_status: "FAILED";
    guard_error_code: "LEGACY_NON_OFFER_LAUNCH_AUTH_CALLBACK_REJECTION";
    error: string;
    amazon_request_performed: false;
  };
  recovery: {
    path: string;
    file_sha256: string;
    event_id: string;
    event_sha256: string;
    created_at: string;
    source_status: "SETTLEMENT_UNRESOLVED";
    armed_event_id: string;
    selection_sha256: string;
    polling_reads: number;
    read_errors: 0;
    consecutive_stable_reads: number;
    last_classification: "BEFORE";
    last_path_state_sha256: string;
    remains_pending: true;
    automatic_resubmission_authorized: false;
  };
  fence: {
    path: string;
    file_sha256: string;
    schema_version: "uncrustables-amazon-pending-mutation-fence/v1";
    repair_plan_sha256: string;
    claimed_at: string;
    purpose: string;
  };
  guarantees: {
    amazon_calls_performed_by_disposition: 0;
    channelmax_calls_performed_by_disposition: 0;
    historical_amazon_patch_performed: false;
    automatic_resubmission_authorized: false;
    fence_release_authorized: false;
    terminalizes_only_armed_event_id: string;
    terminal_status_is_verified: false;
  };
  sha256: string;
  confirmation_token: string;
}

export function preRequestAbortDispositionDigest(
  body: Omit<PreRequestAbortDispositionProposal, "sha256" | "confirmation_token">,
): string {
  return sha256(stableJson(body));
}

export function preRequestAbortDispositionConfirmationToken(
  digest: string,
): string {
  assertSha(digest, "Pre-request abort disposition digest");
  return `DISPOSITION-PRE-REQUEST-ABORT-${digest.slice(0, 20).toUpperCase()}`;
}

export function preRequestAbortFenceReleaseConfirmationToken(
  digest: string,
): string {
  assertSha(digest, "Pre-request abort disposition digest");
  return `RELEASE-PRE-REQUEST-ABORT-FENCE-${digest.slice(0, 20).toUpperCase()}`;
}

export function verifyPreRequestAbortDispositionProposal(
  proposal: PreRequestAbortDispositionProposal,
): void {
  const { sha256: claimed, confirmation_token: token, ...body } = proposal;
  assertSha(claimed, "Pre-request abort proposal sha256");
  if (
    proposal.schema_version !== PRE_REQUEST_ABORT_DISPOSITION_SCHEMA ||
    proposal.immutable !== true ||
    !finiteDate(proposal.created_at) ||
    proposal.disposition !==
      "SYNC_PRE_REQUEST_GUARD_ABORT_PROVEN_NO_AMAZON_PATCH" ||
    proposal.marketplace !== "AmazonUS" ||
    claimed !== preRequestAbortDispositionDigest(body) ||
    token !== preRequestAbortDispositionConfirmationToken(claimed)
  ) {
    throw new Error("Invalid or tampered pre-request abort disposition proposal.");
  }

  assertSha(proposal.plan.sha256, "Plan sha256");
  assertSha(proposal.selection.sha256, "Selection sha256");
  assertSha(proposal.action.actual_patch_sha256, "Actual PATCH sha256");
  if (
    !proposal.plan.path ||
    !proposal.selection.path ||
    proposal.selection.profile !== "MAIN_MEDIA_ONLY_V1" ||
    proposal.selection.selected_action_ids.length !== 1 ||
    proposal.selection.selected_action_ids[0] !== proposal.action.action_id ||
    proposal.action.kind !== "MEDIA" ||
    !proposal.action.action_id ||
    !proposal.action.sku ||
    !proposal.action.asin ||
    !Number.isInteger(proposal.action.store_index) ||
    proposal.action.store_index <= 0 ||
    proposal.action.exact_action_paths.length !== 1 ||
    proposal.action.exact_action_paths[0] !==
      "/attributes/main_product_image_locator"
  ) {
    throw new Error("Pre-request abort proposal is not one exact MAIN action.");
  }

  const armed = proposal.armed;
  assertSha(armed.file_sha256, "Armed checkpoint file sha256");
  assertSha(armed.event_sha256, "Armed checkpoint event sha256");
  assertSha(armed.before_path_state_sha256, "Armed before-state sha256");
  if (
    !armed.path ||
    !armed.event_id ||
    !finiteDate(armed.created_at) ||
    armed.source_status !== "SUBMISSION_ARMED" ||
    armed.settlement_guard_schema !== "EXACT_ACTION_PATHS_V1"
  ) {
    throw new Error("Pre-request abort proposal lacks exact armed evidence.");
  }

  const failed = proposal.failed;
  assertSha(failed.file_sha256, "FAILED checkpoint file sha256");
  assertSha(failed.event_sha256, "FAILED checkpoint event sha256");
  const exactLegacyError =
    `Physical Amazon account does not match launch authorization for ${proposal.action.action_id}. No Amazon call was made.`;
  if (
    !failed.path ||
    !failed.event_id ||
    !finiteDate(failed.created_at) ||
    failed.source_status !== "FAILED" ||
    failed.guard_error_code !==
      "LEGACY_NON_OFFER_LAUNCH_AUTH_CALLBACK_REJECTION" ||
    failed.error !== exactLegacyError ||
    failed.amazon_request_performed !== false ||
    Date.parse(failed.created_at) < Date.parse(armed.created_at)
  ) {
    throw new Error("FAILED evidence is not the exact synchronous no-call guard abort.");
  }

  const recovery = proposal.recovery;
  assertSha(recovery.file_sha256, "Recovery file sha256");
  assertSha(recovery.event_sha256, "Recovery event sha256");
  assertSha(recovery.last_path_state_sha256, "Recovery path-state sha256");
  if (
    !recovery.path ||
    !recovery.event_id ||
    !finiteDate(recovery.created_at) ||
    recovery.source_status !== "SETTLEMENT_UNRESOLVED" ||
    recovery.armed_event_id !== armed.event_id ||
    recovery.selection_sha256 !== proposal.selection.sha256 ||
    !Number.isInteger(recovery.polling_reads) ||
    recovery.polling_reads < 3 ||
    recovery.read_errors !== 0 ||
    !Number.isInteger(recovery.consecutive_stable_reads) ||
    recovery.consecutive_stable_reads < 3 ||
    recovery.last_classification !== "BEFORE" ||
    recovery.last_path_state_sha256 !== armed.before_path_state_sha256 ||
    recovery.remains_pending !== true ||
    recovery.automatic_resubmission_authorized !== false ||
    Date.parse(recovery.created_at) < Date.parse(failed.created_at)
  ) {
    throw new Error(
      "Pre-request abort requires at least three stable BEFORE reads with zero errors.",
    );
  }

  const fence = proposal.fence;
  assertSha(fence.file_sha256, "Fence file sha256");
  if (
    !fence.path ||
    fence.schema_version !==
      "uncrustables-amazon-pending-mutation-fence/v1" ||
    fence.repair_plan_sha256 !== proposal.plan.sha256 ||
    !finiteDate(fence.claimed_at) ||
    !fence.purpose
  ) {
    throw new Error("Pre-request abort proposal is not bound to the exact fence.");
  }

  const guarantees = proposal.guarantees;
  if (
    guarantees.amazon_calls_performed_by_disposition !== 0 ||
    guarantees.channelmax_calls_performed_by_disposition !== 0 ||
    guarantees.historical_amazon_patch_performed !== false ||
    guarantees.automatic_resubmission_authorized !== false ||
    guarantees.fence_release_authorized !== false ||
    guarantees.terminalizes_only_armed_event_id !== armed.event_id ||
    guarantees.terminal_status_is_verified !== false
  ) {
    throw new Error("Pre-request abort safety guarantees are invalid.");
  }
}

export function verifyPreRequestAbortTerminalEvent(input: {
  terminalEvent: unknown;
  eventsById: ReadonlyMap<string, unknown>;
}): PreRequestAbortDispositionProposal {
  const terminal = assertRecord(input.terminalEvent, "Terminal checkpoint");
  const detail = assertRecord(terminal.detail, "Terminal checkpoint detail");
  if (
    terminal.status !== PRE_REQUEST_ABORT_TERMINAL_STATUS ||
    detail.schema_version !== PRE_REQUEST_ABORT_TERMINAL_DETAIL_SCHEMA ||
    typeof detail.armed_event_id !== "string"
  ) {
    throw new Error("Invalid pre-request abort terminal checkpoint detail.");
  }
  const proposal = detail.proposal as PreRequestAbortDispositionProposal;
  verifyPreRequestAbortDispositionProposal(proposal);
  if (
    terminal.plan_sha256 !== proposal.plan.sha256 ||
    terminal.action_id !== proposal.action.action_id ||
    terminal.sku !== proposal.action.sku ||
    terminal.kind !== "MEDIA" ||
    detail.armed_event_id !== proposal.armed.event_id
  ) {
    throw new Error("Pre-request abort terminal checkpoint crosses evidence scope.");
  }

  const armed = assertRecord(
    input.eventsById.get(proposal.armed.event_id),
    "Referenced armed checkpoint",
  );
  const failed = assertRecord(
    input.eventsById.get(proposal.failed.event_id),
    "Referenced FAILED checkpoint",
  );
  const recovery = assertRecord(
    input.eventsById.get(proposal.recovery.event_id),
    "Referenced recovery checkpoint",
  );
  const armedDetail = assertRecord(armed.detail, "Referenced armed detail");
  const failedDetail = assertRecord(failed.detail, "Referenced FAILED detail");
  const recoveryDetail = assertRecord(
    recovery.detail,
    "Referenced recovery detail",
  );
  const guard = assertRecord(armedDetail.settlement_guard, "Armed settlement guard");
  if (
    armed.status !== "SUBMISSION_ARMED" ||
    armed.event_id !== proposal.armed.event_id ||
    armed.sha256 !== proposal.armed.event_sha256 ||
    armed.created_at !== proposal.armed.created_at ||
    armed.plan_sha256 !== proposal.plan.sha256 ||
    armed.action_id !== proposal.action.action_id ||
    armed.sku !== proposal.action.sku ||
    armed.kind !== "MEDIA" ||
    armedDetail.launch_execution_authorization_body_sha256 != null ||
    guard.schema_version !== "EXACT_ACTION_PATHS_V1" ||
    guard.actual_patch_sha256 !== proposal.action.actual_patch_sha256 ||
    guard.before_path_state_sha256 !== proposal.armed.before_path_state_sha256 ||
    !Array.isArray(guard.exact_action_paths) ||
    stableJson(guard.exact_action_paths) !==
      stableJson(proposal.action.exact_action_paths)
  ) {
    throw new Error("Pre-request abort armed lineage is invalid.");
  }
  if (
    failed.status !== "FAILED" ||
    failed.event_id !== proposal.failed.event_id ||
    failed.sha256 !== proposal.failed.event_sha256 ||
    failed.created_at !== proposal.failed.created_at ||
    failed.plan_sha256 !== proposal.plan.sha256 ||
    failed.action_id !== proposal.action.action_id ||
    failed.sku !== proposal.action.sku ||
    failed.kind !== "MEDIA" ||
    failedDetail.error !== proposal.failed.error
  ) {
    throw new Error("Pre-request abort FAILED lineage is invalid.");
  }
  if (
    recovery.status !== "SETTLEMENT_UNRESOLVED" ||
    recovery.event_id !== proposal.recovery.event_id ||
    recovery.sha256 !== proposal.recovery.event_sha256 ||
    recovery.created_at !== proposal.recovery.created_at ||
    recovery.plan_sha256 !== proposal.plan.sha256 ||
    recovery.action_id !== proposal.action.action_id ||
    recovery.sku !== proposal.action.sku ||
    recovery.kind !== "MEDIA" ||
    recoveryDetail.submitted_event_id !== proposal.armed.event_id ||
    recoveryDetail.selection_sha256 !== proposal.selection.sha256 ||
    recoveryDetail.polling_reads !== proposal.recovery.polling_reads ||
    recoveryDetail.read_errors !== 0 ||
    recoveryDetail.consecutive_stable_reads !==
      proposal.recovery.consecutive_stable_reads ||
    recoveryDetail.last_classification !== "BEFORE" ||
    recoveryDetail.last_path_state_sha256 !==
      proposal.recovery.last_path_state_sha256 ||
    recoveryDetail.remains_pending !== true ||
    recoveryDetail.automatic_resubmission_authorized !== false
  ) {
    throw new Error("Pre-request abort recovery lineage is invalid.");
  }
  return proposal;
}
