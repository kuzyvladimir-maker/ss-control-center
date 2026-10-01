/**
 * Приём реестра споров, новых штрафов и кредитов с сервера в модуль.
 *
 * Сайт живёт на Vercel и файлов сервера не видит, поэтому серверный мост
 * (scripts/adjustments_registry_push.py в workspace Джеки) шлёт сюда:
 *   cases     — строки queue.csv: заказ, кейс, статус подачи;
 *   penalties — новые штрафы детектора (SP-API v2024-06-19) с классом;
 *   credits   — кредиты MiscAdjustment, привязанные к заказу по сумме;
 *   runs      — heartbeat кронов для блока «Здоровье крон».
 *
 * Всё идемпотентно: у каждого импортного события свой sourceRef, повторная
 * отправка того же файла ничего не дублирует.
 *
 * 🔴 Один вызов = один аккаунт. Строка ищется только внутри storeId вызова —
 * перепутать кабинеты в истории спора здесь нельзя по построению.
 */
import { prisma } from "@/lib/prisma";
import { addDisputeEvent, type DisputeEventType } from "@/lib/adjustments/dispute-history";
import { BOARD_STORE_IDS } from "@/lib/adjustments/dispute-board";
import { originFor } from "@/lib/adjustments/submission-origin";

export interface SyncCase {
  orderId: string;
  amount: number; // USD, положительное — сумма списания
  caseId: string; // "22198660051;22356228091" — подача и повторная подача
  status: string; // как в queue.csv: CREDITED_0929_…, DENIED_FINAL, SUBMITTED…
  carrier?: string | null;
  tracking?: string | null;
  vps?: string | null;
  filedDate?: string | null; // YYYY-MM-DD — дата подачи кейса
  summary?: string | null;
}

export interface SyncPenalty {
  transactionId: string;
  orderId?: string | null;
  date: string; // YYYY-MM-DD, ET
  amount: number; // USD, положительное
  carrier?: string | null;
  tracking?: string | null;
  cls?: string | null;
  disputable?: string | null; // STRONG | CHECK | WEAK | NO | UNKNOWN
  reason?: string | null;
}

export interface SyncCredit {
  transactionId: string;
  date: string; // YYYY-MM-DD, ET
  amount: number; // USD, положительное
  orderId?: string | null;
  kind?: string | null; // MiscAdjustment | PostageRefund_PostageAdjustment
}

export interface SyncRun {
  job: string; // penalty-monitor | registry-sync
  startedAt: string;
  finishedAt?: string | null;
  ok: boolean;
  error?: string | null;
  items?: number;
}

export interface RegistrySyncInput {
  store: string;
  cases?: SyncCase[];
  penalties?: SyncPenalty[];
  credits?: SyncCredit[];
  runs?: SyncRun[];
}

/** Классы детектора, по которым сразу готовим черновик спора. */
const DRAFT_GRADES = new Set(["STRONG", "CHECK"]);

/** Статус очереди → события истории (кроме возврата: он только из credits). */
function eventsForQueueStatus(status: string): DisputeEventType[] {
  const s = status.toUpperCase();
  if (s.startsWith("REJECTED") || s.startsWith("DENIED")) return ["FILED", "REJECTED"];
  if (s.startsWith("REREVIEW") || s.startsWith("REFILED")) return ["FILED", "ESCALATED"];
  if (s.startsWith("INTERNAL_REVIEW") || s.startsWith("PENDING")) return ["FILED", "AMAZON_REVIEW"];
  if (s.startsWith("CLOSED")) return ["FILED", "CLOSED"];
  // SUBMITTED, FILED, ADDED_TO_…, CREDITED_… — кейс подан; возврат придёт из credits.
  return ["FILED"];
}

/** «…_0929_…» / «…_1001» в статусе очереди → дата события. */
function dateFromStatus(status: string, year: number): string | null {
  const m = status.match(/_(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?:_|$)/);
  return m ? `${year}-${m[1]}-${m[2]}` : null;
}

function near(a: number, b: number) {
  return Math.abs(Math.abs(a) - Math.abs(b)) < 0.005;
}

function dayDiff(a: string, b: string) {
  return Math.abs(new Date(`${a}T12:00:00Z`).getTime() - new Date(`${b}T12:00:00Z`).getTime()) / 86400_000;
}

/** Ищет списание в пределах одного аккаунта: по заказу и сумме, иначе по дате и сумме без заказа. */
async function findCharge(storeId: string, amount: number, orderId?: string | null, date?: string | null) {
  if (orderId) {
    const byOrder = await prisma.shippingAdjustment.findMany({
      where: { storeId, channel: "Amazon", amazonOrderId: orderId, adjustmentAmount: { lt: 0 } },
      select: { id: true, adjustmentAmount: true, amazonOrderId: true, carrier: true, trackingNumber: true },
    });
    const exact = byOrder.find((r) => near(r.adjustmentAmount, amount));
    if (exact) return exact;
  }
  if (date) {
    const cents = Math.round(Math.abs(amount) * 100);
    const candidates = await prisma.shippingAdjustment.findMany({
      where: {
        storeId,
        channel: "Amazon",
        amazonOrderId: null,
        adjustmentAmount: { gte: -(cents + 0.5) / 100, lte: -(cents - 0.5) / 100 },
      },
      select: {
        id: true,
        adjustmentAmount: true,
        amazonOrderId: true,
        carrier: true,
        trackingNumber: true,
        adjustmentDate: true,
      },
    });
    const sameDay = candidates.filter((r) => dayDiff(r.adjustmentDate, date) <= 1);
    if (sameDay.length === 1) return sameDay[0];
  }
  return null;
}

async function hasEvent(adjustmentId: string, sourceRef: string) {
  const e = await prisma.adjustmentDisputeEvent.findFirst({
    where: { adjustmentId, sourceRef },
    select: { id: true },
  });
  return e != null;
}

async function enrich(
  row: { id: string; amazonOrderId: string | null; carrier: string | null; trackingNumber: string | null },
  data: { orderId?: string | null; carrier?: string | null; tracking?: string | null }
) {
  const patch: Record<string, string> = {};
  if (!row.amazonOrderId && data.orderId) {
    patch.amazonOrderId = data.orderId;
    patch.orderId = data.orderId;
  }
  if (!row.carrier && data.carrier) patch.carrier = data.carrier.toUpperCase();
  if (!row.trackingNumber && data.tracking) patch.trackingNumber = data.tracking;
  if (Object.keys(patch).length) {
    await prisma.shippingAdjustment.update({ where: { id: row.id }, data: patch });
  }
}

export async function registrySync(input: RegistrySyncInput) {
  const storeId = input.store;
  if (!BOARD_STORE_IDS.includes(storeId)) {
    throw new Error(`аккаунт ${storeId} не ведётся в модуле споров`);
  }
  const origin = originFor(storeId);
  if (!origin || origin.blocked) throw new Error(`аккаунт ${storeId}: подача запрещена`);

  const report = {
    store: storeId,
    cases: { rows: 0, matched: 0, events: 0, unmatched: [] as string[], errors: [] as string[] },
    penalties: { rows: 0, matched: 0, drafts: 0, enriched: 0, unmatched: [] as string[] },
    credits: { rows: 0, events: 0, skipped: 0, unmatched: [] as string[] },
    runs: 0,
  };
  const year = new Date().getUTCFullYear();

  // --- Кейсы из очереди --------------------------------------------------
  for (const c of input.cases ?? []) {
    report.cases.rows++;
    const row = await findCharge(storeId, c.amount, c.orderId, null);
    if (!row) {
      report.cases.unmatched.push(`${c.orderId} $${c.amount}`);
      continue;
    }
    report.cases.matched++;
    await enrich(row, { orderId: c.orderId, carrier: c.carrier, tracking: c.tracking });

    if (c.vps && c.vps !== origin.vps) {
      report.cases.errors.push(`${c.orderId}: VPS ${c.vps} не совпадает с ${origin.vps} — строку не импортирую`);
      continue;
    }
    const caseIds = c.caseId.split(/[;,\s]+/).filter(Boolean);
    const firstCase = caseIds[0] ?? null;
    const lastCase = caseIds[caseIds.length - 1] ?? null;
    const filedDate = c.filedDate ?? null;
    // Дата из статуса не может быть раньше подачи («_0101_» в статусе — не 1 января):
    // иначе отказ встанет в историю до подачи и статус строки останется «Открыт».
    const parsed = dateFromStatus(c.status, year);
    const statusDate = parsed && (!filedDate || parsed >= filedDate) ? parsed : filedDate;

    for (const type of eventsForQueueStatus(c.status)) {
      const caseId = type === "FILED" ? firstCase : lastCase;
      const ref = `queue:${caseId}:${type}:${c.orderId}`;
      if (await hasEvent(row.id, ref)) continue;
      try {
        await addDisputeEvent({
          adjustmentId: row.id,
          eventType: type,
          eventDate: (type === "FILED" ? filedDate : statusDate) ?? undefined,
          caseId,
          storeId,
          submittedFromStore: storeId,
          submittedFromVps: origin.vps,
          amountInDispute: Math.abs(c.amount),
          summary: type === "FILED" ? c.summary ?? null : `статус очереди: ${c.status}`,
          sourceType: "IMPORT",
          sourceRef: ref,
        });
        report.cases.events++;
      } catch (err) {
        report.cases.errors.push(`${c.orderId} ${type}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // --- Новые штрафы детектора ------------------------------------------
  for (const p of input.penalties ?? []) {
    report.penalties.rows++;
    const row = await findCharge(storeId, p.amount, p.orderId, p.date);
    if (!row) {
      report.penalties.unmatched.push(`${p.orderId ?? "?"} ${p.date} $${p.amount}`);
      continue;
    }
    report.penalties.matched++;
    if (!row.amazonOrderId && p.orderId) report.penalties.enriched++;
    await enrich(row, { orderId: p.orderId, carrier: p.carrier, tracking: p.tracking });

    if (!DRAFT_GRADES.has((p.disputable ?? "").toUpperCase())) continue;
    const ref = `penalty:${p.transactionId}`;
    if (await hasEvent(row.id, ref)) continue;
    const existing = await prisma.adjustmentDisputeEvent.count({ where: { adjustmentId: row.id } });
    if (existing > 0) continue; // по строке уже идёт спор — черновик не нужен
    await addDisputeEvent({
      adjustmentId: row.id,
      eventType: "DRAFT",
      eventDate: p.date,
      storeId,
      amountInDispute: Math.abs(p.amount),
      summary: `детектор: ${p.cls ?? "?"} (${p.disputable}) — ${p.reason ?? ""}`.trim(),
      sourceType: "DETECTOR",
      sourceRef: ref,
    });
    report.penalties.drafts++;
  }

  // --- Кредиты: «выиграно» только отсюда ---------------------------------
  for (const cr of input.credits ?? []) {
    report.credits.rows++;
    // Автовозвраты перевозчика (PostageRefund) уже лежат в базе строками
    // WeightAdjustmentRefund и к спорам отношения не имеют.
    if ((cr.kind ?? "") !== "MiscAdjustment" || !cr.orderId) {
      report.credits.skipped++;
      continue;
    }
    const already = await prisma.adjustmentDisputeEvent.findFirst({
      where: { sourceRef: `credit:${cr.transactionId}` },
      select: { id: true },
    });
    if (already) continue;
    const row = await prisma.shippingAdjustment.findFirst({
      where: { storeId, channel: "Amazon", amazonOrderId: cr.orderId, adjustmentAmount: { lt: 0 } },
      orderBy: { adjustmentAmount: "asc" },
      select: { id: true, adjustmentAmount: true, disputeCaseId: true },
    });
    if (!row) {
      report.credits.unmatched.push(`${cr.orderId} $${cr.amount}`);
      continue;
    }
    const full = cr.amount + 0.05 >= Math.abs(row.adjustmentAmount);
    await addDisputeEvent({
      adjustmentId: row.id,
      eventType: full ? "REFUND" : "PARTIAL_REFUND",
      eventDate: cr.date,
      caseId: row.disputeCaseId,
      storeId,
      amountRefunded: cr.amount,
      summary: `кредит в Payments (SP-API ${cr.kind}), ${cr.date}`,
      sourceType: "SPAPI_CREDIT",
      sourceRef: `credit:${cr.transactionId}`,
    });
    report.credits.events++;
  }

  // --- Heartbeat кронов --------------------------------------------------
  for (const r of input.runs ?? []) {
    const startedAt = new Date(r.startedAt);
    if (Number.isNaN(startedAt.getTime())) continue;
    const jobName = `${r.job}:${storeId}`;
    const dup = await prisma.syncLog.findFirst({ where: { jobName, startedAt }, select: { id: true } });
    if (dup) continue;
    await prisma.syncLog.create({
      data: {
        jobName,
        startedAt,
        completedAt: r.finishedAt ? new Date(r.finishedAt) : new Date(),
        status: r.ok ? "done" : "error",
        itemsSynced: r.items ?? 0,
        error: r.ok ? null : (r.error ?? "ошибка без текста").slice(0, 1000),
      },
    });
    report.runs++;
  }

  return report;
}
