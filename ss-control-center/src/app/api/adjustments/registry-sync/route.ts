/**
 * POST /api/adjustments/registry-sync
 *
 * Мост сервер → модуль: очередь кейсов, новые штрафы детектора, кредиты из
 * Payments и heartbeat кронов. Один вызов — один аккаунт (`store`).
 * Повторная отправка безопасна: события дедуплицируются по sourceRef.
 *
 * Тело: { store, cases?, penalties?, credits?, runs? } — типы в
 * lib/adjustments/registry-sync.ts.
 */
import { NextRequest, NextResponse } from "next/server";
import { registrySync, type RegistrySyncInput } from "@/lib/adjustments/registry-sync";

export const maxDuration = 300;

export async function POST(request: NextRequest) {
  let body: RegistrySyncInput;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "нужен JSON в теле" }, { status: 400 });
  }
  if (!body || typeof body.store !== "string") {
    return NextResponse.json({ error: "нужен store (store1 | store3)" }, { status: 400 });
  }
  try {
    const report = await registrySync(body);
    return NextResponse.json({ ok: true, report });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 400 });
  }
}
