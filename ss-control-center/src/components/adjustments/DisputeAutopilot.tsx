"use client";

/**
 * Автопилот споров: очередь «готов к подаче» с готовым текстом, строки без
 * аудита, «что работает / что нет» (исходы из реестра + проверенные уроки)
 * и плейбук. Данные — /api/adjustments/autopilot.
 *
 * Подачу модуль не делает: текст копируется и подаётся из живой сессии на
 * VPS нужного аккаунта.
 */
import { useCallback, useEffect, useState } from "react";
import { Check, ChevronDown, ChevronRight, Copy, Loader2 } from "lucide-react";
import { Panel, PanelBody, PanelHeader } from "@/components/kit";

interface Bucket {
  count: number;
  amount: number;
}
interface OutcomeCell {
  pattern: string;
  patternLabel: string;
  argument: string;
  carrier: string;
  credited: Bucket;
  denied: Bucket;
  pending: Bucket;
  successRate: number | null;
}
interface ComposedRow {
  id: string;
  orderId: string | null;
  tracking: string | null;
  carrier: string | null;
  date: string;
  amount: number;
  declared: string;
  audited: string;
}
interface ComposedDispute {
  key: string;
  storeId: string;
  account: string;
  vps: string;
  caseEmail: string;
  pattern: string;
  patternLabel: string;
  carrier: string;
  choice: {
    verdict: "FILE" | "FILE_CAUTION" | "DO_NOT_FILE" | "NEEDS_AUDIT";
    why: string;
    stats: { credited: number; denied: number; pending: number; successRate: number | null };
  };
  rows: ComposedRow[];
  amount: number;
  target: { mode: "append" | "new"; caseId: string | null; reason: string };
  subject: string;
  text: string;
  chatChunks: string[];
  referenceNumbers: string;
  checklist: string[];
  markCommand: string;
}
interface AuditGap {
  storeId: string;
  account: string;
  count: number;
  amount: number;
  command: string;
}
interface Lesson {
  text: string;
  evidence: string;
}
interface Autopilot {
  queue: { ready: ComposedDispute[]; gaps: AuditGap[] };
  outcomes: OutcomeCell[];
  playbook: Array<{ id: string; title: string; items: string[] }>;
  works: Lesson[];
  fails: Lesson[];
}

const usd = (n: number) =>
  `$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const VERDICT: Record<string, { label: string; tone: string }> = {
  FILE: { label: "Готов к подаче", tone: "bg-green-soft text-green-ink" },
  FILE_CAUTION: { label: "Подать с оговоркой", tone: "bg-warn-tint text-warn-strong" },
  DO_NOT_FILE: { label: "Не подавать", tone: "bg-danger-tint text-danger-strong" },
  NEEDS_AUDIT: { label: "Нужен замер", tone: "bg-surface-tint text-ink-2" },
};

function CopyBtn({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
      className="inline-flex items-center gap-1 rounded-md border border-rule bg-surface px-2 py-0.5 text-[11.5px] text-ink-2 hover:bg-surface-tint"
    >
      {done ? <Check size={12} /> : <Copy size={12} />} {label}
    </button>
  );
}

function DisputeCard({ d }: { d: ComposedDispute }) {
  const [open, setOpen] = useState(d.choice.verdict === "FILE");
  const v = VERDICT[d.choice.verdict];
  return (
    <div className="rounded-md border border-rule/70 bg-surface">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left text-[12.5px]"
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span className={`rounded-full px-2 py-0.5 text-[11.5px] ${v.tone}`}>{v.label}</span>
        <strong className="text-ink">{d.account}</strong>
        <span className="text-ink-2">
          {d.carrier} · {d.patternLabel}
        </span>
        <span className="tabular text-ink">
          {d.rows.length} стр. · {usd(d.amount)}
        </span>
        <span className="font-mono text-[11px] text-ink-3">VPS {d.vps}</span>
      </button>
      {open && (
        <div className="space-y-3 border-t border-rule/60 px-3 py-3 text-[12.5px]">
          <div className="text-ink-2">
            <strong className="text-ink">Почему:</strong> {d.choice.why}
          </div>
          <div className="text-ink-2">
            <strong className="text-ink">Куда:</strong>{" "}
            {d.target.mode === "append" ? `дописать в кейс ${d.target.caseId}` : "новый кейс"} —{" "}
            {d.target.reason}. Почта кейсов: <span className="font-mono">{d.caseEmail}</span>
          </div>
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-rule text-left text-[11px] text-ink-3">
                <th className="py-1 font-normal">Заказ</th>
                <th className="py-1 font-normal">Трекинг</th>
                <th className="py-1 font-normal">Заявлено</th>
                <th className="py-1 font-normal">Аудит</th>
                <th className="py-1 text-right font-normal">Сумма</th>
              </tr>
            </thead>
            <tbody>
              {d.rows.map((r) => (
                <tr key={r.id} className="border-b border-rule/30">
                  <td className="py-1 font-mono">{r.orderId ?? "?"}</td>
                  <td className="py-1 font-mono">{r.tracking ?? "?"}</td>
                  <td className="py-1">{r.declared}</td>
                  <td className="py-1">{r.audited}</td>
                  <td className="py-1 text-right tabular">{usd(r.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div>
            <div className="mb-1 flex flex-wrap items-center gap-2">
              <strong className="text-ink">Текст обращения (англ.)</strong>
              <CopyBtn text={d.text} label="весь текст" />
              <CopyBtn text={d.referenceNumbers} label="reference numbers" />
              {d.chatChunks.length > 1 &&
                d.chatChunks.map((c, i) => (
                  <CopyBtn key={i} text={c} label={`чат ${i + 1}/${d.chatChunks.length}`} />
                ))}
            </div>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-md bg-surface-tint p-2 font-mono text-[11.5px] text-ink">
              {d.text}
            </pre>
          </div>
          <div>
            <strong className="text-ink">Перед подачей:</strong>
            <ul className="ml-4 list-disc text-ink-2">
              {d.checklist.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </div>
          <div>
            <div className="mb-1 flex items-center gap-2">
              <strong className="text-ink">После подачи (номер кейса — в тот же шаг):</strong>
              <CopyBtn text={d.markCommand} label="команда" />
            </div>
            <pre className="overflow-auto rounded-md bg-surface-tint p-2 font-mono text-[11px] text-ink-2">
              {d.markCommand}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

export default function DisputeAutopilot() {
  const [data, setData] = useState<Autopilot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showPlaybook, setShowPlaybook] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/adjustments/autopilot", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
      setData(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (error && !data) {
    return (
      <div className="rounded-lg border border-danger/20 bg-danger-tint px-4 py-2.5 text-[12.5px] text-danger-strong">
        Автопилот споров не загрузился: {error}
      </div>
    );
  }
  if (!data) {
    return (
      <Panel>
        <PanelBody className="flex items-center gap-2 text-[12.5px] text-ink-3">
          <Loader2 size={14} className="animate-spin" /> Собираю очередь споров…
        </PanelBody>
      </Panel>
    );
  }

  const fileable = data.queue.ready.filter((d) => d.choice.verdict === "FILE" || d.choice.verdict === "FILE_CAUTION");

  return (
    <div className="space-y-4">
      <Panel>
        <PanelHeader title="Очередь споров — готово к подаче" count={fileable.length} />
        <PanelBody className="space-y-2">
          {data.queue.ready.length === 0 ? (
            <p className="text-[12.5px] text-ink-3">
              Черновиков нет: детектор не нашёл новых оспоримых строк (STRONG/CHECK).
            </p>
          ) : (
            data.queue.ready.map((d) => <DisputeCard key={d.key} d={d} />)
          )}
          {data.queue.gaps.some((g) => g.count > 0) && (
            <div className="rounded-md bg-surface-tint px-3 py-2 text-[12px] text-ink-2">
              <strong className="text-ink">Ждут замера с VPS</strong> (новые после отсечки, аудита нет):
              <ul className="ml-4 mt-1 list-disc">
                {data.queue.gaps
                  .filter((g) => g.count > 0)
                  .map((g) => (
                    <li key={g.storeId}>
                      {g.account}: <span className="tabular">{g.count} на {usd(g.amount)}</span> —{" "}
                      <span className="font-mono text-[11px]">{g.command}</span>
                    </li>
                  ))}
              </ul>
            </div>
          )}
          <p className="text-[11px] text-ink-3">
            Модуль готовит текст и очередь. Подаёт живая сессия из кабинета этого аккаунта и с его
            VPS; номера кейсов и заказы другого аккаунта в тексте не упоминаются.
          </p>
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader title="Что работает / что нет" />
        <PanelBody className="space-y-3">
          <div className="overflow-x-auto">
            <table className="w-full text-[12.5px]">
              <thead>
                <tr className="border-b border-rule text-left text-[11px] text-ink-3">
                  <th className="py-2 font-normal">Тип случая</th>
                  <th className="py-2 font-normal">Перевозчик</th>
                  <th className="py-2 text-right font-normal">Кредит</th>
                  <th className="py-2 text-right font-normal">Отказ</th>
                  <th className="py-2 text-right font-normal">Ждём</th>
                  <th className="py-2 pr-2 text-right font-normal">Успех</th>
                </tr>
              </thead>
              <tbody>
                {data.outcomes.map((o) => (
                  <tr key={`${o.pattern}|${o.carrier}`} className="border-b border-rule/40 align-top">
                    <td className="py-1.5 text-ink" title={o.argument}>
                      {o.patternLabel}
                    </td>
                    <td className="py-1.5 text-ink-2">{o.carrier}</td>
                    <td className="py-1.5 text-right tabular text-green-ink">
                      {o.credited.count ? `${o.credited.count} · ${usd(o.credited.amount)}` : "—"}
                    </td>
                    <td className="py-1.5 text-right tabular text-danger">
                      {o.denied.count ? `${o.denied.count} · ${usd(o.denied.amount)}` : "—"}
                    </td>
                    <td className="py-1.5 text-right tabular text-ink-2">
                      {o.pending.count ? `${o.pending.count} · ${usd(o.pending.amount)}` : "—"}
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular">
                      {o.successRate == null ? "—" : `${Math.round(o.successRate * 100)}%`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <div>
              <div className="mb-1 text-[12px] font-semibold text-green-ink">Сработало</div>
              <ul className="space-y-1.5 text-[12px]">
                {data.works.map((l) => (
                  <li key={l.text}>
                    <div className="text-ink">{l.text}</div>
                    <div className="text-[11px] text-ink-3">{l.evidence}</div>
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <div className="mb-1 text-[12px] font-semibold text-danger">Не сработало</div>
              <ul className="space-y-1.5 text-[12px]">
                {data.fails.map((l) => (
                  <li key={l.text}>
                    <div className="text-ink">{l.text}</div>
                    <div className="text-[11px] text-ink-3">{l.evidence}</div>
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <p className="text-[11px] text-ink-3">
            Таблица считается из реестра: тип случая — по геометрии «заявлено / аудит», исход — кредит
            в Payments, отказ или ждём. Новые исходы сразу меняют выбор довода для очереди выше.
          </p>
        </PanelBody>
      </Panel>

      <Panel>
        <PanelHeader
          title="Плейбук"
          right={
            <button
              type="button"
              onClick={() => setShowPlaybook((v) => !v)}
              className="text-[12px] text-ink-3 underline underline-offset-2 hover:text-ink"
            >
              {showPlaybook ? "свернуть" : "развернуть"}
            </button>
          }
        />
        {showPlaybook && (
          <PanelBody className="grid gap-4 lg:grid-cols-2">
            {data.playbook.map((s) => (
              <div key={s.id}>
                <div className="mb-1 text-[12.5px] font-semibold text-ink">{s.title}</div>
                <ul className="ml-4 list-disc space-y-1 text-[12px] text-ink-2">
                  {s.items.map((i) => (
                    <li key={i}>{i}</li>
                  ))}
                </ul>
              </div>
            ))}
          </PanelBody>
        )}
      </Panel>
    </div>
  );
}
