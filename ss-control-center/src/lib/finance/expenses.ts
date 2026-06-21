// OpEx helpers — recurring business expenses → monthly obligation per fund.
//
// Vladimir's model: the expense CATEGORIES are the FP1 (life-support) funds
// (Salaries, Warehouse & Logistics, Software, Subscriptions). Each fund must
// accumulate enough each month to cover its recurring expenses. Source data is
// Sellerboard's expenses export (Indirect/Variable Expenses).

export const WEEKS_PER_MONTH = 52 / 12; // 4.3333…
export const WORKDAYS_PER_MONTH = 260 / 12; // ≈21.67 (5-day week)

/** The FP1 fund categories derived from the expenses. Order = display order. */
export const EXPENSE_CATEGORIES = [
  "Salaries",
  "Warehouse & Logistics",
  "Software",
  "Subscriptions",
  "Other",
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

/** Normalize one expense to its MONTHLY cost. daily = per working day (×260/12);
 *  weekly × 52/12; one-time → 0; else monthly. */
export function monthlyAmount(amount: number, frequency: string): number {
  if (!Number.isFinite(amount)) return 0;
  if (frequency === "daily") return Math.round(amount * WORKDAYS_PER_MONTH * 100) / 100;
  if (frequency === "weekly") return Math.round(amount * WEEKS_PER_MONTH * 100) / 100;
  if (frequency === "yearly") return Math.round((amount / 12) * 100) / 100;
  if (frequency === "one_time") return 0;
  return Math.round(amount * 100) / 100; // monthly
}

export const FREQUENCIES = ["monthly", "weekly", "daily", "yearly", "one_time"] as const;

export const WORKDAYS_PER_WEEK = 5;
export const WORKDAYS_PER_YEAR = 260;

/** Per-WORKING-DAY rate for a salary item (for timesheet pay = worked days × this). */
export function perDayRate(amount: number, frequency: string): number {
  if (!Number.isFinite(amount)) return 0;
  if (frequency === "daily") return Math.round(amount * 100) / 100;
  if (frequency === "weekly") return Math.round((amount / WORKDAYS_PER_WEEK) * 100) / 100;
  if (frequency === "monthly") return Math.round((amount / WORKDAYS_PER_MONTH) * 100) / 100;
  if (frequency === "yearly") return Math.round((amount / WORKDAYS_PER_YEAR) * 100) / 100;
  return 0;
}

/** Map a (possibly Russian / Sellerboard) category label to our FP1 fund name. */
export function mapCategory(raw: string): ExpenseCategory {
  const t = (raw || "").toLowerCase();
  if (/зп|salar|payroll|зарплат/.test(t)) return "Salaries";
  if (/склад|логист|расходник|warehouse|logist/.test(t)) return "Warehouse & Logistics";
  if (/софт|soft/.test(t)) return "Software";
  if (/подписк|subscrip|members/.test(t)) return "Subscriptions";
  return "Other";
}

export interface ParsedExpenseRow {
  name: string;
  category: ExpenseCategory;
  amount: number;
  frequency: "monthly" | "weekly" | "one_time";
  marketplace: string | null;
  product: string | null;
  isAdSpend: boolean;
}

/** Parse a Sellerboard expenses CSV (';'-delimited:
 *  Date;Type;Name;Category;Product;Marketplace;Sum;Currency;Ad_spend).
 *  Dedups by (name, category, frequency) keeping the latest — the export repeats
 *  each recurring expense per period; we want the recurring template, not history. */
export function parseSellerboardExpensesCsv(text: string): ParsedExpenseRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const headers = lines[0].split(";").map((h) => h.trim().toLowerCase());
  const col = (n: string) => headers.indexOf(n);
  const ci = { type: col("type"), name: col("name"), category: col("category"), product: col("product"), marketplace: col("marketplace"), sum: col("sum"), ad: col("ad_spend") };

  const byKey = new Map<string, ParsedExpenseRow>();
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(";");
    const name = (c[ci.name] || "").trim();
    if (!name) continue;
    const freq = (c[ci.type] || "monthly").trim().toLowerCase() === "weekly" ? "weekly" : "monthly";
    const amount = parseFloat((c[ci.sum] || "0").replace(/,/g, "")) || 0;
    const category = mapCategory(c[ci.category] || "");
    const marketplace = (c[ci.marketplace] || "").trim() || null;
    const product = (c[ci.product] || "").trim() || null;
    const isAdSpend = (c[ci.ad] || "").trim().toUpperCase() === "YES";
    const key = `${name}|${category}|${freq}`;
    byKey.set(key, { name, category, amount, frequency: freq, marketplace, product, isAdSpend });
  }
  return [...byKey.values()];
}
