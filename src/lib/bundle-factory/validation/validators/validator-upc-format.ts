/**
 * Phase 2.4 Stage 6 — Validator 10: UPC format + uniqueness.
 *
 * Checks all four invariants:
 *   1. 12 digits, no other characters
 *   2. valid GS1 check digit (mod-10 weighted)
 *   3. UPC exists in our owner-managed UPCPool and is ASSIGNED to this SKU
 *   4. UPC isn't marketplace-quarantined or assigned elsewhere
 *
 * Failing #1/#2 is an unrecoverable error (typo or fabricated UPC).
 * `UPCPool.gs1_validated` is a legacy CSV check-digit flag, not proof of a
 * current GS1 registry lookup. This validator only proves local syntax,
 * reservation and uniqueness. The Walmart certification gate separately
 * requires fresh exact-UPC registry, brand-alignment and seller-authority
 * evidence. An explicit marketplace quarantine remains a hard block.
 */

import { prisma } from "@/lib/prisma";
import type { ValidatorFn } from "../types";

const TWELVE_DIGITS = /^\d{12}$/;

export interface ManagedUpcPoolRow {
  id: string;
  status: string;
  assigned_to_id: string | null;
  gs1_validated: boolean;
}

export function evaluateManagedUpcAssignment(input: {
  skuId: string;
  skuUpcPoolId: string | null;
  poolRow: ManagedUpcPoolRow;
}): { ok: true } | { ok: false; code: string; message: string } {
  const status = input.poolRow.status.trim().toUpperCase();
  if (["BURNED", "QUARANTINED", "INVALID", "RETIRED"].includes(status)) {
    return {
      ok: false,
      code: "UPC_POOL_QUARANTINED",
      message: `UPC pool row is ${status} and cannot be submitted.`,
    };
  }
  if (
    status !== "ASSIGNED" ||
    input.poolRow.assigned_to_id !== input.skuId ||
    input.skuUpcPoolId !== input.poolRow.id
  ) {
    return {
      ok: false,
      code: "UPC_POOL_ASSIGNMENT_MISMATCH",
      message:
        "UPC must be atomically ASSIGNED to this ChannelSKU in the owner-managed pool.",
    };
  }
  return { ok: true };
}

/** Standard UPC-A mod-10 check digit. Sum odd-position digits ×3 + even
 *  positions ×1 over the first 11; check digit makes the total a
 *  multiple of 10. */
function isValidUpcChecksum(upc: string): boolean {
  if (!TWELVE_DIGITS.test(upc)) return false;
  let sum = 0;
  for (let i = 0; i < 11; i++) {
    const d = upc.charCodeAt(i) - 48;
    sum += i % 2 === 0 ? d * 3 : d;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === upc.charCodeAt(11) - 48;
}

export const validatorUpcFormat: ValidatorFn = async ({ sku }) => {
  const upc = (sku.upc || "").trim();
  if (!upc) {
    return {
      validator_id: "validator-upc-format",
      passed: false,
      severity: "error",
      message: "UPC is empty.",
    };
  }
  if (!TWELVE_DIGITS.test(upc)) {
    return {
      validator_id: "validator-upc-format",
      passed: false,
      severity: "error",
      message: `UPC "${upc}" is not 12 digits.`,
      details: { upc },
    };
  }
  if (!isValidUpcChecksum(upc)) {
    return {
      validator_id: "validator-upc-format",
      passed: false,
      severity: "error",
      message: `UPC "${upc}" has an invalid GS1 check digit.`,
      details: { upc },
    };
  }

  const poolRow = await prisma.uPCPool.findUnique({
    where: { upc },
    select: {
      id: true,
      status: true,
      assigned_to_id: true,
      gs1_validated: true,
    },
  });
  if (!poolRow) {
    return {
      validator_id: "validator-upc-format",
      passed: false,
      severity: "error",
      message: `UPC "${upc}" is not in our UPCPool — risk of marketplace GTIN-ownership suppression.`,
    };
  }

  const assignment = evaluateManagedUpcAssignment({
    skuId: sku.id,
    skuUpcPoolId: sku.upc_pool_id,
    poolRow,
  });
  if (!assignment.ok) {
    return {
      validator_id: "validator-upc-format",
      passed: false,
      severity: "error",
      message: `${assignment.message} UPC: "${upc}".`,
      details: {
        upc,
        code: assignment.code,
        pool_status: poolRow.status,
        pool_assigned_to_id: poolRow.assigned_to_id,
        sku_upc_pool_id: sku.upc_pool_id,
      },
    };
  }

  // Uniqueness check via DB. ChannelSKU.upc is already unique-indexed,
  // but we want a friendly error rather than a 500 on insert. Also
  // catches the case where another draft reserved the same UPC from
  // the pool but hasn't been validated yet.
  const conflict = await prisma.channelSKU.findFirst({
    where: { upc, id: { not: sku.id } },
    select: { id: true, channel: true },
  });
  if (conflict) {
    return {
      validator_id: "validator-upc-format",
      passed: false,
      severity: "error",
      message: `UPC "${upc}" already assigned to ChannelSKU ${conflict.id} (${conflict.channel}).`,
      details: { conflicting_sku_id: conflict.id, conflicting_channel: conflict.channel },
    };
  }

  return {
    validator_id: "validator-upc-format",
    passed: true,
    details: {
      upc,
      ownership_basis: "OWNER_MANAGED_UPC_POOL",
      pool_status: poolRow.status,
      legacy_csv_check_digit_flag: poolRow.gs1_validated,
      legacy_flag_is_registry_proof: false,
      fresh_walmart_product_identifier_evidence_required: true,
    },
  };
};
