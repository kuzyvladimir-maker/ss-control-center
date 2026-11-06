/** Owner scope, 2026-11-06: other Amazon accounts remain blocked. */
export const ACTIVE_CS_STORES = [1];
export function assertActiveCsStore(storeIndex: number) {
  if (!ACTIVE_CS_STORES.includes(storeIndex)) throw new Error("Customer Service is disabled for this store");
}
