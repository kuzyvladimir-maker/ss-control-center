/**
 * Read-only composition boundary for one completed Walmart listing repair.
 *
 * Callers provide authority objects plus a narrow immutable reference. They do
 * not provide ledger or HTTP/payload bytes. This adapter loads those bytes from
 * two fixed single-host custody roots, verifies the current SUCCEEDED ledger
 * HEAD, maps the artifact-custody names into the pure verifier contract, and
 * rejects any custody/reference drift observed before it returns.
 *
 * This module has no bootstrap, persistence, network, database, model, or
 * marketplace dependency. Production remains fail-closed until a separately
 * frozen release wires this adapter into the Qualification Officer.
 */

import path from "node:path";

import type {
  WalmartListingRepairOneSkuPermit,
  WalmartListingRepairSequenceAuthorization,
} from "./listing-integrity-remediation-authority.ts";
import {
  withWalmartListingRepairLockedArtifactCustody,
  type WalmartListingRepairSucceededTerminalArtifacts,
} from "./listing-integrity-remediation-artifacts.ts";
import {
  verifyWalmartListingRepairCustodyLoadedApplyEvidence,
  type VerifiedWalmartListingRepairCustodyApplyEvidence,
  type WalmartListingRepairCustodyLoadedApplyEvidence,
} from "./listing-integrity-remediation-apply-evidence.ts";
import {
  readWalmartListingRepairPermitLedgerEvidence,
  type WalmartListingRepairPermitLedgerEvidence,
  type WalmartListingRepairPermitTerminalReceipt,
} from "./listing-integrity-remediation-ledger.ts";
import type {
  WalmartListingSurgicalBaselineReference,
} from "./listing-integrity-remediation-payload.ts";
import type {
  SealedWalmartListingRepairPlan,
} from "./listing-integrity-remediation-qualification.ts";

export const WALMART_LISTING_REPAIR_APPLY_EVIDENCE_REFERENCE_SCHEMA =
  "walmart-listing-repair-apply-evidence-reference/v1" as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

type JsonRecord = Record<string, unknown>;

export interface WalmartListingRepairApplyEvidenceReference {
  schema_version: typeof WALMART_LISTING_REPAIR_APPLY_EVIDENCE_REFERENCE_SCHEMA;
  permit_authorization_sha256: string;
  ledger_identity_sha256: string;
  ledger_terminal_sha256: string;
  ledger_head_sha256: string;
  artifact_custody_identity_sha256: string;
  artifact_custody_inventory_sha256: string;
}

export interface WalmartListingRepairCustodyApplyEvidenceAdapter {
  readonly custody_root: string;
  readonly ledger_state_directory: string;
  verify(
    input: WalmartListingRepairCustodyApplyEvidenceVerifyInput,
  ): Promise<VerifiedWalmartListingRepairCustodyApplyEvidence>;
}

export interface WalmartListingRepairCustodyApplyEvidenceVerifyInput {
  reference: WalmartListingRepairApplyEvidenceReference;
  sequence: WalmartListingRepairSequenceAuthorization;
  permit: WalmartListingRepairOneSkuPermit;
  plan: SealedWalmartListingRepairPlan;
  baseline: WalmartListingSurgicalBaselineReference;
}

export class WalmartListingRepairApplyEvidenceAdapterError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WalmartListingRepairApplyEvidenceAdapterError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new WalmartListingRepairApplyEvidenceAdapterError(code, message);
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("REFERENCE_INVALID", `${label} must be an object`);
  }
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
    || actual.some((entry, index) => entry !== wanted[index])) {
    fail("REFERENCE_INVALID", `${label} has missing or extra fields`);
  }
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail("REFERENCE_INVALID", `${label} must be a lowercase SHA-256 digest`);
  }
  return value;
}

function fixedAbsolutePath(value: unknown, label: string): string {
  if (typeof value !== "string" || !value || value !== value.trim()
    || !path.isAbsolute(value) || path.resolve(value) !== value
    || value === path.parse(value).root) {
    fail("PATH_INVALID", `${label} must be an exact normalized absolute non-root path`);
  }
  return value;
}

function parseReference(value: unknown): WalmartListingRepairApplyEvidenceReference {
  const raw = record(value, "apply evidence reference");
  exactKeys(raw, [
    "schema_version",
    "permit_authorization_sha256",
    "ledger_identity_sha256",
    "ledger_terminal_sha256",
    "ledger_head_sha256",
    "artifact_custody_identity_sha256",
    "artifact_custody_inventory_sha256",
  ], "apply evidence reference");
  if (raw.schema_version !== WALMART_LISTING_REPAIR_APPLY_EVIDENCE_REFERENCE_SCHEMA) {
    fail("REFERENCE_INVALID", "apply evidence reference schema is invalid");
  }
  return {
    schema_version: WALMART_LISTING_REPAIR_APPLY_EVIDENCE_REFERENCE_SCHEMA,
    permit_authorization_sha256: digest(
      raw.permit_authorization_sha256,
      "reference permit authorization SHA",
    ),
    ledger_identity_sha256: digest(
      raw.ledger_identity_sha256,
      "reference ledger identity SHA",
    ),
    ledger_terminal_sha256: digest(
      raw.ledger_terminal_sha256,
      "reference ledger terminal SHA",
    ),
    ledger_head_sha256: digest(raw.ledger_head_sha256, "reference ledger HEAD SHA"),
    artifact_custody_identity_sha256: digest(
      raw.artifact_custody_identity_sha256,
      "reference artifact-custody identity SHA",
    ),
    artifact_custody_inventory_sha256: digest(
      raw.artifact_custody_inventory_sha256,
      "reference artifact-custody inventory SHA",
    ),
  };
}

function succeededTerminal(
  evidence: WalmartListingRepairPermitLedgerEvidence,
): WalmartListingRepairPermitTerminalReceipt {
  if (evidence.state !== "SUCCEEDED" || evidence.receipt.state !== "SUCCEEDED"
    || evidence.terminal_bytes === null || evidence.terminal_sha256 === null) {
    fail(
      "LEDGER_NOT_SUCCEEDED",
      "current ledger HEAD does not contain one terminal SUCCEEDED result",
    );
  }
  return evidence.receipt;
}

function assertReferenceBindings(input: {
  reference: WalmartListingRepairApplyEvidenceReference;
  permit: WalmartListingRepairOneSkuPermit;
  ledger: WalmartListingRepairPermitLedgerEvidence;
  artifact_identity_sha256: string;
  artifact_inventory_sha256: string;
}): void {
  const terminal = succeededTerminal(input.ledger);
  if (input.reference.permit_authorization_sha256 !== input.permit.authorization_sha256
    || input.reference.ledger_identity_sha256
      !== input.permit.signed_body.consumption_ledger.identity_artifact_sha256
    || input.reference.ledger_identity_sha256 !== input.ledger.identity_sha256
    || input.reference.ledger_terminal_sha256 !== input.ledger.terminal_sha256
    || input.reference.ledger_terminal_sha256 !== terminal.terminal_file_sha256
    || input.reference.ledger_head_sha256 !== input.ledger.head_sha256
    || input.reference.ledger_head_sha256 !== terminal.ledger_head_sha256
    || input.reference.artifact_custody_identity_sha256 !== input.artifact_identity_sha256
    || input.reference.artifact_custody_inventory_sha256 !== input.artifact_inventory_sha256) {
    fail(
      "REFERENCE_DRIFT",
      "apply evidence reference differs from the current permit/ledger/artifact custody",
    );
  }
}

function sameLedgerCapture(
  before: WalmartListingRepairPermitLedgerEvidence,
  after: WalmartListingRepairPermitLedgerEvidence,
): boolean {
  return before.state === "SUCCEEDED" && after.state === "SUCCEEDED"
    && before.receipt.state === "SUCCEEDED" && after.receipt.state === "SUCCEEDED"
    && before.identity_sha256 === after.identity_sha256
    && before.claim_sha256 === after.claim_sha256
    && before.requesting_sha256 === after.requesting_sha256
    && before.accepted_sha256 === after.accepted_sha256
    && before.terminal_sha256 === after.terminal_sha256
    && before.head_sha256 === after.head_sha256;
}

function mapLoadedArtifacts(
  input: WalmartListingRepairSucceededTerminalArtifacts,
): Omit<WalmartListingRepairCustodyLoadedApplyEvidence, "ledger"> {
  return {
    writer_artifacts: {
      request_manifest_bytes: input.request_manifest_bytes,
      request_payload_bytes: input.request_payload_bytes,
      post_response_http_receipt_bytes: input.response_http_receipt_bytes,
      post_response_payload_bytes: input.response_payload_bytes,
      terminal_feed_status_http_receipt_bytes: input.feed_status_http_receipt_bytes,
      terminal_feed_status_payload_bytes: input.feed_status_payload_bytes,
    },
    surgical_supporting: {
      target_image_certificate_bytes: input.surgical.target_image_certificate_bytes,
      schema_contract_bytes: input.surgical.schema_contract_bytes,
      get_spec_receipt_bytes: input.surgical.get_spec_receipt_bytes,
      get_spec_request_bytes: input.surgical.get_spec_request_bytes,
      get_spec_response_bytes: input.surgical.get_spec_response_bytes,
      live_item_receipt_bytes: input.surgical.live_item_receipt_bytes,
      live_item_response_bytes: input.surgical.live_item_response_bytes,
    },
  };
}

export function createWalmartListingRepairCustodyApplyEvidenceAdapter(options: {
  custody_root: string;
  ledger_state_directory: string;
}): WalmartListingRepairCustodyApplyEvidenceAdapter {
  const custodyRoot = fixedAbsolutePath(options.custody_root, "custody_root");
  const ledgerStateDirectory = fixedAbsolutePath(
    options.ledger_state_directory,
    "ledger_state_directory",
  );
  if (custodyRoot === ledgerStateDirectory) {
    fail("PATH_INVALID", "artifact custody and ledger custody must be distinct roots");
  }

  return Object.freeze({
    custody_root: custodyRoot,
    ledger_state_directory: ledgerStateDirectory,
    verify: async (
      input: WalmartListingRepairCustodyApplyEvidenceVerifyInput,
    ): Promise<VerifiedWalmartListingRepairCustodyApplyEvidence> => {
      const reference = parseReference(input.reference);
      if (reference.permit_authorization_sha256 !== input.permit.authorization_sha256) {
        fail("REFERENCE_DRIFT", "apply evidence reference belongs to another permit");
      }
      if (reference.ledger_identity_sha256
        !== input.permit.signed_body.consumption_ledger.identity_artifact_sha256) {
        fail("REFERENCE_DRIFT", "apply evidence reference belongs to another ledger identity");
      }

      const initialLedger = await readWalmartListingRepairPermitLedgerEvidence({
        state_directory: ledgerStateDirectory,
        expected_binding: input.permit.signed_body.consumption_ledger,
        permit_authorization_sha256: input.permit.authorization_sha256,
      });
      succeededTerminal(initialLedger);

      return withWalmartListingRepairLockedArtifactCustody({
        custody_root: custodyRoot,
        permit: input.permit,
        operation: async (reader) => {
          const ledgerBefore = await readWalmartListingRepairPermitLedgerEvidence({
            state_directory: ledgerStateDirectory,
            expected_binding: input.permit.signed_body.consumption_ledger,
            permit_authorization_sha256: input.permit.authorization_sha256,
          });
          if (!sameLedgerCapture(initialLedger, ledgerBefore)) {
            fail(
              "CUSTODY_CHANGED_DURING_VERIFICATION",
              "ledger changed before the artifact-custody qualification lock was acquired",
            );
          }
          const terminal = succeededTerminal(ledgerBefore);
          const artifactBefore = await reader.readEvidence();
          assertReferenceBindings({
            reference,
            permit: input.permit,
            ledger: ledgerBefore,
            artifact_identity_sha256: artifactBefore.identity_artifact_sha256,
            artifact_inventory_sha256: artifactBefore.inventory_sha256,
          });

          const terminalArtifacts = await reader.loadSucceededTerminal({ terminal });
          const verified = verifyWalmartListingRepairCustodyLoadedApplyEvidence({
            loaded: {
              ledger: ledgerBefore,
              ...mapLoadedArtifacts(terminalArtifacts),
            },
            sequence: input.sequence,
            permit: input.permit,
            plan: input.plan,
            baseline: input.baseline,
          });

          const ledgerAfter = await readWalmartListingRepairPermitLedgerEvidence({
            state_directory: ledgerStateDirectory,
            expected_binding: input.permit.signed_body.consumption_ledger,
            permit_authorization_sha256: input.permit.authorization_sha256,
          });
          const artifactAfter = await reader.readEvidence();
          if (!sameLedgerCapture(ledgerBefore, ledgerAfter)
            || artifactBefore.identity_artifact_sha256
              !== artifactAfter.identity_artifact_sha256
            || artifactBefore.inventory_sha256 !== artifactAfter.inventory_sha256) {
            fail(
              "CUSTODY_CHANGED_DURING_VERIFICATION",
              "ledger or artifact custody changed while apply evidence was being verified",
            );
          }
          assertReferenceBindings({
            reference,
            permit: input.permit,
            ledger: ledgerAfter,
            artifact_identity_sha256: artifactAfter.identity_artifact_sha256,
            artifact_inventory_sha256: artifactAfter.inventory_sha256,
          });
          return verified;
        },
      });
    },
  });
}
