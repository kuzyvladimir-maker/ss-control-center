// Pure obligations-registry model — Personal Finance Phase 2. No I/O.
//
// One shape (`Liability`) for every obligation the owner carries: personal credit
// cards and debts from BOTH pools (a business-pool debt is still the owner's
// obligation; it is shown, never copied). Every number keeps its date and source;
// an unknown balance stays `null`, never 0. Unit-tested in
// scripts/check-personal-finance.ts.

import { knownMinPayment, utilization } from "./cards";
import { installmentMonthly } from "./expenses";

/** Status badges, in the order the owner reads them (most urgent first). */
export const STANDINGS = ["court", "past_due", "collections", "dispute", "window", "check", "paying", "current"] as const;
export type Standing = (typeof STANDINGS)[number];

export const STANDING_META: Record<Standing, { label: string; tone: "danger" | "warn" | "purple" | "info" | "green" | "neutral" }> = {
  court: { label: "Court", tone: "danger" },
  past_due: { label: "Past due", tone: "danger" },
  collections: { label: "Collections", tone: "warn" },
  dispute: { label: "Dispute", tone: "purple" },
  window: { label: "Window", tone: "info" },
  check: { label: "Needs check", tone: "warn" },
  paying: { label: "Paying", tone: "green" },
  current: { label: "Current", tone: "neutral" },
};

export function asStanding(s: string | null | undefined): Standing {
  return (STANDINGS as readonly string[]).includes(s ?? "") ? (s as Standing) : "current";
}
export const standingRank = (s: Standing) => STANDINGS.indexOf(s);

export interface Liability {
  id: string;
  type: "card" | "debt";
  label: string;
  creditor: string | null;
  accountRef: string | null;
  owner: string | null;
  entity: string | null;
  pool: "personal" | "business";
  kind: string | null;
  standing: Standing;
  standingSince: string | null;
  standingNote: string | null;
  alert: string | null;
  balance: number | null; // null = unknown
  balanceAsOf: string | null;
  balanceSource: string | null;
  balanceNote: string | null;
  apr: number | null;
  /** Per-period payment as stated (card minimum, installment); null = not set. */
  payment: number | null;
  frequency: string | null; // monthly | biweekly | weekly | daily
  /** Payment averaged to a month (biweekly $350 → $758.33); null = not set. */
  monthlyPayment: number | null;
  dueDay: number | null;
  nextDueDate: string | null;
  maturityDate: string | null;
  limit: number | null;
  utilization: number | null;
  closed: boolean;
  counted: boolean; // false = kept for review, excluded from every total
}

export interface CardRow {
  id: string; owner: string | null; issuer: string; name: string | null; last4: string | null; scope?: string;
  creditLimit: number; currentBalance: number; statementBalance?: number; apr: number | null;
  minPaymentFixed: number; minPaymentPct: number; minPaymentDue?: number | null;
  dueDay: number | null; nextDueDate?: string | null; active: boolean; closed?: boolean;
  balanceAsOf?: string | null; balanceSource?: string | null; balanceNote?: string | null;
  standing?: string | null; standingSince?: string | null; standingNote?: string | null; alert?: string | null;
}

export interface DebtRow {
  id: string; scope: string; amount: number; paid: number; description: string | null; owner: string | null;
  kind: string | null; apr: number | null; monthlyPayment: number | null; paymentFrequency: string | null;
  dueDay: number | null; status: string; creditor?: string | null; entity?: string | null; accountRef?: string | null;
  balanceAsOf?: string | null; balanceSource?: string | null; balanceNote?: string | null; amountKnown?: boolean | null;
  standing?: string | null; standingSince?: string | null; standingNote?: string | null; alert?: string | null;
  nextDueDate?: string | null; maturityDate?: string | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function cardLabel(c: Pick<CardRow, "name" | "issuer" | "last4">): string {
  return `${c.name || c.issuer}${c.last4 ? ` ${c.last4}` : ""}`;
}

export function cardToLiability(c: CardRow): Liability {
  const min = knownMinPayment(c);
  return {
    id: c.id, type: "card", label: cardLabel(c), creditor: c.issuer, accountRef: c.last4,
    owner: c.owner, entity: "Personal", pool: "personal", kind: "card",
    standing: asStanding(c.standing), standingSince: c.standingSince ?? null, standingNote: c.standingNote ?? null, alert: c.alert ?? null,
    balance: round2(Math.max(0, c.currentBalance || 0)),
    balanceAsOf: c.balanceAsOf ?? null, balanceSource: c.balanceSource ?? null, balanceNote: c.balanceNote ?? null,
    apr: c.apr ?? null, payment: min, frequency: "monthly", monthlyPayment: min,
    dueDay: c.dueDay, nextDueDate: c.nextDueDate ?? null, maturityDate: null,
    limit: c.creditLimit > 0 ? c.creditLimit : null,
    utilization: c.creditLimit > 0 ? round2(utilization(c)) : null,
    closed: Boolean(c.closed), counted: Boolean(c.active),
  };
}

export function debtToLiability(d: DebtRow): Liability {
  const known = d.amountKnown !== false;
  return {
    id: d.id, type: "debt", label: d.description || d.creditor || "Debt", creditor: d.creditor ?? null, accountRef: d.accountRef ?? null,
    owner: d.owner, entity: d.entity ?? null, pool: d.scope === "personal" ? "personal" : "business", kind: d.kind,
    standing: asStanding(d.standing), standingSince: d.standingSince ?? null, standingNote: d.standingNote ?? null, alert: d.alert ?? null,
    balance: known ? round2(Math.max(0, d.amount - d.paid)) : null,
    balanceAsOf: d.balanceAsOf ?? null, balanceSource: d.balanceSource ?? null, balanceNote: d.balanceNote ?? null,
    apr: d.apr ?? null,
    payment: d.monthlyPayment ?? null, frequency: d.monthlyPayment ? d.paymentFrequency ?? "monthly" : null,
    monthlyPayment: d.monthlyPayment ? installmentMonthly(d.monthlyPayment, d.paymentFrequency) : null,
    dueDay: d.dueDay, nextDueDate: d.nextDueDate ?? null, maturityDate: d.maturityDate ?? null,
    limit: null, utilization: null, closed: false, counted: d.status === "open",
  };
}

/** Counted first; then most urgent status, then largest balance (unknown last). */
export function sortLiabilities(ls: Liability[]): Liability[] {
  return [...ls].sort((a, b) =>
    Number(b.counted) - Number(a.counted) || standingRank(a.standing) - standingRank(b.standing)
    || (b.balance ?? -1) - (a.balance ?? -1) || a.label.localeCompare(b.label));
}

export interface Bucket { count: number; total: number; unknown: number }
const bucket = (): Bucket => ({ count: 0, total: 0, unknown: 0 });
function add(b: Bucket, l: Liability) { b.count++; if (l.balance == null) b.unknown++; else b.total = round2(b.total + l.balance); }

export interface RegistryTotals {
  all: Bucket;
  byOwner: Record<string, Bucket>;
  byStanding: Record<string, Bucket>;
  byPool: Record<string, Bucket>;
  monthlyPayments: number; // Σ known monthly payments of counted obligations
  missingPayment: number; // counted obligations with a balance but no payment set
  asOfOldest: string | null;
  asOfNewest: string | null;
}

/** Totals over COUNTED liabilities only. Unknown balances are counted, never summed. */
export function registryTotals(ls: Liability[]): RegistryTotals {
  const t: RegistryTotals = { all: bucket(), byOwner: {}, byStanding: {}, byPool: {}, monthlyPayments: 0, missingPayment: 0, asOfOldest: null, asOfNewest: null };
  for (const l of ls) {
    if (!l.counted) continue;
    if (l.balance === 0 && l.type === "card") continue; // a paid-off card is not an obligation
    add(t.all, l);
    add((t.byOwner[l.owner ?? "—"] ??= bucket()), l);
    add((t.byStanding[l.standing] ??= bucket()), l);
    add((t.byPool[l.pool] ??= bucket()), l);
    if (l.monthlyPayment != null) t.monthlyPayments = round2(t.monthlyPayments + l.monthlyPayment);
    else if ((l.balance ?? 1) > 0) t.missingPayment++;
    if (l.balanceAsOf) {
      if (!t.asOfOldest || l.balanceAsOf < t.asOfOldest) t.asOfOldest = l.balanceAsOf;
      if (!t.asOfNewest || l.balanceAsOf > t.asOfNewest) t.asOfNewest = l.balanceAsOf;
    }
  }
  return t;
}

export interface AssetLike { id: string; name: string; owner: string | null; value: number; active: boolean; valueAsOf?: string | null; alert?: string | null; last4?: string | null }

export interface NetWorth {
  assets: number;
  liabilities: number; // known balances only
  unknownLiabilities: number; // count of obligations whose balance is unknown
  net: number;
  byOwner: Record<string, { assets: number; liabilities: number; net: number }>;
}

/** Net worth = Σ active asset values − Σ known counted liabilities, also per owner.
 *  Fund balances are envelopes of the same cash, so they are NOT assets here. */
export function netWorth(assets: AssetLike[], ls: Liability[]): NetWorth {
  const byOwner: NetWorth["byOwner"] = {};
  const slot = (o: string | null) => (byOwner[o ?? "—"] ??= { assets: 0, liabilities: 0, net: 0 });
  let a = 0, l = 0, unknown = 0;
  for (const x of assets) {
    if (!x.active) continue;
    a = round2(a + x.value);
    const s = slot(x.owner); s.assets = round2(s.assets + x.value);
  }
  for (const x of ls) {
    if (!x.counted) continue;
    if (x.balance == null) { unknown++; continue; }
    l = round2(l + x.balance);
    const s = slot(x.owner); s.liabilities = round2(s.liabilities + x.balance);
  }
  for (const s of Object.values(byOwner)) s.net = round2(s.assets - s.liabilities);
  return { assets: a, liabilities: l, unknownLiabilities: unknown, net: round2(a - l), byOwner };
}

export interface RegistryAlert { refType: "card" | "debt" | "asset"; refId: string; label: string; text: string }

/** Every red warning on the registry, in reading order (most urgent first). */
export function collectAlerts(ls: Liability[], assets: AssetLike[]): RegistryAlert[] {
  const out: RegistryAlert[] = [];
  for (const l of sortLiabilities(ls)) if (l.counted && l.alert) out.push({ refType: l.type, refId: l.id, label: l.label, text: l.alert });
  for (const a of assets) if (a.active && a.alert) out.push({ refType: "asset", refId: a.id, label: `${a.name}${a.last4 ? ` ${a.last4}` : ""}`, text: a.alert });
  return out;
}
