/**
 * История урегулирования: добавление события и пересчёт сводки на строке.
 *
 * Статус спора нигде не вводится руками — он всегда производная от последнего
 * события. Иначе строка в реестре и переписка расходятся, а по трём поданным
 * кейсам (22167316661, 22167069131, 22167699051) видно, что события приходят
 * вразнобой: отказ по одному кейсу может прийти раньше, чем инструкция по
 * другому, поданному днём раньше.
 */
import { prisma } from "@/lib/prisma";

export const DISPUTE_EVENT_TYPES = [
  "FILED",
  "CLARIFICATION",
  "AMAZON_REPLY",
  "REJECTED",
  "PARTIAL_REFUND",
  "REFUND",
  "ESCALATED",
  "CLOSED",
  "NOTE",
] as const;

export type DisputeEventType = (typeof DISPUTE_EVENT_TYPES)[number];

export const DISPUTE_EVENT_LABEL: Record<DisputeEventType, string> = {
  FILED: "Подано",
  CLARIFICATION: "Уточнение",
  AMAZON_REPLY: "Ответ Amazon",
  REJECTED: "Отказ",
  PARTIAL_REFUND: "Частичный возврат",
  REFUND: "Возврат",
  ESCALATED: "Эскалация",
  CLOSED: "Закрыто",
  NOTE: "Пометка",
};

export type DisputeStatus =
  | "NONE"
  | "FILED"
  | "AWAITING"
  | "REJECTED"
  | "PARTIAL"
  | "REFUNDED"
  | "ESCALATED"
  | "CLOSED";

export const DISPUTE_STATUS_LABEL: Record<DisputeStatus, string> = {
  NONE: "Не подавали",
  FILED: "Подано",
  AWAITING: "Ждём ответа",
  REJECTED: "Отказ",
  PARTIAL: "Вернули часть",
  REFUNDED: "Вернули",
  ESCALATED: "Эскалация",
  CLOSED: "Закрыто",
};

/** Событие → статус, в котором оказывается спор после него. */
const STATUS_AFTER: Record<DisputeEventType, DisputeStatus> = {
  FILED: "FILED",
  CLARIFICATION: "AWAITING",
  AMAZON_REPLY: "AWAITING",
  REJECTED: "REJECTED",
  PARTIAL_REFUND: "PARTIAL",
  REFUND: "REFUNDED",
  ESCALATED: "ESCALATED",
  CLOSED: "CLOSED",
  NOTE: "NONE", // пометка статус не двигает — берём предыдущее значимое событие
};

export function isDisputeEventType(v: string): v is DisputeEventType {
  return (DISPUTE_EVENT_TYPES as readonly string[]).includes(v);
}

interface EventLike {
  eventType: string;
  eventDate: string;
  eventAt: Date;
  caseId: string | null;
  amountRefunded: number | null;
}

/** Хронологический порядок: сперва дата события, при равенстве — метка времени. */
function chronological(a: EventLike, b: EventLike): number {
  const byDate = a.eventDate.localeCompare(b.eventDate);
  if (byDate !== 0) return byDate;
  return a.eventAt.getTime() - b.eventAt.getTime();
}

export function summarizeEvents(events: EventLike[]): {
  disputeStatus: DisputeStatus;
  amountRecovered: number;
  lastDisputeEventAt: Date | null;
  disputeCaseId: string | null;
} {
  if (events.length === 0) {
    return {
      disputeStatus: "NONE",
      amountRecovered: 0,
      lastDisputeEventAt: null,
      disputeCaseId: null,
    };
  }
  const sorted = [...events].sort(chronological);
  const last = sorted[sorted.length - 1];

  // NOTE статус не двигает: ищем последнее событие, которое его двигает.
  let status: DisputeStatus = "NONE";
  for (const e of sorted) {
    if (!isDisputeEventType(e.eventType)) continue;
    const next = STATUS_AFTER[e.eventType];
    if (e.eventType === "NOTE") continue;
    status = next;
  }

  const amountRecovered = sorted.reduce((s, e) => s + (e.amountRefunded ?? 0), 0);
  const caseId = [...sorted].reverse().find((e) => e.caseId)?.caseId ?? null;

  return {
    disputeStatus: status,
    amountRecovered: Math.round(amountRecovered * 100) / 100,
    lastDisputeEventAt: last.eventAt,
    disputeCaseId: caseId,
  };
}

/** Пересчитывает сводку спора на строке списания по её событиям. */
export async function refreshDisputeSummary(adjustmentId: string) {
  const events = await prisma.adjustmentDisputeEvent.findMany({
    where: { adjustmentId },
    select: {
      eventType: true,
      eventDate: true,
      eventAt: true,
      caseId: true,
      amountRefunded: true,
    },
  });
  const summary = summarizeEvents(events);
  await prisma.shippingAdjustment.update({
    where: { id: adjustmentId },
    data: {
      disputeStatus: summary.disputeStatus,
      amountRecovered: summary.amountRecovered,
      lastDisputeEventAt: summary.lastDisputeEventAt,
      // disputeCaseId держим в согласии с историей, но не затираем вручную
      // вбитый номер, если событий с кейсом ещё нет.
      ...(summary.disputeCaseId ? { disputeCaseId: summary.disputeCaseId } : {}),
      ...(summary.disputeStatus !== "NONE" ? { disputedAt: summary.lastDisputeEventAt } : {}),
    },
  });
  return summary;
}

export interface NewDisputeEvent {
  adjustmentId: string;
  eventDate?: string;
  eventAt?: Date;
  eventType: DisputeEventType;
  caseId?: string | null;
  storeId?: string | null;
  amountInDispute?: number | null;
  amountRefunded?: number | null;
  summary?: string | null;
  sourceType?: string | null;
  sourceRef?: string | null;
}

export async function addDisputeEvent(input: NewDisputeEvent) {
  const eventAt = input.eventAt ?? new Date();
  const eventDate = input.eventDate ?? eventAt.toISOString().slice(0, 10);
  const event = await prisma.adjustmentDisputeEvent.create({
    data: {
      adjustmentId: input.adjustmentId,
      eventDate,
      eventAt,
      eventType: input.eventType,
      caseId: input.caseId ?? null,
      storeId: input.storeId ?? null,
      amountInDispute: input.amountInDispute ?? null,
      amountRefunded: input.amountRefunded ?? null,
      summary: input.summary ?? null,
      sourceType: input.sourceType ?? null,
      sourceRef: input.sourceRef ?? null,
    },
  });
  await refreshDisputeSummary(input.adjustmentId);
  return event;
}
