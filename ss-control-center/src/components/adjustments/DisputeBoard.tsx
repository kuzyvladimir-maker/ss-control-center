"use client";

/**
 * Дашборд споров вверху /adjustments: сводка по каждому аккаунту, кейсы со
 * статусом и датой следующего действия, здоровье кронов. Данные —
 * /api/adjustments/board, то есть тот же реестр, что и таблица ниже.
 */
import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
import { FilterTabs, Panel, PanelBody, PanelHeader } from "@/components/kit";

interface Money {
  count: number;
  amount: number;
}
interface AccountPeriod {
  charged: Money;
  disputed: Money;
  won: Money;
  rejected: Money;
  inWork: Money;
  awaiting: Money;
}
interface AccountBoard {
  storeId: string;
  name: string;
  vps: string | null;
  cutoff: string;
  all: AccountPeriod;
  last30: AccountPeriod;
  sinceCutoff: { charged: Money; disputable: Money; untouched: Money };
}
interface BoardCase {
  key: string;
  caseId: string | null;
  storeId: string;
  account: string;
  status: string;
  statusLabel: string;
  rows: number;
  amount: number;
  recovered: number;
  rejectedAmount: number;
  carriers: string[];
  breakdown: Array<{ status: string; count: number }>;
  openedAt: string | null;
  lastEventAt: string | null;
  nextActionDate: string | null;
  nextAction: string | null;
}
interface CronHealth {
  job: string;
  label: string;
  where: string;
  schedule: string;
  lastStartedAt: string | null;
  lastFinishedAt: string | null;
  lastStatus: string | null;
  lastError: string | null;
  lastSuccessAt: string | null;
  nextRunAt: string | null;
  stale: boolean;
}
interface Board {
  generatedAt: string;
  today: string;
  accounts: AccountBoard[];
  cases: BoardCase[];
  crons: CronHealth[];
  anyStale: boolean;
}

type Period = "all" | "last30";

const ROW_STATUS_LABEL: Record<string, string> = {
  DRAFT: "черновик",
  FILED: "открыт",
  AWAITING: "ждём Amazon",
  REPLIED: "ответ Amazon",
  ESCALATED: "повторная проверка",
  REFUNDED: "выиграно",
  PARTIAL: "частично",
  REJECTED: "отказ",
  CLOSED: "закрыто",
};

const CASE_TONE: Record<string, string> = {
  DRAFT: "bg-surface-tint text-ink-2",
  FILED: "bg-surface-tint text-ink",
  AWAITING: "bg-surface-tint text-ink",
  REPLIED: "bg-warn-tint text-warn-strong",
  ESCALATED: "bg-warn-tint text-warn-strong",
  WON: "bg-green-soft text-green-ink",
  PARTIAL: "bg-green-soft2 text-green-ink",
  REJECTED: "bg-danger-tint text-danger-strong",
  CLOSED: "bg-surface-tint text-ink-3",
};

const usd = (n: number) =>
  `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const ruDate = (iso: string | null) => {
  if (!iso) return "—";
  const d = iso.length === 10 ? new Date(`${iso}T12:00:00Z`) : new Date(iso);
  return d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", timeZone: "America/New_York" });
};
const ruDateTime = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "America/New_York",
      }) + " ET"
    : "—";

function Metric({
  label,
  money,
  tone,
  hint,
}: {
  label: string;
  money: Money;
  tone?: "good" | "bad" | "warn";
  hint?: string;
}) {
  const color =
    tone === "good" ? "text-green-ink" : tone === "bad" ? "text-danger" : tone === "warn" ? "text-warn-strong" : "text-ink";
  return (
    <div className="rounded-md border border-rule/60 bg-surface px-3 py-2">
      <div className="text-[11px] text-ink-3">{label}</div>
      <div className={`tabular text-[17px] font-semibold ${color}`}>{usd(money.amount)}</div>
      <div className="text-[11px] text-ink-3 tabular">
        {money.count} {hint ?? "списаний"}
      </div>
    </div>
  );
}

export default function DisputeBoard() {
  const [board, setBoard] = useState<Board | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<Period>("all");
  const [store, setStore] = useState<string>("all");
  const [showClosed, setShowClosed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/adjustments/board", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      setBoard(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (loading && !board) {
    return (
      <Panel>
        <PanelBody className="flex items-center gap-2 text-[12.5px] text-ink-3">
          <Loader2 size={14} className="animate-spin" /> Загружаю дашборд споров…
        </PanelBody>
      </Panel>
    );
  }
  if (error && !board) {
    return (
      <div className="rounded-lg border border-danger/20 bg-danger-tint px-4 py-2.5 text-[12.5px] text-danger-strong">
        Дашборд споров не загрузился: {error}
      </div>
    );
  }
  if (!board) return null;

  const staleCrons = board.crons.filter((c) => c.stale);
  const terminal = new Set(["WON", "REJECTED", "CLOSED", "PARTIAL"]);
  const cases = board.cases.filter(
    (c) => (store === "all" || c.storeId === store) && (showClosed || !terminal.has(c.status))
  );
  const closedCount = board.cases.filter(
    (c) => (store === "all" || c.storeId === store) && terminal.has(c.status)
  ).length;

  return (
    <div className="space-y-4">
      {staleCrons.length > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-tint px-4 py-2.5 text-[12.5px] text-danger-strong">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <div>
            <strong>Крон не отработал больше суток:</strong>{" "}
            {staleCrons
              .map((c) => `${c.label} (последний успех ${ruDateTime(c.lastSuccessAt)})`)
              .join("; ")}
            . Новые штрафы и кредиты могут не попадать в реестр.
          </div>
        </div>
      )}

      <Panel>
        <PanelHeader
          title="Споры по корректировкам доставки"
          right={
            <div className="flex items-center gap-2">
              <FilterTabs<Period>
                className="border-0 px-0 py-0"
                tabs={[
                  { id: "all", label: "Всё время" },
                  { id: "last30", label: "30 дней" },
                ]}
                active={period}
                onChange={setPeriod}
              />
              <button
                type="button"
                onClick={load}
                className="text-ink-3 hover:text-ink"
                title="Обновить"
              >
                <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
              </button>
            </div>
          }
        />
        <PanelBody className="space-y-4">
          {board.accounts.map((a) => {
            const p = a[period];
            return (
              <div key={a.storeId} className="space-y-2">
                <div className="flex flex-wrap items-baseline gap-x-3 text-[13px]">
                  <strong className="text-ink">{a.name}</strong>
                  <span className="font-mono text-[11px] text-ink-3">VPS {a.vps ?? "—"}</span>
                </div>
                <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
                  <Metric label="Предъявлено" money={p.charged} tone="bad" />
                  <Metric label="Оспариваем" money={p.disputed} />
                  <Metric label="Отвоёвано (кредит в Payments)" money={p.won} tone="good" />
                  <Metric label="Отказано" money={p.rejected} tone="bad" />
                  <Metric label="В работе (наш ход)" money={p.inWork} tone="warn" />
                  <Metric label="Ждёт ответа Amazon" money={p.awaiting} />
                </div>
                <div className="rounded-md bg-surface-tint px-3 py-1.5 text-[12px] text-ink-2">
                  Новые после отсечки {ruDate(a.cutoff)}:{" "}
                  <strong className="text-ink tabular">
                    {a.sinceCutoff.charged.count} на {usd(a.sinceCutoff.charged.amount)}
                  </strong>
                  {" · "}спорных в работе{" "}
                  <span className="tabular">
                    {a.sinceCutoff.disputable.count} на {usd(a.sinceCutoff.disputable.amount)}
                  </span>
                  {" · "}без решения{" "}
                  <span className="tabular">
                    {a.sinceCutoff.untouched.count} на {usd(a.sinceCutoff.untouched.amount)}
                  </span>
                </div>
              </div>
            );
          })}
          <p className="text-[11px] text-ink-3">
            «Отвоёвано» считается только по кредиту, найденному в Payments / SP-API. Письмо
            Amazon «уладим» статус не меняет. За 30 дней: «предъявлено» — по дате списания,
            остальное — по дате последнего события.
          </p>
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader
          title="Кейсы"
          count={cases.length}
          right={
            <div className="flex items-center gap-3 text-[12px]">
              <select
                className="rounded-md border border-rule bg-surface px-2 py-1 text-[12px] text-ink"
                value={store}
                onChange={(e) => setStore(e.target.value)}
              >
                <option value="all">Оба аккаунта</option>
                {board.accounts.map((a) => (
                  <option key={a.storeId} value={a.storeId}>
                    {a.name}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-1 text-ink-2">
                <input
                  type="checkbox"
                  checked={showClosed}
                  onChange={(e) => setShowClosed(e.target.checked)}
                />
                закрытые ({closedCount})
              </label>
            </div>
          }
        />
        <PanelBody className="overflow-x-auto p-0">
          {cases.length === 0 ? (
            <p className="px-4 py-3 text-[12.5px] text-ink-3">Открытых кейсов нет.</p>
          ) : (
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-b border-rule text-left text-[11px] text-ink-3">
                  <th className="px-4 py-2 font-normal">Кейс</th>
                  <th className="py-2 font-normal">Аккаунт</th>
                  <th className="py-2 font-normal">Статус</th>
                  <th className="py-2 text-right font-normal">Сумма</th>
                  <th className="py-2 text-right font-normal">Вернули</th>
                  <th className="py-2 pl-3 font-normal">Перевозчик</th>
                  <th className="py-2 font-normal">Строки</th>
                  <th className="py-2 pr-4 font-normal">Следующее действие</th>
                </tr>
              </thead>
              <tbody>
                {cases.map((c) => {
                  const overdue = c.nextActionDate != null && c.nextActionDate <= board.today;
                  return (
                    <tr key={c.key} className="border-b border-rule/40 align-top">
                      <td className="px-4 py-2 font-mono text-ink">
                        {c.caseId ?? "к подаче"}
                        {c.openedAt && (
                          <div className="font-sans text-[11px] text-ink-3">с {ruDate(c.openedAt)}</div>
                        )}
                      </td>
                      <td className="py-2 text-ink-2">{c.account}</td>
                      <td className="py-2">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[11.5px] ${CASE_TONE[c.status] ?? "bg-surface-tint"}`}
                        >
                          {c.statusLabel}
                        </span>
                      </td>
                      <td className="py-2 text-right tabular">{usd(c.amount)}</td>
                      <td className="py-2 text-right tabular text-green-ink">
                        {c.recovered > 0 ? usd(c.recovered) : "—"}
                      </td>
                      <td className="py-2 pl-3 text-ink-2">{c.carriers.join(", ") || "—"}</td>
                      <td className="py-2 text-[11.5px] text-ink-2">
                        {c.breakdown
                          .map((b) => `${b.count} ${ROW_STATUS_LABEL[b.status] ?? b.status}`)
                          .join(" · ")}
                      </td>
                      <td className="py-2 pr-4">
                        {c.nextActionDate ? (
                          <span className={overdue ? "text-danger" : "text-ink"}>
                            <span className="tabular">{ruDate(c.nextActionDate)}</span> — {c.nextAction}
                          </span>
                        ) : (
                          <span className="text-ink-3">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader title="Здоровье крон" />
        <PanelBody className="overflow-x-auto p-0">
          <table className="w-full text-[12.5px]">
            <thead>
              <tr className="border-b border-rule text-left text-[11px] text-ink-3">
                <th className="px-4 py-2 font-normal">Задача</th>
                <th className="py-2 font-normal">Где</th>
                <th className="py-2 font-normal">Последний запуск</th>
                <th className="py-2 font-normal">Итог</th>
                <th className="py-2 pr-4 font-normal">Следующий запуск</th>
              </tr>
            </thead>
            <tbody>
              {board.crons.map((c) => (
                <tr key={c.job} className={`border-b border-rule/40 ${c.stale ? "bg-danger-tint" : ""}`}>
                  <td className="px-4 py-2 text-ink">
                    {c.label}
                    <div className="text-[11px] text-ink-3">{c.schedule}</div>
                  </td>
                  <td className="py-2 text-ink-2">{c.where}</td>
                  <td className="py-2 tabular text-ink-2">{ruDateTime(c.lastStartedAt)}</td>
                  <td className="py-2">
                    {c.lastStatus === "done" ? (
                      <span className="inline-flex items-center gap-1 text-green-ink">
                        <CheckCircle2 size={13} /> успех
                      </span>
                    ) : c.lastStatus === "error" ? (
                      <span className="text-danger" title={c.lastError ?? ""}>
                        ошибка{c.lastError ? `: ${c.lastError.slice(0, 80)}` : ""}
                      </span>
                    ) : c.lastStatus ? (
                      <span className="text-ink-3">{c.lastStatus}</span>
                    ) : (
                      <span className="text-danger">не запускался</span>
                    )}
                    {c.stale && <div className="text-[11px] text-danger">успеха не было больше суток</div>}
                  </td>
                  <td className="py-2 pr-4 tabular text-ink-2">{ruDateTime(c.nextRunAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </PanelBody>
      </Panel>
    </div>
  );
}
