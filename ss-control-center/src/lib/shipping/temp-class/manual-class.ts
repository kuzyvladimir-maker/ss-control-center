/**
 * Validation for a MANUAL temperature class set from the Command Center —
 * the Set product type dialog, the AI classification dialog, the card chip
 * and the external fix-tag API all go through this (topic 135, 2026-10-30:
 * "Chilled" must be accepted everywhere, never rejected or silently turned
 * into Frozen).
 */

import { isTempClass, type TempClass } from "./classes";

export const WALMART_COLD_REASON =
  "Frozen and chilled are forbidden on Walmart — Walmart orders always ship Dry.";

/**
 * Parse the class an operator picked: "Frozen" / "Chilled" / "Dry" in any
 * case. On a Walmart order only Dry is allowed.
 */
export function parseManualClass(
  raw: unknown,
  opts: { isWalmart?: boolean } = {},
): { ok: true; klass: TempClass } | { ok: false; error: string } {
  const klass = String(raw ?? "").trim().toUpperCase();
  if (!isTempClass(klass)) {
    return { ok: false, error: 'type must be "Frozen", "Chilled" or "Dry"' };
  }
  if (opts.isWalmart && klass !== "DRY") {
    return { ok: false, error: WALMART_COLD_REASON };
  }
  return { ok: true, klass };
}

/** "walmart" channel hint from a request body (the order the operator is on). */
export function isWalmartChannel(channel: unknown): boolean {
  return String(channel ?? "").trim().toLowerCase() === "walmart";
}
