/**
 * Классификация shipping adjustment на ЧЕСТНЫХ данных аудита.
 *
 * Старая классификация (carrier-measure.ts, классы A/B/C/D) строилась на
 * полях adjustedDim* — а туда без разбора источника складывался ответ Track
 * API. Для UPS это МАНИФЕСТ: наши же цифры, введённые при покупке лейбла.
 * Сравнивая манифест с заявленным, мы всегда получали «совпало» и уверенно
 * записывали строку в класс A «штраф не на чем основан» — то есть спорили,
 * опираясь на собственный ввод. Установлено 20–21.09.2026.
 *
 * Здесь источник — часть данных, а не примечание к ним. Строка с источником
 * UPS_API_MANIFEST_UNRELIABLE не попадает в спорный класс никогда, какой бы
 * красивой ни выглядела разница.
 */

export const AUDIT_SOURCES = {
  /** Страница Transaction Details в Seller Central — полноценный аудит. */
  TRANSACTION_DETAILS: "TRANSACTION_DETAILS",
  /** FedEx Track API — отдаёт настоящий аудит (сверено с Amazon 21.09.2026). */
  FEDEX_API: "FEDEX_API",
  /** UPS Track API — отдаёт манифест, а не аудит. Для спора непригоден. */
  UPS_API_MANIFEST_UNRELIABLE: "UPS_API_MANIFEST_UNRELIABLE",
} as const;

export type AuditSource = (typeof AUDIT_SOURCES)[keyof typeof AUDIT_SOURCES];

/** Источники, по которым вообще можно спорить. */
export const TRUSTWORTHY_AUDIT_SOURCES: AuditSource[] = [
  AUDIT_SOURCES.TRANSACTION_DETAILS,
  AUDIT_SOURCES.FEDEX_API,
];

export type AdjustmentClass =
  | "NO_AUDIT_DATA"
  | "MATCH"
  | "SCANNER_NOISE"
  | "DISCREPANCY"
  | "GROSS_DIM"
  | "GROSS_WEIGHT"
  | "SURCHARGE_ONLY";

export const CLASS_LABEL: Record<AdjustmentClass, string> = {
  NO_AUDIT_DATA: "Аудита нет — спорить нечем",
  MATCH: "Аудит равен заявленному",
  SCANNER_NOISE: "Шум измерителя (±1″, вес ±10%)",
  DISCREPANCY: "Расхождение выше шума, но ниже грубого",
  GROSS_DIM: "Сторона выросла вдвое и больше",
  GROSS_WEIGHT: "Вес вырос в 1.5 раза и больше",
  SURCHARGE_ONLY: "Габариты и вес сошлись — начислены сурчарджи",
};

/** Классы, с которыми имеет смысл идти в поштучный спор. */
export const DISPUTABLE_CLASSES: AdjustmentClass[] = [
  "MATCH",
  "GROSS_DIM",
  "GROSS_WEIGHT",
  "SURCHARGE_ONLY",
];

/** Порог шума измерителя по стороне, дюймы. */
export const NOISE_DIM_INCHES = 1.0;
/** Порог шума измерителя по весу, доля. */
export const NOISE_WEIGHT_RATIO = 0.1;
/** Сторона выросла во столько раз — грубая ошибка габарита. */
export const GROSS_DIM_RATIO = 2.0;
/** Вес вырос во столько раз — грубая ошибка веса. */
export const GROSS_WEIGHT_RATIO = 1.5;
/** Равенство с точностью до погрешности округления в кабинете. */
const EPS = 0.051;

export interface ChargeLine {
  label: string;
  amount: number;
}

/** Статьи, которые начисляются НЕ за перевес, а за адрес и топливо. */
const SURCHARGE_PATTERNS = [
  /residential/i,
  /address\s*correction/i,
  /fuel/i,
  /super\s*rural/i,
  /delivery\s*area/i,
  /remote/i,
  /additional\s*handling/i,
  /peak/i,
  /demand\s*surcharge/i,
];

/** Статьи, означающие пересчёт самой перевозки (перевес / габарит). */
const POSTAGE_PATTERNS = [
  /base\s*postage/i,
  /shipping\s*charge\s*correction/i,
  /postage\s*adjustment/i,
  /weight\s*correction/i,
  /dimension/i,
];

export function isSurchargeLine(label: string): boolean {
  if (POSTAGE_PATTERNS.some((re) => re.test(label))) return false;
  return SURCHARGE_PATTERNS.some((re) => re.test(label));
}

/** Разбирает chargeBreakdown из базы (JSON-строка) в массив статей. */
export function parseChargeBreakdown(raw: string | null | undefined): ChargeLine[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((x): ChargeLine | null => {
        const label = typeof x?.label === "string" ? x.label : typeof x?.name === "string" ? x.name : null;
        const amount = typeof x?.amount === "number" ? x.amount : Number(x?.amount);
        if (!label || !Number.isFinite(amount)) return null;
        return { label, amount };
      })
      .filter((x): x is ChargeLine => x !== null);
  } catch {
    return [];
  }
}

/**
 * Начисление состоит только из сурчарджей: перевозку не пересчитывали,
 * доплата набежала за адрес, топливо и исправление адреса.
 */
export function isSurchargeOnly(lines: ChargeLine[]): boolean {
  const meaningful = lines.filter((l) => Math.abs(l.amount) > 0.004);
  if (meaningful.length === 0) return false;
  return meaningful.every((l) => isSurchargeLine(l.label));
}

const toInches = (v: number | null | undefined, unit: string | null | undefined): number | null => {
  if (v == null || !Number.isFinite(v)) return null;
  return (unit || "IN").toUpperCase() === "CM" ? v / 2.54 : v;
};

const toPounds = (v: number | null | undefined, unit: string | null | undefined): number | null => {
  if (v == null || !Number.isFinite(v)) return null;
  const u = (unit || "LB").toUpperCase();
  if (u === "OZ") return v / 16;
  if (u === "KG") return v * 2.20462;
  return v;
};

export interface ClassifiableRow {
  auditSource?: string | null;
  // то, что мы заявили при покупке лейбла (кабинет Amazon)
  enteredDimL?: number | null;
  enteredDimW?: number | null;
  enteredDimH?: number | null;
  enteredDimUnit?: string | null;
  enteredWeight?: number | null;
  enteredWeightUnit?: string | null;
  // то, что намерил перевозчик
  auditedDimL?: number | null;
  auditedDimW?: number | null;
  auditedDimH?: number | null;
  auditedDimUnit?: string | null;
  auditedWeight?: number | null;
  auditedWeightUnit?: string | null;
  // запасной источник заявленного — наша SKU-база
  declaredDimL?: number | null;
  declaredDimW?: number | null;
  declaredDimH?: number | null;
  declaredWeightLbs?: number | null;
  chargeBreakdown?: string | null;
}

export interface ClassificationResult {
  cls: AdjustmentClass;
  /** Почему именно этот класс — строкой, чтобы показывать в реестре. */
  reason: string;
  /** Максимальный прирост стороны, разы. null — сравнивать нечего. */
  maxDimRatio: number | null;
  /** Прирост веса, разы. */
  weightRatio: number | null;
  /** Максимальный прирост стороны, дюймы. */
  maxDimDeltaInches: number | null;
  /** Источник признан пригодным для спора. */
  sourceTrusted: boolean;
}

/** Стороны коробки сравниваем отсортированными: перевозчик кладёт её как хочет. */
function sortedSides(
  l: number | null,
  w: number | null,
  h: number | null
): [number, number, number] | null {
  if (l == null || w == null || h == null) return null;
  if (l <= 0 || w <= 0 || h <= 0) return null;
  return [l, w, h].sort((a, b) => a - b) as [number, number, number];
}

export function classifyByAudit(row: ClassifiableRow): ClassificationResult {
  const empty: ClassificationResult = {
    cls: "NO_AUDIT_DATA",
    reason: "",
    maxDimRatio: null,
    weightRatio: null,
    maxDimDeltaInches: null,
    sourceTrusted: false,
  };

  const source = (row.auditSource || "").toUpperCase();
  if (!source) {
    return { ...empty, reason: "источник аудита не указан" };
  }
  if (source === AUDIT_SOURCES.UPS_API_MANIFEST_UNRELIABLE) {
    return {
      ...empty,
      reason: "UPS Track API отдаёт манифест, а не аудит — сравнивать не с чем",
    };
  }
  if (!TRUSTWORTHY_AUDIT_SOURCES.includes(source as AuditSource)) {
    return { ...empty, reason: `источник ${source} не признан аудитом` };
  }

  const audited = sortedSides(
    toInches(row.auditedDimL, row.auditedDimUnit),
    toInches(row.auditedDimW, row.auditedDimUnit),
    toInches(row.auditedDimH, row.auditedDimUnit)
  );
  const auditedWeight = toPounds(row.auditedWeight, row.auditedWeightUnit);

  const entered =
    sortedSides(
      toInches(row.enteredDimL, row.enteredDimUnit),
      toInches(row.enteredDimW, row.enteredDimUnit),
      toInches(row.enteredDimH, row.enteredDimUnit)
    ) ?? sortedSides(row.declaredDimL ?? null, row.declaredDimW ?? null, row.declaredDimH ?? null);
  const enteredWeight =
    toPounds(row.enteredWeight, row.enteredWeightUnit) ?? row.declaredWeightLbs ?? null;

  const haveDims = audited !== null && entered !== null;
  const haveWeight =
    auditedWeight != null && auditedWeight > 0 && enteredWeight != null && enteredWeight > 0;

  if (!haveDims && !haveWeight) {
    return { ...empty, sourceTrusted: true, reason: "аудит пуст — ни габаритов, ни веса" };
  }

  let maxDimRatio: number | null = null;
  let maxDimDelta: number | null = null;
  if (haveDims) {
    maxDimRatio = Math.max(...audited!.map((a, i) => a / entered![i]));
    maxDimDelta = Math.max(...audited!.map((a, i) => a - entered![i]));
  }
  const weightRatio = haveWeight ? auditedWeight! / enteredWeight! : null;

  const base = {
    maxDimRatio,
    weightRatio,
    maxDimDeltaInches: maxDimDelta,
    sourceTrusted: true,
  };

  const dimsEqual = !haveDims || audited!.every((a, i) => Math.abs(a - entered![i]) <= EPS);
  const weightEqual = !haveWeight || Math.abs(auditedWeight! - enteredWeight!) <= EPS;

  if (dimsEqual && weightEqual) {
    const lines = parseChargeBreakdown(row.chargeBreakdown);
    if (isSurchargeOnly(lines)) {
      return {
        ...base,
        cls: "SURCHARGE_ONLY",
        reason: `габариты и вес сошлись, начислено только сурчарджами: ${lines
          .map((l) => l.label)
          .join(", ")}`,
      };
    }
    return { ...base, cls: "MATCH", reason: "аудит совпал с заявленным" };
  }

  if (maxDimRatio != null && maxDimRatio >= GROSS_DIM_RATIO) {
    return {
      ...base,
      cls: "GROSS_DIM",
      reason: `сторона выросла в ${maxDimRatio.toFixed(2)} раза`,
    };
  }

  if (weightRatio != null && weightRatio >= GROSS_WEIGHT_RATIO) {
    return {
      ...base,
      cls: "GROSS_WEIGHT",
      reason: `вес вырос в ${weightRatio.toFixed(2)} раза`,
    };
  }

  const dimsNoisy = !haveDims || (maxDimDelta != null && maxDimDelta <= NOISE_DIM_INCHES);
  const weightNoisy =
    !haveWeight || (weightRatio != null && Math.abs(weightRatio - 1) <= NOISE_WEIGHT_RATIO);
  if (dimsNoisy && weightNoisy) {
    return {
      ...base,
      cls: "SCANNER_NOISE",
      reason: `стороны +${(maxDimDelta ?? 0).toFixed(1)}″, вес ×${(weightRatio ?? 1).toFixed(2)}`,
    };
  }

  // Ни шум, ни грубая ошибка: например сторона выросла в 1.6 раза, а вес в 1.2.
  // Отдельный класс вместо натягивания такой строки на GROSS_* — иначе в спор
  // уйдут цифры, которых на самом деле нет.
  return {
    ...base,
    cls: "DISCREPANCY",
    reason: `стороны ×${(maxDimRatio ?? 1).toFixed(2)}, вес ×${(weightRatio ?? 1).toFixed(2)}`,
  };
}
