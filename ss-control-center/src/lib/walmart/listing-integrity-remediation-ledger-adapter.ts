/**
 * Concrete single-custody adapter between the one-SKU writer and the durable
 * permit ledger.  The writer already verifies the signed permit; this adapter
 * independently refuses to touch a ledger whose immutable identity differs
 * from the permit binding supplied at construction time.
 *
 * This module performs filesystem-only ledger operations.  It has no network,
 * database, model, or marketplace dependency.
 */

import { resolve } from "node:path";

import type {
  WalmartListingRepairConsumptionLedgerBinding,
  WalmartListingRepairOneSkuPermit,
} from "./listing-integrity-remediation-authority.ts";
import {
  consumeWalmartListingRepairPermit,
  loadWalmartListingRepairPermitAccepted,
  loadWalmartListingRepairPermitRequesting,
  recordWalmartListingRepairPermitAccepted,
  terminalizeWalmartListingRepairPermit,
} from "./listing-integrity-remediation-ledger.ts";
import type {
  WalmartListingRepairAcceptedReceipt,
  WalmartListingRepairLedgerAdapter,
  WalmartListingRepairRequestingReceipt,
} from "./listing-integrity-remediation-writer.ts";

type JsonRecord = Record<string, unknown>;

export class WalmartListingRepairLedgerAdapterError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WalmartListingRepairLedgerAdapterError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new WalmartListingRepairLedgerAdapterError(code, message);
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("INVALID_LEDGER_BINDING", "ledger binding contains a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") {
    fail("INVALID_LEDGER_BINDING", "ledger binding is not canonical JSON");
  }
  const row = value as JsonRecord;
  return `{${Object.keys(row).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(row[key])}`
  )).join(",")}}`;
}

function exactEqual(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function exactPermitBinding(
  permit: WalmartListingRepairOneSkuPermit,
  expected: WalmartListingRepairConsumptionLedgerBinding,
): void {
  if (!permit || typeof permit !== "object"
    || typeof permit.authorization_sha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(permit.authorization_sha256)
    || !permit.signed_body
    || !exactEqual(permit.signed_body.consumption_ledger, expected)) {
    fail(
      "PERMIT_LEDGER_BINDING_MISMATCH",
      "one-SKU permit is not bound to this exact durable ledger identity",
    );
  }
}

function assertRequestBinding(
  receipt: WalmartListingRepairRequestingReceipt | WalmartListingRepairAcceptedReceipt,
  manifestSha: string,
  payloadSha: string,
): void {
  if (receipt.request_manifest_sha256 !== manifestSha
    || receipt.request_payload_sha256 !== payloadSha) {
    fail(
      "REQUEST_LEDGER_BINDING_MISMATCH",
      "durable ledger receipt differs from the exact request manifest/payload",
    );
  }
}

export function createWalmartListingRepairLedgerAdapter(options: {
  state_directory: string;
  expected_binding: WalmartListingRepairConsumptionLedgerBinding;
}): WalmartListingRepairLedgerAdapter {
  if (typeof options.state_directory !== "string" || !options.state_directory.trim()) {
    fail("INVALID_STATE_DIRECTORY", "ledger state_directory must be a non-empty path");
  }
  const stateDirectory = resolve(options.state_directory);
  if (stateDirectory !== options.state_directory) {
    fail("INVALID_STATE_DIRECTORY", "ledger state_directory must be an absolute normalized path");
  }
  const expectedBinding = structuredClone(options.expected_binding);

  return Object.freeze({
    consume: async ({
      permit,
      claimed_at,
      requesting_at,
      request_manifest_sha256,
      request_payload_sha256,
    }) => {
      exactPermitBinding(permit, expectedBinding);
      const receipt = await consumeWalmartListingRepairPermit({
        state_directory: stateDirectory,
        expected_binding: expectedBinding,
        permit_authorization_sha256: permit.authorization_sha256,
        claimed_at,
        requesting_at,
        request_manifest_sha256,
        request_payload_sha256,
      });
      assertRequestBinding(receipt, request_manifest_sha256, request_payload_sha256);
      return receipt;
    },

    loadRequesting: async ({ permit, request_manifest_sha256, request_payload_sha256 }) => {
      exactPermitBinding(permit, expectedBinding);
      const loaded = await loadWalmartListingRepairPermitRequesting({
        state_directory: stateDirectory,
        expected_binding: expectedBinding,
        permit_authorization_sha256: permit.authorization_sha256,
      });
      assertRequestBinding(loaded.receipt, request_manifest_sha256, request_payload_sha256);
      return loaded.receipt;
    },

    recordAccepted: async ({
      permit,
      requesting,
      accepted_at,
      apply_id,
      feed_id,
      response_http_receipt_sha256,
      response_payload_sha256,
    }) => {
      exactPermitBinding(permit, expectedBinding);
      if (requesting.authorization_sha256 !== permit.authorization_sha256) {
        fail("PERMIT_RECEIPT_BINDING_MISMATCH", "REQUESTING receipt belongs to another permit");
      }
      return recordWalmartListingRepairPermitAccepted({
        state_directory: stateDirectory,
        expected_binding: expectedBinding,
        requesting: requesting as Parameters<
          typeof recordWalmartListingRepairPermitAccepted
        >[0]["requesting"],
        accepted_at,
        apply_id,
        feed_id,
        response_http_receipt_sha256,
        response_payload_sha256,
      });
    },

    loadAccepted: async ({ permit, request_manifest_sha256, request_payload_sha256 }) => {
      exactPermitBinding(permit, expectedBinding);
      const loaded = await loadWalmartListingRepairPermitAccepted({
        state_directory: stateDirectory,
        expected_binding: expectedBinding,
        permit_authorization_sha256: permit.authorization_sha256,
      });
      assertRequestBinding(loaded.receipt, request_manifest_sha256, request_payload_sha256);
      return loaded.receipt;
    },

    terminalize: async ({ permit, prior, outcome }) => {
      exactPermitBinding(permit, expectedBinding);
      if (prior.authorization_sha256 !== permit.authorization_sha256) {
        fail("PERMIT_RECEIPT_BINDING_MISMATCH", "prior ledger receipt belongs to another permit");
      }
      const receipt = await terminalizeWalmartListingRepairPermit({
        state_directory: stateDirectory,
        expected_binding: expectedBinding,
        prior: prior as Parameters<typeof terminalizeWalmartListingRepairPermit>[0]["prior"],
        outcome: {
          state: outcome.state,
          terminal_at: outcome.terminal_at,
          apply_id: outcome.apply_id,
          marketplace_write_calls: outcome.marketplace_write_calls,
          feed_id: outcome.feed_id,
          response_http_receipt_sha256: outcome.response_http_receipt_sha256,
          response_payload_sha256: outcome.response_payload_sha256,
          feed_status_http_receipt_sha256: outcome.feed_status_http_receipt_sha256,
          feed_status_payload_sha256: outcome.feed_status_payload_sha256,
          error_code: outcome.error_code,
        },
      });
      if (receipt.state !== outcome.state) {
        fail("TERMINAL_LEDGER_BINDING_MISMATCH", "durable terminal state differs from writer outcome");
      }
      return receipt;
    },
  });
}
