"use client";

/**
 * Реестр споров по shipping adjustments.
 *
 * Одна строка — одно списание, и по ней сразу видно всё: деньги, заказ, трек,
 * что мы заявили, что намерил перевозчик, из чего сложилось начисление и чем
 * кончилась переписка. Раскрытие строки показывает статьи начисления целиком
 * и всю историю урегулирования — Amazon принимает только поштучные претензии,
 * поэтому переписка живёт на строке заказа, а не на пачке.
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Btn } from "@/components/kit";
import { ChevronDown, ChevronRight, Download, ExternalLink, Loader2 } from "lucide-react";
import PeriodPicker, { presetLabel, presetPeriod, ruDay, type Period } from "./PeriodPicker";

const CLASS_ORDER = [
  "GROSS_DIM",
  "GROSS_WEIGHT",
  "SURCHARGE_ONLY",
  "MATCH",
  "DISCREPANCY",
  "SCANNER_NOISE",
  "NO_AUDIT_DATA",
] as const;

const CLASS_LABEL: Record<string, string> = {
  GROSS_DIM: "Грубый габарит",
  GROSS_WEIGHT: "Грубый вес",
  SURCHARGE_ONLY: "Только сурчарджи",
  MATCH: "Совпало",
  DISCREPANCY: "Расхождение",
  SCANNER_NOISE: "Шум замера",
  NO_AUDIT_DATA: "Аудита нет",
};

/** Классы, по которым имеет смысл идти в спор — красим тревожно. */
const CLASS_TONE: Record<string, string> = {
  GROSS_DIM: "bg-danger-tint text-danger-strong",
  GROSS_WEIGHT: "bg-danger-tint text-danger-strong",
  SURCHARGE_ONLY: "bg-warn-tint text-warn-strong",
  MATCH: "bg-warn-tint text-warn-strong",
  DISCREPANCY: "bg-surface-tint text-ink-2",
  SCANNER_NOISE: "bg-surface-tint text-ink-3",
  NO_AUDIT_DATA: "bg-surface-tint text-ink-3",
};

const STATUS_LABEL: Record<string, string> = {
  NONE: "Не подавали",
  DRAFT: "Черновик",
  FILED: "Открыт",
  AWAITING: "Ждём ответа Amazon",
  REPLIED: "Ответ Amazon — наш ход",
  REJECTED: "Отказ",
  PARTIAL: "Выигран частично",
  REFUNDED: "Выигран",
  ESCALATED: "Повторная проверка",
  CLOSED: "Закрыто",
  EXCLUDED_BLOCKED_ACCOUNT: "Аккаунт заблокирован — не подаём",
};

const EVENT_LABEL: Record<string, string> = {
  DRAFT: "Черновик спора",
  FILED: "Подано",
  CLARIFICATION: "Уточнение",
  AMAZON_REPLY: "Ответ Amazon",
  AMAZON_REVIEW: "Amazon взял на проверку",
  REJECTED: "Отказ",
  PARTIAL_REFUND: "Частичный возврат",
  REFUND: "Возврат (кредит в Payments)",
  ESCALATED: "Повторная проверка",
  CLOSED: "Закрыто",
  NOTE: "Пометка",
};

const SOURCE_LABEL: Record<string, string> = {
  TRANSACTION_DETAILS: "Transaction Details",
  FEDEX_API: "FedEx API",
  UPS_API_MANIFEST_UNRELIABLE: "UPS — манифест, не аудит",
};

const STORES = [
  { id: "store1", name: "Salutem Solutions" },
  { id: "store2", name: "Vladimir Personal" },
  { id: "store3", name: "AMZ Commerce" },
  { id: "store4", name: "Sirius International" },
  { id: "store5", name: "Retailer Distributor" },
  { id: "walmart-store1", name: "Walmart" },
];

/**
 * Справочник подачи — тот же, что в lib/adjustments/submission-origin.ts.
 * Здесь он нужен, чтобы оператор выбирал кабинет и VPS из списка, а не вбивал
 * руками: 20.09.2026 в кейс Salutem уехали 16 строк AMZ Commerce именно из-за
 * ручной сборки выборки.
 */
const SUBMISSION_ORIGINS = [
  { id: "store1", name: "Salutem Solutions", vps: "209.208.63.54", blocked: false },
  { id: "store3", name: "AMZ Commerce LLC", vps: "209.208.78.229", blocked: false },
  { id: "store5", name: "Retailer Distributor", vps: "209.208.79.131", blocked: true },
];

/** Типы событий, означающие исходящую подачу: для них кабинет и VPS обязательны. */
const SUBMISSION_EVENT_TYPES = ["FILED", "CLARIFICATION", "ESCALATED"];

interface ChargeLine {
  label: string;
  amount: number;
}

interface RegistryRow {
  id: string;
  date: string;
  channel: string;
  storeId: string | null;
  account: string | null;
  orderId: string | null;
  trackingNumber: string | null;
  sku: string | null;
  productName: string | null;
  carrier: string | null;
  service: string | null;
  entered: {
    dims: string | null;
    weight: number | null;
    weightUnit: string | null;
    fallbackDims: string | null;
    fallbackWeight: number | null;
  };
  audited: {
    dims: string | null;
    weight: number | null;
    weightUnit: string | null;
    source: string | null;
    capturedAt: string | null;
  };
  charges: ChargeLine[];
  amountAlreadyPaid: number | null;
  totalChargeFromCarrier: number | null;
  transactionTotal: number | null;
  labelCost: number | null;
  amount: number;
  disputeClass: string;
  disputeClassLabel: string | null;
  disputeStatus: string;
  submittable: boolean;
  blockedReason: string | null;
  submittedFrom: {
    store: string | null;
    account: string | null;
    vps: string | null;
    eventDate: string;
    caseId: string | null;
    mismatch: boolean;
  } | null;
  disputeCaseId: string | null;
  amountRecovered: number;
  financialEventId: string | null;
  transactionDetailsUrl: string | null;
  lastEvent: {
    date: string;
    type: string;
    caseId: string | null;
    summary: string | null;
    amountRefunded: number | null;
  } | null;
}

interface DisputeEvent {
  id: string;
  eventDate: string;
  eventType: string;
  caseId: string | null;
  storeId: string | null;
  submittedFromStore: string | null;
  submittedFromVps: string | null;
  amountInDispute: number | null;
  amountRefunded: number | null;
  summary: string | null;
  sourceType: string | null;
  sourceRef: string | null;
}

interface GroupRow {
  key: string;
  count: number;
  amount: number;
  recovered: number;
}

interface Filters {
  store: string;
  carrier: string;
  cls: string;
  status: string;
  submittedFrom: string;
  originMismatch: boolean;
  amountMin: string;
  amountMax: string;
  period: Period;
  q: string;
  groupBy: string;
}

const EMPTY_FILTERS: Filters = {
  store: "",
  carrier: "",
  cls: "",
  status: "",
  submittedFrom: "",
  originMismatch: false,
  amountMin: "",
  amountMax: "",
  period: presetPeriod("all"),
  q: "",
  groupBy: "class",
};

function buildParams(f: Filters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.store) p.set("store", f.store);
  if (f.carrier) p.set("carrier", f.carrier);
  if (f.cls) p.set("class", f.cls);
  if (f.status) p.set("status", f.status);
  if (f.submittedFrom) p.set("submittedFrom", f.submittedFrom);
  if (f.originMismatch) p.set("originMismatch", "1");
  if (f.amountMin) p.set("amountMin", f.amountMin);
  if (f.amountMax) p.set("amountMax", f.amountMax);
  if (f.q) p.set("q", f.q.trim());
  // Период по дате списания; без границ — весь реестр.
  if (f.period.from) p.set("from", f.period.from);
  if (f.period.to) p.set("to", f.period.to);
  if (!f.period.from && !f.period.to) p.set("days", "all");
  p.set("groupBy", f.groupBy);
  p.set("limit", "5000");
  return p;
}

const money = (v: number | null | undefined): string =>
  v == null ? "—" : `${v < 0 ? "−" : ""}$${Math.abs(v).toFixed(2)}`;

function trackingUrl(carrier: string | null, tracking: string | null): string | null {
  if (!tracking) return null;
  const c = (carrier || "").toUpperCase();
  if (c === "UPS") return `https://www.ups.com/track?tracknum=${tracking}`;
  if (c === "FEDEX") return `https://www.fedex.com/fedextrack/?trknbr=${tracking}`;
  if (c === "USPS") return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${tracking}`;
  return null;
}

export default function AdjustmentsRegistry() {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [rows, setRows] = useState<RegistryRow[]>([]);
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [totals, setTotals] = useState<{
    count: number;
    amount: number;
    recovered: number;
    truncated: boolean;
  } | null>(null);
  const [grand, setGrand] = useState<{
    count: number;
    amount: number;
    firstDate: string | null;
    lastDate: string | null;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [events, setEvents] = useState<Record<string, DisputeEvent[]>>({});
  const [eventsLoading, setEventsLoading] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/adjustments/registry?${buildParams(filters).toString()}`);
      const data = await res.json();
      setRows(data.items || []);
      setGroups(data.groups || []);
      setTotals(data.totals || null);
      setGrand(data.grand || null);
    } catch (err) {
      console.error("registry load failed", err);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    load();
  }, [load]);

  const loadEvents = useCallback(async (id: string) => {
    setEventsLoading(id);
    try {
      const res = await fetch(`/api/adjustments/dispute-events?adjustmentId=${id}`);
      const data = await res.json();
      setEvents((prev) => ({ ...prev, [id]: data.events || [] }));
    } catch (err) {
      console.error("events load failed", err);
    } finally {
      setEventsLoading(null);
    }
  }, []);

  const toggle = (id: string) => {
    const next = expandedId === id ? null : id;
    setExpandedId(next);
    if (next && !events[next]) loadEvents(next);
  };

  const csvHref = useMemo(() => {
    const p = buildParams(filters);
    p.set("format", "csv");
    return `/api/adjustments/registry?${p.toString()}`;
  }, [filters]);

  const set = (patch: Partial<Filters>) => setFilters((f) => ({ ...f, ...patch }));

  const selectClass =
    "rounded-md border border-rule bg-surface px-2.5 py-1.5 text-[12.5px] text-ink";

  return (
    <div className="space-y-4">
      {/* Период по дате списания */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12px] text-ink-3">Дата списания:</span>
        <PeriodPicker value={filters.period} onChange={(period) => set({ period })} />
      </div>

      {/* Фильтры */}
      <div className="flex flex-wrap items-center gap-2">
        <select className={selectClass} value={filters.store} onChange={(e) => set({ store: e.target.value })}>
          <option value="">Все аккаунты</option>
          {STORES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>

        <select className={selectClass} value={filters.carrier} onChange={(e) => set({ carrier: e.target.value })}>
          <option value="">Все перевозчики</option>
          <option value="FEDEX">FedEx</option>
          <option value="UPS">UPS</option>
          <option value="USPS">USPS</option>
          <option value="__none__">Не определён</option>
        </select>

        <select className={selectClass} value={filters.cls} onChange={(e) => set({ cls: e.target.value })}>
          <option value="">Все классы</option>
          {CLASS_ORDER.map((c) => (
            <option key={c} value={c}>
              {CLASS_LABEL[c]}
            </option>
          ))}
        </select>

        <select className={selectClass} value={filters.status} onChange={(e) => set({ status: e.target.value })}>
          <option value="">Любой статус спора</option>
          {Object.entries(STATUS_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>

        <select
          className={selectClass}
          value={filters.submittedFrom}
          onChange={(e) => set({ submittedFrom: e.target.value })}
          title="Из какого кабинета подано"
        >
          <option value="">Откуда подано: любой</option>
          <option value="__none__">Не подавали</option>
          {SUBMISSION_ORIGINS.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name} · {o.vps}
            </option>
          ))}
        </select>

        <label className="flex items-center gap-1 text-[12px] text-ink-2" title="Кабинет или VPS подачи не совпал со справочником">
          <input
            type="checkbox"
            checked={filters.originMismatch}
            onChange={(e) => set({ originMismatch: e.target.checked })}
          />
          чужой кабинет/VPS
        </label>

        <div className="flex items-center gap-1">
          <input
            className={`${selectClass} w-24`}
            placeholder="сумма от"
            inputMode="decimal"
            value={filters.amountMin}
            onChange={(e) => set({ amountMin: e.target.value })}
          />
          <span className="text-ink-3">–</span>
          <input
            className={`${selectClass} w-24`}
            placeholder="до"
            inputMode="decimal"
            value={filters.amountMax}
            onChange={(e) => set({ amountMax: e.target.value })}
          />
        </div>


        <input
          className={`${selectClass} w-52`}
          placeholder="номер заказа, трек, SKU, кейс"
          value={filters.q}
          onChange={(e) => set({ q: e.target.value })}
        />

        <select className={selectClass} value={filters.groupBy} onChange={(e) => set({ groupBy: e.target.value })}>
          <option value="class">Итоги по классу</option>
          <option value="store">Итоги по аккаунту</option>
          <option value="carrier">Итоги по перевозчику</option>
          <option value="status">Итоги по статусу</option>
          <option value="submittedFrom">Итоги по кабинету подачи</option>
        </select>

        <button
          type="button"
          onClick={() => setFilters(EMPTY_FILTERS)}
          className="text-[12px] text-ink-3 underline underline-offset-2 hover:text-ink"
        >
          сбросить
        </button>

        <div className="ml-auto flex items-center gap-2">
          {loading && <Loader2 size={14} className="animate-spin text-ink-3" />}
          <a href={csvHref} download>
            <Btn icon={<Download size={13} />}>CSV</Btn>
          </a>
        </div>
      </div>

      {/* Сколько показано из всего реестра */}
      {totals && grand && (
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-md bg-surface-tint px-3 py-2 text-[12.5px] text-ink-2">
          <span>
            Показано <strong className="tabular text-ink">{totals.count}</strong> из{" "}
            <span className="tabular">{grand.count}</span>
          </span>
          <span>
            сумма <strong className={`tabular ${totals.amount < 0 ? "text-danger" : "text-ink"}`}>{money(totals.amount)}</strong>
            {totals.recovered > 0 && <span className="text-success"> · вернули {money(totals.recovered)}</span>}
          </span>
          <span className="text-[11.5px] text-ink-3 tabular">
            {filters.period.from || filters.period.to
              ? `${ruDay(filters.period.from || grand.firstDate)} – ${ruDay(filters.period.to || grand.lastDate)} (${presetLabel(filters.period.preset)})`
              : `всё время: ${ruDay(grand.firstDate)} – ${ruDay(grand.lastDate)}`}
            {" · "}сумма со знаком: списания минус, кредиты плюс
          </span>
          {totals.truncated && <span className="text-warn-strong">срез по лимиту 5000 строк</span>}
        </div>
      )}

      {/* Итоги по группам */}
      {groups.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {groups.map((g) => (
            <div
              key={g.key}
              className="rounded-lg border border-rule bg-surface-tint px-3 py-1.5 text-[12px]"
            >
              <span className="text-ink">{CLASS_LABEL[g.key] ?? STATUS_LABEL[g.key] ?? g.key}</span>
              <span className="ml-2 tabular text-ink-3">
                {g.count} · {money(g.amount)}
                {g.recovered > 0 && <span className="text-success"> · вернули {money(g.recovered)}</span>}
              </span>
            </div>
          ))}
        </div>
      )}

      {rows.length === 0 ? (
        <p className="py-6 text-center text-[13px] text-ink-3">
          {loading ? "Загружаю…" : "Под фильтр ничего не попало"}
        </p>
      ) : (
        // Своя прокрутка: таблица не растягивает страницу, шапка прилипает.
        <div className="max-h-[600px] overflow-auto rounded-md border border-rule">
          <table className="w-full min-w-[1400px] text-[12px]">
            <thead className="sticky top-0 z-10 bg-surface shadow-[0_1px_0_var(--rule)]">
              <tr className="text-left text-ink-3">
                <th className="w-6 py-2 pl-1" />
                <th className="py-2 font-medium">Дата</th>
                <th className="font-medium">Аккаунт</th>
                <th className="font-medium">Заказ</th>
                <th className="font-medium">Трек</th>
                <th className="font-medium">SKU</th>
                <th className="font-medium">Заявлено</th>
                <th className="font-medium">Аудит</th>
                <th className="font-medium">Начисление</th>
                <th className="font-medium text-right">Лейбл</th>
                <th className="font-medium text-right">Списано</th>
                <th className="font-medium">Класс</th>
                <th className="font-medium">Спор</th>
                <th className="font-medium">Откуда подано</th>
                <th className="font-medium">Кейс</th>
                <th className="font-medium">Последнее событие</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const expanded = expandedId === r.id;
                const track = trackingUrl(r.carrier, r.trackingNumber);
                const enteredDims = r.entered.dims ?? r.entered.fallbackDims;
                const enteredWeight = r.entered.weight ?? r.entered.fallbackWeight;
                const unreliable = r.audited.source === "UPS_API_MANIFEST_UNRELIABLE";
                return (
                  <Fragment key={r.id}>
                    <tr
                      className="cursor-pointer border-b border-rule/40 hover:bg-surface-tint"
                      onClick={() => toggle(r.id)}
                    >
                      <td className="px-1">
                        {expanded ? (
                          <ChevronDown size={13} className="text-ink-3" />
                        ) : (
                          <ChevronRight size={13} className="text-ink-3" />
                        )}
                      </td>
                      <td className="py-1.5 whitespace-nowrap text-ink-3">{r.date}</td>
                      <td className="whitespace-nowrap text-ink">{r.account ?? r.channel}</td>
                      <td className="font-mono whitespace-nowrap">{r.orderId ?? "—"}</td>
                      <td className="font-mono whitespace-nowrap">
                        {track ? (
                          <a
                            href={track}
                            target="_blank"
                            rel="noreferrer"
                            className="text-blue-ink hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {r.trackingNumber}
                          </a>
                        ) : (
                          (r.trackingNumber ?? "—")
                        )}
                      </td>
                      <td className="font-mono">{r.sku ?? "—"}</td>
                      <td className="whitespace-nowrap text-ink-2">
                        {enteredDims ?? "—"}
                        {enteredWeight != null && <span className="ml-1">· {enteredWeight} lb</span>}
                      </td>
                      <td className={`whitespace-nowrap ${unreliable ? "text-ink-3 line-through" : "text-ink-2"}`}>
                        {r.audited.dims ?? "—"}
                        {r.audited.weight != null && (
                          <span className="ml-1">
                            · {r.audited.weight} {(r.audited.weightUnit ?? "lb").toLowerCase()}
                          </span>
                        )}
                      </td>
                      <td className="max-w-[180px] truncate text-ink-3">
                        {r.charges.length > 0 ? r.charges.map((c) => c.label).join(", ") : "—"}
                      </td>
                      <td className="text-right tabular text-ink-2">{money(r.labelCost)}</td>
                      <td
                        className={`text-right tabular font-medium ${
                          r.amount < 0 ? "text-danger" : "text-success"
                        }`}
                      >
                        {money(r.amount)}
                      </td>
                      <td>
                        <Badge className={`text-[10px] ${CLASS_TONE[r.disputeClass] ?? ""}`}>
                          {CLASS_LABEL[r.disputeClass] ?? r.disputeClass}
                        </Badge>
                      </td>
                      <td className="whitespace-nowrap text-ink-2">
                        {STATUS_LABEL[r.disputeStatus] ?? r.disputeStatus}
                        {r.amountRecovered > 0 && (
                          <span className="ml-1 text-success">{money(r.amountRecovered)}</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap">
                        {r.submittedFrom ? (
                          <span
                            className={
                              r.submittedFrom.mismatch
                                ? "rounded bg-danger-tint px-1.5 py-0.5 text-danger-strong"
                                : "text-ink-2"
                            }
                            title={
                              r.submittedFrom.mismatch
                                ? "Кабинет или VPS подачи не совпал со справочником — проверить немедленно"
                                : undefined
                            }
                          >
                            {r.submittedFrom.mismatch && "⚠ "}
                            {r.submittedFrom.account ?? "—"}
                            <span className="ml-1 font-mono text-ink-3">
                              {r.submittedFrom.vps ?? "—"}
                            </span>
                          </span>
                        ) : (
                          <span className="text-ink-3">—</span>
                        )}
                      </td>
                      <td className="font-mono whitespace-nowrap text-ink-3">{r.disputeCaseId ?? "—"}</td>
                      <td className="max-w-[200px] truncate text-ink-3">
                        {r.lastEvent
                          ? `${r.lastEvent.date} · ${EVENT_LABEL[r.lastEvent.type] ?? r.lastEvent.type}`
                          : "—"}
                      </td>
                    </tr>

                    {expanded && (
                      <tr className="border-b border-rule/40 bg-surface-tint/50">
                        <td />
                        <td colSpan={15} className="px-2 py-3">
                          <div className="grid gap-4 md:grid-cols-2">
                            {/* Состав начисления и источник аудита */}
                            <div>
                              <div className="mb-1 font-mono text-[10.5px] uppercase tracking-wider text-ink-3">
                                Состав начисления
                              </div>
                              {r.charges.length === 0 ? (
                                <p className="text-ink-3">
                                  Разбивки нет — страница Transaction Details по этой строке ещё не снята.
                                </p>
                              ) : (
                                <table className="w-full tabular">
                                  <tbody>
                                    {r.charges.map((c, i) => (
                                      <tr key={`${c.label}-${i}`} className="border-b border-rule/30">
                                        <td className="py-1 text-ink-2">{c.label}</td>
                                        <td className="py-1 text-right text-ink">{money(c.amount)}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              )}
                              <dl className="mt-2 space-y-0.5 text-ink-3">
                                <div>Уже оплачено: {money(r.amountAlreadyPaid)}</div>
                                <div>Выставил перевозчик: {money(r.totalChargeFromCarrier)}</div>
                                <div>Итог транзакции: {money(r.transactionTotal)}</div>
                                <div>
                                  Источник аудита:{" "}
                                  <span className={unreliable ? "text-danger-strong" : "text-ink-2"}>
                                    {r.audited.source
                                      ? (SOURCE_LABEL[r.audited.source] ?? r.audited.source)
                                      : "нет"}
                                  </span>
                                </div>
                                {r.financialEventId && <div>Financial event: {r.financialEventId}</div>}
                                {r.transactionDetailsUrl && (
                                  <div>
                                    <a
                                      href={r.transactionDetailsUrl}
                                      target="_blank"
                                      rel="noreferrer"
                                      className="inline-flex items-center gap-1 text-blue-ink hover:underline"
                                    >
                                      Transaction Details <ExternalLink size={11} />
                                    </a>
                                  </div>
                                )}
                              </dl>
                            </div>

                            {/* История урегулирования */}
                            <div>
                              <div className="mb-1 font-mono text-[10.5px] uppercase tracking-wider text-ink-3">
                                История урегулирования
                              </div>
                              {eventsLoading === r.id ? (
                                <Loader2 size={14} className="animate-spin text-ink-3" />
                              ) : (events[r.id] ?? []).length === 0 ? (
                                <p className="text-ink-3">Событий нет — по этой строке ещё ничего не подавали.</p>
                              ) : (
                                <ol className="space-y-1.5">
                                  {(events[r.id] ?? []).map((e) => (
                                    <li key={e.id} className="border-l-2 border-rule pl-2">
                                      <div className="text-ink">
                                        <span className="tabular text-ink-3">{e.eventDate}</span>{" "}
                                        <strong>{EVENT_LABEL[e.eventType] ?? e.eventType}</strong>
                                        {e.caseId && (
                                          <span className="ml-1 font-mono text-ink-3">#{e.caseId}</span>
                                        )}
                                        {e.amountRefunded != null && (
                                          <span className="ml-1 text-success">
                                            вернули {money(e.amountRefunded)}
                                          </span>
                                        )}
                                      </div>
                                      {e.submittedFromStore && (
                                        <div className="text-[10.5px] text-ink-3">
                                          подано из:{" "}
                                          {SUBMISSION_ORIGINS.find((o) => o.id === e.submittedFromStore)
                                            ?.name ?? e.submittedFromStore}
                                          {e.submittedFromVps ? ` · VPS ${e.submittedFromVps}` : ""}
                                        </div>
                                      )}
                                      {e.summary && <div className="text-ink-2">{e.summary}</div>}
                                      {e.sourceType && (
                                        <div className="text-[10.5px] text-ink-3">
                                          источник: {e.sourceType}
                                          {e.sourceRef ? ` · ${e.sourceRef}` : ""}
                                        </div>
                                      )}
                                    </li>
                                  ))}
                                </ol>
                              )}
                              <AddEventForm
                                adjustmentId={r.id}
                                rowStoreId={r.storeId}
                                submittable={r.submittable}
                                blockedReason={r.blockedReason}
                                onAdded={() => {
                                  loadEvents(r.id);
                                  load();
                                }}
                              />
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Запись события переписки. Ничего никуда не отправляет — только журнал.
 *
 * Событие подачи требует кабинета и VPS: без них сервер запись не создаст, и
 * форма это повторяет, чтобы ошибка ловилась до запроса. VPS подставляется из
 * справочника по выбранному кабинету и руками не вводится.
 */
function AddEventForm({
  adjustmentId,
  rowStoreId,
  submittable,
  blockedReason,
  onAdded,
}: {
  adjustmentId: string;
  rowStoreId: string | null;
  submittable: boolean;
  blockedReason: string | null;
  onAdded: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [eventType, setEventType] = useState("FILED");
  const [caseId, setCaseId] = useState("");
  const [summary, setSummary] = useState("");
  const [refunded, setRefunded] = useState("");
  // Номер транзакции кредита из Payments / SP-API — без него возврат не пишется.
  const [creditTx, setCreditTx] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Кабинет подачи по умолчанию — тот, на который упало списание.
  const [fromStore, setFromStore] = useState(rowStoreId ?? "");

  const input = "rounded-md border border-rule bg-surface px-2 py-1 text-[12px] text-ink";
  const isSubmission = SUBMISSION_EVENT_TYPES.includes(eventType);
  const isCredit = eventType === "REFUND" || eventType === "PARTIAL_REFUND";
  const origin = SUBMISSION_ORIGINS.find((o) => o.id === fromStore) ?? null;

  async function save() {
    setError(null);
    if (isSubmission && (!origin || origin.blocked)) {
      setError(
        origin?.blocked
          ? `${origin.name}: подача запрещена, аккаунт заблокирован`
          : "выберите кабинет подачи — без него и его VPS событие не записывается"
      );
      return;
    }
    if (isSubmission && rowStoreId && origin && rowStoreId !== origin.id) {
      setError("кабинет подачи не совпадает с аккаунтом списания — смешивать нельзя");
      return;
    }
    if (isCredit && (!creditTx.trim() || !(parseFloat(refunded) > 0))) {
      setError("возврат — только когда кредит виден в Payments: нужны сумма и номер транзакции кредита");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/adjustments/dispute-events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          adjustmentId,
          eventType,
          caseId: caseId.trim() || null,
          summary: summary.trim() || null,
          amountRefunded: refunded ? parseFloat(refunded) : null,
          sourceType: isCredit ? "PAYMENTS" : "MANUAL",
          ...(isCredit ? { sourceRef: creditTx.trim() } : {}),
          ...(isSubmission && origin
            ? { submittedFromStore: origin.id, submittedFromVps: origin.vps }
            : {}),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `POST failed (${res.status})`);
      setOpen(false);
      setCaseId("");
      setSummary("");
      setRefunded("");
      setCreditTx("");
      onAdded();
    } catch (err) {
      console.error("add event failed", err);
      setError(err instanceof Error ? err.message : "Не удалось записать событие");
    } finally {
      setSaving(false);
    }
  }

  if (!submittable) {
    return (
      <p className="mt-2 rounded-md bg-danger-tint px-2 py-1 text-[12px] text-danger-strong">
        {blockedReason ?? "Аккаунт заблокирован"} — событий по этой строке не заводим.
      </p>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 text-[12px] text-blue-ink underline underline-offset-2"
      >
        + событие
      </button>
    );
  }

  return (
    <div className="mt-2 space-y-1.5">
      <div className="flex flex-wrap gap-1.5">
        <select className={input} value={eventType} onChange={(e) => setEventType(e.target.value)}>
          {Object.entries(EVENT_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <input
          className={`${input} w-36`}
          placeholder="номер кейса"
          value={caseId}
          onChange={(e) => setCaseId(e.target.value)}
        />
        <input
          className={`${input} w-28`}
          placeholder="вернули $"
          inputMode="decimal"
          value={refunded}
          onChange={(e) => setRefunded(e.target.value)}
        />
        {isCredit && (
          <input
            className={`${input} w-56`}
            placeholder="транзакция кредита (Payments)"
            value={creditTx}
            onChange={(e) => setCreditTx(e.target.value)}
          />
        )}
      </div>

      {isSubmission && (
        <div className="flex flex-wrap items-center gap-1.5">
          <select className={input} value={fromStore} onChange={(e) => setFromStore(e.target.value)}>
            <option value="">кабинет подачи…</option>
            {SUBMISSION_ORIGINS.map((o) => (
              <option key={o.id} value={o.id} disabled={o.blocked}>
                {o.name}
                {o.blocked ? " — заблокирован" : ""}
              </option>
            ))}
          </select>
          <span className="font-mono text-[11.5px] text-ink-3">
            VPS {origin?.vps ?? "—"}
          </span>
        </div>
      )}

      {error && (
        <p className="rounded-md bg-danger-tint px-2 py-1 text-[11.5px] text-danger-strong">{error}</p>
      )}
      <textarea
        className={`${input} w-full`}
        rows={2}
        placeholder="суть события"
        value={summary}
        onChange={(e) => setSummary(e.target.value)}
      />
      <div className="flex gap-2">
        <Btn onClick={save} disabled={saving}>
          {saving ? "Пишу…" : "Записать"}
        </Btn>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-[12px] text-ink-3 underline underline-offset-2"
        >
          отмена
        </button>
      </div>
    </div>
  );
}
