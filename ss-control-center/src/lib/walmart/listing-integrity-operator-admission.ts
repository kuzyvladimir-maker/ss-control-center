import { createHash } from "node:crypto";

import {
  transitionWalmartListingIntegrityControlState,
  verifyWalmartListingIntegrityControlState,
  walmartListingIntegrityControlSha256,
  type WalmartListingIntegrityControlState,
  type WalmartListingIntegritySchedulerStage,
} from "./listing-integrity-control-plane";

export const WALMART_LISTING_INTEGRITY_OPERATOR_RECEIPT_SCHEMA =
  "walmart-listing-repair-operator-receipt/v1" as const;

export class WalmartListingIntegrityOperatorAdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WalmartListingIntegrityOperatorAdmissionError";
  }
}

function fail(message: string): never {
  throw new WalmartListingIntegrityOperatorAdmissionError(message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactText(value: unknown, label: string, maximum = 768): string {
  if (typeof value !== "string" || value !== value.trim() || !value
    || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`${label} must be bounded exact text`);
  }
  return value;
}

function exactSha(value: unknown, label: string): string {
  const digest = exactText(value, label, 64);
  if (!/^[a-f0-9]{64}$/u.test(digest)) fail(`${label} must be lowercase SHA-256`);
  return digest;
}

function exactInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    fail(`${label} must be an integer >= ${minimum}`);
  }
  return Number(value);
}

function exactFalse(value: unknown, label: string): false {
  if (value !== false) fail(`${label} must be false`);
  return false;
}

function canonicalInstant(value: unknown, label: string): string {
  const timestamp = exactText(value, label, 64);
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== timestamp) {
    fail(`${label} must be canonical UTC`);
  }
  return timestamp;
}

function decodeReceipt(receiptBytes: Uint8Array): {
  receipt: Record<string, unknown>;
  receiptSha256: string;
} {
  if (!(receiptBytes instanceof Uint8Array) || receiptBytes.byteLength < 2) {
    fail("receipt_bytes must contain exact JSON bytes");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(receiptBytes));
  } catch {
    fail("receipt_bytes must be valid UTF-8 JSON");
  }
  const receipt = record(parsed, "receipt");
  if (receipt.schema_version !== WALMART_LISTING_INTEGRITY_OPERATOR_RECEIPT_SCHEMA) {
    fail("receipt schema is not the frozen operator receipt schema");
  }
  const expectedBodySha = exactSha(receipt.body_sha256, "receipt.body_sha256");
  const body = { ...receipt };
  delete body.body_sha256;
  if (walmartListingIntegrityControlSha256(body) !== expectedBodySha) {
    fail("receipt body seal is invalid");
  }
  return {
    receipt,
    receiptSha256: createHash("sha256").update(receiptBytes).digest("hex"),
  };
}

function assertIdentity(
  current: WalmartListingIntegrityControlState,
  receipt: Record<string, unknown>,
) {
  const listing = record(receipt.listing, "receipt.listing");
  // The controlled-pool census carries Walmart's WPID in identity.item_id,
  // while frozen operator receipts carry the numeric buyer item ID. They are
  // distinct identifiers for the same listing and must not be compared as the
  // same namespace. Exact listingKey/SKU/store plus the already-bound signed
  // package and permit form the write identity; the receipt item ID is still
  // required to be a bounded exact value.
  exactText(listing.item_id, "receipt.listing.item_id", 100);
  if (listing.channel !== "WALMART_US"
    || listing.listing_key !== current.identity.listing_key
    || listing.sku !== current.identity.sku
    || listing.store_index !== current.identity.store_index) {
    fail("receipt listing identity differs from the queued SKU");
  }
}

function assertBindings(
  current: WalmartListingIntegrityControlState,
  receipt: Record<string, unknown>,
) {
  const executionPackageSha = exactSha(
    receipt.execution_package_artifact_sha256,
    "receipt.execution_package_artifact_sha256",
  );
  const permitSha = exactSha(
    receipt.permit_authorization_sha256,
    "receipt.permit_authorization_sha256",
  );
  if (executionPackageSha !== current.execution_package_sha256
    || permitSha !== current.owner_permit_sha256) {
    fail("receipt package or permit binding differs from control state");
  }
  return { executionPackageSha, permitSha };
}

function assertReadOnlyExternalEffects(receipt: Record<string, unknown>) {
  const effects = record(receipt.external_effects, "receipt.external_effects");
  if (effects.database_writes !== 0
    || effects.model_calls !== 0
    || effects.paid_provider_calls !== 0
    || effects.walmart_content_writes !== 0) {
    fail("continuation receipt contains forbidden external effects");
  }
}

function admitExecute(input: {
  current: WalmartListingIntegrityControlState;
  receipt: Record<string, unknown>;
  receiptSha256: string;
}): WalmartListingIntegrityControlState {
  const { current, receipt } = input;
  if (current.state !== "APPLY_REQUESTING") {
    fail("execute receipt requires APPLY_REQUESTING state");
  }
  const { executionPackageSha, permitSha } = assertBindings(current, receipt);
  exactFalse(receipt.automatic_reapply_allowed, "receipt.automatic_reapply_allowed");
  if (exactInteger(receipt.marketplace_write_calls, "receipt.marketplace_write_calls") !== 1) {
    fail("execute must contain exactly one marketplace write");
  }
  const transport = record(receipt.transport_counts, "receipt.transport_counts");
  if (transport.maintenance_post_calls !== 1) {
    fail("execute transport must contain exactly one maintenance POST");
  }
  const status = exactText(receipt.status, "receipt.status", 64);
  const completedAt = canonicalInstant(receipt.completed_at, "receipt.completed_at");
  const feedId = receipt.feed_id === null || receipt.feed_id === undefined
    ? null : exactText(receipt.feed_id, "receipt.feed_id", 500);
  const accepted = status === "APPLIED_PROPAGATING" || status === "SUCCEEDED";
  if (accepted && !feedId) fail("accepted execute receipt requires a feed id");
  return transitionWalmartListingIntegrityControlState({
    current,
    next_state: accepted ? "APPLIED" : "MANUAL_REVIEW",
    transitioned_at: completedAt,
    evidence_sha256: input.receiptSha256,
    execution_package_sha256: executionPackageSha,
    owner_permit_sha256: permitSha,
    feed_id: feedId,
    marketplace_write_calls: 1,
  });
}

function admitResume(input: {
  current: WalmartListingIntegrityControlState;
  receipt: Record<string, unknown>;
  receiptSha256: string;
}): WalmartListingIntegrityControlState {
  const { current, receipt } = input;
  if (current.state !== "APPLIED" && current.state !== "PROPAGATING") {
    fail("resume receipt requires APPLIED or PROPAGATING state");
  }
  const { executionPackageSha, permitSha } = assertBindings(current, receipt);
  exactFalse(receipt.automatic_reapply_allowed, "receipt.automatic_reapply_allowed");
  if (receipt.continuation_marketplace_write_calls !== 0
    || receipt.marketplace_write_calls !== 1) {
    fail("resume must preserve one cumulative write and add zero writes");
  }
  assertReadOnlyExternalEffects(receipt);
  const transport = record(receipt.transport_counts, "receipt.transport_counts");
  if (transport.maintenance_post_calls !== 0
    || exactInteger(transport.feed_status_get_calls, "feed_status_get_calls", 1) !== 1) {
    fail("resume transport must be one feed GET and zero maintenance POST");
  }
  const feedId = exactText(receipt.feed_id, "receipt.feed_id", 500);
  if (feedId !== current.feed_id) fail("resume feed differs from control state");
  const status = exactText(receipt.status, "receipt.status", 64);
  const nextState = status === "APPLIED_PROPAGATING"
    ? "PROPAGATING"
    : status === "SUCCEEDED"
      ? "LIVE_REREAD"
      : status === "FAILED"
        ? "QUARANTINED_UNRESOLVED" : "MANUAL_REVIEW";
  return transitionWalmartListingIntegrityControlState({
    current,
    next_state: nextState,
    transitioned_at: canonicalInstant(receipt.completed_at, "receipt.completed_at"),
    evidence_sha256: input.receiptSha256,
    execution_package_sha256: executionPackageSha,
    owner_permit_sha256: permitSha,
    feed_id: feedId,
    marketplace_write_calls: 1,
  });
}

const REQUIRED_QUALIFICATION_FACETS = Object.freeze([
  "attributes",
  "bullets",
  "description",
  "exact_listing_identity",
  "exact_repair_target",
  "fresh_authenticated_live_reread",
  "gallery",
  "main",
  "pack_count",
  "product_and_variant",
  "published_and_indexed",
  "terminal_apply_custody",
  "title",
  "unchanged_fields_preserved",
]);

function admitQualification(input: {
  current: WalmartListingIntegrityControlState;
  receipt: Record<string, unknown>;
  receiptSha256: string;
}): WalmartListingIntegrityControlState {
  const { current, receipt } = input;
  if (current.state !== "LIVE_REREAD") {
    fail("qualify receipt requires LIVE_REREAD state");
  }
  const { executionPackageSha, permitSha } = assertBindings(current, receipt);
  exactFalse(receipt.automatic_reapply_allowed, "receipt.automatic_reapply_allowed");
  assertReadOnlyExternalEffects(receipt);
  const feedId = exactText(receipt.feed_id, "receipt.feed_id", 500);
  if (feedId !== current.feed_id) fail("Qualification feed differs from control state");
  const qualification = record(receipt.qualification, "receipt.qualification");
  exactFalse(
    qualification.automatic_reapply_allowed,
    "receipt.qualification.automatic_reapply_allowed",
  );
  if (qualification.marketplace_write_authorized !== false) {
    fail("Qualification must grant no marketplace write authority");
  }
  const authority = record(qualification.authority, "receipt.qualification.authority");
  if (authority.terminal_apply_custody_verified !== true
    || authority.live_capture_created_by_qualifier !== true
    || authority.cached_capture_accepted !== false
    || authority.caller_authored_verdict_accepted !== false) {
    fail("Qualification authority is not a fresh frozen live reread");
  }
  const status = exactText(receipt.status, "receipt.status", 64);
  if (qualification.verdict !== status) fail("Qualification verdict differs from receipt status");
  const facets = record(qualification.facets, "receipt.qualification.facets");
  const allPass = REQUIRED_QUALIFICATION_FACETS.every((facet) => facets[facet] === "PASS");
  if (status === "PASS" && (!allPass || qualification.next_sku_unblocked !== true)) {
    fail("Qualification PASS requires every facet PASS and next SKU unblocked");
  }
  if (status === "PENDING_PROPAGATION"
    && (qualification.next_sku_unblocked !== false
      || record(qualification.propagation, "receipt.qualification.propagation")
        .recheck_same_sku_without_write !== true)) {
    fail("pending Qualification must recheck the same SKU without write");
  }
  const nextState = status === "PASS"
    ? "QUALIFIED_PASS"
    : status === "PENDING_PROPAGATION"
      ? "LIVE_REREAD"
      : status === "FAIL"
        ? "QUARANTINED_UNRESOLVED" : "MANUAL_REVIEW";
  return transitionWalmartListingIntegrityControlState({
    current,
    next_state: nextState,
    transitioned_at: canonicalInstant(receipt.completed_at, "receipt.completed_at"),
    evidence_sha256: input.receiptSha256,
    execution_package_sha256: executionPackageSha,
    owner_permit_sha256: permitSha,
    feed_id: feedId,
    marketplace_write_calls: 1,
  });
}

export function admitWalmartListingIntegrityOperatorReceipt(input: {
  stage: WalmartListingIntegritySchedulerStage;
  current: WalmartListingIntegrityControlState;
  receipt_bytes: Uint8Array;
}): WalmartListingIntegrityControlState {
  if (input.stage !== "ONE_SKU") {
    fail("operator receipt admission requires explicitly activated ONE_SKU stage");
  }
  const current = verifyWalmartListingIntegrityControlState(input.current);
  const { receipt, receiptSha256 } = decodeReceipt(input.receipt_bytes);
  assertIdentity(current, receipt);
  const command = exactText(receipt.command, "receipt.command", 32);
  if (command === "execute") return admitExecute({ current, receipt, receiptSha256 });
  if (command === "resume") return admitResume({ current, receipt, receiptSha256 });
  if (command === "qualify") {
    return admitQualification({ current, receipt, receiptSha256 });
  }
  fail(`operator command ${command} is not admitted by the transition boundary`);
}
