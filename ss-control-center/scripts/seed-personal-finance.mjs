// Seed Personal Finance from Vladimir's 2026 planning sheet. Idempotent: skips if
// personal funds already exist (pass --force to wipe personal-scope rows and reseed).
//   node --env-file=.env scripts/seed-personal-finance.mjs [--force]
//
// Labels are English per the project's English-UI rule; everything is editable in
// the UI. Card credit limits / APRs are unknown from the sheet (left 0 / null) —
// fill them in the UI to light up utilization and interest.
import { createClient } from "@libsql/client";
import { randomUUID } from "crypto";

const clean = (v) => (v ? v.trim().replace(/^['"]|['"]$/g, "") : v);
const url = clean(process.env.TURSO_DATABASE_URL);
const authToken = clean(process.env.TURSO_AUTH_TOKEN);
if (!url || !authToken) { console.error("Missing TURSO env"); process.exit(1); }
const force = process.argv.includes("--force");
const client = createClient({ url, authToken });
console.log(`→ ${url.split("@")[1] || url}`);

const existing = await client.execute(`SELECT COUNT(*) AS n FROM "Fund" WHERE scope='personal'`);
if (Number(existing.rows[0].n) > 0 && !force) {
  console.log(`= ${existing.rows[0].n} personal funds already exist — skipping (use --force to reseed)`);
  client.close();
  process.exit(0);
}
if (force) {
  for (const t of ["CardEntry"]) await client.execute(`DELETE FROM "${t}"`);
  await client.execute(`DELETE FROM "CreditCard" WHERE scope='personal'`);
  for (const t of ["Fund", "RecurringExpense", "Debt", "Payout", "FinancePlanRun", "Receipt"]) {
    await client.execute(`DELETE FROM "${t}" WHERE scope='personal'`);
  }
  console.log("  (wiped personal rows)");
}

// 1. Funds: FP1 obligatory envelopes + FP2 savings goal + FREE leftover.
const FUNDS = [
  { name: "Housing", group: "FP1", priority: 10 },
  { name: "Transport", group: "FP1", priority: 11 },
  { name: "Family", group: "FP1", priority: 12 },
  { name: "Health", group: "FP1", priority: 13 },
  { name: "Loans", group: "FP1", priority: 14 },
  { name: "Household", group: "FP1", priority: 15 },
  { name: "Credit Cards", group: "FP1", priority: 16 },
  { name: "Savings", group: "FP2", priority: 30 },
  { name: "Free", group: "FREE", priority: 999, isSystem: 1 },
];
const fundId = {};
for (const f of FUNDS) {
  const id = randomUUID();
  fundId[f.name] = id;
  await client.execute({
    sql: `INSERT INTO "Fund" (id, scope, name, "group", allocationType, value, priority, balance, active, isSystem, createdAt, updatedAt)
          VALUES (?, 'personal', ?, ?, 'percent', 0, ?, 0, 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    args: [id, f.name, f.group, f.priority, f.isSystem ?? 0],
  });
}
console.log(`  + ${FUNDS.length} funds`);

// 2. Bills (and loans-as-bills for Phase 1): category = fund name, with due day.
const BILLS = [
  ["Housing", "Rent", 5100, 1],
  ["Housing", "Water & Trash", 210, 7],
  ["Housing", "Electricity", 240, 21],
  ["Housing", "Internet", 75, 12],
  ["Housing", "Phones", 400, 24],
  ["Transport", "BMW X3 Loan", 810, 7],
  ["Transport", "BMW Moto Loan", 280, 8],
  ["Transport", "Auto Insurance", 260, 21],
  ["Family", "School", 550, 1],
  ["Family", "Alimony", 300, 3],
  ["Health", "Medical Insurance", 60, 15],
  ["Loans", "SBA Loan ($115,000)", 560, 25],
  ["Household", "Household Spending", 1200, 2],
];
for (const [category, name, amount, dueDay] of BILLS) {
  await client.execute({
    sql: `INSERT INTO "RecurringExpense" (id, scope, name, category, amount, frequency, currency, dueDay, isAdSpend, active, source, accrued, paid, createdAt, updatedAt)
          VALUES (?, 'personal', ?, ?, ?, 'monthly', 'USD', ?, 0, 1, 'manual', 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    args: [randomUUID(), name, category, amount, dueDay],
  });
}
console.log(`  + ${BILLS.length} bills`);

// 3. Credit cards by owner. [owner, issuer, name, balance, dueDay]
const CARDS = [
  ["Vladimir", "Merrick Bank", "Merrick BK", 2000, 7],
  ["Vladimir", "PayPal", "PayPal", 0, 10],
  ["Vladimir", "Capital One", "Capital One", 400, 10],
  ["Vladimir", "Credit One Bank", "Credit One Visa 1337", 300, 15],
  ["Vladimir", "Wells Fargo", "Wells Fargo", 10000, 18],
  ["Vladimir", "Capital One", "Capital One BJ's", 6500, 19],
  ["Vladimir", "Credit One Bank", "Credit One Amex", 500, 23],
  ["Vladimir", "Citi", "Citi Costco", 2500, 23],
  ["Vladimir", "Synchrony", "CareCredit", 2186, 25],
  ["Vladimir", "Goldman Sachs", "Apple Card", 2000, 31],
  ["Vladimir", "Unknown", "Card (due 3)", 400, 3],
  ["Vladimir", "Unknown", "Card (due 6)", 500, 6],
  ["Anna", "Citi", "Citi AAdvantage", 2100, 1],
  ["Anna", "Credit One Bank", "Credit One Amex", 1050, 9],
  ["Anna", "Capital One", "Capital One Savor", 500, 9],
  ["Anna", "Citi", "Citi Strata Premier", 11400, 13],
  ["Anna", "Citi", "Citi Diamond", 550, 15],
  ["Anna", "Capital One", "Capital One", 500, 17],
  ["Anna", "Synchrony", "City Furniture", 5059, 19],
  ["Anna", "Credit One Bank", "Credit One Visa", 2250, 23],
];
const ccFund = fundId["Credit Cards"];
for (const [owner, issuer, name, balance, dueDay] of CARDS) {
  await client.execute({
    sql: `INSERT INTO "CreditCard" (id, scope, owner, issuer, name, creditLimit, currentBalance, statementBalance, minPaymentFixed, minPaymentPct, dueDay, autopay, fundId, active, createdAt, updatedAt)
          VALUES (?, 'personal', ?, ?, ?, 0, ?, ?, 35, 2, ?, 'none', ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    args: [randomUUID(), owner, issuer, name, balance, balance, dueDay, ccFund],
  });
}
console.log(`  + ${CARDS.length} cards (Vladimir + Anna)`);

const cardSum = CARDS.reduce((s, c) => s + c[3], 0);
console.log(`✓ Personal Finance seeded — bills ≈ $${BILLS.reduce((s, b) => s + b[2], 0)}/mo, card debt ≈ $${cardSum}`);
client.close();
