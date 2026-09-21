/**
 * GET /api/adjustments/registry
 *
 * Реестр споров по shipping adjustments: одна строка — одно списание, со всем,
 * что по нему известно, включая последнее событие переписки. Старая ручка
 * /api/adjustments оставлена нетронутой — на ней висит ночной сбор и прежняя
 * таблица.
 *
 * Параметры (все необязательные):
 *   store=store1,store3       storeId, через запятую
 *   channel=Amazon
 *   carrier=FEDEX,UPS         __none__ — перевозчик не определён
 *   class=GROSS_DIM,MATCH     класс расхождения
 *   status=FILED,REJECTED     статус спора (EXCLUDED_BLOCKED_ACCOUNT — заблокированный аккаунт)
 *   submittedFrom=store1      из какого кабинета подавали; __none__ — не подавали ниоткуда
 *   originMismatch=1          только строки, где кабинет/VPS подачи не сошлись со справочником
 *   source=TRANSACTION_DETAILS
 *   amountMin=50&amountMax=900  по модулю суммы списания, USD
 *   days=180 | from=YYYY-MM-DD&to=YYYY-MM-DD
 *   q=строка                  поиск по заказу, треку, SKU, номеру кейса
 *   groupBy=store|carrier|class|status
 *   limit=500
 *   format=csv                выгрузка вместо JSON
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { CLASS_LABEL, parseChargeBreakdown } from "@/lib/adjustments/audit-classify";
import {
  EXCLUDED_BLOCKED_ACCOUNT,
  STORE_ORIGINS,
  isBlockedStore,
  isSubmissionEvent,
  originFor,
  originMismatch,
} from "@/lib/adjustments/submission-origin";

const list = (v: string | null): string[] =>
  (v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

/** Аккаунты, с которых подача запрещена — их строки не идут в очередь спора. */
const BLOCKED_STORE_IDS = Object.values(STORE_ORIGINS)
  .filter((o) => o.blocked)
  .map((o) => o.storeId);

const ACCOUNT_NAMES: Record<string, string> = {
  store1: "Salutem Solutions",
  store2: "Vladimir Personal",
  store3: "AMZ Commerce",
  store4: "Sirius International",
  store5: "Retailer Distributor",
  "walmart-store1": "Walmart",
};

function dims(l: number | null, w: number | null, h: number | null, unit: string | null): string | null {
  if (l == null || w == null || h == null) return null;
  return `${l}×${w}×${h} ${(unit || "IN").toLowerCase()}`;
}

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;

  const stores = list(sp.get("store"));
  const carriers = list(sp.get("carrier"));
  const classes = list(sp.get("class"));
  const statuses = list(sp.get("status"));
  const submittedFrom = list(sp.get("submittedFrom"));
  const onlyMismatch = sp.get("originMismatch") === "1";
  const sources = list(sp.get("source"));
  const channel = sp.get("channel");
  const q = (sp.get("q") || "").trim();
  const groupBy = sp.get("groupBy") || "class";
  const limit = Math.min(5000, Math.max(1, parseInt(sp.get("limit") || "500")));
  const amountMin = parseFloat(sp.get("amountMin") || "");
  const amountMax = parseFloat(sp.get("amountMax") || "");

  const where: Prisma.ShippingAdjustmentWhereInput = {};
  const and: Prisma.ShippingAdjustmentWhereInput[] = [];

  if (channel) where.channel = channel;
  if (stores.length) where.storeId = { in: stores };
  if (classes.length) where.disputeClass = { in: classes };
  if (sources.length) where.auditSource = { in: sources };

  // Статус заблокированного аккаунта не хранится в строке, а следует из
  // справочника подачи: фильтр переводим в условие по storeId.
  if (statuses.length) {
    const wantsBlocked = statuses.includes(EXCLUDED_BLOCKED_ACCOUNT);
    const others = statuses.filter((s) => s !== EXCLUDED_BLOCKED_ACCOUNT);
    const clauses: Prisma.ShippingAdjustmentWhereInput[] = [];
    if (wantsBlocked) clauses.push({ storeId: { in: BLOCKED_STORE_IDS } });
    if (others.length) {
      clauses.push({ disputeStatus: { in: others }, storeId: { notIn: BLOCKED_STORE_IDS } });
    }
    and.push(clauses.length === 1 ? clauses[0] : { OR: clauses });
  }

  // «Откуда подано» — по событиям строки. __none__ = ни одного события подачи.
  if (submittedFrom.length) {
    const named = submittedFrom.filter((s) => s !== "__none__");
    const wantsNone = submittedFrom.includes("__none__");
    const clauses: Prisma.ShippingAdjustmentWhereInput[] = [];
    if (named.length) {
      clauses.push({ disputeEvents: { some: { submittedFromStore: { in: named } } } });
    }
    if (wantsNone) {
      clauses.push({ disputeEvents: { none: { submittedFromStore: { not: null } } } });
    }
    and.push(clauses.length === 1 ? clauses[0] : { OR: clauses });
  }

  if (carriers.length) {
    const named = carriers.filter((c) => c !== "__none__");
    const wantsNone = carriers.includes("__none__");
    if (named.length && wantsNone) {
      and.push({ OR: [{ carrier: { in: named } }, { carrier: null }] });
    } else if (wantsNone) {
      where.carrier = null;
    } else {
      where.carrier = { in: named };
    }
  }

  // Диапазон дат: либо окно в днях, либо явные границы.
  const from = sp.get("from");
  const to = sp.get("to");
  if (from || to) {
    where.adjustmentDate = {
      ...(from ? { gte: from } : {}),
      ...(to ? { lte: to } : {}),
    };
  } else {
    const days = Math.min(1000, Math.max(1, parseInt(sp.get("days") || "180")));
    const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
    where.adjustmentDate = { gte: since };
  }

  if (q) {
    and.push({
      OR: [
        { amazonOrderId: { contains: q } },
        { orderId: { contains: q } },
        { walmartOrderId: { contains: q } },
        { trackingNumber: { contains: q } },
        { sku: { contains: q } },
        { disputeCaseId: { contains: q } },
        { productName: { contains: q } },
      ],
    });
  }

  // Фильтр по сумме — по модулю: списание в базе отрицательное, возврат
  // положительный, а оператор мыслит величиной, а не знаком.
  if (Number.isFinite(amountMin)) {
    and.push({
      OR: [{ adjustmentAmount: { lte: -amountMin } }, { adjustmentAmount: { gte: amountMin } }],
    });
  }
  if (Number.isFinite(amountMax)) {
    and.push({ adjustmentAmount: { gte: -amountMax, lte: amountMax } });
  }

  if (and.length) where.AND = and;

  const rows = await prisma.shippingAdjustment.findMany({
    where,
    orderBy: [{ adjustmentDate: "desc" }, { createdAt: "desc" }],
    take: limit,
    include: {
      // Берём последние события целиком: из них нужно не только самое свежее,
      // но и последняя подача — по ней видно кабинет и VPS.
      disputeEvents: {
        orderBy: [{ eventDate: "desc" }, { eventAt: "desc" }],
        take: 20,
      },
    },
  });

  let items = rows.map((r) => {
    const last = r.disputeEvents[0] ?? null;
    const submission =
      r.disputeEvents.find((e) => isSubmissionEvent(e.eventType) && e.submittedFromStore) ?? null;
    const blocked = isBlockedStore(r.storeId);
    const blockedOrigin = blocked ? originFor(r.storeId) : null;
    return {
      id: r.id,
      date: r.adjustmentDate,
      channel: r.channel,
      storeId: r.storeId,
      account: r.storeId ? (ACCOUNT_NAMES[r.storeId] ?? r.storeId) : null,
      orderId: r.amazonOrderId ?? r.orderId ?? r.walmartOrderId ?? null,
      trackingNumber: r.trackingNumber,
      sku: r.sku,
      productName: r.productName,
      carrier: r.carrier,
      service: r.service,

      entered: {
        dims: dims(r.enteredDimL, r.enteredDimW, r.enteredDimH, r.enteredDimUnit),
        weight: r.enteredWeight,
        weightUnit: r.enteredWeightUnit,
        // запасной источник заявленного — наша SKU-база
        fallbackDims: dims(r.declaredDimL, r.declaredDimW, r.declaredDimH, "IN"),
        fallbackWeight: r.declaredWeightLbs,
      },
      audited: {
        dims: dims(r.auditedDimL, r.auditedDimW, r.auditedDimH, r.auditedDimUnit),
        weight: r.auditedWeight,
        weightUnit: r.auditedWeightUnit,
        source: r.auditSource,
        capturedAt: r.auditCapturedAt,
      },

      charges: parseChargeBreakdown(r.chargeBreakdown),
      amountAlreadyPaid: r.amountAlreadyPaid,
      totalChargeFromCarrier: r.totalChargeFromCarrier,
      transactionTotal: r.transactionTotal,
      labelCost: r.originalLabelCost,
      amount: r.adjustmentAmount,
      currency: r.currency ?? "USD",

      disputeClass: r.disputeClass ?? "NO_AUDIT_DATA",
      disputeClassLabel: CLASS_LABEL[(r.disputeClass ?? "NO_AUDIT_DATA") as keyof typeof CLASS_LABEL] ?? null,
      // Заблокированный аккаунт виден в реестре, но подать по нему нечего —
      // терминальный статус перекрывает всё, что было в переписке.
      disputeStatus: blocked ? EXCLUDED_BLOCKED_ACCOUNT : (r.disputeStatus ?? "NONE"),
      submittable: !blocked,
      blockedReason: blockedOrigin?.blockedReason ?? null,

      submittedFrom: submission
        ? {
            store: submission.submittedFromStore,
            account: submission.submittedFromStore
              ? (originFor(submission.submittedFromStore)?.account ??
                ACCOUNT_NAMES[submission.submittedFromStore] ??
                submission.submittedFromStore)
              : null,
            vps: submission.submittedFromVps,
            eventDate: submission.eventDate,
            caseId: submission.caseId,
            mismatch: originMismatch(
              r.storeId,
              submission.submittedFromStore,
              submission.submittedFromVps
            ),
          }
        : null,

      disputeCaseId: r.disputeCaseId,
      amountRecovered: r.amountRecovered ?? 0,
      financialEventId: r.financialEventId,
      transactionDetailsUrl: r.transactionDetailsUrl,

      lastEvent: last
        ? {
            date: last.eventDate,
            type: last.eventType,
            caseId: last.caseId,
            summary: last.summary,
            amountRefunded: last.amountRefunded,
          }
        : null,
    };
  });

  // Смешение кабинетов — отдельный срез: расхождение ищут глазами, поэтому
  // фильтр должен давать ровно эти строки и ничего больше.
  if (onlyMismatch) items = items.filter((i) => i.submittedFrom?.mismatch);

  // Итоги по группам — строк и сумма, чтобы было видно, где деньги.
  const groupKey = (i: (typeof items)[number]): string => {
    if (groupBy === "store") return i.account ?? "—";
    if (groupBy === "carrier") return i.carrier ?? "—";
    if (groupBy === "status") return i.disputeStatus;
    if (groupBy === "submittedFrom") return i.submittedFrom?.account ?? "не подавали";
    return i.disputeClass;
  };
  const groupMap = new Map<string, { key: string; count: number; amount: number; recovered: number }>();
  for (const i of items) {
    const key = groupKey(i);
    const g = groupMap.get(key) ?? { key, count: 0, amount: 0, recovered: 0 };
    g.count++;
    g.amount += i.amount;
    g.recovered += i.amountRecovered;
    groupMap.set(key, g);
  }
  const groups = [...groupMap.values()]
    .map((g) => ({
      ...g,
      amount: Math.round(g.amount * 100) / 100,
      recovered: Math.round(g.recovered * 100) / 100,
    }))
    .sort((a, b) => a.amount - b.amount);

  const totals = {
    count: items.length,
    amount: Math.round(items.reduce((s, i) => s + i.amount, 0) * 100) / 100,
    recovered: Math.round(items.reduce((s, i) => s + i.amountRecovered, 0) * 100) / 100,
    truncated: items.length === limit,
  };

  if (sp.get("format") === "csv") {
    const header = [
      "date", "account", "channel", "order_id", "tracking", "sku", "carrier",
      "entered_dims", "entered_weight", "audited_dims", "audited_weight", "audit_source",
      "charges", "label_cost", "amount", "class", "dispute_status", "case_id",
      "amount_recovered", "last_event_date", "last_event_type",
      "submitted_from_account", "submitted_from_vps", "origin_mismatch",
    ];
    const esc = (v: unknown): string => {
      if (v == null) return "";
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [
      header.join(","),
      ...items.map((i) =>
        [
          i.date, i.account, i.channel, i.orderId, i.trackingNumber, i.sku, i.carrier,
          i.entered.dims ?? i.entered.fallbackDims,
          i.entered.weight ?? i.entered.fallbackWeight,
          i.audited.dims, i.audited.weight, i.audited.source,
          i.charges.map((c) => `${c.label}: ${c.amount}`).join("; "),
          i.labelCost, i.amount, i.disputeClass, i.disputeStatus, i.disputeCaseId,
          i.amountRecovered, i.lastEvent?.date, i.lastEvent?.type,
          i.submittedFrom?.account, i.submittedFrom?.vps,
          i.submittedFrom?.mismatch ? "MISMATCH" : "",
        ]
          .map(esc)
          .join(",")
      ),
    ];
    return new NextResponse(lines.join("\n"), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="adjustments-registry-${new Date()
          .toISOString()
          .slice(0, 10)}.csv"`,
      },
    });
  }

  return NextResponse.json({ items, groups, totals, groupBy });
}
