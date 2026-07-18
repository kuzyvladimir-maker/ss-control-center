/** Marketplace quantity may only come from a recent component-stock check. */

export const INVENTORY_MAX_AGE_MS = 15 * 60_000;

export function inventoryIsFresh(
  checkedAt: Date | string | null | undefined,
  nowMs = Date.now(),
): boolean {
  if (!checkedAt) return false;
  const checkedMs = checkedAt instanceof Date
    ? checkedAt.getTime()
    : new Date(checkedAt).getTime();
  return (
    Number.isFinite(checkedMs) &&
    checkedMs <= nowMs &&
    nowMs - checkedMs <= INVENTORY_MAX_AGE_MS
  );
}
