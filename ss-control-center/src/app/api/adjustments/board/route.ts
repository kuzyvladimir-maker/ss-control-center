/**
 * GET /api/adjustments/board
 *
 * Дашборд споров: сводка по каждому аккаунту (всё время и 30 дней), новые
 * штрафы после отсечки базовой выборки, кейсы со статусом и датой следующего
 * действия, здоровье кронов. Считается из реестра модуля — другого нет.
 */
import { NextResponse } from "next/server";
import { buildDisputeBoard } from "@/lib/adjustments/dispute-board";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await buildDisputeBoard());
  } catch (err) {
    console.error("[adjustments board]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
