/**
 * Автосоставление споров: из реестра модуля в очередь «готов к подаче».
 *
 * Берёт строки в статусе DRAFT (черновик заводит детектор по STRONG/CHECK),
 * определяет тип случая по геометрии, подбирает довод по доле успеха
 * решённых кейсов (dispute-learning.ts) и собирает текст обращения по
 * шаблону выигравшего кейса 22167316661: одна пачка = один аккаунт + один тип.
 *
 * 🔴 Модуль только готовит текст. Подаёт живая сессия со своего VPS из
 * своего кабинета; номер кейса после подачи пишется событием FILED.
 * В тексте одного аккаунта нет ни номеров кейсов, ни заказов другого —
 * пачки строятся внутри storeId, прецедент берётся только свой.
 */
import { prisma } from "@/lib/prisma";
import { BOARD_ACCOUNTS, BOARD_STORE_IDS } from "@/lib/adjustments/dispute-board";
import { STORE_ORIGINS } from "@/lib/adjustments/submission-origin";
import {
  ARGUMENTS,
  buildOutcomeTable,
  chooseArgument,
  detectPattern,
  dimWeight,
  type ArgumentChoice,
  type LearningRow,
  type Measure,
  type OutcomeCell,
  type Pattern,
} from "@/lib/adjustments/dispute-learning";
import { APPEND_CASE_BY_STORE, PRECEDENT_BY_STORE } from "@/lib/adjustments/playbook";

/** Сколько символов влезает в одно сообщение чата Amazon (проверено 01.10: ~1200 даёт «Too many characters»). */
const CHAT_CHUNK = 1000;
/** Кейс, по которому Amazon ответил больше 5 дней назад, не переоткрывается. */
const REOPEN_DAYS = 5;

const CASE_EMAIL: Record<string, string> = {
  store1: "amazon@salutem.solutions",
  store3: "amz.commerce@salutem.solutions",
};
const STORE_KEY: Record<string, string> = { store1: "salutem", store3: "amzcommerce" };

export interface ComposedRow {
  id: string;
  orderId: string | null;
  tracking: string | null;
  carrier: string | null;
  date: string;
  amount: number;
  declared: string;
  audited: string;
  /** Объёмный вес аудированных габаритов (Д×Ш×В/139), фунты */
  dimWeightAudited: number | null;
  enteredWeight: number | null;
  auditedWeight: number | null;
  pattern: Pattern;
}

export interface ComposedDispute {
  key: string;
  storeId: string;
  account: string;
  vps: string;
  caseEmail: string;
  pattern: Pattern;
  patternLabel: string;
  carrier: string;
  choice: ArgumentChoice;
  rows: ComposedRow[];
  amount: number;
  /** Куда подавать: дописать в открытый кейс или новый */
  target: { mode: "append" | "new"; caseId: string | null; reason: string };
  subject: string;
  text: string;
  /** Тот же текст, нарезанный под чат */
  chatChunks: string[];
  referenceNumbers: string;
  checklist: string[];
  markCommand: string;
}

export interface AuditGap {
  storeId: string;
  account: string;
  count: number;
  amount: number;
  command: string;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

function fmtNum(n: number) {
  return Number.isInteger(n) ? String(n) : String(r2(n));
}
function fmtMeasure(m: Measure) {
  if (!m.dims) return "?";
  return `${m.dims.map(fmtNum).join("x")} in${m.weight != null ? `, ${fmtNum(m.weight)} lb` : ""}`;
}
function measureOf(
  l: number | null,
  w: number | null,
  h: number | null,
  weight: number | null,
  unit: string | null
): Measure {
  const dims = l != null && w != null && h != null ? ([l, w, h] as [number, number, number]) : null;
  let wt = weight;
  if (wt != null && (unit ?? "LB").toUpperCase() === "OZ") wt = r2(wt / 16);
  if (wt != null && (unit ?? "LB").toUpperCase() === "KG") wt = r2(wt * 2.20462);
  return { dims, weight: wt };
}

function chunk(text: string, size: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const para of text.split("\n")) {
    const line = para + "\n";
    if (cur.length + line.length > size && cur) {
      out.push(cur.trimEnd());
      cur = "";
    }
    if (line.length > size) {
      // длинный абзац режем по предложениям
      for (const s of line.split(/(?<=\. )/)) {
        if (cur.length + s.length > size && cur) {
          out.push(cur.trimEnd());
          cur = "";
        }
        cur += s;
      }
    } else cur += line;
  }
  if (cur.trim()) out.push(cur.trimEnd());
  return out;
}

const SELECT = {
  id: true,
  storeId: true,
  adjustmentDate: true,
  adjustmentAmount: true,
  amazonOrderId: true,
  trackingNumber: true,
  carrier: true,
  disputeClass: true,
  disputeStatus: true,
  disputeCaseId: true,
  amountRecovered: true,
  enteredDimL: true,
  enteredDimW: true,
  enteredDimH: true,
  enteredWeight: true,
  enteredWeightUnit: true,
  auditedDimL: true,
  auditedDimW: true,
  auditedDimH: true,
  auditedWeight: true,
  auditedWeightUnit: true,
  auditSource: true,
} as const;

type Row = {
  id: string;
  storeId: string | null;
  adjustmentDate: string;
  adjustmentAmount: number;
  amazonOrderId: string | null;
  trackingNumber: string | null;
  carrier: string | null;
  disputeClass: string | null;
  disputeStatus: string | null;
  disputeCaseId: string | null;
  amountRecovered: number | null;
  enteredDimL: number | null;
  enteredDimW: number | null;
  enteredDimH: number | null;
  enteredWeight: number | null;
  enteredWeightUnit: string | null;
  auditedDimL: number | null;
  auditedDimW: number | null;
  auditedDimH: number | null;
  auditedWeight: number | null;
  auditedWeightUnit: string | null;
  auditSource: string | null;
};

function rowMeasures(r: Row) {
  const entered = measureOf(r.enteredDimL, r.enteredDimW, r.enteredDimH, r.enteredWeight, r.enteredWeightUnit);
  // UPS Track API — манифест: такой «аудит» за аудит не считаем.
  const audited =
    r.auditSource === "UPS_API_MANIFEST_UNRELIABLE"
      ? { dims: null, weight: null }
      : measureOf(r.auditedDimL, r.auditedDimW, r.auditedDimH, r.auditedWeight, r.auditedWeightUnit);
  return { entered, audited };
}

export function patternOfRow(r: Row): Pattern {
  const { entered, audited } = rowMeasures(r);
  return detectPattern({ entered, audited, carrier: r.carrier, cls: r.disputeClass });
}

function compose(
  storeId: string,
  pattern: Pattern,
  carrier: string,
  rows: ComposedRow[],
  choice: ArgumentChoice,
  target: ComposedDispute["target"]
): Pick<ComposedDispute, "subject" | "text" | "chatChunks" | "referenceNumbers"> {
  const spec = ARGUMENTS[pattern];
  const total = r2(rows.reduce((s, r) => s + r.amount, 0));
  const carrierName = carrier === "FEDEX" ? "FedEx" : carrier === "UPS" ? "UPS" : carrier;
  const n = rows.length;
  const subject =
    pattern === "SINGLE_AXIS_SCAN_ERROR"
      ? `${carrierName} dimension-scan error on Buy Shipping labels – ${n} shipment${n > 1 ? "s" : ""}, $${total.toFixed(2)}`
      : `${carrierName} carrier adjustment review on Buy Shipping labels – ${n} shipment${n > 1 ? "s" : ""}, $${total.toFixed(2)}`;

  const lines = rows.map(
    (r) =>
      `Order ${r.orderId ?? "?"} | Tracking ${r.tracking ?? "?"} | Declared ${r.declared} | ${carrierName} audited ${r.audited}` +
      (pattern === "SINGLE_AXIS_SCAN_ERROR" && r.dimWeightAudited != null
        ? ` | dimensional weight of these dimensions ≈ ${r.dimWeightAudited} lb`
        : "") +
      ` | Charge $${r.amount.toFixed(2)}`
  );

  const parts: string[] = [];
  if (target.mode === "append" && target.caseId) {
    parts.push(
      `Please add the following ${n} shipment${n > 1 ? "s" : ""} to case ${target.caseId}: the same pattern as the shipments already under review in this case.`
    );
  } else {
    parts.push(`Subject: ${subject}`);
  }
  parts.push("");
  parts.push(
    `The following ${carrierName} shipment${n > 1 ? "s were" : " was"} purchased through Amazon Buy Shipping and later charged a carrier adjustment:`
  );
  parts.push(...lines);
  parts.push(`Total: $${total.toFixed(2)}.`);
  parts.push("");
  parts.push(spec.claim);
  if (
    pattern === "SINGLE_AXIS_SCAN_ERROR" &&
    rows.every((r) => r.auditedWeight != null && r.enteredWeight != null && r.auditedWeight <= r.enteredWeight)
  ) {
    parts.push("The carrier's recorded weight is equal to or lower than the declared weight in every shipment listed.");
  }
  const precedent = PRECEDENT_BY_STORE[storeId];
  if (precedent && pattern === "SINGLE_AXIS_SCAN_ERROR" && target.caseId !== precedent.caseId) {
    parts.push(
      `This is the same pattern as in our case ${precedent.caseId}, where ${precedent.note}.`
    );
  }
  parts.push("");
  parts.push(spec.ask);
  parts.push(
    "The Transaction Details record (declared vs carrier audited dimensions and weight) for each order is available in Payments > Transaction View; we can attach screenshots and a CSV of all listed transactions."
  );
  const text = parts.join("\n");
  return {
    subject,
    text,
    chatChunks: chunk(text, CHAT_CHUNK),
    referenceNumbers: rows
      .map((r) => [r.orderId, r.tracking].filter(Boolean).join(" "))
      .join(", "),
  };
}

/** Строки реестра → обучение. Общая выборка для дашборда и составителя. */
export async function loadLearning() {
  const rows = (await prisma.shippingAdjustment.findMany({
    where: {
      channel: "Amazon",
      storeId: { in: BOARD_STORE_IDS },
      adjustmentAmount: { lt: 0 },
      disputeStatus: { notIn: ["NONE", "DRAFT"] },
    },
    select: SELECT,
  })) as Row[];
  const learningRows: LearningRow[] = rows.map((r) => ({
    pattern: patternOfRow(r),
    carrier: r.carrier,
    status: r.disputeStatus,
    amount: Math.abs(r.adjustmentAmount),
    recovered: r.amountRecovered ?? 0,
  }));
  return { table: buildOutcomeTable(learningRows), rows };
}

export async function buildDisputeQueue(table?: OutcomeCell[]) {
  const outcome = table ?? (await loadLearning()).table;
  const drafts = (await prisma.shippingAdjustment.findMany({
    where: {
      channel: "Amazon",
      storeId: { in: BOARD_STORE_IDS },
      adjustmentAmount: { lt: 0 },
      disputeStatus: "DRAFT",
    },
    select: SELECT,
    orderBy: { adjustmentDate: "asc" },
  })) as Row[];

  // Последнее событие по каждому кейсу дописывания — нельзя дописывать в кейс,
  // по которому ответ был больше REOPEN_DAYS назад.
  const appendInfo = new Map<string, string | null>();
  for (const sid of BOARD_STORE_IDS) {
    const a = APPEND_CASE_BY_STORE[sid];
    if (!a) continue;
    const last = await prisma.adjustmentDisputeEvent.findFirst({
      where: { caseId: a.caseId, storeId: sid },
      orderBy: { eventDate: "desc" },
      select: { eventDate: true },
    });
    appendInfo.set(sid, last?.eventDate ?? null);
  }

  const groups = new Map<string, { storeId: string; pattern: Pattern; carrier: string; rows: ComposedRow[] }>();
  for (const r of drafts) {
    const storeId = r.storeId!;
    const pattern = patternOfRow(r);
    const carrier = (r.carrier ?? "—").toUpperCase();
    const { entered, audited } = rowMeasures(r);
    const key = `${storeId}|${pattern}|${carrier}`;
    let g = groups.get(key);
    if (!g) {
      g = { storeId, pattern, carrier, rows: [] };
      groups.set(key, g);
    }
    g.rows.push({
      id: r.id,
      orderId: r.amazonOrderId,
      tracking: r.trackingNumber,
      carrier: r.carrier,
      date: r.adjustmentDate,
      amount: Math.abs(r.adjustmentAmount),
      declared: fmtMeasure(entered),
      audited: audited.dims ? `${audited.dims.map(fmtNum).join("x")} in` : "?",
      dimWeightAudited: audited.dims ? dimWeight(audited.dims) : null,
      enteredWeight: entered.weight,
      auditedWeight: audited.weight,
      pattern,
    });
  }

  const today = new Date().toISOString().slice(0, 10);
  const ready: ComposedDispute[] = [];
  for (const [key, g] of groups) {
    const origin = STORE_ORIGINS[g.storeId];
    if (!origin || origin.blocked) continue;
    const choice = chooseArgument(g.pattern, g.carrier, outcome);
    const append = APPEND_CASE_BY_STORE[g.storeId];
    let target: ComposedDispute["target"] = {
      mode: "new",
      caseId: null,
      reason: "новый кейс: одна пачка — один тип дефекта",
    };
    if (append && append.pattern === g.pattern) {
      const last = appendInfo.get(g.storeId);
      const age = last
        ? (new Date(`${today}T12:00:00Z`).getTime() - new Date(`${last}T12:00:00Z`).getTime()) / 86400_000
        : null;
      target =
        age != null && age <= REOPEN_DAYS
          ? {
              mode: "append",
              caseId: append.caseId,
              reason: `кейс ${append.caseId} открыт, последнее событие ${last}: дописать, если оператор Amazon разрешает (иначе новый кейс)`,
            }
          : {
              mode: "new",
              caseId: null,
              reason: `по кейсу ${append.caseId} нет событий ${REOPEN_DAYS}+ дней — не переоткрывать, новый кейс`,
            };
    }
    const amount = r2(g.rows.reduce((s, r) => s + r.amount, 0));
    const composed = compose(g.storeId, g.pattern, g.carrier, g.rows, choice, target);
    const storeKey = STORE_KEY[g.storeId] ?? g.storeId;
    ready.push({
      key,
      storeId: g.storeId,
      account: BOARD_ACCOUNTS.find((a) => a.storeId === g.storeId)?.name ?? origin.account,
      vps: origin.vps,
      caseEmail: CASE_EMAIL[g.storeId] ?? "",
      pattern: g.pattern,
      patternLabel: ARGUMENTS[g.pattern].title,
      carrier: g.carrier,
      choice,
      rows: g.rows,
      amount,
      target,
      ...composed,
      checklist: [
        `VPS ${origin.vps}, кабинет «${origin.account}» в шапке Seller Central`,
        "VPS свободен (второй RDP выбивает первого)",
        "все строки пачки — этого аккаунта; чужих номеров кейсов и заказов в тексте нет",
        "Transaction Details по каждому заказу открыт и совпадает с цифрами в тексте",
        "номер кейса виден в Manage support cases — только после этого «подано»",
      ],
      markCommand: g.rows
        .map(
          (r) =>
            `python3 scripts/shipping_penalty_monitor.py mark ${storeKey} ${r.orderId ?? "?"} FILED <case_id>`
        )
        .join("\n"),
    });
  }

  const order: Record<string, number> = { FILE: 0, FILE_CAUTION: 1, NEEDS_AUDIT: 2, DO_NOT_FILE: 3 };
  ready.sort((a, b) => order[a.choice.verdict] - order[b.choice.verdict] || b.amount - a.amount);

  // Строки после отсечки без аудита: их сначала надо снять харвестером с VPS.
  const gaps: AuditGap[] = [];
  for (const acc of BOARD_ACCOUNTS) {
    const agg = await prisma.shippingAdjustment.aggregate({
      where: {
        channel: "Amazon",
        storeId: acc.storeId,
        adjustmentAmount: { lt: 0 },
        adjustmentDate: { gt: acc.cutoff },
        disputeStatus: "NONE",
        auditedDimL: null,
      },
      _count: { _all: true },
      _sum: { adjustmentAmount: true },
    });
    gaps.push({
      storeId: acc.storeId,
      account: acc.name,
      count: agg._count._all,
      amount: r2(Math.abs(agg._sum.adjustmentAmount ?? 0)),
      command: `python3 scripts/shipping_penalty_monitor.py harvester ${STORE_KEY[acc.storeId]}  # выполнить в Chrome на VPS ${STORE_ORIGINS[acc.storeId]?.vps}`,
    });
  }

  return { ready, gaps };
}
