/**
 * Active Amazon stores for Customer Service (owner, topic 42, 2026-11-04):
 * only store 1 (Salutem Solutions) is live; stores 2-5 are blocked by Amazon.
 * Add an index back here the moment Amazon unblocks that account — every CS
 * path (inbox scans, status, alerts, tasks) reads this one list.
 */
export const ACTIVE_CS_STORES = [1];
/** Every Amazon store the hub tracks (store1..store5). */
export const ALL_CS_STORES = [1, 2, 3, 4, 5];
/** Stores Amazon has blocked — never scanned/tasked; surfaced as "blocked". */
export const BLOCKED_CS_STORES = ALL_CS_STORES.filter((s) => !ACTIVE_CS_STORES.includes(s));
export function isActiveCsStore(storeIndex: number): boolean {
  return ACTIVE_CS_STORES.includes(storeIndex);
}
export function assertActiveCsStore(storeIndex: number) {
  if (!ACTIVE_CS_STORES.includes(storeIndex)) throw new Error("Customer Service is disabled for this store");
}
