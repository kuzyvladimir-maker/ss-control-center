/**
 * Фактический замер перевозчика против заявленного в лейбле.
 *
 * Amazon списывает shipping adjustment, не раскрывая причину — в строке есть
 * только сумма. Единственный независимый свидетель это сам перевозчик: FedEx и
 * UPS возвращают в Track API вес и габариты, прошедшие через их измеритель.
 * Положив их рядом с заявленным, мы получаем ответ, обоснован штраф или нет,
 * и именно этим ответом спорим — Amazon в отказе по кейсу 20424098481 (30.05.2026)
 * сам отправил нас за reweigh data к перевозчику.
 *
 * Замер кладётся в уже существующие поля ShippingAdjustment (adjustedWeightLbs,
 * adjustedDim*), новых миграций не требуется.
 */
import { prisma } from "@/lib/prisma";
import { getFedexTracking } from "@/lib/carriers/fedex-tracking";
import { getUpsTracking } from "@/lib/carriers/ups-tracking";

/** Делитель объёмного веса для наземных/экспресс-тарифов FedEx и UPS в США. */
export const DIM_DIVISOR = 139;

export interface CarrierMeasurement {
  weightLbs: number | null;
  dimL: number | null;
  dimW: number | null;
  dimH: number | null;
  service: string | null;
}

const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Достаёт замер из сырого ответа FedEx Track API. */
export function extractFedexMeasurement(raw: unknown): CarrierMeasurement | null {
  const r = raw as Record<string, any>;
  const tr = r?.output?.completeTrackResults?.[0]?.trackResults?.[0];
  if (!tr) return null;
  const wd = tr.packageDetails?.weightAndDimensions;
  const w = wd?.weight?.find((x: any) => x?.unit === "LB");
  const d = wd?.dimensions?.find((x: any) => x?.units === "IN");
  if (!w && !d) return null;
  return {
    weightLbs: num(w?.value),
    dimL: num(d?.length),
    dimW: num(d?.width),
    dimH: num(d?.height),
    service: tr.serviceDetail?.description ?? null,
  };
}

/** Достаёт замер из сырого ответа UPS Track API. */
export function extractUpsMeasurement(raw: unknown): CarrierMeasurement | null {
  const r = raw as Record<string, any>;
  const pkg = r?.trackResponse?.shipment?.[0]?.package?.[0];
  if (!pkg) return null;
  const w = pkg.weight;
  const d = pkg.dimension;
  if (!w && !d) return null;
  return {
    weightLbs: num(w?.weight),
    dimL: num(d?.length),
    dimW: num(d?.width),
    dimH: num(d?.height),
    service: pkg.service?.description ?? null,
  };
}

export async function fetchMeasurement(
  carrier: string | null,
  trackingNumber: string
): Promise<CarrierMeasurement | null> {
  if (!trackingNumber) return null;
  const c = (carrier || "").toUpperCase();
  if (c === "FEDEX") {
    const t = await getFedexTracking(trackingNumber);
    return t ? extractFedexMeasurement(t.raw) : null;
  }
  if (c === "UPS") {
    const t = await getUpsTracking(trackingNumber);
    return t ? extractUpsMeasurement(t.raw) : null;
  }
  // USPS габариты посылки в Track API не отдаёт — сверять нечем.
  return null;
}

/** Оплачиваемый вес: больший из фактического и объёмного. */
export function billableWeight(
  L: number | null | undefined,
  W: number | null | undefined,
  H: number | null | undefined,
  weight: number | null | undefined
): number {
  const dim = L && W && H ? (L * W * H) / DIM_DIVISOR : 0;
  return Math.max(weight || 0, dim);
}

export type DisputeClass = "A" | "B" | "C" | "D";

export const DISPUTE_CLASS_LABEL: Record<DisputeClass, string> = {
  A: "Замер не больше заявленного — штраф не на чем основан",
  B: "Расхождение до 30% — спорно",
  C: "Намерено заметно больше — проверить габариты SKU",
  D: "Намерено в 2.5+ раза больше — ошибка замера",
};

/** Классы A и D идут в спор, C — в починку SKU-базы. */
export const DISPUTABLE: DisputeClass[] = ["A", "D"];

export function classifyAdjustment(row: {
  declaredDimL?: number | null;
  declaredDimW?: number | null;
  declaredDimH?: number | null;
  declaredWeightLbs?: number | null;
  adjustedDimL?: number | null;
  adjustedDimW?: number | null;
  adjustedDimH?: number | null;
  adjustedWeightLbs?: number | null;
}): { cls: DisputeClass | null; declared: number; measured: number } {
  const declared = billableWeight(
    row.declaredDimL, row.declaredDimW, row.declaredDimH, row.declaredWeightLbs);
  const measured = billableWeight(
    row.adjustedDimL, row.adjustedDimW, row.adjustedDimH, row.adjustedWeightLbs);
  if (!declared || !measured) return { cls: null, declared, measured };
  const ratio = measured / declared;
  const cls: DisputeClass =
    ratio <= 1.05 ? "A" : ratio <= 1.3 ? "B" : ratio <= 2.5 ? "C" : "D";
  return { cls, declared, measured };
}

/**
 * Дотягивает замеры перевозчика для строк, где их ещё нет.
 * Идём от свежих к старым: и FedEx, и UPS перестают отдавать данные
 * по номерам старше примерно трёх месяцев.
 */
export async function syncMeasurements(opts: { limit?: number } = {}) {
  const limit = opts.limit ?? 200;
  const rows = await prisma.shippingAdjustment.findMany({
    where: {
      adjustmentAmount: { lt: 0 },
      trackingNumber: { not: null },
      adjustedDimL: null,
      carrier: { in: ["FEDEX", "UPS"] },
    },
    orderBy: { adjustmentDate: "desc" },
    take: limit,
  });

  let updated = 0;
  let missed = 0;
  for (const row of rows) {
    let m: CarrierMeasurement | null = null;
    try {
      m = await fetchMeasurement(row.carrier, row.trackingNumber!);
    } catch (e) {
      console.error("[measure] fetch failed", row.trackingNumber,
        e instanceof Error ? e.message : String(e));
    }
    if (!m || (!m.weightLbs && !m.dimL)) {
      missed++;
      continue;
    }
    await prisma.shippingAdjustment.update({
      where: { id: row.id },
      data: {
        adjustedWeightLbs: m.weightLbs,
        adjustedDimL: m.dimL,
        adjustedDimW: m.dimW,
        adjustedDimH: m.dimH,
        service: row.service ?? m.service,
      },
    });
    updated++;
  }
  return { scanned: rows.length, updated, missed };
}
