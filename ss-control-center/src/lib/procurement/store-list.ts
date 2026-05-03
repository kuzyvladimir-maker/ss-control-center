/**
 * Fixed list of physical stores Vladimir buys from. Shown in the
 * StorePriorityPopup dropdown — keeps store names consistent across SKUs
 * (no typos like "Publix" / "publix" / "Publix Store" mixed together).
 */
export const STORE_OPTIONS: ReadonlyArray<string> = [
  "Publix",
  "Walmart",
  "BJ's",
  "Sam's Club",
  "Costco",
  "Trader Joe's",
  "Aldi",
  "Whole Foods",
  "Other",
];

/**
 * Recognised Prisma error code thrown when a model's table doesn't yet
 * exist in the connected database. We use this to detect "Turso not
 * migrated yet" and degrade the UI gracefully.
 */
export const PRISMA_TABLE_NOT_FOUND = "P2021";

interface PrismaErrorLike {
  code?: string;
  message?: string;
}

export function isMissingTableError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const err = e as PrismaErrorLike;
  if (err.code === PRISMA_TABLE_NOT_FOUND) return true;
  // Belt-and-suspenders: SQLite/libsql sometimes surfaces this as a plain
  // error with "no such table" in the message.
  if (typeof err.message === "string" && /no such table/i.test(err.message)) {
    return true;
  }
  return false;
}
