/**
 * GET /api/adjustments/board
 *
 * Дашборд споров: сводка по каждому аккаунту (всё время, 30 дней и период
 * from/to), новые
 * штрафы после отсечки базовой выборки, кейсы со статусом и датой следующего
 * действия, здоровье кронов. Считается из реестра модуля — другого нет.
 */
import { NextRequest, NextResponse } from "next/server";
import { buildDisputeBoard } from "@/lib/adjustments/dispute-board";

export const dynamic = "force-dynamic";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** ?from=YYYY-MM-DD&to=YYYY-MM-DD — период для блока `period`; без них — всё время. */
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const day = (v: string | null) => (v && DAY_RE.test(v) ? v : null);
  try {
    return NextResponse.json(
      await buildDisputeBoard(new Date(), { from: day(sp.get("from")), to: day(sp.get("to")) })
    );
  } catch (err) {
    console.error("[adjustments board]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
