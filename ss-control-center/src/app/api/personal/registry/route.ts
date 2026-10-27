// Personal obligations registry (Phase 2) — every obligation the owner carries, with
// its balance date + source + status badge, plus the asset side for net worth.
//   GET                                   → liabilities (cards + debts of BOTH pools), totals,
//                                           net worth, alerts, events, assets
//   POST   { type: "debt"|"event"|"asset", ... }        → create
//   PATCH  { type: "debt"|"card"|"event"|"asset", id, ... } → update
//   DELETE ?type=event|asset&id=          → remove
// A changed balance/value without its own date + source is stamped "today · Manual entry",
// so no number on the page is ever undated. Owner is required on debts and cards.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth-server";
import {
  STANDINGS, cardToLiability, collectAlerts, debtToLiability, netWorth, registryTotals, sortLiabilities,
} from "@/lib/finance/registry";

const round2 = (n: number) => Math.round(n * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);
const num = (v: unknown) => (v != null && v !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown) => (v == null || String(v).trim() === "" ? null : String(v).trim());
const iso = (v: unknown) => { const s = str(v); return s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; };
const standing = (v: unknown) => { const s = str(v); return s && (STANDINGS as readonly string[]).includes(s) ? s : null; };
const day = (v: unknown) => { const n = num(v); return n != null && n >= 1 && n <= 31 ? Math.round(n) : null; };
const FREQ = new Set(["monthly", "biweekly", "weekly", "daily"]);
const EVENT_KINDS = new Set(["payment", "installment", "hearing", "mediation", "window", "deadline"]);
const EVENT_STATUS = new Set(["planned", "done", "missed", "cancelled"]);
const AUTOPAY = new Set(["none", "min", "statement", "full", "fixed"]);

type Parser = (v: unknown) => unknown;
const bool: Parser = (v) => v === true || v === "true" || v === 1 || v === "1";

const DEBT_FIELDS: Record<string, Parser> = {
  description: str, creditor: str, entity: str, accountRef: str, owner: str, kind: str,
  apr: num, monthlyPayment: num, paymentFrequency: (v) => (FREQ.has(String(v)) ? String(v) : null), dueDay: day,
  nextDueDate: iso, maturityDate: iso, balanceAsOf: iso, balanceSource: str, balanceNote: str,
  standing, standingSince: iso, standingNote: str, alert: str, amountKnown: bool,
};
const CARD_FIELDS: Record<string, Parser> = {
  owner: str, issuer: str, name: str, last4: str, creditLimit: (v) => num(v) ?? 0, currentBalance: (v) => round2(num(v) ?? 0),
  statementBalance: (v) => round2(num(v) ?? 0), apr: num, minPaymentDue: num, dueDay: day, nextDueDate: iso,
  autopay: (v) => (AUTOPAY.has(String(v)) ? String(v) : "none"), autopayAmount: num,
  balanceAsOf: iso, balanceSource: str, balanceNote: str, standing, standingSince: iso, standingNote: str, alert: str,
  closed: bool, active: bool,
};
const EVENT_FIELDS: Record<string, Parser> = {
  date: iso, endDate: iso, time: str, kind: (v) => (EVENT_KINDS.has(String(v)) ? String(v) : "payment"), title: str,
  amount: num, status: (v) => (EVENT_STATUS.has(String(v)) ? String(v) : "planned"), source: str, note: str,
  debtId: str, cardId: str,
};
const ASSET_FIELDS: Record<string, Parser> = {
  owner: str, entity: str, name: str, kind: str, institution: str, last4: str, value: (v) => round2(num(v) ?? 0),
  valueAsOf: iso, valueSource: str, alert: str, active: bool, notes: str,
};

function pick(b: Record<string, unknown>, fields: Record<string, Parser>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, parse] of Object.entries(fields)) if (b[k] !== undefined) out[k] = parse(b[k]);
  return out;
}

/** A new number must carry its date + source; stamp them when the caller didn't. */
function stampSource(data: Record<string, unknown>, changed: boolean, asOfKey: string, sourceKey: string) {
  if (!changed) return;
  if (!data[asOfKey]) data[asOfKey] = today();
  if (!data[sourceKey]) data[sourceKey] = `Manual entry ${today()}`;
}

const bad = (error: string) => NextResponse.json({ ok: false, error }, { status: 400 });

// Invalid numbers must not silently erase a real balance or become a guessed 0.
function invalidInput(b: Record<string, unknown>): string | null {
  if (!b || typeof b !== "object" || Array.isArray(b)) return "object required";
  const fields = b.type === "asset" ? ["value"] : b.type === "event" ? ["amount"]
    : b.type === "card" ? ["currentBalance", "statementBalance", "creditLimit", "apr", "minPaymentDue", "autopayAmount", "dueDay"]
    : ["balance", "apr", "monthlyPayment", "dueDay"];
  for (const k of fields) {
    if (!(k in b)) continue;
    const v = b[k], blank = v == null || typeof v === "string" && !v.trim();
    if (blank) {
      if (["value", "currentBalance", "statementBalance"].includes(k)) return `${k} must be a number`;
      continue;
    }
    if ((typeof v !== "number" && typeof v !== "string") || !Number.isFinite(Number(v))) return `${k} must be a finite number`;
    if (k !== "value" && Number(v) < 0) return `${k} must not be negative`;
    if (k === "dueDay" && (!Number.isInteger(Number(v)) || Number(v) < 1 || Number(v) > 31)) return "dueDay must be 1–31";
  }
  for (const k of ["date", "endDate", "balanceAsOf", "valueAsOf", "nextDueDate", "standingSince", "maturityDate"]) {
    if (!b[k]) continue;
    const v = iso(b[k]);
    if (!v || !Number.isFinite(Date.parse(v)) || new Date(v).toISOString().slice(0, 10) !== v) return `${k} must be a valid date`;
  }
  if (b.date && b.endDate && String(b.endDate) < String(b.date)) return "endDate must not precede date";
  return null;
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  const [cards, debts, events, assets] = await Promise.all([
    prisma.creditCard.findMany({ where: { scope: "personal" } }),
    // Both pools: a business-plan debt is still the owner's obligation (shown, not copied).
    prisma.debt.findMany({ where: { status: "open" } }),
    prisma.obligationEvent.findMany({ where: { scope: "personal" }, orderBy: [{ date: "asc" }, { time: "asc" }] }),
    prisma.personalAsset.findMany({ where: { scope: "personal" }, orderBy: [{ active: "desc" }, { value: "desc" }] }),
  ]);
  const liabilities = sortLiabilities([...cards.map(cardToLiability), ...debts.map(debtToLiability)]);
  const labelOf = new Map(liabilities.map((l) => [l.id, l.label]));
  return NextResponse.json({
    today: today(),
    liabilities,
    totals: registryTotals(liabilities),
    netWorth: netWorth(assets, liabilities),
    alerts: collectAlerts(liabilities, assets),
    events: events.map((e) => ({ ...e, refLabel: labelOf.get(e.debtId ?? e.cardId ?? "") ?? null })),
    assets,
  });
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  try {
    const b = await req.json();
    const invalid = invalidInput(b);
    if (invalid) return bad(invalid);
    if (b.type === "event") {
      const data = pick(b, EVENT_FIELDS);
      if (!data.date || !data.title) return bad("date (YYYY-MM-DD) and title required");
      const event = await prisma.obligationEvent.create({ data: { scope: "personal", kind: "payment", ...data } as never });
      return NextResponse.json({ ok: true, event });
    }
    if (b.type === "asset") {
      const data = pick(b, ASSET_FIELDS);
      if (!data.name || !data.owner || num(b.value) == null) return bad("name, owner and value required");
      stampSource(data, true, "valueAsOf", "valueSource");
      const asset = await prisma.personalAsset.create({ data: { scope: "personal", ...data } as never });
      return NextResponse.json({ ok: true, asset });
    }
    if (b.type === "debt") {
      const data = pick(b, DEBT_FIELDS);
      if (!data.owner) return bad("owner required");
      if (!data.description && !data.creditor) return bad("description or creditor required");
      const balance = num(b.balance);
      const known = balance != null;
      const fund = b.fundId
        ? await prisma.fund.findUnique({ where: { id: String(b.fundId) } })
        : await prisma.fund.findFirst({ where: { scope: "personal", name: "Loans" } });
      if (!fund) return bad("fund not found");
      stampSource(data, true, "balanceAsOf", "balanceSource");
      const debt = await prisma.debt.create({
        data: {
          ...data, scope: fund.scope, fundId: fund.id, amount: known ? round2(balance!) : 0, amountKnown: known,
          description: (data.description as string | null) ?? (data.creditor as string), standing: (data.standing as string | null) ?? "current",
          lastAccruedDate: today(),
        } as never,
      });
      return NextResponse.json({ ok: true, debt });
    }
    return bad("type must be debt | event | asset");
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  try {
    const b = await req.json();
    const invalid = invalidInput(b);
    if (invalid) return bad(invalid);
    if (!b.id) return bad("id required");
    const id = String(b.id);

    if (b.type === "debt") {
      const data = pick(b, DEBT_FIELDS);
      if ("owner" in data && !data.owner) return bad("owner required");
      const balance = num(b.balance);
      if (balance != null) {
        // The registry edits the BALANCE; keep the paid ledger, move the amount.
        const cur = await prisma.debt.findUnique({ where: { id }, select: { paid: true } });
        if (!cur) return bad("debt not found");
        data.amount = round2(balance + cur.paid);
        data.amountKnown = true;
      }
      stampSource(data, balance != null, "balanceAsOf", "balanceSource");
      const debt = await prisma.debt.update({ where: { id }, data: data as never });
      return NextResponse.json({ ok: true, debt });
    }
    if (b.type === "card") {
      const data = pick(b, CARD_FIELDS);
      if ("owner" in data && !data.owner) return bad("owner required");
      stampSource(data, "currentBalance" in data, "balanceAsOf", "balanceSource");
      const card = await prisma.creditCard.update({ where: { id }, data: data as never });
      return NextResponse.json({ ok: true, card });
    }
    if (b.type === "event") {
      const event = await prisma.obligationEvent.update({ where: { id }, data: pick(b, EVENT_FIELDS) as never });
      return NextResponse.json({ ok: true, event });
    }
    if (b.type === "asset") {
      const data = pick(b, ASSET_FIELDS);
      if ("owner" in data && !data.owner) return bad("owner required");
      stampSource(data, "value" in data, "valueAsOf", "valueSource");
      const asset = await prisma.personalAsset.update({ where: { id }, data: data as never });
      return NextResponse.json({ ok: true, asset });
    }
    return bad("type must be debt | card | event | asset");
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const auth = await requireAdmin(req);
  if (auth instanceof NextResponse) return auth;
  const type = req.nextUrl.searchParams.get("type");
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return bad("id required");
  if (type === "event") await prisma.obligationEvent.delete({ where: { id } });
  else if (type === "asset") await prisma.personalAsset.delete({ where: { id } });
  else return bad("type must be event | asset");
  return NextResponse.json({ ok: true });
}
