// Canonical store/channel → legal-entity mapping for finance traceability.
// Exact names — used in payouts and (later) per-entity P&L. See the memory note
// reference_legal_entities for the full picture (owners, partner equity).

export const AMAZON_STORE_ENTITY: Record<number, string> = {
  1: "Salutem Solutions LLC",
  2: "Vladimir Personal",
  3: "AMZ Commerce",
  4: "Sirius International",
  5: "Retailer Distributor",
};

/** The single live Walmart account is on Sirius International. */
export const WALMART_ENTITY = "Sirius International";

/** "store3" → 3 ; "3" → 3. */
export function storeIdToIndex(storeId: string): number {
  return Number(String(storeId).replace(/\D/g, "")) || 0;
}

export function amazonEntityFor(storeId: string): string {
  return AMAZON_STORE_ENTITY[storeIdToIndex(storeId)] ?? storeId;
}
