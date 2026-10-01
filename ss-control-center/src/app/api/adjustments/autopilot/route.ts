/**
 * GET /api/adjustments/autopilot
 *
 * Автопилот споров: очередь «готов к подаче» с текстом обращения по каждой
 * пачке (аккаунт + тип дефекта), строки без аудита, таблица исходов
 * «тип случая / перевозчик → кредит / отказ / ждём» и плейбук.
 * Всё считается из реестра модуля на каждом запросе.
 */
import { NextResponse } from "next/server";
import { buildDisputeQueue, loadLearning } from "@/lib/adjustments/dispute-composer";
import { ARGUMENTS } from "@/lib/adjustments/dispute-learning";
import { PLAYBOOK, WHAT_FAILS, WHAT_WORKS } from "@/lib/adjustments/playbook";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { table } = await loadLearning();
    const queue = await buildDisputeQueue(table);
    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      queue,
      outcomes: table.map((c) => ({
        ...c,
        patternLabel: ARGUMENTS[c.pattern].title,
        argument: ARGUMENTS[c.pattern].argument,
      })),
      playbook: PLAYBOOK,
      works: WHAT_WORKS,
      fails: WHAT_FAILS,
    });
  } catch (err) {
    console.error("[adjustments autopilot]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
