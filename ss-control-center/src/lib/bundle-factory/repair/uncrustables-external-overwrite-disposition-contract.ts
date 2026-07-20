import { createHash } from "node:crypto";

export const EXTERNAL_OVERWRITE_DISPOSITION_SCHEMA =
  "uncrustables-amazon-external-overwrite-disposition/v1" as const;
export const EXTERNAL_OVERWRITE_TERMINAL_DETAIL_SCHEMA =
  "uncrustables-amazon-external-overwrite-terminal-detail/v1" as const;
export const EXTERNAL_OVERWRITE_TERMINAL_STATUS =
  "DISPOSITIONED_EXTERNAL_OVERWRITE" as const;

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

function finiteDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function exactMoney(value: unknown, expected: number): boolean {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Math.round(value * 100) === Math.round(expected * 100);
}

function assertRecord(value: unknown, label: string): UnknownRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function assertSha(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !SHA256_RE.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256.`);
  }
}

export interface ExternalOverwriteDispositionProposal {
  schema_version: typeof EXTERNAL_OVERWRITE_DISPOSITION_SCHEMA;
  immutable: true;
  created_at: string;
  disposition: "ACCEPTED_OFFER_EXTERNALLY_OVERWRITTEN_BY_CHANNELMAX";
  marketplace: "AmazonUS";
  plan: {
    path: string;
    sha256: string;
  };
  selection: {
    path: string;
    sha256: string;
    profile: "OFFER_ONLY_V1";
    selected_action_ids: [string];
  };
  action: {
    action_id: string;
    sku: string;
    asin: string;
    store_index: number;
    kind: "OFFER";
    desired_offer: {
      currency: "USD";
      consumer_price: number;
      business_price: number;
      minimum_seller_allowed_price: number;
      maximum_seller_allowed_price: number;
    };
    desired_offer_sha256: string;
  };
  pending_submission: {
    event_id: string;
    event_sha256: string;
    created_at: string;
    source_status: "SUBMITTED";
    amazon_status: "ACCEPTED";
    amazon_submission_id: string;
  };
  settlement: {
    path: string;
    file_sha256: string;
    event_id: string;
    event_sha256: string;
    created_at: string;
    submitted_event_id: string;
    selection_sha256: string;
    polling_reads: number;
    read_errors: 0;
    consecutive_stable_reads: number;
    last_classification: "NON_DESIRED";
    last_path_state_sha256: string;
    remains_pending: true;
    automatic_resubmission_authorized: false;
  };
  channelmax_postwrite: {
    path: string;
    file_sha256: string;
    schema_version: "channelmax-qx-fence-recovery-postwrite/v1";
    confirmed_at: string;
    row: {
      item_id: number;
      sku: string;
      asin: string;
      site_id: 300;
    };
    before: {
      minimum_price: number | null;
      maximum_price: number;
      price: number;
      repricing_model_name: string;
    };
    after: {
      minimum_price: number;
      maximum_price: number;
      price: number;
      repricing_model_name: string;
    };
    write_response: {
      is_valid: true;
      message: "SUCCESS";
      updated_rows: 1;
    };
    independent_readback: {
      action: "inventoryitemsite";
      is_valid: true;
      minimum_price: number;
      maximum_price: number;
      last_updated_by: string;
    };
    amazon_next_action: "GET_ONLY_PENDING_SETTLEMENT";
    amazon_resubmission_performed: false;
    result: "PASS";
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
    amazon_calls_performed: 0;
    channelmax_calls_performed: 0;
    automatic_resubmission_authorized: false;
    fence_release_authorized: false;
    terminalizes_only_submitted_event_id: string;
  };
  sha256: string;
  confirmation_token: string;
}

export interface ExternalOverwriteTerminalDetail {
  schema_version: typeof EXTERNAL_OVERWRITE_TERMINAL_DETAIL_SCHEMA;
  submitted_event_id: string;
  proposal: ExternalOverwriteDispositionProposal;
}

export function externalOverwriteDispositionDigest(
  body: Omit<ExternalOverwriteDispositionProposal, "sha256" | "confirmation_token">,
): string {
  return sha256(stableJson(body));
}

export function externalOverwriteDispositionConfirmationToken(
  digest: string,
): string {
  assertSha(digest, "Disposition digest");
  return `DISPOSITION-EXTERNAL-OVERWRITE-${digest.slice(0, 20).toUpperCase()}`;
}

export function externalOverwriteFenceReleaseConfirmationToken(
  dispositionDigest: string,
): string {
  assertSha(dispositionDigest, "Disposition digest");
  return `RELEASE-EXTERNAL-OVERWRITE-FENCE-${dispositionDigest.slice(0, 20).toUpperCase()}`;
}

/** Validate the self-contained immutable evidence. This deliberately accepts
 * exactly the QX ChannelMAX postwrite schema; a different writer/artifact must
 * get a separately reviewed contract instead of being treated as equivalent. */
export function verifyExternalOverwriteDispositionProposal(
  proposal: ExternalOverwriteDispositionProposal,
): void {
  const { sha256: claimed, confirmation_token: token, ...body } = proposal;
  assertSha(claimed, "Disposition proposal sha256");
  if (
    proposal.schema_version !== EXTERNAL_OVERWRITE_DISPOSITION_SCHEMA ||
    proposal.immutable !== true ||
    !finiteDate(proposal.created_at) ||
    proposal.disposition !==
      "ACCEPTED_OFFER_EXTERNALLY_OVERWRITTEN_BY_CHANNELMAX" ||
    proposal.marketplace !== "AmazonUS" ||
    claimed !== externalOverwriteDispositionDigest(body) ||
    token !== externalOverwriteDispositionConfirmationToken(claimed)
  ) {
    throw new Error("Invalid or tampered external-overwrite disposition proposal.");
  }

  assertSha(proposal.plan.sha256, "Disposition plan sha256");
  assertSha(proposal.selection.sha256, "Disposition selection sha256");
  assertSha(
    proposal.action.desired_offer_sha256,
    "Disposition desired offer sha256",
  );
  if (
    !proposal.plan.path ||
    !proposal.selection.path ||
    proposal.selection.profile !== "OFFER_ONLY_V1" ||
    proposal.selection.selected_action_ids.length !== 1 ||
    proposal.selection.selected_action_ids[0] !== proposal.action.action_id ||
    proposal.action.kind !== "OFFER" ||
    !proposal.action.action_id ||
    !proposal.action.sku ||
    !proposal.action.asin ||
    !Number.isInteger(proposal.action.store_index) ||
    proposal.action.store_index <= 0 ||
    proposal.action.desired_offer.currency !== "USD" ||
    proposal.action.desired_offer_sha256 !==
      sha256(stableJson(proposal.action.desired_offer))
  ) {
    throw new Error("Disposition proposal is not bound to one exact OFFER action.");
  }

  const pending = proposal.pending_submission;
  assertSha(pending.event_sha256, "Pending submission event sha256");
  if (
    !pending.event_id ||
    !finiteDate(pending.created_at) ||
    pending.source_status !== "SUBMITTED" ||
    pending.amazon_status !== "ACCEPTED" ||
    !pending.amazon_submission_id
  ) {
    throw new Error("Disposition proposal lacks an exact accepted submission.");
  }

  const settlement = proposal.settlement;
  assertSha(settlement.file_sha256, "Settlement file sha256");
  assertSha(settlement.event_sha256, "Settlement event sha256");
  assertSha(
    settlement.last_path_state_sha256,
    "Settlement last path state sha256",
  );
  if (
    !settlement.path ||
    !settlement.event_id ||
    !finiteDate(settlement.created_at) ||
    settlement.submitted_event_id !== pending.event_id ||
    settlement.selection_sha256 !== proposal.selection.sha256 ||
    !Number.isInteger(settlement.polling_reads) ||
    settlement.polling_reads < 3 ||
    settlement.read_errors !== 0 ||
    !Number.isInteger(settlement.consecutive_stable_reads) ||
    settlement.consecutive_stable_reads < 3 ||
    settlement.last_classification !== "NON_DESIRED" ||
    settlement.remains_pending !== true ||
    settlement.automatic_resubmission_authorized !== false
  ) {
    throw new Error(
      "External overwrite requires at least three stable NON_DESIRED reads with zero read errors.",
    );
  }

  const channelmax = proposal.channelmax_postwrite;
  assertSha(channelmax.file_sha256, "ChannelMAX postwrite file sha256");
  if (
    !channelmax.path ||
    channelmax.schema_version !==
      "channelmax-qx-fence-recovery-postwrite/v1" ||
    !finiteDate(channelmax.confirmed_at) ||
    channelmax.row.sku !== proposal.action.sku ||
    channelmax.row.asin !== proposal.action.asin ||
    channelmax.row.site_id !== 300 ||
    !Number.isInteger(channelmax.row.item_id) ||
    channelmax.row.item_id <= 0 ||
    channelmax.write_response.is_valid !== true ||
    channelmax.write_response.message !== "SUCCESS" ||
    channelmax.write_response.updated_rows !== 1 ||
    channelmax.independent_readback.action !== "inventoryitemsite" ||
    channelmax.independent_readback.is_valid !== true ||
    !channelmax.independent_readback.last_updated_by ||
    channelmax.amazon_next_action !== "GET_ONLY_PENDING_SETTLEMENT" ||
    channelmax.amazon_resubmission_performed !== false ||
    channelmax.result !== "PASS" ||
    channelmax.before.repricing_model_name !==
      channelmax.after.repricing_model_name ||
    Date.parse(settlement.created_at) <= Date.parse(channelmax.confirmed_at)
  ) {
    throw new Error(
      "Disposition proposal lacks a current exact ChannelMAX postwrite followed by Amazon settlement reads.",
    );
  }

  const desired = proposal.action.desired_offer;
  if (
    !exactMoney(channelmax.after.minimum_price, desired.minimum_seller_allowed_price) ||
    !exactMoney(channelmax.after.maximum_price, desired.maximum_seller_allowed_price) ||
    !exactMoney(channelmax.after.price, desired.consumer_price) ||
    !exactMoney(
      channelmax.independent_readback.minimum_price,
      desired.minimum_seller_allowed_price,
    ) ||
    !exactMoney(
      channelmax.independent_readback.maximum_price,
      desired.maximum_seller_allowed_price,
    )
  ) {
    throw new Error(
      "ChannelMAX postwrite/readback does not equal the sealed OFFER price bounds.",
    );
  }

  const fence = proposal.fence;
  assertSha(fence.file_sha256, "Pending fence file sha256");
  if (
    !fence.path ||
    fence.schema_version !==
      "uncrustables-amazon-pending-mutation-fence/v1" ||
    fence.repair_plan_sha256 !== proposal.plan.sha256 ||
    !finiteDate(fence.claimed_at) ||
    !fence.purpose
  ) {
    throw new Error("Disposition proposal is not bound to the exact live fence.");
  }
  if (
    proposal.guarantees.amazon_calls_performed !== 0 ||
    proposal.guarantees.channelmax_calls_performed !== 0 ||
    proposal.guarantees.automatic_resubmission_authorized !== false ||
    proposal.guarantees.fence_release_authorized !== false ||
    proposal.guarantees.terminalizes_only_submitted_event_id !== pending.event_id
  ) {
    throw new Error("Disposition safety guarantees are invalid.");
  }
}

/** A terminal event is valid only if its embedded proposal is valid and both
 * referenced immutable journal events exist with exact hashes/lineage. */
export function verifyExternalOverwriteTerminalEvent(input: {
  terminalEvent: unknown;
  eventsById: ReadonlyMap<string, unknown>;
}): ExternalOverwriteDispositionProposal {
  const terminal = assertRecord(input.terminalEvent, "Terminal checkpoint");
  const detail = assertRecord(terminal.detail, "Terminal checkpoint detail");
  if (
    terminal.status !== EXTERNAL_OVERWRITE_TERMINAL_STATUS ||
    detail.schema_version !== EXTERNAL_OVERWRITE_TERMINAL_DETAIL_SCHEMA ||
    typeof detail.submitted_event_id !== "string"
  ) {
    throw new Error("Invalid external-overwrite terminal checkpoint detail.");
  }
  const proposal = detail.proposal as ExternalOverwriteDispositionProposal;
  verifyExternalOverwriteDispositionProposal(proposal);
  if (
    terminal.plan_sha256 !== proposal.plan.sha256 ||
    terminal.action_id !== proposal.action.action_id ||
    terminal.sku !== proposal.action.sku ||
    terminal.kind !== "OFFER" ||
    detail.submitted_event_id !== proposal.pending_submission.event_id
  ) {
    throw new Error("External-overwrite terminal checkpoint crosses evidence scope.");
  }

  const submitted = assertRecord(
    input.eventsById.get(proposal.pending_submission.event_id),
    "Referenced submitted checkpoint",
  );
  const settlement = assertRecord(
    input.eventsById.get(proposal.settlement.event_id),
    "Referenced settlement checkpoint",
  );
  const submittedDetail = assertRecord(
    submitted.detail,
    "Referenced submitted detail",
  );
  const settlementDetail = assertRecord(
    settlement.detail,
    "Referenced settlement detail",
  );
  if (
    submitted.status !== "SUBMITTED" ||
    submitted.event_id !== proposal.pending_submission.event_id ||
    submitted.sha256 !== proposal.pending_submission.event_sha256 ||
    submitted.created_at !== proposal.pending_submission.created_at ||
    submitted.plan_sha256 !== proposal.plan.sha256 ||
    submitted.action_id !== proposal.action.action_id ||
    submitted.sku !== proposal.action.sku ||
    submitted.kind !== "OFFER" ||
    submittedDetail.status !== "ACCEPTED" ||
    submittedDetail.submission_id !==
      proposal.pending_submission.amazon_submission_id
  ) {
    throw new Error("External-overwrite disposition submitted lineage is invalid.");
  }
  if (
    settlement.status !== "SETTLEMENT_UNRESOLVED" ||
    settlement.event_id !== proposal.settlement.event_id ||
    settlement.sha256 !== proposal.settlement.event_sha256 ||
    settlement.created_at !== proposal.settlement.created_at ||
    settlement.plan_sha256 !== proposal.plan.sha256 ||
    settlement.action_id !== proposal.action.action_id ||
    settlement.sku !== proposal.action.sku ||
    settlement.kind !== "OFFER" ||
    settlementDetail.submitted_event_id !==
      proposal.pending_submission.event_id ||
    settlementDetail.selection_sha256 !== proposal.selection.sha256 ||
    settlementDetail.polling_reads !== proposal.settlement.polling_reads ||
    settlementDetail.read_errors !== 0 ||
    settlementDetail.consecutive_stable_reads !==
      proposal.settlement.consecutive_stable_reads ||
    settlementDetail.last_classification !== "NON_DESIRED" ||
    settlementDetail.last_path_state_sha256 !==
      proposal.settlement.last_path_state_sha256 ||
    settlementDetail.remains_pending !== true ||
    settlementDetail.automatic_resubmission_authorized !== false
  ) {
    throw new Error("External-overwrite disposition settlement lineage is invalid.");
  }
  return proposal;
}
