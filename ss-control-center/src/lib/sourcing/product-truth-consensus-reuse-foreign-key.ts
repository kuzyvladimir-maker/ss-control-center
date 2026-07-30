import type { Client, Row, Transaction } from "@libsql/client";

export const PRODUCT_TRUTH_CONSENSUS_REUSE_FOREIGN_KEY_TABLES = [
  "CanonicalProductVariant",
  "DonorProductVariantDecision",
  "ProductContentObservation",
  "ProductTruthListingRecipe",
  "ProductTruthListingRecipeComponent",
  "SkuCostListingScopeLink",
  "SkuComponentEvidence",
  "SkuCost",
] as const;

type SqlReader = Pick<Client, "execute"> | Pick<Transaction, "execute">;

export interface ProductTruthConsensusReuseForeignKeyViolation {
  checkedTable: string;
  table: string | null;
  rowid: number | string | null;
  parent: string | null;
  fkid: number | string | null;
}

function scalar(value: unknown): number | string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number" || typeof value === "string") return value;
  return String(value);
}

function violation(
  checkedTable: string,
  row: Row,
): ProductTruthConsensusReuseForeignKeyViolation {
  return {
    checkedTable,
    table: scalar(row.table) as string | null,
    rowid: scalar(row.rowid),
    parent: scalar(row.parent) as string | null,
    fkid: scalar(row.fkid),
  };
}

/**
 * Verify only the append-only Product Truth graph touched by consensus reuse.
 * A global PRAGMA scans every unrelated Command Center table and can stall a
 * remote libSQL connection; table-scoped checks preserve the write boundary.
 */
export async function checkProductTruthConsensusReuseForeignKeys(
  db: SqlReader,
): Promise<ProductTruthConsensusReuseForeignKeyViolation[]> {
  const result: ProductTruthConsensusReuseForeignKeyViolation[] = [];
  for (const table of PRODUCT_TRUTH_CONSENSUS_REUSE_FOREIGN_KEY_TABLES) {
    const rows = await db.execute(
      `PRAGMA foreign_key_check("${table}")`,
    );
    result.push(...rows.rows.map((row) => violation(table, row)));
  }
  return result;
}
