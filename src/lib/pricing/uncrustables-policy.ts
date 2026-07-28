/**
 * Central guard for obsolete Uncrustables price writers.
 *
 * Kept as a `void` function (rather than a top-level `throw`) so TypeScript can
 * still type-check the archived code below each call. At runtime it always
 * stops before credentials, Amazon, ChannelMAX artifacts, or DB writes.
 */
export function blockLegacyUncrustablesPriceMutation(source: string): void {
  throw new Error(
    `DISABLED ${source}: Uncrustables base prices are canonical and coupon-only. Use repair-uncrustables-surgical.ts for corrections; do not use a legacy price writer.`,
  );
}
