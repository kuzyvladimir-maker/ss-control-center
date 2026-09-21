/**
 * История урегулирования по списанию.
 *
 *   GET  /api/adjustments/dispute-events?adjustmentId=…   — вся переписка по строке
 *   GET  /api/adjustments/dispute-events?caseId=…         — всё, что подавали в этот кейс
 *   POST /api/adjustments/dispute-events                  — добавить событие
 *
 * POST ничего никуда не отправляет — это журнал того, что произошло, а не
 * подача обращения. Подаёт человек, здесь только запись факта.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  addDisputeEvent,
  isDisputeEventType,
  DISPUTE_EVENT_TYPES,
} from "@/lib/adjustments/dispute-history";

export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const adjustmentId = sp.get("adjustmentId");
  const caseId = sp.get("caseId");

  if (!adjustmentId && !caseId) {
    return NextResponse.json(
      { error: "нужен adjustmentId или caseId" },
      { status: 400 }
    );
  }

  const events = await prisma.adjustmentDisputeEvent.findMany({
    where: adjustmentId ? { adjustmentId } : { caseId: caseId! },
    orderBy: [{ eventDate: "asc" }, { eventAt: "asc" }],
  });

  return NextResponse.json({ events, count: events.length });
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "нужен JSON в теле" }, { status: 400 });
  }

  const adjustmentId = typeof body.adjustmentId === "string" ? body.adjustmentId : null;
  const eventType = typeof body.eventType === "string" ? body.eventType : null;

  if (!adjustmentId || !eventType) {
    return NextResponse.json(
      { error: "нужны adjustmentId и eventType" },
      { status: 400 }
    );
  }
  if (!isDisputeEventType(eventType)) {
    return NextResponse.json(
      { error: `eventType должен быть одним из: ${DISPUTE_EVENT_TYPES.join(", ")}` },
      { status: 400 }
    );
  }

  const row = await prisma.shippingAdjustment.findUnique({
    where: { id: adjustmentId },
    select: { id: true, storeId: true, adjustmentAmount: true },
  });
  if (!row) {
    return NextResponse.json({ error: "списание не найдено" }, { status: 404 });
  }

  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;

  const event = await addDisputeEvent({
    adjustmentId,
    eventType,
    eventDate: typeof body.eventDate === "string" ? body.eventDate : undefined,
    eventAt: typeof body.eventAt === "string" ? new Date(body.eventAt) : undefined,
    caseId: typeof body.caseId === "string" ? body.caseId : null,
    // Аккаунт по умолчанию берём со строки: кейс подаётся из кабинета того
    // юрлица, на которое упало списание, смешивать аккаунты нельзя.
    storeId: typeof body.storeId === "string" ? body.storeId : row.storeId,
    amountInDispute: num(body.amountInDispute) ?? Math.abs(row.adjustmentAmount),
    amountRefunded: num(body.amountRefunded),
    summary: typeof body.summary === "string" ? body.summary : null,
    sourceType: typeof body.sourceType === "string" ? body.sourceType : "MANUAL",
    sourceRef: typeof body.sourceRef === "string" ? body.sourceRef : null,
  });

  return NextResponse.json({ ok: true, event });
}
