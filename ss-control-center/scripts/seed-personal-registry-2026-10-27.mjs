// Personal Finance Phase 2 — the owner's obligations registry as of 2026-10-27.
//   node --env-file=.env scripts/seed-personal-registry-2026-10-27.mjs [--dry]
//
// Sources (every row carries its own date + source string):
//   • Owner's ТЗ 2026-10-27 (cards from Plaid 27.10, debts list) + correction (EGK and the
//     factory are live obligations) + Jackie's reconciliation addendum 2026-10-27 10:25
//     (owners, status badges, nearest dates, warnings).
//   • Jackie's server files (read-only): data/bills/bills.json (minimums, due days,
//     statements), wiki/business/business-debts.md (creditors, refs, legal debtors),
//     memory/tax_debts_2024_2025.md + irs_tax_debt_2024_status.md (IRS), and the Plaid
//     snapshot projects/credit-score-vladimir/data.json 2026-10-27 07:15 (limits, APR,
//     bank balances).
// Nothing is guessed: an unknown limit / APR / minimum / balance is left "not set".
//
// Idempotent: every row gets a `registryKey`; a re-run updates the same rows. The
// business-pool debts that already existed (Parafin, IRS 2024, Amex ×2, Uline, factory,
// EGK) are updated IN PLACE — not copied — so the business plan and the personal view
// never count one payment twice. All writes go in ONE atomic batch.
import { createClient } from "@libsql/client";
import { randomUUID } from "crypto";

const clean = (v) => (v ? v.trim().replace(/^['"]|['"]$/g, "") : v);
const url = clean(process.env.TURSO_DATABASE_URL);
const authToken = clean(process.env.TURSO_AUTH_TOKEN);
if (!url || !authToken) { console.error("Missing TURSO env"); process.exit(1); }
const dry = process.argv.includes("--dry");
const client = createClient({ url, authToken });
console.log(`→ ${url.split("@")[1] || url}${dry ? " (dry run)" : ""}`);

const TODAY = "2026-10-27";
const REG = "Owner registry 2026-10-27";
const PLAID = "Plaid 2026-10-27";

// ── Credit cards ────────────────────────────────────────────────────────────
// `match` finds the June-sheet row the first time (owner + name [+ dueDay]).
// Every card drops the invented "2% / $35" minimum rule: minPaymentDue is the real
// statement minimum where known, otherwise the minimum is "not set".
const CARDS = [
  { key: "card-wf-8843", match: { owner: "Vladimir", name: "Wells Fargo" }, set: {
    issuer: "Wells Fargo", name: "WF Reflect", last4: "8843", owner: "Vladimir",
    creditLimit: 10000, currentBalance: 8846.51, statementBalance: 6528.61, apr: 28.74,
    minPaymentDue: 66, dueDay: 18, nextDueDate: "2026-11-18", standing: "paying",
    balanceAsOf: TODAY, balanceSource: `${PLAID} (balance, limit, APR); statement $6,528.61 + min $66 — WF email 2026-10-25`,
    standingNote: "Payment of $4,500 on 2026-10-20 posted." } },
  { key: "card-bjs-5961", match: { owner: "Vladimir", name: "Capital One BJ's" }, set: {
    issuer: "Capital One", name: "BJ's One+", last4: "5961", owner: "Vladimir",
    creditLimit: 6500, currentBalance: 6490.07, statementBalance: 6715.07,
    minPaymentDue: 225, dueDay: 19, nextDueDate: "2026-11-19", standing: "paying",
    balanceAsOf: TODAY, balanceSource: `${PLAID} (balance, limit); statement $6,715.07 + min $225 — statement 2026-10-25`,
    standingNote: "Owner decision 2026-10-26: pay the FULL statement by the due date, not the minimum — interest of $157.54 was charged 2026-10-25. Business purchasing card." } },
  { key: "card-qs-6823", match: { owner: "Vladimir", name: "Capital One", dueDay: 10 }, set: {
    issuer: "Capital One", name: "QuicksilverOne", last4: "6823", owner: "Vladimir",
    creditLimit: 400, currentBalance: 66.56, statementBalance: 61.22,
    minPaymentDue: 25, dueDay: 10, nextDueDate: "2026-11-10", autopay: "min", standing: "current",
    balanceAsOf: TODAY, balanceSource: `${PLAID} (balance, limit); statement 2026-10-18: $61.22, min $25` } },
  { key: "card-c1-8871", match: { owner: "Anna", name: "Credit One Visa" }, set: {
    issuer: "Credit One Bank", name: "Credit One Visa", last4: "8871", owner: "Anna",
    creditLimit: 2250, currentBalance: 1773.92, statementBalance: 0,
    minPaymentDue: 99, dueDay: 23, nextDueDate: "2026-11-23", autopay: "fixed", autopayAmount: 99, standing: "paying",
    balanceAsOf: TODAY, balanceSource: `${PLAID} (balance, limit); AutoPay $99 posted 2026-10-23 (Credit One email)` } },
  { key: "card-c1-3989", match: { owner: "Anna", name: "Credit One Amex" }, set: {
    issuer: "Credit One Bank", name: "Credit One AmEx", last4: "3989", owner: "Anna",
    creditLimit: 1250, currentBalance: 661.11, statementBalance: 0,
    minPaymentDue: 36, dueDay: 9, nextDueDate: null, autopay: "none",
    standing: "past_due", standingSince: "2026-10-09",
    standingNote: "The $35 payment of 2026-10-19 was returned by the bank; AutoPay cancelled. Due day 9 is not confirmed; minimum $35–36.",
    alert: "Credit One AmEx 3989 is past due since 2026-10-09 — the payment was returned.",
    balanceAsOf: TODAY, balanceSource: `${PLAID} (balance, limit); minimum — Jackie bills.json` } },
  { key: "card-savor-2044", match: { owner: "Anna", name: "Capital One Savor" }, set: {
    issuer: "Capital One", name: "Savor", last4: "2044", owner: "Anna",
    creditLimit: 0, currentBalance: 95.84, statementBalance: 0,
    minPaymentDue: 25, dueDay: 9, nextDueDate: "2026-11-09", autopay: "min", standing: "current",
    balanceAsOf: TODAY, balanceSource: `${PLAID} (balance); AutoPay minimum $25 — Jackie bills.json` } },
  { key: "card-c1-0224", match: { owner: "Vladimir", name: "Credit One Amex" }, set: {
    issuer: "Credit One Bank", name: "Credit One AmEx", last4: "0224", owner: "Vladimir",
    creditLimit: 500, currentBalance: 40.21, statementBalance: 0,
    minPaymentDue: 30, statementDay: 27, dueDay: 23, nextDueDate: "2026-11-23", standing: "current",
    balanceAsOf: TODAY, balanceSource: `${PLAID} (balance, limit); min $30 + due day — 2026 plan sheet (Jackie bills.json)` } },
  { key: "card-c1-1337", match: { owner: "Vladimir", name: "Credit One Visa 1337" }, set: {
    issuer: "Credit One Bank", name: "Credit One Visa", last4: "1337", owner: "Vladimir",
    creditLimit: 300, currentBalance: 8.33, statementBalance: 0,
    minPaymentDue: 30, statementDay: 19, dueDay: 15, nextDueDate: "2026-11-15", standing: "current",
    balanceAsOf: TODAY, balanceSource: `${PLAID} (balance, limit); min $30 + due day — 2026 plan sheet (Jackie bills.json)` } },
  { key: "card-citi-4946", match: { owner: "Anna", name: "Citi Strata Premier" }, set: {
    issuer: "Citi", name: "Citi Strata Premier", last4: "4946", owner: "Anna", closed: 1,
    creditLimit: 0, currentBalance: 9526.74, statementBalance: 0,
    minPaymentDue: 191, dueDay: 13, nextDueDate: "2026-11-13", autopay: "fixed", autopayAmount: 191, standing: "paying",
    standingNote: "Card closed. Payment arrangement — AutoPay $191/mo (posted 2026-10-13).",
    balanceAsOf: "2026-10-13", balanceSource: `Citi AutoPay 2026-10-13 (Jackie bills.json); ${REG}: $9,527` } },
  { key: "card-citi-0640", match: { owner: "Anna", name: "Citi AAdvantage" }, set: {
    issuer: "Citi", name: "Citi AAdvantage", last4: "0640", owner: "Anna", closed: 1,
    creditLimit: 0, currentBalance: 1647.94, statementBalance: 0,
    minPaymentDue: 61, statementDay: 4, dueDay: 1, nextDueDate: "2026-12-01", standing: "current",
    standingNote: "Card closed. The 2026-11-01 minimum is already covered by $60.69 paid 2026-10-12.",
    balanceAsOf: "2026-10-12", balanceSource: `Jackie bills.json (Citi); ${REG}: $1,648` } },
  { key: "card-carecredit-9301", match: { owner: "Vladimir", name: "CareCredit" }, set: {
    issuer: "Synchrony", name: "CareCredit", last4: "9301", owner: "Vladimir",
    creditLimit: 2500, currentBalance: 3416.24, statementBalance: 3416.24,
    minPaymentDue: 124, dueDay: 25, nextDueDate: "2026-11-25", standing: "paying",
    balanceAsOf: "2026-10-02", balanceSource: "Statement 2026-10-02 (Jackie bills.json); limit — Experian report 2026-09-02" } },
  { key: "card-merrick-4164", match: { owner: "Vladimir", name: "Merrick BK" }, set: {
    issuer: "Merrick Bank", name: "Merrick Platinum", last4: "4164", owner: "Vladimir",
    creditLimit: 3000, currentBalance: 1627, statementBalance: 1627,
    minPaymentDue: 58, dueDay: 7, nextDueDate: "2026-11-07", standing: "paying",
    standingNote: "$55 paid 2026-10-05.",
    balanceAsOf: "2026-10-17", balanceSource: "Merrick statement 2026-10-17 (email); limit — Plaid (cached 2026-10-05)" } },
  { key: "card-apple", match: { owner: "Vladimir", name: "Apple Card" }, set: {
    issuer: "Goldman Sachs", name: "Apple Card", owner: "Vladimir",
    creditLimit: 3000, currentBalance: 1498, statementBalance: 0,
    minPaymentDue: 41, dueDay: 31, nextDueDate: "2026-10-31", autopay: "min", standing: "current",
    balanceNote: "Balance is from August — Plaid does not cover Apple Card.",
    alert: "Apple Card AutoPay ($41 on 10-31) pulls from WF Everyday Checking 9868, which is overdrawn — risk of a returned payment.",
    balanceAsOf: "2026-08-31", balanceSource: "Experian report 2026-08-31; AutoPay $41 — screenshot 2026-10-15 (Jackie bills.json)" } },
  { key: "card-paypal-4251", match: { owner: "Vladimir", name: "PayPal" }, set: {
    issuer: "PayPal", name: "PayPal Credit", last4: "4251", owner: "Vladimir",
    creditLimit: 110, currentBalance: 0, statementBalance: 0, minPaymentDue: null, standing: "current",
    balanceAsOf: TODAY, balanceSource: PLAID } },
  { key: "card-vs-1548", match: null, set: {
    issuer: "Comenity", name: "Victoria's Secret", last4: "1548", owner: "Vladimir",
    creditLimit: 950, currentBalance: 775.44, statementBalance: 0, minPaymentDue: null, standing: "check",
    standingNote: "Found in Plaid 2026-10-27 but missing from the owner's registry — confirm whose card it is (owner set from Vladimir's credit file).",
    balanceAsOf: TODAY, balanceSource: PLAID } },
  // June-sheet rows no current source confirms → not counted (active=0), kept for review.
  { key: "card-stale-citi-costco", match: { owner: "Vladimir", name: "Citi Costco" }, set: {
    last4: "7647", closed: 1, active: 0, standing: "check",
    standingNote: "Not in the 2026-10-27 registry. Closed card (Jackie's list 2026-10-15); Jackie last saw $1,458.87 in Dec 2025. Confirm the balance.",
    balanceAsOf: "2026-06-21", balanceSource: "2026 plan sheet (June)" } },
  { key: "card-stale-citi-diamond", match: { owner: "Anna", name: "Citi Diamond" }, set: {
    last4: "6590", closed: 1, active: 0, standing: "check",
    standingNote: "Not in the 2026-10-27 registry. Closed card (Jackie's list 2026-10-15). Confirm the balance.",
    balanceAsOf: "2026-06-21", balanceSource: "2026 plan sheet (June)" } },
  { key: "card-stale-city-furniture", match: { owner: "Anna", name: "City Furniture" }, set: {
    active: 0, standing: "check",
    standingNote: "Not in the 2026-10-27 registry. Possibly the account now with Midland (dispute) — confirm.",
    balanceAsOf: "2026-06-21", balanceSource: "2026 plan sheet (June)" } },
  { key: "card-stale-anna-capone", match: { owner: "Anna", name: "Capital One", dueDay: 17 }, set: {
    active: 0, standing: "check",
    standingNote: "Not in the 2026-10-27 registry (Jackie lists an Anna Capital One ending 1635). Confirm.",
    balanceAsOf: "2026-06-21", balanceSource: "2026 plan sheet (June)" } },
  { key: "card-stale-due6", match: { owner: "Vladimir", name: "Card (due 6)" }, set: {
    active: 0, standing: "check",
    standingNote: "Unnamed card from the June sheet, not in the 2026-10-27 registry — identify it or delete.",
    balanceAsOf: "2026-06-21", balanceSource: "2026 plan sheet (June)" } },
  { key: "card-stale-due3", match: { owner: "Vladimir", name: "Card (due 3)" }, set: {
    active: 0, standing: "check",
    standingNote: "Unnamed card from the June sheet, not in the 2026-10-27 registry — identify it or delete.",
    balanceAsOf: "2026-06-21", balanceSource: "2026 plan sheet (June)" } },
];

// ── Debts / obligations ─────────────────────────────────────────────────────
// `id` = an existing business-pool row updated in place; `fund` = [scope, fund name]
// for a new row. Business-pool rows stay in the business plan (their payments are
// planned there); the personal view reads both pools.
const EGK_NOTE = "Balance from June data ($7,489.16 across 8 invoices) — being reconciled; paid via Intuit QuickBooks in Aug, Sep, Oct.";
const egk = (id, ref, amount, desc) => ({ key: `debt-egk-${ref}`, id, set: {
  description: `EGK Solutions — ${desc}`, creditor: "EGK Solutions", entity: "Salutem Solutions", owner: "Vladimir",
  accountRef: ref, kind: "vendor", amount, standing: "paying", balanceAsOf: "2026-06-08",
  balanceSource: "QuickBooks invoices (Jackie registry)", balanceNote: EGK_NOTE } });

const DEBTS = [
  { key: "debt-parafin-amz", id: "cmqnaxuhs000004l7c23fnkpd", set: {
    description: "Parafin / Walmart Capital — cash advance #001", creditor: "Parafin (Walmart Capital)",
    entity: "AMZ Commerce", owner: "Anna", kind: "advance", amount: 9150,
    monthlyPayment: 350, paymentFrequency: "biweekly", maturityDate: "2027-02-06", standing: "paying",
    standingNote: "AutoPay $350 every 2 weeks (Tuesdays). Payoff date per the owner: 2027-02-06.",
    balanceAsOf: TODAY, balanceSource: REG, balanceNote: "June dashboard showed $12,650 outstanding." } },
  { key: "debt-irs-2024", id: "cmqnaz8xs000004juwmuk5qt9", set: {
    description: "IRS — 2024 income tax (joint return)", creditor: "IRS", entity: "Personal", owner: "Vladimir",
    accountRef: "1040 · 2024 · MFJ", kind: "tax", amount: 8664.28, monthlyPayment: 1000, paymentFrequency: "monthly",
    dueDay: 5, nextDueDate: "2026-11-05", standing: "paying",
    standingNote: "Joint with Anna. Voluntary $1,000/mo — there is no installment agreement (the plan defaulted 2026-07-20).",
    alert: "IRS 2024: the account transcript shows $11,855.44 with accrued interest and penalty (2026-09-14) vs our $8,664.28 — $2,234.46 paid in Jun–Jul ($1,234.46 on 06-03, $1,000 on 07-08) did not post to 2024.",
    balanceAsOf: "2026-10-25", balanceSource: "IRS online account 2026-10-13 ($9,664.28) − $1,000 EFT 2026-10-14 (Jackie)" } },
  { key: "debt-amex-01001", id: "cmqn91feq000004lc3vbazsue", set: {
    description: "Amex Business Gold 01001 — lawsuit", creditor: "American Express", entity: "AMZ Commerce", owner: "Anna",
    accountRef: "01001 · case 26-010022-CO", kind: "court", amount: 11653.16, standing: "court",
    standingNote: "Joint and several — Anna personally. Case handled by Hilton. Mediation 2026-12-10 13:00; installments 11-13, 12-13, 01-12, 02-11, 03-13.",
    balanceNote: "Plus court costs (amount not set).",
    balanceAsOf: "2026-10-18", balanceSource: "Lawsuit 26-010022-CO (Jackie registry 2026-10-18)" } },
  { key: "debt-amex-91009", id: "cmqn8zzjp000004jgofeniuz3", set: {
    description: "Amex Business Gold 91009", creditor: "American Express", entity: "Salutem Solutions", owner: "Vladimir",
    accountRef: "91009", kind: "collections", amount: 6303.83, standing: "collections", standingSince: "2026-01-25",
    standingNote: "Card cancelled; in collections since Jan 2026. Settlement offer was $4,412.68 (deadline 2026-06-19).",
    balanceAsOf: "2026-06-20", balanceSource: "Amex collections letters (Jackie registry)" } },
  { key: "debt-uline", id: "cmqn8iz4h000004l4wjf3sw07", set: {
    description: "Uline (via A.G. Adjustments)", creditor: "Uline — A.G. Adjustments", entity: "Salutem Solutions", owner: "Vladimir",
    accountRef: "Uline 21177472 · AGA C984881", kind: "collections", amount: 3000, standing: "collections",
    balanceAsOf: TODAY, balanceSource: REG, balanceNote: "AGA portal showed $3,300.00 on 2026-06-20 — reconcile." } },
  { key: "debt-factory-detox", id: "cmqn865vk000004k03uk8tl5s", set: {
    description: "Factory — Salutem Vita Detox production", creditor: "Factory (detox)", entity: "Salutem Solutions", owner: "Vladimir",
    kind: "vendor", amount: 3015, standing: "paying", standingNote: "Paid by Zelle (payments in Aug, Sep, Oct).",
    balanceAsOf: "2026-06-21", balanceSource: "Vladimir's words 2026-06-21",
    balanceNote: "Balance from June data — being reconciled." } },
  egk("cmqn9ij0s000004jv5mcotu68", "2024-5187", 540, "Retailer Distributor LLC registration + BOI"),
  egk("cmqn9jge1000104jvealiftju", "2024-5265", 75, "sales tax 2023"),
  egk("cmqn9km0m000204jvirv0u431", "2024-5336", 140, "service + late fees"),
  egk("cmqn9lit1000304jv7j03pt5e", "2025-5552", 182.91, "1099-NEC e-file (9 forms)"),
  egk("cmqn9m78l001f04jg2l2hw268", "2025-5770", 75, "sales tax 2024"),
  egk("cmqn9n5em001g04jgoz9pa7z9", "2025-5793", 235, "payroll setup"),
  egk("cmqn9o8no001h04jgd9gx6jv9", "2025-5801", 6161.25, "bookkeeping 2025"),
  egk("cmqneuu9j000004jszmz1tbl6", "2025-6048", 80, "sales tax 2024 + late"),
  { key: "debt-irs-2025", fund: ["business", "Installments / Loans"], set: {
    description: "IRS — 2025 income tax (joint return)", creditor: "IRS", entity: "Personal", owner: "Vladimir",
    accountRef: "1040 · 2025 · MFJ", kind: "tax", amount: 13660, standing: "window",
    standingNote: "Joint with Anna. Set up the payment plan in the 2–16 Nov window (Simple Payment Plan).",
    balanceAsOf: "2026-10-19", balanceSource: "2025 return accepted by the IRS 2026-10-19 (Jackie)" } },
  { key: "debt-lendistry", fund: ["business", "Debt repayment / Expansion"], set: {
    description: "Lendistry loan (via Cedars)", creditor: "Lendistry — Cedars Business Services", entity: "AMZ Commerce", owner: "Anna",
    accountRef: "AMZN-955OI-2540 · Cedars 14338815", kind: "collections", amount: 14765.82, apr: 11.69,
    maturityDate: "2026-04-01", standing: "collections",
    standingNote: "Anna's personal guaranty. Loan matured 2026-04-01 — the whole balance is due. Cedars asked for hardship documents 2026-02-10; not answered yet.",
    balanceAsOf: "2026-01-09", balanceSource: "Cedars letter (Jackie registry)", balanceNote: "Interest keeps accruing since 2026-01-09." } },
  { key: "debt-mvb-lendesca", fund: ["personal", "Loans"], set: {
    description: "MVB / Lendesca — SLFL loan", creditor: "Lendesca / MVB Bank", entity: "Personal", owner: "Vladimir",
    kind: "personal", amount: 20896.44, standing: "dispute",
    balanceAsOf: "2026-10-18", balanceSource: "Jackie registry 2026-10-18" } },
  { key: "debt-sba-eidl", fund: ["personal", "Loans"], set: {
    description: "SBA COVID EIDL …9103", creditor: "SBA", entity: "Personal", owner: "Vladimir",
    accountRef: "9103", kind: "sba", amount: 111700, monthlyPayment: 560, paymentFrequency: "monthly", dueDay: 25,
    standing: "check", standingNote: "Borrower personally (Vladimir 2026-10-18). Payment $560/mo is from the 2026 plan sheet.",
    alert: "SBA EIDL ≈$111,700 — sources disagree (QuickBooks principal ~$100,400 at 2024-12-31). Clarify the balance.",
    balanceAsOf: "2026-10-18", balanceSource: "Vladimir's words 2026-10-18", balanceNote: "Approximate." } },
  { key: "debt-midland", fund: ["personal", "Loans"], set: {
    description: "Midland Credit Management (Synchrony)", creditor: "Midland Credit Management", entity: "Personal", owner: "Anna",
    kind: "collections", amount: 8496, standing: "dispute",
    balanceAsOf: TODAY, balanceSource: REG } },
  { key: "debt-bmw-x3", fund: ["personal", "Transport"], set: {
    description: "BMW X3 auto loan", creditor: "BMW (likely BMO ••2038 — confirm)", entity: "Personal", owner: "Vladimir",
    kind: "auto", amount: 0, amountKnown: 0, monthlyPayment: 810, paymentFrequency: "monthly", dueDay: 7, nextDueDate: "2026-11-07",
    standing: "past_due", standingSince: "2026-10-07",
    standingNote: "17 days past due as of 2026-10-24. The $810/mo payment is from the June sheet — not confirmed.",
    alert: "BMW X3 loan is past due (17 days on 2026-10-24); balance and payment are not confirmed.",
    balanceAsOf: TODAY, balanceSource: `${REG} (balance unknown)` } },
  { key: "debt-bmw-moto", fund: ["personal", "Transport"], set: {
    description: "BMW motorcycle loan (Synchrony)", creditor: "Synchrony", entity: "Personal", owner: "Anna",
    kind: "auto", amount: 0, amountKnown: 0, monthlyPayment: 292, paymentFrequency: "monthly", dueDay: 8, nextDueDate: "2026-11-08",
    standing: "paying", standingNote: "Pay by phone only. October paid.",
    balanceAsOf: TODAY, balanceSource: `${REG}; Jackie bills.json (balance unknown)` } },
];

// Personal bills replaced by a Debt row above (same payment, now with its balance).
const BILLS_MOVED = ["BMW X3 Loan", "BMW Moto Loan", "SBA Loan ($115,000)"];

// ── Dated events ────────────────────────────────────────────────────────────
const HILTON = ["2026-11-13", "2026-12-13", "2027-01-12", "2027-02-11", "2027-03-13"];
const EVENTS = [
  { key: "ev-amex-01001-mediation", debt: "debt-amex-01001", date: "2026-12-10", time: "13:00", kind: "mediation",
    title: "Amex 01001 — mediation", source: REG },
  ...HILTON.map((date, i) => ({ key: `ev-amex-01001-inst-${i + 1}`, debt: "debt-amex-01001", date, kind: "installment",
    title: `Amex 01001 — installment ${i + 1} of 5 (Hilton)`, source: REG, note: "Amount not set." })),
  { key: "ev-irs-2025-window", debt: "debt-irs-2025", date: "2026-11-02", endDate: "2026-11-16", kind: "window",
    title: "IRS 2025 — set up the payment plan (Simple Payment Plan)", source: "Jackie 2026-10-27" },
  { key: "ev-bjs-full-statement", card: "card-bjs-5961", date: "2026-11-19", kind: "payment", amount: 6715.07,
    title: "BJ's 5961 — pay the full statement", source: "Owner decision 2026-10-26", note: "Minimum is $225; paying the statement avoids interest." },
  { key: "ev-bjs-before-close", card: "card-bjs-5961", date: "2026-11-21", kind: "deadline",
    title: "BJ's 5961 — pay down before the statement closes (24–25th)", source: "Owner decision 2026-10-26",
    note: "Amount = everything charged since the last statement, so a low balance is reported." },
];

// ── Assets (net worth) ──────────────────────────────────────────────────────
const PLAID_BANK = "Plaid 2026-10-27 07:15 (Vladimir's connections)";
const ASSETS = [
  { key: "asset-wf-4134", name: "WF Platinum Savings", kind: "savings", institution: "Wells Fargo", last4: "4134", value: 8747.96, entity: "Personal" },
  { key: "asset-wf-9868", name: "WF Everyday Checking", kind: "checking", institution: "Wells Fargo", last4: "9868", value: 47.31, entity: "Personal",
    alert: "WF Everyday Checking 9868 is overdrawn (Jackie 2026-10-27 10:25) — AutoPays from it (Apple Card $41 on 10-31) may be returned." },
  { key: "asset-wf-4542", name: "WF Way2Save Savings", kind: "savings", institution: "Wells Fargo", last4: "4542", value: 0, entity: "Personal" },
  { key: "asset-wf-4628", name: "WF Business Checking", kind: "checking", institution: "Wells Fargo", last4: "4628", value: 219.29, entity: "Business", notes: "Which LLC — not set." },
  { key: "asset-wf-6632", name: "WF Business Checking", kind: "checking", institution: "Wells Fargo", last4: "6632", value: 16.7, entity: "Business", notes: "Which LLC — not set." },
  { key: "asset-paypal", name: "PayPal balance", kind: "cash", institution: "PayPal", value: -1287.38, entity: "Personal" },
];

// ── Build the batch ─────────────────────────────────────────────────────────
const one = async (sql, args = []) => (await client.execute({ sql, args })).rows[0];
const stmts = [];
const log = [];

function updateStmt(table, id, set) {
  const cols = Object.keys(set);
  return { sql: `UPDATE "${table}" SET ${cols.map((c) => `"${c}" = ?`).join(", ")}, "updatedAt" = CURRENT_TIMESTAMP WHERE id = ?`, args: [...cols.map((c) => set[c]), id] };
}
function insertStmt(table, set) {
  const cols = Object.keys(set);
  return { sql: `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, args: cols.map((c) => set[c]) };
}

const cardIds = {};
for (const c of CARDS) {
  let row = await one(`SELECT id FROM "CreditCard" WHERE "registryKey" = ?`, [c.key]);
  if (!row && c.match) {
    const conds = [`scope = 'personal'`, `owner = ?`, `name = ?`];
    const args = [c.match.owner, c.match.name];
    if (c.match.dueDay != null) { conds.push(`"dueDay" = ?`); args.push(c.match.dueDay); }
    row = await one(`SELECT id FROM "CreditCard" WHERE ${conds.join(" AND ")}`, args);
  }
  const set = { minPaymentFixed: 0, minPaymentPct: 0, active: 1, closed: 0, standingSince: null, standingNote: null, alert: null, balanceNote: null, ...c.set, registryKey: c.key };
  if (row) { stmts.push(updateStmt("CreditCard", row.id, set)); cardIds[c.key] = row.id; log.push(`card  ~ ${c.key}`); }
  else {
    if (c.match) throw new Error(`card ${c.key}: June row ${JSON.stringify(c.match)} not found`);
    const id = randomUUID(); cardIds[c.key] = id;
    stmts.push(insertStmt("CreditCard", { id, scope: "personal", ...set })); log.push(`card  + ${c.key}`);
  }
}

const debtIds = {};
for (const d of DEBTS) {
  let row = await one(`SELECT id FROM "Debt" WHERE "registryKey" = ?`, [d.key]);
  if (!row && d.id) row = await one(`SELECT id FROM "Debt" WHERE id = ?`, [d.id]);
  const set = { amountKnown: 1, status: "open", ...d.set, registryKey: d.key };
  if (row) { stmts.push(updateStmt("Debt", row.id, set)); debtIds[d.key] = row.id; log.push(`debt  ~ ${d.key}`); }
  else {
    if (d.id) throw new Error(`debt ${d.key}: business row ${d.id} not found`);
    const fund = await one(`SELECT id FROM "Fund" WHERE scope = ? AND name = ?`, d.fund);
    if (!fund) throw new Error(`debt ${d.key}: fund ${d.fund.join("/")} not found`);
    const id = randomUUID(); debtIds[d.key] = id;
    stmts.push(insertStmt("Debt", { id, scope: d.fund[0], fundId: fund.id, paid: 0, accrued: 0, lastAccruedDate: TODAY, ...set }));
    log.push(`debt  + ${d.key} (${d.fund.join(" / ")})`);
  }
}

for (const e of EVENTS) {
  const row = await one(`SELECT id FROM "ObligationEvent" WHERE "registryKey" = ?`, [e.key]);
  const set = {
    debtId: e.debt ? debtIds[e.debt] : null, cardId: e.card ? cardIds[e.card] : null,
    date: e.date, endDate: e.endDate ?? null, time: e.time ?? null, kind: e.kind, title: e.title,
    amount: e.amount ?? null, source: e.source ?? null, note: e.note ?? null, registryKey: e.key,
  };
  if (row) { stmts.push(updateStmt("ObligationEvent", row.id, set)); log.push(`event ~ ${e.key}`); }
  else { stmts.push(insertStmt("ObligationEvent", { id: randomUUID(), scope: "personal", status: "planned", ...set })); log.push(`event + ${e.key}`); }
}

for (const a of ASSETS) {
  const row = await one(`SELECT id FROM "PersonalAsset" WHERE "registryKey" = ?`, [a.key]);
  const { key, ...rest } = a;
  const set = { owner: "Vladimir", institution: null, last4: null, alert: null, notes: null, ...rest, valueAsOf: TODAY, valueSource: PLAID_BANK, registryKey: key };
  if (row) { stmts.push(updateStmt("PersonalAsset", row.id, set)); log.push(`asset ~ ${key}`); }
  else { stmts.push(insertStmt("PersonalAsset", { id: randomUUID(), scope: "personal", active: 1, ...set })); log.push(`asset + ${key}`); }
}

// Bills: retire the three that became Debt rows; restart every personal bill meter
// today — it had ticked since June with no payments recorded, so "Needed" read
// ~$43.8k of phantom arrears (four months of rent "owed").
for (const name of BILLS_MOVED) {
  stmts.push({ sql: `UPDATE "RecurringExpense" SET active = 0, notes = ?, "updatedAt" = CURRENT_TIMESTAMP WHERE scope = 'personal' AND name = ?`,
    args: [`Moved to the obligations registry ${TODAY} (Debt row).`, name] });
  log.push(`bill  - ${name}`);
}
stmts.push({ sql: `UPDATE "RecurringExpense" SET accrued = 0, paid = 0, "lastAccruedDate" = ?, "updatedAt" = CURRENT_TIMESTAMP WHERE scope = 'personal'`, args: [TODAY] });
log.push("bills ~ meters restarted");

console.log(log.join("\n"));
if (dry) { console.log(`\n(dry) ${stmts.length} statements not written`); client.close(); process.exit(0); }
await client.batch(stmts, "write");
console.log(`\n✓ registry written — ${stmts.length} statements in one transaction`);
client.close();
