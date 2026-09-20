/**
 * POST /api/adjustments/measure-sync
 *
 * Дотягивает у FedEx и UPS фактический замер (вес и габариты) по трек-номерам
 * списаний и кладёт его в adjustedWeightLbs / adjustedDim*. Это доказательная
 * база для спора: Amazon причину доначисления не раскрывает, а замер перевозчика
 * показывает, был ли вообще перевес.
 *
 * Тело: { limit?: number } — сколько строк обработать за прогон (по умолчанию 200).
 * Перевозчики перестают отдавать данные по номерам старше ~3 месяцев, поэтому
 * идём от свежих к старым.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { syncMeasurements } from "@/lib/adjustments/carrier-measure";

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  let limit = 200;
  try {
    const body = await request.json();
    if (body && typeof body.limit === "number") limit = Math.min(500, Math.max(1, body.limit));
  } catch {
    // пустое тело — берём значение по умолчанию
  }

  const log = await prisma.syncLog.create({
    data: { jobName: "adjustments-carrier-measure", status: "RUNNING", startedAt: new Date() },
  });

  try {
    const result = await syncMeasurements({ limit });
    await prisma.syncLog.update({
      where: { id: log.id },
      data: { status: "SUCCESS", completedAt: new Date(), itemsSynced: result.updated },
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await prisma.syncLog.update({
      where: { id: log.id },
      data: { status: "FAILED", completedAt: new Date(), error: message },
    });
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
