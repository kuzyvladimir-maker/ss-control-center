/**
 * Приём настоящего аудита габаритов со страницы Transaction Details.
 *
 * Данные собирает отдельный сборщик и кладёт JSON-массивом; формат полей там
 * пока не зацементирован, поэтому парсеры ниже нарочно терпимые: габариты
 * принимаются и строкой «13 x 42 x 11 in», и массивом [13,42,11], и объектом
 * { length, width, height, unit }. Падать из-за того, что сборщик поменял
 * форму записи, реестр не должен — он должен сказать, сколько строк не понял.
 *
 * Правила записи (2026-11-19, после разбора импорта):
 *  - импорт ДОПОЛНЯЕТ строку, а не перезаписывает её: отсутствующее значение
 *    не стирает уже собранное (аудит FedEx, данные с сервера), валидный 0
 *    записывается как 0;
 *  - строки ошибок сборщика ({ error } / { __status }) не применяются;
 *  - строка ищется по ID транзакции в пределах магазина, трек и заказ — только
 *    запасной путь при однозначном совпадении; иначе запись пропускается с
 *    причиной в отчёте;
 *  - класс пересчитывается только у обновлённых строк, а класс, пришедший с
 *    сервера (его нет в нашем классификаторе), не трогается.
 */
import {
  AUDIT_SOURCES,
  CLASS_LABEL,
  classifyByAudit,
  type ChargeLine,
  type ClassifiableRow,
} from "@/lib/adjustments/audit-classify";

/**
 * Узкий срез Prisma-клиента, который нужен импорту. Отдельным типом — чтобы
 * регрессионные тесты гоняли импорт на базе в памяти, а боевой код брал
 * настоящий prisma (лениво: импорт модуля не открывает соединение с базой).
 */
export type AdjRow = { id: string } & Record<string, unknown>;
export interface AuditDb {
  shippingAdjustment: {
    findMany(args: { where: Record<string, unknown> }): Promise<AdjRow[]>;
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
  };
}

async function defaultDb(): Promise<AuditDb> {
  const { prisma } = await import("@/lib/prisma");
  return prisma as unknown as AuditDb;
}

export interface ParsedDims {
  l: number;
  w: number;
  h: number;
  unit: string;
}

export interface ParsedWeight {
  value: number;
  unit: string;
}

/** Число или null. Пустая строка / null / мусор — null; 0 — это 0. */
const numOf = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

export function parseDims(raw: unknown): ParsedDims | null {
  if (raw == null) return null;

  if (Array.isArray(raw)) {
    const [l, w, h] = raw.map(numOf);
    if (l == null || w == null || h == null) return null;
    return { l, w, h, unit: "IN" };
  }

  if (typeof raw === "string") {
    const nums = raw.match(/\d+(?:\.\d+)?/g);
    if (!nums || nums.length < 3) return null;
    const unit = /cm/i.test(raw) ? "CM" : "IN";
    return { l: parseFloat(nums[0]), w: parseFloat(nums[1]), h: parseFloat(nums[2]), unit };
  }

  if (typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const l = numOf(o.l ?? o.length ?? o.L);
    const w = numOf(o.w ?? o.width ?? o.W);
    const h = numOf(o.h ?? o.height ?? o.H);
    if (l == null || w == null || h == null) return null;
    const unitRaw = typeof o.unit === "string" ? o.unit : typeof o.units === "string" ? o.units : "IN";
    return { l, w, h, unit: /cm/i.test(unitRaw) ? "CM" : "IN" };
  }

  return null;
}

export function parseWeight(raw: unknown): ParsedWeight | null {
  if (raw == null) return null;

  if (typeof raw === "number") {
    return Number.isFinite(raw) ? { value: raw, unit: "LB" } : null;
  }

  if (typeof raw === "string") {
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) return null;
    const unit = /kg/i.test(raw) ? "KG" : /oz/i.test(raw) ? "OZ" : "LB";
    return { value: n, unit };
  }

  if (typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const value = numOf(o.value ?? o.weight ?? o.lbs ?? o.amount);
    if (value == null) return null;
    const unitRaw = typeof o.unit === "string" ? o.unit : typeof o.units === "string" ? o.units : "LB";
    const unit = /kg/i.test(unitRaw) ? "KG" : /oz/i.test(unitRaw) ? "OZ" : "LB";
    return { value, unit };
  }

  return null;
}

export function parseCharges(raw: unknown): ChargeLine[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x): ChargeLine | null => {
      if (!x || typeof x !== "object") return null;
      const o = x as Record<string, unknown>;
      const label =
        typeof o.label === "string"
          ? o.label
          : typeof o.name === "string"
            ? o.name
            : typeof o.description === "string"
              ? o.description
              : null;
      const amount = numOf(o.amount ?? o.value ?? o.charge);
      if (!label || amount == null) return null;
      return { label: label.trim(), amount };
    })
    .filter((x): x is ChargeLine => x !== null);
}

/** Одна запись аудита из файла сборщика. */
export interface AuditRecord {
  orderId?: string | null;
  financialEventId?: string | null;
  trackingNumber?: string | null;
  enteredDims?: unknown;
  enteredWeight?: unknown;
  auditedDims?: unknown;
  auditedWeight?: unknown;
  charges?: unknown;
  /** Плоская форма сборщика: enteredDimL/W/H, auditedWeightUnit и т.п. */
  [key: string]: unknown;
  amountAlreadyPaid?: unknown;
  totalChargeFromCarrier?: unknown;
  transactionTotal?: unknown;
  detailsUrl?: string | null;
  transactionDetailsUrl?: string | null;
}

/** Запись, которую импорт сознательно не применил, и почему. */
export interface SkippedRecord {
  orderId: string | null;
  financialEventId: string | null;
  trackingNumber: string | null;
  reason: "collector_error" | "ambiguous" | "amount_mismatch" | "duplicate_target";
  detail: string;
}

export interface ImportResult {
  total: number;
  matched: number;
  /** Строк, в которые реально что-то записано. */
  updated: number;
  unmatched: Array<{ orderId: string | null; trackingNumber: string | null; financialEventId: string | null }>;
  /** Сопоставлено, но аудит перевозчика (габариты/вес) в записи не разобран. */
  unparsed: number;
  /** Ошибки сборщика, неоднозначные и повторные записи — не применены. */
  skipped: SkippedRecord[];
  /** Класс в строке пришёл с сервера (его нет в нашем классификаторе) — оставлен. */
  serverClassKept: number;
}

/**
 * Класс, которого наш классификатор не выдаёт (UNEXPLAINED_CHARGE,
 * UNIFORM_GROWTH, …), записал сервер через registry-sync. Пересчёт его не
 * трогает: локальный классификатор о таких классах ничего не знает.
 *
 * Ограничение: если сервер записал класс с тем же именем, что и у нас
 * (например GROSS_DIM), отличить его от локального без отдельного поля нельзя.
 */
export function isServerClass(cls: unknown): boolean {
  return (
    typeof cls === "string" &&
    cls !== "" &&
    !Object.prototype.hasOwnProperty.call(CLASS_LABEL, cls)
  );
}

/** Суммы сравниваем по модулю: знак у списания в разных источниках разный. */
const sameAmount = (a: unknown, b: number) =>
  typeof a === "number" && Math.abs(Math.abs(a) - Math.abs(b)) < 0.005;

export type PickResult<T> =
  | { hit: T }
  | { reason: "ambiguous" | "amount_mismatch"; count: number }
  | null;

/**
 * Из нескольких строк одного заказа/трека выбирает ту, к которой запись
 * относится однозначно. Сумма транзакции известна — строка обязана с ней
 * совпасть (иначе это другое списание того же заказа). Неизвестна — годится
 * только единственный кандидат. Никакого «берём первую».
 */
export function pickUnambiguous<T>(
  cands: T[],
  total: number | null,
  amountOf: (c: T) => unknown
): PickResult<T> {
  if (cands.length === 0) return null;
  if (total != null) {
    const exact = cands.filter((c) => sameAmount(amountOf(c), total));
    if (exact.length === 1) return { hit: exact[0] };
    if (exact.length > 1) return { reason: "ambiguous", count: exact.length };
    return { reason: "amount_mismatch", count: cands.length };
  }
  if (cands.length === 1) return { hit: cands[0] };
  return { reason: "ambiguous", count: cands.length };
}

type Match = { row: AdjRow } | { skip: SkippedRecord } | null;

/**
 * Находит строку списания по аудиту.
 *
 * Сначала — ID транзакции (financialEventId) в пределах магазина: он привязан
 * к одной конкретной проводке. Трек и номер заказа — только запасной путь и
 * только при однозначном соответствии: у заказа бывает несколько списаний, и
 * раньше импорт брал первую попавшуюся строку, сливая разные транзакции в
 * одну. Строки, уже привязанные к ДРУГОЙ транзакции, в запасном пути не
 * участвуют.
 */
async function findAdjustment(db: AuditDb, rec: AuditRecord, storeId?: string): Promise<Match> {
  const scope = storeId ? { storeId } : {};
  const eventId = str(rec.financialEventId);
  const tracking = str(rec.trackingNumber);
  const orderId = str(rec.orderId);
  const total = numOf(rec.transactionTotal);
  const ids = { orderId, financialEventId: eventId, trackingNumber: tracking };

  if (eventId) {
    const rows = await db.shippingAdjustment.findMany({
      where: { financialEventId: eventId, ...scope },
    });
    if (rows.length === 1) return { row: rows[0] };
    if (rows.length > 1) {
      const stores = [...new Set(rows.map((r) => String(r.storeId)))].join(", ");
      return {
        skip: {
          ...ids,
          reason: "ambiguous",
          detail: `financialEventId ${eventId}: ${rows.length} строк (магазины: ${stores})`,
        },
      };
    }
  }

  const free = (rows: AdjRow[]) =>
    rows.filter((r) => !eventId || r.financialEventId == null || r.financialEventId === eventId);

  const fallbacks: Array<[string, Record<string, unknown> | null]> = [
    ["трек", tracking ? { trackingNumber: tracking } : null],
    ["заказ", orderId ? { OR: [{ amazonOrderId: orderId }, { orderId }] } : null],
  ];
  for (const [label, where] of fallbacks) {
    if (!where) continue;
    const rows = free(await db.shippingAdjustment.findMany({ where: { ...where, ...scope } }));
    const pick = pickUnambiguous(rows, total, (r) => r.adjustmentAmount);
    if (!pick) continue;
    if ("hit" in pick) return { row: pick.hit };
    return {
      skip: {
        ...ids,
        reason: pick.reason,
        detail:
          pick.reason === "ambiguous"
            ? `по ключу «${label}» ${pick.count} подходящих строк — привязка не однозначна`
            : `по ключу «${label}» ${pick.count} строк, ни одна не совпала с суммой ${total}`,
      },
    };
  }
  return null;
}

/**
 * Сборщик Transaction Details кладёт габариты плоско (`enteredDimL/W/H`,
 * `enteredDimUnit`), а не объектом. Собираем из плоских полей объект, если
 * вложенной формы нет — чтобы импорт не молчал и не обнулял аудит.
 */
function dimsFrom(rec: AuditRecord, prefix: "entered" | "audited"): unknown {
  const nested = rec[`${prefix}Dims`];
  if (nested != null) return nested;
  const l = rec[`${prefix}DimL`];
  const w = rec[`${prefix}DimW`];
  const h = rec[`${prefix}DimH`];
  if (l == null && w == null && h == null) return null;
  return { l, w, h, unit: rec[`${prefix}DimUnit`] ?? "IN" };
}

function weightFrom(rec: AuditRecord, prefix: "entered" | "audited"): unknown {
  const raw = rec[`${prefix}Weight`];
  const unit = rec[`${prefix}WeightUnit`];
  if (raw == null) return null;
  if (typeof raw === "number" && typeof unit === "string") {
    return { value: raw, unit };
  }
  return raw;
}

/**
 * Патч строки из записи аудита: только то, что в записи реально есть.
 * Отсутствующее значение не превращается в null и не стирает собранное.
 */
function patchFrom(rec: AuditRecord, row: AdjRow, source: string, now: Date) {
  const data: Record<string, unknown> = {};
  const put = (key: string, v: unknown) => {
    if (v !== null && v !== undefined) data[key] = v;
  };

  const entered = parseDims(dimsFrom(rec, "entered"));
  const enteredW = parseWeight(weightFrom(rec, "entered"));
  const audited = parseDims(dimsFrom(rec, "audited"));
  const auditedW = parseWeight(weightFrom(rec, "audited"));
  const charges = parseCharges(rec.charges);

  if (entered) {
    put("enteredDimL", entered.l);
    put("enteredDimW", entered.w);
    put("enteredDimH", entered.h);
    put("enteredDimUnit", entered.unit);
  }
  if (enteredW) {
    put("enteredWeight", enteredW.value);
    put("enteredWeightUnit", enteredW.unit);
  }
  if (audited) {
    put("auditedDimL", audited.l);
    put("auditedDimW", audited.w);
    put("auditedDimH", audited.h);
    put("auditedDimUnit", audited.unit);
  }
  if (auditedW) {
    put("auditedWeight", auditedW.value);
    put("auditedWeightUnit", auditedW.unit);
  }
  if (audited || auditedW) {
    data.auditSource = source;
    data.auditCapturedAt = now;
  }
  if (charges.length) data.chargeBreakdown = JSON.stringify(charges);
  put("amountAlreadyPaid", numOf(rec.amountAlreadyPaid));
  put("totalChargeFromCarrier", numOf(rec.totalChargeFromCarrier));
  put("transactionTotal", numOf(rec.transactionTotal));

  const eventId = str(rec.financialEventId);
  if (eventId && row.financialEventId == null) data.financialEventId = eventId;
  put("transactionDetailsUrl", str(rec.transactionDetailsUrl) ?? str(rec.detailsUrl));

  return { data, auditParsed: Boolean(audited || auditedW) };
}

export async function importAuditRecords(
  records: AuditRecord[],
  opts: { storeId?: string; source?: string; db?: AuditDb } = {}
): Promise<ImportResult> {
  const db = opts.db ?? (await defaultDb());
  const source = opts.source ?? AUDIT_SOURCES.TRANSACTION_DETAILS;
  const result: ImportResult = {
    total: records.length,
    matched: 0,
    updated: 0,
    unmatched: [],
    unparsed: 0,
    skipped: [],
    serverClassKept: 0,
  };
  // Одна строка — одна транзакция за прогон: вторая запись в ту же строку
  // означает, что сопоставление где-то не однозначно, и она не применяется.
  const claimed = new Map<string, string>();

  for (const rec of records) {
    const ids = {
      orderId: str(rec.orderId),
      financialEventId: str(rec.financialEventId),
      trackingNumber: str(rec.trackingNumber),
    };

    if (rec.error != null || rec.__status != null) {
      result.skipped.push({
        ...ids,
        reason: "collector_error",
        detail: String(rec.error ?? `HTTP ${rec.__status}`),
      });
      continue;
    }

    const match = await findAdjustment(db, rec, opts.storeId);
    if (!match) {
      result.unmatched.push(ids);
      continue;
    }
    if ("skip" in match) {
      result.skipped.push(match.skip);
      continue;
    }
    const row = match.row;
    const recKey = ids.financialEventId ?? ids.trackingNumber ?? ids.orderId ?? "?";
    const prev = claimed.get(row.id);
    if (prev !== undefined) {
      result.skipped.push({
        ...ids,
        reason: "duplicate_target",
        detail: `строка ${row.id} уже получила запись ${prev} в этом импорте`,
      });
      continue;
    }
    claimed.set(row.id, recKey);
    result.matched++;

    const { data, auditParsed } = patchFrom(rec, row, source, new Date());
    if (!auditParsed) result.unparsed++;

    if (isServerClass(row.disputeClass)) {
      result.serverClassKept++;
    } else {
      const cls = classifyByAudit({ ...row, ...data } as ClassifiableRow).cls;
      if (cls !== row.disputeClass) data.disputeClass = cls;
    }

    if (Object.keys(data).length === 0) continue;
    await db.shippingAdjustment.update({ where: { id: row.id }, data });
    result.updated++;
  }

  return result;
}

/**
 * Пересчитывает класс — после смены порогов или после того, как источник у
 * части строк переставили на честный. Запускается только вручную
 * (scripts/reclassify-adjustments.ts), импорт его больше не вызывает.
 * Серверные классы не перезаписываются; storeId сужает пересчёт до магазина.
 */
export async function reclassifyAll(
  opts: { storeId?: string; db?: AuditDb } = {}
): Promise<Record<string, number>> {
  const db = opts.db ?? (await defaultDb());
  const rows = await db.shippingAdjustment.findMany({
    where: opts.storeId ? { storeId: opts.storeId } : {},
  });

  const counts: Record<string, number> = {};
  for (const row of rows) {
    if (isServerClass(row.disputeClass)) {
      const kept = String(row.disputeClass);
      counts[kept] = (counts[kept] ?? 0) + 1;
      continue;
    }
    const cls = classifyByAudit(row as ClassifiableRow).cls;
    counts[cls] = (counts[cls] ?? 0) + 1;
    if (row.disputeClass !== cls) {
      await db.shippingAdjustment.update({
        where: { id: row.id },
        data: { disputeClass: cls },
      });
    }
  }
  return counts;
}
