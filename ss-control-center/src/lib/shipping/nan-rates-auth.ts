import { createHash, timingSafeEqual } from "node:crypto";

/** Header the NAN rates collector sends; value = env NAN_RATES_SECRET. */
export const NAN_RATES_SECRET_HEADER = "x-nan-rates-secret";

/** Constant-time check of the collector's shared secret. */
export function isNanRatesSecretValid(provided: string | null | undefined): boolean {
  const expected = process.env.NAN_RATES_SECRET;
  if (!expected || expected.length < 16 || !provided) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
