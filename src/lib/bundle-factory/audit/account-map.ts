// Bridge between the audit's account keys ('SALUTEM', 'PERSONAL', …)
// and the SP-API client's storeIndex (1..5). Defined in CLAUDE.md.
//
// Single source of truth so the rest of the audit code never has to
// hand-roll this mapping.

export const ACCOUNT_KEYS = [
  "SALUTEM",
  "PERSONAL",
  "AMZCOM",
  "SIRIUS",
  "RETAILER",
] as const;

export type AccountKey = (typeof ACCOUNT_KEYS)[number];

const STORE_INDEX_BY_ACCOUNT: Record<AccountKey, number> = {
  SALUTEM: 1, // Salutem Solutions (Brand Registry owner)
  PERSONAL: 2, // Vladimir Personal
  AMZCOM: 3, // AMZ Commerce
  SIRIUS: 4, // Sirius International
  RETAILER: 5, // Retailer Distributor (blocked 2026-05-17)
};

export function storeIndexFor(account: AccountKey): number {
  return STORE_INDEX_BY_ACCOUNT[account];
}

export function accountFromStoreIndex(storeIndex: number): AccountKey | null {
  const entry = (Object.entries(STORE_INDEX_BY_ACCOUNT) as Array<
    [AccountKey, number]
  >).find(([, idx]) => idx === storeIndex);
  return entry?.[0] ?? null;
}

// Audit order: blocked account first (so we can fix listings before
// reactivation attempt), then Brand Registry owner, then everyone else.
// See BUNDLE_FACTORY_LISTING_AUDIT_TOOL_v1_0.md §"Order of audits".
export const AUDIT_ORDER: AccountKey[] = [
  "RETAILER",
  "SALUTEM",
  "AMZCOM",
  "PERSONAL",
  "SIRIUS",
];
