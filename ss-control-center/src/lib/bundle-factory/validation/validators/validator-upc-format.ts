/**
 * Phase 2.4 Stage 6 — Validator 10: UPC format + uniqueness.
 *
 * Checks all four invariants:
 *   1. 12 digits, no other characters
 *   2. valid GS1 check digit (mod-10 weighted)
 *   3. UPC exists in our UPCPool (i.e. we own it — not a guess)
 *   4. UPC isn't already assigned to a different ChannelSKU
 *
 * Failing #1/#2 is an unrecoverable error (typo or fabricated UPC).
 * Failing #3 is also error — listing with a UPC outside the pool risks
 * marketplace-side suppression for "GTIN ownership not verified".
 * Failing #4 is a hard conflict.
 */

import { prisma } from "@/lib/prisma";
import type { ValidatorFn } from "../types";

const TWELVE_DIGITS = /^\d{12}$/;

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

  const poolRow = await prisma.uPCPool.findUnique({ where: { upc } });
  if (!poolRow) {
    return {
      validator_id: "validator-upc-format",
      passed: false,
      severity: "error",
      message: `UPC "${upc}" is not in our UPCPool — risk of marketplace GTIN-ownership suppression.`,
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
    details: { upc, gs1_validated: poolRow.gs1_validated },
  };
};
